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

5. **Lint Firestore security rules**
   ```bash
   npx eslint firestore.rules
   ```

---

## Deploying to Google Cloud Run

1. Build the production frontend bundle (`npm run build`).
2. Ensure `NODE_ENV=production` and `GEMINI_API_KEY` are configured in Cloud Run environment variables / Secret Manager.
3. Cloud Run executes `npm start` (`node server.ts`), listening on `0.0.0.0:$PORT`.
4. Add your Cloud Run domain to **Firebase Console → Authentication → Settings → Authorized domains** so Google Sign-In works in production.
5. Review and audit `firestore.rules` before opening access broadly.

---

## External Integrations Awaiting Live API Credentials

Per platform honesty and compliance guardrails, no metrics, payments, outreach dispatches, or ad spends are ever simulated:

1. **Payment Gateways**: Live `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_HASH`, and `STRIPE_WEBHOOK_SECRET` merchant credentials (server verification and webhook signature scaffolding exist in `/api/payments/verify` and `/api/payments/webhook/:provider`, returning `awaiting_provider_integration` until keys are configured).
2. **Advertising Platform APIs**: Meta Marketing API, TikTok Marketing API, and YouTube Ads API credentials for automated campaign telemetry sync (currently supports manual & CSV metric logging with `manual` vs `api` source tracking).
3. **Automated Messaging Dispatch**: WhatsApp Business API / SMTP / SendGrid credentials for automated outreach delivery (currently generates drafts and logs explicitly authorized manual outreach).
4. **Streaming Platform Analytics APIs**: Spotify for Artists, Apple Music for Artists, and Audiomack creator APIs for automated stream ingestion.
