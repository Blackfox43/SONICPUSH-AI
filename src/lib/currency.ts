import type { CurrencyCode } from '../types/sonicpush';

// Planning reference exchange rates relative to 1 USD (displayed with disclaimer when converted)
const USD_RATES: Record<CurrencyCode, number> = {
  USD: 1,
  NGN: 1600,
  GBP: 0.79,
  EUR: 0.92,
};

export function convertCurrency(
  amount: number,
  from: CurrencyCode,
  to: CurrencyCode
): number {
  if (from === to) return amount;
  const inUsd = amount / (USD_RATES[from] || 1);
  return inUsd * (USD_RATES[to] || 1);
}

export function formatMoney(
  amount: number,
  currency: CurrencyCode,
  compact = false
): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(currency === 'NGN' ? 'en-NG' : 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: compact ? 0 : 2,
      notation: compact && Math.abs(safe) >= 1_000_000 ? 'compact' : 'standard',
    }).format(safe);
  } catch {
    const symbol =
      currency === 'NGN' ? '₦' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
    return `${symbol}${safe.toLocaleString()}`;
  }
}

export function formatNumber(n: number | undefined | null): string {
  const safe = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return safe.toLocaleString('en-US');
}
