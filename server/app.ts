import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { GoogleGenAI, Type } from '@google/genai';
import {
  createAuthMiddleware,
  requireRole,
  resolveServerSession,
  verifyFirebaseIdToken,
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
import { SlidingWindowQuotaLimiter } from './rateLimit.ts';
import {
  constructVerifiedStripeWebhookEvent,
  normalizeFlutterwaveWebhookPayload,
  normalizePaystackWebhookPayload,
  normalizeStripeWebhookEvent,
  PaymentLedgerStore,
  signPaymentAttestation,
  toMinorUnits,
  verifyFlutterwaveWebhookSignature,
  verifyFlutterwaveWithProvider,
  verifyPaystackWebhookSignature,
  verifyPaystackWithProvider,
  verifyStripeWithProvider,
  type CurrencyCode,
  type FetchLike,
  type PaymentProvider,
} from './payments.ts';

export interface SonicPushAppDeps {
  tokenVerifier?: TokenVerifierFn;
  sessionResolver?: SessionResolverFn;
  rateLimiter?: SlidingWindowQuotaLimiter;
  paymentLedger?: PaymentLedgerStore;
  fetchImpl?: FetchLike;
  getDoc?: typeof getFirestoreDoc;
  runQuery?: typeof runFirestoreQuery;
  patchDoc?: typeof patchFirestoreDoc;
  fetchWorkspaceContext?: typeof fetchAuthorizedWorkspaceContext;
  getGeminiClient?: () => GoogleGenAI;
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

function logSecurityEvent(event: string, meta: Record<string, string | number | boolean>): void {
  // Never log tokens, lyrics, emails, or provider secrets
  console.info(JSON.stringify({ ts: new Date().toISOString(), event, ...meta }));
}

export function createSonicPushApp(deps: SonicPushAppDeps = {}): Express {
  const app = express();
  const verifyFirebaseAuth = createAuthMiddleware(
    deps.tokenVerifier ?? verifyFirebaseIdToken,
    deps.sessionResolver ?? resolveServerSession
  );
  const rateLimiter = deps.rateLimiter ?? new SlidingWindowQuotaLimiter();
  const ledger = deps.paymentLedger ?? new PaymentLedgerStore();
  const getDoc = deps.getDoc ?? getFirestoreDoc;
  const runQuery = deps.runQuery ?? runFirestoreQuery;
  const patchDoc = deps.patchDoc ?? patchFirestoreDoc;
  const fetchContext = deps.fetchWorkspaceContext ?? fetchAuthorizedWorkspaceContext;
  const getAiClient = deps.getGeminiClient ?? defaultGetGeminiClient;

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

  function aiQuotaMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const uid = req.authSession?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const decision = rateLimiter.checkAndConsume(uid);
    res.setHeader('X-RateLimit-Limit', String(decision.limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.status(429).json({
        error: decision.reason || 'Rate limit exceeded. Please retry shortly.',
        retryAfterSeconds: decision.retryAfterSeconds,
      });
      return;
    }
    next();
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
  // Health Check
  // ---------------------------------------------------------------------------
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'SONICPUSH AI', timestamp: new Date().toISOString() });
  });

  // ---------------------------------------------------------------------------
  // Auth Session & Super Admin Governance (No Client Email Trust)
  // ---------------------------------------------------------------------------
  app.get('/api/auth/session', verifyFirebaseAuth, (req: AuthenticatedRequest, res: Response) => {
    const s = req.authSession!;
    res.json({
      uid: s.uid,
      email: s.email,
      emailVerified: s.emailVerified,
      role: s.role,
      isSuperAdmin: s.isSuperAdmin,
      isBootstrapAdmin: s.isBootstrapAdmin,
      onboardingCompleted: s.onboardingCompleted,
      organizationId: s.organizationId,
      capabilities: s.capabilities,
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
        logSecurityEvent('role_escalation_blocked', { uidPrefix: s.uid.slice(0, 8) });
        res.status(403).json({
          error: 'Only authorized platform administrators may hold the SUPER_ADMIN role.',
        });
        return;
      }
      res.json({
        approvedRole: s.isBootstrapAdmin && requestedRole === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : requestedRole,
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
        const targetDoc = await getDoc('users', targetUid, session.idToken);
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

        await patchDoc(
          'users',
          targetUid,
          { role: nextRole, updatedAt: new Date().toISOString() },
          session.idToken
        );
        logSecurityEvent('admin_role_updated', {
          actorPrefix: session.uid.slice(0, 8),
          targetPrefix: targetUid.slice(0, 8),
          nextRole,
        });
        res.json({ ok: true, targetUid, role: nextRole });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unable to update user role.';
        res.status(msg.includes('PERMISSION_DENIED') ? 403 : 500).json({
          error: 'Failed to update user role safely.',
        });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 1. Song Intelligence Engine (Auth + Quota + Binary Signature + AI)
  // ---------------------------------------------------------------------------
  app.post(
    '/api/ai/song-intelligence',
    verifyFirebaseAuth,
    aiQuotaMiddleware,
    handleAudioUploadMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      const started = Date.now();
      const session = req.authSession!;
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
          res.status(400).json({ error: 'Song title is required.' });
          return;
        }
        if (requestedOrgId && !session.isSuperAdmin && requestedOrgId !== session.organizationId) {
          res.status(403).json({ error: 'Cross-organization upload rejected.' });
          return;
        }

        const effectiveOrgId = requestedOrgId || session.organizationId || session.uid;
        const file = req.file;
        let audioProcessed = false;
        let audioDescriptor: {
          storageObjectPath: string;
          safeFilename: string;
          retentionExpiresAt: string;
          detectedFormat: string;
          canonicalMimeType: string;
        } | null = null;

        const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> =
          [];

        if (file) {
          const sigCheck = validateAudioUpload(file.buffer, file.mimetype, file.originalname);
          if (!sigCheck.valid || !sigCheck.detectedFormat || !sigCheck.canonicalMimeType || !sigCheck.extension) {
            // Release buffer immediately
            file.buffer.fill(0);
            res.status(400).json({ error: sigCheck.error || 'Invalid audio file signature.' });
            return;
          }

          const storageMeta = generateSafeAudioStorageDescriptor(effectiveOrgId, sigCheck.extension);
          audioDescriptor = {
            ...storageMeta,
            detectedFormat: sigCheck.detectedFormat,
            canonicalMimeType: sigCheck.canonicalMimeType,
          };

          parts.push({
            inlineData: {
              mimeType: sigCheck.canonicalMimeType,
              data: file.buffer.toString('base64'),
            },
          });
          audioProcessed = true;
          // Clear buffer from memory once base64 encoded
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
        logSecurityEvent('ai_song_intelligence', {
          uidPrefix: session.uid.slice(0, 8),
          audioProcessed,
          latencyMs,
        });
        res.json({
          audioProcessed,
          audioFileName: audioDescriptor?.safeFilename || '',
          audioStoragePath: audioDescriptor?.storageObjectPath || '',
          audioMimeType: audioDescriptor?.canonicalMimeType || '',
          audioSignatureFormat: audioDescriptor?.detectedFormat || '',
          audioRetentionExpiresAt: audioDescriptor?.retentionExpiresAt || '',
          verifiedObservations: parsed.verifiedObservations || [],
          aiHypotheses: parsed.aiHypotheses,
          latencyMs,
          model: 'gemini-4-hydrogen',
        });
      } catch (err) {
        if (req.file?.buffer) {
          req.file.buffer.fill(0);
        }
        const safeErr = formatSafeGeminiError(err, 'Failed to analyze song release.');
        logSecurityEvent('ai_song_intelligence_error', {
          uidPrefix: session.uid.slice(0, 8),
          status: safeErr.status,
          latencyMs: Date.now() - started,
        });
        res.status(safeErr.status).json({ error: safeErr.message, latencyMs: Date.now() - started });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 2. AI Music Campaign Manager
  // ---------------------------------------------------------------------------
  app.post(
    '/api/ai/campaign-generate',
    verifyFirebaseAuth,
    aiQuotaMiddleware,
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
        const durationDays = Math.min(365, Math.max(1, Math.round(Number(body.durationDays) || 30)));
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
        logSecurityEvent('ai_campaign_generate', { uidPrefix: session.uid.slice(0, 8), latencyMs });
        res.json({ strategySections, latencyMs, model: 'gemini-4-hydrogen' });
      } catch (err) {
        const safeErr = formatSafeGeminiError(err, 'Failed to generate campaign strategy.');
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
    aiQuotaMiddleware,
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
        logSecurityEvent('ai_content_studio', { uidPrefix: session.uid.slice(0, 8), latencyMs });
        res.json({ ideas, latencyMs, model: 'gemini-4-hydrogen' });
      } catch (err) {
        const safeErr = formatSafeGeminiError(err, 'Failed to generate content concepts.');
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
    aiQuotaMiddleware,
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
        logSecurityEvent('ai_trends', { uidPrefix: session.uid.slice(0, 8), latencyMs });
        res.json({
          trends: parsedTrends,
          summaryMarkdown: parsedTrends.length === 0 ? rawText : '',
          sources,
          latencyMs,
          model: 'gemini-4-hydrogen',
        });
      } catch (err) {
        const safeErr = formatSafeGeminiError(err, 'Failed to research live trends.');
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
    aiQuotaMiddleware,
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
        logSecurityEvent('ai_outreach_draft', { uidPrefix: session.uid.slice(0, 8), latencyMs });
        res.json({
          subject: draft.subject || '',
          messageBody: draft.messageBody || '',
          latencyMs,
          model: 'gemini-4-hydrogen',
        });
      } catch (err) {
        const safeErr = formatSafeGeminiError(err, 'Failed to draft outreach message.');
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
    aiQuotaMiddleware,
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
          logSecurityEvent('cross_org_ai_query_blocked', {
            uidPrefix: session.uid.slice(0, 8),
          });
          res.status(403).json({
            error: 'Cross-organization workspace queries are not permitted.',
          });
          return;
        }

        const effectiveOrgId = requestedOrgId || session.organizationId;
        // NEVER trust browser-submitted workspaceContext; retrieve verified records server-side
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
        logSecurityEvent('ai_assistant', { uidPrefix: session.uid.slice(0, 8), latencyMs });
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
        res.status(safeErr.status).json({ error: safeErr.message, latencyMs: Date.now() - started });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 7. Payment Verification, Ledger & Raw-Body Webhooks
  // ---------------------------------------------------------------------------
  app.get('/api/payments/ledger', verifyFirebaseAuth, (req: AuthenticatedRequest, res: Response) => {
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
    res.json(ledger.listOrganizationRecords(targetOrg));
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

        // Retrieve authoritative invoice directly from Firestore via caller's ID token
        const invoice = await getDoc('invoices', invoiceId, session.idToken);
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

        const conflict = ledger.checkReferenceConflict(provider, reference, invoiceId, invoiceOrgId);
        if (conflict) {
          res.status(409).json({ error: conflict });
          return;
        }

        // Also check Firestore payments collection for cross-invoice / cross-org reference reuse
        const existingFirestorePayments = await runQuery(
          'payments',
          session.idToken,
          [{ field: 'reference', op: 'EQUAL', value: reference }],
          5
        ).catch(() => []);

        for (const p of existingFirestorePayments) {
          if (p.provider === provider && (p.invoiceId !== invoiceId || p.organizationId !== invoiceOrgId)) {
            res.status(409).json({
              error: 'Payment reference already exists on another invoice or organization.',
            });
            return;
          }
        }

        const invoiceCurrency = (typeof invoice.currency === 'string' ? invoice.currency : 'NGN') as CurrencyCode;
        const invoiceAmount = Number(invoice.amount);
        const expectedMinor = toMinorUnits(invoiceAmount, invoiceCurrency);
        if (expectedMinor <= 0) {
          res.status(400).json({ error: 'Invoice amount must be greater than zero to verify payment.' });
          return;
        }

        let result: {
          verified: boolean;
          verificationStatus:
            | 'pending'
            | 'awaiting_provider_integration'
            | 'verified'
            | 'failed'
            | 'refunded'
            | 'disputed';
          providerTransactionId?: string;
          message: string;
        };

        if (provider === 'paystack') {
          result = await verifyPaystackWithProvider({
            reference,
            expectedAmountMinor: expectedMinor,
            expectedCurrency: invoiceCurrency,
            invoiceId,
            fetchImpl: deps.fetchImpl,
          });
        } else if (provider === 'flutterwave') {
          result = await verifyFlutterwaveWithProvider({
            reference,
            transactionId: transactionId || undefined,
            expectedAmountMinor: expectedMinor,
            expectedCurrency: invoiceCurrency,
            invoiceId,
            fetchImpl: deps.fetchImpl,
          });
        } else if (provider === 'stripe') {
          result = await verifyStripeWithProvider({
            reference,
            expectedAmountMinor: expectedMinor,
            expectedCurrency: invoiceCurrency,
            invoiceId,
          });
        } else {
          result = {
            verified: false,
            verificationStatus: 'pending',
            message:
              'Manual bank transfer logged as pending. Only an authorized administrator can reconcile manual transfers.',
          };
        }

        const nowIso = new Date().toISOString();
        ledger.upsertReferenceBinding({
          bindingKey: `${provider}:${reference}`,
          provider,
          reference,
          invoiceId,
          organizationId: invoiceOrgId,
          currency: invoiceCurrency,
          expectedMinor,
          verificationStatus: result.verificationStatus,
          providerTransactionId: result.providerTransactionId,
          updatedAt: nowIso,
        });

        const serverAttestation = signPaymentAttestation({
          invoiceId,
          organizationId: invoiceOrgId,
          provider,
          reference,
          amountMinor: expectedMinor,
          currency: invoiceCurrency,
          verificationStatus: result.verificationStatus,
        });

        // If verified & caller is SUPER_ADMIN, synchronize authoritative invoice status server-side
        let invoiceReconciled = false;
        if (result.verified && session.isSuperAdmin) {
          try {
            await patchDoc(
              'invoices',
              invoiceId,
              {
                status: 'paid',
                verifiedPaymentRef: reference,
                paidAt: nowIso,
                updatedAt: nowIso,
              },
              session.idToken
            );
            invoiceReconciled = true;
          } catch {
            invoiceReconciled = false;
          }
        }

        logSecurityEvent('payment_verify_checked', {
          provider,
          verificationStatus: result.verificationStatus,
          verified: result.verified,
          invoiceReconciled,
        });

        res.json({
          verified: result.verified,
          verificationStatus: result.verificationStatus,
          invoiceId,
          organizationId: invoiceOrgId,
          currency: invoiceCurrency,
          amount: invoiceAmount,
          providerTransactionId: result.providerTransactionId || '',
          serverAttestation,
          invoiceReconciled,
          message: result.message,
        });
      } catch (err) {
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
      const session = req.authSession!;
      const invoiceId = sanitizeTextField(req.body?.invoiceId, 128);
      const paymentId = sanitizeTextField(req.body?.paymentId, 128);
      const provider = sanitizeTextField(req.body?.provider, 32) as PaymentProvider;
      const reference = sanitizeTextField(req.body?.reference, 160);

      if (!invoiceId || !provider || !reference) {
        res.status(400).json({ error: 'invoiceId, provider, and reference are required.' });
        return;
      }

      const binding = ledger.getReferenceBinding(provider, reference);
      if (!binding || binding.invoiceId !== invoiceId) {
        res.status(404).json({ error: 'No matching server verification or webhook record found for this reference.' });
        return;
      }
      if (
        binding.verificationStatus !== 'verified' &&
        binding.verificationStatus !== 'refunded' &&
        binding.verificationStatus !== 'disputed'
      ) {
        res.status(409).json({
          error: `Reference is in "${binding.verificationStatus}" state and cannot be reconciled as settled.`,
        });
        return;
      }

      const nowIso = new Date().toISOString();
      const targetInvoiceStatus =
        binding.verificationStatus === 'verified'
          ? 'paid'
          : binding.verificationStatus === 'refunded'
          ? 'refunded'
          : 'disputed';

      try {
        await patchDoc(
          'invoices',
          invoiceId,
          {
            status: targetInvoiceStatus,
            verifiedPaymentRef: reference,
            ...(targetInvoiceStatus === 'paid' ? { paidAt: nowIso } : {}),
            updatedAt: nowIso,
          },
          session.idToken
        );

        if (paymentId) {
          await patchDoc(
            'payments',
            paymentId,
            {
              verificationStatus: binding.verificationStatus,
              verificationSource: 'server_api',
              verifiedAt: nowIso,
              ...(binding.providerTransactionId
                ? { providerTransactionId: binding.providerTransactionId }
                : {}),
              updatedAt: nowIso,
            },
            session.idToken
          );
        }

        res.json({
          ok: true,
          invoiceId,
          invoiceStatus: targetInvoiceStatus,
          verificationStatus: binding.verificationStatus,
        });
      } catch {
        res.status(500).json({ error: 'Failed to reconcile payment state into Firestore.' });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Webhooks (Raw Body Preserved + Official Signature Verification + Idempotency)
  // ---------------------------------------------------------------------------
  app.post('/api/payments/webhook/:provider', (req: AuthenticatedRequest, res: Response) => {
    const providerParam = sanitizeTextField(req.params.provider, 32) as PaymentProvider;
    const rawBody = req.rawBody;

    if (!rawBody || rawBody.length === 0) {
      res.status(400).json({ error: 'Raw request body is required for webhook signature verification.' });
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
        logSecurityEvent('webhook_invalid_signature', { provider: 'paystack' });
        res.status(401).json({ error: 'Invalid Paystack webhook signature.' });
        return;
      }

      const normalized = normalizePaystackWebhookPayload((req.body || {}) as Record<string, unknown>);
      if (!normalized) {
        res.status(400).json({ error: 'Malformed Paystack webhook payload.' });
        return;
      }

      const existingEvent = ledger.hasProcessedWebhook('paystack', normalized.eventId);
      if (existingEvent) {
        res.status(200).json({
          received: true,
          duplicate: true,
          eventId: normalized.eventId,
          outcome: existingEvent.outcome,
        });
        return;
      }

      const existingBinding = ledger.getReferenceBinding('paystack', normalized.reference);
      let finalOutcome = normalized.outcome;
      let note = 'Processed verified Paystack webhook.';

      if (existingBinding) {
        if (
          normalized.amountMinor !== undefined &&
          normalized.amountMinor !== existingBinding.expectedMinor
        ) {
          finalOutcome = 'failed';
          note = 'Webhook amount mismatch against bound invoice.';
        } else if (
          normalized.currency &&
          normalized.currency !== existingBinding.currency.toUpperCase()
        ) {
          finalOutcome = 'failed';
          note = 'Webhook currency mismatch against bound invoice.';
        } else {
          ledger.upsertReferenceBinding({
            ...existingBinding,
            verificationStatus: finalOutcome,
            providerTransactionId:
              normalized.providerTransactionId || existingBinding.providerTransactionId,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      ledger.recordWebhookEvent({
        idempotencyKey: `paystack:${normalized.eventId}`,
        provider: 'paystack',
        eventId: normalized.eventId,
        eventType: normalized.eventType,
        reference: normalized.reference,
        invoiceId: normalized.invoiceId || existingBinding?.invoiceId,
        organizationId: normalized.organizationId || existingBinding?.organizationId,
        outcome: finalOutcome,
        processedAt: new Date().toISOString(),
        note,
      });

      res.status(200).json({
        received: true,
        duplicate: false,
        provider: 'paystack',
        eventId: normalized.eventId,
        outcome: finalOutcome,
      });
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
        logSecurityEvent('webhook_invalid_signature', { provider: 'flutterwave' });
        res.status(401).json({ error: 'Invalid Flutterwave webhook signature.' });
        return;
      }

      const normalized = normalizeFlutterwaveWebhookPayload((req.body || {}) as Record<string, unknown>);
      if (!normalized) {
        res.status(400).json({ error: 'Malformed Flutterwave webhook payload.' });
        return;
      }

      const existingEvent = ledger.hasProcessedWebhook('flutterwave', normalized.eventId);
      if (existingEvent) {
        res.status(200).json({
          received: true,
          duplicate: true,
          eventId: normalized.eventId,
          outcome: existingEvent.outcome,
        });
        return;
      }

      const existingBinding = ledger.getReferenceBinding('flutterwave', normalized.reference);
      let finalOutcome = normalized.outcome;
      let note = 'Processed verified Flutterwave webhook.';
      if (existingBinding) {
        if (
          normalized.amountMinor !== undefined &&
          normalized.amountMinor !== existingBinding.expectedMinor
        ) {
          finalOutcome = 'failed';
          note = 'Webhook amount mismatch against bound invoice.';
        } else if (
          normalized.currency &&
          normalized.currency !== existingBinding.currency.toUpperCase()
        ) {
          finalOutcome = 'failed';
          note = 'Webhook currency mismatch against bound invoice.';
        } else {
          ledger.upsertReferenceBinding({
            ...existingBinding,
            verificationStatus: finalOutcome,
            providerTransactionId:
              normalized.providerTransactionId || existingBinding.providerTransactionId,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      ledger.recordWebhookEvent({
        idempotencyKey: `flutterwave:${normalized.eventId}`,
        provider: 'flutterwave',
        eventId: normalized.eventId,
        eventType: normalized.eventType,
        reference: normalized.reference,
        invoiceId: existingBinding?.invoiceId,
        organizationId: existingBinding?.organizationId,
        outcome: finalOutcome,
        processedAt: new Date().toISOString(),
        note,
      });

      res.status(200).json({
        received: true,
        duplicate: false,
        provider: 'flutterwave',
        eventId: normalized.eventId,
        outcome: finalOutcome,
      });
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
        logSecurityEvent('webhook_invalid_signature', { provider: 'stripe' });
        res.status(401).json({ error: 'Invalid Stripe webhook signature.' });
        return;
      }

      const normalized = normalizeStripeWebhookEvent(stripeEvent);
      const existingEvent = ledger.hasProcessedWebhook('stripe', normalized.eventId);
      if (existingEvent) {
        res.status(200).json({
          received: true,
          duplicate: true,
          eventId: normalized.eventId,
          outcome: existingEvent.outcome,
        });
        return;
      }

      const existingBinding = normalized.reference
        ? ledger.getReferenceBinding('stripe', normalized.reference)
        : null;
      let finalOutcome = normalized.outcome;
      let note = `Processed Stripe ${normalized.eventType} event.`;
      if (existingBinding) {
        if (
          finalOutcome === 'verified' &&
          normalized.amountMinor !== undefined &&
          normalized.amountMinor !== existingBinding.expectedMinor
        ) {
          finalOutcome = 'failed';
          note = 'Stripe webhook amount mismatch against bound invoice.';
        } else {
          ledger.upsertReferenceBinding({
            ...existingBinding,
            verificationStatus: finalOutcome,
            providerTransactionId:
              normalized.providerTransactionId || existingBinding.providerTransactionId,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      ledger.recordWebhookEvent({
        idempotencyKey: `stripe:${normalized.eventId}`,
        provider: 'stripe',
        eventId: normalized.eventId,
        eventType: normalized.eventType,
        reference: normalized.reference,
        invoiceId: normalized.invoiceId || existingBinding?.invoiceId,
        organizationId: normalized.organizationId || existingBinding?.organizationId,
        outcome: finalOutcome,
        processedAt: new Date().toISOString(),
        note,
      });

      res.status(200).json({
        received: true,
        duplicate: false,
        provider: 'stripe',
        eventId: normalized.eventId,
        outcome: finalOutcome,
      });
      return;
    }

    res.status(400).json({ error: `Unsupported webhook provider: ${providerParam}` });
  });

  // Global safe JSON error handler (never expose stack traces to clients)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled server error:', err instanceof Error ? err.message : 'Unknown error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'An internal server error occurred.' });
    }
  });

  return app;
}
