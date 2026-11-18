import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { GoogleGenAI, Type } from '@google/genai';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Read firebase-applet-config.json without static JSON import issues across Node/tsx
const firebaseConfigPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf-8')) as {
  apiKey: string;
  projectId: string;
};

function getGeminiClient(): GoogleGenAI {
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

interface VerifiedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
}

interface AuthenticatedRequest extends Request {
  verifiedUser?: VerifiedUser;
}

async function verifyFirebaseAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Missing Bearer token.' });
    return;
  }
  const idToken = header.slice('Bearer '.length).trim();
  if (!idToken) {
    res.status(401).json({ error: 'Authentication required. Empty token.' });
    return;
  }

  try {
    const lookupRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseConfig.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!lookupRes.ok) {
      res.status(401).json({ error: 'Invalid or expired authentication session.' });
      return;
    }
    const data = (await lookupRes.json()) as {
      users?: Array<{ localId: string; email?: string; emailVerified?: boolean }>;
    };
    const user = data.users?.[0];
    if (!user || !user.localId) {
      res.status(401).json({ error: 'Unable to verify Firebase account.' });
      return;
    }
    req.verifiedUser = {
      uid: user.localId,
      email: user.email || '',
      emailVerified: Boolean(user.emailVerified),
    };
    next();
  } catch (err) {
    console.error('Auth verification error:', err);
    res.status(500).json({ error: 'Failed to verify authentication token.' });
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max inline audio upload
});

app.use(express.json({ limit: '4mb' }));

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'SONICPUSH AI', timestamp: new Date().toISOString() });
});

// -----------------------------------------------------------------------------
// 1. Song Intelligence Engine (Audio Multimodal + Metadata + Lyrics)
// -----------------------------------------------------------------------------
const SUPPORTED_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
]);

app.post(
  '/api/ai/song-intelligence',
  verifyFirebaseAuth,
  upload.single('audio'),
  async (req: AuthenticatedRequest, res: Response) => {
    const started = Date.now();
    try {
      const {
        title = '',
        artistName = '',
        genre = '',
        language = '',
        releaseDate = '',
        streamingLink = '',
        message = '',
        moodAndStyle = '',
        lyrics = '',
      } = req.body as Record<string, string>;

      if (!title.trim()) {
        res.status(400).json({ error: 'Song title is required.' });
        return;
      }

      const file = req.file;
      let audioProcessed = false;
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

      if (file && file.buffer && file.buffer.length > 0) {
        const mime = file.mimetype === 'audio/mp3' ? 'audio/mpeg' : file.mimetype;
        if (!SUPPORTED_AUDIO_MIMES.has(file.mimetype)) {
          res.status(400).json({
            error: `Unsupported audio format (${file.mimetype}). Upload MP3, WAV, M4A, AAC, OGG, FLAC, or WebM.`,
          });
          return;
        }
        parts.push({
          inlineData: {
            mimeType: mime,
            data: file.buffer.toString('base64'),
          },
        });
        audioProcessed = true;
      }

      const prompt = `Analyze this music release for SONICPUSH AI, a Nigerian, African, and international music promotion agency.

Song Metadata Provided by User:
- Title: ${title}
- Artist: ${artistName || 'Not specified'}
- Genre: ${genre || 'Not specified'}
- Language(s): ${language || 'Not specified'}
- Release Date: ${releaseDate || 'Not specified'}
- Streaming / Preview Link: ${streamingLink || 'None provided'}
- Core Song Message: ${message || 'Not specified'}
- Mood & Style Description: ${moodAndStyle || 'Not specified'}
- Audio File Uploaded & Attached for Direct Listening: ${audioProcessed ? `YES (${file?.originalname}, ${Math.round((file?.size || 0) / 1024)} KB)` : 'NO'}
- User-Authorized Lyrics: ${lyrics ? lyrics.slice(0, 5000) : 'None provided'}

CRITICAL HONESTY & GROUNDING RULES:
1. If Audio File Attached is NO, you MUST NOT claim to have listened to the audio, tempo, vocal tone, instrumentation, or beat! Only list factual observations from the user-provided text metadata and lyrics in "verifiedObservations".
2. If Audio File Attached is YES, include direct acoustic/musical observations you actually hear in the audio inside "verifiedObservations" (e.g., vocal delivery, percussion/groove, tempo feel, hook timing) and clearly keep marketing hypotheses separate in "aiHypotheses".
3. Never invent streaming numbers, chart placements, or real-world release outcomes.`;

      parts.push({ text: prompt });

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          systemInstruction:
            'You are a senior A&R director and music marketing strategist at SONICPUSH AI, specializing in Nigerian music culture (Afrobeats, Amapiano, Afro-fusion, Hip-hop, Gospel, R&B, Dancehall) and global diaspora markets. Always distinguish verified facts/audio observations from strategic hypotheses.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              verifiedObservations: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description:
                  'Strictly verified observations from uploaded audio (if processed) and provided metadata/lyrics.',
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
      res.json({
        audioProcessed,
        audioFileName: file?.originalname || '',
        verifiedObservations: parsed.verifiedObservations || [],
        aiHypotheses: parsed.aiHypotheses,
        latencyMs: Date.now() - started,
        model: 'gemini-4-hydrogen',
      });
    } catch (err) {
      console.error('Song intelligence error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to analyze song.',
        latencyMs: Date.now() - started,
      });
    }
  }
);

// -----------------------------------------------------------------------------
// 2. AI Music Campaign Manager (15-Section Structured Strategy)
// -----------------------------------------------------------------------------
app.post(
  '/api/ai/campaign-generate',
  verifyFirebaseAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const started = Date.now();
    try {
      const {
        artistName,
        artistCountry,
        artistGenre,
        songTitle,
        songMessage,
        campaignType,
        durationDays,
        currency,
        budget,
        targetMarkets,
      } = req.body as {
        artistName: string;
        artistCountry?: string;
        artistGenre?: string;
        songTitle?: string;
        songMessage?: string;
        campaignType: string;
        durationDays: number;
        currency: string;
        budget: number;
        targetMarkets?: string;
      };

      if (!artistName || !campaignType) {
        res.status(400).json({ error: 'Artist name and campaign type are required.' });
        return;
      }

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Generate a comprehensive ${durationDays}-day "${campaignType}" promotional campaign for:
- Artist: ${artistName} (${artistCountry || 'Nigeria / Africa'}, Genre: ${artistGenre || 'Afrobeats / Afro-fusion'})
- Song: ${songTitle || 'Artist Catalogue / Release'}
- Song Message / Context: ${songMessage || 'Not specified'}
- Target Markets: ${targetMarkets || 'Nigeria, West Africa, UK Diaspora, Global'}
- Planned Budget: ${budget} ${currency}

STRICT INTEGRITY RULES:
1. Work strictly within the user's ${budget} ${currency} budget for budget allocations (use percentages + approximate ${currency} splits clearly labeled as planning estimates).
2. NEVER invent guaranteed advertising costs (CPC/CPM), fake influencer rate cards, guaranteed playlist placements, or guaranteed stream counts.
3. Explicitly label projections and assumptions in "projectionsDisclaimer" and inside KPIs/budget sections.`,
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
      res.json({
        strategySections,
        latencyMs: Date.now() - started,
        model: 'gemini-4-hydrogen',
      });
    } catch (err) {
      console.error('Campaign generate error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to generate campaign strategy.',
        latencyMs: Date.now() - started,
      });
    }
  }
);

// -----------------------------------------------------------------------------
// 3. Viral Content Creation Studio
// -----------------------------------------------------------------------------
app.post(
  '/api/ai/content-studio',
  verifyFirebaseAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const started = Date.now();
    try {
      const {
        artistName,
        songTitle,
        genre,
        moodAndStyle,
        category,
        durationSeconds,
        variationsCount = 3,
      } = req.body as {
        artistName: string;
        songTitle: string;
        genre?: string;
        moodAndStyle?: string;
        category: string;
        durationSeconds: 15 | 30 | 60;
        variationsCount?: number;
      };

      const count = Math.min(Math.max(Number(variationsCount) || 3, 1), 4);
      const ai = getGeminiClient();

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Create ${count} distinct ${durationSeconds}-second "${category}" promotional concepts for:
- Artist: ${artistName}
- Song: ${songTitle}
- Genre: ${genre || 'Afrobeats'}
- Mood/Style: ${moodAndStyle || 'Energetic and relatable'}

CRITICAL RULE: Do NOT describe any concept or audio format as "currently trending" or "viral right now" because no live trend feed is attached to this prompt. Focus on repeatable creative craft, Nigerian/African & global audience relatability, and crisp production cues.`,
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
      res.json({
        ideas,
        latencyMs: Date.now() - started,
        model: 'gemini-4-hydrogen',
      });
    } catch (err) {
      console.error('Content studio error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to generate content concepts.',
        latencyMs: Date.now() - started,
      });
    }
  }
);

// -----------------------------------------------------------------------------
// 4. Trend Intelligence (Live Google Search Grounding)
// -----------------------------------------------------------------------------
app.post(
  '/api/ai/trends',
  verifyFirebaseAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const started = Date.now();
    try {
      const { market = 'Nigeria', platform = 'TikTok', genre = 'Afrobeats', artistContext = '' } =
        req.body as {
          market?: string;
          platform?: string;
          genre?: string;
          artistContext?: string;
        };

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Research current, verifiable music marketing trends, popular content formats, regional conversations, and creator challenges for ${genre} music on ${platform} in ${market}.
${artistContext ? `Artist context: ${artistContext}` : ''}

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
        // Fallback: return raw grounded summary cleanly alongside sources
      }

      res.json({
        trends: parsedTrends,
        summaryMarkdown: parsedTrends.length === 0 ? rawText : '',
        sources,
        latencyMs: Date.now() - started,
        model: 'gemini-4-hydrogen',
      });
    } catch (err) {
      console.error('Trend intelligence error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to research live trends.',
        latencyMs: Date.now() - started,
      });
    }
  }
);

// -----------------------------------------------------------------------------
// 5. Outreach Message Drafting (Influencers & DJ/Radio/Media)
// -----------------------------------------------------------------------------
app.post(
  '/api/ai/outreach-draft',
  verifyFirebaseAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const started = Date.now();
    try {
      const {
        contactName,
        contactCategory,
        platform,
        country,
        channel,
        artistName,
        songTitle,
        genre,
        streamingLink,
        deliverableGoal,
      } = req.body as Record<string, string>;

      if (!contactName || !channel || !artistName) {
        res.status(400).json({ error: 'Contact name, channel, and artist name are required.' });
        return;
      }

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Draft a professional, respectful, culturally authentic outreach message for:
- Recipient: ${contactName} (${contactCategory || 'Creator/Media'}, ${platform || 'Social/Media'}, ${country || 'Nigeria'})
- Channel: ${channel} (tailor length & tone to ${channel})
- Artist: ${artistName}
- Song: ${songTitle || 'Upcoming release'} (${genre || 'Afrobeats'})
- Listen / EPK Link: ${streamingLink || '[Insert Streaming / EPK Link]'}
- Goal: ${deliverableGoal || 'Introduction, listen request, and collaboration inquiry'}

STRICT RULE: Never promise guaranteed airplay, coverage, or playlist placement. Do not invent fake metrics about the artist or recipient.`,
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
      res.json({
        subject: draft.subject || '',
        messageBody: draft.messageBody || '',
        latencyMs: Date.now() - started,
        model: 'gemini-4-hydrogen',
      });
    } catch (err) {
      console.error('Outreach draft error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to generate outreach message.',
        latencyMs: Date.now() - started,
      });
    }
  }
);

// -----------------------------------------------------------------------------
// 6. Central SONICPUSH AI Assistant (Grounded in Real Organization Records)
// -----------------------------------------------------------------------------
app.post(
  '/api/ai/assistant',
  verifyFirebaseAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const started = Date.now();
    try {
      const { messages = [], workspaceContext = {} } = req.body as {
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        workspaceContext?: Record<string, unknown>;
      };

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'At least one user message is required.' });
        return;
      }

      const ai = getGeminiClient();
      const contents = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents,
        config: {
          systemInstruction: `You are the central SONICPUSH AI Strategist—combining the expertise of a Music Marketing Strategist, Digital Marketing Manager, Artist Development Consultant, Social Media Strategist, Influencer Campaign Manager, Music Publicist, and Campaign Analyst.

You deeply understand Nigerian music culture, Afrobeats, Amapiano, Afro-fusion, Hip-hop, Gospel, R&B, Dancehall, and both African and international music markets.

REAL WORKSPACE DATABASE SNAPSHOT (JSON):
${JSON.stringify(workspaceContext).slice(0, 12000)}

STRICT INTEGRITY RULES:
1. Always reference the real artists, songs, campaigns, tasks, and recorded metrics from the workspace snapshot above whenever relevant.
2. NEVER invent campaign results, fake streaming figures, fake industry contacts, fake package prices, or unverified research findings. If data is missing from the workspace snapshot, state what is missing and guide the user on what to log or create.`,
        },
      });

      res.json({
        reply: response.text || 'I could not generate a response for that request.',
        latencyMs: Date.now() - started,
        model: 'gemini-4-hydrogen',
      });
    } catch (err) {
      console.error('AI assistant error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to query SONICPUSH AI Assistant.',
        latencyMs: Date.now() - started,
      });
    }
  }
);

// -----------------------------------------------------------------------------
// 7. Payment Verification & Webhook Scaffolding (No Simulated Success)
// -----------------------------------------------------------------------------
app.post(
  '/api/payments/verify',
  verifyFirebaseAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const { provider, reference } = req.body as { provider?: string; reference?: string };
    if (!provider || !reference) {
      res.status(400).json({ error: 'Payment provider and transaction reference are required.' });
      return;
    }

    if (provider === 'paystack') {
      const secret = process.env.PAYSTACK_SECRET_KEY;
      if (!secret) {
        res.json({
          verified: false,
          verificationStatus: 'awaiting_provider_integration',
          message:
            'Paystack secret key is not configured on the server. Payment remains pending manual/provider verification.',
        });
        return;
      }
      try {
        const pRes = await fetch(
          `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
          { headers: { Authorization: `Bearer ${secret}` } }
        );
        const pJson = (await pRes.json()) as { status?: boolean; data?: { status?: string } };
        const isPaid = pJson.status === true && pJson.data?.status === 'success';
        res.json({
          verified: isPaid,
          verificationStatus: isPaid ? 'verified' : 'failed',
          providerResponse: pJson.data?.status || 'unverified',
        });
        return;
      } catch (err) {
        res.status(502).json({
          verified: false,
          verificationStatus: 'pending',
          error: err instanceof Error ? err.message : 'Paystack verification request failed.',
        });
        return;
      }
    }

    res.json({
      verified: false,
      verificationStatus: 'awaiting_provider_integration',
      message: `${provider} server-side credentials/webhook are awaiting integration. Real payments are never simulated.`,
    });
  }
);

app.post('/api/payments/webhook/:provider', (req: Request, res: Response) => {
  const { provider } = req.params;
  if (provider === 'paystack' && process.env.PAYSTACK_SECRET_KEY) {
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
      res.status(401).json({ error: 'Invalid Paystack webhook signature.' });
      return;
    }
    res.status(200).json({ received: true, provider: 'paystack' });
    return;
  }

  if (provider === 'flutterwave' && process.env.FLUTTERWAVE_SECRET_HASH) {
    if (req.headers['verif-hash'] !== process.env.FLUTTERWAVE_SECRET_HASH) {
      res.status(401).json({ error: 'Invalid Flutterwave webhook signature.' });
      return;
    }
    res.status(200).json({ received: true, provider: 'flutterwave' });
    return;
  }

  res.status(501).json({
    received: false,
    status: 'awaiting_provider_integration',
    message: `Webhook secret for ${provider} is not configured.`,
  });
});

// -----------------------------------------------------------------------------
// Vite Dev Middleware / Production Static Serving
// -----------------------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SONICPUSH AI server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
