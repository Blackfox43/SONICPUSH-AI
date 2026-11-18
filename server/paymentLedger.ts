import crypto from 'crypto';
import type Stripe from 'stripe';
import {
  SERVER_TIMESTAMP_SENTINEL,
  type AdminFirestoreAdapter,
} from './firebaseAdmin.ts';
import { logStructured, sanitizeErrorMessage } from './logger.ts';
import {
  signPaymentAttestation,
  toMinorUnits,
  verifyFlutterwaveWithProvider,
  verifyPaystackWithProvider,
  verifyStripeWithProvider,
  type CurrencyCode,
  type FetchLike,
  type NormalizedWebhookOutcome,
  type PaymentProvider,
  type PaymentVerificationStatus,
} from './payments.ts';

export type WebhookReconciliationStatus =
  | 'reconciled'
  | 'pending_retry'
  | 'quarantined'
  | 'ignored';

export interface ReferenceBindingDoc {
  id: string;
  bindingKey: string;
  provider: PaymentProvider;
  reference: string;
  invoiceId: string;
  organizationId: string;
  currency: CurrencyCode;
  expectedMinor: number;
  verificationStatus: PaymentVerificationStatus;
  providerTransactionId?: string;
  serverAttestation?: string;
  updatedAt: string;
  createdAt?: string;
}

export interface WebhookEventDoc {
  id: string;
  idempotencyKey: string;
  provider: PaymentProvider;
  eventId: string;
  eventType: string;
  reference: string;
  providerTransactionId?: string;
  invoiceId?: string;
  organizationId?: string;
  outcome: PaymentVerificationStatus;
  reconciliationStatus: WebhookReconciliationStatus;
  retryCount: number;
  lastError?: string;
  quarantineReason?: string;
  amountMinor?: number;
  currency?: string;
  processedAt: string;
  updatedAt: string;
  note?: string;
}

export class ReferenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceConflictError';
  }
}

export function makeBindingDocId(provider: PaymentProvider, reference: string): string {
  const hash = crypto.createHash('sha256').update(`${provider}:${reference}`).digest('hex').slice(0, 40);
  return `${provider}_${hash}`;
}

export function makeWebhookEventDocId(provider: PaymentProvider, eventId: string): string {
  const hash = crypto.createHash('sha256').update(`${provider}:${eventId}`).digest('hex').slice(0, 40);
  return `${provider}_${hash}`;
}

export interface WebhookProcessResult {
  received: boolean;
  duplicate: boolean;
  quarantined: boolean;
  retryable: boolean;
  provider: PaymentProvider;
  eventId: string;
  eventDocId: string;
  outcome: PaymentVerificationStatus;
  reconciliationStatus: WebhookReconciliationStatus;
  invoiceId?: string;
  note?: string;
}

export class FirestorePaymentRepository {
  private readonly db: AdminFirestoreAdapter;
  private readonly fetchImpl?: FetchLike;
  private readonly stripeClient?: Stripe;

  constructor(
    db: AdminFirestoreAdapter,
    options?: {
      fetchImpl?: FetchLike;
      stripeClient?: Stripe;
    }
  ) {
    this.db = db;
    this.fetchImpl = options?.fetchImpl;
    this.stripeClient = options?.stripeClient;
  }

  async getReferenceBinding(
    provider: PaymentProvider,
    reference: string
  ): Promise<ReferenceBindingDoc | null> {
    const id = makeBindingDocId(provider, reference);
    const doc = await this.db.getDoc('payment_reference_bindings', id);
    return doc ? (doc as unknown as ReferenceBindingDoc) : null;
  }

  async getWebhookEventByDocId(eventDocId: string): Promise<WebhookEventDoc | null> {
    const doc = await this.db.getDoc('payment_webhook_events', eventDocId);
    return doc ? (doc as unknown as WebhookEventDoc) : null;
  }

  async listOrganizationRecords(organizationId: string): Promise<{
    bindings: ReferenceBindingDoc[];
    webhooks: WebhookEventDoc[];
  }> {
    const [bindingsRaw, webhooksRaw] = await Promise.all([
      this.db.queryDocs(
        'payment_reference_bindings',
        [{ field: 'organizationId', op: '==' as const, value: organizationId }],
        { limit: 100 }
      ),
      this.db.queryDocs(
        'payment_webhook_events',
        [{ field: 'organizationId', op: '==' as const, value: organizationId }],
        { limit: 100 }
      ),
    ]);
    return {
      bindings: bindingsRaw as unknown as ReferenceBindingDoc[],
      webhooks: webhooksRaw as unknown as WebhookEventDoc[],
    };
  }

  async listAdminDiagnosticsWebhooks(limit = 50): Promise<WebhookEventDoc[]> {
    const rows = await this.db.queryDocs('payment_webhook_events', [], {
      orderBy: { field: 'processedAt', dir: 'desc' },
      limit,
    });
    return rows as unknown as WebhookEventDoc[];
  }

  async verifyAndBindReference(params: {
    provider: PaymentProvider;
    reference: string;
    transactionId?: string;
    invoiceId: string;
    invoiceOrganizationId: string;
    invoiceCurrency: CurrencyCode;
    invoiceAmount: number;
    isSuperAdmin: boolean;
  }): Promise<{
    verified: boolean;
    verificationStatus: PaymentVerificationStatus;
    providerTransactionId?: string;
    serverAttestation: string;
    invoiceReconciled: boolean;
    message: string;
  }> {
    const expectedMinor = toMinorUnits(params.invoiceAmount, params.invoiceCurrency);
    if (expectedMinor <= 0) {
      throw new Error('Invoice amount must be greater than zero.');
    }

    const bindingDocId = makeBindingDocId(params.provider, params.reference);

    // Pre-check reference conflict atomically in Firestore + legacy payments docs
    const existingPayments = await this.db
      .queryDocs(
        'payments',
        [{ field: 'reference', op: '==', value: params.reference }],
        { limit: 10 }
      )
      .catch(() => []);

    for (const p of existingPayments) {
      if (
        p.provider === params.provider &&
        (p.invoiceId !== params.invoiceId || p.organizationId !== params.invoiceOrganizationId)
      ) {
        throw new ReferenceConflictError(
          'Payment reference already exists on another invoice or organization.'
        );
      }
    }

    await this.db.runTransaction(async (tx) => {
      const existing = await tx.get('payment_reference_bindings', bindingDocId);
      if (existing) {
        if (existing.organizationId !== params.invoiceOrganizationId) {
          throw new ReferenceConflictError(
            'Payment reference is already bound to a different organization.'
          );
        }
        if (existing.invoiceId !== params.invoiceId) {
          throw new ReferenceConflictError(
            'Payment reference is already bound to a different invoice and cannot be reused.'
          );
        }
      }
      // Reserve/bind atomically before calling provider API so concurrent calls to two invoices conflict
      const nowIso = new Date().toISOString();
      await tx.set(
        'payment_reference_bindings',
        bindingDocId,
        {
          id: bindingDocId,
          bindingKey: `${params.provider}:${params.reference}`,
          provider: params.provider,
          reference: params.reference,
          invoiceId: params.invoiceId,
          organizationId: params.invoiceOrganizationId,
          currency: params.invoiceCurrency,
          expectedMinor,
          verificationStatus: existing?.verificationStatus || 'pending',
          ...(existing?.providerTransactionId
            ? { providerTransactionId: existing.providerTransactionId }
            : {}),
          createdAt: existing?.createdAt || nowIso,
          updatedAt: nowIso,
        },
        true
      );
    });

    // Authoritative provider verification
    let result;
    if (params.provider === 'paystack') {
      result = await verifyPaystackWithProvider({
        reference: params.reference,
        expectedAmountMinor: expectedMinor,
        expectedCurrency: params.invoiceCurrency,
        invoiceId: params.invoiceId,
        fetchImpl: this.fetchImpl,
      });
    } else if (params.provider === 'flutterwave') {
      result = await verifyFlutterwaveWithProvider({
        reference: params.reference,
        transactionId: params.transactionId || undefined,
        expectedAmountMinor: expectedMinor,
        expectedCurrency: params.invoiceCurrency,
        invoiceId: params.invoiceId,
        fetchImpl: this.fetchImpl,
      });
    } else if (params.provider === 'stripe') {
      result = await verifyStripeWithProvider({
        reference: params.reference,
        expectedAmountMinor: expectedMinor,
        expectedCurrency: params.invoiceCurrency,
        invoiceId: params.invoiceId,
        stripeClient: this.stripeClient,
      });
    } else {
      result = {
        verified: false,
        verificationStatus: 'pending' as PaymentVerificationStatus,
        message:
          'Manual bank transfer logged as pending. Only an authorized administrator can reconcile manual transfers.',
      };
    }

    const nowIso = new Date().toISOString();
    const serverAttestation = signPaymentAttestation({
      invoiceId: params.invoiceId,
      organizationId: params.invoiceOrganizationId,
      provider: params.provider,
      reference: params.reference,
      amountMinor: expectedMinor,
      currency: params.invoiceCurrency,
      verificationStatus: result.verificationStatus,
    });

    let invoiceReconciled = false;
    await this.db.runTransaction(async (tx) => {
      const existing = await tx.get('payment_reference_bindings', bindingDocId);
      if (existing && (existing.invoiceId !== params.invoiceId || existing.organizationId !== params.invoiceOrganizationId)) {
        throw new ReferenceConflictError('Payment reference conflict detected during persistence.');
      }

      await tx.set(
        'payment_reference_bindings',
        bindingDocId,
        {
          id: bindingDocId,
          bindingKey: `${params.provider}:${params.reference}`,
          provider: params.provider,
          reference: params.reference,
          invoiceId: params.invoiceId,
          organizationId: params.invoiceOrganizationId,
          currency: params.invoiceCurrency,
          expectedMinor,
          verificationStatus: result.verificationStatus,
          ...(result.providerTransactionId
            ? { providerTransactionId: result.providerTransactionId }
            : {}),
          serverAttestation,
          createdAt: existing?.createdAt || nowIso,
          updatedAt: nowIso,
        },
        true
      );

      if (result.verified && params.isSuperAdmin) {
        const inv = await tx.get('invoices', params.invoiceId);
        if (inv && inv.status !== 'paid' && inv.status !== 'refunded' && inv.status !== 'void') {
          await tx.update('invoices', params.invoiceId, {
            status: 'paid',
            verifiedPaymentRef: params.reference,
            paidAt: nowIso,
            updatedAt: SERVER_TIMESTAMP_SENTINEL,
          });
          invoiceReconciled = true;
        }
      }
    });

    return {
      verified: result.verified,
      verificationStatus: result.verificationStatus,
      providerTransactionId: result.providerTransactionId,
      serverAttestation,
      invoiceReconciled,
      message: result.message,
    };
  }

  async reconcilePayment(params: {
    invoiceId: string;
    paymentId?: string;
    provider: PaymentProvider;
    reference: string;
  }): Promise<{
    invoiceId: string;
    invoiceStatus: string;
    verificationStatus: PaymentVerificationStatus;
  }> {
    const bindingDocId = makeBindingDocId(params.provider, params.reference);
    const nowIso = new Date().toISOString();

    return this.db.runTransaction(async (tx) => {
      const binding = await tx.get('payment_reference_bindings', bindingDocId);
      if (!binding || binding.invoiceId !== params.invoiceId) {
        throw new Error('BINDING_NOT_FOUND');
      }

      const status = binding.verificationStatus as PaymentVerificationStatus;
      if (status !== 'verified' && status !== 'refunded' && status !== 'disputed') {
        throw new Error(`INVALID_STATE:${status}`);
      }

      const invoice = await tx.get('invoices', params.invoiceId);
      if (!invoice) {
        throw new Error('INVOICE_NOT_FOUND');
      }

      const targetInvoiceStatus =
        status === 'verified' ? 'paid' : status === 'refunded' ? 'refunded' : 'disputed';

      await tx.update('invoices', params.invoiceId, {
        status: targetInvoiceStatus,
        verifiedPaymentRef: params.reference,
        ...(targetInvoiceStatus === 'paid' ? { paidAt: nowIso } : {}),
        updatedAt: SERVER_TIMESTAMP_SENTINEL,
      });

      if (params.paymentId) {
        const paymentDoc = await tx.get('payments', params.paymentId);
        if (paymentDoc) {
          if (
            paymentDoc.invoiceId !== params.invoiceId ||
            paymentDoc.provider !== params.provider ||
            paymentDoc.reference !== params.reference
          ) {
            throw new ReferenceConflictError('Payment record does not match bound invoice/reference.');
          }
          await tx.update('payments', params.paymentId, {
            verificationStatus: status,
            verificationSource: 'server_api',
            verifiedAt: nowIso,
            ...(binding.providerTransactionId
              ? { providerTransactionId: binding.providerTransactionId }
              : {}),
            updatedAt: SERVER_TIMESTAMP_SENTINEL,
          });
        }
      }

      return {
        invoiceId: params.invoiceId,
        invoiceStatus: targetInvoiceStatus,
        verificationStatus: status,
      };
    });
  }

  async processWebhook(params: {
    provider: PaymentProvider;
    normalized: NormalizedWebhookOutcome;
    isRetry?: boolean;
  }): Promise<WebhookProcessResult> {
    const { provider, normalized } = params;
    const eventDocId = makeWebhookEventDocId(provider, normalized.eventId);
    const nowIso = new Date().toISOString();

    // Step 1: Idempotency check in shared Firestore
    const existingWebhook = await this.db.getDoc('payment_webhook_events', eventDocId);
    if (
      existingWebhook &&
      existingWebhook.reconciliationStatus !== 'pending_retry' &&
      !params.isRetry
    ) {
      return {
        received: true,
        duplicate: true,
        quarantined: existingWebhook.reconciliationStatus === 'quarantined',
        retryable: false,
        provider,
        eventId: normalized.eventId,
        eventDocId,
        outcome: (existingWebhook.outcome as PaymentVerificationStatus) || normalized.outcome,
        reconciliationStatus:
          (existingWebhook.reconciliationStatus as WebhookReconciliationStatus) || 'reconciled',
        invoiceId:
          typeof existingWebhook.invoiceId === 'string' ? existingWebhook.invoiceId : undefined,
        note: typeof existingWebhook.note === 'string' ? existingWebhook.note : undefined,
      };
    }

    const prevRetryCount =
      existingWebhook && typeof existingWebhook.retryCount === 'number'
        ? existingWebhook.retryCount
        : 0;

    // Step 2: Resolve bound reference / invoice / payments from Firestore
    const bindingDocId = normalized.reference
      ? makeBindingDocId(provider, normalized.reference)
      : '';
    const existingBinding = bindingDocId
      ? await this.db.getDoc('payment_reference_bindings', bindingDocId)
      : null;

    const matchingPayments = normalized.reference
      ? await this.db
          .queryDocs(
            'payments',
            [{ field: 'reference', op: '==', value: normalized.reference }],
            { limit: 10 }
          )
          .catch(() => [])
      : [];

    const providerMatchedPayments = matchingPayments.filter((p) => p.provider === provider);

    const resolvedInvoiceId =
      (existingBinding?.invoiceId as string | undefined) ||
      normalized.invoiceId ||
      (providerMatchedPayments[0]?.invoiceId as string | undefined);

    if (!resolvedInvoiceId) {
      const quarantineReason = 'Unmatched invoice or missing reference binding for webhook event.';
      await this.persistQuarantinedWebhook({
        eventDocId,
        provider,
        normalized,
        outcome: normalized.outcome,
        quarantineReason,
        retryCount: prevRetryCount,
        nowIso,
      });
      logStructured('warn', 'webhook_quarantined_unmatched', {
        provider,
        eventId: normalized.eventId,
        eventType: normalized.eventType,
      });
      return {
        received: true,
        duplicate: false,
        quarantined: true,
        retryable: false,
        provider,
        eventId: normalized.eventId,
        eventDocId,
        outcome: normalized.outcome,
        reconciliationStatus: 'quarantined',
        note: quarantineReason,
      };
    }

    const invoice = await this.db.getDoc('invoices', resolvedInvoiceId);
    if (!invoice || typeof invoice.organizationId !== 'string') {
      const quarantineReason = `Referenced invoice (${resolvedInvoiceId}) does not exist in Firestore.`;
      await this.persistQuarantinedWebhook({
        eventDocId,
        provider,
        normalized,
        invoiceId: resolvedInvoiceId,
        outcome: normalized.outcome,
        quarantineReason,
        retryCount: prevRetryCount,
        nowIso,
      });
      return {
        received: true,
        duplicate: false,
        quarantined: true,
        retryable: false,
        provider,
        eventId: normalized.eventId,
        eventDocId,
        outcome: normalized.outcome,
        reconciliationStatus: 'quarantined',
        invoiceId: resolvedInvoiceId,
        note: quarantineReason,
      };
    }

    const invoiceOrgId = invoice.organizationId as string;
    const invoiceCurrency = ((invoice.currency as string) || 'NGN').toUpperCase() as CurrencyCode;
    const invoiceAmount = Number(invoice.amount || 0);
    const expectedMinor = toMinorUnits(invoiceAmount, invoiceCurrency);

    // Step 3: Validate cross-org & reference reuse consistency
    if (normalized.organizationId && normalized.organizationId !== invoiceOrgId) {
      const quarantineReason = 'Webhook metadata organizationId does not match authoritative invoice organization.';
      await this.persistQuarantinedWebhook({
        eventDocId,
        provider,
        normalized,
        invoiceId: resolvedInvoiceId,
        organizationId: invoiceOrgId,
        outcome: 'failed',
        quarantineReason,
        retryCount: prevRetryCount,
        nowIso,
      });
      return {
        received: true,
        duplicate: false,
        quarantined: true,
        retryable: false,
        provider,
        eventId: normalized.eventId,
        eventDocId,
        outcome: 'failed',
        reconciliationStatus: 'quarantined',
        invoiceId: resolvedInvoiceId,
        note: quarantineReason,
      };
    }

    if (
      existingBinding &&
      (existingBinding.invoiceId !== resolvedInvoiceId || existingBinding.organizationId !== invoiceOrgId)
    ) {
      const quarantineReason = 'Payment reference is bound to a different invoice or organization.';
      await this.persistQuarantinedWebhook({
        eventDocId,
        provider,
        normalized,
        invoiceId: resolvedInvoiceId,
        organizationId: invoiceOrgId,
        outcome: 'failed',
        quarantineReason,
        retryCount: prevRetryCount,
        nowIso,
      });
      return {
        received: true,
        duplicate: false,
        quarantined: true,
        retryable: false,
        provider,
        eventId: normalized.eventId,
        eventDocId,
        outcome: 'failed',
        reconciliationStatus: 'quarantined',
        invoiceId: resolvedInvoiceId,
        note: quarantineReason,
      };
    }

    // Step 4: Validate webhook amount & currency before trusting settlement
    if (
      normalized.outcome === 'verified' &&
      ((normalized.amountMinor !== undefined && normalized.amountMinor !== expectedMinor) ||
        (normalized.currency && normalized.currency.toUpperCase() !== invoiceCurrency))
    ) {
      const quarantineReason = `Webhook amount/currency mismatch against invoice (${expectedMinor} ${invoiceCurrency}).`;
      await this.persistQuarantinedWebhook({
        eventDocId,
        provider,
        normalized,
        invoiceId: resolvedInvoiceId,
        organizationId: invoiceOrgId,
        outcome: 'failed',
        quarantineReason,
        retryCount: prevRetryCount,
        nowIso,
      });
      return {
        received: true,
        duplicate: false,
        quarantined: true,
        retryable: false,
        provider,
        eventId: normalized.eventId,
        eventDocId,
        outcome: 'failed',
        reconciliationStatus: 'quarantined',
        invoiceId: resolvedInvoiceId,
        note: quarantineReason,
      };
    }

    // Step 5: Authoritative Provider Verification API confirmation for verified settlements
    let finalOutcome: PaymentVerificationStatus = normalized.outcome;
    let verifiedTxId = normalized.providerTransactionId;
    let note = `Processed ${provider} ${normalized.eventType} event.`;

    if (finalOutcome === 'verified') {
      let apiCheck;
      if (provider === 'paystack') {
        apiCheck = await verifyPaystackWithProvider({
          reference: normalized.reference,
          expectedAmountMinor: expectedMinor,
          expectedCurrency: invoiceCurrency,
          invoiceId: resolvedInvoiceId,
          fetchImpl: this.fetchImpl,
        });
      } else if (provider === 'flutterwave') {
        apiCheck = await verifyFlutterwaveWithProvider({
          reference: normalized.reference,
          transactionId: normalized.providerTransactionId,
          expectedAmountMinor: expectedMinor,
          expectedCurrency: invoiceCurrency,
          invoiceId: resolvedInvoiceId,
          fetchImpl: this.fetchImpl,
        });
      } else if (provider === 'stripe') {
        apiCheck = await verifyStripeWithProvider({
          reference: normalized.reference,
          expectedAmountMinor: expectedMinor,
          expectedCurrency: invoiceCurrency,
          invoiceId: resolvedInvoiceId,
          stripeClient: this.stripeClient,
        });
      }

      if (apiCheck && !apiCheck.verified) {
        const quarantineReason = `Authoritative provider API check failed: ${apiCheck.message}`;
        await this.persistQuarantinedWebhook({
          eventDocId,
          provider,
          normalized,
          invoiceId: resolvedInvoiceId,
          organizationId: invoiceOrgId,
          outcome: apiCheck.verificationStatus,
          quarantineReason,
          retryCount: prevRetryCount,
          nowIso,
        });
        return {
          received: true,
          duplicate: false,
          quarantined: true,
          retryable: false,
          provider,
          eventId: normalized.eventId,
          eventDocId,
          outcome: apiCheck.verificationStatus,
          reconciliationStatus: 'quarantined',
          invoiceId: resolvedInvoiceId,
          note: quarantineReason,
        };
      }
      if (apiCheck?.providerTransactionId) {
        verifiedTxId = apiCheck.providerTransactionId;
      }
      if (apiCheck?.message) {
        note = apiCheck.message;
      }
    }

    // Step 6: Atomic Firestore reconciliation transaction
    const serverAttestation = signPaymentAttestation({
      invoiceId: resolvedInvoiceId,
      organizationId: invoiceOrgId,
      provider,
      reference: normalized.reference,
      amountMinor: expectedMinor,
      currency: invoiceCurrency,
      verificationStatus: finalOutcome,
    });

    try {
      const txResult = await this.db.runTransaction(async (tx) => {
        const txWebhook = await tx.get('payment_webhook_events', eventDocId);
        if (
          txWebhook &&
          txWebhook.reconciliationStatus !== 'pending_retry' &&
          !params.isRetry
        ) {
          return {
            duplicate: true,
            outcome: (txWebhook.outcome as PaymentVerificationStatus) || finalOutcome,
            reconciliationStatus:
              (txWebhook.reconciliationStatus as WebhookReconciliationStatus) || 'reconciled',
          };
        }

        const txInvoice = await tx.get('invoices', resolvedInvoiceId);
        if (!txInvoice) {
          throw new Error('INVOICE_MISSING_IN_TX');
        }

        if (bindingDocId) {
          const txBinding = await tx.get('payment_reference_bindings', bindingDocId);
          if (
            txBinding &&
            (txBinding.invoiceId !== resolvedInvoiceId || txBinding.organizationId !== invoiceOrgId)
          ) {
            throw new ReferenceConflictError('Payment reference bound to conflicting invoice.');
          }
          await tx.set(
            'payment_reference_bindings',
            bindingDocId,
            {
              id: bindingDocId,
              bindingKey: `${provider}:${normalized.reference}`,
              provider,
              reference: normalized.reference,
              invoiceId: resolvedInvoiceId,
              organizationId: invoiceOrgId,
              currency: invoiceCurrency,
              expectedMinor,
              verificationStatus: finalOutcome,
              ...(verifiedTxId ? { providerTransactionId: verifiedTxId } : {}),
              serverAttestation,
              createdAt: txBinding?.createdAt || nowIso,
              updatedAt: nowIso,
            },
            true
          );
        }

        // Update invoice state atomically based on verified/failed/refunded/disputed outcome
        const currentInvStatus = String(txInvoice.status || 'sent');
        if (finalOutcome === 'verified') {
          if (currentInvStatus !== 'refunded' && currentInvStatus !== 'disputed' && currentInvStatus !== 'void') {
            await tx.update('invoices', resolvedInvoiceId, {
              status: 'paid',
              verifiedPaymentRef: normalized.reference,
              paidAt: txInvoice.paidAt || nowIso,
              updatedAt: SERVER_TIMESTAMP_SENTINEL,
            });
          }
        } else if (finalOutcome === 'refunded') {
          await tx.update('invoices', resolvedInvoiceId, {
            status: 'refunded',
            verifiedPaymentRef: normalized.reference,
            updatedAt: SERVER_TIMESTAMP_SENTINEL,
          });
        } else if (finalOutcome === 'disputed') {
          await tx.update('invoices', resolvedInvoiceId, {
            status: 'disputed',
            verifiedPaymentRef: normalized.reference,
            updatedAt: SERVER_TIMESTAMP_SENTINEL,
          });
        } else if (finalOutcome === 'failed' && currentInvStatus === 'awaiting_verification') {
          await tx.update('invoices', resolvedInvoiceId, {
            status: 'sent',
            updatedAt: SERVER_TIMESTAMP_SENTINEL,
          });
        }

        // Update matching payment docs inside transaction, or create canonical payment doc if absent
        if (providerMatchedPayments.length > 0) {
          for (const pm of providerMatchedPayments) {
            const pmId = String(pm.id || '');
            if (!pmId) continue;
            const livePm = await tx.get('payments', pmId);
            if (!livePm || livePm.invoiceId !== resolvedInvoiceId) continue;
            await tx.update('payments', pmId, {
              verificationStatus: finalOutcome,
              verificationSource: 'webhook',
              webhookEventId: eventDocId,
              ...(verifiedTxId ? { providerTransactionId: verifiedTxId } : {}),
              ...(finalOutcome === 'verified' ? { verifiedAt: nowIso } : {}),
              ...(normalized.failureReason ? { failureReason: normalized.failureReason.slice(0, 380) } : {}),
              serverAttestation,
              updatedAt: SERVER_TIMESTAMP_SENTINEL,
            });
          }
        } else if (
          finalOutcome === 'verified' ||
          finalOutcome === 'failed' ||
          finalOutcome === 'refunded' ||
          finalOutcome === 'disputed'
        ) {
          const canonicalPayId = `pay_wh_${eventDocId.slice(0, 32)}`;
          const existingCanonical = await tx.get('payments', canonicalPayId);
          const ownerId = String(txInvoice.ownerId || 'system');
          const assignedUserIds = Array.isArray(txInvoice.assignedUserIds)
            ? (txInvoice.assignedUserIds as string[])
            : [ownerId];
          await tx.set(
            'payments',
            canonicalPayId,
            {
              id: canonicalPayId,
              organizationId: invoiceOrgId,
              ownerId,
              assignedUserIds,
              invoiceId: resolvedInvoiceId,
              provider,
              reference: normalized.reference,
              ...(verifiedTxId ? { providerTransactionId: verifiedTxId } : {}),
              currency: invoiceCurrency,
              amount: invoiceAmount,
              verificationStatus: finalOutcome,
              verificationSource: 'webhook',
              webhookEventId: eventDocId,
              ...(finalOutcome === 'verified' ? { verifiedAt: nowIso } : {}),
              ...(normalized.failureReason ? { failureReason: normalized.failureReason.slice(0, 380) } : {}),
              serverAttestation,
              createdAt: existingCanonical?.createdAt || SERVER_TIMESTAMP_SENTINEL,
              updatedAt: SERVER_TIMESTAMP_SENTINEL,
            },
            true
          );
        }

        await tx.set(
          'payment_webhook_events',
          eventDocId,
          {
            id: eventDocId,
            idempotencyKey: `${provider}:${normalized.eventId}`,
            provider,
            eventId: normalized.eventId,
            eventType: normalized.eventType,
            reference: normalized.reference,
            ...(verifiedTxId ? { providerTransactionId: verifiedTxId } : {}),
            invoiceId: resolvedInvoiceId,
            organizationId: invoiceOrgId,
            outcome: finalOutcome,
            reconciliationStatus: 'reconciled',
            retryCount: prevRetryCount,
            ...(normalized.amountMinor !== undefined ? { amountMinor: normalized.amountMinor } : {}),
            ...(normalized.currency ? { currency: normalized.currency } : {}),
            processedAt: existingWebhook?.processedAt || nowIso,
            updatedAt: nowIso,
            note,
          },
          true
        );

        return {
          duplicate: false,
          outcome: finalOutcome,
          reconciliationStatus: 'reconciled' as WebhookReconciliationStatus,
        };
      });

      return {
        received: true,
        duplicate: txResult.duplicate,
        quarantined: false,
        retryable: false,
        provider,
        eventId: normalized.eventId,
        eventDocId,
        outcome: txResult.outcome,
        reconciliationStatus: txResult.reconciliationStatus,
        invoiceId: resolvedInvoiceId,
        note,
      };
    } catch (err) {
      const errMsg = sanitizeErrorMessage(err, 'Firestore reconciliation transaction failed.');
      logStructured('error', 'webhook_reconciliation_failed', {
        provider,
        eventId: normalized.eventId,
        invoiceId: resolvedInvoiceId,
        error: errMsg,
      });

      // Best-effort persist pending_retry state so provider or admin retry can complete safely
      try {
        await this.db.setDoc(
          'payment_webhook_events',
          eventDocId,
          {
            id: eventDocId,
            idempotencyKey: `${provider}:${normalized.eventId}`,
            provider,
            eventId: normalized.eventId,
            eventType: normalized.eventType,
            reference: normalized.reference,
            ...(verifiedTxId ? { providerTransactionId: verifiedTxId } : {}),
            invoiceId: resolvedInvoiceId,
            organizationId: invoiceOrgId,
            outcome: finalOutcome,
            reconciliationStatus: 'pending_retry',
            retryCount: prevRetryCount + 1,
            lastError: errMsg,
            ...(normalized.amountMinor !== undefined ? { amountMinor: normalized.amountMinor } : {}),
            ...(normalized.currency ? { currency: normalized.currency } : {}),
            processedAt: existingWebhook?.processedAt || nowIso,
            updatedAt: nowIso,
            note: 'Awaiting retry after transient Firestore reconciliation failure.',
          },
          true
        );
      } catch {
        // Firestore completely unreachable; provider retry HTTP 500 still protects consistency
      }

      return {
        received: false,
        duplicate: false,
        quarantined: false,
        retryable: true,
        provider,
        eventId: normalized.eventId,
        eventDocId,
        outcome: finalOutcome,
        reconciliationStatus: 'pending_retry',
        invoiceId: resolvedInvoiceId,
        note: errMsg,
      };
    }
  }

  async retryPendingWebhook(eventDocId: string): Promise<WebhookProcessResult> {
    const existing = await this.getWebhookEventByDocId(eventDocId);
    if (!existing) {
      throw new Error('WEBHOOK_EVENT_NOT_FOUND');
    }
    if (existing.reconciliationStatus === 'reconciled') {
      return {
        received: true,
        duplicate: true,
        quarantined: false,
        retryable: false,
        provider: existing.provider,
        eventId: existing.eventId,
        eventDocId,
        outcome: existing.outcome,
        reconciliationStatus: 'reconciled',
        invoiceId: existing.invoiceId,
        note: 'Webhook already reconciled.',
      };
    }
    return this.processWebhook({
      provider: existing.provider,
      isRetry: true,
      normalized: {
        eventId: existing.eventId,
        eventType: existing.eventType,
        reference: existing.reference,
        providerTransactionId: existing.providerTransactionId,
        outcome: existing.outcome,
        amountMinor: existing.amountMinor,
        currency: existing.currency,
        invoiceId: existing.invoiceId,
        organizationId: existing.organizationId,
      },
    });
  }

  private async persistQuarantinedWebhook(params: {
    eventDocId: string;
    provider: PaymentProvider;
    normalized: NormalizedWebhookOutcome;
    invoiceId?: string;
    organizationId?: string;
    outcome: PaymentVerificationStatus;
    quarantineReason: string;
    retryCount: number;
    nowIso: string;
  }): Promise<void> {
    await this.db.setDoc(
      'payment_webhook_events',
      params.eventDocId,
      {
        id: params.eventDocId,
        idempotencyKey: `${params.provider}:${params.normalized.eventId}`,
        provider: params.provider,
        eventId: params.normalized.eventId,
        eventType: params.normalized.eventType,
        reference: params.normalized.reference,
        ...(params.normalized.providerTransactionId
          ? { providerTransactionId: params.normalized.providerTransactionId }
          : {}),
        ...(params.invoiceId ? { invoiceId: params.invoiceId } : {}),
        ...(params.organizationId ? { organizationId: params.organizationId } : {}),
        outcome: params.outcome,
        reconciliationStatus: 'quarantined',
        retryCount: params.retryCount,
        quarantineReason: params.quarantineReason.slice(0, 400),
        ...(params.normalized.amountMinor !== undefined
          ? { amountMinor: params.normalized.amountMinor }
          : {}),
        ...(params.normalized.currency ? { currency: params.normalized.currency } : {}),
        processedAt: params.nowIso,
        updatedAt: params.nowIso,
        note: params.quarantineReason.slice(0, 400),
      },
      true
    );
  }
}
