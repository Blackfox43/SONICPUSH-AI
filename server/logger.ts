const SENSITIVE_KEY_PATTERN =
  /^(authorization|token|idtoken|secret|apikey|api_key|password|passwd|credential|privatekey|lyrics|prompt|messages|rawbody|payload|cookie|set-cookie)$/i;

function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Strip bearer tokens if accidentally passed inside a message
    return value.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]').slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(key, item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = redactValue(k, v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export type LogLevel = 'info' | 'warn' | 'error';

export function logStructured(
  level: LogLevel,
  event: string,
  meta: Record<string, unknown> = {}
): void {
  const sanitized = redactValue('root', meta) as Record<string, unknown>;
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitized,
  });

  if (level === 'error') {
    console.error(entry);
  } else if (level === 'warn') {
    console.warn(entry);
  } else {
    console.info(entry);
  }
}

export function sanitizeErrorMessage(err: unknown, fallback = 'Operation failed'): string {
  const raw = err instanceof Error ? err.message : String(err || fallback);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(sk_live_|sk_test_|whsec_|FLWSECK|AIza)[A-Za-z0-9_\-]+/g, '[REDACTED_SECRET]')
    .slice(0, 300);
}
