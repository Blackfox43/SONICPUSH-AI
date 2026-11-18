# SONICPUSH AI — TURN SONGS INTO MOVEMENTS

SONICPUSH AI is a full-stack AI-powered music promotion agency and artist management platform built for independent artists, record labels, managers, promoters, and music marketing teams across Nigeria, Africa, and international diaspora markets.

---

## Core Architecture

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Recharts (`Studio Console Dark` design system with subtle CSS waveform branding and live `NGN` / `USD` / `GBP` / `EUR` workspace currency switching).
- **Backend Server**: Node.js + Express (`server.ts`) serving Vite middleware in development and the compiled `dist/` SPA bundle in production (`PORT=3000` default, Cloud Run ready).
- **AI Engine (`@google/genai`)**: Server-side Gemini integration (`gemini-4-hydrogen`) powering:
  - **Song Intelligence Engine**: Accepts optional real audio uploads (`multipart/form-data`, up to 20 MB) plus metadata and authorized lyrics, strictly separating direct audio/metadata observations from AI strategic hypotheses.
  - **15-Section Campaign Manager**: Structured launch/promo/release strategies tailored to user-defined budgets and target markets with explicit projection disclaimers.
  - **Viral Content Studio**: 15s / 30s / 60s creative concepts without fabricated trend claims.
  - **Live Trend Intelligence**: Grounded in live Google Search (`googleSearch` tool) with real source URLs and timestamps.
  - **Outreach Drafting & Central AI Assistant**: Context-aware strategist grounded in real Firestore workspace records.
- **Database, Auth & Storage**: Firebase Authentication (Google Sign-In + role onboarding for `SUPER_ADMIN`, `PROMOTER`, `ARTIST`), Cloud Firestore (20 tenant-scoped collections with `firestore.rules` and `firebase-blueprint.json`), and Firebase Storage.

---

## Local Development & Build

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment variables**
   Copy `.env.example` to `.env` and supply server-side secrets:
   - `GEMINI_API_KEY` — Required for all `/api/ai/*` endpoints.
   - `APP_URL` — Public service URL.
   - `PORT` — HTTP port (defaults to `3000`).
   - Optional payment keys: `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_HASH`, `STRIPE_WEBHOOK_SECRET`.

3. **Run in development**
   ```bash
   npm run dev
   ```

4. **Type-check and build for production**
   ```bash
   npm run lint
   npm run build
   npm start
   ```

5. **Lint & Test Security Hardening**
   ```bash
   npx eslint firestore.rules
   npm test
   # With Java 17+ installed locally for Firebase Emulator:
   firebase emulators:exec --only firestore "npm run test:rules"
   ```

---

## Security & Payment Architecture (Phase 1 Hardened)

- **Server-Verified Sessions & RBAC**: `GET /api/auth/session` and `POST /api/auth/onboarding-check` validate Firebase ID tokens server-side and enforce `SUPER_ADMIN` privileges without client-side email allowlists. Role updates go through `POST /api/admin/users/:targetUid/role` with `admin_audit_logs` tracking.
- **Starter Tier Architecture**: Designed for AI Studio Starter Tier projects (no IAM service-account admin privilege); Firestore REST calls execute under the caller's verified Firebase ID token so `firestore.rules` always enforces strict tenant isolation.
- **Fail-Closed Payment Verification & Raw-Body Webhooks**:
  - `POST /api/payments/verify` fetches authoritative invoice amounts and organization ownership directly from Firestore on the server, compares minor units (`toMinorUnits`), enforces reference uniqueness across invoices and organizations, and supports Paystack, Flutterwave, and Stripe (`stripe` SDK).
  - `POST /api/payments/webhook/:provider` preserves the raw request buffer (`req.rawBody`), verifies official Paystack (`x-paystack-signature` HMAC-SHA512), Flutterwave (`verif-hash` / `flutterwave-signature`), and Stripe (`stripe.webhooks.constructEvent`) signatures, deduplicates events for idempotency, and handles `failed`, `refunded`, and `disputed` transitions.
- **Gemini AI & Audio Upload Security**:
  - Every `/api/ai/*` endpoint requires verified Firebase Auth, per-user rate/daily quotas (`SlidingWindowQuotaLimiter`), strict input sanitization, and prompt-injection delimiters.
  - `/api/ai/assistant` retrieves workspace records server-side from Firestore instead of trusting browser-submitted context.
  - Song Intelligence validates audio binary signatures (magic bytes beyond extension/MIME) up to 20 MB, assigns UUID private storage paths (`storage.rules`), attaches retention metadata (`AUDIO_RETENTION_DAYS`), and cleans up Storage objects on deletion. Automated antivirus scanning is not performed.

---

## Deploying to Google Cloud Run

1. Build the production frontend bundle (`npm run build`).
2. Ensure `NODE_ENV=production` and `GEMINI_API_KEY` are configured in Cloud Run environment variables / Secret Manager.
3. Cloud Run executes `npm start` (`node server.ts`), listening on `0.0.0.0:$PORT`.
4. Add your Cloud Run domain to **Firebase Console → Authentication → Settings → Authorized domains** so Google Sign-In works in production.
5. Deploy updated security rules manually after review:
   ```bash
   firebase deploy --only firestore:rules,storage
   ```

---

## External Integrations Awaiting Live API Credentials

Per platform honesty and compliance guardrails, no metrics, payments, outreach dispatches, or ad spends are ever simulated:

1. **Payment Gateways**: Live `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_SECRET_HASH`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` merchant credentials (server verification and webhook signature validation return `awaiting_provider_integration` until keys are configured).
2. **Advertising Platform APIs**: Meta Marketing API, TikTok Marketing API, and YouTube Ads API credentials for automated campaign telemetry sync (currently supports manual & CSV metric logging with `manual` vs `api` source tracking).
3. **Automated Messaging Dispatch**: WhatsApp Business API / SMTP / SendGrid credentials for automated outreach delivery (currently generates drafts and logs explicitly authorized manual outreach).
4. **Streaming Platform Analytics APIs**: Spotify for Artists, Apple Music for Artists, and Audiomack creator APIs for automated stream ingestion.
