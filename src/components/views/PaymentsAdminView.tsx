import React, { useState } from 'react';
import { CreditCard, ShieldCheck, Plus, RefreshCw, AlertTriangle } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { postJsonApi } from '../../lib/api';
import { formatMoney } from '../../lib/currency';
import { clampStr, createScopedDoc, makeDocId, updateScopedDoc } from '../../lib/firebase';
import type { CurrencyCode, InvoiceRecord, PaymentRecord, UserRole } from '../../types/sonicpush';

export const PaymentsAdminView: React.FC<{ initialTab?: 'payments' | 'admin' }> = ({
  initialTab = 'payments',
}) => {
  const { user, currency, invoices, payments, aiUsageLogs, allUsers, artists, campaigns } =
    useWorkspace();
  const { notify } = useToast();

  const isAdmin = user.role === 'SUPER_ADMIN';
  const [tab, setTab] = useState<'payments' | 'admin'>(initialTab === 'admin' && isAdmin ? 'admin' : 'payments');

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
  const [verifying, setVerifying] = useState(false);

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
      const verifyRes = await postJsonApi<{
        verified: boolean;
        verificationStatus: PaymentRecord['verificationStatus'];
        message?: string;
      }>('/api/payments/verify', {
        provider,
        reference: reference.trim(),
      });

      await createScopedDoc('payments', makeDocId('pay'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        invoiceId: inv.id,
        provider,
        reference: clampStr(reference, 160),
        currency: inv.currency,
        amount: inv.amount,
        // Firestore rules strictly forbid non-admins from setting verified directly; admin/webhook sets verified
        verificationStatus:
          isAdmin && verifyRes.verified ? 'verified' : 'awaiting_provider_integration',
      });

      setReference('');
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

  const handleRoleUpdate = async (targetUid: string, role: UserRole) => {
    try {
      await updateScopedDoc('users', targetUid, { role });
      notify(`Updated user role to ${role}.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update user role.', 'error');
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
            Manage campaign invoices, Paystack / Flutterwave / Stripe verification status, and platform governance.
          </p>
        </div>

        {isAdmin && (
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

      {tab === 'admin' && isAdmin ? (
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
              <strong>Payment Gateway Architecture Ready (No Simulated Success):</strong> Paystack, Flutterwave, and Stripe verification endpoints require server-side merchant keys and webhook secrets. Until live credentials are added, submitted references remain in <code className="font-mono-tabular">awaiting_provider_integration</code> state.
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
                        {inv.clientName} ({formatMoney(inv.amount, inv.currency)})
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
                  <option value="stripe">Stripe</option>
                  <option value="manual_transfer">Manual Bank Transfer</option>
                </select>
              </div>
              <input
                type="text"
                required
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Gateway Transaction Reference (e.g. PSK_...)"
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white font-mono-tabular"
              />
              <button
                type="submit"
                disabled={verifying || invoices.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-[#8B5CF6] text-white hover:bg-[#7C3AED] disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {verifying ? 'Checking Server Verification...' : 'Check Server Verification'}
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
              <div className="p-4 border-b border-white/10">
                <h3 className="font-display text-sm font-semibold text-white">Payment Verification Ledger ({payments.length})</h3>
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
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td className="py-2.5 px-4">
                          <p className="font-medium text-white uppercase">{p.provider}</p>
                          <p className="font-mono-tabular text-zinc-400">{p.reference}</p>
                        </td>
                        <td className="py-2.5 px-4 font-mono-tabular text-zinc-200">
                          {formatMoney(p.amount, p.currency)}
                        </td>
                        <td className="py-2.5 px-4 text-amber-300">
                          {p.verificationStatus.replace(/_/g, ' ')}
                        </td>
                      </tr>
                    ))}
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
