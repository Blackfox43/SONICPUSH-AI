import crypto from 'crypto';
import Stripe from 'stripe';

export type PaymentProvider = 'paystack' | 'flutterwave' | 'stripe' | 'manual_transfer';
export type PaymentVerificationStatus =
  | 'pending'
  | 'awaiting_provider_integration'
  | 'verified'
  | 'failed'
  | 'refunded'
  | 'disputed';

export type CurrencyCode = 'NGN' | 'USD' | 'GBP' | 'EUR';

export function toMinorUnits(amount: number, currency: CurrencyCode): number {
  if (!Number.isFinite(amount) || amount < 0) return -1;
  switch (currency) {
    case 'NGN':
    case 'USD':
    case 'GBP':
    case 'EUR':
    default:
      return Math.round(amount * 100);
  }
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const EPHEMERAL_ATTESTATION_KEY = crypto.randomBytes(32).toString('hex');

export function signPaymentAttestation(payload: {
  invoiceId: string;
  organizationId: string;
  provider: string;
  reference: string;
  amountMinor: number;
  currency: string;
  verificationStatus: string;
}): string {
  const secret =
    process.env.PAYMENT_ATTESTATION_SECRET ||
    process.env.GEMINI_API_KEY ||
    EPHEMERAL_ATTESTATION_KEY;
  const canonical = [
    payload.invoiceId,
    payload.organizationId,
    payload.provider,
    payload.reference,
    String(payload.amountMinor),
    payload.currency.toUpperCase(),
    payload.verificationStatus,
  ].join('|');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

export interface ProviderVerificationResult {
  verified: boolean;
  verificationStatus: PaymentVerificationStatus;
  providerTransactionId?: string;
  amountMinor?: number;
  currency?: string;
  message: string;
}

export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export async function verifyPaystackWithProvider(params: {
  reference: string;
  expectedAmountMinor: number;
  expectedCurrency: CurrencyCode;
  invoiceId: string;
  expectedOrganizationId?: string;
  secretKey?: string;
  fetchImpl?: FetchLike;
}): Promise<ProviderVerificationResult> {
  const secret = params.secretKey ?? process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return {
      verified: false,
      verificationStatus: 'awaiting_provider_integration',
      message:
        'Paystack secret key is not configured on the server. Live verification requires PAYSTACK_SECRET_KEY.',
    };
  }

  const fetcher: FetchLike = params.fetchImpl ?? (fetch as unknown as FetchLike);
  const res = await fetcher(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(params.reference)}`,
    {
      headers: { Authorization: `Bearer ${secret}` },
    }
  );

  if (!res.ok) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: `Paystack API rejected verification request (HTTP ${res.status}).`,
    };
  }

  const body = (await res.json()) as {
    status?: boolean;
    message?: string;
    data?: {
      id?: number | string;
      status?: string;
      reference?: string;
      amount?: number;
      currency?: string;
      metadata?: { invoiceId?: string; organizationId?: string };
    };
  };

  const tx = body.data;
  if (body.status !== true || !tx) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: body.message || 'Paystack returned an unverified transaction response.',
    };
  }

  if (tx.status !== 'success') {
    return {
      verified: false,
      verificationStatus: 'failed',
      providerTransactionId: tx.id ? String(tx.id) : undefined,
      message: `Paystack transaction status is "${tx.status || 'unknown'}", not success.`,
    };
  }

  if (tx.reference !== params.reference) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: 'Paystack transaction reference mismatch.',
    };
  }

  if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount)) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: 'Paystack returned missing or non-numeric transaction amount.',
    };
  }
  const actualMinor = Math.round(tx.amount);
  if (actualMinor !== params.expectedAmountMinor) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: `Paystack amount mismatch (expected ${params.expectedAmountMinor} minor units, got ${actualMinor}).`,
    };
  }

  const actualCurrency = String(tx.currency || '').toUpperCase();
  if (!actualCurrency || actualCurrency !== params.expectedCurrency.toUpperCase()) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: `Paystack currency mismatch (expected ${params.expectedCurrency}, got ${actualCurrency || 'missing'}).`,
    };
  }

  if (tx.metadata?.invoiceId && tx.metadata.invoiceId !== params.invoiceId) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: 'Paystack metadata invoiceId does not match target invoice.',
    };
  }

  if (
    params.expectedOrganizationId &&
    tx.metadata?.organizationId &&
    tx.metadata.organizationId !== params.expectedOrganizationId
  ) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: 'Paystack metadata organizationId does not match invoice organization.',
    };
  }

  return {
    verified: true,
    verificationStatus: 'verified',
    providerTransactionId: tx.id ? String(tx.id) : undefined,
    amountMinor: actualMinor,
    currency: actualCurrency,
    message: 'Payment verified via Paystack official verification API.',
  };
}

export async function verifyFlutterwaveWithProvider(params: {
  reference: string;
  transactionId?: string;
  expectedAmountMinor: number;
  expectedCurrency: CurrencyCode;
  invoiceId: string;
  expectedOrganizationId?: string;
  secretKey?: string;
  fetchImpl?: FetchLike;
}): Promise<ProviderVerificationResult> {
  const secret = params.secretKey ?? process.env.FLUTTERWAVE_SECRET_KEY;
  if (!secret) {
    return {
      verified: false,
      verificationStatus: 'awaiting_provider_integration',
      message:
        'Flutterwave secret key is not configured on the server. Live verification requires FLUTTERWAVE_SECRET_KEY.',
    };
  }

  const fetcher: FetchLike = params.fetchImpl ?? (fetch as unknown as FetchLike);
  const endpoint = params.transactionId
    ? `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(params.transactionId)}/verify`
    : `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(params.reference)}`;

  const res = await fetcher(endpoint, {
    headers: { Authorization: `Bearer ${secret}` },
  });

  if (!res.ok) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: `Flutterwave API rejected verification request (HTTP ${res.status}).`,
    };
  }

  const body = (await res.json()) as {
    status?: string;
    message?: string;
    data?: {
      id?: number | string;
      status?: string;
      tx_ref?: string;
      amount?: number;
      currency?: string;
      meta?: { invoiceId?: string; organizationId?: string };
    };
  };

  const tx = body.data;
  if (body.status !== 'success' || !tx) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: body.message || 'Flutterwave returned an unverified transaction response.',
    };
  }

  if (tx.status !== 'successful') {
    return {
      verified: false,
      verificationStatus: 'failed',
      providerTransactionId: tx.id ? String(tx.id) : undefined,
      message: `Flutterwave transaction status is "${tx.status || 'unknown'}", not successful.`,
    };
  }

  if (params.transactionId && String(tx.id) !== String(params.transactionId)) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: 'Flutterwave transaction ID mismatch.',
    };
  }

  if (tx.tx_ref !== params.reference) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: 'Flutterwave tx_ref mismatch.',
    };
  }

  if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount)) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: 'Flutterwave returned missing or non-numeric transaction amount.',
    };
  }
  const actualMinor = Math.round(tx.amount * 100);
  if (actualMinor !== params.expectedAmountMinor) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: `Flutterwave amount mismatch (expected ${params.expectedAmountMinor} minor units, got ${actualMinor}).`,
    };
  }

  const actualCurrency = String(tx.currency || '').toUpperCase();
  if (!actualCurrency || actualCurrency !== params.expectedCurrency.toUpperCase()) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: `Flutterwave currency mismatch (expected ${params.expectedCurrency}, got ${actualCurrency || 'missing'}).`,
    };
  }

  if (tx.meta?.invoiceId && tx.meta.invoiceId !== params.invoiceId) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: 'Flutterwave metadata invoiceId does not match target invoice.',
    };
  }

  if (
    params.expectedOrganizationId &&
    tx.meta?.organizationId &&
    tx.meta.organizationId !== params.expectedOrganizationId
  ) {
    return {
      verified: false,
      verificationStatus: 'failed',
      message: 'Flutterwave metadata organizationId does not match invoice organization.',
    };
  }

  return {
    verified: true,
    verificationStatus: 'verified',
    providerTransactionId: tx.id ? String(tx.id) : undefined,
    amountMinor: actualMinor,
    currency: actualCurrency,
    message: 'Payment verified via Flutterwave official verification API.',
  };
}

export async function verifyStripeWithProvider(params: {
  reference: string; // Checkout Session cs_... or PaymentIntent pi_...
  expectedAmountMinor: number;
  expectedCurrency: CurrencyCode;
  invoiceId: string;
  expectedOrganizationId?: string;
  secretKey?: string;
  stripeClient?: Stripe;
}): Promise<ProviderVerificationResult> {
  const secret = params.secretKey ?? process.env.STRIPE_SECRET_KEY;
  if (!secret && !params.stripeClient) {
    return {
      verified: false,
      verificationStatus: 'awaiting_provider_integration',
      message:
        'Stripe secret key is not configured on the server. Live verification requires STRIPE_SECRET_KEY.',
    };
  }

  const stripe = params.stripeClient || new Stripe(secret!);

  if (params.reference.startsWith('cs_')) {
    const session = await stripe.checkout.sessions.retrieve(params.reference);
    if (session.payment_status !== 'paid') {
      return {
        verified: false,
        verificationStatus: 'failed',
        providerTransactionId: session.id,
        message: `Stripe Checkout session status is "${session.payment_status}", not paid.`,
      };
    }
    const actualMinor = typeof session.amount_total === 'number' ? session.amount_total : -1;
    if (actualMinor !== params.expectedAmountMinor) {
      return {
        verified: false,
        verificationStatus: 'failed',
        message: `Stripe amount mismatch (expected ${params.expectedAmountMinor}, got ${actualMinor}).`,
      };
    }
    const actualCurrency = String(session.currency || '').toUpperCase();
    if (!actualCurrency || actualCurrency !== params.expectedCurrency.toUpperCase()) {
      return {
        verified: false,
        verificationStatus: 'failed',
        message: `Stripe currency mismatch (expected ${params.expectedCurrency}, got ${actualCurrency || 'missing'}).`,
      };
    }
    if (session.metadata?.invoiceId && session.metadata.invoiceId !== params.invoiceId) {
      return {
        verified: false,
        verificationStatus: 'failed',
        message: 'Stripe session metadata invoiceId mismatch.',
      };
    }
    if (
      params.expectedOrganizationId &&
      session.metadata?.organizationId &&
      session.metadata.organizationId !== params.expectedOrganizationId
    ) {
      return {
        verified: false,
        verificationStatus: 'failed',
        message: 'Stripe session metadata organizationId mismatch.',
      };
    }
    return {
      verified: true,
      verificationStatus: 'verified',
      providerTransactionId:
        typeof session.payment_intent === 'string' ? session.payment_intent : session.id,
      amountMinor: actualMinor,
      currency: actualCurrency,
      message: 'Payment verified via Stripe Checkout Session API.',
    };
  }

  if (params.reference.startsWith('pi_')) {
    const pi = await stripe.paymentIntents.retrieve(params.reference);
    if (pi.status !== 'succeeded') {
      return {
        verified: false,
        verificationStatus: 'failed',
        providerTransactionId: pi.id,
        message: `Stripe PaymentIntent status is "${pi.status}", not succeeded.`,
      };
    }
    const actualMinor = typeof pi.amount_received === 'number' ? pi.amount_received : -1;
    if (actualMinor !== params.expectedAmountMinor) {
      return {
        verified: false,
        verificationStatus: 'failed',
        message: `Stripe amount mismatch (expected ${params.expectedAmountMinor}, got ${actualMinor}).`,
      };
    }
    const actualCurrency = String(pi.currency || '').toUpperCase();
    if (!actualCurrency || actualCurrency !== params.expectedCurrency.toUpperCase()) {
      return {
        verified: false,
        verificationStatus: 'failed',
        message: `Stripe currency mismatch (expected ${params.expectedCurrency}, got ${actualCurrency || 'missing'}).`,
      };
    }
    if (pi.metadata?.invoiceId && pi.metadata.invoiceId !== params.invoiceId) {
      return {
        verified: false,
        verificationStatus: 'failed',
        message: 'Stripe PaymentIntent metadata invoiceId mismatch.',
      };
    }
    if (
      params.expectedOrganizationId &&
      pi.metadata?.organizationId &&
      pi.metadata.organizationId !== params.expectedOrganizationId
    ) {
      return {
        verified: false,
        verificationStatus: 'failed',
        message: 'Stripe PaymentIntent metadata organizationId mismatch.',
      };
    }
    return {
      verified: true,
      verificationStatus: 'verified',
      providerTransactionId: pi.id,
      amountMinor: actualMinor,
      currency: actualCurrency,
      message: 'Payment verified via Stripe PaymentIntents API.',
    };
  }

  return {
    verified: false,
    verificationStatus: 'failed',
    message: 'Stripe reference must be a valid Checkout Session ID (cs_...) or PaymentIntent ID (pi_...).',
  };
}

// -----------------------------------------------------------------------------
// Webhook Raw-Body Signature Verification
// -----------------------------------------------------------------------------
export function verifyPaystackWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!rawBody || rawBody.length === 0 || !signatureHeader || !secret) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return timingSafeEqualStr(expected, signatureHeader.trim());
}

export function verifyFlutterwaveWebhookSignature(params: {
  rawBody: Buffer;
  verifHashHeader?: string;
  flutterwaveSignatureHeader?: string;
  secretHash: string;
}): boolean {
  if (!params.secretHash) return false;
  if (params.verifHashHeader && timingSafeEqualStr(params.verifHashHeader.trim(), params.secretHash)) {
    return true;
  }
  if (params.flutterwaveSignatureHeader && params.rawBody && params.rawBody.length > 0) {
    const hmac = crypto
      .createHmac('sha256', params.secretHash)
      .update(params.rawBody)
      .digest('base64');
    return timingSafeEqualStr(hmac, params.flutterwaveSignatureHeader.trim());
  }
  return false;
}

export function constructVerifiedStripeWebhookEvent(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  webhookSecret: string
): Stripe.Event {
  if (!rawBody || rawBody.length === 0) {
    throw new Error('Missing raw request body for Stripe webhook verification.');
  }
  if (!signatureHeader) {
    throw new Error('Missing stripe-signature header.');
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_webhook_verify_only');
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
}

export interface NormalizedWebhookOutcome {
  eventId: string;
  eventType: string;
  reference: string;
  providerTransactionId?: string;
  outcome: PaymentVerificationStatus;
  amountMinor?: number;
  currency?: string;
  invoiceId?: string;
  organizationId?: string;
  failureReason?: string;
}

export function normalizePaystackWebhookPayload(
  payload: Record<string, unknown>
): NormalizedWebhookOutcome | null {
  const event = typeof payload.event === 'string' ? payload.event : '';
  const data = (
    payload.data && typeof payload.data === 'object' ? payload.data : {}
  ) as Record<string, unknown>;
  const metadata = (
    data.metadata && typeof data.metadata === 'object' ? data.metadata : {}
  ) as Record<string, unknown>;
  const nestedTx = (
    data.transaction && typeof data.transaction === 'object' ? data.transaction : {}
  ) as Record<string, unknown>;
  const reference =
    typeof data.reference === 'string' && data.reference
      ? data.reference
      : typeof data.transaction_reference === 'string' && data.transaction_reference
      ? data.transaction_reference
      : typeof nestedTx.reference === 'string'
      ? nestedTx.reference
      : '';
  const txId =
    data.id !== undefined
      ? String(data.id)
      : nestedTx.id !== undefined
      ? String(nestedTx.id)
      : '';
  const eventId = txId ? `${event}:${txId}` : `${event}:${reference}`;
  if (!event || !reference) return null;

  let outcome: PaymentVerificationStatus = 'pending';
  if (event === 'charge.success' && data.status === 'success') outcome = 'verified';
  else if (event === 'charge.failed') outcome = 'failed';
  else if (event.startsWith('refund.')) outcome = 'refunded';
  else if (event.startsWith('charge.dispute')) outcome = 'disputed';

  return {
    eventId,
    eventType: event,
    reference,
    providerTransactionId: txId || undefined,
    outcome,
    amountMinor:
      typeof data.amount === 'number' && Number.isFinite(data.amount)
        ? Math.round(data.amount)
        : undefined,
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase() : undefined,
    invoiceId: typeof metadata.invoiceId === 'string' ? metadata.invoiceId : undefined,
    organizationId:
      typeof metadata.organizationId === 'string' ? metadata.organizationId : undefined,
    failureReason: typeof data.gateway_response === 'string' ? data.gateway_response : undefined,
  };
}

export function normalizeFlutterwaveWebhookPayload(
  payload: Record<string, unknown>
): NormalizedWebhookOutcome | null {
  const event = typeof payload.event === 'string' ? payload.event : '';
  const data = (
    payload.data && typeof payload.data === 'object' ? payload.data : {}
  ) as Record<string, unknown>;
  const meta = (
    data.meta && typeof data.meta === 'object' ? data.meta : {}
  ) as Record<string, unknown>;
  const reference =
    typeof data.tx_ref === 'string' && data.tx_ref
      ? data.tx_ref
      : typeof data.txRef === 'string'
      ? data.txRef
      : '';
  const txId = data.id !== undefined ? String(data.id) : '';
  const eventId = txId ? `${event}:${txId}` : `${event}:${reference}`;
  if (!event || !reference) return null;

  let outcome: PaymentVerificationStatus = 'pending';
  if (event === 'charge.completed' && data.status === 'successful') outcome = 'verified';
  else if (event === 'charge.completed' && data.status === 'failed') outcome = 'failed';
  else if (event.includes('refund')) outcome = 'refunded';
  else if (event.includes('chargeback') || event.includes('dispute')) outcome = 'disputed';

  return {
    eventId,
    eventType: event,
    reference,
    providerTransactionId: txId || undefined,
    outcome,
    amountMinor:
      typeof data.amount === 'number' && Number.isFinite(data.amount)
        ? Math.round(data.amount * 100)
        : undefined,
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase() : undefined,
    invoiceId: typeof meta.invoiceId === 'string' ? meta.invoiceId : undefined,
    organizationId: typeof meta.organizationId === 'string' ? meta.organizationId : undefined,
    failureReason:
      typeof data.processor_response === 'string' ? data.processor_response : undefined,
  };
}

export function normalizeStripeWebhookEvent(event: Stripe.Event): NormalizedWebhookOutcome {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const metadata = (
    obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {}
  ) as Record<string, unknown>;

  let reference = '';
  if (typeof obj.payment_intent === 'string') reference = obj.payment_intent;
  else if (typeof obj.id === 'string') reference = obj.id;

  let outcome: PaymentVerificationStatus = 'pending';
  if (event.type === 'checkout.session.completed' && obj.payment_status === 'paid') {
    outcome = 'verified';
    reference = typeof obj.id === 'string' ? obj.id : reference;
  } else if (event.type === 'payment_intent.succeeded') {
    outcome = 'verified';
  } else if (
    event.type === 'payment_intent.payment_failed' ||
    event.type === 'checkout.session.expired'
  ) {
    outcome = 'failed';
  } else if (event.type === 'charge.refunded') {
    outcome = 'refunded';
  } else if (event.type.startsWith('charge.dispute.')) {
    outcome = 'disputed';
  }

  const amountVal =
    typeof obj.amount_received === 'number' && Number.isFinite(obj.amount_received)
      ? obj.amount_received
      : typeof obj.amount_total === 'number' && Number.isFinite(obj.amount_total)
      ? obj.amount_total
      : typeof obj.amount === 'number' && Number.isFinite(obj.amount)
      ? obj.amount
      : undefined;

  const providerTxId =
    typeof obj.payment_intent === 'string'
      ? obj.payment_intent
      : typeof obj.id === 'string'
      ? obj.id
      : undefined;

  return {
    eventId: event.id,
    eventType: event.type,
    reference,
    providerTransactionId: providerTxId,
    outcome,
    amountMinor: amountVal,
    currency: typeof obj.currency === 'string' ? obj.currency.toUpperCase() : undefined,
    invoiceId: typeof metadata.invoiceId === 'string' ? metadata.invoiceId : undefined,
    organizationId:
      typeof metadata.organizationId === 'string' ? metadata.organizationId : undefined,
  };
}
