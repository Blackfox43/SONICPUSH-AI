import React, { useEffect, useState, useCallback } from 'react';
import { CreditCard, ShieldCheck, Plus, RefreshCw, AlertTriangle, CheckCircle2, Activity, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { getJsonApi, postJsonApi } from '../../lib/api';
import { formatMoney } from '../../lib/currency';
import { clampStr, createScopedDoc, makeDocId } from '../../lib/firebase';
import type { CurrencyCode, InvoiceRecord, PaymentRecord, UserRole } from '../../types/sonicpush';

interface ServerLedgerResponse {
  bindings: Array<{
    bindingKey: string;
    provider: string;
    reference: string;
    invoiceId: string;
    verificationStatus: string;
    providerTransactionId?: string;
    updatedAt: string;
  }>;
  webhooks: Array<{
    id?: string;
    idempotencyKey: string;
    provider: string;
    eventId: string;
    eventType: string;
    reference: string;
    outcome: string;
    reconciliationStatus?: string;
    processedAt: string;
    note?: string;
  }>;
}

interface AdminDiagnosticsResponse {
  timestamp: string;
  providers: {
    geminiConfigured: boolean;
    paystackConfigured: boolean;
    flutterwaveConfigured: boolean;
    flutterwaveWebhookConfigured: boolean;
    stripeConfigured: boolean;
    stripeWebhookConfigured: boolean;
  };
  firebaseAdmin: {
    initialized: boolean;
    firestoreReady: boolean;
    storageReady: boolean;
    authReady: boolean;
    iamStatus: string;
    diagnosticNote?: string;
  };
  webhookSummary: {
    totalRecent: number;
    pendingRetryCount: number;
    quarantinedCount: number;
    recentEvents: Array<{
      id: string;
      provider: string;
      eventId: string;
      eventType: string;
      reference: string;
      outcome: string;
      reconciliationStatus: string;
      retryCount: number;
      processedAt: string;
      note?: string;
    }>;
  };
  audioCleanup: {
    failedSongsCount: number;
    recentLogs: Array<{
      id: string;
      songId: string;
      status: string;
      attemptedAt: string;
      error?: string;
    }>;
  };
  aiQuota: {
    mode: string;
    degradedReason?: string;
  };
}

export const PaymentsAdminView: React.FC<{ initialTab?: 'payments' | 'admin' }> = ({
  initialTab = 'payments',
}) => {
  const { user, isSuperAdmin, currency, invoices, payments, aiUsageLogs, allUsers, artists, campaigns } =
    useWorkspace();
  const { notify } = useToast();

  const [tab, setTab] = useState<'payments' | 'admin'>(
    initialTab === 'admin' && isSuperAdmin ? 'admin' : 'payments'
  );

  // Invoice form
  const [clientName, setClientName] = useState('');
  const [billingType, setBillingType] = useState<InvoiceRecord['billingType']>('one_time_campaign');
  const [packageTier, setPackageTier] = useState('GROWTH');
  const [invCurrency, setInvCurrency] = useState<CurrencyCode>(currency);
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(new Date().toISOString().slice(0, 10));
  const [savingInv, setSavingInv] = useState(false);

  // Payment verification check state
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [provider, setProvider] = useState<PaymentRecord['provider']>('paystack');
  const [reference, setReference] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [serverLedger, setServerLedger] = useState<ServerLedgerResponse>({ bindings: [], webhooks: [] });
  const [diagnostics, setDiagnostics] = useState<AdminDiagnosticsResponse | null>(null);
  const [runningCleanup, setRunningCleanup] = useState(false);
  const [retryingEventId, setRetryingEventId] = useState<string | null>(null);

  const refreshServerLedger = useCallback(async () => {
    try {
      const data = await getJsonApi<ServerLedgerResponse>(
        `/api/payments/ledger?organizationId=${encodeURIComponent(user.organizationId)}`
      );
      setServerLedger(data);
    } catch {
      // Non-blocking if ledger endpoint is momentarily unreachable
    }
  }, [user.organizationId]);

  const refreshAdminDiagnostics = useCallback(async () => {
    if (!isSuperAdmin) return;
    try {
      const diag = await getJsonApi<AdminDiagnosticsResponse>('/api/admin/diagnostics');
      setDiagnostics(diag);
    } catch {
      // Non-blocking
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    void refreshServerLedger();
    if (isSuperAdmin && tab === 'admin') {
      void refreshAdminDiagnostics();
    }
  }, [refreshServerLedger, refreshAdminDiagnostics, isSuperAdmin, tab]);

  const handleCreateInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientName.trim() || !amount.trim()) return;
    setSavingInv(true);
    try {
      await createScopedDoc('invoices', makeDocId('inv'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        clientName: clampStr(clientName, 160),
        packageTier,
        billingType,
        currency: invCurrency,
        amount: Math.max(0, Number(amount) || 0),
        dueDate,
        status: 'sent',
      });
      setClientName('');
      setAmount('');
      notify('Invoice created and saved.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to create invoice.', 'error');
    } finally {
      setSavingInv(false);
    }
  };

  const handleRecordAndVerifyPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    const inv = invoices.find((i) => i.id === (selectedInvoiceId || invoices[0]?.id));
    if (!inv || !reference.trim()) {
      notify('Select an invoice and enter a provider transaction reference.', 'error');
      return;
    }

    setVerifying(true);
    try {
      // Server retrieves the authoritative invoice & expected minor-unit amount directly from Firestore
      const verifyRes = await postJsonApi<{
        verified: boolean;
        verificationStatus: PaymentRecord['verificationStatus'];
        providerTransactionId?: string;
        serverAttestation?: string;
        invoiceReconciled?: boolean;
        message?: string;
      }>('/api/payments/verify', {
        invoiceId: inv.id,
        provider,
        reference: reference.trim(),
        ...(transactionId.trim() ? { transactionId: transactionId.trim() } : {}),
      });

      const paymentId = makeDocId('pay');
      // Client create strictly records server-bound non-settled state; verified reconciliation happens via server endpoint
      const initialCreateStatus: 'pending' | 'awaiting_provider_integration' =
        verifyRes.verificationStatus === 'awaiting_provider_integration'
          ? 'awaiting_provider_integration'
          : 'pending';

      await createScopedDoc('payments', paymentId, {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        invoiceId: inv.id,
        provider,
        reference: clampStr(reference, 160),
        ...(verifyRes.providerTransactionId
          ? { providerTransactionId: clampStr(verifyRes.providerTransactionId, 160) }
          : {}),
        currency: inv.currency,
        amount: inv.amount,
        verificationStatus: initialCreateStatus,
        verificationSource: 'server_api',
        ...(verifyRes.serverAttestation
          ? { serverAttestation: clampStr(verifyRes.serverAttestation, 256) }
          : {}),
      });

      if (isSuperAdmin && verifyRes.verified) {
        await postJsonApi('/api/payments/reconcile', {
          invoiceId: inv.id,
          paymentId,
          provider,
          reference: reference.trim(),
        });
      }

      setReference('');
      setTransactionId('');
      await refreshServerLedger();
      notify(
        verifyRes.message ||
          (verifyRes.verified
            ? 'Payment verified via provider API.'
            : 'Transaction recorded as awaiting provider verification.'),
        verifyRes.verified ? 'success' : 'info'
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Payment check failed.', 'error');
    } finally {
      setVerifying(false);
    }
  };

  const handleReconcilePayment = async (p: PaymentRecord) => {
    if (!isSuperAdmin) return;
    try {
      await postJsonApi('/api/payments/reconcile', {
        invoiceId: p.invoiceId,
        paymentId: p.id,
        provider: p.provider,
        reference: p.reference,
      });
      await refreshServerLedger();
      notify(`Reconciled payment reference ${p.reference}.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Reconciliation requires verified server/webhook confirmation.', 'error');
    }
  };

  const handleRoleUpdate = async (targetUid: string, role: UserRole) => {
    try {
      const res = await postJsonApi<{ ok: boolean; claimsSynced?: boolean; claimsNote?: string }>(
        `/api/admin/users/${encodeURIComponent(targetUid)}/role`,
        { role }
      );
      notify(
        res.claimsSynced
          ? `Updated role to ${role} and synced Auth custom claims.`
          : `Updated role to ${role}${res.claimsNote ? ` (${res.claimsNote})` : ''}.`,
        'success'
      );
      void refreshAdminDiagnostics();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update user role.', 'error');
    }
  };

  const handleRetryWebhook = async (eventDocId: string) => {
    setRetryingEventId(eventDocId);
    try {
      await postJsonApi(`/api/payments/webhooks/${encodeURIComponent(eventDocId)}/retry`, {});
      notify('Webhook reconciliation retried cleanly.', 'success');
      await Promise.all([refreshAdminDiagnostics(), refreshServerLedger()]);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Webhook retry failed.', 'error');
    } finally {
      setRetryingEventId(null);
    }
  };

  const handleRunAudioCleanup = async () => {
    setRunningCleanup(true);
    try {
      const summary = await postJsonApi<{ scanned: number; deleted: number; failed: number }>(
        '/api/admin/audio/cleanup',
        { limit: 50 }
      );
      notify(
        `Audio cleanup complete: scanned ${summary.scanned}, deleted ${summary.deleted}, failed ${summary.failed}.`,
        summary.failed > 0 ? 'info' : 'success'
      );
      await refreshAdminDiagnostics();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Audio retention cleanup failed.', 'error');
    } finally {
      setRunningCleanup(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">
            {tab === 'admin' ? 'Super Admin Governance & AI Telemetry' : 'Payments, Invoices & Subscriptions'}
          </h1>
          <p className="text-sm text-zinc-400">
            Server-verified Paystack, Flutterwave, and Stripe reconciliation with idempotent raw-body webhook validation.
          </p>
        </div>

        {isSuperAdmin && (
          <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#121216] border border-white/10">
            <button
              type="button"
              onClick={() => setTab('payments')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                tab === 'payments' ? 'bg-[#FF5500] text-white' : 'text-zinc-400 hover:text-white'
              }`}
            >
              Invoices & Payments
            </button>
            <button
              type="button"
              onClick={() => setTab('admin')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                tab === 'admin' ? 'bg-[#FF5500] text-white' : 'text-zinc-400 hover:text-white'
              }`}
            >
              Super Admin Console
            </button>
          </div>
        )}
      </div>

      {tab === 'admin' && isSuperAdmin ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-white/10 bg-[#121216] p-4">
              <p className="text-xs text-zinc-400">Platform Users</p>
              <p className="font-mono-tabular text-2xl font-bold text-white mt-1">{allUsers.length}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#121216] p-4">
              <p className="text-xs text-zinc-400">All Artists</p>
              <p className="font-mono-tabular text-2xl font-bold text-white mt-1">{artists.length}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#121216] p-4">
              <p className="text-xs text-zinc-400">All Campaigns</p>
              <p className="font-mono-tabular text-2xl font-bold text-[#FF5500] mt-1">{campaigns.length}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#121216] p-4">
              <p className="text-xs text-zinc-400">AI Requests Logged</p>
              <p className="font-mono-tabular text-2xl font-bold text-[#8B5CF6] mt-1">{aiUsageLogs.length}</p>
            </div>
          </div>

          {/* User & Role Management */}
          <div className="rounded-xl border border-white/10 bg-[#121216] overflow-x-auto">
            <div className="p-4 border-b border-white/10 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[#FF5500]" />
              <h2 className="font-display text-sm font-semibold text-white">User Accounts & Roles</h2>
            </div>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10 text-xs text-zinc-400">
                  <th className="py-3 px-4 font-medium">User</th>
                  <th className="py-3 px-4 font-medium">Organization ID</th>
                  <th className="py-3 px-4 font-medium">Currency</th>
                  <th className="py-3 px-4 font-medium">Role</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10 text-xs">
                {allUsers.map((u) => (
                  <tr key={u.uid}>
                    <td className="py-3 px-4">
                      <p className="font-medium text-white">{u.displayName}</p>
                      <p className="text-zinc-400">{u.email}</p>
                    </td>
                    <td className="py-3 px-4 font-mono-tabular text-zinc-400">{u.organizationId}</td>
                    <td className="py-3 px-4 font-mono-tabular text-zinc-300">{u.preferredCurrency}</td>
                    <td className="py-3 px-4">
                      <select
                        value={u.role}
                        onChange={(e) => void handleRoleUpdate(u.uid, e.target.value as UserRole)}
                        className="rounded border border-white/10 bg-[#18181E] px-2 py-1 text-xs text-white"
                      >
                        <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                        <option value="PROMOTER">PROMOTER</option>
                        <option value="ARTIST">ARTIST</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Platform Diagnostics, Webhook Retry & Audio Cleanup */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl border border-white/10 bg-[#121216] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-[#FF5500]" />
                  <h2 className="font-display text-sm font-semibold text-white">
                    System & Provider Readiness
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => void refreshAdminDiagnostics()}
                  className="text-xs text-zinc-400 hover:text-white inline-flex items-center gap-1"
                >
                  <RefreshCw className="h-3 w-3" />
                  Refresh
                </button>
              </div>
              {diagnostics ? (
                <div className="space-y-2 text-xs">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-[#18181E] p-2.5">
                      <p className="text-zinc-400">Admin SDK IAM</p>
                      <p className="font-mono-tabular text-white mt-0.5">{diagnostics.firebaseAdmin.iamStatus}</p>
                    </div>
                    <div className="rounded-lg bg-[#18181E] p-2.5">
                      <p className="text-zinc-400">AI Quota Limiter</p>
                      <p className="font-mono-tabular text-white mt-0.5">{diagnostics.aiQuota.mode}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {[
                      { label: 'Gemini', ok: diagnostics.providers.geminiConfigured },
                      { label: 'Paystack', ok: diagnostics.providers.paystackConfigured },
                      { label: 'Flutterwave', ok: diagnostics.providers.flutterwaveConfigured },
                      { label: 'Stripe', ok: diagnostics.providers.stripeConfigured },
                    ].map((p) => (
                      <span
                        key={p.label}
                        className={`rounded-md border px-2 py-1 text-[11px] ${
                          p.ok
                            ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300'
                            : 'border-amber-500/30 bg-amber-950/20 text-amber-300'
                        }`}
                      >
                        {p.label}: {p.ok ? 'Configured' : 'Awaiting Credentials'}
                      </span>
                    ))}
                  </div>
                  {diagnostics.firebaseAdmin.diagnosticNote && (
                    <p className="text-[11px] text-amber-300/90 leading-relaxed">
                      {diagnostics.firebaseAdmin.diagnosticNote}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-zinc-500">Loading platform diagnostics...</p>
              )}
            </div>

            <div className="rounded-xl border border-white/10 bg-[#121216] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Trash2 className="h-4 w-4 text-[#8B5CF6]" />
                  <h2 className="font-display text-sm font-semibold text-white">
                    Audio Retention Cleanup
                  </h2>
                </div>
                <button
                  type="button"
                  disabled={runningCleanup}
                  onClick={() => void handleRunAudioCleanup()}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#8B5CF6] text-white hover:bg-[#7C3AED] disabled:opacity-50"
                >
                  {runningCleanup ? 'Cleaning...' : 'Run Retention Cleanup'}
                </button>
              </div>
              <p className="text-xs text-zinc-400">
                Deletes expired private audio files past <code className="font-mono-tabular">AUDIO_RETENTION_DAYS</code> and retries failed deletions.
                {diagnostics ? ` Failed pending retry: ${diagnostics.audioCleanup.failedSongsCount}.` : ''}
              </p>
              {diagnostics && diagnostics.audioCleanup.recentLogs.length > 0 ? (
                <div className="space-y-1.5 max-h-28 overflow-y-auto text-[11px]">
                  {diagnostics.audioCleanup.recentLogs.slice(0, 6).map((l) => (
                    <div key={l.id} className="flex items-center justify-between rounded bg-[#18181E] px-2.5 py-1.5">
                      <span className="font-mono-tabular text-zinc-300 truncate">{l.songId}</span>
                      <span className={l.status === 'deleted' ? 'text-emerald-400' : 'text-red-400'}>
                        {l.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-zinc-500">No cleanup runs recorded yet.</p>
              )}
            </div>
          </div>

          {diagnostics && diagnostics.webhookSummary.recentEvents.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-[#121216] overflow-x-auto">
              <div className="p-4 border-b border-white/10 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-white">
                  Recent Payment Webhooks ({diagnostics.webhookSummary.totalRecent})
                </h2>
                <span className="text-xs text-zinc-400">
                  Pending Retry: {diagnostics.webhookSummary.pendingRetryCount} · Quarantined:{' '}
                  {diagnostics.webhookSummary.quarantinedCount}
                </span>
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-zinc-400">
                    <th className="py-2.5 px-4">Provider & Event</th>
                    <th className="py-2.5 px-4">Reference</th>
                    <th className="py-2.5 px-4">Outcome</th>
                    <th className="py-2.5 px-4">Reconciliation</th>
                    <th className="py-2.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {diagnostics.webhookSummary.recentEvents.map((ev) => (
                    <tr key={ev.id}>
                      <td className="py-2.5 px-4">
                        <span className="uppercase text-white font-medium">{ev.provider}</span>{' '}
                        <span className="text-zinc-400">{ev.eventType}</span>
                      </td>
                      <td className="py-2.5 px-4 font-mono-tabular text-zinc-300">{ev.reference}</td>
                      <td className="py-2.5 px-4 text-zinc-300">{ev.outcome}</td>
                      <td className="py-2.5 px-4">
                        <span
                          className={
                            ev.reconciliationStatus === 'reconciled'
                              ? 'text-emerald-400'
                              : ev.reconciliationStatus === 'pending_retry'
                              ? 'text-amber-300'
                              : 'text-red-400'
                          }
                        >
                          {ev.reconciliationStatus}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        {ev.reconciliationStatus === 'pending_retry' ? (
                          <button
                            type="button"
                            disabled={retryingEventId === ev.id}
                            onClick={() => void handleRetryWebhook(ev.id)}
                            className="text-[#FF5500] hover:underline disabled:opacity-50"
                          >
                            {retryingEventId === ev.id ? 'Retrying...' : 'Retry'}
                          </button>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* AI Usage Monitor */}
          <div className="rounded-xl border border-white/10 bg-[#121216] overflow-x-auto">
            <div className="p-4 border-b border-white/10">
              <h2 className="font-display text-sm font-semibold text-white">Gemini AI Usage Logs</h2>
            </div>
            {aiUsageLogs.length === 0 ? (
              <p className="p-6 text-xs text-zinc-500">No AI operations logged yet.</p>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 text-xs text-zinc-400">
                    <th className="py-3 px-4 font-medium">Feature</th>
                    <th className="py-3 px-4 font-medium">Model</th>
                    <th className="py-3 px-4 font-medium">Status</th>
                    <th className="py-3 px-4 font-medium text-right">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10 text-xs">
                  {aiUsageLogs.slice(0, 30).map((log) => (
                    <tr key={log.id}>
                      <td className="py-2.5 px-4 text-white">{log.feature}</td>
                      <td className="py-2.5 px-4 font-mono-tabular text-zinc-400">{log.model}</td>
                      <td className="py-2.5 px-4">
                        <span className={log.status === 'success' ? 'text-emerald-400' : 'text-red-400'}>
                          {log.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono-tabular text-zinc-300">
                        {log.latencyMs} ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="rounded-lg border border-amber-500/30 bg-amber-950/15 p-4 flex items-start gap-2.5 text-xs text-amber-200">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <span>
              <strong>Fail-Closed Gateway Verification Active:</strong> Paystack, Flutterwave, and Stripe verify amounts in minor units against your authoritative server invoice record and check reference uniqueness across organizations. Until live provider keys are supplied in server environment variables, submissions remain <code className="font-mono-tabular">awaiting_provider_integration</code>.
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Create Invoice */}
            <form
              onSubmit={(e) => void handleCreateInvoice(e)}
              className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-4"
            >
              <h2 className="font-display text-base font-semibold text-white">Create Billing Invoice</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Client / Artist Name *"
                  className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
                <select
                  value={billingType}
                  onChange={(e) => setBillingType(e.target.value as InvoiceRecord['billingType'])}
                  className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                >
                  <option value="one_time_campaign">One-Time Promotional Campaign</option>
                  <option value="monthly_subscription">Monthly Subscription</option>
                  <option value="agency_package">Agency Service Package</option>
                  <option value="custom_project">Custom Promotional Project</option>
                </select>
                <select
                  value={packageTier}
                  onChange={(e) => setPackageTier(e.target.value)}
                  className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                >
                  <option value="STARTER">STARTER</option>
                  <option value="GROWTH">GROWTH</option>
                  <option value="PREMIUM">PREMIUM</option>
                  <option value="ELITE">ELITE</option>
                  <option value="CUSTOM CAMPAIGN">CUSTOM CAMPAIGN</option>
                </select>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
                <select
                  value={invCurrency}
                  onChange={(e) => setInvCurrency(e.target.value as CurrencyCode)}
                  className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                >
                  <option value="NGN">NGN</option>
                  <option value="USD">USD</option>
                  <option value="GBP">GBP</option>
                  <option value="EUR">EUR</option>
                </select>
                <input
                  type="number"
                  min={0}
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Invoice Amount *"
                  className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white font-mono-tabular"
                />
              </div>
              <button
                type="submit"
                disabled={savingInv}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00]"
              >
                <Plus className="h-4 w-4" />
                Issue Invoice
              </button>
            </form>

            {/* Verify Payment Reference */}
            <form
              onSubmit={(e) => void handleRecordAndVerifyPayment(e)}
              className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-4"
            >
              <h2 className="font-display text-base font-semibold text-white">
                Verify Payment Transaction
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <select
                  value={selectedInvoiceId || invoices[0]?.id || ''}
                  onChange={(e) => setSelectedInvoiceId(e.target.value)}
                  className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                >
                  {invoices.length === 0 ? (
                    <option value="">Create an invoice first</option>
                  ) : (
                    invoices.map((inv) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.clientName} ({formatMoney(inv.amount, inv.currency)} · {inv.status})
                      </option>
                    ))
                  )}
                </select>

                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as PaymentRecord['provider'])}
                  className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                >
                  <option value="paystack">Paystack</option>
                  <option value="flutterwave">Flutterwave</option>
                  <option value="stripe">Stripe (cs_... / pi_...)</option>
                  <option value="manual_transfer">Manual Bank Transfer</option>
                </select>
              </div>
              <input
                type="text"
                required
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Gateway Transaction Reference (e.g. PSK_..., cs_test_...)"
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white font-mono-tabular"
              />
              {provider === 'flutterwave' && (
                <input
                  type="text"
                  value={transactionId}
                  onChange={(e) => setTransactionId(e.target.value)}
                  placeholder="Optional Flutterwave numeric transaction_id"
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white font-mono-tabular"
                />
              )}
              <button
                type="submit"
                disabled={verifying || invoices.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-[#8B5CF6] text-white hover:bg-[#7C3AED] disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {verifying ? 'Verifying with Server...' : 'Verify Payment Server-Side'}
              </button>
            </form>
          </div>

          {/* Invoices & Payments Tables */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl border border-white/10 bg-[#121216] overflow-x-auto">
              <div className="p-4 border-b border-white/10 flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-[#FF5500]" />
                <h3 className="font-display text-sm font-semibold text-white">Invoices ({invoices.length})</h3>
              </div>
              {invoices.length === 0 ? (
                <p className="p-6 text-xs text-zinc-500">No invoices created yet.</p>
              ) : (
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-white/10 text-zinc-400">
                      <th className="py-2.5 px-4">Client</th>
                      <th className="py-2.5 px-4">Amount</th>
                      <th className="py-2.5 px-4">Due</th>
                      <th className="py-2.5 px-4">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {invoices.map((inv) => (
                      <tr key={inv.id}>
                        <td className="py-2.5 px-4">
                          <p className="font-medium text-white">{inv.clientName}</p>
                          <p className="text-zinc-500">{inv.billingType.replace(/_/g, ' ')}</p>
                        </td>
                        <td className="py-2.5 px-4 font-mono-tabular text-zinc-200">
                          {formatMoney(inv.amount, inv.currency)}
                        </td>
                        <td className="py-2.5 px-4 font-mono-tabular text-zinc-400">{inv.dueDate}</td>
                        <td className="py-2.5 px-4 text-zinc-300 capitalize">{inv.status.replace(/_/g, ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="rounded-xl border border-white/10 bg-[#121216] overflow-x-auto">
              <div className="p-4 border-b border-white/10 flex items-center justify-between">
                <h3 className="font-display text-sm font-semibold text-white">
                  Payment Verification Ledger ({payments.length})
                </h3>
                <span className="font-mono-tabular text-[11px] text-zinc-400">
                  {serverLedger.webhooks.length} webhook events
                </span>
              </div>
              {payments.length === 0 ? (
                <p className="p-6 text-xs text-zinc-500">No payment verification records yet.</p>
              ) : (
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-white/10 text-zinc-400">
                      <th className="py-2.5 px-4">Provider & Ref</th>
                      <th className="py-2.5 px-4">Amount</th>
                      <th className="py-2.5 px-4">Verification</th>
                      {isSuperAdmin && <th className="py-2.5 px-4 text-right">Action</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {payments.map((p) => {
                      const binding = serverLedger.bindings.find(
                        (b) => b.provider === p.provider && b.reference === p.reference
                      );
                      const displayStatus = binding?.verificationStatus || p.verificationStatus;
                      return (
                        <tr key={p.id}>
                          <td className="py-2.5 px-4">
                            <p className="font-medium text-white uppercase">{p.provider}</p>
                            <p className="font-mono-tabular text-zinc-400">{p.reference}</p>
                          </td>
                          <td className="py-2.5 px-4 font-mono-tabular text-zinc-200">
                            {formatMoney(p.amount, p.currency)}
                          </td>
                          <td
                            className={`py-2.5 px-4 ${
                              displayStatus === 'verified'
                                ? 'text-emerald-400'
                                : displayStatus === 'failed' || displayStatus === 'disputed'
                                ? 'text-red-400'
                                : 'text-amber-300'
                            }`}
                          >
                            {displayStatus.replace(/_/g, ' ')}
                          </td>
                          {isSuperAdmin && (
                            <td className="py-2.5 px-4 text-right">
                              {p.verificationStatus !== displayStatus ||
                              (displayStatus === 'verified' && p.verificationStatus !== 'verified') ? (
                                <button
                                  type="button"
                                  onClick={() => void handleReconcilePayment(p)}
                                  className="inline-flex items-center gap-1 text-emerald-400 hover:underline"
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  Reconcile
                                </button>
                              ) : (
                                <span className="text-zinc-500">—</span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
