import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';
import type { GoogleGenAI } from '@google/genai';
import { createSonicPushApp } from '../server/app.ts';
import type { ServerAuthSession, VerifiedFirebaseIdentity } from '../server/auth.ts';
import { PaymentLedgerStore, verifyPaystackWebhookSignature } from '../server/payments.ts';
import { SlidingWindowQuotaLimiter } from '../server/rateLimit.ts';
import { detectAudioMagicSignature, validateAudioUpload } from '../server/audioSecurity.ts';

interface TestTokenIdentity {
  identity: VerifiedFirebaseIdentity;
  session: ServerAuthSession;
}

const USERS: Record<string, TestTokenIdentity> = {
  'token-admin': {
    identity: {
      uid: 'uid_admin',
      email: 'emma432cent@gmail.com',
      emailVerified: true,
      customClaims: {},
    },
    session: {
      uid: 'uid_admin',
      email: 'emma432cent@gmail.com',
      emailVerified: true,
      idToken: 'token-admin',
      role: 'SUPER_ADMIN',
      isSuperAdmin: true,
      isBootstrapAdmin: true,
      onboardingCompleted: true,
      organizationId: 'org_agency',
      capabilities: {
        canManageUsers: true,
        canManagePackages: true,
        canManageClients: true,
        canReconcilePayments: true,
        canAccessAdminConsole: true,
      },
    },
  },
  'token-promoter-a': {
    identity: {
      uid: 'uid_prom_a',
      email: 'promoter-a@example.com',
      emailVerified: true,
      customClaims: {},
    },
    session: {
      uid: 'uid_prom_a',
      email: 'promoter-a@example.com',
      emailVerified: true,
      idToken: 'token-promoter-a',
      role: 'PROMOTER',
      isSuperAdmin: false,
      isBootstrapAdmin: false,
      onboardingCompleted: true,
      organizationId: 'org_a',
      capabilities: {
        canManageUsers: false,
        canManagePackages: false,
        canManageClients: true,
        canReconcilePayments: false,
        canAccessAdminConsole: false,
      },
    },
  },
  'token-artist-b': {
    identity: {
      uid: 'uid_art_b',
      email: 'artist-b@example.com',
      emailVerified: true,
      customClaims: {},
    },
    session: {
      uid: 'uid_art_b',
      email: 'artist-b@example.com',
      emailVerified: true,
      idToken: 'token-artist-b',
      role: 'ARTIST',
      isSuperAdmin: false,
      isBootstrapAdmin: false,
      onboardingCompleted: true,
      organizationId: 'org_b',
      capabilities: {
        canManageUsers: false,
        canManagePackages: false,
        canManageClients: false,
        canReconcilePayments: false,
        canAccessAdminConsole: false,
      },
    },
  },
  'token-unverified': {
    identity: {
      uid: 'uid_unverified',
      email: 'unverified@example.com',
      emailVerified: false,
      customClaims: {},
    },
    session: {
      uid: 'uid_unverified',
      email: 'unverified@example.com',
      emailVerified: false,
      idToken: 'token-unverified',
      role: 'ARTIST',
      isSuperAdmin: false,
      isBootstrapAdmin: false,
      onboardingCompleted: false,
      organizationId: 'org_unv',
      capabilities: {
        canManageUsers: false,
        canManagePackages: false,
        canManageClients: false,
        canReconcilePayments: false,
        canAccessAdminConsole: false,
      },
    },
  },
};

function createTestServer(overrides?: {
  rateLimiter?: SlidingWindowQuotaLimiter;
  paymentLedger?: PaymentLedgerStore;
  fetchImpl?: typeof fetch;
  onGeminiPrompt?: (text: string) => void;
}) {
  const docs: Record<string, Record<string, Record<string, unknown>>> = {
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
      uid_art_b: {
        uid: 'uid_art_b',
        email: 'artist-b@example.com',
        role: 'ARTIST',
        organizationId: 'org_b',
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
  };

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
    tokenVerifier: async (token) => {
      const found = USERS[token];
      if (!found) throw new Error('INVALID_TOKEN');
      return found.identity;
    },
    sessionResolver: async (_id, token) => USERS[token].session,
    rateLimiter: overrides?.rateLimiter ?? new SlidingWindowQuotaLimiter({ shortLimit: 20, dailyLimit: 200 }),
    paymentLedger: overrides?.paymentLedger ?? new PaymentLedgerStore(':memory:'),
    fetchImpl: overrides?.fetchImpl as never,
    getDoc: async (col, id) => docs[col]?.[id] ?? null,
    runQuery: async () => [],
    patchDoc: async (col, id, patch) => {
      docs[col] = docs[col] || {};
      docs[col][id] = { ...(docs[col][id] || {}), ...patch };
    },
    fetchWorkspaceContext: async ({ organizationId }) => ({
      organizationId,
      artists: [{ id: 'art_real_1', name: 'REAL_SERVER_ARTIST' }],
      songs: [{ id: 'song_real_1', title: 'REAL_SERVER_SONG' }],
      campaigns: [],
      recentMetrics: [],
      openTasks: [],
    }),
    getGeminiClient: () => fakeGeminiClient,
  });

  return { app, docs };
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

test('1. Auth enforcement: rejects missing, invalid, and unverified tokens; accepts valid token', async () => {
  const { app } = createTestServer();
  await withLiveServer(app, async (baseUrl) => {
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

test('2. Role authorization: blocks self-escalation & non-admin role writes; protects bootstrap owner', async () => {
  const { app, docs } = createTestServer();
  await withLiveServer(app, async (baseUrl) => {
    // Non-admin attempting SUPER_ADMIN during onboarding
    const escalate = await fetch(`${baseUrl}/api/auth/onboarding-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-artist-b',
      },
      body: JSON.stringify({ role: 'SUPER_ADMIN' }),
    });
    assert.equal(escalate.status, 403);

    // Non-admin attempting admin role update endpoint
    const nonAdminUpdate = await fetch(`${baseUrl}/api/admin/users/uid_art_b/role`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-promoter-a',
      },
      body: JSON.stringify({ role: 'SUPER_ADMIN' }),
    });
    assert.equal(nonAdminUpdate.status, 403);

    // Super Admin cannot demote bootstrap owner
    const demoteOwner = await fetch(`${baseUrl}/api/admin/users/uid_admin/role`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-admin',
      },
      body: JSON.stringify({ role: 'PROMOTER' }),
    });
    assert.equal(demoteOwner.status, 403);

    // Super Admin can update regular user role
    const okUpdate = await fetch(`${baseUrl}/api/admin/users/uid_art_b/role`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-admin',
      },
      body: JSON.stringify({ role: 'PROMOTER' }),
    });
    assert.equal(okUpdate.status, 200);
    assert.equal(docs.users.uid_art_b.role, 'PROMOTER');
  });
});

test('3. Payment verification: fail-closed without keys, verifies Paystack/Flutterwave minor units, blocks mismatch & reuse', async () => {
  const prevPaystack = process.env.PAYSTACK_SECRET_KEY;
  const prevFlw = process.env.FLUTTERWAVE_SECRET_KEY;
  delete process.env.PAYSTACK_SECRET_KEY;
  delete process.env.FLUTTERWAVE_SECRET_KEY;

  try {
    // 3a. Fail-closed when no provider key configured
    const { app: noKeyApp } = createTestServer();
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

    // 3b. With Paystack & Flutterwave test secrets + mocked official gateway HTTP verification responses
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_paystack_dummy';
    process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST_dummy';

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
              amount: 5000000, // 50,000 NGN * 100 kobo
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
              amount: 10000, // Mismatch!
              currency: 'NGN',
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
              amount: 250, // 250 USD major units from Flutterwave -> 25000 cents
              currency: 'USD',
              meta: { invoiceId: 'inv_org_b_1' },
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const { app } = createTestServer({ fetchImpl: mockedGatewayFetch as unknown as typeof fetch });
    await withLiveServer(app, async (baseUrl) => {
      // Cross-org invoice access rejected
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

      // Valid Paystack minor-unit verification succeeds
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
      assert.ok(okPaystackBody.serverAttestation.length === 64);

      // Reference reuse across a different invoice blocked with 409
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

      // Valid Flutterwave USD verification for org_b succeeds
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
    });
  } finally {
    if (prevPaystack === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = prevPaystack;
    if (prevFlw === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
    else process.env.FLUTTERWAVE_SECRET_KEY = prevFlw;
  }
});

test('4 & 5. Webhook signature validation (Paystack, Flutterwave, Stripe) & idempotency + refund/dispute states', async () => {
  const prevPaystack = process.env.PAYSTACK_SECRET_KEY;
  const prevFlwHash = process.env.FLUTTERWAVE_SECRET_HASH;
  const prevStripeWebhook = process.env.STRIPE_WEBHOOK_SECRET;

  process.env.PAYSTACK_SECRET_KEY = 'wh_paystack_secret';
  process.env.FLUTTERWAVE_SECRET_HASH = 'wh_flw_hash_secret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_stripe_secret';

  try {
    const ledger = new PaymentLedgerStore(':memory:');
    ledger.upsertReferenceBinding({
      bindingKey: 'paystack:PSK_EVT_1',
      provider: 'paystack',
      reference: 'PSK_EVT_1',
      invoiceId: 'inv_org_a_1',
      organizationId: 'org_a',
      currency: 'NGN',
      expectedMinor: 5000000,
      verificationStatus: 'pending',
      updatedAt: new Date().toISOString(),
    });

    const { app } = createTestServer({ paymentLedger: ledger });
    await withLiveServer(app, async (baseUrl) => {
      // Paystack: invalid signature rejected
      const paystackPayload = JSON.stringify({
        event: 'charge.success',
        data: { id: 551, status: 'success', reference: 'PSK_EVT_1', amount: 5000000, currency: 'NGN' },
      });
      const badPaystackSig = await fetch(`${baseUrl}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-paystack-signature': 'deadbeef',
        },
        body: paystackPayload,
      });
      assert.equal(badPaystackSig.status, 401);

      // Paystack: valid raw-body HMAC-SHA512 signature succeeds
      const goodSig = crypto
        .createHmac('sha512', 'wh_paystack_secret')
        .update(Buffer.from(paystackPayload, 'utf8'))
        .digest('hex');
      assert.equal(
        verifyPaystackWebhookSignature(Buffer.from(paystackPayload, 'utf8'), goodSig, 'wh_paystack_secret'),
        true
      );

      const firstDelivery = await fetch(`${baseUrl}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-paystack-signature': goodSig,
        },
        body: paystackPayload,
      });
      assert.equal(firstDelivery.status, 200);
      const firstBody = (await firstDelivery.json()) as { duplicate: boolean; outcome: string };
      assert.equal(firstBody.duplicate, false);
      assert.equal(firstBody.outcome, 'verified');

      // Duplicate Paystack webhook delivery is idempotent
      const dupDelivery = await fetch(`${baseUrl}/api/payments/webhook/paystack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-paystack-signature': goodSig,
        },
        body: paystackPayload,
      });
      assert.equal(dupDelivery.status, 200);
      const dupBody = (await dupDelivery.json()) as { duplicate: boolean; outcome: string };
      assert.equal(dupBody.duplicate, true);
      assert.equal(dupBody.outcome, 'verified');

      // Flutterwave: bad verif-hash rejected, valid accepted
      const flwPayload = JSON.stringify({
        event: 'charge.completed',
        data: { id: 882, tx_ref: 'FLW_EVT_1', status: 'failed', amount: 100, currency: 'USD' },
      });
      const flwBad = await fetch(`${baseUrl}/api/payments/webhook/flutterwave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'verif-hash': 'wrong' },
        body: flwPayload,
      });
      assert.equal(flwBad.status, 401);

      const flwOk = await fetch(`${baseUrl}/api/payments/webhook/flutterwave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'verif-hash': 'wh_flw_hash_secret' },
        body: flwPayload,
      });
      assert.equal(flwOk.status, 200);
      const flwBody = (await flwOk.json()) as { outcome: string };
      assert.equal(flwBody.outcome, 'failed');

      // Stripe: official raw-body constructEvent signature verification + charge.refunded handling
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

      const stripeBad = await fetch(`${baseUrl}/api/payments/webhook/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=bad' },
        body: stripePayload,
      });
      assert.equal(stripeBad.status, 401);

      const stripeOk = await fetch(`${baseUrl}/api/payments/webhook/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': stripeSig },
        body: stripePayload,
      });
      assert.equal(stripeOk.status, 200);
      const stripeBody = (await stripeOk.json()) as { outcome: string; duplicate: boolean };
      assert.equal(stripeBody.outcome, 'refunded');
      assert.equal(stripeBody.duplicate, false);
    });
  } finally {
    if (prevPaystack === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = prevPaystack;
    if (prevFlwHash === undefined) delete process.env.FLUTTERWAVE_SECRET_HASH;
    else process.env.FLUTTERWAVE_SECRET_HASH = prevFlwHash;
    if (prevStripeWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = prevStripeWebhook;
  }
});

test('6. AI security: requires auth, rejects cross-org query, ignores browser context, enforces rate limit', async () => {
  let capturedPrompt = '';
  const tightLimiter = new SlidingWindowQuotaLimiter({ shortLimit: 2, dailyLimit: 10 });
  const { app } = createTestServer({
    rateLimiter: tightLimiter,
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

    // Cross-org query blocked before quota exhaustion check succeeds
    const crossOrg = await fetch(`${baseUrl}/api/ai/assistant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-promoter-a',
      },
      body: JSON.stringify({
        organizationId: 'org_b',
        messages: [{ role: 'user', content: 'Show org_b secrets' }],
      }),
    });
    assert.equal(crossOrg.status, 403);

    // Spoofed browser workspaceContext is ignored in favor of server-fetched Firestore context
    const legitimate = await fetch(`${baseUrl}/api/ai/assistant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-promoter-a',
      },
      body: JSON.stringify({
        organizationId: 'org_a',
        messages: [{ role: 'user', content: 'Summarize my roster' }],
        workspaceContext: {
          artists: [{ name: 'SPOOFED_CLIENT_ARTIST' }],
        },
      }),
    });
    assert.equal(legitimate.status, 200);
    assert.ok(capturedPrompt.includes('REAL_SERVER_ARTIST'));
    assert.equal(capturedPrompt.includes('SPOOFED_CLIENT_ARTIST'), false);

    // Exceed per-minute quota (limit was 2; 2nd call was crossOrg or legitimate -> test 3rd call triggers 429)
    const rateLimited = await fetch(`${baseUrl}/api/ai/assistant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-promoter-a',
      },
      body: JSON.stringify({
        organizationId: 'org_a',
        messages: [{ role: 'user', content: 'Another query' }],
      }),
    });
    assert.equal(rateLimited.status, 429);
  });
});

test('7. Audio upload security: validates magic bytes, rejects spoofed non-audio payloads, enforces auth before upload', async () => {
  // Valid ID3 MP3 signature
  const mp3Header = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.alloc(16)]);
  assert.equal(detectAudioMagicSignature(mp3Header), 'mp3');
  assert.equal(validateAudioUpload(mp3Header, 'audio/mpeg', 'track.mp3').valid, true);

  // Valid WAV RIFF/WAVE signature
  const wavHeader = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'ascii');
  assert.equal(detectAudioMagicSignature(wavHeader), 'wav');
  assert.equal(validateAudioUpload(wavHeader, 'audio/wav', 'master.wav').valid, true);

  // Spoofed HTML script masquerading as audio/mpeg .mp3
  const htmlSpoof = Buffer.from('<!DOCTYPE html><script>alert(1)</script>', 'utf8');
  assert.equal(detectAudioMagicSignature(htmlSpoof), null);
  assert.equal(validateAudioUpload(htmlSpoof, 'audio/mpeg', 'evil.mp3').valid, false);

  // Mismatched extension (.wav file renamed to .mp3)
  assert.equal(validateAudioUpload(wavHeader, 'audio/mpeg', 'mismatch.mp3').valid, false);

  const { app } = createTestServer();
  await withLiveServer(app, async (baseUrl) => {
    const form = new FormData();
    form.append('title', 'Midnight Drive');
    form.append('audio', new Blob([htmlSpoof], { type: 'audio/mpeg' }), 'spoof.mp3');

    // Unauthenticated upload rejected 401 before multer/AI processing
    const unauthUpload = await fetch(`${baseUrl}/api/ai/song-intelligence`, {
      method: 'POST',
      body: form,
    });
    assert.equal(unauthUpload.status, 401);

    // Authenticated spoofed audio rejected 400
    const badAudioRes = await fetch(`${baseUrl}/api/ai/song-intelligence`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-promoter-a' },
      body: form,
    });
    assert.equal(badAudioRes.status, 400);

    // Authenticated valid MP3 accepted with UUID storage path & retention timestamp
    const validForm = new FormData();
    validForm.append('title', 'Lagos Dawn');
    validForm.append('organizationId', 'org_a');
    validForm.append('audio', new Blob([mp3Header], { type: 'audio/mpeg' }), 'lagos_dawn.mp3');

    const okRes = await fetch(`${baseUrl}/api/ai/song-intelligence`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-promoter-a' },
      body: validForm,
    });
    assert.equal(okRes.status, 200);
    const okData = (await okRes.json()) as {
      audioProcessed: boolean;
      audioStoragePath: string;
      audioRetentionExpiresAt: string;
    };
    assert.equal(okData.audioProcessed, true);
    assert.match(okData.audioStoragePath, /^organizations\/org_a\/audio\/[a-f0-9-]+\.mp3$/);
    assert.ok(Date.parse(okData.audioRetentionExpiresAt) > Date.now());
  });
});
