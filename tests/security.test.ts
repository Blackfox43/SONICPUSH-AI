import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';
import type { GoogleGenAI } from '@google/genai';
import { createSonicPushApp } from '../server/app.ts';
import {
  resolveServerSession,
  type AuthClaimManager,
  type VerifiedFirebaseIdentity,
} from '../server/auth.ts';
import {
  SERVER_TIMESTAMP_SENTINEL,
  type AdminFirestoreAdapter,
  type AdminQueryFilter,
  type AdminTx,
} from '../server/firebaseAdmin.ts';
import { AudioRetentionService, type AudioStorageAdapter } from '../server/audioStorage.ts';
import { verifyPaystackWebhookSignature } from '../server/payments.ts';
import { FirestoreDistributedQuotaLimiter } from '../server/rateLimit.ts';
import { detectAudioMagicSignature, validateAudioUpload } from '../server/audioSecurity.ts';

function cloneValue<T>(val: T): T {
  if (val === SERVER_TIMESTAMP_SENTINEL) {
    return new Date().toISOString() as unknown as T;
  }
  if (Array.isArray(val)) {
    return val.map((item) => cloneValue(item)) as unknown as T;
  }
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = cloneValue(v);
      }
    }
    return out as T;
  }
  return val;
}

interface TestFirestoreController {
  adapter: AdminFirestoreAdapter;
  docs: Record<string, Record<string, Record<string, unknown>>>;
  failNextTransactionCount: number;
}

function createInMemoryAdminFirestore(
  initialDocs?: Record<string, Record<string, Record<string, unknown>>>
): TestFirestoreController {
  const docs: Record<string, Record<string, Record<string, unknown>>> = cloneValue(
    initialDocs || {}
  );
  let txQueue: Promise<unknown> = Promise.resolve();

  const controller: TestFirestoreController = {
    docs,
    failNextTransactionCount: 0,
    adapter: {
      async getDoc(col, id) {
        const hit = docs[col]?.[id];
        return hit ? cloneValue(hit) : null;
      },
      async setDoc(col, id, data, merge = false) {
        docs[col] = docs[col] || {};
        const clean = cloneValue(data);
        docs[col][id] = merge && docs[col][id] ? { ...docs[col][id], ...clean } : clean;
      },
      async updateDoc(col, id, data) {
        if (!docs[col]?.[id]) {
          throw new Error(`NOT_FOUND:${col}/${id}`);
        }
        docs[col][id] = { ...docs[col][id], ...cloneValue(data) };
      },
      async deleteDoc(col, id) {
        if (docs[col]) {
          delete docs[col][id];
        }
      },
      async queryDocs(col, filters: AdminQueryFilter[], options) {
        const entries = Object.values(docs[col] || {}).filter((doc) =>
          filters.every((f) => {
            const v = doc[f.field];
            if (f.op === '==') return v === f.value;
            if (f.op === '<=') return typeof v === 'string' && typeof f.value === 'string' && v <= f.value;
            if (f.op === '>=') return typeof v === 'string' && typeof f.value === 'string' && v >= f.value;
            if (f.op === 'array-contains') return Array.isArray(v) && v.includes(f.value);
            return false;
          })
        );
        let result = entries.map((e) => cloneValue(e));
        if (options?.orderBy) {
          const { field, dir } = options.orderBy;
          result.sort((a, b) => {
            const av = String(a[field] ?? '');
            const bv = String(b[field] ?? '');
            return dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
          });
        }
        if (options?.limit) {
          result = result.slice(0, options.limit);
        }
        return result;
      },
      async runTransaction<T>(fn: (tx: AdminTx) => Promise<T>): Promise<T> {
        const run = async () => {
          if (controller.failNextTransactionCount > 0) {
            controller.failNextTransactionCount -= 1;
            throw new Error('SIMULATED_FIRESTORE_TRANSIENT_ERROR');
          }
          // Stage writes until transaction callback succeeds cleanly (atomic rollback on throw)
          const snapshotCols = cloneValue(docs);
          const stagedOps: Array<() => void> = [];

          const tx: AdminTx = {
            async get(col, id) {
              const hit = snapshotCols[col]?.[id];
              return hit ? cloneValue(hit) : null;
            },
            async set(col, id, data, merge = false) {
              snapshotCols[col] = snapshotCols[col] || {};
              const clean = cloneValue(data);
              snapshotCols[col][id] =
                merge && snapshotCols[col][id] ? { ...snapshotCols[col][id], ...clean } : clean;
              stagedOps.push(() => {
                docs[col] = docs[col] || {};
                const commitClean = cloneValue(data);
                docs[col][id] =
                  merge && docs[col][id] ? { ...docs[col][id], ...commitClean } : commitClean;
              });
            },
            async update(col, id, data) {
              if (!snapshotCols[col]?.[id]) {
                throw new Error(`NOT_FOUND:${col}/${id}`);
              }
              const clean = cloneValue(data);
              snapshotCols[col][id] = { ...snapshotCols[col][id], ...clean };
              stagedOps.push(() => {
                docs[col][id] = { ...docs[col][id], ...cloneValue(data) };
              });
            },
          };

          const result = await fn(tx);
          for (const op of stagedOps) op();
          return result;
        };

        const chained = txQueue.then(run, run);
        txQueue = chained.catch(() => undefined);
        return chained;
      },
    },
  };
  return controller;
}

function createInMemoryAudioStorage() {
  const objects = new Map<
    string,
    { buffer: Buffer; contentType: string; ownerId: string; organizationId: string }
  >();
  let failNextUpload = false;
  const failDeletePaths = new Set<string>();

  const adapter: AudioStorageAdapter = {
    async uploadPrivateAudio(params) {
      if (failNextUpload) {
        failNextUpload = false;
        throw new Error('SIMULATED_STORAGE_UPLOAD_FAILURE');
      }
      objects.set(params.storageObjectPath, {
        buffer: Buffer.from(params.buffer),
        contentType: params.contentType,
        ownerId: params.ownerId,
        organizationId: params.organizationId,
      });
    },
    async deleteAudioObject(storageObjectPath) {
      if (failDeletePaths.has(storageObjectPath)) {
        throw new Error('SIMULATED_STORAGE_DELETE_FAILURE');
      }
      objects.delete(storageObjectPath);
    },
    async getSignedReadUrl(storageObjectPath) {
      if (!objects.has(storageObjectPath)) {
        throw new Error('OBJECT_NOT_FOUND');
      }
      return `https://storage.example.test/signed/${encodeURIComponent(storageObjectPath)}`;
    },
    async readAudioStream(storageObjectPath) {
      const hit = objects.get(storageObjectPath);
      if (!hit) throw new Error('OBJECT_NOT_FOUND');
      return { buffer: Buffer.from(hit.buffer), contentType: hit.contentType };
    },
  };

  return {
    adapter,
    objects,
    setFailNextUpload(val: boolean) {
      failNextUpload = val;
    },
    failDeleteFor(path: string, shouldFail: boolean) {
      if (shouldFail) failDeletePaths.add(path);
      else failDeletePaths.delete(path);
    },
  };
}

function buildTestEnvironment(overrides?: {
  dbController?: TestFirestoreController;
  rateLimiter?: FirestoreDistributedQuotaLimiter;
  fetchImpl?: typeof fetch;
  stripeClient?: Stripe;
  onGeminiPrompt?: (text: string) => void;
  audioStorage?: ReturnType<typeof createInMemoryAudioStorage>;
}) {
  const dbController =
    overrides?.dbController ??
    createInMemoryAdminFirestore({
      users: {
        uid_admin: {
          uid: 'uid_admin',
          email: 'emma432cent@gmail.com',
          role: 'SUPER_ADMIN',
          organizationId: 'org_agency',
          onboardingCompleted: true,
        },
        uid_prom_a: {
          uid: 'uid_prom_a',
          email: 'promoter-a@example.com',
          role: 'PROMOTER',
          organizationId: 'org_a',
          onboardingCompleted: true,
        },
        uid_art_b: {
          uid: 'uid_art_b',
          email: 'artist-b@example.com',
          role: 'ARTIST',
          organizationId: 'org_b',
          onboardingCompleted: true,
        },
      },
      invoices: {
        inv_org_a_1: {
          id: 'inv_org_a_1',
          organizationId: 'org_a',
          ownerId: 'uid_prom_a',
          assignedUserIds: ['uid_prom_a'],
          clientName: 'Lagos Pulse Client',
          currency: 'NGN',
          amount: 50000,
          status: 'sent',
        },
        inv_org_a_2: {
          id: 'inv_org_a_2',
          organizationId: 'org_a',
          ownerId: 'uid_prom_a',
          assignedUserIds: ['uid_prom_a'],
          clientName: 'Lagos Pulse Second',
          currency: 'NGN',
          amount: 50000,
          status: 'sent',
        },
        inv_org_b_1: {
          id: 'inv_org_b_1',
          organizationId: 'org_b',
          ownerId: 'uid_art_b',
          assignedUserIds: ['uid_art_b'],
          clientName: 'Abuja Artist',
          currency: 'USD',
          amount: 250,
          status: 'sent',
        },
      },
    });

  const syncedClaims: Record<string, Record<string, unknown>> = {
    uid_admin: { superAdmin: true, role: 'SUPER_ADMIN' },
  };

  const identities: Record<string, VerifiedFirebaseIdentity> = {
    'token-admin': {
      uid: 'uid_admin',
      email: 'emma432cent@gmail.com',
      emailVerified: true,
      customClaims: syncedClaims.uid_admin,
    },
    'token-promoter-a': {
      uid: 'uid_prom_a',
      email: 'promoter-a@example.com',
      emailVerified: true,
      customClaims: syncedClaims.uid_prom_a || {},
    },
    'token-artist-b': {
      uid: 'uid_art_b',
      email: 'artist-b@example.com',
      emailVerified: true,
      customClaims: syncedClaims.uid_art_b || {},
    },
    'token-artist-b-refreshed': {
      uid: 'uid_art_b',
      email: 'artist-b@example.com',
      emailVerified: true,
      get customClaims() {
        return syncedClaims.uid_art_b || {};
      },
    },
    'token-unverified': {
      uid: 'uid_unverified',
      email: 'unverified@example.com',
      emailVerified: false,
      customClaims: {},
    },
  };

  const claimManager: AuthClaimManager = {
    async setCustomUserClaims(uid, claims) {
      syncedClaims[uid] = { ...claims };
    },
  };

  const audioStorage = overrides?.audioStorage ?? createInMemoryAudioStorage();
  const retentionService = new AudioRetentionService(dbController.adapter, audioStorage.adapter);
  const rateLimiter =
    overrides?.rateLimiter ??
    new FirestoreDistributedQuotaLimiter(dbController.adapter, {
      config: {
        userPerMinuteLimit: 20,
        userDailyLimit: 200,
        orgDailyLimit: 500,
      },
      allowStarterTierFallback: false,
    });

  const fakeGeminiClient = {
    models: {
      generateContent: async (args: {
        contents: unknown;
        config?: { systemInstruction?: string };
      }) => {
        if (overrides?.onGeminiPrompt) {
          overrides.onGeminiPrompt(
            JSON.stringify({ contents: args.contents, systemInstruction: args.config?.systemInstruction })
          );
        }
        return {
          text: JSON.stringify({
            verifiedObservations: ['User-submitted metadata recorded.'],
            aiHypotheses: {
              songPositioning: 'Position across Afro-fusion playlists.',
              genreAssessment: 'Afrobeats',
              audienceSegments: ['Lagos Gen-Z'],
              marketingAngles: ['Late-night drive'],
              shortFormOpportunities: ['15s hook snippet'],
              emotionalStorytelling: ['Resilience'],
              suggestedObjectives: ['Awareness'],
              brandingRecommendations: ['Visual visualizer'],
              promotionalChannels: ['TikTok', 'Spotify'],
            },
          }),
        };
      },
    },
  } as unknown as GoogleGenAI;

  const app = createSonicPushApp({
    adminDb: dbController.adapter,
    adminAuth: claimManager,
    audioStorage: audioStorage.adapter,
    audioRetentionService: retentionService,
    rateLimiter,
    fetchImpl: overrides?.fetchImpl,
    stripeClient: overrides?.stripeClient,
    tokenVerifier: async (token) => {
      const found = identities[token];
      if (!found) throw new Error('INVALID_TOKEN');
      return {
        ...found,
        customClaims: { ...(found.customClaims || {}) },
      };
    },
    sessionResolver: (identity, token) =>
      resolveServerSession(identity, token, { adminDb: dbController.adapter }),
    getDoc: async (col, id) => dbController.adapter.getDoc(col, id),
    patchDoc: async (col, id, patch) => dbController.adapter.updateDoc(col, id, patch),
    fetchWorkspaceContext: async ({ organizationId }) => ({
      organizationId,
      artists: [{ id: 'art_real_1', name: 'REAL_SERVER_ARTIST' }],
      songs: [{ id: 'song_real_1', title: 'REAL_SERVER_SONG' }],
      campaigns: [],
      recentMetrics: [],
      openTasks: [],
    }),
    getGeminiClient: () => fakeGeminiClient,
    getAdminDiagnosticsFn: async () => ({
      initialized: true,
      projectId: 'silent-gist-m2t1j',
      databaseId: 'ai-studio-test',
      storageBucket: 'silent-gist-m2t1j.firebasestorage.app',
      emulators: {
        firestore: false,
        auth: false,
        storage: false,
      },
      firestoreReady: true,
      storageReady: true,
      authReady: true,
      iamStatus: 'ok',
    }),
  });

  return {
    app,
    dbController,
    audioStorage,
    retentionService,
    syncedClaims,
    rateLimiter,
  };
}

async function withLiveServer(
  app: ReturnType<typeof createSonicPushApp>,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

test('1. Auth enforcement & health endpoint: rejects missing, invalid, and unverified tokens; serves clean health telemetry', async () => {
  const { app } = buildTestEnvironment();
  await withLiveServer(app, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const healthData = (await health.json()) as {
      ok: boolean;
      checks: { firestoreReady: boolean; rateLimiterMode: string };
    };
    assert.equal(healthData.ok, true);
    assert.equal(healthData.checks.firestoreReady, true);
    assert.equal(healthData.checks.rateLimiterMode, 'firestore_distributed');

    const missing = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(missing.status, 401);

    const invalid = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: 'Bearer fake-token' },
    });
    assert.equal(invalid.status, 401);

    const unverified = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: 'Bearer token-unverified' },
    });
    assert.equal(unverified.status, 403);

    const valid = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: 'Bearer token-promoter-a' },
    });
    assert.equal(valid.status, 200);
    const data = (await valid.json()) as { role: string; isSuperAdmin: boolean };
    assert.equal(data.role, 'PROMOTER');
    assert.equal(data.isSuperAdmin, false);
  });
});

test('2. Super Admin Governance: role escalation blocked, bootstrap owner & self-demotion protected, promoted Super Admin receives claims & full access', async () => {
  const { app, dbController, syncedClaims } = buildTestEnvironment();
  await withLiveServer(app, async (baseUrl) => {
    // Non-admin cannot self-escalate on onboarding check
    const escalate = await fetch(`${baseUrl}/api/auth/onboarding-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-artist-b',
      },
      body: JSON.stringify({ role: 'SUPER_ADMIN' }),
    });
    assert.equal(escalate.status, 403);

    // Non-admin blocked from /api/admin/diagnostics and role changes
    const nonAdminDiag = await fetch(`${baseUrl}/api/admin/diagnostics`, {
      headers: { Authorization: 'Bearer token-promoter-a' },
    });
    assert.equal(nonAdminDiag.status, 403);

    const nonAdminUpdate = await fetch(`${baseUrl}/api/admin/users/uid_art_b/role`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-promoter-a',
      },
      body: JSON.stringify({ role: 'SUPER_ADMIN' }),
    });
    assert.equal(nonAdminUpdate.status, 403);

    // Bootstrap owner cannot be demoted
    const demoteOwner = await fetch(`${baseUrl}/api/admin/users/uid_admin/role`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-admin',
      },
      body: JSON.stringify({ role: 'PROMOTER' }),
    });
    assert.equal(demoteOwner.status, 403);

    // Bootstrap admin promotes uid_art_b to SUPER_ADMIN -> syncs Firebase Auth claims & logs audit entry
    const promoteRes = await fetch(`${baseUrl}/api/admin/users/uid_art_b/role`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-admin',
      },
      body: JSON.stringify({ role: 'SUPER_ADMIN' }),
    });
    assert.equal(promoteRes.status, 200);
    const promoteBody = (await promoteRes.json()) as {
      ok: boolean;
      role: string;
      claimsSynced: boolean;
    };
    assert.equal(promoteBody.ok, true);
    assert.equal(promoteBody.role, 'SUPER_ADMIN');
    assert.equal(promoteBody.claimsSynced, true);
    assert.deepEqual(syncedClaims.uid_art_b, { superAdmin: true, role: 'SUPER_ADMIN' });

    const auditLogs = Object.values(dbController.docs.admin_audit_logs || {});
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].action, 'user_role_updated');
    assert.equal(auditLogs[0].targetUid, 'uid_art_b');

    // Promoted Super Admin session reflects full admin capabilities with refreshed token
    const promotedSession = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: 'Bearer token-artist-b-refreshed' },
    });
    assert.equal(promotedSession.status, 200);
    const sessionData = (await promotedSession.json()) as {
      role: string;
      isSuperAdmin: boolean;
      isBootstrapAdmin: boolean;
      needsTokenRefresh: boolean;
    };
    assert.equal(sessionData.role, 'SUPER_ADMIN');
    assert.equal(sessionData.isSuperAdmin, true);
    assert.equal(sessionData.isBootstrapAdmin, false);
    assert.equal(sessionData.needsTokenRefresh, false);

    // Promoted Super Admin has identical diagnostics & governance access as bootstrap admin
    const promotedDiag = await fetch(`${baseUrl}/api/admin/diagnostics`, {
      headers: { Authorization: 'Bearer token-artist-b-refreshed' },
    });
    assert.equal(promotedDiag.status, 200);

    // Promoted Super Admin cannot self-demote (prevents accidental lockout)
    const selfDemote = await fetch(`${baseUrl}/api/admin/users/uid_art_b/role`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-artist-b-refreshed',
      },
      body: JSON.stringify({ role: 'ARTIST' }),
    });
    assert.equal(selfDemote.status, 403);
  });
});

test('3. Shared Firestore Payment Verification: fail-closed without keys, verifies Paystack/Flutterwave/Stripe, blocks mismatch & reference reuse', async () => {
  const prevPaystack = process.env.PAYSTACK_SECRET_KEY;
  const prevFlw = process.env.FLUTTERWAVE_SECRET_KEY;
  const prevStripe = process.env.STRIPE_SECRET_KEY;
  delete process.env.PAYSTACK_SECRET_KEY;
  delete process.env.FLUTTERWAVE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;

  try {
    const { app: noKeyApp } = buildTestEnvironment();
    await withLiveServer(noKeyApp, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-promoter-a',
        },
        body: JSON.stringify({
          invoiceId: 'inv_org_a_1',
          provider: 'paystack',
          reference: 'PSK_NOKEY_1',
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { verified: boolean; verificationStatus: string };
      assert.equal(body.verified, false);
      assert.equal(body.verificationStatus, 'awaiting_provider_integration');
    });

    process.env.PAYSTACK_SECRET_KEY = 'sk_test_paystack_dummy';
    process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST_dummy';
    process.env.STRIPE_SECRET_KEY = 'sk_test_stripe_dummy';

    const mockedGatewayFetch = async (url: string) => {
      if (url.includes('api.paystack.co/transaction/verify/PSK_OK_1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: {
              id: 99123,
              status: 'success',
              reference: 'PSK_OK_1',
              amount: 5000000,
              currency: 'NGN',
              metadata: { invoiceId: 'inv_org_a_1' },
            },
          }),
        };
      }
      if (url.includes('api.paystack.co/transaction/verify/PSK_WRONG_AMT')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: {
              id: 99124,
              status: 'success',
              reference: 'PSK_WRONG_AMT',
              amount: 10000,
              currency: 'NGN',
            },
          }),
        };
      }
      if (url.includes('api.paystack.co/transaction/verify/PSK_WRONG_CUR')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: {
              id: 99125,
              status: 'success',
              reference: 'PSK_WRONG_CUR',
              amount: 5000000,
              currency: 'USD',
            },
          }),
        };
      }
      if (url.includes('api.flutterwave.com/v3/transactions/verify_by_reference')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'success',
            data: {
              id: 778899,
              status: 'successful',
              tx_ref: 'FLW_OK_1',
              amount: 250,
              currency: 'USD',
              meta: { invoiceId: 'inv_org_b_1' },
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const mockStripeClient = {
      paymentIntents: {
        retrieve: async (id: string) => ({
          id,
          status: 'succeeded',
          amount_received: 5000000,
          amount: 5000000,
          currency: 'ngn',
          metadata: { invoiceId: 'inv_org_a_2' },
        }),
      },
      checkout: { sessions: { retrieve: async () => ({}) } },
    } as unknown as Stripe;

    const { app, dbController } = buildTestEnvironment({
      fetchImpl: mockedGatewayFetch as unknown as typeof fetch,
      stripeClient: mockStripeClient,
    });

    await withLiveServer(app, async (baseUrl) => {
      // Cross-org invoice rejected
      const crossOrg = await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-artist-b',
        },
        body: JSON.stringify({
          invoiceId: 'inv_org_a_1',
          provider: 'paystack',
          reference: 'PSK_OK_1',
        }),
      });
      assert.equal(crossOrg.status, 403);

      // Amount mismatch rejected
      const badAmt = await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-promoter-a',
        },
        body: JSON.stringify({
          invoiceId: 'inv_org_a_1',
          provider: 'paystack',
          reference: 'PSK_WRONG_AMT',
        }),
      });
      const badAmtBody = (await badAmt.json()) as { verified: boolean; verificationStatus: string };
      assert.equal(badAmtBody.verified, false);
      assert.equal(badAmtBody.verificationStatus, 'failed');

      // Currency mismatch rejected
      const badCur = await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-promoter-a',
        },
        body: JSON.stringify({
          invoiceId: 'inv_org_a_1',
          provider: 'paystack',
          reference: 'PSK_WRONG_CUR',
        }),
      });
      const badCurBody = (await badCur.json()) as { verified: boolean; verificationStatus: string };
      assert.equal(badCurBody.verified, false);
      assert.equal(badCurBody.verificationStatus, 'failed');

      // Valid Paystack minor-unit verification succeeds and writes binding to Firestore
      const okPaystack = await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-promoter-a',
        },
        body: JSON.stringify({
          invoiceId: 'inv_org_a_1',
          provider: 'paystack',
          reference: 'PSK_OK_1',
        }),
      });
      const okPaystackBody = (await okPaystack.json()) as {
        verified: boolean;
        verificationStatus: string;
        serverAttestation: string;
      };
      assert.equal(okPaystackBody.verified, true);
      assert.equal(okPaystackBody.verificationStatus, 'verified');
      assert.equal(okPaystackBody.serverAttestation.length, 64);
      assert.equal(Object.keys(dbController.docs.payment_reference_bindings || {}).length, 3);

      // Reuse of reference across a different invoice blocked 409
      const reuseSameOrg = await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-promoter-a',
        },
        body: JSON.stringify({
          invoiceId: 'inv_org_a_2',
          provider: 'paystack',
          reference: 'PSK_OK_1',
        }),
      });
      assert.equal(reuseSameOrg.status, 409);

      // Valid Flutterwave USD verification
      const okFlw = await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-artist-b',
        },
        body: JSON.stringify({
          invoiceId: 'inv_org_b_1',
          provider: 'flutterwave',
          reference: 'FLW_OK_1',
        }),
      });
      const okFlwBody = (await okFlw.json()) as { verified: boolean; verificationStatus: string };
      assert.equal(okFlwBody.verified, true);
      assert.equal(okFlwBody.verificationStatus, 'verified');

      // Valid Stripe PaymentIntent verification
      const okStripe = await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-promoter-a',
        },
        body: JSON.stringify({
          invoiceId: 'inv_org_a_2',
          provider: 'stripe',
          reference: 'pi_test_ok_2',
        }),
      });
      const okStripeBody = (await okStripe.json()) as {
        verified: boolean;
        verificationStatus: string;
      };
      assert.equal(okStripeBody.verified, true);
      assert.equal(okStripeBody.verificationStatus, 'verified');
    });
  } finally {
    if (prevPaystack === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = prevPaystack;
    if (prevFlw === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
    else process.env.FLUTTERWAVE_SECRET_KEY = prevFlw;
    if (prevStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevStripe;
  }
});

test('4. Webhooks: signatures, provider API verification, quarantine, refund/dispute, multi-instance idempotency & transient failure retry', async () => {
  const prevPaystack = process.env.PAYSTACK_SECRET_KEY;
  const prevFlwKey = process.env.FLUTTERWAVE_SECRET_KEY;
  const prevFlwHash = process.env.FLUTTERWAVE_SECRET_HASH;
  const prevStripeKey = process.env.STRIPE_SECRET_KEY;
  const prevStripeWebhook = process.env.STRIPE_WEBHOOK_SECRET;

  process.env.PAYSTACK_SECRET_KEY = 'wh_paystack_secret';
  process.env.FLUTTERWAVE_SECRET_KEY = 'flw_api_secret';
  process.env.FLUTTERWAVE_SECRET_HASH = 'wh_flw_hash_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_stripe';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_stripe_secret';

  try {
    const sharedDb = createInMemoryAdminFirestore({
      users: {
        uid_admin: {
          uid: 'uid_admin',
          email: 'emma432cent@gmail.com',
          role: 'SUPER_ADMIN',
          organizationId: 'org_agency',
        },
        uid_prom_a: {
          uid: 'uid_prom_a',
          email: 'promoter-a@example.com',
          role: 'PROMOTER',
          organizationId: 'org_a',
        },
      },
      invoices: {
        inv_org_a_1: {
          id: 'inv_org_a_1',
          organizationId: 'org_a',
          ownerId: 'uid_prom_a',
          assignedUserIds: ['uid_prom_a'],
          clientName: 'Lagos Pulse',
          currency: 'NGN',
          amount: 50000,
          status: 'sent',
        },
        inv_org_a_2: {
          id: 'inv_org_a_2',
          organizationId: 'org_a',
          ownerId: 'uid_prom_a',
          assignedUserIds: ['uid_prom_a'],
          clientName: 'Lagos Second',
          currency: 'USD',
          amount: 250,
          status: 'sent',
        },
      },
    });

    const gatewayFetch = async (url: string) => {
      if (url.includes('api.paystack.co/transaction/verify/PSK_WH_OK')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: {
              id: 551,
              status: 'success',
              reference: 'PSK_WH_OK',
              amount: 5000000,
              currency: 'NGN',
              metadata: { invoiceId: 'inv_org_a_1' },
            },
          }),
        };
      }
      if (url.includes('api.paystack.co/transaction/verify/PSK_WH_MISMATCH')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: {
              id: 552,
              status: 'success',
              reference: 'PSK_WH_MISMATCH',
              amount: 1000, // Mismatch vs invoice 5000000
              currency: 'NGN',
              metadata: { invoiceId: 'inv_org_a_1' },
            },
          }),
        };
      }
      if (url.includes('api.paystack.co/transaction/verify/PSK_WH_RETRY')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: {
              id: 553,
              status: 'success',
              reference: 'PSK_WH_RETRY',
              amount: 5000000,
              currency: 'NGN',
              metadata: { invoiceId: 'inv_org_a_1' },
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const mockStripeClient = {
      paymentIntents: {
        retrieve: async (id: string) => ({
          id,
          status: 'succeeded',
          amount_received: 25000,
          amount: 25000,
          currency: 'usd',
        }),
      },
      checkout: { sessions: { retrieve: async () => ({}) } },
    } as unknown as Stripe;

    const instance1 = buildTestEnvironment({
      dbController: sharedDb,
      fetchImpl: gatewayFetch as unknown as typeof fetch,
      stripeClient: mockStripeClient,
    });
    const instance2 = buildTestEnvironment({
      dbController: sharedDb,
      fetchImpl: gatewayFetch as unknown as typeof fetch,
      stripeClient: mockStripeClient,
    });

    const paystackOkPayload = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 'evt_psk_551',
        status: 'success',
        reference: 'PSK_WH_OK',
        amount: 5000000,
        currency: 'NGN',
        metadata: { invoiceId: 'inv_org_a_1' },
      },
    });
    const paystackOkSig = crypto
      .createHmac('sha512', 'wh_paystack_secret')
      .update(Buffer.from(paystackOkPayload, 'utf8'))
      .digest('hex');

    assert.equal(
      verifyPaystackWebhookSignature(
        Buffer.from(paystackOkPayload, 'utf8'),
        paystackOkSig,
        'wh_paystack_secret'
      ),
      true
    );

    await withLiveServer(instance1.app, async (baseUrl1) => {
      // Invalid Paystack signature -> 401
      const badSig = await fetch(`${baseUrl1}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': 'deadbeef' },
        body: paystackOkPayload,
      });
      assert.equal(badSig.status, 401);

      // Valid delivery on instance 1 reconciles invoice + payment + webhook record in Firestore
      const firstDelivery = await fetch(`${baseUrl1}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': paystackOkSig },
        body: paystackOkPayload,
      });
      assert.equal(firstDelivery.status, 200);
      const firstBody = (await firstDelivery.json()) as {
        duplicate: boolean;
        outcome: string;
        reconciliationStatus: string;
      };
      assert.equal(firstBody.duplicate, false);
      assert.equal(firstBody.outcome, 'verified');
      assert.equal(firstBody.reconciliationStatus, 'reconciled');
      assert.equal(sharedDb.docs.invoices.inv_org_a_1.status, 'paid');

      // Quarantined unmatched webhook (no invoice / binding)
      const unmatchedPayload = JSON.stringify({
        event: 'charge.success',
        data: { id: 'evt_unmatched', status: 'success', reference: 'PSK_UNKNOWN', amount: 1000, currency: 'NGN' },
      });
      const unmatchedSig = crypto
        .createHmac('sha512', 'wh_paystack_secret')
        .update(Buffer.from(unmatchedPayload, 'utf8'))
        .digest('hex');
      const unmatchedRes = await fetch(`${baseUrl1}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': unmatchedSig },
        body: unmatchedPayload,
      });
      assert.equal(unmatchedRes.status, 200);
      const unmatchedBody = (await unmatchedRes.json()) as {
        quarantined: boolean;
        reconciliationStatus: string;
      };
      assert.equal(unmatchedBody.quarantined, true);
      assert.equal(unmatchedBody.reconciliationStatus, 'quarantined');

      // Quarantined provider API amount mismatch
      const mismatchPayload = JSON.stringify({
        event: 'charge.success',
        data: {
          id: 'evt_mismatch',
          status: 'success',
          reference: 'PSK_WH_MISMATCH',
          amount: 5000000,
          currency: 'NGN',
          metadata: { invoiceId: 'inv_org_a_1' },
        },
      });
      const mismatchSig = crypto
        .createHmac('sha512', 'wh_paystack_secret')
        .update(Buffer.from(mismatchPayload, 'utf8'))
        .digest('hex');
      const mismatchRes = await fetch(`${baseUrl1}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': mismatchSig },
        body: mismatchPayload,
      });
      const mismatchBody = (await mismatchRes.json()) as { quarantined: boolean; outcome: string };
      assert.equal(mismatchBody.quarantined, true);
      assert.equal(mismatchBody.outcome, 'failed');

      // Stripe charge.refunded -> updates bound invoice to refunded
      await instance1.app; // ensure Stripe binding exists first on inv_org_a_2
      await fetch(`${baseUrl1}/api/payments/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-promoter-a' },
        body: JSON.stringify({ invoiceId: 'inv_org_a_2', provider: 'stripe', reference: 'pi_refund_1' }),
      });
      const stripe = new Stripe('sk_test_dummy');
      const stripePayload = JSON.stringify({
        id: 'evt_stripe_refund_1',
        object: 'event',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_123',
            payment_intent: 'pi_refund_1',
            amount: 25000,
            currency: 'usd',
          },
        },
      });
      const stripeSig = stripe.webhooks.generateTestHeaderString({
        payload: stripePayload,
        secret: 'whsec_test_stripe_secret',
      });
      const stripeOk = await fetch(`${baseUrl1}/api/payments/webhook/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': stripeSig },
        body: stripePayload,
      });
      assert.equal(stripeOk.status, 200);
      const stripeBody = (await stripeOk.json()) as { outcome: string; reconciliationStatus: string };
      assert.equal(stripeBody.outcome, 'refunded');
      assert.equal(stripeBody.reconciliationStatus, 'reconciled');
      assert.equal(sharedDb.docs.invoices.inv_org_a_2.status, 'refunded');

      // Transient Firestore transaction failure -> 500 + pending_retry, then Super Admin retries cleanly
      const retryPayload = JSON.stringify({
        event: 'charge.success',
        data: {
          id: 'evt_psk_retry',
          status: 'success',
          reference: 'PSK_WH_RETRY',
          amount: 5000000,
          currency: 'NGN',
          metadata: { invoiceId: 'inv_org_a_1' },
        },
      });
      const retrySig = crypto
        .createHmac('sha512', 'wh_paystack_secret')
        .update(Buffer.from(retryPayload, 'utf8'))
        .digest('hex');

      sharedDb.failNextTransactionCount = 1;
      const failedDelivery = await fetch(`${baseUrl1}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': retrySig },
        body: retryPayload,
      });
      assert.equal(failedDelivery.status, 500);
      const failedBody = (await failedDelivery.json()) as {
        eventDocId: string;
        reconciliationStatus: string;
        retryable: boolean;
      };
      assert.equal(failedBody.reconciliationStatus, 'pending_retry');
      assert.equal(failedBody.retryable, true);

      // Non-admin blocked from manual retry
      const nonAdminRetry = await fetch(
        `${baseUrl1}/api/payments/webhooks/${failedBody.eventDocId}/retry`,
        { method: 'POST', headers: { Authorization: 'Bearer token-promoter-a' } }
      );
      assert.equal(nonAdminRetry.status, 403);

      // Admin retry completes cleanly
      const adminRetry = await fetch(
        `${baseUrl1}/api/payments/webhooks/${failedBody.eventDocId}/retry`,
        { method: 'POST', headers: { Authorization: 'Bearer token-admin' } }
      );
      assert.equal(adminRetry.status, 200);
      const adminRetryBody = (await adminRetry.json()) as {
        ok: boolean;
        reconciliationStatus: string;
      };
      assert.equal(adminRetryBody.ok, true);
      assert.equal(adminRetryBody.reconciliationStatus, 'reconciled');
    });

    // Multi-instance / server-restart idempotency: instance 2 sharing sharedDb deduplicates Paystack event!
    await withLiveServer(instance2.app, async (baseUrl2) => {
      const dupAcrossInstances = await fetch(`${baseUrl2}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': paystackOkSig },
        body: paystackOkPayload,
      });
      assert.equal(dupAcrossInstances.status, 200);
      const dupBody = (await dupAcrossInstances.json()) as { duplicate: boolean; outcome: string };
      assert.equal(dupBody.duplicate, true);
      assert.equal(dupBody.outcome, 'verified');
    });
  } finally {
    if (prevPaystack === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = prevPaystack;
    if (prevFlwKey === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
    else process.env.FLUTTERWAVE_SECRET_KEY = prevFlwKey;
    if (prevFlwHash === undefined) delete process.env.FLUTTERWAVE_SECRET_HASH;
    else process.env.FLUTTERWAVE_SECRET_HASH = prevFlwHash;
    if (prevStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevStripeKey;
    if (prevStripeWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = prevStripeWebhook;
  }
});

test('5. Private Audio Storage & Retention Cleanup: upload, fail-closed on storage error, org isolation, download stream, expired cleanup & retry', async () => {
  const mp3Header = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.alloc(16)]);
  const wavHeader = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'ascii');
  const htmlSpoof = Buffer.from('<!DOCTYPE html><script>alert(1)</script>', 'utf8');

  assert.equal(detectAudioMagicSignature(mp3Header), 'mp3');
  assert.equal(validateAudioUpload(mp3Header, 'audio/mpeg', 'track.mp3').valid, true);
  assert.equal(detectAudioMagicSignature(wavHeader), 'wav');
  assert.equal(validateAudioUpload(wavHeader, 'audio/wav', 'master.wav').valid, true);
  assert.equal(detectAudioMagicSignature(htmlSpoof), null);
  assert.equal(validateAudioUpload(htmlSpoof, 'audio/mpeg', 'evil.mp3').valid, false);
  assert.equal(validateAudioUpload(wavHeader, 'audio/mpeg', 'mismatch.mp3').valid, false);

  const prevCron = process.env.AUDIO_CLEANUP_CRON_SECRET;
  process.env.AUDIO_CLEANUP_CRON_SECRET = 'cron_secret_test_123';

  try {
    const { app, dbController, audioStorage, retentionService } = buildTestEnvironment();
    await withLiveServer(app, async (baseUrl) => {
      // Unauthenticated upload -> 401
      const badForm = new FormData();
      badForm.append('title', 'Midnight Drive');
      badForm.append('audio', new Blob([htmlSpoof], { type: 'audio/mpeg' }), 'spoof.mp3');
      const unauth = await fetch(`${baseUrl}/api/ai/song-intelligence`, { method: 'POST', body: badForm });
      assert.equal(unauth.status, 401);

      // Spoofed audio -> 400
      const spoofRes = await fetch(`${baseUrl}/api/ai/song-intelligence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token-promoter-a' },
        body: badForm,
      });
      assert.equal(spoofRes.status, 400);

      // Fail-closed when storage upload throws -> 502 (never reports success!)
      audioStorage.setFailNextUpload(true);
      const validForm1 = new FormData();
      validForm1.append('title', 'Storage Fail Track');
      validForm1.append('organizationId', 'org_a');
      validForm1.append('audio', new Blob([mp3Header], { type: 'audio/mpeg' }), 'fail.mp3');
      const failStorageRes = await fetch(`${baseUrl}/api/ai/song-intelligence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token-promoter-a' },
        body: validForm1,
      });
      assert.equal(failStorageRes.status, 502);
      assert.equal(audioStorage.objects.size, 0);

      // Valid private MP3 upload stores binary in private Storage and returns metadata
      const validForm2 = new FormData();
      validForm2.append('title', 'Lagos Dawn');
      validForm2.append('organizationId', 'org_a');
      validForm2.append('audio', new Blob([mp3Header], { type: 'audio/mpeg' }), 'lagos_dawn.mp3');
      const okRes = await fetch(`${baseUrl}/api/ai/song-intelligence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token-promoter-a' },
        body: validForm2,
      });
      assert.equal(okRes.status, 200);
      const okData = (await okRes.json()) as {
        audioProcessed: boolean;
        audioUploaded: boolean;
        audioStoragePath: string;
        audioUploadedAt: string;
        audioRetentionExpiresAt: string;
        audioStorageCleanupStatus: string;
      };
      assert.equal(okData.audioProcessed, true);
      assert.equal(okData.audioUploaded, true);
      assert.equal(okData.audioStorageCleanupStatus, 'active');
      assert.match(okData.audioStoragePath, /^organizations\/org_a\/audio\/[a-f0-9-]+\.mp3$/);
      assert.ok(audioStorage.objects.has(okData.audioStoragePath));

      // Seed songs doc for authorized playback / stream / deletion / expiration cleanup checks
      await dbController.adapter.setDoc('songs', 'song_org_a_1', {
        id: 'song_org_a_1',
        organizationId: 'org_a',
        ownerId: 'uid_prom_a',
        assignedUserIds: ['uid_prom_a'],
        title: 'Lagos Dawn',
        audioStoragePath: okData.audioStoragePath,
        audioMimeType: 'audio/mpeg',
        audioUploadedAt: okData.audioUploadedAt,
        audioRetentionExpiresAt: '2020-01-01T00:00:00.000Z', // already expired for retention cleanup test
        audioStorageCleanupStatus: 'active',
      });

      // Cross-org audio download rejected 403
      const crossOrgAudio = await fetch(`${baseUrl}/api/songs/song_org_a_1/audio-url`, {
        headers: { Authorization: 'Bearer token-artist-b' },
      });
      assert.equal(crossOrgAudio.status, 403);

      // Authorized org member receives signed URL & can stream authorized audio
      const orgUrlRes = await fetch(`${baseUrl}/api/songs/song_org_a_1/audio-url`, {
        headers: { Authorization: 'Bearer token-promoter-a' },
      });
      assert.equal(orgUrlRes.status, 200);
      const streamRes = await fetch(`${baseUrl}/api/songs/song_org_a_1/audio-stream`, {
        headers: { Authorization: 'Bearer token-promoter-a' },
      });
      assert.equal(streamRes.status, 200);
      const streamedBuf = Buffer.from(await streamRes.arrayBuffer());
      assert.equal(streamedBuf.length, mp3Header.length);

      // Retention cleanup failure marks 'cleanup_failed', then next retry run succeeds -> 'deleted'
      audioStorage.failDeleteFor(okData.audioStoragePath, true);
      const failedCleanup = await retentionService.cleanupExpiredAudio({ now: new Date('2026-01-01T00:00:00.000Z') });
      assert.equal(failedCleanup.scanned, 1);
      assert.equal(failedCleanup.failed, 1);
      assert.equal(dbController.docs.songs.song_org_a_1.audioStorageCleanupStatus, 'cleanup_failed');
      assert.ok(audioStorage.objects.has(okData.audioStoragePath));

      audioStorage.failDeleteFor(okData.audioStoragePath, false);

      // Non-admin cannot invoke cleanup endpoint; valid cron secret or Super Admin can!
      const nonAdminCleanup = await fetch(`${baseUrl}/api/admin/audio/cleanup`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token-promoter-a' },
      });
      assert.equal(nonAdminCleanup.status, 403);

      const cronCleanup = await fetch(`${baseUrl}/api/admin/audio/cleanup`, {
        method: 'POST',
        headers: { 'x-cron-secret': 'cron_secret_test_123' },
      });
      assert.equal(cronCleanup.status, 200);
      const cronSummary = (await cronCleanup.json()) as { scanned: number; deleted: number; failed: number };
      assert.equal(cronSummary.scanned, 1);
      assert.equal(cronSummary.deleted, 1);
      assert.equal(cronSummary.failed, 0);
      assert.equal(dbController.docs.songs.song_org_a_1.audioStorageCleanupStatus, 'deleted');
      assert.equal(audioStorage.objects.has(okData.audioStoragePath), false);
      assert.equal(Object.keys(dbController.docs.audio_cleanup_logs || {}).length, 2);

      // Song deletion endpoint deletes storage & Firestore doc cleanly
      const validForm3 = new FormData();
      validForm3.append('title', 'Delete Me');
      validForm3.append('organizationId', 'org_a');
      validForm3.append('audio', new Blob([mp3Header], { type: 'audio/mpeg' }), 'del.mp3');
      const okRes3 = await fetch(`${baseUrl}/api/ai/song-intelligence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token-promoter-a' },
        body: validForm3,
      });
      const okData3 = (await okRes3.json()) as { audioStoragePath: string };
      await dbController.adapter.setDoc('songs', 'song_org_a_del', {
        id: 'song_org_a_del',
        organizationId: 'org_a',
        ownerId: 'uid_prom_a',
        assignedUserIds: ['uid_prom_a'],
        title: 'Delete Me',
        audioStoragePath: okData3.audioStoragePath,
        audioStorageCleanupStatus: 'active',
      });
      assert.ok(audioStorage.objects.has(okData3.audioStoragePath));

      const delRes = await fetch(`${baseUrl}/api/songs/song_org_a_del`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token-promoter-a' },
      });
      assert.equal(delRes.status, 200);
      assert.equal(audioStorage.objects.has(okData3.audioStoragePath), false);
      assert.equal(dbController.docs.songs.song_org_a_del, undefined);
    });
  } finally {
    if (prevCron === undefined) delete process.env.AUDIO_CLEANUP_CRON_SECRET;
    else process.env.AUDIO_CLEANUP_CRON_SECRET = prevCron;
  }
});

test('6. Distributed Firestore AI Quotas: per-user, per-org, per-feature limits, concurrent race safety, multi-instance & sanitized logs', async () => {
  const sharedDb = createInMemoryAdminFirestore({
    users: {
      uid_prom_a: { uid: 'uid_prom_a', email: 'promoter-a@example.com', role: 'PROMOTER', organizationId: 'org_a' },
      uid_prom_a2: { uid: 'uid_prom_a2', email: 'promoter-a2@example.com', role: 'PROMOTER', organizationId: 'org_a' },
    },
  });

  // 6a. Direct concurrent burst safety + multi-instance quota enforcement
  const limiterInstanceA = new FirestoreDistributedQuotaLimiter(sharedDb.adapter, {
    config: {
      userPerMinuteLimit: 3,
      userDailyLimit: 10,
      orgDailyLimit: 4,
      featureDailyLimits: {
        assistant: 3,
        campaign_generate: 2,
      },
    },
    allowStarterTierFallback: false,
  });

  const limiterInstanceB = new FirestoreDistributedQuotaLimiter(sharedDb.adapter, {
    config: {
      userPerMinuteLimit: 3,
      userDailyLimit: 10,
      orgDailyLimit: 4,
      featureDailyLimits: {
        assistant: 3,
        campaign_generate: 2,
      },
    },
    allowStarterTierFallback: false,
  });

  // Fire 6 concurrent requests for the same user on instance A -> strictly 3 allowed, 3 rejected!
  const burstDecisions = await Promise.all(
    Array.from({ length: 6 }, () =>
      limiterInstanceA.checkAndConsume({
        uid: 'uid_prom_a',
        organizationId: 'org_a',
        feature: 'assistant',
        now: 1_760_000_000_000,
      })
    )
  );
  const allowedCount = burstDecisions.filter((d) => d.allowed).length;
  const blockedCount = burstDecisions.filter((d) => !d.allowed).length;
  assert.equal(allowedCount, 3);
  assert.equal(blockedCount, 3);

  // Across a "restart" / second backend instance B sharing Firestore: org_a now has 3/4 daily used.
  // Different user in org_a gets 1 allowed request on instance B, then 2nd triggers org_daily limit!
  const secondUserOk = await limiterInstanceB.checkAndConsume({
    uid: 'uid_prom_a2',
    organizationId: 'org_a',
    feature: 'campaign_generate',
    now: 1_760_000_000_000,
  });
  assert.equal(secondUserOk.allowed, true);

  const orgDailyBlocked = await limiterInstanceB.checkAndConsume({
    uid: 'uid_prom_a2',
    organizationId: 'org_a',
    feature: 'campaign_generate',
    now: 1_760_000_000_000,
  });
  assert.equal(orgDailyBlocked.allowed, false);
  assert.equal(orgDailyBlocked.scope, 'org_daily');

  // Feature-specific daily limit check on a fresh org
  const featLim = new FirestoreDistributedQuotaLimiter(sharedDb.adapter, {
    config: {
      userPerMinuteLimit: 10,
      userDailyLimit: 20,
      orgDailyLimit: 50,
      featureDailyLimits: { campaign_generate: 1 },
    },
    allowStarterTierFallback: false,
  });
  const featFirst = await featLim.checkAndConsume({
    uid: 'uid_other',
    organizationId: 'org_other',
    feature: 'campaign_generate',
  });
  const featSecond = await featLim.checkAndConsume({
    uid: 'uid_other',
    organizationId: 'org_other',
    feature: 'campaign_generate',
  });
  assert.equal(featFirst.allowed, true);
  assert.equal(featSecond.allowed, false);
  assert.equal(featSecond.scope, 'feature_daily');

  // 6b. End-to-end /api/ai/assistant verifies server context, sanitized logs, and 429 enforcement
  sharedDb.docs.ai_rate_limits = {};
  let capturedPrompt = '';
  const tightEndpointLimiter = new FirestoreDistributedQuotaLimiter(sharedDb.adapter, {
    config: { userPerMinuteLimit: 2, userDailyLimit: 5, orgDailyLimit: 5 },
    allowStarterTierFallback: false,
  });
  const { app } = buildTestEnvironment({
    dbController: sharedDb,
    rateLimiter: tightEndpointLimiter,
    onGeminiPrompt: (txt) => {
      capturedPrompt = txt;
    },
  });

  await withLiveServer(app, async (baseUrl) => {
    const unauth = await fetch(`${baseUrl}/api/ai/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    });
    assert.equal(unauth.status, 401);

    // Cross-org rejected before quota burn
    const crossOrg = await fetch(`${baseUrl}/api/ai/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-promoter-a' },
      body: JSON.stringify({
        organizationId: 'org_b',
        messages: [{ role: 'user', content: 'Show org_b secrets' }],
      }),
    });
    assert.equal(crossOrg.status, 403);

    // Spoofed client workspace context ignored; real server snapshot injected
    const okRes = await fetch(`${baseUrl}/api/ai/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-promoter-a' },
      body: JSON.stringify({
        organizationId: 'org_a',
        messages: [{ role: 'user', content: 'TOP_SECRET_USER_PROMPT_DO_NOT_LOG' }],
        workspaceContext: { artists: [{ name: 'SPOOFED_CLIENT_ARTIST' }] },
      }),
    });
    assert.equal(okRes.status, 200);
    assert.ok(capturedPrompt.includes('REAL_SERVER_ARTIST'));
    assert.equal(capturedPrompt.includes('SPOOFED_CLIENT_ARTIST'), false);

    // 2nd request triggers 429 from distributed Firestore quota
    const limitedRes = await fetch(`${baseUrl}/api/ai/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-promoter-a' },
      body: JSON.stringify({
        organizationId: 'org_a',
        messages: [{ role: 'user', content: 'Another query' }],
      }),
    });
    assert.equal(limitedRes.status, 429);

    // Verify ai_usage_logs NEVER contain sensitive prompt text or email PII
    await new Promise((r) => setTimeout(r, 20));
    const usageSerialized = JSON.stringify(sharedDb.docs.ai_usage_logs || {});
    assert.equal(usageSerialized.includes('TOP_SECRET_USER_PROMPT_DO_NOT_LOG'), false);
    assert.equal(usageSerialized.includes('promoter-a@example.com'), false);
  });
});
