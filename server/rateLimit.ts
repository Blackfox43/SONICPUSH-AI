export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  reason?: string;
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
        reason: `Per-minute AI request limit reached (${this.shortLimit}/min). Please wait ${retryAfterSeconds}s.`,
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
        reason: `Daily AI usage quota reached (${this.dailyLimit}/24h).`,
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
    };
  }

  reset(key?: string): void {
    if (key) {
      this.shortHits.delete(key);
      this.dailyHits.delete(key);
    } else {
      this.shortHits.clear();
      this.dailyHits.clear();
    }
  }
}
