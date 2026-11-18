import React, { useState } from 'react';
import { ArrowRight, Radio, Disc3, BarChart3, Globe2, ShieldCheck, Sparkles, Menu, X } from 'lucide-react';
import { BrandMark, WaveformSymbol } from './BrandMark';

interface LandingPageProps {
  onSignIn: () => Promise<void>;
  signingIn: boolean;
  authError: string | null;
}

const PACKAGE_TIERS = [
  {
    tier: 'STARTER',
    audience: 'For emerging independent artists',
    summary: 'Song intelligence audit, release readiness checklist, and foundational short-form content calendar.',
    limit: '1 active release cycle',
  },
  {
    tier: 'GROWTH',
    audience: 'For developing artists building regional traction',
    summary: 'Multi-platform TikTok/Reels studio scripts, playlist pitch tracking, and DJ/blog outreach management.',
    limit: 'Up to 3 active campaigns',
  },
  {
    tier: 'PREMIUM',
    audience: 'For breakout releases across Nigeria & diaspora',
    summary: 'Full 15-section campaign blueprint, creator brief coordination, ad planning, and weekly reporting.',
    limit: 'Up to 8 active campaigns',
  },
  {
    tier: 'ELITE',
    audience: 'For labels & multi-artist international rosters',
    summary: 'Cross-territory West Africa, UK & US campaign architecture, press/radio CRM, and executive analytics.',
    limit: 'Multi-artist roster workspace',
  },
  {
    tier: 'CUSTOM CAMPAIGN',
    audience: 'For bespoke album rollouts & tours',
    summary: 'Custom deliverables, NGN or USD billing schedules, and dedicated agency operations.',
    limit: 'Scoped per project brief',
  },
];

export const LandingPage: React.FC<LandingPageProps> = ({
  onSignIn,
  signingIn,
  authError,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#09090B] text-[#FAFAFA]">
      {/* Top Bar Contract: 3 Zones separated by gap-8 */}
      <header className="sticky top-0 z-40 bg-[#09090B]/95 backdrop-blur border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
          <a href="#top" className="whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF5500] rounded">
            <BrandMark />
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-zinc-400">
            <a href="#capabilities" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Capabilities
            </a>
            <a href="#intelligence" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Intelligence
            </a>
            <a href="#roles" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Workflow
            </a>
            <a href="#packages" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Packages
            </a>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => void onSignIn()}
              disabled={signingIn}
              className="hidden sm:inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
            >
              {signingIn ? 'Connecting...' : 'Enter Studio'}
              <ArrowRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="md:hidden inline-flex items-center justify-center h-11 w-11 rounded-lg border border-white/10 text-zinc-200 hover:bg-white/5"
              aria-label="Toggle navigation menu"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden border-t border-white/10 bg-[#121216] px-4 py-4 space-y-3">
            <a href="#capabilities" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-zinc-300 hover:text-white">
              Capabilities
            </a>
            <a href="#intelligence" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-zinc-300 hover:text-white">
              Intelligence
            </a>
            <a href="#roles" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-zinc-300 hover:text-white">
              Workflow
            </a>
            <a href="#packages" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-zinc-300 hover:text-white">
              Packages
            </a>
            <button
              type="button"
              onClick={() => void onSignIn()}
              disabled={signingIn}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] disabled:opacity-60"
            >
              {signingIn ? 'Connecting...' : 'Enter Studio with Google'}
            </button>
          </div>
        )}
      </header>

      <main id="top">
        {/* Hero Section */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 pb-16 lg:pt-20 lg:pb-24">
          {authError && (
            <div className="mb-6 rounded-xl border border-red-500/40 bg-red-950/30 px-4 py-3 text-sm text-red-200">
              {authError}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-stretch">
            <div className="lg:col-span-6 flex flex-col justify-between space-y-8">
              <div className="space-y-6">
                <div className="flex items-center gap-3 text-xs text-zinc-400 font-medium tracking-wide">
                  <WaveformSymbol />
                  <span>Nigeria · Africa · International Music Promotion Agency</span>
                </div>

                <h1
                  className="font-display font-bold tracking-tight text-white leading-[1.06]"
                  style={{ fontSize: 'clamp(2.25rem, 4.2vw, 3.75rem)', textWrap: 'balance' }}
                >
                  Turn Songs Into Movements.
                </h1>

                <p className="text-base sm:text-lg text-zinc-300 leading-relaxed max-w-xl">
                  SONICPUSH AI is a commercial music promotion agency and artist management workspace. Analyze audio releases, build 15-section release strategies in NGN or USD, coordinate DJ, radio, playlist, and creator outreach, and measure every campaign from real records.
                </p>
              </div>

              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-4">
                  <button
                    type="button"
                    onClick={() => void onSignIn()}
                    disabled={signingIn}
                    className="inline-flex items-center justify-center gap-2.5 px-6 py-3.5 text-sm font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] disabled:opacity-60 transition-colors min-h-[44px] whitespace-nowrap"
                  >
                    {signingIn ? 'Signing In...' : 'Sign In with Google'}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                  <a
                    href="#capabilities"
                    className="inline-flex items-center justify-center px-5 py-3.5 text-sm font-medium rounded-lg border border-white/15 text-zinc-200 hover:bg-white/5 transition-colors min-h-[44px] whitespace-nowrap"
                  >
                    Explore Platform Architecture
                  </a>
                </div>
                <p className="text-xs text-zinc-500">
                  Verified Google Sign-In with guided role onboarding for Artists, Music Promoters, and Agency Admins.
                </p>
              </div>
            </div>

            <div className="lg:col-span-6">
              <div className="relative h-full min-h-[280px] sm:min-h-[360px] rounded-xl overflow-hidden border border-white/10 bg-[#121216]">
                <img
                  src="/src/assets/images/hero_studio_console_1794950258681.jpg"
                  alt="SONICPUSH AI mastering console and campaign control studio"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#09090B]/90 via-[#09090B]/20 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-6 flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className="text-xs text-zinc-400">Studio Console Workspace</p>
                    <p className="font-display text-lg font-semibold text-white">
                      Built for Afrobeats, Amapiano, Hip-Hop, Gospel & Global Releases
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 4-Column Structural Strip Below Hero Split */}
          <div className="mt-12 pt-8 border-t border-white/10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div>
              <p className="text-xs text-zinc-400">Audio & Metadata Analysis</p>
              <p className="mt-1 font-display text-base font-semibold text-white">Song Intelligence Engine</p>
              <p className="mt-1 text-sm text-zinc-400">Separates verified audio observations from strategic AI hypotheses.</p>
            </div>
            <div>
              <p className="text-xs text-zinc-400">Multi-Market Planning</p>
              <p className="mt-1 font-display text-base font-semibold text-white">15-Section Campaign Engine</p>
              <p className="mt-1 text-sm text-zinc-400">7 to 90+ day rollouts across NGN, USD, GBP, and EUR budgets.</p>
            </div>
            <div>
              <p className="text-xs text-zinc-400">Direct Industry Outreach</p>
              <p className="mt-1 font-display text-base font-semibold text-white">DJ, Radio, Press & Creators</p>
              <p className="mt-1 text-sm text-zinc-400">Human-authorized WhatsApp, Instagram DM, and Email CRM logs.</p>
            </div>
            <div>
              <p className="text-xs text-zinc-400">Database-Driven Reporting</p>
              <p className="mt-1 font-display text-base font-semibold text-white">Zero-Fabrication Analytics</p>
              <p className="mt-1 text-sm text-zinc-400">Tracks real reach, streams, spend, CSV exports, and PDF reports.</p>
            </div>
          </div>
        </section>

        {/* Core Capabilities Asymmetric Bento */}
        <section id="capabilities" className="border-t border-white/10 bg-[#0D0D10]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24 space-y-12">
            <div className="max-w-2xl space-y-3">
              <p className="text-xs font-medium text-[#FF5500]">Agency Capabilities</p>
              <h2 className="font-display text-2xl sm:text-4xl font-bold tracking-tight text-white" style={{ textWrap: 'balance' }}>
                Four connected departments running every release cycle.
              </h2>
              <p className="text-sm sm:text-base text-zinc-400 leading-relaxed">
                From studio upload to Lagos club rotation and international playlist pitching, every workflow lives in a single persistent organization workspace.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Feature 01 (Wide) */}
              <div className="lg:col-span-7 rounded-xl border border-white/10 bg-[#121216] overflow-hidden flex flex-col">
                <div className="aspect-[16/9] bg-[#18181E] overflow-hidden">
                  <img
                    src="/src/assets/images/live_soundstage_visual_1794950259328.jpg"
                    alt="DJ booth and live music crowd in Lagos"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="p-6 sm:p-8 space-y-3">
                  <p className="font-mono-tabular text-xs text-zinc-400">01. Campaign Architecture & Cultural Distribution</p>
                  <h3 className="font-display text-xl sm:text-2xl font-semibold text-white">
                    AI Music Campaign Manager & Multi-Channel Rollouts
                  </h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">
                    Build pre-release, release-day, viral short-form, streaming awareness, event, and international expansion campaigns. Every generated blueprint maps objectives, target audiences, DJ & radio outreach, playlist pitching, content calendars, risk checks, and weekly reviews.
                  </p>
                </div>
              </div>

              {/* Feature 02 */}
              <div className="lg:col-span-5 rounded-xl border border-white/10 bg-[#121216] overflow-hidden flex flex-col">
                <div className="aspect-[4/3] bg-[#18181E] overflow-hidden">
                  <img
                    src="/src/assets/images/afrobeats_session_visual_1794950258698.jpg"
                    alt="Independent Afrobeats artist recording vocals in studio"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="p-6 sm:p-8 space-y-3 flex-1">
                  <p className="font-mono-tabular text-xs text-zinc-400">02. Multimodal A&R Analysis</p>
                  <h3 className="font-display text-xl font-semibold text-white">
                    Song Intelligence Engine
                  </h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">
                    Upload audio tracks or attach streaming metadata and lyrics. Gemini analyzes submitted audio directly and explicitly separates verified observations from strategic marketing hypotheses.
                  </p>
                </div>
              </div>

              {/* Feature 03 */}
              <div className="lg:col-span-5 rounded-xl border border-white/10 bg-[#121216] overflow-hidden flex flex-col">
                <div className="aspect-[4/3] bg-[#18181E] overflow-hidden">
                  <img
                    src="/src/assets/images/campaign_war_room_1794950260095.jpg"
                    alt="Music marketing strategists reviewing campaign calendars"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="p-6 sm:p-8 space-y-3 flex-1">
                  <p className="font-mono-tabular text-xs text-zinc-400">03. Agency Operations & Client Billing</p>
                  <h3 className="font-display text-xl font-semibold text-white">
                    Client Roster, Packages & Payment Ledger
                  </h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">
                    Onboard clients, assign artists, configure agency service packages, issue NGN/USD invoices, and integrate Paystack, Flutterwave, or Stripe server-side verification without simulated payments.
                  </p>
                </div>
              </div>

              {/* Feature 04 (Wide) */}
              <div id="intelligence" className="lg:col-span-7 rounded-xl border border-white/10 bg-[#121216] p-6 sm:p-8 flex flex-col justify-between space-y-8">
                <div className="space-y-3">
                  <p className="font-mono-tabular text-xs text-[#8B5CF6]">04. Creative Studio, Grounded Trends & Outreach CRM</p>
                  <h3 className="font-display text-xl sm:text-2xl font-semibold text-white">
                    Short-Form Scripts, Live Search Trends & Legitimate Playlist Tracking
                  </h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">
                    Generate 15s, 30s, and 60s TikTok, Reels, and YouTube Shorts scripts with scene-by-scene cues. Research real-time regional music conversations via Google Search grounding with cited source links—never fabricated trend numbers or payola promises.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 pt-6 border-t border-white/10">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-sm font-semibold text-white">
                      <Radio className="h-4 w-4 text-[#FF5500]" />
                      <span>DJ, Radio & Press CRM</span>
                    </div>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Organize 9 media categories with follow-up reminders and human-approved WhatsApp, IG DM, and Email drafts.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-sm font-semibold text-white">
                      <Disc3 className="h-4 w-4 text-[#8B5CF6]" />
                      <span>Editorial vs Independent Playlists</span>
                    </div>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Separate official platform editorial pitches from independent curators with transparent submission tracking.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-sm font-semibold text-white">
                      <BarChart3 className="h-4 w-4 text-[#FF5500]" />
                      <span>Manual vs API Telemetry</span>
                    </div>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Keep manually logged campaign metrics distinct from future API feeds with CSV and print-PDF reporting.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-sm font-semibold text-white">
                      <Globe2 className="h-4 w-4 text-[#8B5CF6]" />
                      <span>Nigeria, Africa & Global Corridors</span>
                    </div>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Culturally fluent AI assistant trained on Afrobeats, Amapiano, Afro-fusion, Gospel, Hip-Hop, and Dancehall.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Role-Based Access Workflow */}
        <section id="roles" className="border-t border-white/10">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24 space-y-10">
            <div className="max-w-2xl space-y-3">
              <p className="text-xs font-medium text-[#8B5CF6]">Role-Based Security</p>
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
                Three dedicated access levels isolated by organization.
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="rounded-xl border border-white/10 bg-[#121216] p-6 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <ShieldCheck className="h-4 w-4 text-[#FF5500]" />
                  <span>Super Admin</span>
                </div>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Full platform governance: manage user roles, configure agency service package pricing in NGN/USD, monitor Gemini AI usage logs, and oversee platform analytics.
                </p>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#121216] p-6 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Sparkles className="h-4 w-4 text-[#8B5CF6]" />
                  <span>Music Promoter / Agency</span>
                </div>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Manage multi-artist rosters, run Song Intelligence, generate 15-section campaigns, coordinate DJ/radio/influencer outreach, and deliver client reports.
                </p>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#121216] p-6 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Disc3 className="h-4 w-4 text-[#FF5500]" />
                  <span>Artist / Client</span>
                </div>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Build artist profiles, upload songs and promotional briefs, track assigned campaigns, export strategy documents, and request agency service packages.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Service Packages Preview */}
        <section id="packages" className="border-t border-white/10 bg-[#0D0D10]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24 space-y-10">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
              <div className="max-w-2xl space-y-3">
                <p className="text-xs font-medium text-[#FF5500]">Promotional Service Packages</p>
                <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
                  Structured tiers configured transparently by your agency admin.
                </h2>
              </div>
              <p className="text-xs text-zinc-500 max-w-sm">
                Package pricing in NGN and USD is set directly by the platform administrator inside the workspace—never fabricated.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              {PACKAGE_TIERS.map((pkg) => (
                <div key={pkg.tier} className="rounded-xl border border-white/10 bg-[#121216] p-5 flex flex-col justify-between space-y-6">
                  <div className="space-y-2.5">
                    <p className="font-mono-tabular text-xs font-semibold text-[#FF5500]">{pkg.tier}</p>
                    <p className="text-xs text-zinc-400">{pkg.audience}</p>
                    <p className="text-sm text-zinc-300 leading-relaxed">{pkg.summary}</p>
                  </div>
                  <div className="pt-4 border-t border-white/10 space-y-3">
                    <p className="font-mono-tabular text-xs text-zinc-400">{pkg.limit}</p>
                    <button
                      type="button"
                      onClick={() => void onSignIn()}
                      disabled={signingIn}
                      className="w-full py-2 px-3 text-xs font-medium rounded-lg border border-white/15 text-zinc-200 hover:bg-white/5 transition-colors"
                    >
                      View in Studio
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-white/10 bg-[#09090B]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          <div className="space-y-2">
            <BrandMark />
            <p className="text-xs text-zinc-500">
              Turn Songs Into Movements · Music Marketing & Artist Promotion Workspace
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-6 text-xs text-zinc-500">
            <span>Cloud Firestore Persistence</span>
            <span>·</span>
            <span>Server-Side Gemini Intelligence</span>
            <span>·</span>
            <span>© {new Date().getFullYear()} SONICPUSH AI</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
