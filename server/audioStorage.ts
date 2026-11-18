import crypto from 'crypto';
import {
  getAdminStorageBucket,
  SERVER_TIMESTAMP_SENTINEL,
  type AdminFirestoreAdapter,
} from './firebaseAdmin.ts';
import { logStructured, sanitizeErrorMessage } from './logger.ts';

export interface AudioUploadParams {
  storageObjectPath: string;
  buffer: Buffer;
  contentType: string;
  ownerId: string;
  organizationId: string;
  retentionExpiresAt: string;
  uploadedAt: string;
}

export interface AudioStorageAdapter {
  uploadPrivateAudio(params: AudioUploadParams): Promise<void>;
  deleteAudioObject(storageObjectPath: string): Promise<void>;
  getSignedReadUrl?(storageObjectPath: string, expiresInSeconds?: number): Promise<string>;
  readAudioStream?(storageObjectPath: string): Promise<{ buffer: Buffer; contentType?: string }>;
}

export function createFirebaseAdminAudioStorage(): AudioStorageAdapter {
  return {
    async uploadPrivateAudio(params: AudioUploadParams): Promise<void> {
      const bucket = getAdminStorageBucket();
      const file = bucket.file(params.storageObjectPath);
      await file.save(params.buffer, {
        resumable: false,
        public: false,
        metadata: {
          contentType: params.contentType,
          cacheControl: 'private, max-age=0, no-store',
          metadata: {
            ownerId: params.ownerId,
            organizationId: params.organizationId,
            retentionExpiresAt: params.retentionExpiresAt,
            uploadedAt: params.uploadedAt,
          },
        },
      });
    },

    async deleteAudioObject(storageObjectPath: string): Promise<void> {
      const bucket = getAdminStorageBucket();
      const file = bucket.file(storageObjectPath);
      try {
        await file.delete({ ignoreNotFound: true });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        const msg = err instanceof Error ? err.message : '';
        if (code === 404 || msg.includes('No such object')) {
          return;
        }
        throw err;
      }
    },

    async getSignedReadUrl(storageObjectPath: string, expiresInSeconds = 900): Promise<string> {
      const bucket = getAdminStorageBucket();
      const file = bucket.file(storageObjectPath);
      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + expiresInSeconds * 1000,
      });
      return url;
    },

    async readAudioStream(storageObjectPath: string): Promise<{ buffer: Buffer; contentType?: string }> {
      const bucket = getAdminStorageBucket();
      const file = bucket.file(storageObjectPath);
      const [meta] = await file.getMetadata();
      const [buffer] = await file.download();
      return {
        buffer,
        contentType: typeof meta.contentType === 'string' ? meta.contentType : undefined,
      };
    },
  };
}

export interface AudioCleanupSummary {
  ranAt: string;
  scanned: number;
  deleted: number;
  failed: number;
  skipped: number;
  results: Array<{
    songId: string;
    storageObjectPath: string;
    status: 'deleted' | 'failed';
    error?: string;
  }>;
}

export class AudioRetentionService {
  private readonly db: AdminFirestoreAdapter;
  private readonly storage: AudioStorageAdapter;
  private running = false;

  constructor(db: AdminFirestoreAdapter, storage: AudioStorageAdapter) {
    this.db = db;
    this.storage = storage;
  }

  async cleanupExpiredAudio(options?: { now?: Date; limit?: number }): Promise<AudioCleanupSummary> {
    if (this.running) {
      return {
        ranAt: (options?.now ?? new Date()).toISOString(),
        scanned: 0,
        deleted: 0,
        failed: 0,
        skipped: 0,
        results: [],
      };
    }

    this.running = true;
    const nowIso = (options?.now ?? new Date()).toISOString();
    const limit = Math.min(200, Math.max(1, options?.limit ?? 50));

    try {
      const [activeExpired, retryFailedExpired] = await Promise.all([
        this.db.queryDocs(
          'songs',
          [
            { field: 'audioStorageCleanupStatus', op: '==', value: 'active' },
            { field: 'audioRetentionExpiresAt', op: '<=', value: nowIso },
          ],
          { limit }
        ),
        this.db.queryDocs(
          'songs',
          [
            { field: 'audioStorageCleanupStatus', op: '==', value: 'cleanup_failed' },
            { field: 'audioRetentionExpiresAt', op: '<=', value: nowIso },
          ],
          { limit }
        ),
      ]);

      const candidatesMap = new Map<string, Record<string, unknown>>();
      for (const s of [...activeExpired, ...retryFailedExpired]) {
        if (typeof s.id === 'string') {
          candidatesMap.set(s.id, s);
        }
      }

      const candidates = Array.from(candidatesMap.values()).slice(0, limit);
      let deleted = 0;
      let failed = 0;
      let skipped = 0;
      const results: AudioCleanupSummary['results'] = [];

      for (const song of candidates) {
        const songId = String(song.id || '');
        const storagePath = typeof song.audioStoragePath === 'string' ? song.audioStoragePath : '';
        const orgId = typeof song.organizationId === 'string' ? song.organizationId : 'unknown';

        if (!storagePath) {
          skipped += 1;
          continue;
        }

        const attemptIso = new Date().toISOString();
        const logId = `aclean_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

        try {
          await this.storage.deleteAudioObject(storagePath);

          await this.db.updateDoc('songs', songId, {
            audioStorageCleanupStatus: 'deleted',
            audioDeletedAt: attemptIso,
            audioCleanupError: '',
            updatedAt: SERVER_TIMESTAMP_SENTINEL,
          });

          await this.db.setDoc('audio_cleanup_logs', logId, {
            id: logId,
            songId,
            organizationId: orgId,
            storageObjectPath: storagePath,
            status: 'deleted',
            attemptedAt: attemptIso,
            createdAt: attemptIso,
            updatedAt: attemptIso,
          });

          deleted += 1;
          results.push({ songId, storageObjectPath: storagePath, status: 'deleted' });
        } catch (err) {
          const safeErr = sanitizeErrorMessage(err, 'Storage deletion failed.');
          try {
            await this.db.updateDoc('songs', songId, {
              audioStorageCleanupStatus: 'cleanup_failed',
              audioCleanupError: safeErr.slice(0, 380),
              updatedAt: SERVER_TIMESTAMP_SENTINEL,
            });
            await this.db.setDoc('audio_cleanup_logs', logId, {
              id: logId,
              songId,
              organizationId: orgId,
              storageObjectPath: storagePath,
              status: 'failed',
              error: safeErr.slice(0, 380),
              attemptedAt: attemptIso,
              createdAt: attemptIso,
              updatedAt: attemptIso,
            });
          } catch {
            // Non-fatal logging error
          }

          failed += 1;
          results.push({
            songId,
            storageObjectPath: storagePath,
            status: 'failed',
            error: safeErr,
          });
        }
      }

      logStructured('info', 'audio_retention_cleanup_completed', {
        scanned: candidates.length,
        deleted,
        failed,
        skipped,
      });

      return {
        ranAt: nowIso,
        scanned: candidates.length,
        deleted,
        failed,
        skipped,
        results,
      };
    } finally {
      this.running = false;
    }
  }

  async listRecentCleanupLogs(limit = 30): Promise<Array<Record<string, unknown>>> {
    return this.db
      .queryDocs('audio_cleanup_logs', [], {
        orderBy: { field: 'attemptedAt', dir: 'desc' },
        limit,
      })
      .catch(() => []);
  }
}
