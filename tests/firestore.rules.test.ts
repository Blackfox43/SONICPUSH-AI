import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';

const PROJECT_ID = 'sonicpush-rules-test';
const RULES_PATH = path.resolve(process.cwd(), 'firestore.rules');

let testEnv: RulesTestEnvironment | undefined;

async function setupEnv(): Promise<RulesTestEnvironment> {
  if (testEnv) return testEnv;
  const rules = fs.readFileSync(RULES_PATH, 'utf8');
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: '127.0.0.1',
      port: 8080,
    },
  });
  return testEnv;
}

async function seedBaselineFixtures(env: RulesTestEnvironment): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = serverTimestamp();

    await setDoc(doc(db, 'organizations', 'org_alpha'), {
      id: 'org_alpha',
      ownerId: 'promoter_a',
      name: 'Alpha Agency',
      type: 'AGENCY',
      country: 'Nigeria',
      defaultCurrency: 'NGN',
      assignedUserIds: ['promoter_a', 'artist_a'],
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'organizations', 'org_beta'), {
      id: 'org_beta',
      ownerId: 'artist_b',
      name: 'Beta Music',
      type: 'INDEPENDENT_ARTIST',
      country: 'Ghana',
      defaultCurrency: 'USD',
      assignedUserIds: ['artist_b'],
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'users', 'promoter_a'), {
      uid: 'promoter_a',
      ownerId: 'promoter_a',
      email: 'promoter@alpha.ng',
      displayName: 'Promoter Alpha',
      role: 'PROMOTER',
      organizationId: 'org_alpha',
      preferredCurrency: 'NGN',
      onboardingCompleted: true,
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'users', 'artist_a'), {
      uid: 'artist_a',
      ownerId: 'artist_a',
      email: 'artist@alpha.ng',
      displayName: 'Artist Alpha',
      role: 'ARTIST',
      organizationId: 'org_alpha',
      preferredCurrency: 'NGN',
      onboardingCompleted: true,
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'users', 'artist_b'), {
      uid: 'artist_b',
      ownerId: 'artist_b',
      email: 'artist@beta.gh',
      displayName: 'Artist Beta',
      role: 'ARTIST',
      organizationId: 'org_beta',
      preferredCurrency: 'USD',
      onboardingCompleted: true,
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'invoices', 'inv_alpha_1'), {
      id: 'inv_alpha_1',
      organizationId: 'org_alpha',
      ownerId: 'promoter_a',
      assignedUserIds: ['promoter_a', 'artist_a'],
      clientName: 'Alpha Client',
      billingType: 'one_time_campaign',
      currency: 'NGN',
      amount: 100000,
      dueDate: '2026-12-31',
      status: 'sent',
      createdAt: now,
      updatedAt: now,
    });

    await setDoc(doc(db, 'payments', 'pay_alpha_1'), {
      id: 'pay_alpha_1',
      organizationId: 'org_alpha',
      ownerId: 'promoter_a',
      assignedUserIds: ['promoter_a'],
      invoiceId: 'inv_alpha_1',
      provider: 'paystack',
      reference: 'PSK_REF_1',
      currency: 'NGN',
      amount: 100000,
      verificationStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  });
}

test('Firestore Emulator Security Rules Suite (8 Scenarios)', async () => {
  const env = await setupEnv();
  await env.clearFirestore();
  await seedBaselineFixtures(env);

  const anonDb = env.unauthenticatedContext().firestore();
  const artistADb = env
    .authenticatedContext('artist_a', { email: 'artist@alpha.ng', email_verified: true })
    .firestore();
  const promoterADb = env
    .authenticatedContext('promoter_a', { email: 'promoter@alpha.ng', email_verified: true })
    .firestore();
  const artistBDb = env
    .authenticatedContext('artist_b', { email: 'artist@beta.gh', email_verified: true })
    .firestore();
  const adminDb = env
    .authenticatedContext('admin_uid', {
      email: 'emma432cent@gmail.com',
      email_verified: true,
      superAdmin: true,
    })
    .firestore();

  // 1. Anonymous access denied on private & user collections
  await assertFails(getDoc(doc(anonDb, 'users', 'promoter_a')));
  await assertFails(getDoc(doc(anonDb, 'invoices', 'inv_alpha_1')));

  // 2. Artist access: can read assigned org invoice, blocked from Promoter-only clients CRUD
  await assertSucceeds(getDoc(doc(artistADb, 'invoices', 'inv_alpha_1')));
  await assertFails(
    setDoc(doc(artistADb, 'clients', 'cli_bad'), {
      id: 'cli_bad',
      organizationId: 'org_alpha',
      ownerId: 'artist_a',
      assignedUserIds: ['artist_a'],
      name: 'Blocked Client',
      email: 'c@test.com',
      country: 'Nigeria',
      packageTier: 'STARTER',
      onboardingStatus: 'pending',
      paymentStatus: 'unpaid',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );

  // 3. Promoter access: allowed to create client inside own organization
  await assertSucceeds(
    setDoc(doc(promoterADb, 'clients', 'cli_ok'), {
      id: 'cli_ok',
      organizationId: 'org_alpha',
      ownerId: 'promoter_a',
      assignedUserIds: ['promoter_a'],
      name: 'Valid Client',
      email: 'client@alpha.ng',
      country: 'Nigeria',
      packageTier: 'GROWTH',
      onboardingStatus: 'pending',
      paymentStatus: 'unpaid',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );

  // 4. Organization isolation: artist_b cannot read or write inside org_alpha
  await assertFails(getDoc(doc(artistBDb, 'invoices', 'inv_alpha_1')));
  await assertFails(
    setDoc(doc(artistBDb, 'artists', 'art_cross_org'), {
      id: 'art_cross_org',
      organizationId: 'org_alpha',
      ownerId: 'artist_b',
      assignedUserIds: ['artist_b'],
      name: 'Intruder Artist',
      bio: 'Bio',
      country: 'Nigeria',
      city: 'Lagos',
      genre: 'Afrobeats',
      languages: 'English',
      targetAudience: 'Youth',
      careerStage: 'Emerging',
      marketingObjectives: 'Awareness',
      archived: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );

  // 5. Role escalation: artist_b cannot self-upgrade role to SUPER_ADMIN
  await assertFails(
    updateDoc(doc(artistBDb, 'users', 'artist_b'), {
      role: 'SUPER_ADMIN',
      updatedAt: serverTimestamp(),
    })
  );

  // 6. Payment tampering: non-admin cannot mark payment verified or forge wrong amount
  await assertFails(
    setDoc(doc(promoterADb, 'payments', 'pay_forged'), {
      id: 'pay_forged',
      organizationId: 'org_alpha',
      ownerId: 'promoter_a',
      assignedUserIds: ['promoter_a'],
      invoiceId: 'inv_alpha_1',
      provider: 'paystack',
      reference: 'PSK_FORGED',
      currency: 'NGN',
      amount: 100000,
      verificationStatus: 'verified',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );
  await assertFails(
    updateDoc(doc(promoterADb, 'payments', 'pay_alpha_1'), {
      verificationStatus: 'verified',
      updatedAt: serverTimestamp(),
    })
  );
  await assertFails(deleteDoc(doc(promoterADb, 'payments', 'pay_alpha_1')));

  // 7. Invoice tampering: non-admin cannot change amount, currency, or mark invoice paid directly
  await assertFails(
    updateDoc(doc(promoterADb, 'invoices', 'inv_alpha_1'), {
      status: 'paid',
      updatedAt: serverTimestamp(),
    })
  );
  await assertFails(
    updateDoc(doc(promoterADb, 'invoices', 'inv_alpha_1'), {
      amount: 1,
      updatedAt: serverTimestamp(),
    })
  );
  await assertFails(deleteDoc(doc(promoterADb, 'invoices', 'inv_alpha_1')));

  // 8. Authorized admin operations: Bootstrap Super Admin can reconcile verified payment & paid invoice
  await assertSucceeds(
    updateDoc(doc(adminDb, 'payments', 'pay_alpha_1'), {
      verificationStatus: 'verified',
      verificationSource: 'server_api',
      updatedAt: serverTimestamp(),
    })
  );
  await assertSucceeds(
    updateDoc(doc(adminDb, 'invoices', 'inv_alpha_1'), {
      status: 'paid',
      verifiedPaymentRef: 'PSK_REF_1',
      updatedAt: serverTimestamp(),
    })
  );

  // 9. Promoted Super Admin parity: non-bootstrap user with synced custom claims + role == SUPER_ADMIN has full admin access
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = serverTimestamp();
    await setDoc(doc(db, 'users', 'promoted_admin'), {
      uid: 'promoted_admin',
      ownerId: 'promoted_admin',
      email: 'promoted-admin@sonicpush.ng',
      displayName: 'Promoted Admin',
      role: 'SUPER_ADMIN',
      organizationId: 'org_agency',
      preferredCurrency: 'NGN',
      onboardingCompleted: true,
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'payment_webhook_events', 'paystack_evt_1'), {
      id: 'paystack_evt_1',
      idempotencyKey: 'paystack:evt_1',
      provider: 'paystack',
      eventId: 'evt_1',
      eventType: 'charge.success',
      outcome: 'verified',
      reconciliationStatus: 'reconciled',
      retryCount: 0,
      processedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  const promotedAdminDb = env
    .authenticatedContext('promoted_admin', {
      email: 'promoted-admin@sonicpush.ng',
      email_verified: true,
      superAdmin: true,
      role: 'SUPER_ADMIN',
    })
    .firestore();

  await assertSucceeds(getDoc(doc(promotedAdminDb, 'invoices', 'inv_alpha_1')));
  await assertSucceeds(getDoc(doc(promotedAdminDb, 'payment_webhook_events', 'paystack_evt_1')));

  // 10. Server-managed collections: clients cannot write bindings/webhooks/quotas/cleanup logs or read ai_rate_limits
  await assertFails(
    setDoc(doc(promoterADb, 'payment_reference_bindings', 'forged_bind'), {
      id: 'forged_bind',
      provider: 'paystack',
      reference: 'FORGED',
    })
  );
  await assertFails(
    setDoc(doc(promoterADb, 'payment_webhook_events', 'forged_wh'), {
      id: 'forged_wh',
      provider: 'paystack',
    })
  );
  await assertFails(
    setDoc(doc(promoterADb, 'ai_rate_limits', 'forged_rl'), {
      id: 'forged_rl',
      count: 0,
    })
  );
  await assertFails(getDoc(doc(promoterADb, 'payment_webhook_events', 'paystack_evt_1')));
  await assertFails(getDoc(doc(promotedAdminDb, 'ai_rate_limits', 'forged_rl')));
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'audio_cleanup_queue', 'aq_test_1'), {
      id: 'aq_test_1',
      organizationId: 'org_alpha',
      storageObjectPath: 'organizations/org_alpha/audio/1234.mp3',
      reason: 'song_delete_failed',
      status: 'pending',
      retryCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  await assertFails(
    setDoc(doc(promoterADb, 'audio_cleanup_logs', 'forged_clean'), {
      id: 'forged_clean',
      status: 'deleted',
    })
  );
  await assertFails(
    setDoc(doc(promoterADb, 'audio_cleanup_queue', 'forged_queue'), {
      id: 'forged_queue',
      status: 'pending',
    })
  );
  await assertFails(getDoc(doc(promoterADb, 'audio_cleanup_queue', 'aq_test_1')));
  await assertSucceeds(getDoc(doc(promotedAdminDb, 'audio_cleanup_queue', 'aq_test_1')));

  // 11. Song Phase 2 retention metadata validation
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = serverTimestamp();
    await setDoc(doc(db, 'artists', 'art_alpha_1'), {
      id: 'art_alpha_1',
      organizationId: 'org_alpha',
      ownerId: 'promoter_a',
      assignedUserIds: ['promoter_a'],
      name: 'Alpha Star',
      bio: 'Bio',
      country: 'Nigeria',
      city: 'Lagos',
      genre: 'Afrobeats',
      languages: 'English',
      targetAudience: 'Global',
      careerStage: 'Developing',
      marketingObjectives: 'Growth',
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  await assertSucceeds(
    setDoc(doc(promoterADb, 'songs', 'song_alpha_valid'), {
      id: 'song_alpha_valid',
      organizationId: 'org_alpha',
      ownerId: 'promoter_a',
      assignedUserIds: ['promoter_a'],
      artistId: 'art_alpha_1',
      artistName: 'Alpha Star',
      title: 'Midnight Lagos',
      genre: 'Afrobeats',
      language: 'English',
      releaseDate: '2026-06-01',
      audioStoragePath: 'organizations/org_alpha/audio/1234.mp3',
      audioUploadedAt: '2026-05-01T00:00:00.000Z',
      audioRetentionExpiresAt: '2026-08-01T00:00:00.000Z',
      audioStorageCleanupStatus: 'active',
      audioProcessed: true,
      message: 'Summer anthem',
      moodAndStyle: 'Warm Afro-fusion',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );

  await assertFails(
    setDoc(doc(promoterADb, 'songs', 'song_alpha_bad_status'), {
      id: 'song_alpha_bad_status',
      organizationId: 'org_alpha',
      ownerId: 'promoter_a',
      assignedUserIds: ['promoter_a'],
      artistId: 'art_alpha_1',
      artistName: 'Alpha Star',
      title: 'Invalid Status',
      genre: 'Afrobeats',
      language: 'English',
      releaseDate: '2026-06-01',
      audioStorageCleanupStatus: 'forged_status',
      audioProcessed: false,
      message: 'Test',
      moodAndStyle: 'Test',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );

  await env.cleanup();
});
