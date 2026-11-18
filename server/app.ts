import crypto from 'crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import Stripe from 'stripe';
import { GoogleGenAI, Type } from '@google/genai';
import {
  createAuthMiddleware,
  createFirebaseAdminClaimManager,
  requireRole,
  resolveServerSession,
  syncRoleCustomClaims,
  verifyFirebaseIdToken,
  type AuthClaimManager,
  type AuthenticatedRequest,
  type SessionResolverFn,
  type TokenVerifierFn,
  type UserRole,
} from './auth.ts';
import {
  fetchAuthorizedWorkspaceContext,
  getFirestoreDoc,
  patchFirestoreDoc,
  runFirestoreQuery,
} from './firestoreRest.ts';
import {
  createFirebaseAdminDbAdapter,
  inspectFirebaseAdminHealth,
  isPermissionOrCredentialError,
  SERVER_TIMESTAMP_SENTINEL,
  type AdminFirestoreAdapter,
  type FirebaseAdminDiagnostics,
} from './firebaseAdmin.ts';
import {
  AudioRetentionService,
  createFirebaseAdminAudioStorage,
  makeCleanupQueueDocId,
  parseAudioOrgFromPath,
  verifyStorageMetadataOrg,
  type AudioStorageAdapter,
} from './audioStorage.ts';
import {
  generateSafeAudioStorageDescriptor,
  MAX_AUDIO_SIZE_BYTES,
  validateAudioUpload,
} from './audioSecurity.ts';
import {
  formatSafeGeminiError,
  PROMPT_INJECTION_GUARD_INSTRUCTION,
  sanitizeTextField,
  validateAssistantMessages,
  wrapUntrustedBlock,
} from './aiSecurity.ts';
import {
  FirestoreDistributedQuotaLimiter,
  type AiFeatureName,
} from './rateLimit.ts';
import {
  constructVerifiedStripeWebhookEvent,
  normalizeFlutterwaveWebhookPayload,
  normalizePaystackWebhookPayload,
  normalizeStripeWebhookEvent,
  timingSafeEqualStr,
  verifyFlutterwaveWebhookSignature,
  verifyPaystackWebhookSignature,
  type CurrencyCode,
  type FetchLike,
  type PaymentProvider,
} from './payments.ts';
import {
  FirestorePaymentRepository,
  ReferenceConflictError,
} from './paymentLedger.ts';
import { logStructured, sanitizeErrorMessage } from './logger.ts';

export interface SonicPushAppDeps {
  tokenVerifier?: TokenVerifierFn;
  sessionResolver?: SessionResolverFn;
  adminDb?: AdminFirestoreAdapter;
  adminAuth?: AuthClaimManager;
  audioStorage?: AudioStorageAdapter;
  rateLimiter?: FirestoreDistributedQuotaLimiter;
  paymentRepository?: FirestorePaymentRepository;
  audioRetentionService?: AudioRetentionService;
  fetchImpl?: FetchLike;
  stripeClient?: Stripe;
  getDoc?: typeof getFirestoreDoc;
  runQuery?: typeof runFirestoreQuery;
  patchDoc?: typeof patchFirestoreDoc;
  fetchWorkspaceContext?: typeof fetchAuthorizedWorkspaceContext;
  getGeminiClient?: () => GoogleGenAI;
  getAdminDiagnosticsFn?: () => Promise<FirebaseAdminDiagnostics>;
}

function defaultGetGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function createSonicPushApp(deps: SonicPushAppDeps = {}): Express {
  const app = express();
  const adminDb = deps.adminDb ?? createFirebaseAdminDbAdapter();
  const adminAuth = deps.adminAuth ?? createFirebaseAdminClaimManager();
  const audioStorage = deps.audioStorage ?? createFirebaseAdminAudioStorage();

  const defaultResolver: SessionResolverFn = (identity, idToken) =>
    resolveServerSession(identity, idToken, { adminDb });

  const verifyFirebaseAuth = createAuthMiddleware(
    deps.tokenVerifier ?? verifyFirebaseIdToken,
    deps.sessionResolver ?? defaultResolver
  );

  const allowStarterFallback =
    process.env.ALLOW_STARTER_TIER_LIMITER_FALLBACK !== 'false' &&
    process.env.NODE_ENV !== 'test';

  const rateLimiter =
    deps.rateLimiter ??
    new FirestoreDistributedQuotaLimiter(adminDb, {
      allowStarterTierFallback: deps.adminDb ? false : allowStarterFallback,
    });

  const paymentRepo =
    deps.paymentRepository ??
    new FirestorePaymentRepository(adminDb, {
      fetchImpl: deps.fetchImpl,
      stripeClient: deps.stripeClient,
    });

  const audioRetention =
    deps.audioRetentionService ?? new AudioRetentionService(adminDb, audioStorage);

  const getDoc = deps.getDoc ?? getFirestoreDoc;
  const patchDoc = deps.patchDoc ?? patchFirestoreDoc;
  const fetchContext = deps.fetchWorkspaceContext ?? fetchAuthorizedWorkspaceContext;
  const getAiClient = deps.getGeminiClient ?? defaultGetGeminiClient;
  const getAdminDiag = deps.getAdminDiagnosticsFn ?? inspectFirebaseAdminHealth;

  // Capture rawBody buffer for webhook HMAC signature verification before JSON parsing
  app.use(
    express.json({
      limit: '4mb',
      verify: (req, _res, buf) => {
        (req as AuthenticatedRequest).rawBody = buf;
      },
    })
  );

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_SIZE_BYTES, files: 1 },
  });

  function aiQuotaMiddleware(feature: AiFeatureName) {
    return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      const session = req.authSession;
      if (!session?.uid) {
        res.status(401).json({ error: 'Authentication required.' });
        return;
      }

      try {
        const decision = await rateLimiter.checkAndConsume({
          uid: session.uid,
          organizationId: session.organizationId || session.uid,
          feature,
        });
        res.setHeader('X-RateLimit-Limit', String(decision.limit));
        res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
        res.setHeader('X-RateLimit-Mode', decision.mode);

        if (!decision.allowed) {
          res.setHeader('Retry-After', String(decision.retryAfterSeconds));
          res.status(429).json({
            error: decision.reason || 'Rate limit exceeded. Please retry shortly.',
            retryAfterSeconds: decision.retryAfterSeconds,
            scope: decision.scope,
          });
          return;
        }
        next();
      } catch (err) {
        logStructured('error', 'ai_quota_check_failed', {
          feature,
          error: sanitizeErrorMessage(err),
        });
        res.status(503).json({
          error: 'AI quota enforcement store is temporarily unavailable. Please retry.',
        });
      }
    };
  }

  function handleAudioUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
    upload.single('audio')(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'Audio upload exceeds the 20 MB maximum file size.' });
          return;
        }
        res.status(400).json({ error: `Invalid audio upload: ${err.message}` });
        return;
      }
      res.status(400).json({ error: 'Failed to process uploaded audio file.' });
    });
  }

  // ---------------------------------------------------------------------------
  // Health Check (Never Exposes Secrets or Tokens)
  // ---------------------------------------------------------------------------
  app.get('/api/health', async (_req: Request, res: Response) => {
    const adminDiag = await getAdminDiag().catch(() => null);
    const limiterDiag = rateLimiter.getDiagnostics();
    const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);
    const degraded =
      !geminiConfigured ||
      !adminDiag?.firestoreReady ||
      limiterDiag.mode === 'starter_tier_degraded';

    res.json({
      ok: true,
      status: degraded ? 'degraded' : 'ready',
      service: 'SONICPUSH AI',
      timestamp: new Date().toISOString(),
      checks: {
        server: true,
        geminiConfigured,
        firebaseAdminInitialized: Boolean(adminDiag?.initialized),
        firestoreReady: Boolean(adminDiag?.firestoreReady),
        storageReady: Boolean(adminDiag?.storageReady),
        rateLimiterMode: limiterDiag.mode,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Auth Session & Super Admin Governance (Custom Claims Sync + No Client Email Trust)
  // ---------------------------------------------------------------------------
  app.get('/api/auth/session', verifyFirebaseAuth, async (req: AuthenticatedRequest, res: Response) => {
    const s = req.authSession!;
    let claimsSynced = !s.needsTokenRefresh;

    if (s.isSuperAdmin && s.needsTokenRefresh) {
      const syncResult = await syncRoleCustomClaims(
        s.uid,
        'SUPER_ADMIN',
        adminAuth,
        s.organizationId || undefined
      );
      claimsSynced = syncResult.synced;
    }

    res.json({
      uid: s.uid,
      email: s.email,
      emailVerified: s.emailVerified,
      role: s.role,
      isSuperAdmin: s.isSuperAdmin,
      isBootstrapAdmin: s.isBootstrapAdmin,
      needsTokenRefresh: Boolean(s.needsTokenRefresh && claimsSynced),
      claimsSynced,
      onboardingCompleted: s.onboardingCompleted,
      organizationId: s.organizationId,
      capabilities: s.capabilities,
    });
  });

  app.post('/api/auth/refresh-claims', verifyFirebaseAuth, async (req: AuthenticatedRequest, res: Response) => {
    const s = req.authSession!;
    const targetRole: UserRole = s.role || 'ARTIST';
    const syncResult = await syncRoleCustomClaims(
      s.uid,
      targetRole,
      adminAuth,
      s.organizationId || undefined
    );
    res.json({
      ok: syncResult.synced,
      role: targetRole,
      isSuperAdmin: s.isSuperAdmin,
      claimsSynced: syncResult.synced,
      note: syncResult.reason,
    });
  });

  app.post(
    '/api/auth/onboarding-check',
    verifyFirebaseAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const s = req.authSession!;
      const requestedRole = sanitizeTextField(req.body?.role, 32) as UserRole;
      if (
        requestedRole !== 'SUPER_ADMIN' &&
        requestedRole !== 'PROMOTER' &&
        requestedRole !== 'ARTIST'
      ) {
        res.status(400).json({ error: 'Invalid role requested.' });
        return;
      }
      if (requestedRole === 'SUPER_ADMIN' && !s.isSuperAdmin) {
        logStructured('warn', 'role_escalation_blocked', { uidPrefix: s.uid.slice(0, 8) });
        res.status(403).json({
          error: 'Only authorized platform administrators may hold the SUPER_ADMIN role.',
        });
        return;
      }
      res.json({
        approvedRole:
          s.isSuperAdmin && requestedRole === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : requestedRole,
        isSuperAdmin: s.isSuperAdmin,
      });
    }
  );

  app.post(
    '/api/admin/users/:targetUid/role',
    verifyFirebaseAuth,
    requireRole(['SUPER_ADMIN']),
    async (req: AuthenticatedRequest, res: Response) => {
      const session = req.authSession!;
      const targetUid = sanitizeTextField(req.params.targetUid, 128);
      const nextRole = sanitizeTextField(req.body?.role, 32) as UserRole;

      if (!targetUid || !/^[a-zA-Z0-9_-]+$/.test(targetUid)) {
        res.status(400).json({ error: 'Invalid target user identifier.' });
        return;
      }
      if (nextRole !== 'SUPER_ADMIN' && nextRole !== 'PROMOTER' && nextRole !== 'ARTIST') {
        res.status(400).json({ error: 'Role must be SUPER_ADMIN, PROMOTER, or ARTIST.' });
        return;
      }

      try {
        let targetDoc: Record<string, unknown> | null = null;
        try {
          targetDoc = await adminDb.getDoc('users', targetUid);
        } catch {
          targetDoc = null;
        }
        if (!targetDoc) {
          targetDoc = await getDoc('users', targetUid, session.idToken);
        }

        if (!targetDoc) {
          res.status(404).json({ error: 'Target user record not found.' });
          return;
        }

        const targetEmail = typeof targetDoc.email === 'string' ? targetDoc.email.toLowerCase() : '';
        if (targetEmail === 'emma432cent@gmail.com' && nextRole !== 'SUPER_ADMIN') {
          res.status(403).json({
            error: 'Bootstrap platform owner cannot be demoted from SUPER_ADMIN.',
          });
          return;
        }
        if (targetUid === session.uid && nextRole !== 'SUPER_ADMIN') {
          res.status(403).json({
            error: 'Administrators cannot revoke their own SUPER_ADMIN privilege.',
          });
          return;
        }

        const previousRole = typeof targetDoc.role === 'string' ? targetDoc.role : 'unknown';

        // Persist role update in Firestore (Admin SDK primary, REST fallback if injected or starter tier)
        let persisted = false;
        try {
          await adminDb.updateDoc('users', targetUid, {
            role: nextRole,
            updatedAt: SERVER_TIMESTAMP_SENTINEL,
          });
          persisted = true;
        } catch (err) {
          if (!isPermissionOrCredentialError(err) && !deps.patchDoc) {
            throw err;
          }
        }

        if (deps.patchDoc || !persisted) {
          await patchDoc(
            'users',
            targetUid,
            { role: nextRole, updatedAt: new Date().toISOString() },
            session.idToken
          );
        }

        // Sync Firebase Auth custom claims so Firestore & Storage `allow list` / org rules match immediately upon token refresh
        const targetOrgId =
          typeof targetDoc.organizationId === 'string' && targetDoc.organizationId
            ? targetDoc.organizationId
            : undefined;
        const claimSync = await syncRoleCustomClaims(targetUid, nextRole, adminAuth, targetOrgId);

        // Server-side immutable admin audit log
        const auditId = `audit_srv_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
        await adminDb
          .setDoc('admin_audit_logs', auditId, {
            id: auditId,
            organizationId: session.organizationId || 'platform',
            ownerId: session.uid,
            assignedUserIds: [session.uid],
            action: 'user_role_updated',
            targetUid,
            detail: `Role changed ${previousRole} -> ${nextRole} (claimsSynced=${claimSync.synced})`,
            createdAt: SERVER_TIMESTAMP_SENTINEL,
            updatedAt: SERVER_TIMESTAMP_SENTINEL,
          })
          .catch(() => null);

        logStructured('info', 'admin_role_updated', {
          actorPrefix: session.uid.slice(0, 8),
          targetPrefix: targetUid.slice(0, 8),
          previousRole,
          nextRole,
          claimsSynced: claimSync.synced,
        });

        res.json({
          ok: true,
          targetUid,
          role: nextRole,
          claimsSynced: claimSync.synced,
          claimsNote: claimSync.reason,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unable to update user role.';
        res.status(msg.includes('PERMISSION_DENIED') ? 403 : 500).json({
          error: 'Failed to update user role safely.',
        });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Admin Diagnostics & Operations Console Endpoints
  // ---------------------------------------------------------------------------
  app.get(
    '/api/admin/diagnostics',
    verifyFirebaseAuth,
    requireRole(['SUPER_ADMIN']),
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const [
          firebaseAdmin,
          recentWebhooks,
          recentCleanupLogs,
          aiUsageMetrics,
          failedCleanupSongs,
          pendingQueue,
        ] = await Promise.all([
          getAdminDiag(),
          paymentRepo.listAdminDiagnosticsWebhooks(40).catch(() => []),
          audioRetention.listRecentCleanupLogs(25),
          rateLimiter.getAdminUsageMetrics().catch(() => null),
          adminDb
            .queryDocs(
              'songs',
              [{ field: 'audioStorageCleanupStatus', op: '==', value: 'cleanup_failed' }],
              { limit: 50 }
            )
            .catch(() => []),
          audioRetention.listPendingCleanupQueue(50),
        ]);

        const pendingRetryCount = recentWebhooks.filter(
          (w) => w.reconciliationStatus === 'pending_retry'
        ).length;
        const quarantinedCount = recentWebhooks.filter(
          (w) => w.reconciliationStatus === 'quarantined'
        ).length;

        res.json({
          timestamp: new Date().toISOString(),
          service: 'SONICPUSH AI',
          providers: {
            geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
            paystackConfigured: Boolean(process.env.PAYSTACK_SECRET_KEY),
            flutterwaveConfigured: Boolean(process.env.FLUTTERWAVE_SECRET_KEY),
            flutterwaveWebhookConfigured: Boolean(process.env.FLUTTERWAVE_SECRET_HASH),
            stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
            stripeWebhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
          },
          firebaseAdmin,
          webhookSummary: {
            totalRecent: recentWebhooks.length,
            pendingRetryCount,
            quarantinedCount,
            recentEvents: recentWebhooks.slice(0, 20),
          },
          audioCleanup: {
            failedSongsCount: failedCleanupSongs.length,
            pendingQueueCount: pendingQueue.length,
            recentLogs: recentCleanupLogs,
          },
          aiQuota: {
            ...rateLimiter.getDiagnostics(),
            usageMetrics: aiUsageMetrics,
          },
        });
      } catch (err) {
        logStructured('error', 'admin_diagnostics_error', {
          error: sanitizeErrorMessage(err),
        });
        res.status(500).json({ error: 'Unable to retrieve platform diagnostics.' });
      }
    }
  );

  // Audio retention cleanup trigger (Super Admin OR Cloud Scheduler cron secret)
  app.post('/api/admin/audio/cleanup', async (req: AuthenticatedRequest, res: Response) => {
    const cronSecret = process.env.AUDIO_CLEANUP_CRON_SECRET;
    const providedCronSecret = sanitizeTextField(req.headers['x-cron-secret'], 256);

    const authorizedByCron =
      Boolean(cronSecret) && Boolean(providedCronSecret) && timingSafeEqualStr(providedCronSecret, cronSecret!);

    if (!authorizedByCron) {
      // Fall back to standard Firebase Auth + SUPER_ADMIN role gate
      await new Promise<void>((resolve) => {
        verifyFirebaseAuth(req, res, () => resolve());
      });
      if (res.headersSent) return;
      if (!req.authSession?.isSuperAdmin) {
        res.status(403).json({
          error: 'Access denied. Only SUPER_ADMIN or scheduled cleanup secret may trigger audio cleanup.',
        });
        return;
      }
    }

    try {
      const limit = Number(req.body?.limit) || 50;
      const includeOrphans = req.body?.includeOrphans !== false;
      const orphanGraceMinutes =
        typeof req.body?.orphanGraceMinutes === 'number' &&
        Number.isFinite(req.body.orphanGraceMinutes)
          ? req.body.orphanGraceMinutes
          : undefined;
      const organizationId = sanitizeTextField(req.body?.organizationId, 128) || undefined;
      const orphanPageSize =
        typeof req.body?.orphanPageSize === 'number' && Number.isFinite(req.body.orphanPageSize)
          ? req.body.orphanPageSize
          : undefined;
      const orphanMaxPagesPerRun =
        typeof req.body?.orphanMaxPagesPerRun === 'number' &&
        Number.isFinite(req.body.orphanMaxPagesPerRun)
          ? req.body.orphanMaxPagesPerRun
          : undefined;
      const orphanMaxObjectsPerRun =
        typeof req.body?.orphanMaxObjectsPerRun === 'number' &&
        Number.isFinite(req.body.orphanMaxObjectsPerRun)
          ? req.body.orphanMaxObjectsPerRun
          : undefined;
      const resetOrphanCursor = req.body?.resetOrphanCursor === true;
      const summary = await audioRetention.cleanupExpiredAudio({
        limit,
        includeOrphans,
        orphanGraceMinutes,
        orphanPageSize,
        orphanMaxPagesPerRun,
        orphanMaxObjectsPerRun,
        resetOrphanCursor,
        organizationId,
      });
      res.json(summary);
    } catch (err) {
      const safeErr = sanitizeErrorMessage(err, 'Audio retention cleanup execution failed.');
      logStructured('error', 'audio_cleanup_endpoint_failed', {
        error: safeErr,
      });
      res.status(500).json({ error: safeErr });
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Song Intelligence + Private Firebase Storage Audio Upload / Download / Delete
  // ---------------------------------------------------------------------------
  app.post(
    '/api/ai/song-intelligence',
    verifyFirebaseAuth,
    aiQuotaMiddleware('song_intelligence'),
    handleAudioUploadMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      const started = Date.now();
      const session = req.authSession!;
      let audioUploaded = false;
      let effectiveOrgId = session.organizationId || session.uid;
      let audioDescriptor: {
        storageObjectPath: string;
        safeFilename: string;
        retentionExpiresAt: string;
        detectedFormat: string;
        canonicalMimeType: string;
      } | null = null;

      try {
        const body = (req.body || {}) as Record<string, unknown>;
        const title = sanitizeTextField(body.title, 180);
        const artistName = sanitizeTextField(body.artistName, 140);
        const genre = sanitizeTextField(body.genre, 120);
        const language = sanitizeTextField(body.language, 100);
        const releaseDate = sanitizeTextField(body.releaseDate, 40);
        const streamingLink = sanitizeTextField(body.streamingLink, 1024);
        const message = sanitizeTextField(body.message, 1500);
        const moodAndStyle = sanitizeTextField(body.moodAndStyle, 800);
        const lyrics = sanitizeTextField(body.lyrics, 8000);
        const requestedOrgId = sanitizeTextField(body.organizationId, 128);

        if (!title) {
          if (req.file?.buffer) req.file.buffer.fill(0);
          res.status(400).json({ error: 'Song title is required.' });
          return;
        }
        if (requestedOrgId && !session.isSuperAdmin && requestedOrgId !== session.organizationId) {
          if (req.file?.buffer) req.file.buffer.fill(0);
          res.status(403).json({ error: 'Cross-organization upload rejected.' });
          return;
        }

        effectiveOrgId = requestedOrgId || session.organizationId || session.uid;
        const file = req.file;
        let audioProcessed = false;
        let audioUploadedAt = '';

        const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> =
          [];

        if (file) {
          const sigCheck = validateAudioUpload(file.buffer, file.mimetype, file.originalname);
          if (
            !sigCheck.valid ||
            !sigCheck.detectedFormat ||
            !sigCheck.canonicalMimeType ||
            !sigCheck.extension
          ) {
            file.buffer.fill(0);
            res.status(400).json({ error: sigCheck.error || 'Invalid audio file signature.' });
            return;
          }

          const storageMeta = generateSafeAudioStorageDescriptor(effectiveOrgId, sigCheck.extension);
          audioUploadedAt = new Date().toISOString();
          audioDescriptor = {
            ...storageMeta,
            detectedFormat: sigCheck.detectedFormat,
            canonicalMimeType: sigCheck.canonicalMimeType,
          };

          // Authoritative private server-side Firebase Storage upload (fail closed if storage fails)
          try {
            await audioStorage.uploadPrivateAudio({
              storageObjectPath: storageMeta.storageObjectPath,
              buffer: file.buffer,
              contentType: sigCheck.canonicalMimeType,
              ownerId: session.uid,
              organizationId: effectiveOrgId,
              retentionExpiresAt: storageMeta.retentionExpiresAt,
              uploadedAt: audioUploadedAt,
            });
            audioUploaded = true;
          } catch (storageErr) {
            file.buffer.fill(0);
            logStructured('error', 'audio_private_storage_upload_failed', {
              uidPrefix: session.uid.slice(0, 8),
              orgId: effectiveOrgId,
              error: sanitizeErrorMessage(storageErr),
            });
            res.status(502).json({
              error:
                'Private audio storage upload failed. Verify Firebase Storage configuration and IAM permissions before retrying.',
              audioProcessed: false,
              audioUploaded: false,
            });
            return;
          }

          parts.push({
            inlineData: {
              mimeType: sigCheck.canonicalMimeType,
              data: file.buffer.toString('base64'),
            },
          });
          audioProcessed = true;
          file.buffer.fill(0);
        }

        const prompt = `${PROMPT_INJECTION_GUARD_INSTRUCTION}

Analyze this music release for SONICPUSH AI, a Nigerian, African, and international music promotion agency.

${wrapUntrustedBlock('Title', title)}
${wrapUntrustedBlock('Artist', artistName || 'Not specified')}
${wrapUntrustedBlock('Genre', genre || 'Not specified')}
${wrapUntrustedBlock('Language(s)', language || 'Not specified')}
${wrapUntrustedBlock('Release Date', releaseDate || 'Not specified')}
${wrapUntrustedBlock('Streaming / Preview Link', streamingLink || 'None provided')}
${wrapUntrustedBlock('Core Song Message', message || 'Not specified')}
${wrapUntrustedBlock('Mood & Style Description', moodAndStyle || 'Not specified')}
- Audio File Uploaded & Signature-Verified for Direct Listening: ${
          audioProcessed
            ? `YES (verified ${audioDescriptor?.detectedFormat.toUpperCase()} audio, ${Math.round((file?.size || 0) / 1024)} KB)`
            : 'NO'
        }
${wrapUntrustedBlock('User-Authorized Lyrics', lyrics || 'None provided')}

CRITICAL HONESTY & GROUNDING RULES:
1. If Audio File Uploaded is NO, you MUST NOT claim to have listened to the audio, tempo, vocal tone, instrumentation, or beat. Only list factual observations from the user-provided metadata/lyrics in "verifiedObservations" (clearly labeled as user-submitted metadata).
2. If Audio File Uploaded is YES, include direct acoustic/musical observations you actually hear in the audio inside "verifiedObservations" and keep marketing recommendations in "aiHypotheses".
3. Never invent streaming numbers, chart placements, or real-world release outcomes.`;

        parts.push({ text: prompt });

        const ai = getAiClient();
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: { parts },
          config: {
            systemInstruction:
              'You are a senior A&R director and music marketing strategist at SONICPUSH AI, specializing in Nigerian music culture (Afrobeats, Amapiano, Afro-fusion, Hip-hop, Gospel, R&B, Dancehall) and global diaspora markets. Always distinguish verified facts/audio observations from user claims and strategic hypotheses.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                verifiedObservations: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                aiHypotheses: {
                  type: Type.OBJECT,
                  properties: {
                    songPositioning: { type: Type.STRING },
                    genreAssessment: { type: Type.STRING },
                    audienceSegments: { type: Type.ARRAY, items: { type: Type.STRING } },
                    marketingAngles: { type: Type.ARRAY, items: { type: Type.STRING } },
                    shortFormOpportunities: { type: Type.ARRAY, items: { type: Type.STRING } },
                    emotionalStorytelling: { type: Type.ARRAY, items: { type: Type.STRING } },
                    suggestedObjectives: { type: Type.ARRAY, items: { type: Type.STRING } },
                    brandingRecommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
                    promotionalChannels: { type: Type.ARRAY, items: { type: Type.STRING } },
                  },
                  required: [
                    'songPositioning',
                    'genreAssessment',
                    'audienceSegments',
                    'marketingAngles',
                    'shortFormOpportunities',
                    'emotionalStorytelling',
                    'suggestedObjectives',
                    'brandingRecommendations',
                    'promotionalChannels',
                  ],
                },
              },
              required: ['verifiedObservations', 'aiHypotheses'],
            },
          },
        });

        const parsed = JSON.parse((response.text ?? '{}').trim());
        const latencyMs = Date.now() - started;

        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: effectiveOrgId,
          feature: 'song_intelligence',
          model: 'gemini-4-hydrogen',
          status: 'success',
          latencyMs,
        });

        logStructured('info', 'ai_song_intelligence', {
          uidPrefix: session.uid.slice(0, 8),
          audioProcessed,
          audioUploaded,
          latencyMs,
        });

        res.json({
          audioProcessed,
          audioUploaded,
          audioFileName: audioDescriptor?.safeFilename || '',
          audioStoragePath: audioDescriptor?.storageObjectPath || '',
          audioMimeType: audioDescriptor?.canonicalMimeType || '',
          audioSignatureFormat: audioDescriptor?.detectedFormat || '',
          audioUploadedAt: audioUploadedAt || '',
          audioRetentionExpiresAt: audioDescriptor?.retentionExpiresAt || '',
          audioStorageCleanupStatus: audioUploaded ? 'active' : 'none',
          verifiedObservations: parsed.verifiedObservations || [],
          aiHypotheses: parsed.aiHypotheses,
          latencyMs,
          model: 'gemini-4-hydrogen',
        });
      } catch (err) {
        if (req.file?.buffer) {
          req.file.buffer.fill(0);
        }

        // Rollback or enqueue durable cleanup if audio was already uploaded before Gemini failed
        let cleanupQueued = false;
        if (audioUploaded && audioDescriptor?.storageObjectPath) {
          const rollbackPath = audioDescriptor.storageObjectPath;
          try {
            await audioStorage.deleteAudioObject(rollbackPath);
            await audioRetention.logCleanupAttempt({
              songId: 'rollback_gemini_failed',
              organizationId: effectiveOrgId,
              storageObjectPath: rollbackPath,
              status: 'deleted',
              reason: 'gemini_analysis_failed',
            });
            logStructured('info', 'audio_upload_rolled_back_on_gemini_failure', {
              orgId: effectiveOrgId,
              storageObjectPath: rollbackPath,
            });
          } catch (cleanupErr) {
            cleanupQueued = true;
            logStructured('error', 'audio_rollback_failed_enqueueing', {
              orgId: effectiveOrgId,
              storageObjectPath: rollbackPath,
              error: sanitizeErrorMessage(cleanupErr),
            });
            await audioRetention
              .enqueueCleanupTask({
                storageObjectPath: rollbackPath,
                organizationId: effectiveOrgId,
                deleteSongOnCleanup: false,
                reason: 'gemini_analysis_failed',
                error: cleanupErr,
              })
              .catch(() => null);
          }
        }

        const safeErr = formatSafeGeminiError(err, 'Failed to analyze song release.');
        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: effectiveOrgId,
          feature: 'song_intelligence',
          model: 'gemini-4-hydrogen',
          status: 'error',
          latencyMs: Date.now() - started,
        });
        logStructured('error', 'ai_song_intelligence_error', {
          uidPrefix: session.uid.slice(0, 8),
          status: safeErr.status,
          cleanupQueued,
          latencyMs: Date.now() - started,
        });
        res.status(safeErr.status).json({
          error: safeErr.message,
          audioProcessed: false,
          audioUploaded: false,
          cleanupQueued,
          latencyMs: Date.now() - started,
        });
      }
    }
  );

  // Authorized private audio URL / download stream (strict organization & assignment verification)
  app.get(
    '/api/songs/:songId/audio-url',
    verifyFirebaseAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const session = req.authSession!;
      const songId = sanitizeTextField(req.params.songId, 128);
      if (!songId || !/^[a-zA-Z0-9_-]+$/.test(songId)) {
        res.status(400).json({ error: 'Invalid song identifier.' });
        return;
      }

      try {
        let song = await adminDb.getDoc('songs', songId).catch(() => null);
        if (!song) {
          song = await getDoc('songs', songId, session.idToken).catch(() => null);
        }
        if (!song) {
          res.status(404).json({ error: 'Song not found.' });
          return;
        }

        const songOrg = typeof song.organizationId === 'string' ? song.organizationId : '';
        const assignedUsers = Array.isArray(song.assignedUserIds)
          ? (song.assignedUserIds as string[])
          : [];
        const authorized =
          session.isSuperAdmin ||
          song.ownerId === session.uid ||
          assignedUsers.includes(session.uid) ||
          (Boolean(session.organizationId) && session.organizationId === songOrg);

        if (!authorized) {
          res.status(403).json({ error: 'Cross-organization audio access denied.' });
          return;
        }

        const storagePath = typeof song.audioStoragePath === 'string' ? song.audioStoragePath : '';
        if (!storagePath || song.audioStorageCleanupStatus === 'deleted') {
          res.status(404).json({ error: 'No active private audio file exists for this song.' });
          return;
        }

        if (audioStorage.getSignedReadUrl) {
          try {
            const url = await audioStorage.getSignedReadUrl(storagePath, 900);
            res.json({
              mode: 'signed_url',
              url,
              expiresInSeconds: 900,
              storageObjectPath: storagePath,
            });
            return;
          } catch {
            // Fall through to authorized server proxy stream when IAM signBlob is unavailable (e.g. emulator)
          }
        }

        res.json({
          mode: 'proxy_stream',
          url: `/api/songs/${encodeURIComponent(songId)}/audio-stream`,
          storageObjectPath: storagePath,
        });
      } catch (err) {
        res.status(500).json({ error: sanitizeErrorMessage(err, 'Failed to authorize audio download.') });
      }
    }
  );

  app.get(
    '/api/songs/:songId/audio-stream',
    verifyFirebaseAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const session = req.authSession!;
      const songId = sanitizeTextField(req.params.songId, 128);
      if (!songId || !/^[a-zA-Z0-9_-]+$/.test(songId)) {
        res.status(400).json({ error: 'Invalid song identifier.' });
        return;
      }

      try {
        let song = await adminDb.getDoc('songs', songId).catch(() => null);
        if (!song) {
          song = await getDoc('songs', songId, session.idToken).catch(() => null);
        }
        if (!song) {
          res.status(404).json({ error: 'Song not found.' });
          return;
        }

        const songOrg = typeof song.organizationId === 'string' ? song.organizationId : '';
        const assignedUsers = Array.isArray(song.assignedUserIds)
          ? (song.assignedUserIds as string[])
          : [];
        const authorized =
          session.isSuperAdmin ||
          song.ownerId === session.uid ||
          assignedUsers.includes(session.uid) ||
          (Boolean(session.organizationId) && session.organizationId === songOrg);

        if (!authorized) {
          res.status(403).json({ error: 'Cross-organization audio stream access denied.' });
          return;
        }

        const storagePath = typeof song.audioStoragePath === 'string' ? song.audioStoragePath : '';
        if (!storagePath || song.audioStorageCleanupStatus === 'deleted') {
          res.status(404).json({ error: 'Audio object is unavailable or has expired.' });
          return;
        }

        if (!audioStorage.readAudioStream) {
          res.status(501).json({ error: 'Server audio streaming is not supported.' });
          return;
        }

        const streamed = await audioStorage.readAudioStream(storagePath);
        res.setHeader(
          'Content-Type',
          streamed.contentType ||
            (typeof song.audioMimeType === 'string' ? song.audioMimeType : 'application/octet-stream')
        );
        res.setHeader('Cache-Control', 'private, no-store');
        res.send(streamed.buffer);
      } catch {
        res.status(404).json({ error: 'Audio file could not be retrieved from storage.' });
      }
    }
  );

  app.delete(
    '/api/songs/:songId',
    verifyFirebaseAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const session = req.authSession!;
      const songId = sanitizeTextField(req.params.songId, 128);
      if (!songId || !/^[a-zA-Z0-9_-]+$/.test(songId)) {
        res.status(400).json({ error: 'Invalid song identifier.' });
        return;
      }

      try {
        let song = await adminDb.getDoc('songs', songId).catch(() => null);
        if (!song) {
          song = await getDoc('songs', songId, session.idToken).catch(() => null);
        }
        if (!song) {
          res.status(404).json({ error: 'Song not found.' });
          return;
        }

        if (!session.isSuperAdmin && song.ownerId !== session.uid) {
          res.status(403).json({ error: 'Only the song owner or SUPER_ADMIN may delete this release.' });
          return;
        }

        const songOrg = typeof song.organizationId === 'string' ? song.organizationId : '';
        if (
          !session.isSuperAdmin &&
          session.organizationId &&
          songOrg &&
          session.organizationId !== songOrg
        ) {
          res.status(403).json({
            ok: false,
            deleted: false,
            error: 'Cross-organization song deletion blocked.',
          });
          return;
        }

        const storagePath = typeof song.audioStoragePath === 'string' ? song.audioStoragePath : '';
        const hasActiveStorageObject = Boolean(
          storagePath && song.audioStorageCleanupStatus !== 'deleted'
        );
        let storageDeleted = false;

        if (hasActiveStorageObject) {
          const pathOrg = parseAudioOrgFromPath(storagePath);
          if (!pathOrg || !songOrg || pathOrg !== songOrg) {
            logStructured('warn', 'song_delete_cross_org_path_blocked', {
              songId,
              songOrg,
              pathOrg,
            });
            res.status(403).json({
              ok: false,
              deleted: false,
              error: 'Cross-organization storage deletion blocked.',
            });
            return;
          }

          const metaCheck = await verifyStorageMetadataOrg(audioStorage, storagePath, songOrg);
          if (metaCheck.status === 'conflict' || metaCheck.status === 'unverified_org') {
            logStructured('warn', 'song_delete_cross_org_metadata_blocked', {
              songId,
              songOrg,
              status: metaCheck.status,
              metadataOrg: metaCheck.status === 'conflict' ? metaCheck.metadataOrg : 'missing',
            });
            res.status(403).json({
              ok: false,
              deleted: false,
              error:
                metaCheck.status === 'conflict'
                  ? 'Cross-organization storage deletion blocked due to object metadata mismatch.'
                  : 'Storage deletion blocked because object organization ownership metadata could not be established.',
            });
            return;
          }

          if (metaCheck.status === 'lookup_error') {
            const safeMetaErr = sanitizeErrorMessage(
              metaCheck.error,
              'Failed to verify private audio metadata before deletion.'
            );
            await adminDb
              .updateDoc('songs', songId, {
                audioStorageCleanupStatus: 'cleanup_failed',
                audioCleanupError: safeMetaErr.slice(0, 380),
                updatedAt: SERVER_TIMESTAMP_SENTINEL,
              })
              .catch(() => null);

            let cleanupQueued = false;
            try {
              await audioRetention.enqueueCleanupTask({
                storageObjectPath: storagePath,
                organizationId: songOrg,
                songId,
                deleteSongOnCleanup: true,
                storageDeleted: false,
                reason: 'song_delete_failed',
                error: metaCheck.error,
              });
              cleanupQueued = true;
            } catch {
              cleanupQueued = false;
            }

            logStructured('error', 'song_delete_metadata_lookup_failed_preserved_db', {
              songId,
              orgId: songOrg,
              cleanupQueued,
              error: safeMetaErr,
            });

            res.status(502).json({
              ok: false,
              deleted: false,
              cleanupPending: true,
              cleanupQueued,
              storageDeleted: false,
              songId,
              error:
                'Private audio metadata verification failed. Storage object and database record were preserved and cleanup retry has been queued.',
            });
            return;
          }

          if (metaCheck.status === 'missing_object') {
            // Confirmed 404 / missing Storage object: handle safely as already deleted
            storageDeleted = true;
          } else {
            try {
              await audioStorage.deleteAudioObject(storagePath);
              storageDeleted = true;
            } catch (storageErr) {
              const safeErr = sanitizeErrorMessage(
                storageErr,
                'Failed to delete private audio file from Storage.'
              );
              await adminDb
                .updateDoc('songs', songId, {
                  audioStorageCleanupStatus: 'cleanup_failed',
                  audioCleanupError: safeErr.slice(0, 380),
                  updatedAt: SERVER_TIMESTAMP_SENTINEL,
                })
                .catch(() => null);

              let cleanupQueued = false;
              try {
                await audioRetention.enqueueCleanupTask({
                  storageObjectPath: storagePath,
                  organizationId: songOrg,
                  songId,
                  deleteSongOnCleanup: true,
                  storageDeleted: false,
                  reason: 'song_delete_failed',
                  error: storageErr,
                });
                cleanupQueued = true;
              } catch {
                cleanupQueued = false;
              }

              logStructured('error', 'song_delete_storage_failed_preserved_db', {
                songId,
                orgId: songOrg,
                cleanupQueued,
                error: safeErr,
              });

              res.status(502).json({
                ok: false,
                deleted: false,
                cleanupPending: true,
                cleanupQueued,
                storageDeleted: false,
                songId,
                error:
                  'Private audio deletion failed in Storage. Database metadata was preserved and cleanup retry has been queued.',
              });
              return;
            }
          }
        }

        try {
          await adminDb.deleteDoc('songs', songId);
        } catch (dbErr) {
          const safeDbErr = sanitizeErrorMessage(
            dbErr,
            'Failed to delete song record in Firestore.'
          );
          const effectiveSongOrg = songOrg || session.organizationId || '';
          const queuePath =
            storagePath ||
            (effectiveSongOrg
              ? `organizations/${effectiveSongOrg}/audio/metadata-only-${songId}`
              : '');

          await adminDb
            .updateDoc('songs', songId, {
              ...(storageDeleted ? { audioStorageCleanupStatus: 'deleted' } : {}),
              audioCleanupError: safeDbErr.slice(0, 380),
              updatedAt: SERVER_TIMESTAMP_SENTINEL,
            })
            .catch(() => null);

          let cleanupQueued = false;
          if (queuePath && effectiveSongOrg) {
            try {
              await audioRetention.enqueueCleanupTask({
                storageObjectPath: queuePath,
                organizationId: effectiveSongOrg,
                songId,
                deleteSongOnCleanup: true,
                storageDeleted: true,
                reason: 'song_delete_failed',
                error: dbErr,
              });
              cleanupQueued = true;
            } catch {
              cleanupQueued = false;
            }
          }

          logStructured('error', 'song_delete_firestore_failed_cleanup_pending', {
            songId,
            orgId: effectiveSongOrg,
            storageDeleted,
            cleanupQueued,
            error: safeDbErr,
          });

          res.status(502).json({
            ok: false,
            deleted: false,
            cleanupPending: true,
            cleanupQueued,
            storageDeleted,
            songId,
            error: cleanupQueued
              ? 'Storage deletion succeeded, but Firestore song deletion failed. Cleanup is pending and a durable retry task has been queued.'
              : 'Storage deletion succeeded, but Firestore song deletion failed and cleanup queuing also failed.',
          });
          return;
        }

        if (storageDeleted && storagePath) {
          await audioRetention.logCleanupAttempt({
            songId,
            organizationId: songOrg,
            storageObjectPath: storagePath,
            status: 'deleted',
            reason: 'song_delete_failed',
          });
          await adminDb
            .deleteDoc('audio_cleanup_queue', makeCleanupQueueDocId(storagePath))
            .catch(() => null);
        }

        res.json({ ok: true, deleted: true, songId });
      } catch (err) {
        res.status(500).json({
          ok: false,
          deleted: false,
          error: sanitizeErrorMessage(err, 'Failed to delete song.'),
        });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 2. AI Music Campaign Manager
  // ---------------------------------------------------------------------------
  app.post(
    '/api/ai/campaign-generate',
    verifyFirebaseAuth,
    aiQuotaMiddleware('campaign_generate'),
    async (req: AuthenticatedRequest, res: Response) => {
      const started = Date.now();
      const session = req.authSession!;
      try {
        const body = (req.body || {}) as Record<string, unknown>;
        const artistName = sanitizeTextField(body.artistName, 140);
        const artistCountry = sanitizeTextField(body.artistCountry, 80);
        const artistGenre = sanitizeTextField(body.artistGenre, 120);
        const songTitle = sanitizeTextField(body.songTitle, 180);
        const songMessage = sanitizeTextField(body.songMessage, 1500);
        const campaignType = sanitizeTextField(body.campaignType, 100);
        const targetMarkets = sanitizeTextField(body.targetMarkets, 300);
        const currency = sanitizeTextField(body.currency, 8) || 'NGN';
        const durationDays = Math.min(
          365,
          Math.max(1, Math.round(Number(body.durationDays) || 30))
        );
        const budget = Math.max(0, Number(body.budget) || 0);

        if (!artistName || !campaignType) {
          res.status(400).json({ error: 'Artist name and campaign type are required.' });
          return;
        }
        if (!['NGN', 'USD', 'GBP', 'EUR'].includes(currency)) {
          res.status(400).json({ error: 'Unsupported currency code.' });
          return;
        }

        const ai = getAiClient();
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `${PROMPT_INJECTION_GUARD_INSTRUCTION}

Generate a comprehensive ${durationDays}-day promotional campaign strategy:
${wrapUntrustedBlock('Campaign Type', campaignType)}
${wrapUntrustedBlock('Artist Name', artistName)}
${wrapUntrustedBlock('Country & Genre', `${artistCountry || 'Nigeria / Africa'} | ${artistGenre || 'Afrobeats'}`)}
${wrapUntrustedBlock('Song Title', songTitle || 'Artist Catalogue / Release')}
${wrapUntrustedBlock('Song Message', songMessage || 'Not specified')}
${wrapUntrustedBlock('Target Markets', targetMarkets || 'Nigeria, West Africa, UK Diaspora, Global')}
- Planned Budget: ${budget} ${currency}

STRICT INTEGRITY RULES:
1. Work strictly within the user's ${budget} ${currency} budget for budget allocations (use percentages + approximate ${currency} splits clearly labeled as planning estimates).
2. NEVER invent guaranteed advertising costs (CPC/CPM), fake influencer rate cards, guaranteed playlist placements, or guaranteed stream counts.
3. Explicitly label projections and assumptions in "projectionsDisclaimer".`,
          config: {
            systemInstruction:
              'You are a Principal Music Campaign Director at SONICPUSH AI. Produce actionable, culturally authentic Nigerian/African & international campaign plans covering all 15 strategic pillars.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                overview: { type: Type.STRING },
                marketingObjectives: { type: Type.STRING },
                targetAudience: { type: Type.STRING },
                platformStrategy: { type: Type.STRING },
                contentCalendar: { type: Type.STRING },
                promotionalSchedule: { type: Type.STRING },
                influencerStrategy: { type: Type.STRING },
                djOutreachStrategy: { type: Type.STRING },
                radioStrategy: { type: Type.STRING },
                playlistSubmissionStrategy: { type: Type.STRING },
                advertisingRecommendations: { type: Type.STRING },
                budgetBreakdown: { type: Type.STRING },
                keyPerformanceIndicators: { type: Type.STRING },
                riskAssessment: { type: Type.STRING },
                weeklyPerformanceReview: { type: Type.STRING },
                projectionsDisclaimer: { type: Type.STRING },
              },
              required: [
                'overview',
                'marketingObjectives',
                'targetAudience',
                'platformStrategy',
                'contentCalendar',
                'promotionalSchedule',
                'influencerStrategy',
                'djOutreachStrategy',
                'radioStrategy',
                'playlistSubmissionStrategy',
                'advertisingRecommendations',
                'budgetBreakdown',
                'keyPerformanceIndicators',
                'riskAssessment',
                'weeklyPerformanceReview',
                'projectionsDisclaimer',
              ],
            },
          },
        });

        const strategySections = JSON.parse((response.text ?? '{}').trim());
        const latencyMs = Date.now() - started;
        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: session.organizationId || session.uid,
          feature: 'campaign_generate',
          model: 'gemini-4-hydrogen',
          status: 'success',
          latencyMs,
        });
        logStructured('info', 'ai_campaign_generate', {
          uidPrefix: session.uid.slice(0, 8),
          latencyMs,
        });
        res.json({ strategySections, latencyMs, model: 'gemini-4-hydrogen' });
      } catch (err) {
        const safeErr = formatSafeGeminiError(err, 'Failed to generate campaign strategy.');
        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: session.organizationId || session.uid,
          feature: 'campaign_generate',
          model: 'gemini-4-hydrogen',
          status: 'error',
          latencyMs: Date.now() - started,
        });
        res.status(safeErr.status).json({ error: safeErr.message, latencyMs: Date.now() - started });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 3. Viral Content Creation Studio
  // ---------------------------------------------------------------------------
  app.post(
    '/api/ai/content-studio',
    verifyFirebaseAuth,
    aiQuotaMiddleware('content_studio'),
    async (req: AuthenticatedRequest, res: Response) => {
      const started = Date.now();
      const session = req.authSession!;
      try {
        const body = (req.body || {}) as Record<string, unknown>;
        const artistName = sanitizeTextField(body.artistName, 140);
        const songTitle = sanitizeTextField(body.songTitle, 180);
        const genre = sanitizeTextField(body.genre, 120);
        const moodAndStyle = sanitizeTextField(body.moodAndStyle, 800);
        const category = sanitizeTextField(body.category, 100);
        const rawDur = Number(body.durationSeconds);
        const durationSeconds: 15 | 30 | 60 = rawDur === 15 || rawDur === 60 ? rawDur : 30;
        const count = Math.min(Math.max(Number(body.variationsCount) || 3, 1), 4);

        if (!artistName || !category) {
          res.status(400).json({ error: 'Artist name and content category are required.' });
          return;
        }

        const ai = getAiClient();
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `${PROMPT_INJECTION_GUARD_INSTRUCTION}

Create ${count} distinct ${durationSeconds}-second promotional concepts:
${wrapUntrustedBlock('Category', category)}
${wrapUntrustedBlock('Artist', artistName)}
${wrapUntrustedBlock('Song Title', songTitle || 'Latest Release')}
${wrapUntrustedBlock('Genre & Mood', `${genre || 'Afrobeats'} | ${moodAndStyle || 'Energetic'}`)}

CRITICAL RULE: Do NOT describe any concept or audio format as "currently trending" or "viral right now" because no live trend feed is attached to this prompt.`,
          config: {
            systemInstruction:
              'You are a Creative Director at SONICPUSH AI specializing in short-form music storytelling across Lagos, London, Johannesburg, and global diaspora feeds.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  openingHook: { type: Type.STRING },
                  sceneInstructions: { type: Type.STRING },
                  suggestedDuration: { type: Type.NUMBER },
                  onScreenText: { type: Type.STRING },
                  audioPlacement: { type: Type.STRING },
                  caption: { type: Type.STRING },
                  callToAction: { type: Type.STRING },
                  hashtags: { type: Type.STRING },
                },
                required: [
                  'title',
                  'openingHook',
                  'sceneInstructions',
                  'suggestedDuration',
                  'onScreenText',
                  'audioPlacement',
                  'caption',
                  'callToAction',
                  'hashtags',
                ],
              },
            },
          },
        });

        const ideas = JSON.parse((response.text ?? '[]').trim());
        const latencyMs = Date.now() - started;
        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: session.organizationId || session.uid,
          feature: 'content_studio',
          model: 'gemini-4-hydrogen',
          status: 'success',
          latencyMs,
        });
        logStructured('info', 'ai_content_studio', {
          uidPrefix: session.uid.slice(0, 8),
          latencyMs,
        });
        res.json({ ideas, latencyMs, model: 'gemini-4-hydrogen' });
      } catch (err) {
        const safeErr = formatSafeGeminiError(err, 'Failed to generate content concepts.');
        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: session.organizationId || session.uid,
          feature: 'content_studio',
          model: 'gemini-4-hydrogen',
          status: 'error',
          latencyMs: Date.now() - started,
        });
        res.status(safeErr.status).json({ error: safeErr.message, latencyMs: Date.now() - started });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 4. Trend Intelligence (Live Google Search Grounding)
  // ---------------------------------------------------------------------------
  app.post(
    '/api/ai/trends',
    verifyFirebaseAuth,
    aiQuotaMiddleware('trends'),
    async (req: AuthenticatedRequest, res: Response) => {
      const started = Date.now();
      const session = req.authSession!;
      try {
        const body = (req.body || {}) as Record<string, unknown>;
        const market = sanitizeTextField(body.market, 100) || 'Nigeria';
        const platform = sanitizeTextField(body.platform, 80) || 'TikTok';
        const genre = sanitizeTextField(body.genre, 100) || 'Afrobeats';
        const artistContext = sanitizeTextField(body.artistContext, 300);

        const ai = getAiClient();
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `${PROMPT_INJECTION_GUARD_INSTRUCTION}

Research current, verifiable music marketing trends, popular content formats, regional conversations, and creator challenges:
${wrapUntrustedBlock('Target Market / Platform / Genre', `${market} | ${platform} | ${genre}`)}
${artistContext ? wrapUntrustedBlock('Artist Context', artistContext) : ''}

Return ONLY trends you actually observed in Google Search results. Never invent view counts, percentages, or fabricated statistics.
Format the response strictly as a JSON array inside \`\`\`json ... \`\`\` where each object has:
- trendName (string)
- platform (string)
- geographicMarket (string)
- dateObserved (string, e.g., current month/year from source)
- sourceLink (string, real URL from search results)
- relevanceToArtist (string)
- recommendedAction (string)`,
          config: {
            tools: [{ googleSearch: {} }],
          },
        });

        const rawText = response.text ?? '';
        const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const sources = chunks
          .map((c) => c.web)
          .filter((w): w is { uri: string; title?: string } => Boolean(w && w.uri))
          .map((w) => ({ uri: w.uri, title: w.title || w.uri }));

        let parsedTrends: Array<Record<string, string>> = [];
        const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/i);
        const candidateJson = jsonMatch ? jsonMatch[1].trim() : rawText.trim();
        try {
          const parsed = JSON.parse(candidateJson);
          if (Array.isArray(parsed)) {
            parsedTrends = parsed;
          }
        } catch {
          // Return grounded summary markdown alongside citations
        }

        const latencyMs = Date.now() - started;
        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: session.organizationId || session.uid,
          feature: 'trends',
          model: 'gemini-4-hydrogen',
          status: 'success',
          latencyMs,
        });
        logStructured('info', 'ai_trends', { uidPrefix: session.uid.slice(0, 8), latencyMs });
        res.json({
          trends: parsedTrends,
          summaryMarkdown: parsedTrends.length === 0 ? rawText : '',
          sources,
          latencyMs,
          model: 'gemini-4-hydrogen',
        });
      } catch (err) {
        const safeErr = formatSafeGeminiError(err, 'Failed to research live trends.');
        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: session.organizationId || session.uid,
          feature: 'trends',
          model: 'gemini-4-hydrogen',
          status: 'error',
          latencyMs: Date.now() - started,
        });
        res.status(safeErr.status).json({ error: safeErr.message, latencyMs: Date.now() - started });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 5. Outreach Message Drafting
  // ---------------------------------------------------------------------------
  app.post(
    '/api/ai/outreach-draft',
    verifyFirebaseAuth,
    aiQuotaMiddleware('outreach_draft'),
    async (req: AuthenticatedRequest, res: Response) => {
      const started = Date.now();
      const session = req.authSession!;
      try {
        const body = (req.body || {}) as Record<string, unknown>;
        const contactName = sanitizeTextField(body.contactName, 160);
        const contactCategory = sanitizeTextField(body.contactCategory, 120);
        const platform = sanitizeTextField(body.platform, 80);
        const country = sanitizeTextField(body.country, 80);
        const channel = sanitizeTextField(body.channel, 40);
        const artistName = sanitizeTextField(body.artistName, 140);
        const songTitle = sanitizeTextField(body.songTitle, 180);
        const genre = sanitizeTextField(body.genre, 120);
        const streamingLink = sanitizeTextField(body.streamingLink, 1024);
        const deliverableGoal = sanitizeTextField(body.deliverableGoal, 400);

        if (!contactName || !channel || !artistName) {
          res.status(400).json({ error: 'Contact name, channel, and artist name are required.' });
          return;
        }
        if (!['WhatsApp', 'Instagram DM', 'Email'].includes(channel)) {
          res.status(400).json({ error: 'Channel must be WhatsApp, Instagram DM, or Email.' });
          return;
        }

        const ai = getAiClient();
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `${PROMPT_INJECTION_GUARD_INSTRUCTION}

Draft a professional, respectful, culturally authentic outreach message:
${wrapUntrustedBlock('Recipient', `${contactName} (${contactCategory || 'Creator/Media'}, ${platform || 'Social'}, ${country || 'Nigeria'})`)}
- Channel: ${channel}
${wrapUntrustedBlock('Artist & Song', `${artistName} — ${songTitle || 'Upcoming release'} (${genre || 'Afrobeats'})`)}
${wrapUntrustedBlock('Streaming / EPK Link', streamingLink || '[Insert Streaming / EPK Link]')}
${wrapUntrustedBlock('Outreach Goal', deliverableGoal || 'Introduction and listen request')}

STRICT RULE: Never promise guaranteed airplay, coverage, or playlist placement. Do not invent fake metrics.`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                subject: { type: Type.STRING },
                messageBody: { type: Type.STRING },
              },
              required: ['subject', 'messageBody'],
            },
          },
        });

        const draft = JSON.parse((response.text ?? '{}').trim());
        const latencyMs = Date.now() - started;
        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: session.organizationId || session.uid,
          feature: 'outreach_draft',
          model: 'gemini-4-hydrogen',
          status: 'success',
          latencyMs,
        });
        logStructured('info', 'ai_outreach_draft', {
          uidPrefix: session.uid.slice(0, 8),
          latencyMs,
        });
        res.json({
          subject: draft.subject || '',
          messageBody: draft.messageBody || '',
          latencyMs,
          model: 'gemini-4-hydrogen',
        });
      } catch (err) {
        const safeErr = formatSafeGeminiError(err, 'Failed to draft outreach message.');
        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: session.organizationId || session.uid,
          feature: 'outreach_draft',
          model: 'gemini-4-hydrogen',
          status: 'error',
          latencyMs: Date.now() - started,
        });
        res.status(safeErr.status).json({ error: safeErr.message, latencyMs: Date.now() - started });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 6. Central SONICPUSH AI Assistant (Server-Fetched Workspace Context)
  // ---------------------------------------------------------------------------
  app.post(
    '/api/ai/assistant',
    verifyFirebaseAuth,
    aiQuotaMiddleware('assistant'),
    async (req: AuthenticatedRequest, res: Response) => {
      const started = Date.now();
      const session = req.authSession!;
      try {
        const msgCheck = validateAssistantMessages(req.body?.messages);
        if (!msgCheck.valid) {
          res.status(400).json({ error: msgCheck.error || 'Invalid message payload.' });
          return;
        }

        const requestedOrgId = sanitizeTextField(req.body?.organizationId, 128);
        if (requestedOrgId && !session.isSuperAdmin && requestedOrgId !== session.organizationId) {
          logStructured('warn', 'cross_org_ai_query_blocked', {
            uidPrefix: session.uid.slice(0, 8),
          });
          res.status(403).json({
            error: 'Cross-organization workspace queries are not permitted.',
          });
          return;
        }

        const effectiveOrgId = requestedOrgId || session.organizationId;
        const serverWorkspaceSnapshot = await fetchContext({
          idToken: session.idToken,
          uid: session.uid,
          isSuperAdmin: session.isSuperAdmin,
          organizationId: effectiveOrgId,
        });

        const ai = getAiClient();
        const contents = msgCheck.messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [
            {
              text:
                m.role === 'user'
                  ? `<untrusted_user_data label="user_query">\n${m.content}\n</untrusted_user_data>`
                  : m.content,
            },
          ],
        }));

        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents,
          config: {
            systemInstruction: `${PROMPT_INJECTION_GUARD_INSTRUCTION}

You are the central SONICPUSH AI Strategist—combining Music Marketing Strategist, Digital Marketing Manager, Artist Development Consultant, Social Media Strategist, Influencer Campaign Manager, Music Publicist, and Campaign Analyst expertise.

SERVER-VERIFIED WORKSPACE SNAPSHOT (RETRIEVED DIRECTLY FROM FIRESTORE FOR CALLER ${session.role || 'MEMBER'}):
${JSON.stringify(serverWorkspaceSnapshot).slice(0, 12000)}

STRICT INTEGRITY RULES:
1. Reference only real artists, songs, campaigns, tasks, and recorded metrics from the server-verified snapshot above.
2. NEVER invent campaign results, streaming figures, influencer contacts, package prices, or unverified research findings. State clearly if data has not yet been recorded.`,
          },
        });

        const latencyMs = Date.now() - started;
        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: effectiveOrgId || session.uid,
          feature: 'assistant',
          model: 'gemini-4-hydrogen',
          status: 'success',
          latencyMs,
        });
        logStructured('info', 'ai_assistant', { uidPrefix: session.uid.slice(0, 8), latencyMs });
        res.json({
          reply: response.text || 'I could not generate a response for that request.',
          contextRecordCounts: {
            artists: serverWorkspaceSnapshot.artists.length,
            songs: serverWorkspaceSnapshot.songs.length,
            campaigns: serverWorkspaceSnapshot.campaigns.length,
          },
          latencyMs,
          model: 'gemini-4-hydrogen',
        });
      } catch (err) {
        const safeErr = formatSafeGeminiError(err, 'Failed to query SONICPUSH AI Assistant.');
        void rateLimiter.recordUsageLog({
          uid: session.uid,
          organizationId: session.organizationId || session.uid,
          feature: 'assistant',
          model: 'gemini-4-hydrogen',
          status: 'error',
          latencyMs: Date.now() - started,
        });
        res.status(safeErr.status).json({ error: safeErr.message, latencyMs: Date.now() - started });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 7. Payment Verification, Firestore Ledger, Retries & Raw-Body Webhooks
  // ---------------------------------------------------------------------------
  app.get('/api/payments/ledger', verifyFirebaseAuth, async (req: AuthenticatedRequest, res: Response) => {
    const session = req.authSession!;
    const requestedOrgId = sanitizeTextField(req.query.organizationId, 128);
    if (requestedOrgId && !session.isSuperAdmin && requestedOrgId !== session.organizationId) {
      res.status(403).json({ error: 'Cannot view payment ledger for another organization.' });
      return;
    }
    const targetOrg = requestedOrgId || session.organizationId;
    if (!targetOrg) {
      res.json({ bindings: [], webhooks: [] });
      return;
    }

    try {
      const records = await paymentRepo.listOrganizationRecords(targetOrg);
      res.json(records);
    } catch (err) {
      if (isPermissionOrCredentialError(err)) {
        res.json({
          bindings: [],
          webhooks: [],
          diagnosticNote:
            'Shared Firestore payment ledger requires Firebase Admin IAM permissions (unavailable on un-upgraded Starter Tier).',
        });
        return;
      }
      res.status(500).json({ error: 'Unable to retrieve payment ledger from Firestore.' });
    }
  });

  app.post(
    '/api/payments/verify',
    verifyFirebaseAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const session = req.authSession!;
      try {
        const body = (req.body || {}) as Record<string, unknown>;
        const invoiceId = sanitizeTextField(body.invoiceId, 128);
        const provider = sanitizeTextField(body.provider, 32) as PaymentProvider;
        const reference = sanitizeTextField(body.reference, 160);
        const transactionId = sanitizeTextField(body.transactionId, 120);

        if (!invoiceId || !/^[a-zA-Z0-9_-]+$/.test(invoiceId)) {
          res.status(400).json({ error: 'A valid invoiceId is required.' });
          return;
        }
        if (
          provider !== 'paystack' &&
          provider !== 'flutterwave' &&
          provider !== 'stripe' &&
          provider !== 'manual_transfer'
        ) {
          res.status(400).json({ error: 'Unsupported payment provider.' });
          return;
        }
        if (!reference) {
          res.status(400).json({ error: 'Gateway transaction reference is required.' });
          return;
        }

        // Retrieve authoritative invoice directly from Firestore
        let invoice = await adminDb.getDoc('invoices', invoiceId).catch(() => null);
        if (!invoice) {
          invoice = await getDoc('invoices', invoiceId, session.idToken);
        }
        if (!invoice) {
          res.status(404).json({ error: 'Invoice not found or access denied.' });
          return;
        }

        const invoiceOrgId = typeof invoice.organizationId === 'string' ? invoice.organizationId : '';
        const assignedUsers = Array.isArray(invoice.assignedUserIds)
          ? (invoice.assignedUserIds as string[])
          : [];
        const callerAuthorized =
          session.isSuperAdmin ||
          invoice.ownerId === session.uid ||
          assignedUsers.includes(session.uid) ||
          (Boolean(session.organizationId) && session.organizationId === invoiceOrgId);

        if (!callerAuthorized || !invoiceOrgId) {
          res.status(403).json({ error: 'Not authorized to verify payment for this invoice.' });
          return;
        }

        const invoiceStatus = typeof invoice.status === 'string' ? invoice.status : '';
        if (invoiceStatus === 'paid' || invoiceStatus === 'void' || invoiceStatus === 'refunded') {
          res.status(409).json({
            error: `Invoice is already in terminal state (${invoiceStatus}).`,
          });
          return;
        }

        const invoiceCurrency = (
          typeof invoice.currency === 'string' ? invoice.currency : 'NGN'
        ) as CurrencyCode;
        const invoiceAmount = Number(invoice.amount);

        const result = await paymentRepo.verifyAndBindReference({
          provider,
          reference,
          transactionId: transactionId || undefined,
          invoiceId,
          invoiceOrganizationId: invoiceOrgId,
          invoiceCurrency,
          invoiceAmount,
          isSuperAdmin: session.isSuperAdmin,
        });

        logStructured('info', 'payment_verify_checked', {
          provider,
          verificationStatus: result.verificationStatus,
          verified: result.verified,
          invoiceReconciled: result.invoiceReconciled,
        });

        res.json({
          verified: result.verified,
          verificationStatus: result.verificationStatus,
          invoiceId,
          organizationId: invoiceOrgId,
          currency: invoiceCurrency,
          amount: invoiceAmount,
          providerTransactionId: result.providerTransactionId || '',
          serverAttestation: result.serverAttestation,
          invoiceReconciled: result.invoiceReconciled,
          message: result.message,
        });
      } catch (err) {
        if (err instanceof ReferenceConflictError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (isPermissionOrCredentialError(err)) {
          res.status(503).json({
            verified: false,
            verificationStatus: 'failed',
            error:
              'Shared Firestore payment ledger requires Firebase Admin IAM permissions in this environment.',
          });
          return;
        }
        const msg = err instanceof Error ? err.message : 'Payment verification failed.';
        res.status(msg.includes('PERMISSION_DENIED') ? 403 : 500).json({
          verified: false,
          verificationStatus: 'failed',
          error: msg.includes('PERMISSION_DENIED')
            ? 'Insufficient permissions to verify this invoice.'
            : 'Unable to complete server payment verification.',
        });
      }
    }
  );

  app.post(
    '/api/payments/reconcile',
    verifyFirebaseAuth,
    requireRole(['SUPER_ADMIN']),
    async (req: AuthenticatedRequest, res: Response) => {
      const invoiceId = sanitizeTextField(req.body?.invoiceId, 128);
      const paymentId = sanitizeTextField(req.body?.paymentId, 128);
      const provider = sanitizeTextField(req.body?.provider, 32) as PaymentProvider;
      const reference = sanitizeTextField(req.body?.reference, 160);

      if (!invoiceId || !provider || !reference) {
        res.status(400).json({ error: 'invoiceId, provider, and reference are required.' });
        return;
      }

      try {
        const reconciled = await paymentRepo.reconcilePayment({
          invoiceId,
          paymentId: paymentId || undefined,
          provider,
          reference,
        });
        res.json({ ok: true, ...reconciled });
      } catch (err) {
        if (err instanceof ReferenceConflictError) {
          res.status(409).json({ error: err.message });
          return;
        }
        const msg = err instanceof Error ? err.message : '';
        if (msg === 'BINDING_NOT_FOUND' || msg === 'INVOICE_NOT_FOUND') {
          res.status(404).json({
            error: 'No matching server verification or webhook record found for this reference.',
          });
          return;
        }
        if (msg.startsWith('INVALID_STATE:')) {
          const state = msg.split(':')[1] || 'pending';
          res.status(409).json({
            error: `Reference is in "${state}" state and cannot be reconciled as settled.`,
          });
          return;
        }
        res.status(500).json({ error: 'Failed to reconcile payment state into Firestore.' });
      }
    }
  );

  app.post(
    '/api/payments/webhooks/:eventDocId/retry',
    verifyFirebaseAuth,
    requireRole(['SUPER_ADMIN']),
    async (req: AuthenticatedRequest, res: Response) => {
      const eventDocId = sanitizeTextField(req.params.eventDocId, 128);
      if (!eventDocId || !/^[a-zA-Z0-9_-]+$/.test(eventDocId)) {
        res.status(400).json({ error: 'Invalid webhook event identifier.' });
        return;
      }

      try {
        const result = await paymentRepo.retryPendingWebhook(eventDocId);
        if (result.retryable) {
          res.status(500).json({
            ok: false,
            ...result,
            error: 'Reconciliation retry failed transiently.',
          });
          return;
        }
        res.json({ ok: true, ...result });
      } catch (err) {
        if (err instanceof Error && err.message === 'WEBHOOK_EVENT_NOT_FOUND') {
          res.status(404).json({ error: 'Webhook event record not found.' });
          return;
        }
        res.status(500).json({ error: 'Failed to retry webhook reconciliation.' });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Webhooks (Raw Body + Official Signature + Authoritative API Verification + Firestore Atomic Tx)
  // ---------------------------------------------------------------------------
  app.post('/api/payments/webhook/:provider', async (req: AuthenticatedRequest, res: Response) => {
    const providerParam = sanitizeTextField(req.params.provider, 32) as PaymentProvider;
    const rawBody = req.rawBody;

    if (!rawBody || rawBody.length === 0) {
      res
        .status(400)
        .json({ error: 'Raw request body is required for webhook signature verification.' });
      return;
    }

    if (providerParam === 'paystack') {
      const secret = process.env.PAYSTACK_SECRET_KEY;
      if (!secret) {
        res.status(501).json({
          received: false,
          status: 'awaiting_provider_integration',
          message: 'PAYSTACK_SECRET_KEY is not configured.',
        });
        return;
      }
      const sig = req.headers['x-paystack-signature'] as string | undefined;
      if (!verifyPaystackWebhookSignature(rawBody, sig, secret)) {
        logStructured('warn', 'webhook_invalid_signature', { provider: 'paystack' });
        res.status(401).json({ error: 'Invalid Paystack webhook signature.' });
        return;
      }

      const normalized = normalizePaystackWebhookPayload(
        (req.body || {}) as Record<string, unknown>
      );
      if (!normalized) {
        res.status(400).json({ error: 'Malformed Paystack webhook payload.' });
        return;
      }

      const result = await paymentRepo.processWebhook({ provider: 'paystack', normalized });
      if (result.retryable) {
        res.status(500).json(result);
        return;
      }
      res.status(200).json(result);
      return;
    }

    if (providerParam === 'flutterwave') {
      const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
      if (!secretHash) {
        res.status(501).json({
          received: false,
          status: 'awaiting_provider_integration',
          message: 'FLUTTERWAVE_SECRET_HASH is not configured.',
        });
        return;
      }
      const valid = verifyFlutterwaveWebhookSignature({
        rawBody,
        verifHashHeader: req.headers['verif-hash'] as string | undefined,
        flutterwaveSignatureHeader: req.headers['flutterwave-signature'] as string | undefined,
        secretHash,
      });
      if (!valid) {
        logStructured('warn', 'webhook_invalid_signature', { provider: 'flutterwave' });
        res.status(401).json({ error: 'Invalid Flutterwave webhook signature.' });
        return;
      }

      const normalized = normalizeFlutterwaveWebhookPayload(
        (req.body || {}) as Record<string, unknown>
      );
      if (!normalized) {
        res.status(400).json({ error: 'Malformed Flutterwave webhook payload.' });
        return;
      }

      const result = await paymentRepo.processWebhook({ provider: 'flutterwave', normalized });
      if (result.retryable) {
        res.status(500).json(result);
        return;
      }
      res.status(200).json(result);
      return;
    }

    if (providerParam === 'stripe') {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        res.status(501).json({
          received: false,
          status: 'awaiting_provider_integration',
          message: 'STRIPE_WEBHOOK_SECRET is not configured.',
        });
        return;
      }

      let stripeEvent;
      try {
        stripeEvent = constructVerifiedStripeWebhookEvent(
          rawBody,
          req.headers['stripe-signature'] as string | undefined,
          webhookSecret
        );
      } catch {
        logStructured('warn', 'webhook_invalid_signature', { provider: 'stripe' });
        res.status(401).json({ error: 'Invalid Stripe webhook signature.' });
        return;
      }

      const normalized = normalizeStripeWebhookEvent(stripeEvent);
      const result = await paymentRepo.processWebhook({ provider: 'stripe', normalized });
      if (result.retryable) {
        res.status(500).json(result);
        return;
      }
      res.status(200).json(result);
      return;
    }

    res.status(400).json({ error: `Unsupported webhook provider: ${providerParam}` });
  });

  // Global safe JSON error handler (never expose stack traces to clients)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logStructured('error', 'unhandled_server_error', {
      message: sanitizeErrorMessage(err, 'Unknown internal error'),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'An internal server error occurred.' });
    }
  });

  return app;
}
