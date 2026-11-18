import React, { useState } from 'react';
import { Megaphone, Plus, ShieldCheck, AlertTriangle, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { formatMoney } from '../../lib/currency';
import { clampStr, createScopedDoc, deleteScopedDoc, makeDocId, updateScopedDoc } from '../../lib/firebase';
import type { AdPlan, CurrencyCode } from '../../types/sonicpush';

const AD_PLATFORMS: AdPlan['platform'][] = [
  'Meta Ads',
  'Instagram Ads',
  'Facebook Ads',
  'TikTok Ads',
  'YouTube Ads',
];

export const AdvertisingView: React.FC = () => {
  const { user, currency, campaigns, adPlans } = useWorkspace();
  const { notify } = useToast();

  const [campaignId, setCampaignId] = useState(campaigns[0]?.id || '');
  const [platform, setPlatform] = useState<AdPlan['platform']>('Instagram Ads');
  const [objective, setObjective] = useState('Video Views & Profile Visits');
  const [audienceDefinition, setAudienceDefinition] = useState('');
  const [geoTargeting, setGeoTargeting] = useState('Nigeria (Lagos, Abuja), London UK');
  const [adCurrency, setAdCurrency] = useState<CurrencyCode>(currency);
  const [budget, setBudget] = useState('150000');
  const [durationDays, setDurationDays] = useState('14');
  const [creativeRecommendations, setCreativeRecommendations] = useState('');
  const [adCopy, setAdCopy] = useState('');
  const [humanConfirmed, setHumanConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSavePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!objective.trim()) return;
    setSaving(true);
    try {
      await createScopedDoc('ad_plans', makeDocId('adp'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        ...(campaignId ? { campaignId } : {}),
        platform,
        objective: clampStr(objective, 200),
        ...(audienceDefinition.trim() ? { audienceDefinition: clampStr(audienceDefinition, 600) } : {}),
        ...(geoTargeting.trim() ? { geoTargeting: clampStr(geoTargeting, 300) } : {}),
        currency: adCurrency,
        budget: Math.max(0, Number(budget) || 0),
        durationDays: Math.min(365, Math.max(1, Number(durationDays) || 14)),
        ...(creativeRecommendations.trim()
          ? { creativeRecommendations: clampStr(creativeRecommendations, 1500) }
          : {}),
        ...(adCopy.trim() ? { adCopy: clampStr(adCopy, 1500) } : {}),
        humanConfirmed,
        apiExecutionState: 'awaiting_api_integration',
      });
      setAudienceDefinition('');
      setCreativeRecommendations('');
      setAdCopy('');
      setHumanConfirmed(false);
      notify('Advertising campaign plan saved.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to save ad plan.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">Advertising Campaign Manager</h1>
        <p className="text-sm text-zinc-400">
          Plan Meta, Instagram, Facebook, TikTok, and YouTube ad campaigns with explicit human budget confirmation before any expenditure.
        </p>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-950/15 p-4 flex items-start gap-2.5 text-xs text-amber-200">
        <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
        <span>
          <strong>Awaiting Official Ad API Integration:</strong> This workspace creates and stores manual advertising plans ready for Meta Marketing API, TikTok Ads API, and Google/YouTube Ads integration. No live ad spend is triggered from this screen.
        </span>
      </div>

      <form
        onSubmit={(e) => void handleSavePlan(e)}
        className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-4"
      >
        <h2 className="font-display text-base font-semibold text-white">Create Advertising Plan</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">Ad Network</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as AdPlan['platform'])}
              className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            >
              {AD_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">Linked Campaign</label>
            <select
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            >
              <option value="">Standalone Ad Plan</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">Objective *</label>
            <input
              type="text"
              required
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Curr.</label>
              <select
                value={adCurrency}
                onChange={(e) => setAdCurrency(e.target.value as CurrencyCode)}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-2 py-2 text-sm text-white"
              >
                <option value="NGN">NGN</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
                <option value="EUR">EUR</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-zinc-300 mb-1">Budget</label>
              <input
                type="number"
                min={0}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white font-mono-tabular"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">Geographic Targeting</label>
            <input
              type="text"
              value={geoTargeting}
              onChange={(e) => setGeoTargeting(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">Audience Definition</label>
            <input
              type="text"
              value={audienceDefinition}
              onChange={(e) => setAudienceDefinition(e.target.value)}
              placeholder="Ages 18-30, Afrobeats, Burna Boy, Asake listeners"
              className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">Duration (Days)</label>
            <input
              type="number"
              min={1}
              max={365}
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white font-mono-tabular"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <textarea
            rows={2}
            value={creativeRecommendations}
            onChange={(e) => setCreativeRecommendations(e.target.value)}
            placeholder="Creative specs & hook recommendations (e.g. 9:16 vertical studio performance cut)"
            className="rounded-lg border border-white/10 bg-[#18181E] p-3 text-sm text-white"
          />
          <textarea
            rows={2}
            value={adCopy}
            onChange={(e) => setAdCopy(e.target.value)}
            placeholder="Primary ad copy & CTA..."
            className="rounded-lg border border-white/10 bg-[#18181E] p-3 text-sm text-white"
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={humanConfirmed}
              onChange={(e) => setHumanConfirmed(e.target.checked)}
              className="accent-[#FF5500]"
            />
            <span>Human budget sign-off confirmed for manual execution</span>
          </label>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00]"
          >
            <Plus className="h-4 w-4" />
            Save Advertising Plan
          </button>
        </div>
      </form>

      {adPlans.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-10 text-center space-y-2">
          <Megaphone className="h-6 w-6 text-zinc-500 mx-auto" />
          <p className="font-display text-base font-semibold text-white">No advertising plans saved yet</p>
          <p className="text-sm text-zinc-400">
            Configure your first Meta, TikTok, or YouTube ad plan above.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {adPlans.map((plan) => (
            <div key={plan.id} className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-[#FF5500] font-medium">
                    {plan.platform} · {plan.durationDays} days · {formatMoney(plan.budget, plan.currency)}
                  </p>
                  <h3 className="font-display text-base font-semibold text-white mt-0.5">
                    {plan.objective}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => void deleteScopedDoc('ad_plans', plan.id)}
                  className="p-1.5 text-zinc-500 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="text-xs text-zinc-300 space-y-1">
                {plan.geoTargeting && <p><span className="text-zinc-500">Geo: </span>{plan.geoTargeting}</p>}
                {plan.audienceDefinition && <p><span className="text-zinc-500">Audience: </span>{plan.audienceDefinition}</p>}
                {plan.creativeRecommendations && <p><span className="text-zinc-500">Creative: </span>{plan.creativeRecommendations}</p>}
                {plan.adCopy && <p><span className="text-zinc-500">Ad Copy: </span>{plan.adCopy}</p>}
              </div>

              <div className="pt-3 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-zinc-400">State: Awaiting Ad API Integration (Manual Plan)</span>
                <button
                  type="button"
                  onClick={() =>
                    void updateScopedDoc('ad_plans', plan.id, {
                      humanConfirmed: !plan.humanConfirmed,
                    })
                  }
                  className={`inline-flex items-center gap-1 font-medium ${
                    plan.humanConfirmed ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {plan.humanConfirmed ? 'Human Confirmed' : 'Confirm Budget Sign-Off'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
