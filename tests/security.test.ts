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
  failDeleteCounts: Map<string, number>;
  failUpdateCounts: Map<string, number>;
  failSetCounts: Map<string, number>;
  failGetCounts: Map<string, number>;
}

function createInMemoryAdminFirestore(
  initialDocs?: Record<string, Record<string, Record<string, unknown>>>
): TestFirestoreController {
  const docs: Record<string, Record<string, Record<string, unknown>>> = cloneValue(
    initialDocs || {}
  );
  let txQueue: Promise<unknown> = Promise.resolve();
  const failDeleteCounts = new Map<string, number>();
  const failUpdateCounts = new Map<string, number>();
  const failSetCounts = new Map<string, number>();
  const failGetCounts = new Map<string, number>();

  const controller: TestFirestoreController = {
    docs,
    failNextTransactionCount: 0,
    failDeleteCounts,
    failUpdateCounts,
    failSetCounts,
    failGetCounts,
    adapter: {
      async getDoc(col, id) {
        const key = `${col}/${id}`;
        const rem = failGetCounts.get(key) || 0;
        if (rem > 0) {
          failGetCounts.set(key, rem - 1);
          throw new Error(`SIMULATED_FIRESTORE_GET_FAILURE:${key}`);
        }
        const hit = docs[col]?.[id];
        return hit ? cloneValue(hit) : null;
      },
      async setDoc(col, id, data, merge = false) {
        const key = `${col}/${id}`;
        const rem = failSetCounts.get(key) || 0;
        if (rem > 0) {
          failSetCounts.set(key, rem - 1);
          throw new Error(`SIMULATED_FIRESTORE_SET_FAILURE:${key}`);
        }
        docs[col] = docs[col] || {};
        const clean = cloneValue(data);
        docs[col][id] = merge && docs[col][id] ? { ...docs[col][id], ...clean } : clean;
      },
      async updateDoc(col, id, data) {
        const key = `${col}/${id}`;
        const rem = failUpdateCounts.get(key) || 0;
        if (rem > 0) {
          failUpdateCounts.set(key, rem - 1);
          throw new Error(`SIMULATED_FIRESTORE_UPDATE_FAILURE:${key}`);
        }
        if (!docs[col]?.[id]) {
          throw new Error(`NOT_FOUND:${col}/${id}`);
        }
        docs[col][id] = { ...docs[col][id], ...cloneValue(data) };
      },
      async deleteDoc(col, id) {
        const key = `${col}/${id}`;
        const rem = failDeleteCounts.get(key) || 0;
        if (rem > 0) {
          failDeleteCounts.set(key, rem - 1);
          throw new Error(`SIMULATED_FIRESTORE_DELETE_FAILURE:${key}`);
        }
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
          // Strictly enforce real Firestore rule: all reads must execute before any writes!
          const snapshotCols = cloneValue(docs);
          const stagedOps: Array<() => void> = [];
          let hasWrittenInTx = false;

          const tx: AdminTx = {
            async get(col, id) {
              if (hasWrittenInTx) {
                throw new Error(
                  'Firestore transactions require all reads to be executed before all writes.'
                );
              }
              const hit = snapshotCols[col]?.[id];
              return hit ? cloneValue(hit) : null;
            },
            async set(col, id, data, merge = false) {
              hasWrittenInTx = true;
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
              hasWrittenInTx = true;
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
    {
      buffer: Buffer;
      contentType: string;
      ownerId: string;
      organizationId: string;
      uploadedAt: string;
    }
  >();
  let failNextUpload = false;
  const failDeletePaths = new Set<string>();
  const failMetadataErrors = new Map<string, Error>();

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
        uploadedAt: params.uploadedAt || new Date().toISOString(),
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
    async getAudioMetadata(storageObjectPath) {
      const injectedErr = failMetadataErrors.get(storageObjectPath);
      if (injectedErr) {
        throw injectedErr;
      }
      const hit = objects.get(storageObjectPath);
      if (!hit) return null;
      return {
        organizationId: hit.organizationId || undefined,
        ownerId: hit.ownerId || undefined,
      };
    },
    async listAudioObjectsPage({ prefix = 'organizations/', pageToken, maxResults = 500 }) {
      const sortedPaths = Array.from(objects.keys())
        .filter((p) => p.startsWith(prefix))
        .sort((a, b) => a.localeCompare(b));
      let afterPath: string | undefined;
      if (pageToken && pageToken.startsWith('after:')) {
        afterPath = Buffer.from(pageToken.slice(6), 'base64').toString('utf8');
      }
      const eligible = afterPath
        ? sortedPaths.filter((p) => p > afterPath!)
        : sortedPaths;
      const limit = Math.max(1, maxResults);
      const pagePaths = eligible.slice(0, limit);
      const hasMore = eligible.length > pagePaths.length;
      const pageObjects = pagePaths.map((path) => {
        const entry = objects.get(path)!;
        return {
          path,
          organizationId: entry.organizationId || undefined,
          uploadedAt: entry.uploadedAt,
          updatedAt: entry.uploadedAt,
        };
      });
      const nextPageToken =
        hasMore && pagePaths.length > 0
          ? `after:${Buffer.from(pagePaths[pagePaths.length - 1], 'utf8').toString('base64')}`
          : undefined;
      return {
        objects: pageObjects,
        ...(nextPageToken ? { nextPageToken } : {}),
      };
    },
    async listAudioObjects(prefix = 'organizations/') {
      const out = [];
      let pageToken: string | undefined;
      do {
        const page = await adapter.listAudioObjectsPage!({
          prefix,
          pageToken,
          maxResults: 500,
        });
        out.push(...page.objects);
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
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
    failMetadataFor(path: string, err: Error | null) {
      if (err) failMetadataErrors.set(path, err);
      else failMetadataErrors.delete(path);
    },
    seedObject(
      path: string,
      entry: {
        buffer?: Buffer;
        contentType?: string;
        ownerId?: string;
        organizationId: string;
        uploadedAt: string;
      }
    ) {
      objects.set(path, {
        buffer: entry.buffer ?? Buffer.from('ID3'),
        contentType: entry.contentType ?? 'audio/mpeg',
        ownerId: entry.ownerId ?? 'uid_seed',
        organizationId: entry.organizationId,
        uploadedAt: entry.uploadedAt,
      });
    },
  };
}

function buildTestEnvironment(overrides?: {
  dbController?: TestFirestoreController;
  rateLimiter?: FirestoreDistributedQuotaLimiter;
  fetchImpl?: typeof fetch;
  stripeClient?: Stripe;
  onGeminiPrompt?: (text: string) => void;
  failGeminiError?: Error;
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
        if (overrides?.failGeminiError) {
          throw overrides.failGeminiError;
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
    assert.deepEqual(syncedClaims.uid_art_b, {
      superAdmin: true,
      role: 'SUPER_ADMIN',
      organizationId: 'org_b',
    });

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

test('7. Payment Regression: strict tx ordering with/without existing payment docs, Stripe cs_->pi_ & Paystack dispute/refund, incomplete webhooks & transient retry', async () => {
  const prevPaystack = process.env.PAYSTACK_SECRET_KEY;
  const prevStripeKey = process.env.STRIPE_SECRET_KEY;
  const prevStripeWebhook = process.env.STRIPE_WEBHOOK_SECRET;

  process.env.PAYSTACK_SECRET_KEY = 'sk_test_paystack_reg';
  process.env.STRIPE_SECRET_KEY = 'sk_test_stripe_reg';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stripe_reg';

  try {
    const dbCtrl = createInMemoryAdminFirestore({
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
        inv_with_pm: {
          id: 'inv_with_pm',
          organizationId: 'org_a',
          ownerId: 'uid_prom_a',
          assignedUserIds: ['uid_prom_a'],
          clientName: 'With Payment Doc',
          currency: 'NGN',
          amount: 25000,
          status: 'awaiting_verification',
        },
        inv_no_pm: {
          id: 'inv_no_pm',
          organizationId: 'org_a',
          ownerId: 'uid_prom_a',
          assignedUserIds: ['uid_prom_a'],
          clientName: 'Without Payment Doc',
          currency: 'NGN',
          amount: 40000,
          status: 'sent',
        },
        inv_stripe_cs: {
          id: 'inv_stripe_cs',
          organizationId: 'org_a',
          ownerId: 'uid_prom_a',
          assignedUserIds: ['uid_prom_a'],
          clientName: 'Stripe Checkout Session',
          currency: 'USD',
          amount: 120,
          status: 'sent',
        },
      },
      payments: {
        pay_existing_1: {
          id: 'pay_existing_1',
          organizationId: 'org_a',
          ownerId: 'uid_prom_a',
          assignedUserIds: ['uid_prom_a'],
          invoiceId: 'inv_with_pm',
          provider: 'paystack',
          reference: 'PSK_WITH_PM_1',
          currency: 'NGN',
          amount: 25000,
          verificationStatus: 'pending',
        },
      },
    });

    const gatewayFetch = async (url: string) => {
      if (url.includes('PSK_WITH_PM_1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: {
              id: 801,
              status: 'success',
              reference: 'PSK_WITH_PM_1',
              amount: 2500000,
              currency: 'NGN',
              metadata: { invoiceId: 'inv_with_pm', organizationId: 'org_a' },
            },
          }),
        };
      }
      if (url.includes('PSK_NO_PM_1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: {
              id: 802,
              status: 'success',
              reference: 'PSK_NO_PM_1',
              amount: 4000000,
              currency: 'NGN',
              metadata: { invoiceId: 'inv_no_pm', organizationId: 'org_a' },
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const mockStripeClient = {
      checkout: {
        sessions: {
          retrieve: async (id: string) => ({
            id,
            payment_status: 'paid',
            payment_intent: 'pi_linked_cs_1',
            amount_total: 12000,
            currency: 'usd',
            metadata: { invoiceId: 'inv_stripe_cs', organizationId: 'org_a' },
          }),
        },
      },
      paymentIntents: {
        retrieve: async (id: string) => ({
          id,
          status: 'succeeded',
          amount_received: 12000,
          currency: 'usd',
          metadata: { invoiceId: 'inv_stripe_cs', organizationId: 'org_a' },
        }),
      },
    } as unknown as Stripe;

    const { app } = buildTestEnvironment({
      dbController: dbCtrl,
      fetchImpl: gatewayFetch as unknown as typeof fetch,
      stripeClient: mockStripeClient,
    });

    const signPaystack = (raw: string) =>
      crypto.createHmac('sha512', 'sk_test_paystack_reg').update(Buffer.from(raw, 'utf8')).digest('hex');

    await withLiveServer(app, async (baseUrl) => {
      // 7a. Super Admin /verify + /reconcile on invoice WITH existing payment doc (catches any read-after-write!)
      const verifyWithPm = await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-admin' },
        body: JSON.stringify({
          invoiceId: 'inv_with_pm',
          provider: 'paystack',
          reference: 'PSK_WITH_PM_1',
        }),
      });
      assert.equal(verifyWithPm.status, 200);
      assert.equal(dbCtrl.docs.invoices.inv_with_pm.status, 'paid');

      const reconcileWithPm = await fetch(`${baseUrl}/api/payments/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-admin' },
        body: JSON.stringify({
          invoiceId: 'inv_with_pm',
          paymentId: 'pay_existing_1',
          provider: 'paystack',
          reference: 'PSK_WITH_PM_1',
        }),
      });
      assert.equal(reconcileWithPm.status, 200);
      assert.equal(dbCtrl.docs.payments.pay_existing_1.verificationStatus, 'verified');

      // 7b. Reconcile on invoice WITHOUT existing payment doc succeeds cleanly
      const verifyNoPm = await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-promoter-a' },
        body: JSON.stringify({
          invoiceId: 'inv_no_pm',
          provider: 'paystack',
          reference: 'PSK_NO_PM_1',
        }),
      });
      assert.equal(verifyNoPm.status, 200);
      const reconcileNoPm = await fetch(`${baseUrl}/api/payments/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-admin' },
        body: JSON.stringify({
          invoiceId: 'inv_no_pm',
          provider: 'paystack',
          reference: 'PSK_NO_PM_1',
        }),
      });
      assert.equal(reconcileNoPm.status, 200);
      assert.equal(dbCtrl.docs.invoices.inv_no_pm.status, 'paid');

      // 7c. Incomplete verified webhook (missing amount/currency) is quarantined safely
      const incompletePayload = JSON.stringify({
        event: 'charge.success',
        data: {
          id: 'evt_incomplete_1',
          status: 'success',
          reference: 'PSK_NO_PM_1',
          metadata: { invoiceId: 'inv_no_pm' },
        },
      });
      const incompleteRes = await fetch(`${baseUrl}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signPaystack(incompletePayload) },
        body: incompletePayload,
      });
      assert.equal(incompleteRes.status, 200);
      const incompleteBody = (await incompleteRes.json()) as { quarantined: boolean };
      assert.equal(incompleteBody.quarantined, true);

      // 7d. Paystack dispute event (using nested data.transaction.reference) updates existing payment & invoice
      const disputePayload = JSON.stringify({
        event: 'charge.dispute.create',
        data: {
          id: 'disp_1',
          currency: 'NGN',
          amount: 2500000,
          transaction: { reference: 'PSK_WITH_PM_1' },
        },
      });
      const disputeRes = await fetch(`${baseUrl}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signPaystack(disputePayload) },
        body: disputePayload,
      });
      assert.equal(disputeRes.status, 200);
      const disputeBody = (await disputeRes.json()) as { outcome: string; reconciliationStatus: string };
      assert.equal(disputeBody.outcome, 'disputed');
      assert.equal(disputeBody.reconciliationStatus, 'reconciled');
      assert.equal(dbCtrl.docs.invoices.inv_with_pm.status, 'disputed');
      assert.equal(dbCtrl.docs.payments.pay_existing_1.verificationStatus, 'disputed');

      // 7e. Paystack refund event (using data.transaction_reference) on invoice WITHOUT prior payment creates canonical payment doc cleanly
      const refundPayload = JSON.stringify({
        event: 'refund.processed',
        data: {
          id: 'ref_1',
          transaction_reference: 'PSK_NO_PM_1',
          currency: 'NGN',
          amount: 4000000,
        },
      });
      const refundRes = await fetch(`${baseUrl}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signPaystack(refundPayload) },
        body: refundPayload,
      });
      assert.equal(refundRes.status, 200);
      assert.equal(dbCtrl.docs.invoices.inv_no_pm.status, 'refunded');
      assert.ok(Object.values(dbCtrl.docs.payments).some((p) => p.invoiceId === 'inv_no_pm' && p.verificationStatus === 'refunded'));

      // 7f. Failed webhook after transient Firestore tx error transitions awaiting_verification -> sent cleanly on retry
      await dbCtrl.adapter.setDoc('invoices', 'inv_fail_test', {
        id: 'inv_fail_test',
        organizationId: 'org_a',
        ownerId: 'uid_prom_a',
        assignedUserIds: ['uid_prom_a'],
        clientName: 'Fail Retry Test',
        currency: 'NGN',
        amount: 10000,
        status: 'awaiting_verification',
      });
      const failWhPayload = JSON.stringify({
        event: 'charge.failed',
        data: {
          id: 'fail_wh_1',
          status: 'failed',
          reference: 'PSK_FAIL_RETRY_1',
          gateway_response: 'Insufficient funds',
          metadata: { invoiceId: 'inv_fail_test', organizationId: 'org_a' },
        },
      });
      dbCtrl.failNextTransactionCount = 1;
      const failWh1 = await fetch(`${baseUrl}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signPaystack(failWhPayload) },
        body: failWhPayload,
      });
      assert.equal(failWh1.status, 500);
      const failWh1Body = (await failWh1.json()) as { eventDocId: string; retryable: boolean };
      assert.equal(failWh1Body.retryable, true);

      const failRetry = await fetch(`${baseUrl}/api/payments/webhooks/${failWh1Body.eventDocId}/retry`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token-admin' },
      });
      assert.equal(failRetry.status, 200);
      assert.equal(dbCtrl.docs.invoices.inv_fail_test.status, 'sent');

      // 7g. Stripe Checkout Session cs_ -> PaymentIntent pi_ correlation across webhook lifecycle
      const verifyCs = await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-promoter-a' },
        body: JSON.stringify({
          invoiceId: 'inv_stripe_cs',
          provider: 'stripe',
          reference: 'cs_test_session_1',
        }),
      });
      assert.equal(verifyCs.status, 200);

      const stripe = new Stripe('sk_test_dummy');
      const stripeRefundPayload = JSON.stringify({
        id: 'evt_cs_refund_1',
        object: 'event',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_cs_1',
            payment_intent: 'pi_linked_cs_1',
            amount: 12000,
            currency: 'usd',
          },
        },
      });
      const stripeSig = stripe.webhooks.generateTestHeaderString({
        payload: stripeRefundPayload,
        secret: 'whsec_stripe_reg',
      });
      const stripeCsRefund = await fetch(`${baseUrl}/api/payments/webhook/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': stripeSig },
        body: stripeRefundPayload,
      });
      assert.equal(stripeCsRefund.status, 200);
      assert.equal(dbCtrl.docs.invoices.inv_stripe_cs.status, 'refunded');
    });
  } finally {
    if (prevPaystack === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = prevPaystack;
    if (prevStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevStripeKey;
    if (prevStripeWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = prevStripeWebhook;
  }
});

test('8. Phase 2.1 Audio Integrity: Gemini failure rollback & queue retry, Song delete preserves DB on Storage failure, and org-safe orphan reconciliation', async () => {
  const mp3Header = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.alloc(16)]);

  // 8a. Gemini failure after audio upload rolls back uploaded Storage object immediately (never leaves orphan)
  const storageRollback = createInMemoryAudioStorage();
  const envRollback = buildTestEnvironment({
    audioStorage: storageRollback,
    failGeminiError: new Error('GEMINI_UPSTREAM_TIMEOUT'),
  });

  await withLiveServer(envRollback.app, async (baseUrl) => {
    const form = new FormData();
    form.append('title', 'Gemini Fail Track');
    form.append('organizationId', 'org_a');
    form.append('audio', new Blob([mp3Header], { type: 'audio/mpeg' }), 'fail_track.mp3');

    const res = await fetch(`${baseUrl}/api/ai/song-intelligence`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-promoter-a' },
      body: form,
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as {
      audioProcessed: boolean;
      audioUploaded: boolean;
      cleanupQueued: boolean;
    };
    assert.equal(body.audioProcessed, false);
    assert.equal(body.audioUploaded, false);
    assert.equal(body.cleanupQueued, false);
    assert.equal(storageRollback.objects.size, 0);
    const logs = Object.values(envRollback.dbController.docs.audio_cleanup_logs || {});
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'deleted');
    assert.equal(logs[0].reason, 'gemini_analysis_failed');
  });

  // 8b. Gemini failure when Storage rollback ALSO fails -> queues durable cleanup retry & cleans up on next run
  const storageQueueFail = createInMemoryAudioStorage();
  const baseUpload = storageQueueFail.adapter.uploadPrivateAudio.bind(storageQueueFail.adapter);
  storageQueueFail.adapter.uploadPrivateAudio = async (params) => {
    await baseUpload(params);
    storageQueueFail.failDeleteFor(params.storageObjectPath, true);
  };
  const envGeminiQueue = buildTestEnvironment({
    audioStorage: storageQueueFail,
    failGeminiError: new Error('GEMINI_UNAVAILABLE'),
  });

  await withLiveServer(envGeminiQueue.app, async (baseUrl) => {
    const form = new FormData();
    form.append('title', 'Gemini And Delete Fail');
    form.append('organizationId', 'org_a');
    form.append('audio', new Blob([mp3Header], { type: 'audio/mpeg' }), 'double_fail.mp3');

    const res = await fetch(`${baseUrl}/api/ai/song-intelligence`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-promoter-a' },
      body: form,
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { cleanupQueued: boolean };
    assert.equal(body.cleanupQueued, true);
    assert.equal(storageQueueFail.objects.size, 1);
    const queuedItems = Object.values(envGeminiQueue.dbController.docs.audio_cleanup_queue || {});
    assert.equal(queuedItems.length, 1);
    assert.equal(queuedItems[0].reason, 'gemini_analysis_failed');
    const uploadedPath = String(queuedItems[0].storageObjectPath);

    // Recover Storage and trigger retention cleanup -> queue item & file cleaned up
    storageQueueFail.failDeleteFor(uploadedPath, false);
    const summary = await envGeminiQueue.retentionService.cleanupExpiredAudio({
      includeOrphans: false,
    });
    assert.equal(summary.queueScanned, 1);
    assert.equal(summary.queueDeleted, 1);
    assert.equal(storageQueueFail.objects.size, 0);
    assert.equal(Object.keys(envGeminiQueue.dbController.docs.audio_cleanup_queue || {}).length, 0);
  });

  // 8c. DELETE /api/songs/:songId when Storage delete fails preserves song doc, queues retry, and completes on retry
  const storageSongDel = createInMemoryAudioStorage();
  const songDelPath = 'organizations/org_a/audio/song-del-fail-1.mp3';
  storageSongDel.seedObject(songDelPath, {
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    uploadedAt: '2026-01-01T00:00:00.000Z',
  });
  storageSongDel.failDeleteFor(songDelPath, true);

  const envSongDel = buildTestEnvironment({ audioStorage: storageSongDel });
  await envSongDel.dbController.adapter.setDoc('songs', 'song_retry_del', {
    id: 'song_retry_del',
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    assignedUserIds: ['uid_prom_a'],
    title: 'Cannot Delete Storage Yet',
    audioStoragePath: songDelPath,
    audioStorageCleanupStatus: 'active',
  });

  await withLiveServer(envSongDel.app, async (baseUrl) => {
    const failedDel = await fetch(`${baseUrl}/api/songs/song_retry_del`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token-promoter-a' },
    });
    assert.equal(failedDel.status, 502);
    const failedBody = (await failedDel.json()) as {
      ok: boolean;
      deleted: boolean;
      cleanupQueued: boolean;
    };
    assert.equal(failedBody.ok, false);
    assert.equal(failedBody.deleted, false);
    assert.equal(failedBody.cleanupQueued, true);

    // Database doc MUST still exist with cleanup_failed status and durable queue entry!
    assert.ok(envSongDel.dbController.docs.songs.song_retry_del);
    assert.equal(
      envSongDel.dbController.docs.songs.song_retry_del.audioStorageCleanupStatus,
      'cleanup_failed'
    );
    const qItems = Object.values(envSongDel.dbController.docs.audio_cleanup_queue || {});
    assert.equal(qItems.length, 1);
    assert.equal(qItems[0].songId, 'song_retry_del');
    assert.equal(qItems[0].deleteSongOnCleanup, true);

    // Storage recovers -> retry cleanup completes Storage deletion AND removes song doc
    storageSongDel.failDeleteFor(songDelPath, false);
    const retrySummary = await envSongDel.retentionService.cleanupExpiredAudio({
      includeOrphans: false,
    });
    assert.equal(retrySummary.queueDeleted, 1);
    assert.equal(storageSongDel.objects.has(songDelPath), false);
    assert.equal(envSongDel.dbController.docs.songs.song_retry_del, undefined);
    assert.equal(Object.keys(envSongDel.dbController.docs.audio_cleanup_queue || {}).length, 0);
  });

  // 8d. Orphaned Storage object reconciliation respects grace period, active songs, and strictly isolates organizations
  const storageOrphan = createInMemoryAudioStorage();
  const now = new Date('2026-05-01T12:00:00.000Z');
  const twoHoursAgo = '2026-05-01T10:00:00.000Z';
  const fiveMinsAgo = '2026-05-01T11:55:00.000Z';

  const orphanOldA = 'organizations/org_a/audio/orphan-old-a.mp3';
  const orphanFreshA = 'organizations/org_a/audio/orphan-fresh-a.mp3';
  const activeOldA = 'organizations/org_a/audio/active-old-a.mp3';
  const orphanOldB = 'organizations/org_b/audio/orphan-old-b.mp3';
  const mismatchedMetaA = 'organizations/org_a/audio/cross-meta-a.mp3';

  storageOrphan.seedObject(orphanOldA, { organizationId: 'org_a', uploadedAt: twoHoursAgo });
  storageOrphan.seedObject(orphanFreshA, { organizationId: 'org_a', uploadedAt: fiveMinsAgo });
  storageOrphan.seedObject(activeOldA, { organizationId: 'org_a', uploadedAt: twoHoursAgo });
  storageOrphan.seedObject(orphanOldB, { organizationId: 'org_b', uploadedAt: twoHoursAgo });
  // Cross-org metadata mismatch must be skipped safely!
  storageOrphan.seedObject(mismatchedMetaA, { organizationId: 'org_b', uploadedAt: twoHoursAgo });

  const envOrphan = buildTestEnvironment({ audioStorage: storageOrphan });
  await envOrphan.dbController.adapter.setDoc('songs', 'song_active_ref', {
    id: 'song_active_ref',
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    assignedUserIds: ['uid_prom_a'],
    title: 'Active Referenced Song',
    audioStoragePath: activeOldA,
    audioStorageCleanupStatus: 'active',
    audioRetentionExpiresAt: '2026-08-01T00:00:00.000Z',
  });

  // Scoped cleanup for org_a ONLY deletes orphanOldA; org_b's orphanOldB, activeOldA, orphanFreshA, and mismatchedMetaA stay untouched!
  const orphanSummaryA = await envOrphan.retentionService.cleanupExpiredAudio({
    now,
    includeOrphans: true,
    orphanGraceMinutes: 60,
    organizationId: 'org_a',
  });

  assert.equal(orphanSummaryA.orphansDeleted, 1);
  assert.equal(storageOrphan.objects.has(orphanOldA), false);
  assert.equal(storageOrphan.objects.has(orphanFreshA), true);
  assert.equal(storageOrphan.objects.has(activeOldA), true);
  assert.equal(storageOrphan.objects.has(orphanOldB), true);
  assert.equal(storageOrphan.objects.has(mismatchedMetaA), true);
});

test('9. Final Cleanup Reliability: Storage-succeeded Firestore-failed preserves queue, retries remaining work, >500 full pagination & progressive cursor, and org isolation', async () => {
  // 9a. Storage deletion succeeds on DELETE /api/songs/:songId, Firestore delete fails -> queues deleteSongOnCleanup=true + storageDeleted=true + 502 cleanupPending
  const storagePartial = createInMemoryAudioStorage();
  const partialPath = 'organizations/org_a/audio/partial-del-1.mp3';
  storagePartial.seedObject(partialPath, {
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    uploadedAt: '2026-01-01T00:00:00.000Z',
  });

  const envPartial = buildTestEnvironment({ audioStorage: storagePartial });
  await envPartial.dbController.adapter.setDoc('songs', 'song_partial_del', {
    id: 'song_partial_del',
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    assignedUserIds: ['uid_prom_a'],
    title: 'Partial Failure Song',
    audioStoragePath: partialPath,
    audioStorageCleanupStatus: 'active',
  });
  // Fail the next TWO Firestore delete attempts on songs/song_partial_del:
  // 1st failure during DELETE /api/songs/:songId, 2nd failure during first queue retry!
  envPartial.dbController.failDeleteCounts.set('songs/song_partial_del', 2);

  await withLiveServer(envPartial.app, async (baseUrl) => {
    const delRes = await fetch(`${baseUrl}/api/songs/song_partial_del`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token-promoter-a' },
    });
    assert.equal(delRes.status, 502);
    const delBody = (await delRes.json()) as {
      ok: boolean;
      deleted: boolean;
      cleanupPending: boolean;
      cleanupQueued: boolean;
      storageDeleted: boolean;
    };
    assert.equal(delBody.ok, false);
    assert.equal(delBody.deleted, false);
    assert.equal(delBody.cleanupPending, true);
    assert.equal(delBody.cleanupQueued, true);
    assert.equal(delBody.storageDeleted, true);

    // Storage is already empty, song doc preserved, queue item persisted with deleteSongOnCleanup + storageDeleted
    assert.equal(storagePartial.objects.has(partialPath), false);
    assert.ok(envPartial.dbController.docs.songs.song_partial_del);
    const q1 = Object.values(envPartial.dbController.docs.audio_cleanup_queue || {});
    assert.equal(q1.length, 1);
    assert.equal(q1[0].songId, 'song_partial_del');
    assert.equal(q1[0].deleteSongOnCleanup, true);
    assert.equal(q1[0].storageDeleted, true);

    // First retry fails on Firestore deleteDoc -> queue item MUST STILL BE PRESERVED!
    const retry1 = await envPartial.retentionService.cleanupExpiredAudio({
      includeOrphans: false,
    });
    assert.equal(retry1.queueScanned, 1);
    assert.equal(retry1.queueFailed, 1);
    assert.equal(retry1.queueDeleted, 0);
    assert.ok(envPartial.dbController.docs.songs.song_partial_del);
    const q2 = Object.values(envPartial.dbController.docs.audio_cleanup_queue || {});
    assert.equal(q2.length, 1);
    assert.equal(q2[0].status, 'failed');
    assert.equal(q2[0].retryCount, 1);
    assert.equal(q2[0].storageDeleted, true);

    // Second retry succeeds -> song doc AND queue item both removed cleanly
    const retry2 = await envPartial.retentionService.cleanupExpiredAudio({
      includeOrphans: false,
    });
    assert.equal(retry2.queueScanned, 1);
    assert.equal(retry2.queueDeleted, 1);
    assert.equal(retry2.queueFailed, 0);
    assert.equal(envPartial.dbController.docs.songs.song_partial_del, undefined);
    assert.equal(Object.keys(envPartial.dbController.docs.audio_cleanup_queue || {}).length, 0);
  });

  // 9b. Queue item with deleteSongOnCleanup=false (updateDoc failure after Storage deletion) preserves queue until updateDoc succeeds
  const storageUpdateFail = createInMemoryAudioStorage();
  const updatePath = 'organizations/org_a/audio/update-fail-1.mp3';
  storageUpdateFail.seedObject(updatePath, {
    organizationId: 'org_a',
    uploadedAt: '2025-01-01T00:00:00.000Z',
  });
  const envUpdateFail = buildTestEnvironment({ audioStorage: storageUpdateFail });
  await envUpdateFail.dbController.adapter.setDoc('songs', 'song_update_fail', {
    id: 'song_update_fail',
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    assignedUserIds: ['uid_prom_a'],
    title: 'Update Fail Song',
    audioStoragePath: updatePath,
    audioRetentionExpiresAt: '2026-06-01T00:00:00.000Z',
    audioStorageCleanupStatus: 'active',
  });
  await envUpdateFail.retentionService.enqueueCleanupTask({
    storageObjectPath: updatePath,
    organizationId: 'org_a',
    songId: 'song_update_fail',
    deleteSongOnCleanup: false,
    reason: 'retention_expired',
  });
  // Fail updateDoc on songs/song_update_fail once -> Storage deletes, updateDoc fails, queue stays!
  envUpdateFail.dbController.failUpdateCounts.set('songs/song_update_fail', 1);

  const uRetry1 = await envUpdateFail.retentionService.cleanupExpiredAudio({
    now: new Date('2026-01-01T00:00:00.000Z'),
    includeOrphans: false,
  });
  assert.equal(uRetry1.queueFailed, 1);
  assert.equal(storageUpdateFail.objects.has(updatePath), false);
  const uQueueAfter1 = Object.values(envUpdateFail.dbController.docs.audio_cleanup_queue || {});
  assert.equal(uQueueAfter1.length, 1);
  assert.equal(uQueueAfter1[0].storageDeleted, true);

  // Next retry completes updateDoc -> 'deleted' and removes queue item
  const uRetry2 = await envUpdateFail.retentionService.cleanupExpiredAudio({
    now: new Date('2026-01-01T00:00:00.000Z'),
    includeOrphans: false,
  });
  assert.equal(uRetry2.queueDeleted, 1);
  assert.equal(envUpdateFail.dbController.docs.songs.song_update_fail.audioStorageCleanupStatus, 'deleted');
  assert.equal(Object.keys(envUpdateFail.dbController.docs.audio_cleanup_queue || {}).length, 0);

  // 9c. >500 Storage objects (1,250 objects across 3 pages) reconciled progressively across scheduled runs AND in full scan, with cross-org protection
  const storageLarge = createInMemoryAudioStorage();
  const oldIso = '2026-01-01T00:00:00.000Z';
  const runNow = new Date('2026-05-01T12:00:00.000Z');

  // Seed 1,250 objects in org_a: first 520 are active songs, remaining 730 (positions 521..1250) are orphans!
  // Plus 1 cross-org metadata mismatch in org_a & 10 orphans in org_b that MUST NEVER be deleted when scanning org_a.
  const envLarge = buildTestEnvironment({ audioStorage: storageLarge });
  for (let i = 0; i < 1250; i++) {
    const padded = String(i).padStart(4, '0');
    const objPath = `organizations/org_a/audio/track-${padded}.mp3`;
    storageLarge.seedObject(objPath, {
      organizationId: 'org_a',
      uploadedAt: oldIso,
    });
    if (i < 520) {
      await envLarge.dbController.adapter.setDoc('songs', `song_large_${padded}`, {
        id: `song_large_${padded}`,
        organizationId: 'org_a',
        ownerId: 'uid_prom_a',
        assignedUserIds: ['uid_prom_a'],
        title: `Active ${padded}`,
        audioStoragePath: objPath,
        audioStorageCleanupStatus: 'active',
        audioRetentionExpiresAt: '2027-01-01T00:00:00.000Z',
      });
    }
  }

  const mismatchInLarge = 'organizations/org_a/audio/track-9999-crossmeta.mp3';
  storageLarge.seedObject(mismatchInLarge, {
    organizationId: 'org_b', // conflicts with org_a path!
    uploadedAt: oldIso,
  });
  for (let j = 0; j < 10; j++) {
    storageLarge.seedObject(`organizations/org_b/audio/orgb-${j}.mp3`, {
      organizationId: 'org_b',
      uploadedAt: oldIso,
    });
  }

  // Progressive scheduled runs (1 page of 500 per run) inspect all >500 items across 3 runs without starving pages 2 & 3!
  const schedRun1 = await envLarge.retentionService.cleanupExpiredAudio({
    now: runNow,
    includeOrphans: true,
    orphanGraceMinutes: 60,
    orphanPageSize: 500,
    orphanMaxPagesPerRun: 1,
    organizationId: 'org_a',
  });
  assert.equal(schedRun1.orphanPagesScanned, 1);
  assert.equal(schedRun1.orphansScanned, 500);
  assert.equal(schedRun1.orphansDeleted, 0); // All first 500 are active songs
  assert.equal(schedRun1.orphanHasMore, true);

  const schedRun2 = await envLarge.retentionService.cleanupExpiredAudio({
    now: runNow,
    includeOrphans: true,
    orphanGraceMinutes: 60,
    orphanPageSize: 500,
    orphanMaxPagesPerRun: 1,
    organizationId: 'org_a',
  });
  assert.equal(schedRun2.orphanPagesScanned, 1);
  assert.equal(schedRun2.orphansScanned, 500); // Objects 500..999 (20 active + 480 orphans!)
  assert.equal(schedRun2.orphansDeleted, 480);
  assert.equal(schedRun2.orphanHasMore, true);

  const schedRun3 = await envLarge.retentionService.cleanupExpiredAudio({
    now: runNow,
    includeOrphans: true,
    orphanGraceMinutes: 60,
    orphanPageSize: 500,
    orphanMaxPagesPerRun: 1,
    organizationId: 'org_a',
  });
  assert.equal(schedRun3.orphanPagesScanned, 1);
  assert.equal(schedRun3.orphansScanned, 250); // Remaining 250 org_a orphans (mismatchInLarge skipped before lookup)
  assert.equal(schedRun3.orphansDeleted, 250);
  assert.equal(schedRun3.orphanHasMore, false); // Cursor resets cleanly at end of bucket!

  // Verify 520 active songs remain, cross-org metadata mismatch remains, and all 10 org_b objects remain!
  assert.equal(storageLarge.objects.has(mismatchInLarge), true);
  assert.equal(storageLarge.objects.has('organizations/org_a/audio/track-0000.mp3'), true);
  assert.equal(storageLarge.objects.has('organizations/org_a/audio/track-0519.mp3'), true);
  assert.equal(storageLarge.objects.has('organizations/org_a/audio/track-0520.mp3'), false);
  assert.equal(storageLarge.objects.has('organizations/org_a/audio/track-1249.mp3'), false);
  for (let j = 0; j < 10; j++) {
    assert.equal(storageLarge.objects.has(`organizations/org_b/audio/orgb-${j}.mp3`), true);
  }

  // Also verify single multi-page run reconciles >500 newly added orphans across multiple pages in one call
  for (let k = 0; k < 650; k++) {
    storageLarge.seedObject(`organizations/org_a/audio/bulk-${String(k).padStart(4, '0')}.mp3`, {
      organizationId: 'org_a',
      uploadedAt: oldIso,
    });
  }
  const fullMultiPage = await envLarge.retentionService.cleanupExpiredAudio({
    now: runNow,
    includeOrphans: true,
    orphanGraceMinutes: 60,
    orphanPageSize: 300,
    orphanMaxPagesPerRun: 10,
    organizationId: 'org_a',
  });
  assert.equal(fullMultiPage.orphanPagesScanned, 4); // 520 active + 650 bulk + 1 mismatch = 1,171 objects across 4 pages of 300!
  assert.equal(fullMultiPage.orphansDeleted, 650);
  assert.equal(fullMultiPage.orphanHasMore, false);
  assert.equal(storageLarge.objects.has(mismatchInLarge), true);
  assert.equal(storageLarge.objects.has('organizations/org_b/audio/orgb-0.mp3'), true);

  // 9d. Cross-org metadata conflict blocks DELETE /api/songs/:songId too
  const crossMetaPath = 'organizations/org_a/audio/song-meta-conflict.mp3';
  storageLarge.seedObject(crossMetaPath, {
    organizationId: 'org_b',
    uploadedAt: oldIso,
  });
  await envLarge.dbController.adapter.setDoc('songs', 'song_meta_conflict', {
    id: 'song_meta_conflict',
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    assignedUserIds: ['uid_prom_a'],
    title: 'Metadata Conflict Song',
    audioStoragePath: crossMetaPath,
    audioStorageCleanupStatus: 'active',
  });
  await withLiveServer(envLarge.app, async (baseUrl) => {
    const blockedDel = await fetch(`${baseUrl}/api/songs/song_meta_conflict`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token-promoter-a' },
    });
    assert.equal(blockedDel.status, 403);
    assert.equal(storageLarge.objects.has(crossMetaPath), true);
    assert.ok(envLarge.dbController.docs.songs.song_meta_conflict);
  });
});

test('10. Storage Safety & Cursor Integrity: metadata lookup errors, missing-object handling, unverified-org block, and mandatory cursor persistence', async () => {
  const oldIso = '2026-01-01T00:00:00.000Z';
  const runNow = new Date('2026-05-01T12:00:00.000Z');

  // 10a. DELETE /api/songs/:songId fail-closed on metadata timeout/permission error, unverified org metadata, conflict, and safe 404 missing object
  const storageApi = createInMemoryAudioStorage();
  const errPath = 'organizations/org_a/audio/meta-err-song.mp3';
  const unverifiedPath = 'organizations/org_a/audio/meta-missing-org.mp3';
  const conflictPath = 'organizations/org_a/audio/meta-conflict-org.mp3';
  const alreadyGonePath = 'organizations/org_a/audio/already-missing.mp3';

  storageApi.seedObject(errPath, { organizationId: 'org_a', uploadedAt: oldIso });
  storageApi.seedObject(unverifiedPath, { organizationId: '', uploadedAt: oldIso });
  storageApi.seedObject(conflictPath, { organizationId: 'org_b', uploadedAt: oldIso });
  // alreadyGonePath intentionally NOT seeded in Storage -> confirmed missing object!

  storageApi.failMetadataFor(errPath, new Error('ETIMEDOUT: storage metadata lookup timed out'));

  const envApi = buildTestEnvironment({ audioStorage: storageApi });
  await envApi.dbController.adapter.setDoc('songs', 'song_meta_err', {
    id: 'song_meta_err',
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    assignedUserIds: ['uid_prom_a'],
    title: 'Metadata Error Song',
    audioStoragePath: errPath,
    audioStorageCleanupStatus: 'active',
  });
  await envApi.dbController.adapter.setDoc('songs', 'song_unverified_org', {
    id: 'song_unverified_org',
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    assignedUserIds: ['uid_prom_a'],
    title: 'Unverified Org Song',
    audioStoragePath: unverifiedPath,
    audioStorageCleanupStatus: 'active',
  });
  await envApi.dbController.adapter.setDoc('songs', 'song_conflict_org', {
    id: 'song_conflict_org',
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    assignedUserIds: ['uid_prom_a'],
    title: 'Conflict Org Song',
    audioStoragePath: conflictPath,
    audioStorageCleanupStatus: 'active',
  });
  await envApi.dbController.adapter.setDoc('songs', 'song_already_missing', {
    id: 'song_already_missing',
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    assignedUserIds: ['uid_prom_a'],
    title: 'Already Missing Object Song',
    audioStoragePath: alreadyGonePath,
    audioStorageCleanupStatus: 'active',
  });

  await withLiveServer(envApi.app, async (baseUrl) => {
    // Metadata timeout MUST block deletion, preserve song + Storage, and enqueue durable retry!
    const errRes = await fetch(`${baseUrl}/api/songs/song_meta_err`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token-promoter-a' },
    });
    assert.equal(errRes.status, 502);
    const errBody = (await errRes.json()) as {
      ok: boolean;
      deleted: boolean;
      cleanupPending: boolean;
      cleanupQueued: boolean;
      storageDeleted: boolean;
    };
    assert.equal(errBody.ok, false);
    assert.equal(errBody.deleted, false);
    assert.equal(errBody.cleanupPending, true);
    assert.equal(errBody.cleanupQueued, true);
    assert.equal(errBody.storageDeleted, false);
    assert.equal(storageApi.objects.has(errPath), true);
    assert.ok(envApi.dbController.docs.songs.song_meta_err);
    assert.equal(envApi.dbController.docs.songs.song_meta_err.audioStorageCleanupStatus, 'cleanup_failed');
    assert.equal(Object.keys(envApi.dbController.docs.audio_cleanup_queue || {}).length, 1);

    // Phase 2 retry while metadata error persists STILL blocks deletion and increments retryCount
    const phase2Err = await envApi.retentionService.cleanupExpiredAudio({ includeOrphans: false });
    assert.equal(phase2Err.queueFailed, 1);
    assert.equal(storageApi.objects.has(errPath), true);
    assert.ok(envApi.dbController.docs.songs.song_meta_err);
    const qAfterErr = Object.values(envApi.dbController.docs.audio_cleanup_queue || {});
    assert.equal(qAfterErr.length, 1);
    assert.equal(qAfterErr[0].retryCount, 1);
    assert.equal(qAfterErr[0].storageDeleted, false);

    // Metadata lookup recovers -> Phase 2 retry deletes Storage + song doc + queue item cleanly!
    storageApi.failMetadataFor(errPath, null);
    const phase2Recovered = await envApi.retentionService.cleanupExpiredAudio({ includeOrphans: false });
    assert.equal(phase2Recovered.queueDeleted, 1);
    assert.equal(storageApi.objects.has(errPath), false);
    assert.equal(envApi.dbController.docs.songs.song_meta_err, undefined);
    assert.equal(Object.keys(envApi.dbController.docs.audio_cleanup_queue || {}).length, 0);

    // Missing organizationId metadata -> blocked 403 (never delete unverified ownership)
    const unverifiedRes = await fetch(`${baseUrl}/api/songs/song_unverified_org`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token-promoter-a' },
    });
    assert.equal(unverifiedRes.status, 403);
    assert.equal(storageApi.objects.has(unverifiedPath), true);
    assert.ok(envApi.dbController.docs.songs.song_unverified_org);

    // Cross-org conflict -> blocked 403
    const conflictRes = await fetch(`${baseUrl}/api/songs/song_conflict_org`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token-promoter-a' },
    });
    assert.equal(conflictRes.status, 403);
    assert.equal(storageApi.objects.has(conflictPath), true);
    assert.ok(envApi.dbController.docs.songs.song_conflict_org);

    // Confirmed missing Storage object -> safely completes 200 without endless retries!
    const missingRes = await fetch(`${baseUrl}/api/songs/song_already_missing`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token-promoter-a' },
    });
    assert.equal(missingRes.status, 200);
    assert.equal(envApi.dbController.docs.songs.song_already_missing, undefined);
    assert.equal(Object.keys(envApi.dbController.docs.audio_cleanup_queue || {}).length, 0);
  });

  // 10b. Phase 1 retention cleanup & Phase 3 orphan reconciliation fail-closed on metadata error, unverified org, and confirmed 404
  const storagePhases = createInMemoryAudioStorage();
  const p1ErrPath = 'organizations/org_a/audio/p1-err.mp3';
  const p1GonePath = 'organizations/org_a/audio/p1-gone.mp3';
  const p3ErrPath = 'organizations/org_a/audio/p3-err.mp3';
  const p3UnverifiedPath = 'organizations/org_a/audio/p3-unverified.mp3';
  const p3ConflictPath = 'organizations/org_a/audio/p3-conflict.mp3';

  storagePhases.seedObject(p1ErrPath, { organizationId: 'org_a', uploadedAt: oldIso });
  storagePhases.seedObject(p3ErrPath, { organizationId: 'org_a', uploadedAt: oldIso });
  storagePhases.seedObject(p3UnverifiedPath, { organizationId: '', uploadedAt: oldIso });
  storagePhases.seedObject(p3ConflictPath, { organizationId: 'org_b', uploadedAt: oldIso });

  storagePhases.failMetadataFor(p1ErrPath, new Error('PERMISSION_DENIED: metadata access denied'));
  storagePhases.failMetadataFor(p3ErrPath, new Error('ECONNRESET: network failure'));

  const envPhases = buildTestEnvironment({ audioStorage: storagePhases });
  await envPhases.dbController.adapter.setDoc('songs', 'song_p1_err', {
    id: 'song_p1_err',
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    assignedUserIds: ['uid_prom_a'],
    title: 'Phase 1 Metadata Error',
    audioStoragePath: p1ErrPath,
    audioRetentionExpiresAt: '2026-01-01T00:00:00.000Z',
    audioStorageCleanupStatus: 'active',
  });
  await envPhases.dbController.adapter.setDoc('songs', 'song_p1_gone', {
    id: 'song_p1_gone',
    organizationId: 'org_a',
    ownerId: 'uid_prom_a',
    assignedUserIds: ['uid_prom_a'],
    title: 'Phase 1 Confirmed Missing',
    audioStoragePath: p1GonePath,
    audioRetentionExpiresAt: '2026-01-01T00:00:00.000Z',
    audioStorageCleanupStatus: 'active',
  });

  // Also seed a confirmed-missing Storage item in Phase 2 queue -> should complete cleanly without endless retries!
  await envPhases.retentionService.enqueueCleanupTask({
    storageObjectPath: 'organizations/org_a/audio/p2-gone.mp3',
    organizationId: 'org_a',
    deleteSongOnCleanup: false,
    reason: 'gemini_analysis_failed',
  });

  const phaseRun1 = await envPhases.retentionService.cleanupExpiredAudio({
    now: runNow,
    includeOrphans: true,
    orphanGraceMinutes: 60,
    organizationId: 'org_a',
  });
  // p1ErrPath failed metadata lookup (preserved!), p1GonePath completed as already missing,
  // p2-gone completed as already missing, p3ErrPath failed metadata lookup (preserved!),
  // p3UnverifiedPath & p3ConflictPath skipped (never deleted!)
  assert.equal(storagePhases.objects.has(p1ErrPath), true);
  assert.equal(storagePhases.objects.has(p3ErrPath), true);
  assert.equal(storagePhases.objects.has(p3UnverifiedPath), true);
  assert.equal(storagePhases.objects.has(p3ConflictPath), true);
  assert.equal(envPhases.dbController.docs.songs.song_p1_gone.audioStorageCleanupStatus, 'deleted');
  assert.equal(envPhases.dbController.docs.songs.song_p1_err.audioStorageCleanupStatus, 'cleanup_failed');
  assert.equal(phaseRun1.failed, 2); // p1ErrPath + p3ErrPath
  assert.equal(phaseRun1.orphansDeleted, 0);

  // Recover metadata lookups -> p1ErrPath and p3ErrPath complete cleanly on retry, while unverified & conflict remain untouched!
  storagePhases.failMetadataFor(p1ErrPath, null);
  storagePhases.failMetadataFor(p3ErrPath, null);
  const phaseRun2 = await envPhases.retentionService.cleanupExpiredAudio({
    now: runNow,
    includeOrphans: true,
    orphanGraceMinutes: 60,
    organizationId: 'org_a',
  });
  assert.equal(phaseRun2.failed, 0);
  assert.equal(storagePhases.objects.has(p1ErrPath), false);
  assert.equal(storagePhases.objects.has(p3ErrPath), false);
  assert.equal(envPhases.dbController.docs.songs.song_p1_err.audioStorageCleanupStatus, 'deleted');
  assert.equal(Object.keys(envPhases.dbController.docs.audio_cleanup_queue || {}).length, 0);
  assert.equal(storagePhases.objects.has(p3UnverifiedPath), true);
  assert.equal(storagePhases.objects.has(p3ConflictPath), true);

  // 10c. Mandatory cursor persistence: Firestore cursor write failures during BOTH progress updates and cycle completion
  const storageCursor = createInMemoryAudioStorage();
  const envCursor = buildTestEnvironment({ audioStorage: storageCursor });
  // Seed 6 objects in org_a: first 2 on each 2-item page are active songs (never deleted!), 0..5 mixed
  for (let i = 0; i < 6; i++) {
    const p = `organizations/org_a/audio/cur-${String(i).padStart(2, '0')}.mp3`;
    storageCursor.seedObject(p, { organizationId: 'org_a', uploadedAt: oldIso });
    if (i % 2 === 0) {
      await envCursor.dbController.adapter.setDoc('songs', `song_cur_${i}`, {
        id: `song_cur_${i}`,
        organizationId: 'org_a',
        ownerId: 'uid_prom_a',
        assignedUserIds: ['uid_prom_a'],
        title: `Active Cursor Song ${i}`,
        audioStoragePath: p,
        audioStorageCleanupStatus: 'active',
        audioRetentionExpiresAt: '2027-01-01T00:00:00.000Z',
      });
    }
  }

  const cursorDocId = `orphan_cursor_org_${crypto.createHash('sha256').update('org_a').digest('hex').slice(0, 24)}`;

  // Run 1 succeeds on Page 1 (items 0,1) -> cursor points after cur-01
  const curRun1 = await envCursor.retentionService.cleanupExpiredAudio({
    now: runNow,
    includeOrphans: true,
    orphanGraceMinutes: 60,
    orphanPageSize: 2,
    orphanMaxPagesPerRun: 1,
    organizationId: 'org_a',
  });
  assert.equal(curRun1.orphanHasMore, true);
  assert.equal(curRun1.orphansDeleted, 1); // cur-01 deleted, cur-00 active kept
  const savedTokenAfterRun1 = String(
    envCursor.dbController.docs.audio_cleanup_cursors[cursorDocId].nextPageToken
  );
  assert.ok(savedTokenAfterRun1.length > 0);

  // Run 2 (progress update) FAILS on writing audio_cleanup_cursors -> endpoint MUST return 500 & preserve Run 1's valid cursor!
  envCursor.dbController.failSetCounts.set(`audio_cleanup_cursors/${cursorDocId}`, 1);
  await withLiveServer(envCursor.app, async (baseUrl) => {
    const failProgressRes = await fetch(`${baseUrl}/api/admin/audio/cleanup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-admin',
      },
      body: JSON.stringify({
        includeOrphans: true,
        orphanGraceMinutes: 60,
        orphanPageSize: 2,
        orphanMaxPagesPerRun: 1,
        organizationId: 'org_a',
      }),
    });
    assert.equal(failProgressRes.status, 500);
    const failProgressBody = (await failProgressRes.json()) as { error: string };
    assert.match(failProgressBody.error, /CURSOR_PERSIST_FAILED/);
  });

  // Previous valid cursor from Run 1 MUST still be preserved!
  assert.equal(
    envCursor.dbController.docs.audio_cleanup_cursors[cursorDocId].nextPageToken,
    savedTokenAfterRun1
  );

  // Retry Run 2 -> resumes safely from savedTokenAfterRun1, skips active cur-02, persists token after cur-03!
  const curRun2Retry = await envCursor.retentionService.cleanupExpiredAudio({
    now: runNow,
    includeOrphans: true,
    orphanGraceMinutes: 60,
    orphanPageSize: 2,
    orphanMaxPagesPerRun: 1,
    organizationId: 'org_a',
  });
  assert.equal(curRun2Retry.orphanHasMore, true);
  assert.equal(storageCursor.objects.has('organizations/org_a/audio/cur-02.mp3'), true);
  assert.equal(storageCursor.objects.has('organizations/org_a/audio/cur-03.mp3'), false);
  const savedTokenAfterRun2 = String(
    envCursor.dbController.docs.audio_cleanup_cursors[cursorDocId].nextPageToken
  );
  assert.notEqual(savedTokenAfterRun2, savedTokenAfterRun1);

  // Run 3 (cycle completion) FAILS on writing completion cursor -> MUST reject & MUST NOT reset cursor!
  envCursor.dbController.failSetCounts.set(`audio_cleanup_cursors/${cursorDocId}`, 1);
  await assert.rejects(
    () =>
      envCursor.retentionService.cleanupExpiredAudio({
        now: runNow,
        includeOrphans: true,
        orphanGraceMinutes: 60,
        orphanPageSize: 2,
        orphanMaxPagesPerRun: 1,
        organizationId: 'org_a',
      }),
    /CURSOR_COMPLETION_PERSIST_FAILED/
  );
  // Previous valid cursor MUST NOT have been reset!
  assert.equal(
    envCursor.dbController.docs.audio_cleanup_cursors[cursorDocId].nextPageToken,
    savedTokenAfterRun2
  );

  // Retry Run 3 -> resumes safely from savedTokenAfterRun2, preserves active cur-04, persists completion & ONLY THEN resets cursor!
  const curRun3Retry = await envCursor.retentionService.cleanupExpiredAudio({
    now: runNow,
    includeOrphans: true,
    orphanGraceMinutes: 60,
    orphanPageSize: 2,
    orphanMaxPagesPerRun: 1,
    organizationId: 'org_a',
  });
  assert.equal(curRun3Retry.orphanHasMore, false);
  assert.equal(envCursor.dbController.docs.audio_cleanup_cursors[cursorDocId].nextPageToken, '');
  assert.ok(envCursor.dbController.docs.audio_cleanup_cursors[cursorDocId].cycleCompletedAt);
  assert.equal(storageCursor.objects.has('organizations/org_a/audio/cur-00.mp3'), true);
  assert.equal(storageCursor.objects.has('organizations/org_a/audio/cur-02.mp3'), true);
  assert.equal(storageCursor.objects.has('organizations/org_a/audio/cur-04.mp3'), true);
  assert.equal(storageCursor.objects.has('organizations/org_a/audio/cur-05.mp3'), false);

  // 10d. Repeated pageToken protection prevents infinite pagination loops
  const loopStorage = createInMemoryAudioStorage();
  loopStorage.seedObject('organizations/org_a/audio/loop-1.mp3', {
    organizationId: 'org_a',
    uploadedAt: oldIso,
  });
  let pageCalls = 0;
  loopStorage.adapter.listAudioObjectsPage = async () => {
    pageCalls += 1;
    return {
      objects: [
        {
          path: 'organizations/org_a/audio/loop-1.mp3',
          organizationId: 'org_a',
          uploadedAt: oldIso,
        },
      ],
      nextPageToken: 'REPEATED_TOKEN_FOREVER',
    };
  };
  const envLoop = buildTestEnvironment({ audioStorage: loopStorage });
  const loopRes = await envLoop.retentionService.cleanupExpiredAudio({
    now: runNow,
    includeOrphans: true,
    orphanGraceMinutes: 60,
    orphanMaxPagesPerRun: 10,
    organizationId: 'org_a',
  });
  assert.equal(pageCalls, 2); // Stopped immediately once REPEATED_TOKEN_FOREVER repeated!
  assert.equal(loopRes.orphanHasMore, false);
});



