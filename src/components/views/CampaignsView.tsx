import React, { useState } from 'react';
import { Rocket, Download, Printer, Trash2, CheckSquare, Save, AlertTriangle } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { postJsonApi } from '../../lib/api';
import { formatMoney } from '../../lib/currency';
import { downloadTextFile } from '../../lib/exportUtils';
import { clampStr, createScopedDoc, deleteScopedDoc, makeDocId, updateScopedDoc } from '../../lib/firebase';
import type { Campaign, CampaignStrategySections, CurrencyCode } from '../../types/sonicpush';

const CAMPAIGN_TYPES = [
  'Pre-release promotion',
  'Release-day promotion',
  'Post-release promotion',
  'Viral short-form campaign',
  'Streaming awareness campaign',
  'Artist branding campaign',
  'Event promotion',
  'International expansion campaign',
];

const DURATION_PRESETS = [7, 14, 30, 60, 90];

const SECTION_LABELS: Array<{ key: keyof CampaignStrategySections; label: string }> = [
  { key: 'overview', label: '1. Campaign Overview' },
  { key: 'marketingObjectives', label: '2. Marketing Objectives' },
  { key: 'targetAudience', label: '3. Target Audience' },
  { key: 'platformStrategy', label: '4. Platform Strategy' },
  { key: 'contentCalendar', label: '5. Content Calendar' },
  { key: 'promotionalSchedule', label: '6. Promotional Schedule' },
  { key: 'influencerStrategy', label: '7. Influencer Strategy' },
  { key: 'djOutreachStrategy', label: '8. DJ Outreach Strategy' },
  { key: 'radioStrategy', label: '9. Radio Strategy' },
  { key: 'playlistSubmissionStrategy', label: '10. Playlist Submission Strategy' },
  { key: 'advertisingRecommendations', label: '11. Advertising Recommendations' },
  { key: 'budgetBreakdown', label: '12. Budget Breakdown' },
  { key: 'keyPerformanceIndicators', label: '13. Key Performance Indicators' },
  { key: 'riskAssessment', label: '14. Risk Assessment' },
  { key: 'weeklyPerformanceReview', label: '15. Weekly Performance Review' },
];

export const CampaignsView: React.FC = () => {
  const { user, currency, artists, songs, campaigns, logAiUsage, setActiveSection } = useWorkspace();
  const { notify } = useToast();

  const activeArtists = artists.filter((a) => !a.archived);
  const [artistId, setArtistId] = useState(activeArtists[0]?.id || '');
  const [songId, setSongId] = useState('');
  const [campaignName, setCampaignName] = useState('');
  const [campaignType, setCampaignType] = useState(CAMPAIGN_TYPES[0]);
  const [durationPreset, setDurationPreset] = useState<number | 'custom'>(30);
  const [customDays, setCustomDays] = useState(45);
  const [campaignCurrency, setCampaignCurrency] = useState<CurrencyCode>(currency);
  const [budget, setBudget] = useState<string>('500000');
  const [targetMarkets, setTargetMarkets] = useState('Nigeria (Lagos, Abuja, Port Harcourt), UK Diaspora, Global');
  const [generating, setGenerating] = useState(false);

  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(campaigns[0]?.id || null);
  const [editedSections, setEditedSections] = useState<CampaignStrategySections | null>(null);
  const [savingEdits, setSavingEdits] = useState(false);

  const selectedCampaign =
    campaigns.find((c) => c.id === selectedCampaignId) || campaigns[0] || null;

  const artistSongs = songs.filter((s) => s.artistId === (artistId || activeArtists[0]?.id));

  const handleGenerateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    const chosenArtistId = artistId || activeArtists[0]?.id;
    const artist = activeArtists.find((a) => a.id === chosenArtistId);
    if (!artist) {
      notify('Create an Artist Profile first before generating a campaign.', 'error');
      return;
    }

    const durationDays = durationPreset === 'custom' ? Math.max(1, Number(customDays) || 30) : durationPreset;
    const numericBudget = Math.max(0, Number(budget) || 0);
    const linkedSong = songs.find((s) => s.id === songId);

    setGenerating(true);
    try {
      const res = await postJsonApi<{
        strategySections: CampaignStrategySections;
        latencyMs: number;
        model: string;
      }>('/api/ai/campaign-generate', {
        artistName: artist.name,
        artistCountry: artist.country,
        artistGenre: artist.genre,
        songTitle: linkedSong?.title || '',
        songMessage: linkedSong?.message || '',
        campaignType,
        durationDays,
        currency: campaignCurrency,
        budget: numericBudget,
        targetMarkets,
      });

      void logAiUsage('campaign_generate', res.model || 'gemini-4-hydrogen', 'success', res.latencyMs || 0);

      const id = makeDocId('camp');
      const finalName =
        campaignName.trim() ||
        `${artist.name} — ${linkedSong?.title ? `${linkedSong.title} ` : ''}${campaignType}`;

      const startDate = new Date().toISOString().slice(0, 10);
      const endObj = new Date();
      endObj.setDate(endObj.getDate() + durationDays);
      const endDate = endObj.toISOString().slice(0, 10);

      await createScopedDoc('campaigns', id, {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        artistId: artist.id,
        artistName: clampStr(artist.name, 140),
        ...(linkedSong ? { songId: linkedSong.id, songTitle: clampStr(linkedSong.title, 180) } : {}),
        name: clampStr(finalName, 200),
        campaignType: clampStr(campaignType, 100),
        durationDays,
        startDate,
        endDate,
        currency: campaignCurrency,
        budget: numericBudget,
        status: 'active',
        targetMarkets: clampStr(targetMarkets, 300),
        strategySections: res.strategySections,
      });

      setSelectedCampaignId(id);
      setEditedSections(null);
      setCampaignName('');
      notify(`Generated and saved 15-section campaign "${finalName}".`, 'success');
    } catch (err) {
      void logAiUsage('campaign_generate', 'gemini-4-hydrogen', 'error', 0);
      notify(err instanceof Error ? err.message : 'Campaign generation failed.', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleStatusChange = async (camp: Campaign, status: Campaign['status']) => {
    try {
      await updateScopedDoc('campaigns', camp.id, { status });
      notify(`Campaign status updated to ${status}.`, 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to update campaign status.', 'error');
    }
  };

  const handleSaveSectionEdits = async () => {
    if (!selectedCampaign || !editedSections) return;
    setSavingEdits(true);
    try {
      await updateScopedDoc('campaigns', selectedCampaign.id, {
        strategySections: editedSections,
      });
      setEditedSections(null);
      notify('Campaign blueprint edits saved to database.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save edits.', 'error');
    } finally {
      setSavingEdits(false);
    }
  };

  const handleCreateStarterTasks = async (camp: Campaign) => {
    try {
      const dueBase = new Date();
      const starters = [
        { title: `Finalize audio & press assets for ${camp.name}`, department: 'Artist & Content', days: 2, priority: 'high' as const },
        { title: `Initiate DJ & Radio outreach wave`, department: 'Media & DJs', days: 5, priority: 'high' as const },
        { title: `Execute creator / TikTok brief wave`, department: 'Influencers', days: 7, priority: 'medium' as const },
        { title: `Weekly performance review & metric logging`, department: 'Analytics', days: 7, priority: 'medium' as const },
      ];
      for (const t of starters) {
        const d = new Date(dueBase);
        d.setDate(d.getDate() + t.days);
        await createScopedDoc('campaign_tasks', makeDocId('task'), {
          organizationId: user.organizationId,
          ownerId: user.uid,
          assignedUserIds: [user.uid],
          campaignId: camp.id,
          campaignName: clampStr(camp.name, 200),
          title: clampStr(t.title, 220),
          department: t.department,
          dueDate: d.toISOString().slice(0, 10),
          priority: t.priority,
          status: 'todo',
        });
      }
      notify('Created 4 execution tasks for this campaign.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to create campaign tasks.', 'error');
    }
  };

  const handleExportMarkdown = (camp: Campaign) => {
    const sectionsText = SECTION_LABELS.map(
      ({ key, label }) => `## ${label}\n\n${camp.strategySections?.[key] || ''}\n`
    ).join('\n');
    const md = `# ${camp.name}\n\n- Artist: ${camp.artistName}\n- Type: ${camp.campaignType}\n- Duration: ${camp.durationDays} days\n- Budget: ${formatMoney(camp.budget, camp.currency)}\n- Target Markets: ${camp.targetMarkets || '—'}\n- Projections Notice: ${camp.strategySections?.projectionsDisclaimer || 'Planning estimates only'}\n\n${sectionsText}`;
    downloadTextFile(`${camp.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.md`, md);
  };

  const handleDeleteCampaign = async (camp: Campaign) => {
    try {
      await deleteScopedDoc('campaigns', camp.id);
      if (selectedCampaignId === camp.id) setSelectedCampaignId(null);
      notify(`Deleted campaign "${camp.name}".`, 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to delete campaign.', 'error');
    }
  };

  const activeSections = editedSections || selectedCampaign?.strategySections || null;

  return (
    <div className="space-y-6">
      <div className="no-print">
        <h1 className="font-display text-2xl font-bold text-white">AI Music Campaign Manager</h1>
        <p className="text-sm text-zinc-400">
          Generate, edit, save, and export full 15-section promotional blueprints in NGN, USD, GBP, or EUR without invented quotes or guaranteed stream claims.
        </p>
      </div>

      {activeArtists.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-8 text-center space-y-3">
          <p className="font-display text-base font-semibold text-white">Add an artist profile first</p>
          <p className="text-sm text-zinc-400">Campaigns must be anchored to an artist in your workspace.</p>
          <button
            type="button"
            onClick={() => setActiveSection('artists')}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#FF5500] text-white"
          >
            Open Artist Management
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Left Builder + Saved List */}
          <div className="xl:col-span-4 space-y-5 no-print">
            <form
              onSubmit={(e) => void handleGenerateCampaign(e)}
              className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-4"
            >
              <h2 className="font-display text-base font-semibold text-white">Generate Campaign Blueprint</h2>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Artist *</label>
                <select
                  value={artistId || activeArtists[0]?.id || ''}
                  onChange={(e) => {
                    setArtistId(e.target.value);
                    setSongId('');
                  }}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                >
                  {activeArtists.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Linked Song (Optional)</label>
                <select
                  value={songId}
                  onChange={(e) => setSongId(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                >
                  <option value="">General Artist / Multi-track</option>
                  {artistSongs.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Campaign Name (Optional)</label>
                <input
                  type="text"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="Auto-named if left blank"
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Campaign Type</label>
                <select
                  value={campaignType}
                  onChange={(e) => setCampaignType(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                >
                  {CAMPAIGN_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Duration</label>
                <div className="flex flex-wrap gap-1.5">
                  {DURATION_PRESETS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDurationPreset(d)}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border ${
                        durationPreset === d
                          ? 'border-[#FF5500] bg-[#FF5500]/15 text-white'
                          : 'border-white/10 bg-[#18181E] text-zinc-300'
                      }`}
                    >
                      {d}d
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setDurationPreset('custom')}
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border ${
                      durationPreset === 'custom'
                        ? 'border-[#FF5500] bg-[#FF5500]/15 text-white'
                        : 'border-white/10 bg-[#18181E] text-zinc-300'
                    }`}
                  >
                    Custom
                  </button>
                </div>
                {durationPreset === 'custom' && (
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={customDays}
                    onChange={(e) => setCustomDays(Number(e.target.value))}
                    className="mt-2 w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                  />
                )}
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">Currency</label>
                  <select
                    value={campaignCurrency}
                    onChange={(e) => setCampaignCurrency(e.target.value as CurrencyCode)}
                    className="w-full rounded-lg border border-white/10 bg-[#18181E] px-2.5 py-2 text-sm text-white"
                  >
                    <option value="NGN">NGN</option>
                    <option value="USD">USD</option>
                    <option value="GBP">GBP</option>
                    <option value="EUR">EUR</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-zinc-300 mb-1">Planned Budget</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white font-mono-tabular"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Target Markets</label>
                <input
                  type="text"
                  value={targetMarkets}
                  onChange={(e) => setTargetMarkets(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>

              <button
                type="submit"
                disabled={generating}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] disabled:opacity-60 transition-colors min-h-[44px]"
              >
                <Rocket className="h-4 w-4" />
                {generating ? 'Generating 15-Section Plan...' : 'Generate AI Campaign'}
              </button>
            </form>

            {/* Saved Campaigns List */}
            <div className="rounded-xl border border-white/10 bg-[#121216] p-4 space-y-3">
              <p className="text-xs font-medium text-zinc-400">Saved Campaigns ({campaigns.length})</p>
              {campaigns.length === 0 ? (
                <p className="text-xs text-zinc-500">No campaigns generated yet.</p>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {campaigns.map((c) => (
                    <div
                      key={c.id}
                      className={`rounded-lg border p-3 transition-colors ${
                        selectedCampaign?.id === c.id
                          ? 'border-[#FF5500] bg-[#FF5500]/10'
                          : 'border-white/10 bg-[#18181E] hover:border-white/25'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedCampaignId(c.id);
                            setEditedSections(null);
                          }}
                          className="text-left flex-1 min-w-0"
                        >
                          <p className="text-sm font-semibold text-white truncate">{c.name}</p>
                          <p className="text-xs text-zinc-400 mt-0.5">
                            {c.durationDays}d · {formatMoney(c.budget, c.currency)} · {c.status}
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteCampaign(c)}
                          className="p-1.5 text-zinc-500 hover:text-red-400"
                          title="Delete campaign"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right 15-Section Campaign Blueprint */}
          <div className="xl:col-span-8">
            {!selectedCampaign || !activeSections ? (
              <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-12 text-center space-y-2">
                <p className="font-display text-base font-semibold text-white">Select or generate a campaign</p>
                <p className="text-sm text-zinc-400">
                  Every generated campaign includes 15 editable sections, NGN/USD budget planning, and task conversion.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-white/10 bg-[#121216] p-5 sm:p-6 space-y-6 print-surface">
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 border-b border-white/10 pb-4">
                  <div className="space-y-1">
                    <p className="text-xs text-[#FF5500] font-medium">
                      {selectedCampaign.campaignType} · {selectedCampaign.durationDays} Days ·{' '}
                      {formatMoney(selectedCampaign.budget, selectedCampaign.currency)}
                    </p>
                    <h2 className="font-display text-xl font-bold text-white">{selectedCampaign.name}</h2>
                    <p className="text-xs text-zinc-400">
                      Artist: {selectedCampaign.artistName}
                      {selectedCampaign.songTitle ? ` · Song: ${selectedCampaign.songTitle}` : ''}
                      {selectedCampaign.targetMarkets ? ` · Markets: ${selectedCampaign.targetMarkets}` : ''}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 no-print">
                    <select
                      value={selectedCampaign.status}
                      onChange={(e) =>
                        void handleStatusChange(selectedCampaign, e.target.value as Campaign['status'])
                      }
                      className="rounded-lg border border-white/10 bg-[#18181E] px-2.5 py-2 text-xs text-white"
                    >
                      <option value="draft">Draft</option>
                      <option value="active">Active</option>
                      <option value="paused">Paused</option>
                      <option value="completed">Completed</option>
                      <option value="archived">Archived</option>
                    </select>

                    <button
                      type="button"
                      onClick={() => void handleCreateStarterTasks(selectedCampaign)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-white/15 bg-[#18181E] text-zinc-200 hover:bg-white/5"
                    >
                      <CheckSquare className="h-3.5 w-3.5 text-[#FF5500]" />
                      Spawn Tasks
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportMarkdown(selectedCampaign)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-white/15 bg-[#18181E] text-zinc-200 hover:bg-white/5"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Export MD
                    </button>
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-white/15 bg-[#18181E] text-zinc-200 hover:bg-white/5"
                    >
                      <Printer className="h-3.5 w-3.5" />
                      Print PDF
                    </button>
                    {!editedSections ? (
                      <button
                        type="button"
                        onClick={() => setEditedSections({ ...selectedCampaign.strategySections })}
                        className="px-3 py-2 text-xs font-semibold rounded-lg bg-[#8B5CF6] text-white hover:bg-[#7C3AED]"
                      >
                        Edit Sections
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleSaveSectionEdits()}
                        disabled={savingEdits}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-[#FF5500] text-white"
                      >
                        <Save className="h-3.5 w-3.5" />
                        {savingEdits ? 'Saving...' : 'Save Edits'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Projections & Assumptions Notice */}
                <div className="rounded-lg border border-amber-500/30 bg-amber-950/15 p-3.5 flex items-start gap-2.5 text-xs text-amber-200">
                  <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">Assumptions & Planning Estimates: </span>
                    {activeSections.projectionsDisclaimer ||
                      'Budget allocations and KPI ranges are planning assumptions—not guaranteed ad rates, playlist acceptances, or streaming outcomes.'}
                  </div>
                </div>

                {/* 15 Sections */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {SECTION_LABELS.map(({ key, label }) => (
                    <div
                      key={key}
                      className="rounded-lg border border-white/10 bg-[#18181E] p-4 space-y-2"
                    >
                      <h3 className="font-display text-xs font-semibold text-white">{label}</h3>
                      {editedSections ? (
                        <textarea
                          rows={4}
                          value={editedSections[key] || ''}
                          onChange={(e) =>
                            setEditedSections({ ...editedSections, [key]: e.target.value })
                          }
                          className="w-full rounded border border-white/15 bg-[#121216] p-2 text-xs text-zinc-200"
                        />
                      ) : (
                        <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-line">
                          {activeSections[key] || '—'}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
