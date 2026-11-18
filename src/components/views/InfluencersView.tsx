import React, { useMemo, useState } from 'react';
import { Plus, Search, Sparkles, Trash2, Users } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { postJsonApi } from '../../lib/api';
import { clampStr, createScopedDoc, deleteScopedDoc, makeDocId, updateScopedDoc } from '../../lib/firebase';
import type { InfluencerContact } from '../../types/sonicpush';

export const InfluencersView: React.FC = () => {
  const { user, artists, songs, influencers, logAiUsage } = useWorkspace();
  const { notify } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [countryFilter, setCountryFilter] = useState('ALL');
  const [platformFilter, setPlatformFilter] = useState('ALL');
  const [sourceFilter, setSourceFilter] = useState<'ALL' | 'manual' | 'researched'>('ALL');

  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [platform, setPlatform] = useState('TikTok');
  const [country, setCountry] = useState('Nigeria');
  const [genreFit, setGenreFit] = useState('Afrobeats / Dance');
  const [sourceType, setSourceType] = useState<'manual' | 'researched'>('manual');
  const [publicContact, setPublicContact] = useState('');
  const [agreedDeliverables, setAgreedDeliverables] = useState('');
  const [saving, setSaving] = useState(false);

  const [draftingId, setDraftingId] = useState<string | null>(null);

  const countries = useMemo(
    () => Array.from(new Set(influencers.map((i) => i.country).filter(Boolean))),
    [influencers]
  );

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return influencers.filter((inf) => {
      if (countryFilter !== 'ALL' && inf.country !== countryFilter) return false;
      if (platformFilter !== 'ALL' && inf.platform !== platformFilter) return false;
      if (sourceFilter !== 'ALL' && inf.sourceType !== sourceFilter) return false;
      if (!q) return true;
      return (
        inf.name.toLowerCase().includes(q) ||
        (inf.handle || '').toLowerCase().includes(q) ||
        inf.genreFit.toLowerCase().includes(q)
      );
    });
  }, [influencers, searchQuery, countryFilter, platformFilter, sourceFilter]);

  const handleAddCreator = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createScopedDoc('influencer_contacts', makeDocId('inf'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        name: clampStr(name, 160),
        ...(handle.trim() ? { handle: clampStr(handle, 120) } : {}),
        platform: clampStr(platform, 80),
        country: clampStr(country, 80),
        genreFit: clampStr(genreFit, 120),
        sourceType,
        ...(publicContact.trim() ? { publicContact: clampStr(publicContact, 240) } : {}),
        discussionStatus: 'identified',
        ...(agreedDeliverables.trim() ? { agreedDeliverables: clampStr(agreedDeliverables, 1000) } : {}),
      });
      setName('');
      setHandle('');
      setPublicContact('');
      setAgreedDeliverables('');
      notify('Creator profile saved to directory.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save creator.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (
    inf: InfluencerContact,
    discussionStatus: InfluencerContact['discussionStatus']
  ) => {
    try {
      await updateScopedDoc('influencer_contacts', inf.id, { discussionStatus });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update status.', 'error');
    }
  };

  const handleGenerateProposal = async (inf: InfluencerContact) => {
    const artist = artists.find((a) => !a.archived);
    if (!artist) {
      notify('Create an artist profile first to personalize outreach proposals.', 'error');
      return;
    }
    const song = songs.find((s) => s.artistId === artist.id);
    setDraftingId(inf.id);
    try {
      const res = await postJsonApi<{
        subject: string;
        messageBody: string;
        latencyMs: number;
        model: string;
      }>('/api/ai/outreach-draft', {
        contactName: inf.name,
        contactCategory: `${inf.platform} Creator (${inf.genreFit})`,
        platform: inf.platform,
        country: inf.country,
        channel: 'Instagram DM',
        artistName: artist.name,
        songTitle: song?.title || '',
        genre: artist.genre,
        streamingLink: song?.streamingLink || '',
        deliverableGoal: inf.agreedDeliverables || 'Short-form sound adoption / creator collaboration',
      });
      void logAiUsage('influencer_outreach', res.model || 'gemini-4-hydrogen', 'success', res.latencyMs || 0);
      await updateScopedDoc('influencer_contacts', inf.id, {
        outreachDraft: clampStr(res.messageBody, 2500),
      });
      notify(`Generated collaboration proposal for ${inf.name}.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to draft proposal.', 'error');
    } finally {
      setDraftingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">Influencer & Creator Discovery</h1>
        <p className="text-sm text-zinc-400">
          Organize creators by market, platform, and genre fit. Researched contacts are explicitly separated from manually entered contacts—never fabricated.
        </p>
      </div>

      {/* Add Creator Form */}
      <form
        onSubmit={(e) => void handleAddCreator(e)}
        className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-4"
      >
        <h2 className="font-display text-sm font-semibold text-white">Add Creator Contact</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Creator Name *"
            className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          />
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="Handle (e.g. @creator)"
            className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          />
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          >
            <option value="TikTok">TikTok</option>
            <option value="Instagram">Instagram</option>
            <option value="YouTube">YouTube</option>
            <option value="X">X</option>
            <option value="Snapchat">Snapchat</option>
          </select>
          <input
            type="text"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            placeholder="Country"
            className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          />
          <input
            type="text"
            value={genreFit}
            onChange={(e) => setGenreFit(e.target.value)}
            placeholder="Genre / Audience Fit"
            className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          />
          <select
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value as 'manual' | 'researched')}
            className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          >
            <option value="manual">Manual Entry</option>
            <option value="researched">Researched Contact</option>
          </select>
          <input
            type="text"
            value={publicContact}
            onChange={(e) => setPublicContact(e.target.value)}
            placeholder="Public Contact Email / Link"
            className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          />
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#FF5500] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e04b00] disabled:opacity-60"
          >
            <Plus className="h-4 w-4" />
            Save Creator
          </button>
        </div>
      </form>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="h-4 w-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search creators..."
            className="w-full rounded-lg border border-white/10 bg-[#121216] pl-9 pr-3 py-2 text-sm text-white"
          />
        </div>
        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
          className="rounded-lg border border-white/10 bg-[#121216] px-3 py-2 text-xs text-zinc-200"
        >
          <option value="ALL">All Platforms</option>
          <option value="TikTok">TikTok</option>
          <option value="Instagram">Instagram</option>
          <option value="YouTube">YouTube</option>
          <option value="X">X</option>
        </select>
        <select
          value={countryFilter}
          onChange={(e) => setCountryFilter(e.target.value)}
          className="rounded-lg border border-white/10 bg-[#121216] px-3 py-2 text-xs text-zinc-200"
        >
          <option value="ALL">All Countries</option>
          {countries.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as 'ALL' | 'manual' | 'researched')}
          className="rounded-lg border border-white/10 bg-[#121216] px-3 py-2 text-xs text-zinc-200"
        >
          <option value="ALL">All Sources</option>
          <option value="manual">Manually Entered</option>
          <option value="researched">Researched Contacts</option>
        </select>
      </div>

      {/* Directory List */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-10 text-center space-y-2">
          <Users className="h-6 w-6 text-zinc-500 mx-auto" />
          <p className="font-display text-base font-semibold text-white">No creator contacts recorded</p>
          <p className="text-sm text-zinc-400">
            Add verified public creator profiles above to track deliverables, outreach proposals, and results.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map((inf) => (
            <div key={inf.id} className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-zinc-400">
                    {inf.platform} · {inf.country} · {inf.sourceType === 'researched' ? 'Researched Contact' : 'Manual Entry'}
                  </p>
                  <h3 className="font-display text-base font-semibold text-white mt-0.5">
                    {inf.name} {inf.handle ? <span className="text-zinc-400 font-normal text-xs">{inf.handle}</span> : null}
                  </h3>
                  <p className="text-xs text-zinc-400 mt-0.5">Fit: {inf.genreFit}</p>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={inf.discussionStatus}
                    onChange={(e) =>
                      void handleStatusChange(inf, e.target.value as InfluencerContact['discussionStatus'])
                    }
                    className="rounded border border-white/10 bg-[#18181E] px-2 py-1 text-xs text-zinc-200"
                  >
                    <option value="identified">Identified</option>
                    <option value="contacted">Contacted</option>
                    <option value="negotiating">Negotiating</option>
                    <option value="agreed">Agreed</option>
                    <option value="delivered">Delivered</option>
                    <option value="declined">Declined</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => void deleteScopedDoc('influencer_contacts', inf.id)}
                    className="p-1.5 text-zinc-500 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {inf.publicContact && (
                <p className="text-xs text-zinc-300">Public Contact: {inf.publicContact}</p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  defaultValue={inf.agreedDeliverables || ''}
                  onBlur={(e) =>
                    void updateScopedDoc('influencer_contacts', inf.id, {
                      agreedDeliverables: clampStr(e.target.value, 1000),
                    })
                  }
                  placeholder="Agreed deliverables..."
                  className="rounded border border-white/10 bg-[#18181E] px-2.5 py-1.5 text-xs text-white"
                />
                <input
                  type="text"
                  defaultValue={inf.campaignResults || ''}
                  onBlur={(e) =>
                    void updateScopedDoc('influencer_contacts', inf.id, {
                      campaignResults: clampStr(e.target.value, 1000),
                    })
                  }
                  placeholder="Observed results..."
                  className="rounded border border-white/10 bg-[#18181E] px-2.5 py-1.5 text-xs text-white"
                />
              </div>

              {inf.outreachDraft && (
                <div className="rounded-lg border border-white/10 bg-[#18181E] p-3 text-xs text-zinc-300 whitespace-pre-wrap">
                  {inf.outreachDraft}
                </div>
              )}

              <button
                type="button"
                onClick={() => void handleGenerateProposal(inf)}
                disabled={draftingId === inf.id}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#8B5CF6]/40 bg-[#8B5CF6]/10 text-zinc-100 hover:bg-[#8B5CF6]/20"
              >
                <Sparkles className="h-3.5 w-3.5 text-[#8B5CF6]" />
                {draftingId === inf.id ? 'Drafting...' : 'Generate AI Collaboration Proposal'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
