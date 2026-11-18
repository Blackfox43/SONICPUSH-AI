import React, { useState } from 'react';
import { Briefcase, Plus, Trash2, Settings2, CheckCircle2 } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { formatMoney } from '../../lib/currency';
import { clampStr, createScopedDoc, deleteScopedDoc, makeDocId, updateScopedDoc } from '../../lib/firebase';
import type { ClientRecord, PackageTier, ServicePackage } from '../../types/sonicpush';

const PACKAGE_TIERS: PackageTier[] = ['STARTER', 'GROWTH', 'PREMIUM', 'ELITE', 'CUSTOM CAMPAIGN'];

export const ClientsPackagesView: React.FC = () => {
  const { user, isSuperAdmin, canManageClients, currency, clients, servicePackages } = useWorkspace();
  const { notify } = useToast();

  const isAdmin = isSuperAdmin;
  const isArtist = !canManageClients;

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [companyOrLabel, setCompanyOrLabel] = useState('');
  const [country, setCountry] = useState('Nigeria');
  const [packageTier, setPackageTier] = useState<PackageTier>('GROWTH');
  const [assignedArtistNames, setAssignedArtistNames] = useState('');
  const [savingClient, setSavingClient] = useState(false);

  // Admin Package Configuration Modal
  const [editingPkg, setEditingPkg] = useState<ServicePackage | null>(null);
  const [pkgTitle, setPkgTitle] = useState('');
  const [pkgDesc, setPkgDesc] = useState('');
  const [pkgPriceNGN, setPkgPriceNGN] = useState('');
  const [pkgPriceUSD, setPkgPriceUSD] = useState('');
  const [pkgLimit, setPkgLimit] = useState('3');
  const [pkgDeliverables, setPkgDeliverables] = useState('');

  const handleAddClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setSavingClient(true);
    try {
      await createScopedDoc('clients', makeDocId('cli'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        name: clampStr(name, 160),
        email: clampStr(email, 254),
        ...(companyOrLabel.trim() ? { companyOrLabel: clampStr(companyOrLabel, 160) } : {}),
        country: clampStr(country, 80),
        packageTier,
        onboardingStatus: 'pending',
        paymentStatus: 'unpaid',
        ...(assignedArtistNames.trim() ? { assignedArtistNames: clampStr(assignedArtistNames, 400) } : {}),
      });
      setName('');
      setEmail('');
      setCompanyOrLabel('');
      setAssignedArtistNames('');
      notify('Client record added.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to save client.', 'error');
    } finally {
      setSavingClient(false);
    }
  };

  const handleRequestPackage = async (tier: PackageTier) => {
    try {
      await createScopedDoc('notifications', makeDocId('notif'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        category: 'client_update',
        title: `Service Package Request: ${tier}`,
        message: `${user.displayName} (${user.email}) requested promotional service scope for ${tier}.`,
        targetDate: new Date().toISOString().slice(0, 10),
        read: false,
      });
      notify(`Submitted service package request for ${tier}.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to request service package.', 'error');
    }
  };

  const openPkgEditor = (tier: PackageTier) => {
    const existing = servicePackages.find((p) => p.tier === tier);
    const id = existing?.id || tier.toLowerCase().replace(/\s+/g, '_');
    setEditingPkg(
      existing || {
        id,
        ownerId: user.uid,
        tier,
        title: `${tier} Package`,
        description: '',
        isConfigured: false,
        isPublic: true,
        campaignLimit: 3,
        deliverables: [],
      }
    );
    setPkgTitle(existing?.title || `${tier} Promotional Package`);
    setPkgDesc(existing?.description || '');
    setPkgPriceNGN(existing?.priceNGN !== undefined ? String(existing.priceNGN) : '');
    setPkgPriceUSD(existing?.priceUSD !== undefined ? String(existing.priceUSD) : '');
    setPkgLimit(String(existing?.campaignLimit || 3));
    setPkgDeliverables((existing?.deliverables || []).join('\n'));
  };

  const handleSavePkg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPkg) return;
    try {
      const existsInDb = servicePackages.some((p) => p.id === editingPkg.id);
      const deliverables = pkgDeliverables
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20);
      const payload = {
        tier: editingPkg.tier,
        title: clampStr(pkgTitle, 120),
        description: clampStr(pkgDesc, 600),
        ...(pkgPriceNGN.trim() !== '' ? { priceNGN: Math.max(0, Number(pkgPriceNGN) || 0) } : {}),
        ...(pkgPriceUSD.trim() !== '' ? { priceUSD: Math.max(0, Number(pkgPriceUSD) || 0) } : {}),
        isConfigured: pkgPriceNGN.trim() !== '' || pkgPriceUSD.trim() !== '',
        isPublic: true,
        campaignLimit: Math.min(1000, Math.max(1, Number(pkgLimit) || 1)),
        deliverables,
      };
      if (existsInDb) {
        await updateScopedDoc('service_packages', editingPkg.id, payload);
      } else {
        await createScopedDoc('service_packages', editingPkg.id, {
          ...payload,
          ownerId: user.uid,
        });
      }
      setEditingPkg(null);
      notify(`Updated ${editingPkg.tier} package configuration.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to save package configuration.', 'error');
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">
          {isArtist ? 'Promotional Service Packages' : 'Clients & Agency Service Packages'}
        </h1>
        <p className="text-sm text-zinc-400">
          {isArtist
            ? 'Review official agency packages configured by the administrator and request additional promotional services.'
            : 'Manage client onboarding, artist assignments, internal notes, communication history, and service tiers.'}
        </p>
      </div>

      {/* Promotional Service Packages */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-white">Promotional Service Packages</h2>
          <span className="text-xs text-zinc-400">
            Pricing is configured directly by Super Admin (never invented)
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
          {PACKAGE_TIERS.map((tier) => {
            const pkg = servicePackages.find((p) => p.tier === tier);
            const displayPrice =
              currency === 'NGN'
                ? pkg?.priceNGN !== undefined
                  ? formatMoney(pkg.priceNGN, 'NGN')
                  : 'Pricing Not Yet Configured'
                : pkg?.priceUSD !== undefined
                ? formatMoney(pkg.priceUSD, 'USD')
                : 'Pricing Not Yet Configured';

            return (
              <div
                key={tier}
                className="rounded-xl border border-white/10 bg-[#121216] p-5 flex flex-col justify-between space-y-5"
              >
                <div className="space-y-2">
                  <p className="font-mono-tabular text-xs font-semibold text-[#FF5500]">{tier}</p>
                  <h3 className="font-display text-sm font-semibold text-white">
                    {pkg?.title || `${tier} Tier`}
                  </h3>
                  <p className="font-mono-tabular text-sm font-bold text-zinc-100">{displayPrice}</p>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    {pkg?.description || 'Agency deliverables and limits configurable by Super Admin.'}
                  </p>
                  {pkg?.deliverables && pkg.deliverables.length > 0 && (
                    <ul className="space-y-1 pt-2 border-t border-white/10 text-xs text-zinc-300">
                      {pkg.deliverables.map((d, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
                          <span>{d}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="space-y-2 pt-3 border-t border-white/10">
                  <p className="text-xs text-zinc-500 font-mono-tabular">
                    Limit: {pkg?.campaignLimit ?? 'Custom'} campaigns
                  </p>
                  {isAdmin ? (
                    <button
                      type="button"
                      onClick={() => openPkgEditor(tier)}
                      className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-medium rounded-lg border border-white/15 bg-[#18181E] text-white hover:bg-white/5"
                    >
                      <Settings2 className="h-3.5 w-3.5 text-[#FF5500]" />
                      Configure Package
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleRequestPackage(tier)}
                      className="w-full py-2 px-3 text-xs font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00]"
                    >
                      Request {tier}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Client Operations (Promoter & Admin) */}
      {!isArtist && (
        <div className="space-y-5 pt-4 border-t border-white/10">
          <h2 className="font-display text-lg font-semibold text-white">Client Management & Operations</h2>

          <form
            onSubmit={(e) => void handleAddClient(e)}
            className="rounded-xl border border-white/10 bg-[#121216] p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
          >
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Client / Manager Name *"
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Client Email *"
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <input
              type="text"
              value={companyOrLabel}
              onChange={(e) => setCompanyOrLabel(e.target.value)}
              placeholder="Label / Management Company"
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="Country"
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <select
              value={packageTier}
              onChange={(e) => setPackageTier(e.target.value as PackageTier)}
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            >
              {PACKAGE_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <input
                type="text"
                value={assignedArtistNames}
                onChange={(e) => setAssignedArtistNames(e.target.value)}
                placeholder="Assigned Artist(s)"
                className="flex-1 rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              />
              <button
                type="submit"
                disabled={savingClient}
                className="inline-flex items-center gap-1 rounded-lg bg-[#FF5500] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e04b00]"
              >
                <Plus className="h-4 w-4" />
                Add
              </button>
            </div>
          </form>

          {clients.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-10 text-center space-y-2">
              <Briefcase className="h-6 w-6 text-zinc-500 mx-auto" />
              <p className="font-display text-base font-semibold text-white">No clients onboarded yet</p>
              <p className="text-sm text-zinc-400">
                Add client records above to track package tiers, artist assignments, notes, and communication logs.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {clients.map((cli) => (
                <div key={cli.id} className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-[#FF5500] font-medium">
                        {cli.packageTier} · {cli.country}
                      </p>
                      <h3 className="font-display text-base font-semibold text-white">{cli.name}</h3>
                      <p className="text-xs text-zinc-400">
                        {cli.email}
                        {cli.companyOrLabel ? ` · ${cli.companyOrLabel}` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void deleteScopedDoc('clients', cli.id)}
                      className="p-1.5 text-zinc-500 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={cli.onboardingStatus}
                      onChange={(e) =>
                        void updateScopedDoc('clients', cli.id, {
                          onboardingStatus: e.target.value as ClientRecord['onboardingStatus'],
                        })
                      }
                      className="rounded border border-white/10 bg-[#18181E] px-2.5 py-1.5 text-xs text-zinc-200"
                    >
                      <option value="pending">Onboarding: Pending</option>
                      <option value="in_progress">Onboarding: In Progress</option>
                      <option value="active">Onboarding: Active</option>
                      <option value="completed">Onboarding: Completed</option>
                    </select>

                    <select
                      value={cli.paymentStatus}
                      aria-label="Agency Billing Follow-Up Note"
                      onChange={(e) =>
                        void updateScopedDoc('clients', cli.id, {
                          paymentStatus: e.target.value as ClientRecord['paymentStatus'],
                        })
                      }
                      className="rounded border border-white/10 bg-[#18181E] px-2.5 py-1.5 text-xs text-zinc-200"
                    >
                      <option value="unpaid">Billing Note: Unpaid</option>
                      <option value="pending_verification">Billing Note: Pending Verification</option>
                      <option value="paid">Billing Note: Settled (CRM)</option>
                      <option value="overdue">Billing Note: Overdue</option>
                    </select>
                  </div>

                  <input
                    type="text"
                    defaultValue={cli.assignedArtistNames || ''}
                    onBlur={(e) =>
                      void updateScopedDoc('clients', cli.id, {
                        assignedArtistNames: clampStr(e.target.value, 400),
                      })
                    }
                    placeholder="Assigned artist(s)..."
                    className="w-full rounded border border-white/10 bg-[#18181E] px-3 py-1.5 text-xs text-white"
                  />

                  <textarea
                    rows={2}
                    defaultValue={cli.internalNotes || ''}
                    onBlur={(e) =>
                      void updateScopedDoc('clients', cli.id, {
                        internalNotes: clampStr(e.target.value, 2000),
                      })
                    }
                    placeholder="Internal agency notes..."
                    className="w-full rounded border border-white/10 bg-[#18181E] p-2.5 text-xs text-white"
                  />

                  <textarea
                    rows={2}
                    defaultValue={cli.communicationHistory || ''}
                    onBlur={(e) =>
                      void updateScopedDoc('clients', cli.id, {
                        communicationHistory: clampStr(e.target.value, 3000),
                      })
                    }
                    placeholder="Client communication history..."
                    className="w-full rounded border border-white/10 bg-[#18181E] p-2.5 text-xs text-white"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Admin Package Configuration Modal */}
      {editingPkg && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <form
            onSubmit={(e) => void handleSavePkg(e)}
            className="w-full max-w-lg rounded-xl border border-white/15 bg-[#121216] p-6 space-y-4"
          >
            <h2 className="font-display text-lg font-bold text-white">
              Configure {editingPkg.tier} Package
            </h2>
            <div>
              <label className="block text-xs text-zinc-300 mb-1">Package Title</label>
              <input
                type="text"
                required
                value={pkgTitle}
                onChange={(e) => setPkgTitle(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-300 mb-1">Description</label>
              <textarea
                rows={2}
                value={pkgDesc}
                onChange={(e) => setPkgDesc(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] p-2.5 text-sm text-white"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Price (NGN)</label>
                <input
                  type="number"
                  min={0}
                  value={pkgPriceNGN}
                  onChange={(e) => setPkgPriceNGN(e.target.value)}
                  placeholder="Optional"
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white font-mono-tabular"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Price (USD)</label>
                <input
                  type="number"
                  min={0}
                  value={pkgPriceUSD}
                  onChange={(e) => setPkgPriceUSD(e.target.value)}
                  placeholder="Optional"
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white font-mono-tabular"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Campaign Limit</label>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={pkgLimit}
                  onChange={(e) => setPkgLimit(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white font-mono-tabular"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-300 mb-1">Deliverables (one per line)</label>
              <textarea
                rows={4}
                value={pkgDeliverables}
                onChange={(e) => setPkgDeliverables(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] p-2.5 text-xs text-white"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingPkg(null)}
                className="px-4 py-2 text-xs rounded-lg border border-white/15 text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#FF5500] text-white"
              >
                Save Package
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
