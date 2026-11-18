import crypto from 'crypto';
import {
  isPermissionOrCredentialError,
  SERVER_TIMESTAMP_SENTINEL,
  type AdminFirestoreAdapter,
} from './firebaseAdmin.ts';
import { logStructured, sanitizeErrorMessage } from './logger.ts';

export type AiFeatureName =
  | 'song_intelligence'
  | 'campaign_generate'
  | 'content_studio'
  | 'trends'
  | 'outreach_draft'
  | 'assistant';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  scope?: 'user_minute' | 'user_daily' | 'org_daily' | 'feature_daily';
  reason?: string;
  mode: 'firestore_distributed' | 'starter_tier_degraded';
}

export interface QuotaCheckInput {
  uid: string;
  organizationId: string;
  feature: AiFeatureName;
  now?: number;
}

export interface DistributedQuotaConfig {
  userPerMinuteLimit: number;
  userDailyLimit: number;
  orgDailyLimit: number;
  featureDailyLimits: Record<AiFeatureName, number>;
}

export function getDefaultQuotaConfig(): DistributedQuotaConfig {
  return {
    userPerMinuteLimit: Number(process.env.AI_RATE_LIMIT_PER_MIN) || 15,
    userDailyLimit: Number(process.env.AI_DAILY_QUOTA_PER_USER) || 150,
    orgDailyLimit: Number(process.env.AI_ORG_DAILY_QUOTA) || 600,
    featureDailyLimits: {
      song_intelligence: Number(process.env.AI_LIMIT_SONG_INTELLIGENCE_DAILY) || 40,
      campaign_generate: Number(process.env.AI_LIMIT_CAMPAIGN_DAILY) || 50,
      content_studio: Number(process.env.AI_LIMIT_CONTENT_DAILY) || 60,
      trends: Number(process.env.AI_LIMIT_TRENDS_DAILY) || 60,
      outreach_draft: Number(process.env.AI_LIMIT_OUTREACH_DAILY) || 80,
      assistant: Number(process.env.AI_LIMIT_ASSISTANT_DAILY) || 120,
    },
  };
}

function safeKeyPart(raw: string): string {
  return (raw || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function secondsUntilNextUtcDay(nowMs: number): number {
  const d = new Date(nowMs);
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
  return Math.max(1, Math.ceil((nextMidnight - nowMs) / 1000));
}

function secondsUntilNextMinute(nowMs: number): number {
  const remainder = nowMs % 60_000;
  return Math.max(1, Math.ceil((60_000 - remainder) / 1000));
}

export class SlidingWindowQuotaLimiter {
  private readonly shortWindowMs: number;
  private readonly shortLimit: number;
  private readonly dailyWindowMs: number;
  private readonly dailyLimit: number;
  private readonly shortHits = new Map<string, number[]>();
  private readonly dailyHits = new Map<string, number[]>();

  constructor(options?: {
    shortWindowMs?: number;
    shortLimit?: number;
    dailyWindowMs?: number;
    dailyLimit?: number;
  }) {
    this.shortWindowMs = options?.shortWindowMs ?? 60_000;
    this.shortLimit = options?.shortLimit ?? (Number(process.env.AI_RATE_LIMIT_PER_MIN) || 15);
    this.dailyWindowMs = options?.dailyWindowMs ?? 86_400_000;
    this.dailyLimit = options?.dailyLimit ?? (Number(process.env.AI_DAILY_QUOTA_PER_USER) || 150);
  }

  checkAndConsume(key: string, now = Date.now()): RateLimitDecision {
    const shortCutoff = now - this.shortWindowMs;
    const recentShort = (this.shortHits.get(key) || []).filter((ts) => ts > shortCutoff);
    if (recentShort.length >= this.shortLimit) {
      const oldest = recentShort[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.shortWindowMs - now) / 1000));
      this.shortHits.set(key, recentShort);
      return {
        allowed: false,
        limit: this.shortLimit,
        remaining: 0,
        retryAfterSeconds,
        scope: 'user_minute',
        reason: `Per-minute AI request limit reached (${this.shortLimit}/min). Please wait ${retryAfterSeconds}s.`,
        mode: 'starter_tier_degraded',
      };
    }

    const dailyCutoff = now - this.dailyWindowMs;
    const recentDaily = (this.dailyHits.get(key) || []).filter((ts) => ts > dailyCutoff);
    if (recentDaily.length >= this.dailyLimit) {
      const oldest = recentDaily[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.dailyWindowMs - now) / 1000));
      this.dailyHits.set(key, recentDaily);
      return {
        allowed: false,
        limit: this.dailyLimit,
        remaining: 0,
        retryAfterSeconds,
        scope: 'user_daily',
        reason: `Daily AI usage quota reached (${this.dailyLimit}/24h).`,
        mode: 'starter_tier_degraded',
      };
    }

    recentShort.push(now);
    recentDaily.push(now);
    this.shortHits.set(key, recentShort);
    this.dailyHits.set(key, recentDaily);

    return {
      allowed: true,
      limit: this.shortLimit,
      remaining: Math.max(0, this.shortLimit - recentShort.length),
      retryAfterSeconds: 0,
      mode: 'starter_tier_degraded',
    };
  }
}

export class FirestoreDistributedQuotaLimiter {
  private readonly db: AdminFirestoreAdapter;
  private readonly config: DistributedQuotaConfig;
  private readonly allowStarterTierFallback: boolean;
  private readonly fallbackLimiter: SlidingWindowQuotaLimiter;
  private lastMode: 'firestore_distributed' | 'starter_tier_degraded' = 'firestore_distributed';
  private degradedReason?: string;

  constructor(
    db: AdminFirestoreAdapter,
    options?: {
      config?: Partial<Omit<DistributedQuotaConfig, 'featureDailyLimits'>> & {
        featureDailyLimits?: Partial<Record<AiFeatureName, number>>;
      };
      allowStarterTierFallback?: boolean;
    }
  ) {
    const defaults = getDefaultQuotaConfig();
    this.db = db;
    this.config = {
      userPerMinuteLimit: options?.config?.userPerMinuteLimit ?? defaults.userPerMinuteLimit,
      userDailyLimit: options?.config?.userDailyLimit ?? defaults.userDailyLimit,
      orgDailyLimit: options?.config?.orgDailyLimit ?? defaults.orgDailyLimit,
      featureDailyLimits: {
        ...defaults.featureDailyLimits,
        ...(options?.config?.featureDailyLimits || {}),
      },
    };
    this.allowStarterTierFallback = options?.allowStarterTierFallback ?? false;
    this.fallbackLimiter = new SlidingWindowQuotaLimiter({
      shortLimit: this.config.userPerMinuteLimit,
      dailyLimit: this.config.userDailyLimit,
    });
  }

  getDiagnostics(): {
    mode: 'firestore_distributed' | 'starter_tier_degraded';
    config: DistributedQuotaConfig;
    degradedReason?: string;
  } {
    return {
      mode: this.lastMode,
      config: this.config,
      degradedReason: this.degradedReason,
    };
  }

  async checkAndConsume(input: QuotaCheckInput): Promise<RateLimitDecision> {
    const nowMs = input.now ?? Date.now();
    const minuteBucket = Math.floor(nowMs / 60_000);
    const dayStr = utcDayKey(nowMs);
    const safeUid = safeKeyPart(input.uid);
    const safeOrg = safeKeyPart(input.organizationId || input.uid);
    const featureLimit =
      this.config.featureDailyLimits[input.feature] ?? this.config.userDailyLimit;

    const userMinDocId = `umin_${safeUid}_${minuteBucket}`;
    const userDayDocId = `uday_${safeUid}_${dayStr}`;
    const orgDayDocId = `oday_${safeOrg}_${dayStr}`;
    const featDayDocId = `fday_${input.feature}_${safeUid}_${dayStr}`;

    try {
      const decision = await this.db.runTransaction(async (tx) => {
        const [userMinDoc, userDayDoc, orgDayDoc, featDayDoc] = await Promise.all([
          tx.get('ai_rate_limits', userMinDocId),
          tx.get('ai_rate_limits', userDayDocId),
          tx.get('ai_rate_limits', orgDayDocId),
          tx.get('ai_rate_limits', featDayDocId),
        ]);

        const userMinCount = Number(userMinDoc?.count || 0);
        const userDayCount = Number(userDayDoc?.count || 0);
        const orgDayCount = Number(orgDayDoc?.count || 0);
        const featDayCount = Number(featDayDoc?.count || 0);

        if (userMinCount >= this.config.userPerMinuteLimit) {
          const retryAfterSeconds = secondsUntilNextMinute(nowMs);
          return {
            allowed: false,
            limit: this.config.userPerMinuteLimit,
            remaining: 0,
            retryAfterSeconds,
            scope: 'user_minute' as const,
            reason: `Per-minute AI request limit reached (${this.config.userPerMinuteLimit}/min). Please wait ${retryAfterSeconds}s.`,
            mode: 'firestore_distributed' as const,
          };
        }

        if (userDayCount >= this.config.userDailyLimit) {
          const retryAfterSeconds = secondsUntilNextUtcDay(nowMs);
          return {
            allowed: false,
            limit: this.config.userDailyLimit,
            remaining: 0,
            retryAfterSeconds,
            scope: 'user_daily' as const,
            reason: `Daily user AI quota reached (${this.config.userDailyLimit}/day UTC).`,
            mode: 'firestore_distributed' as const,
          };
        }

        if (orgDayCount >= this.config.orgDailyLimit) {
          const retryAfterSeconds = secondsUntilNextUtcDay(nowMs);
          return {
            allowed: false,
            limit: this.config.orgDailyLimit,
            remaining: 0,
            retryAfterSeconds,
            scope: 'org_daily' as const,
            reason: `Daily organization AI quota reached (${this.config.orgDailyLimit}/day UTC).`,
            mode: 'firestore_distributed' as const,
          };
        }

        if (featDayCount >= featureLimit) {
          const retryAfterSeconds = secondsUntilNextUtcDay(nowMs);
          return {
            allowed: false,
            limit: featureLimit,
            remaining: 0,
            retryAfterSeconds,
            scope: 'feature_daily' as const,
            reason: `Daily ${input.feature} quota reached (${featureLimit}/day UTC).`,
            mode: 'firestore_distributed' as const,
          };
        }

        const nowIso = new Date(nowMs).toISOString();
        const minuteExpiresAt = new Date((minuteBucket + 2) * 60_000).toISOString();
        const dayExpiresAt = new Date(nowMs + 48 * 3600_000).toISOString();

        await Promise.all([
          tx.set(
            'ai_rate_limits',
            userMinDocId,
            {
              id: userMinDocId,
              scope: 'user_minute',
              uid: input.uid,
              organizationId: input.organizationId || input.uid,
              feature: input.feature,
              windowKey: String(minuteBucket),
              count: userMinCount + 1,
              limit: this.config.userPerMinuteLimit,
              expiresAt: minuteExpiresAt,
              updatedAt: nowIso,
            },
            true
          ),
          tx.set(
            'ai_rate_limits',
            userDayDocId,
            {
              id: userDayDocId,
              scope: 'user_daily',
              uid: input.uid,
              organizationId: input.organizationId || input.uid,
              windowKey: dayStr,
              count: userDayCount + 1,
              limit: this.config.userDailyLimit,
              expiresAt: dayExpiresAt,
              updatedAt: nowIso,
            },
            true
          ),
          tx.set(
            'ai_rate_limits',
            orgDayDocId,
            {
              id: orgDayDocId,
              scope: 'org_daily',
              organizationId: input.organizationId || input.uid,
              windowKey: dayStr,
              count: orgDayCount + 1,
              limit: this.config.orgDailyLimit,
              expiresAt: dayExpiresAt,
              updatedAt: nowIso,
            },
            true
          ),
          tx.set(
            'ai_rate_limits',
            featDayDocId,
            {
              id: featDayDocId,
              scope: 'feature_daily',
              uid: input.uid,
              organizationId: input.organizationId || input.uid,
              feature: input.feature,
              windowKey: dayStr,
              count: featDayCount + 1,
              limit: featureLimit,
              expiresAt: dayExpiresAt,
              updatedAt: nowIso,
            },
            true
          ),
        ]);

        return {
          allowed: true,
          limit: this.config.userPerMinuteLimit,
          remaining: Math.max(0, this.config.userPerMinuteLimit - (userMinCount + 1)),
          retryAfterSeconds: 0,
          mode: 'firestore_distributed' as const,
        };
      });

      this.lastMode = 'firestore_distributed';
      this.degradedReason = undefined;
      return decision;
    } catch (err) {
      if (this.allowStarterTierFallback && isPermissionOrCredentialError(err)) {
        this.lastMode = 'starter_tier_degraded';
        this.degradedReason =
          'Admin Firestore IAM unavailable on Starter Tier; using single-instance fallback limiter.';
        logStructured('warn', 'ai_quota_starter_tier_fallback', {
          feature: input.feature,
          reason: sanitizeErrorMessage(err),
        });
        return this.fallbackLimiter.checkAndConsume(`${input.uid}:${input.feature}`, nowMs);
      }
      throw err;
    }
  }

  async recordUsageLog(params: {
    uid: string;
    organizationId: string;
    feature: AiFeatureName;
    model: string;
    status: 'success' | 'error';
    latencyMs: number;
  }): Promise<void> {
    // Strictly omit prompts, lyrics, song titles, and user PII
    const logId = `ailog_srv_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    try {
      await this.db.setDoc('ai_usage_logs', logId, {
        id: logId,
        organizationId: params.organizationId || params.uid,
        ownerId: params.uid,
        assignedUserIds: [params.uid],
        feature: params.feature,
        model: params.model.slice(0, 80),
        status: params.status,
        latencyMs: Math.max(0, Math.round(params.latencyMs)),
        createdAt: SERVER_TIMESTAMP_SENTINEL,
        updatedAt: SERVER_TIMESTAMP_SENTINEL,
      });
    } catch {
      // Usage log telemetry write failure must not abort an already-succeeded response
    }
  }

  async getAdminUsageMetrics(dayIso?: string): Promise<{
    day: string;
    totalOrgRequestsToday: number;
    totalSuccessLogs: number;
    totalErrorLogs: number;
    byFeature: Record<string, number>;
    activeBuckets: Array<Record<string, unknown>>;
  }> {
    const dayStr = (dayIso || new Date().toISOString()).slice(0, 10);
    const [buckets, recentLogs] = await Promise.all([
      this.db
        .queryDocs('ai_rate_limits', [{ field: 'windowKey', op: '==', value: dayStr }], { limit: 100 })
        .catch(() => []),
      this.db.queryDocs('ai_usage_logs', [], { limit: 100 }).catch(() => []),
    ]);

    let totalOrgRequestsToday = 0;
    for (const b of buckets) {
      if (b.scope === 'org_daily') {
        totalOrgRequestsToday += Number(b.count || 0);
      }
    }

    let totalSuccessLogs = 0;
    let totalErrorLogs = 0;
    const byFeature: Record<string, number> = {};
    for (const l of recentLogs) {
      if (l.status === 'success') totalSuccessLogs += 1;
      else if (l.status === 'error') totalErrorLogs += 1;
      const feat = typeof l.feature === 'string' ? l.feature : 'unknown';
      byFeature[feat] = (byFeature[feat] || 0) + 1;
    }

    return {
      day: dayStr,
      totalOrgRequestsToday,
      totalSuccessLogs,
      totalErrorLogs,
      byFeature,
      activeBuckets: buckets.slice(0, 30),
    };
  }
}
