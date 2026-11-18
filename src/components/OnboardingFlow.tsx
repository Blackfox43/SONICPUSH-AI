import React, { useState } from 'react';
import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { ArrowRight, LogOut } from 'lucide-react';
import { db, makeDocId, clampStr, handleFirestoreError, OperationType } from '../lib/firebase';
import { postJsonApi } from '../lib/api';
import { BrandMark } from './BrandMark';
import type { CurrencyCode, UserProfile, UserRole } from '../types/sonicpush';

interface OnboardingFlowProps {
  firebaseUid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  serverCanSuperAdmin?: boolean;
  onComplete: (profile: UserProfile) => void;
  onSignOut: () => Promise<void>;
}

export const OnboardingFlow: React.FC<OnboardingFlowProps> = ({
  firebaseUid,
  email,
  displayName,
  photoURL,
  serverCanSuperAdmin = false,
  onComplete,
  onSignOut,
}) => {
  const isAdminEmail = serverCanSuperAdmin;
  const [role, setRole] = useState<UserRole>(isAdminEmail ? 'SUPER_ADMIN' : 'PROMOTER');
  const [nameInput, setNameInput] = useState(displayName || email.split('@')[0] || 'Artist');
  const [orgName, setOrgName] = useState(
    isAdminEmail ? 'SONICPUSH AI Global Agency' : ''
  );
  const [orgType, setOrgType] = useState<'AGENCY' | 'INDEPENDENT_ARTIST' | 'LABEL'>(
    isAdminEmail ? 'AGENCY' : 'AGENCY'
  );
  const [country, setCountry] = useState('Nigeria');
  const [currency, setCurrency] = useState<CurrencyCode>('NGN');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRoleSelect = (selected: UserRole) => {
    setRole(selected);
    if (selected === 'ARTIST') {
      setOrgType('INDEPENDENT_ARTIST');
    } else {
      setOrgType('AGENCY');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!nameInput.trim()) {
      setError('Please enter your display name.');
      return;
    }
    if (!orgName.trim()) {
      setError('Please enter your agency, label, or artist workspace name.');
      return;
    }

    setSubmitting(true);
    try {
      const roleCheck = await postJsonApi<{ approvedRole: UserRole; isSuperAdmin: boolean }>(
        '/api/auth/onboarding-check',
        { role }
      );
      const effectiveRole = roleCheck.approvedRole;

      const orgId = makeDocId('org');
      const batch = writeBatch(db);

      const orgPayload = {
        id: orgId,
        ownerId: firebaseUid,
        name: clampStr(orgName, 160),
        type: orgType,
        country: clampStr(country, 80) || 'Nigeria',
        defaultCurrency: currency,
        assignedUserIds: [firebaseUid],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      const userPayload = {
        uid: firebaseUid,
        ownerId: firebaseUid,
        email: clampStr(email, 254),
        displayName: clampStr(nameInput, 120),
        ...(photoURL ? { photoURL: clampStr(photoURL, 1024) } : {}),
        role: effectiveRole,
        organizationId: orgId,
        preferredCurrency: currency,
        onboardingCompleted: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      batch.set(doc(db, 'organizations', orgId), orgPayload);
      batch.set(doc(db, 'users', firebaseUid), userPayload);

      // Bootstrap default unpriced service packages for Super Admin on first setup
      if (effectiveRole === 'SUPER_ADMIN') {
        const defaultTiers: Array<{
          tier: 'STARTER' | 'GROWTH' | 'PREMIUM' | 'ELITE' | 'CUSTOM CAMPAIGN';
          title: string;
          description: string;
          limit: number;
          deliverables: string[];
        }> = [
          {
            tier: 'STARTER',
            title: 'Starter Release Foundation',
            description: 'Designed for independent artists preparing a single release.',
            limit: 1,
            deliverables: ['Song Intelligence Audit', '14-Day Content Calendar', 'Editorial Pitch Prep'],
          },
          {
            tier: 'GROWTH',
            title: 'Growth Momentum Push',
            description: 'Designed for developing artists targeting Nigeria & African short-form growth.',
            limit: 3,
            deliverables: ['30-Day AI Campaign Plan', '15 Short-Form Video Scripts', 'DJ & Blog Outreach CRM'],
          },
          {
            tier: 'PREMIUM',
            title: 'Premium Breakout Rollout',
            description: 'Full-funnel release campaign combining creator briefs, radio, and ad planning.',
            limit: 8,
            deliverables: ['60-Day Full Rollout', 'Influencer Collaboration Briefs', 'Weekly Analytics PDF'],
          },
          {
            tier: 'ELITE',
            title: 'Elite Label & Roster Tier',
            description: 'Multi-artist international expansion across Africa, UK, and US corridors.',
            limit: 25,
            deliverables: ['90-Day Cross-Market Strategy', 'Multi-Artist Management', 'Executive Reporting'],
          },
          {
            tier: 'CUSTOM CAMPAIGN',
            title: 'Custom Campaign Scope',
            description: 'Tailored album, EP, or tour marketing scope configured per brief.',
            limit: 50,
            deliverables: ['Custom Deliverable Matrix', 'Dedicated Promoter Assignment', 'Bespoke Billing Schedule'],
          },
        ];

        for (const item of defaultTiers) {
          const pkgId = item.tier.toLowerCase().replace(/\s+/g, '_');
          batch.set(doc(db, 'service_packages', pkgId), {
            id: pkgId,
            ownerId: firebaseUid,
            tier: item.tier,
            title: item.title,
            description: item.description,
            isConfigured: false,
            isPublic: true,
            campaignLimit: item.limit,
            deliverables: item.deliverables,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }

      await batch.commit();

      onComplete({
        uid: firebaseUid,
        ownerId: firebaseUid,
        email,
        displayName: clampStr(nameInput, 120),
        photoURL,
        role: effectiveRole,
        organizationId: orgId,
        preferredCurrency: currency,
        onboardingCompleted: true,
      });
    } catch (err) {
      try {
        handleFirestoreError(err, OperationType.WRITE, `users/${firebaseUid}`);
      } catch (wrapped) {
        setError(wrapped instanceof Error ? wrapped.message : 'Unable to complete onboarding.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#09090B] text-[#FAFAFA] flex flex-col">
      <header className="border-b border-white/10 px-6 h-16 flex items-center justify-between">
        <BrandMark />
        <button
          type="button"
          onClick={() => void onSignOut()}
          className="inline-flex items-center gap-2 text-xs font-medium text-zinc-400 hover:text-white transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </button>
      </header>

      <main className="flex-1 flex items-center justify-center p-4 sm:p-8">
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="w-full max-w-2xl rounded-xl border border-white/10 bg-[#121216] p-6 sm:p-8 space-y-6"
        >
          <div className="space-y-2">
            <p className="text-xs font-medium text-[#FF5500]">Workspace Onboarding</p>
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-white">
              Configure your SONICPUSH AI studio role
            </h1>
            <p className="text-sm text-zinc-400">
              Signed in as <span className="text-zinc-200">{email}</span>. Select how you will operate inside your organization workspace.
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200">
              {error}
            </div>
          )}

          {/* Role Selection */}
          <div className="space-y-2.5">
            <label className="block text-xs font-medium text-zinc-300">Account Access Level</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {isAdminEmail && (
                <button
                  type="button"
                  onClick={() => handleRoleSelect('SUPER_ADMIN')}
                  className={`sm:col-span-2 text-left rounded-lg border p-4 transition-colors ${
                    role === 'SUPER_ADMIN'
                      ? 'border-[#FF5500] bg-[#FF5500]/10'
                      : 'border-white/10 bg-[#18181E] hover:border-white/20'
                  }`}
                >
                  <p className="font-display text-sm font-semibold text-white">Super Admin (Platform Owner)</p>
                  <p className="mt-1 text-xs text-zinc-400">
                    Complete agency governance, package pricing configuration, user permissions, and AI usage monitoring.
                  </p>
                </button>
              )}

              <button
                type="button"
                onClick={() => handleRoleSelect('PROMOTER')}
                className={`text-left rounded-lg border p-4 transition-colors ${
                  role === 'PROMOTER'
                    ? 'border-[#FF5500] bg-[#FF5500]/10'
                    : 'border-white/10 bg-[#18181E] hover:border-white/20'
                }`}
              >
                <p className="font-display text-sm font-semibold text-white">Music Promoter / Agency</p>
                <p className="mt-1 text-xs text-zinc-400">
                  Manage multiple artists, build AI campaigns, coordinate DJs, radio & influencers, and track analytics.
                </p>
              </button>

              <button
                type="button"
                onClick={() => handleRoleSelect('ARTIST')}
                className={`text-left rounded-lg border p-4 transition-colors ${
                  role === 'ARTIST'
                    ? 'border-[#FF5500] bg-[#FF5500]/10'
                    : 'border-white/10 bg-[#18181E] hover:border-white/20'
                }`}
              >
                <p className="font-display text-sm font-semibold text-white">Artist / Client</p>
                <p className="mt-1 text-xs text-zinc-400">
                  Create your artist profile, upload tracks for Song Intelligence, review campaigns, and request promotion.
                </p>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="onboard-name" className="block text-xs font-medium text-zinc-300">
                Your Full Name
              </label>
              <input
                id="onboard-name"
                type="text"
                required
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="e.g. Tunde Adebayo"
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-[#FF5500]"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="onboard-org" className="block text-xs font-medium text-zinc-300">
                {role === 'ARTIST' ? 'Artist / Label Workspace Name' : 'Agency / Organization Name'}
              </label>
              <input
                id="onboard-org"
                type="text"
                required
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder={role === 'ARTIST' ? 'e.g. Kola Sound Records' : 'e.g. Lagos Pulse Promotions'}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-[#FF5500]"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="onboard-type" className="block text-xs font-medium text-zinc-300">
                Workspace Type
              </label>
              <select
                id="onboard-type"
                value={orgType}
                onChange={(e) => setOrgType(e.target.value as 'AGENCY' | 'INDEPENDENT_ARTIST' | 'LABEL')}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-[#FF5500]"
              >
                <option value="AGENCY">Music Promotion Agency</option>
                <option value="LABEL">Record Label / Management</option>
                <option value="INDEPENDENT_ARTIST">Independent Artist</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="onboard-country" className="block text-xs font-medium text-zinc-300">
                Primary Market / Country
              </label>
              <input
                id="onboard-country"
                type="text"
                required
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="Nigeria"
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-[#FF5500]"
              />
            </div>

            <div className="sm:col-span-2 space-y-1.5">
              <label className="block text-xs font-medium text-zinc-300">
                Default Workspace Currency
              </label>
              <div className="flex items-center gap-2">
                {(['NGN', 'USD'] as CurrencyCode[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCurrency(c)}
                    className={`px-4 py-2 text-xs font-semibold rounded-lg border transition-colors ${
                      currency === c
                        ? 'border-[#FF5500] bg-[#FF5500]/15 text-white'
                        : 'border-white/10 bg-[#18181E] text-zinc-400 hover:text-white'
                    }`}
                  >
                    {c === 'NGN' ? 'NGN (₦ Nigerian Naira)' : 'USD ($ US Dollar)'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] disabled:opacity-60 transition-colors min-h-[44px]"
          >
            {submitting ? 'Provisioning Workspace...' : 'Launch SONICPUSH AI Workspace'}
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>
      </main>
    </div>
  );
};
