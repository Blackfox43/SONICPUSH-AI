# SONICPUSH AI — TURN SONGS INTO MOVEMENTS

SONICPUSH AI is a full-stack AI-powered music promotion agency and artist management platform built for independent artists, record labels, managers, promoters, and music marketing teams across Nigeria, Africa, and international diaspora markets.

---

## Core Architecture

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Recharts (`Studio Console Dark` design system with subtle CSS waveform branding and live `NGN` / `USD` / `GBP` / `EUR` workspace currency switching).
- **Backend Server**: Node.js + Express (`server.ts`) serving Vite middleware in development and the compiled `dist/` SPA bundle in production (`PORT=3000` default, Cloud Run ready).
- **AI Engine (`@google/genai`)**: Server-side Gemini integration (`gemini-4-hydrogen`) powering:
  - **Song Intelligence Engine**: Accepts optional real audio uploads (`multipart/form-data`, up to 20 MB) stored privately via Firebase Admin Storage plus metadata and authorized lyrics, strictly separating direct audio/metadata observations from AI strategic hypotheses.
  - **15-Section Campaign Manager**: Structured launch/promo/release strategies tailored to user-defined budgets and target markets with explicit projection disclaimers.
  - **Viral Content Studio**: 15s / 30s / 60s creative concepts without fabricated trend claims.
  - **Live Trend Intelligence**: Grounded in live Google Search (`googleSearch` tool) with real source URLs and timestamps.
  - **Outreach Drafting & Central AI Assistant**: Context-aware strategist grounded in real Firestore workspace records.
- **Database, Auth & Storage**: Firebase Authentication (Google Sign-In + role onboarding & custom claim sync for `SUPER_ADMIN`, `PROMOTER`, `ARTIST`), Cloud Firestore (25 collections including server-managed payment, quota, and retention collections with `firestore.rules` + `firestore.indexes.json`), and Private Firebase Storage (`storage.rules`).

---

## Local Development & Build

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment variables**
   Copy `.env.example` to `.env` and supply server-side configuration:
   - `GEMINI_API_KEY` — Required for all `/api/ai/*` endpoints.
   - `APP_URL` & `PORT` — Public URL and HTTP port (defaults to `3000`).
   - `FIREBASE_PROJECT_ID`, `FIRESTORE_DATABASE_ID`, `FIREBASE_STORAGE_BUCKET` — Optional overrides (otherwise read from `firebase-applet-config.json`).
   - Optional payment secrets: `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_SECRET_HASH`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYMENT_ATTESTATION_SECRET`.
   - Distributed AI quotas & cleanup: `AI_RATE_LIMIT_PER_MIN`, `AI_DAILY_QUOTA_PER_USER`, `AI_ORG_DAILY_QUOTA`, `AUDIO_RETENTION_DAYS`, `AUDIO_CLEANUP_INTERVAL_MS`, `AUDIO_CLEANUP_CRON_SECRET`.

3. **Run in development**
   ```bash
   npm run dev
   ```

4. **Type-check, build, and verify**
   ```bash
   npm run lint
   npm run build
   npx eslint firestore.rules
   npm test
   # With Java 17+ installed locally for Firebase Emulator:
   firebase emulators:exec --only firestore "npm run test:rules"
   ```

---

## Security & Production Architecture (Phase 2 Hardened)

- **Shared Firestore Payment Ledger (`server/paymentLedger.ts`)**:
  - Replaces local/instance storage with durable, multi-instance transactional Firestore collections (`payment_reference_bindings` and `payment_webhook_events`).
  - Atomically prevents payment reference reuse across invoices or organizations (`409 Conflict`), deduplicates webhook events across restarts/instances, and supports `verified`, `failed`, `refunded`, and `disputed` invoice/payment reconciliation.
  - Quarantine & Retry Safety: Unmatched or mismatched webhook payloads are quarantined (`reconciliationStatus: 'quarantined'`), while transient Firestore failures record `pending_retry` and return HTTP `500` so gateways or admins (`POST /api/payments/webhooks/:eventDocId/retry`) can safely retry without duplicate side effects.
- **Complete Payment Provider Webhooks**:
  - `POST /api/payments/verify` fetches authoritative invoice amounts and ownership from Firestore on the server and performs official server-side verification for Paystack (minor units), Flutterwave, and Stripe.
  - `POST /api/payments/webhook/:provider` validates raw-body signatures for Paystack (`x-paystack-signature`), Flutterwave (`verif-hash` / `flutterwave-signature`), and Stripe (`stripe.webhooks.constructEvent`), cross-verifies settlement events via the official provider API when keys are configured, and returns explicit `501 awaiting_provider_integration` if provider secrets are unset.
- **Private Server-Side Audio Storage & Retention Cleanup (`server/audioStorage.ts`)**:
  - Uploaded audio files pass magic-byte signature validation up to 20 MB, then upload privately via `firebase-admin/storage` before reporting success (`audioUploaded: true`, `audioUploadedAt`, `audioRetentionExpiresAt`, `audioStorageCleanupStatus: 'active'`). Storage errors fail closed (`502`).
  - Playback/downloads use `GET /api/songs/:songId/audio-url` (v4 signed URL or org-authorized proxy stream at `GET /api/songs/:songId/audio-stream`). Deleting a release via `DELETE /api/songs/:songId` purges both Storage and Firestore.
  - `AudioRetentionService` automatically purges expired audio objects (`cleanup_failed` retries on subsequent runs) and writes audit entries to `audio_cleanup_logs`.
- **Promoted Super Admin Claim Governance (`server/auth.ts`)**:
  - `POST /api/admin/users/:targetUid/role` updates `users/{uid}.role`, synchronizes Firebase Auth custom claims (`superAdmin: true, role: 'SUPER_ADMIN'`) via Firebase Admin SDK, writes `admin_audit_logs`, and flags `needsTokenRefresh` so clients refresh their JWT (`getIdToken(true)`) immediately.
  - Both bootstrap (`BOOTSTRAP_ADMIN_EMAILS`) and promoted `SUPER_ADMIN` users receive identical `allow list`, cross-org read, payment reconciliation, diagnostics, and storage delete permissions. Bootstrap owner and caller self-demotion are blocked.
- **Distributed Firestore AI Quota Limiter (`server/rateLimit.ts`)**:
  - `FirestoreDistributedQuotaLimiter` runs single-transaction multi-bucket enforcement in `ai_rate_limits` across per-user minute, per-user daily, per-organization daily, and per-feature daily limits.
  - Usage telemetry in `ai_usage_logs` omits prompts, lyrics, song titles, and PII.
- **Observability & Diagnostics (`server/logger.ts`, `/api/admin/diagnostics`, `/api/health`)**:
  - Redacted structured JSON logs strip bearer tokens, secrets, prompts, and raw bodies. `/api/admin/diagnostics` surfaces live provider configuration, Firebase Admin IAM readiness, pending/quarantined webhooks, AI quota metrics, and audio cleanup logs for Super Admins.

---

## Deploying to Google Cloud Run

1. **Build the production bundle**:
   ```bash
   npm run build
   ```
2. **Deploy Cloud Run with Application Default Credentials (ADC)**:
   - Never generate or commit static service account JSON key files.
   - Attach a dedicated runtime Cloud Run Service Account with:
     - `roles/datastore.user` (Cloud Firestore Admin SDK & transactions)
     - `roles/storage.objectAdmin` (Private Firebase Storage read/write/delete & signed URLs if `roles/iam.serviceAccountTokenCreator` is granted for v4 `getSignedUrl`, otherwise server proxy stream works automatically)
     - `roles/firebaseauth.admin` (Synchronizing Firebase Auth custom claims on role governance)
   - Set environment variables / Secret Manager bindings for `GEMINI_API_KEY`, `NODE_ENV=production`, `APP_URL`, `AUDIO_CLEANUP_CRON_SECRET`, and live payment gateway secrets.
   - Cloud Run runs `npm start` (`node server.ts`) listening on `0.0.0.0:$PORT`.
3. **Configure Authorized Domains & Deploy Firebase Rules/Indexes Manually**:
   - Add your Cloud Run URL to **Firebase Console → Authentication → Settings → Authorized domains**.
   - Manually deploy updated rules and composite indexes after review:
     ```bash
     firebase deploy --only firestore:rules,firestore:indexes,storage
     ```
4. **Optional External Cloud Scheduler for Audio Retention**:
   - In addition to the in-process interval scheduler, configure Cloud Scheduler to `POST /api/admin/audio/cleanup` every 6–24 hours with header `x-cron-secret: <AUDIO_CLEANUP_CRON_SECRET>`.
5. **Starter Tier vs Blaze/GCP IAM Note**:
   - On un-upgraded AI Studio Starter Tier projects lacking backend Admin IAM access, Admin SDK calls gracefully surface their degraded state in `/api/health` and `/api/admin/diagnostics`, user-token Firestore REST isolation remains active, and distributed Admin features require attaching Blaze/GCP IAM ADC permissions.

---

## Integration & Verification Status Breakdown

1. **Fully Implemented & Verified End-to-End**: Server-verified auth sessions, custom claim sync flow, RBAC role guards, `firestore.rules` + `storage.rules` + `firestore.indexes.json` validation, fail-closed audio magic-byte validation, redacted structured logging, UI views, and React/TypeScript build (`npm run lint`, `npm run build`, `npx eslint firestore.rules`).
2. **Implemented & Locally Verified Using Transactional/Mocked Adapters (`npm test`)**: Multi-instance/restart shared Firestore payment ledger, Paystack/Flutterwave/Stripe webhook raw-body signature verification, duplicate/conflict/quarantine/retry lifecycles, private audio upload/stream/cleanup/retry, promoted vs bootstrap Super Admin governance, and concurrent distributed AI quota enforcement.
3. **Ready for Gateway Sandbox/Live Verification Once Keys Are Supplied**: Live Paystack, Flutterwave, and Stripe API settlement verification and live webhook delivery require configuring merchant secrets in environment/Secret Manager.
4. **Awaiting Live Credentials**: Automated advertising platform APIs (Meta/TikTok/YouTube Ads), automated WhatsApp/SMTP/SendGrid outreach dispatch, and automated DSP analytics sync (Spotify/Apple Music/Audiomack for Artists).
5. **Environment-Dependent Execution Note**: `tests/firestore.rules.test.ts` requires Java 17+ to launch the local Firebase Firestore Emulator (`npm run test:rules`).
