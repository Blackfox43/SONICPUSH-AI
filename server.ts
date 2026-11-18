import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import path from 'path';
import { createSonicPushApp } from './server/app.ts';
import { createFirebaseAdminDbAdapter } from './server/firebaseAdmin.ts';
import { AudioRetentionService, createFirebaseAdminAudioStorage } from './server/audioStorage.ts';
import { logStructured, sanitizeErrorMessage } from './server/logger.ts';

const PORT = Number(process.env.PORT) || 3000;
const CLEANUP_INTERVAL_MS = Number(process.env.AUDIO_CLEANUP_INTERVAL_MS) || 6 * 60 * 60 * 1000;

async function startServer() {
  const adminDb = createFirebaseAdminDbAdapter();
  const audioStorage = createFirebaseAdminAudioStorage();
  const audioRetention = new AudioRetentionService(adminDb, audioStorage);

  const app = createSonicPushApp({
    adminDb,
    audioStorage,
    audioRetentionService: audioRetention,
  });

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
    logStructured('info', 'server_started', {
      port: PORT,
      env: process.env.NODE_ENV || 'development',
    });
  });

  if (CLEANUP_INTERVAL_MS > 0 && process.env.DISABLE_AUDIO_CLEANUP_SCHEDULER !== 'true') {
    const timer = setInterval(() => {
      void audioRetention
        .cleanupExpiredAudio({
          limit: 50,
          orphanPageSize: 500,
          orphanMaxPagesPerRun: 4,
        })
        .catch((err) => {
          logStructured('warn', 'scheduled_audio_cleanup_skipped', {
            reason: sanitizeErrorMessage(err),
          });
        });
    }, CLEANUP_INTERVAL_MS);
    timer.unref();
  }
}

void startServer();
