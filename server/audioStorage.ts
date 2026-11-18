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

export interface AudioStorageObjectSummary {
  path: string;
  organizationId?: string;
  uploadedAt?: string;
  updatedAt?: string;
}

export interface AudioStoragePageRequest {
  prefix?: string;
  pageToken?: string;
  maxResults?: number;
}

export interface AudioStoragePageResult {
  objects: AudioStorageObjectSummary[];
  nextPageToken?: string;
}

export interface AudioObjectMetadata {
  organizationId?: string;
  ownerId?: string;
}

export interface AudioStorageAdapter {
  uploadPrivateAudio(params: AudioUploadParams): Promise<void>;
  deleteAudioObject(storageObjectPath: string): Promise<void>;
  getSignedReadUrl?(storageObjectPath: string, expiresInSeconds?: number): Promise<string>;
  readAudioStream?(storageObjectPath: string): Promise<{ buffer: Buffer; contentType?: string }>;
  getAudioMetadata?(storageObjectPath: string): Promise<AudioObjectMetadata | null>;
  listAudioObjects?(prefix?: string): Promise<AudioStorageObjectSummary[]>;
  listAudioObjectsPage?(params: AudioStoragePageRequest): Promise<AudioStoragePageResult>;
}

export type AudioCleanupReason =
  | 'gemini_analysis_failed'
  | 'song_delete_failed'
  | 'orphan_reconciled'
  | 'retention_expired';

export interface AudioCleanupQueueItem {
  id: string;
  storageObjectPath: string;
  organizationId: string;
  songId?: string;
  deleteSongOnCleanup?: boolean;
  storageDeleted?: boolean;
  reason: AudioCleanupReason;
  status: 'pending' | 'failed';
  retryCount: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export function makeCleanupQueueDocId(storageObjectPath: string): string {
  const hash = crypto.createHash('sha256').update(storageObjectPath).digest('hex').slice(0, 32);
  return `acleanq_${hash}`;
}

export function makeOrphanCursorDocId(organizationId?: string): string {
  if (!organizationId) {
    return 'orphan_cursor_all';
  }
  const hash = crypto.createHash('sha256').update(organizationId).digest('hex').slice(0, 24);
  return `orphan_cursor_org_${hash}`;
}

export function parseAudioOrgFromPath(storageObjectPath: string): string | null {
  const match = /^organizations\/([a-zA-Z0-9_-]+)\/audio\/[a-zA-Z0-9._-]+$/.exec(storageObjectPath);
  return match ? match[1] : null;
}

function mapStorageFileSummary(file: {
  name: string;
  metadata?: Record<string, unknown>;
}): AudioStorageObjectSummary {
  const meta = file.metadata || {};
  const customMeta = (meta.metadata || {}) as Record<string, unknown>;
  return {
    path: file.name,
    organizationId:
      typeof customMeta.organizationId === 'string' && customMeta.organizationId.trim()
        ? customMeta.organizationId.trim()
        : undefined,
    uploadedAt:
      typeof customMeta.uploadedAt === 'string'
        ? customMeta.uploadedAt
        : typeof meta.timeCreated === 'string'
        ? meta.timeCreated
        : undefined,
    updatedAt: typeof meta.updated === 'string' ? meta.updated : undefined,
  };
}

export function createFirebaseAdminAudioStorage(): AudioStorageAdapter {
  const adapter: AudioStorageAdapter = {
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

    async getAudioMetadata(storageObjectPath: string): Promise<AudioObjectMetadata | null> {
      const bucket = getAdminStorageBucket();
      const file = bucket.file(storageObjectPath);
      try {
        const [meta] = await file.getMetadata();
        const customMeta = ((meta as Record<string, unknown> | undefined)?.metadata || {}) as Record<
          string,
          unknown
        >;
        return {
          organizationId:
            typeof customMeta.organizationId === 'string' && customMeta.organizationId.trim()
              ? customMeta.organizationId.trim()
              : undefined,
          ownerId:
            typeof customMeta.ownerId === 'string' && customMeta.ownerId.trim()
              ? customMeta.ownerId.trim()
              : undefined,
        };
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        const msg = err instanceof Error ? err.message : '';
        if (code === 404 || msg.includes('No such object')) {
          return null;
        }
        throw err;
      }
    },

    async listAudioObjectsPage(params: AudioStoragePageRequest): Promise<AudioStoragePageResult> {
      const bucket = getAdminStorageBucket();
      const prefix = params.prefix || 'organizations/';
      const maxResults = Math.min(1000, Math.max(1, params.maxResults ?? 500));
      const [files, nextQuery] = await bucket.getFiles({
        prefix,
        autoPaginate: false,
        maxResults,
        ...(params.pageToken ? { pageToken: params.pageToken } : {}),
      });
      const rawNextToken =
        nextQuery && typeof (nextQuery as { pageToken?: unknown }).pageToken === 'string'
          ? (nextQuery as { pageToken: string }).pageToken
          : undefined;
      return {
        objects: files.map((file) =>
          mapStorageFileSummary({
            name: file.name,
            metadata: file.metadata as Record<string, unknown> | undefined,
          })
        ),
        ...(rawNextToken ? { nextPageToken: rawNextToken } : {}),
      };
    },

    async listAudioObjects(prefix = 'organizations/'): Promise<AudioStorageObjectSummary[]> {
      const all: AudioStorageObjectSummary[] = [];
      let pageToken: string | undefined;
      const seenTokens = new Set<string>();
      do {
        const page = await adapter.listAudioObjectsPage!({
          prefix,
          pageToken,
          maxResults: 500,
        });
        all.push(...page.objects);
        if (!page.nextPageToken || seenTokens.has(page.nextPageToken)) {
          break;
        }
        seenTokens.add(page.nextPageToken);
        pageToken = page.nextPageToken;
      } while (pageToken);
      return all;
    },
  };

  return adapter;
}

export interface AudioCleanupSummary {
  ranAt: string;
  scanned: number;
  deleted: number;
  failed: number;
  skipped: number;
  queueScanned: number;
  queueDeleted: number;
  queueFailed: number;
  orphansScanned: number;
  orphansDeleted: number;
  orphansSkipped: number;
  orphanPagesScanned: number;
  orphanHasMore: boolean;
  results: Array<{
    songId: string;
    storageObjectPath: string;
    status: 'deleted' | 'failed';
    reason?: AudioCleanupReason;
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

  private async verifyStorageMetadataOrg(
    storagePath: string,
    expectedOrgId: string
  ): Promise<{ ok: true } | { ok: false; metadataOrg: string }> {
    if (!this.storage.getAudioMetadata) {
      return { ok: true };
    }
    const meta = await this.storage.getAudioMetadata(storagePath).catch(() => null);
    if (meta?.organizationId && meta.organizationId !== expectedOrgId) {
      return { ok: false, metadataOrg: meta.organizationId };
    }
    return { ok: true };
  }

  async logCleanupAttempt(params: {
    songId: string;
    organizationId: string;
    storageObjectPath: string;
    status: 'deleted' | 'failed';
    reason?: AudioCleanupReason;
    error?: string;
    attemptedAt?: string;
  }): Promise<void> {
    const attemptIso = params.attemptedAt || new Date().toISOString();
    const logId = `aclean_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    await this.db
      .setDoc('audio_cleanup_logs', logId, {
        id: logId,
        songId: params.songId || 'none',
        organizationId: params.organizationId || 'unknown',
        storageObjectPath: params.storageObjectPath,
        status: params.status,
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.error ? { error: params.error.slice(0, 380) } : {}),
        attemptedAt: attemptIso,
        createdAt: attemptIso,
        updatedAt: attemptIso,
      })
      .catch(() => null);
  }

  async enqueueCleanupTask(params: {
    storageObjectPath: string;
    organizationId: string;
    songId?: string;
    deleteSongOnCleanup?: boolean;
    storageDeleted?: boolean;
    reason: AudioCleanupReason;
    error?: unknown;
  }): Promise<AudioCleanupQueueItem> {
    const nowIso = new Date().toISOString();
    const queueId = makeCleanupQueueDocId(params.storageObjectPath);
    const existing = await this.db.getDoc('audio_cleanup_queue', queueId).catch(() => null);
    const prevRetries =
      existing && typeof existing.retryCount === 'number' ? existing.retryCount : 0;
    const prevStorageDeleted = existing?.storageDeleted === true;
    const safeErr = params.error
      ? sanitizeErrorMessage(params.error, 'Storage cleanup failed.')
      : 'Storage cleanup queued for retry.';

    const item: AudioCleanupQueueItem = {
      id: queueId,
      storageObjectPath: params.storageObjectPath,
      organizationId: params.organizationId,
      ...(params.songId ? { songId: params.songId } : {}),
      ...(params.deleteSongOnCleanup !== undefined
        ? { deleteSongOnCleanup: params.deleteSongOnCleanup }
        : {}),
      ...(params.storageDeleted || prevStorageDeleted ? { storageDeleted: true } : {}),
      reason: params.reason,
      status: 'pending',
      retryCount: prevRetries,
      lastError: safeErr.slice(0, 380),
      createdAt:
        existing && typeof existing.createdAt === 'string' ? existing.createdAt : nowIso,
      updatedAt: nowIso,
    };

    await this.db.setDoc('audio_cleanup_queue', queueId, { ...item }, true);
    await this.logCleanupAttempt({
      songId: params.songId || 'unregistered',
      organizationId: params.organizationId,
      storageObjectPath: params.storageObjectPath,
      status: 'failed',
      reason: params.reason,
      error: safeErr,
      attemptedAt: nowIso,
    });

    return item;
  }

  async listPendingCleanupQueue(limit = 50): Promise<Array<Record<string, unknown>>> {
    const [pending, failed] = await Promise.all([
      this.db
        .queryDocs(
          'audio_cleanup_queue',
          [{ field: 'status', op: '==', value: 'pending' }],
          { limit }
        )
        .catch(() => []),
      this.db
        .queryDocs(
          'audio_cleanup_queue',
          [{ field: 'status', op: '==', value: 'failed' }],
          { limit }
        )
        .catch(() => []),
    ]);
    const map = new Map<string, Record<string, unknown>>();
    for (const row of [...pending, ...failed]) {
      if (typeof row.id === 'string') map.set(row.id, row);
    }
    return Array.from(map.values()).slice(0, limit);
  }

  private async fetchNextOrphanPage(params: {
    prefix: string;
    pageToken?: string;
    lastScannedPath?: string;
    maxResults: number;
  }): Promise<AudioStoragePageResult> {
    if (this.storage.listAudioObjectsPage) {
      return this.storage.listAudioObjectsPage({
        prefix: params.prefix,
        pageToken: params.pageToken,
        maxResults: params.maxResults,
      });
    }
    if (this.storage.listAudioObjects) {
      const all = await this.storage.listAudioObjects(params.prefix);
      const sorted = [...all].sort((a, b) => a.path.localeCompare(b.path));
      const filtered = params.lastScannedPath
        ? sorted.filter((entry) => entry.path > params.lastScannedPath!)
        : sorted;
      const slice = filtered.slice(0, params.maxResults);
      const hasMore = filtered.length > slice.length;
      const lastPath = slice.length > 0 ? slice[slice.length - 1].path : undefined;
      return {
        objects: slice,
        ...(hasMore && lastPath ? { nextPageToken: `path:${lastPath}` } : {}),
      };
    }
    return { objects: [] };
  }

  async cleanupExpiredAudio(options?: {
    now?: Date;
    limit?: number;
    includeOrphans?: boolean;
    orphanGraceMinutes?: number;
    orphanPageSize?: number;
    orphanMaxPagesPerRun?: number;
    orphanMaxObjectsPerRun?: number;
    resetOrphanCursor?: boolean;
    organizationId?: string;
  }): Promise<AudioCleanupSummary> {
    const nowDate = options?.now ?? new Date();
    const nowIso = nowDate.toISOString();

    if (this.running) {
      return {
        ranAt: nowIso,
        scanned: 0,
        deleted: 0,
        failed: 0,
        skipped: 0,
        queueScanned: 0,
        queueDeleted: 0,
        queueFailed: 0,
        orphansScanned: 0,
        orphansDeleted: 0,
        orphansSkipped: 0,
        orphanPagesScanned: 0,
        orphanHasMore: false,
        results: [],
      };
    }

    this.running = true;
    const limit = Math.min(200, Math.max(1, options?.limit ?? 50));
    const filterOrgId = options?.organizationId;

    try {
      const [activeExpired, retryFailedExpired, queueItems] = await Promise.all([
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
        this.listPendingCleanupQueue(limit),
      ]);

      const candidatesMap = new Map<string, Record<string, unknown>>();
      for (const s of [...activeExpired, ...retryFailedExpired]) {
        if (typeof s.id === 'string') {
          if (filterOrgId && s.organizationId !== filterOrgId) continue;
          candidatesMap.set(s.id, s);
        }
      }

      const candidates = Array.from(candidatesMap.values()).slice(0, limit);
      let deleted = 0;
      let failed = 0;
      let skipped = 0;
      let queueScanned = 0;
      let queueDeleted = 0;
      let queueFailed = 0;
      const results: AudioCleanupSummary['results'] = [];
      const handledPaths = new Set<string>();
      const queueByPath = new Map<string, Record<string, unknown>>();
      for (const q of queueItems) {
        if (typeof q.storageObjectPath === 'string') {
          queueByPath.set(q.storageObjectPath, q);
        }
      }

      // Phase 1: Expired retention songs
      for (const song of candidates) {
        const songId = String(song.id || '');
        const storagePath = typeof song.audioStoragePath === 'string' ? song.audioStoragePath : '';
        const orgId = typeof song.organizationId === 'string' ? song.organizationId : '';

        if (!storagePath || !orgId) {
          skipped += 1;
          continue;
        }

        const pathOrg = parseAudioOrgFromPath(storagePath);
        if (!pathOrg || pathOrg !== orgId) {
          skipped += 1;
          logStructured('warn', 'audio_cleanup_org_mismatch_skipped', {
            songId,
            songOrg: orgId,
            pathOrg,
          });
          continue;
        }

        const metaCheck = await this.verifyStorageMetadataOrg(storagePath, orgId);
        if (!metaCheck.ok) {
          skipped += 1;
          logStructured('warn', 'audio_cleanup_metadata_org_mismatch_skipped', {
            songId,
            songOrg: orgId,
            metadataOrg: metaCheck.metadataOrg,
          });
          continue;
        }

        handledPaths.add(storagePath);
        const attemptIso = new Date().toISOString();
        const existingQueue = queueByPath.get(storagePath);
        let storageDeletedThisAttempt = existingQueue?.storageDeleted === true;

        try {
          if (!storageDeletedThisAttempt) {
            await this.storage.deleteAudioObject(storagePath);
            storageDeletedThisAttempt = true;
          }

          await this.db.updateDoc('songs', songId, {
            audioStorageCleanupStatus: 'deleted',
            audioDeletedAt: attemptIso,
            audioCleanupError: '',
            updatedAt: SERVER_TIMESTAMP_SENTINEL,
          });

          // Remove any pending queue item for this path only after song update succeeded
          await this.db
            .deleteDoc('audio_cleanup_queue', makeCleanupQueueDocId(storagePath))
            .catch(() => null);

          await this.logCleanupAttempt({
            songId,
            organizationId: orgId,
            storageObjectPath: storagePath,
            status: 'deleted',
            reason: 'retention_expired',
            attemptedAt: attemptIso,
          });

          deleted += 1;
          results.push({
            songId,
            storageObjectPath: storagePath,
            status: 'deleted',
            reason: 'retention_expired',
          });
        } catch (err) {
          const safeErr = sanitizeErrorMessage(err, 'Storage deletion failed.');
          if (storageDeletedThisAttempt) {
            // Storage was deleted, but Firestore song update failed -> persist durable queue task so it is retried safely
            await this.enqueueCleanupTask({
              storageObjectPath: storagePath,
              organizationId: orgId,
              songId,
              deleteSongOnCleanup: false,
              storageDeleted: true,
              reason: 'retention_expired',
              error: err,
            }).catch(() => null);
          } else {
            try {
              await this.db.updateDoc('songs', songId, {
                audioStorageCleanupStatus: 'cleanup_failed',
                audioCleanupError: safeErr.slice(0, 380),
                updatedAt: SERVER_TIMESTAMP_SENTINEL,
              });
              await this.logCleanupAttempt({
                songId,
                organizationId: orgId,
                storageObjectPath: storagePath,
                status: 'failed',
                reason: 'retention_expired',
                error: safeErr,
                attemptedAt: attemptIso,
              });
            } catch {
              // Non-fatal logging error
            }
          }

          failed += 1;
          results.push({
            songId,
            storageObjectPath: storagePath,
            status: 'failed',
            reason: 'retention_expired',
            error: safeErr,
          });
        }
      }

      // Phase 2: Retry durable cleanup queue (e.g., failed Gemini rollback or failed song delete)
      for (const item of queueItems) {
        const queueId = String(item.id || '');
        const storagePath =
          typeof item.storageObjectPath === 'string' ? item.storageObjectPath : '';
        const orgId = typeof item.organizationId === 'string' ? item.organizationId : '';
        const songId = typeof item.songId === 'string' ? item.songId : '';
        const deleteSongOnCleanup = item.deleteSongOnCleanup === true;
        const reason =
          (item.reason as AudioCleanupReason | undefined) || 'song_delete_failed';

        if (!queueId || !storagePath || !orgId) {
          skipped += 1;
          continue;
        }
        if (filterOrgId && orgId !== filterOrgId) {
          continue;
        }

        const pathOrg = parseAudioOrgFromPath(storagePath);
        if (!pathOrg || pathOrg !== orgId) {
          skipped += 1;
          logStructured('warn', 'audio_queue_org_mismatch_skipped', {
            queueId,
            orgId,
            pathOrg,
          });
          continue;
        }

        if (handledPaths.has(storagePath)) {
          continue;
        }

        let storageDeletedThisAttempt = item.storageDeleted === true;
        if (!storageDeletedThisAttempt) {
          const metaCheck = await this.verifyStorageMetadataOrg(storagePath, orgId);
          if (!metaCheck.ok) {
            skipped += 1;
            logStructured('warn', 'audio_queue_metadata_org_mismatch_skipped', {
              queueId,
              orgId,
              metadataOrg: metaCheck.metadataOrg,
            });
            continue;
          }
        }

        handledPaths.add(storagePath);
        queueScanned += 1;

        const attemptIso = new Date().toISOString();
        try {
          if (!storageDeletedThisAttempt) {
            await this.storage.deleteAudioObject(storagePath);
            storageDeletedThisAttempt = true;
          }

          // Perform every required Firestore song operation WITHOUT swallowing errors
          if (songId && songId !== 'orphan' && songId !== 'rollback_gemini_failed') {
            if (deleteSongOnCleanup) {
              const existingSong = await this.db.getDoc('songs', songId);
              if (existingSong) {
                const existingSongOrg =
                  typeof existingSong.organizationId === 'string'
                    ? existingSong.organizationId
                    : '';
                if (existingSongOrg && existingSongOrg !== orgId) {
                  throw new Error('Cross-organization song record mismatch during cleanup.');
                }
                await this.db.deleteDoc('songs', songId);
              }
            } else {
              const existingSong = await this.db.getDoc('songs', songId);
              if (existingSong) {
                const existingSongOrg =
                  typeof existingSong.organizationId === 'string'
                    ? existingSong.organizationId
                    : '';
                if (existingSongOrg && existingSongOrg !== orgId) {
                  throw new Error('Cross-organization song record mismatch during cleanup.');
                }
                await this.db.updateDoc('songs', songId, {
                  audioStorageCleanupStatus: 'deleted',
                  audioDeletedAt: attemptIso,
                  audioCleanupError: '',
                  updatedAt: SERVER_TIMESTAMP_SENTINEL,
                });
              }
            }
          }

          // Only delete the queue item after BOTH Storage deletion and all required Firestore operations succeed
          await this.db.deleteDoc('audio_cleanup_queue', queueId);
          await this.logCleanupAttempt({
            songId: songId || 'unregistered',
            organizationId: orgId,
            storageObjectPath: storagePath,
            status: 'deleted',
            reason,
            attemptedAt: attemptIso,
          });

          queueDeleted += 1;
          deleted += 1;
          results.push({
            songId: songId || 'unregistered',
            storageObjectPath: storagePath,
            status: 'deleted',
            reason,
          });
        } catch (err) {
          const safeErr = sanitizeErrorMessage(err, 'Storage cleanup retry failed.');
          const nextRetryCount =
            typeof item.retryCount === 'number' ? item.retryCount + 1 : 1;

          // Preserve queue item (marking storageDeleted=true if Storage already succeeded so retry resumes remaining Firestore work)
          await this.db
            .setDoc(
              'audio_cleanup_queue',
              queueId,
              {
                status: 'failed',
                retryCount: nextRetryCount,
                lastError: safeErr.slice(0, 380),
                ...(storageDeletedThisAttempt ? { storageDeleted: true } : {}),
                updatedAt: attemptIso,
              },
              true
            )
            .catch(() => null);

          if (songId && songId !== 'orphan' && songId !== 'rollback_gemini_failed') {
            await this.db
              .updateDoc('songs', songId, {
                audioStorageCleanupStatus: 'cleanup_failed',
                audioCleanupError: safeErr.slice(0, 380),
                updatedAt: SERVER_TIMESTAMP_SENTINEL,
              })
              .catch(() => null);
          }

          await this.logCleanupAttempt({
            songId: songId || 'unregistered',
            organizationId: orgId,
            storageObjectPath: storagePath,
            status: 'failed',
            reason,
            error: safeErr,
            attemptedAt: attemptIso,
          });

          queueFailed += 1;
          failed += 1;
          results.push({
            songId: songId || 'unregistered',
            storageObjectPath: storagePath,
            status: 'failed',
            reason,
            error: safeErr,
          });
        }
      }

      // Phase 3: Full-pagination orphan reconciliation with durable cursor progression
      let orphansScanned = 0;
      let orphansDeleted = 0;
      let orphansSkipped = 0;
      let orphanPagesScanned = 0;
      let orphanHasMore = false;

      if (
        options?.includeOrphans !== false &&
        (this.storage.listAudioObjectsPage || this.storage.listAudioObjects)
      ) {
        const orphanGraceMinutes =
          options?.orphanGraceMinutes ??
          (Number(process.env.ORPHAN_AUDIO_GRACE_MINUTES) >= 0 &&
          process.env.ORPHAN_AUDIO_GRACE_MINUTES !== undefined
            ? Number(process.env.ORPHAN_AUDIO_GRACE_MINUTES)
            : 60);
        const graceMs = Math.max(0, orphanGraceMinutes) * 60 * 1000;
        const prefix = filterOrgId ? `organizations/${filterOrgId}/audio/` : 'organizations/';

        const pageSize = Math.min(1000, Math.max(1, options?.orphanPageSize ?? 500));
        const maxPagesPerRun = Math.min(200, Math.max(1, options?.orphanMaxPagesPerRun ?? 20));
        const maxObjectsPerRun =
          options?.orphanMaxObjectsPerRun !== undefined
            ? Math.max(1, options.orphanMaxObjectsPerRun)
            : pageSize * maxPagesPerRun;

        const cursorDocId = makeOrphanCursorDocId(filterOrgId);
        const existingCursor = options?.resetOrphanCursor
          ? null
          : await this.db.getDoc('audio_cleanup_cursors', cursorDocId).catch(() => null);

        let currentPageToken =
          existingCursor &&
          typeof existingCursor.nextPageToken === 'string' &&
          existingCursor.nextPageToken
            ? existingCursor.nextPageToken
            : undefined;
        let currentLastPath =
          existingCursor &&
          typeof existingCursor.lastScannedPath === 'string' &&
          existingCursor.lastScannedPath
            ? existingCursor.lastScannedPath
            : undefined;
        const prevCyclePages =
          existingCursor && typeof existingCursor.pagesScannedInCycle === 'number'
            ? existingCursor.pagesScannedInCycle
            : 0;

        let objectsSeenInRun = 0;
        let lastScannedPathInRun = currentLastPath || '';
        const seenPageTokens = new Set<string>();
        let tokenResetTried = false;

        while (orphanPagesScanned < maxPagesPerRun && objectsSeenInRun < maxObjectsPerRun) {
          const remainingBudget = maxObjectsPerRun - objectsSeenInRun;
          const batchMaxResults = Math.min(pageSize, remainingBudget);

          let page: AudioStoragePageResult;
          try {
            page = await this.fetchNextOrphanPage({
              prefix,
              pageToken: currentPageToken,
              lastScannedPath: currentLastPath,
              maxResults: batchMaxResults,
            });
          } catch (err) {
            if ((currentPageToken || currentLastPath) && !tokenResetTried) {
              tokenResetTried = true;
              logStructured('warn', 'orphan_audio_cursor_reset_on_error', {
                cursorDocId,
                error: sanitizeErrorMessage(err),
              });
              currentPageToken = undefined;
              currentLastPath = undefined;
              continue;
            }
            logStructured('warn', 'orphan_audio_list_failed', {
              error: sanitizeErrorMessage(err),
            });
            break;
          }

          orphanPagesScanned += 1;
          objectsSeenInRun += page.objects.length;

          for (const obj of page.objects) {
            lastScannedPathInRun = obj.path;
            if (handledPaths.has(obj.path)) continue;

            const pathOrg = parseAudioOrgFromPath(obj.path);
            if (!pathOrg) {
              orphansSkipped += 1;
              continue;
            }
            if (filterOrgId && pathOrg !== filterOrgId) {
              orphansSkipped += 1;
              continue;
            }
            // Cross-org protection: never delete if object metadata claims a different organization
            if (obj.organizationId && (obj.organizationId !== pathOrg || (filterOrgId && obj.organizationId !== filterOrgId))) {
              orphansSkipped += 1;
              logStructured('warn', 'orphan_audio_cross_org_metadata_skipped', {
                path: obj.path,
                pathOrg,
                metadataOrg: obj.organizationId,
              });
              continue;
            }

            const timestampStr = obj.uploadedAt || obj.updatedAt;
            const objTimeMs = timestampStr ? Date.parse(timestampStr) : NaN;
            if (!Number.isFinite(objTimeMs) || nowDate.getTime() - objTimeMs < graceMs) {
              orphansSkipped += 1;
              continue;
            }

            orphansScanned += 1;

            // Fail safe: if querying songs throws, DO NOT treat the object as orphaned
            let matchingSongs: Array<Record<string, unknown>>;
            try {
              matchingSongs = await this.db.queryDocs(
                'songs',
                [{ field: 'audioStoragePath', op: '==', value: obj.path }],
                { limit: 5 }
              );
            } catch (err) {
              orphansSkipped += 1;
              logStructured('error', 'orphan_audio_song_lookup_failed', {
                path: obj.path,
                error: sanitizeErrorMessage(err),
              });
              continue;
            }

            if (matchingSongs.length > 0) {
              // Active or registered song doc references this file (never delete)
              orphansSkipped += 1;
              continue;
            }

            const attemptIso = new Date().toISOString();
            try {
              await this.storage.deleteAudioObject(obj.path);
              await this.logCleanupAttempt({
                songId: 'orphan',
                organizationId: pathOrg,
                storageObjectPath: obj.path,
                status: 'deleted',
                reason: 'orphan_reconciled',
                attemptedAt: attemptIso,
              });
              orphansDeleted += 1;
              deleted += 1;
              results.push({
                songId: 'orphan',
                storageObjectPath: obj.path,
                status: 'deleted',
                reason: 'orphan_reconciled',
              });
            } catch (err) {
              const safeErr = sanitizeErrorMessage(err, 'Orphan audio deletion failed.');
              await this.enqueueCleanupTask({
                storageObjectPath: obj.path,
                organizationId: pathOrg,
                deleteSongOnCleanup: false,
                reason: 'orphan_reconciled',
                error: err,
              }).catch(() => null);
              failed += 1;
              results.push({
                songId: 'orphan',
                storageObjectPath: obj.path,
                status: 'failed',
                reason: 'orphan_reconciled',
                error: safeErr,
              });
            }
          }

          if (!page.nextPageToken || seenPageTokens.has(page.nextPageToken)) {
            currentPageToken = undefined;
            currentLastPath = undefined;
            break;
          }
          seenPageTokens.add(page.nextPageToken);
          currentPageToken = page.nextPageToken;
          currentLastPath = lastScannedPathInRun;
        }

        if (currentPageToken) {
          orphanHasMore = true;
          await this.db
            .setDoc(
              'audio_cleanup_cursors',
              cursorDocId,
              {
                id: cursorDocId,
                organizationId: filterOrgId || 'all',
                nextPageToken: currentPageToken,
                lastScannedPath: lastScannedPathInRun,
                pagesScannedInCycle: prevCyclePages + orphanPagesScanned,
                updatedAt: nowIso,
              },
              true
            )
            .catch(() => null);
        } else {
          orphanHasMore = false;
          await this.db
            .setDoc(
              'audio_cleanup_cursors',
              cursorDocId,
              {
                id: cursorDocId,
                organizationId: filterOrgId || 'all',
                nextPageToken: '',
                lastScannedPath: '',
                pagesScannedInCycle: 0,
                cycleCompletedAt: nowIso,
                updatedAt: nowIso,
              },
              true
            )
            .catch(() => null);
        }
      }

      logStructured('info', 'audio_retention_cleanup_completed', {
        scanned: candidates.length,
        queueScanned,
        orphansScanned,
        orphanPagesScanned,
        orphanHasMore,
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
        queueScanned,
        queueDeleted,
        queueFailed,
        orphansScanned,
        orphansDeleted,
        orphansSkipped,
        orphanPagesScanned,
        orphanHasMore,
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
