import React, { useMemo, useState } from 'react';
import { Clapperboard, Star, CalendarPlus, Trash2, Sparkles } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { postJsonApi } from '../../lib/api';
import { clampStr, createScopedDoc, deleteScopedDoc, makeDocId, updateScopedDoc } from '../../lib/firebase';
import type { ContentCalendarItem, ContentIdea } from '../../types/sonicpush';

const CONTENT_CATEGORIES = [
  'TikTok video ideas',
  'Instagram Reels concepts',
  'YouTube Shorts scripts',
  'Facebook promotional posts',
  'X promotional posts',
  'Song challenge ideas',
  'Dance challenge concepts',
  'UGC creator briefs',
  'Behind-the-scenes video ideas',
  'Artist interview questions',
  'Promotional skits',
  'Release announcement scripts',
  'Countdown content',
  'Fan engagement activities',
];

interface GeneratedIdeaPayload {
  title: string;
  openingHook: string;
  sceneInstructions: string;
  suggestedDuration: number;
  onScreenText: string;
  audioPlacement: string;
  caption: string;
  callToAction: string;
  hashtags: string;
}

export const ContentStudioView: React.FC = () => {
  const { user, artists, songs, contentIdeas, contentCalendar, campaigns, logAiUsage } = useWorkspace();
  const { notify } = useToast();

  const activeArtists = artists.filter((a) => !a.archived);
  const [artistId, setArtistId] = useState(activeArtists[0]?.id || '');
  const [songId, setSongId] = useState('');
  const [category, setCategory] = useState(CONTENT_CATEGORIES[0]);
  const [durationSeconds, setDurationSeconds] = useState<15 | 30 | 60>(30);
  const [variationsCount, setVariationsCount] = useState(3);
  const [generating, setGenerating] = useState(false);

  const [tab, setTab] = useState<'studio' | 'favorites' | 'calendar'>('studio');
  const [calTitle, setCalTitle] = useState('');
  const [calPlatform, setCalPlatform] = useState('TikTok');
  const [calDate, setCalDate] = useState(new Date().toISOString().slice(0, 10));
  const [calCampaignId, setCalCampaignId] = useState('');

  const selectedArtist = activeArtists.find((a) => a.id === (artistId || activeArtists[0]?.id));
  const artistSongs = songs.filter((s) => s.artistId === selectedArtist?.id);
  const selectedSong = artistSongs.find((s) => s.id === songId) || artistSongs[0];

  const displayedIdeas = useMemo(() => {
    if (tab === 'favorites') return contentIdeas.filter((i) => i.isFavorite);
    return contentIdeas;
  }, [contentIdeas, tab]);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedArtist) {
      notify('Add an artist profile first so content concepts match your artist.', 'error');
      return;
    }

    setGenerating(true);
    try {
      const res = await postJsonApi<{
        ideas: GeneratedIdeaPayload[];
        latencyMs: number;
        model: string;
      }>('/api/ai/content-studio', {
        artistName: selectedArtist.name,
        songTitle: selectedSong?.title || `${selectedArtist.name} Latest Release`,
        genre: selectedSong?.genre || selectedArtist.genre,
        moodAndStyle: selectedSong?.moodAndStyle || selectedArtist.marketingObjectives,
        category,
        durationSeconds,
        variationsCount,
      });

      void logAiUsage('content_studio', res.model || 'gemini-4-hydrogen', 'success', res.latencyMs || 0);

      for (const item of res.ideas || []) {
        await createScopedDoc('content_ideas', makeDocId('idea'), {
          organizationId: user.organizationId,
          ownerId: user.uid,
          assignedUserIds: [user.uid],
          artistId: selectedArtist.id,
          ...(selectedSong ? { songId: selectedSong.id } : {}),
          category: clampStr(category, 100),
          durationSeconds,
          title: clampStr(item.title, 200),
          openingHook: clampStr(item.openingHook, 400),
          sceneInstructions: clampStr(item.sceneInstructions, 2000),
          onScreenText: clampStr(item.onScreenText, 500),
          audioPlacement: clampStr(item.audioPlacement, 400),
          caption: clampStr(item.caption, 1000),
          callToAction: clampStr(item.callToAction, 300),
          hashtags: clampStr(item.hashtags, 400),
          isFavorite: false,
        });
      }

      setTab('studio');
      notify(`Generated ${(res.ideas || []).length} ${durationSeconds}s concepts for "${category}".`, 'success');
    } catch (err) {
      void logAiUsage('content_studio', 'gemini-4-hydrogen', 'error', 0);
      notify(err instanceof Error ? err.message : 'Failed to generate content concepts.', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const toggleFavorite = async (idea: ContentIdea) => {
    try {
      await updateScopedDoc('content_ideas', idea.id, { isFavorite: !idea.isFavorite });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update favorite.', 'error');
    }
  };

  const scheduleIdeaToCalendar = async (idea: ContentIdea) => {
    try {
      const nextDate = new Date();
      nextDate.setDate(nextDate.getDate() + 2);
      await createScopedDoc('content_calendar', makeDocId('cal'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        title: clampStr(idea.title, 200),
        platform: idea.category.includes('TikTok')
          ? 'TikTok'
          : idea.category.includes('Reels')
          ? 'Instagram Reels'
          : idea.category.includes('Shorts')
          ? 'YouTube Shorts'
          : 'Multi-Platform',
        scheduledDate: nextDate.toISOString().slice(0, 10),
        format: `${idea.durationSeconds}s ${idea.category}`,
        status: 'planned',
        notes: clampStr(idea.openingHook, 1000),
      });
      notify(`Scheduled "${idea.title}" to Content Calendar.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to schedule item.', 'error');
    }
  };

  const handleAddCalendarEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!calTitle.trim()) return;
    try {
      await createScopedDoc('content_calendar', makeDocId('cal'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        ...(calCampaignId ? { campaignId: calCampaignId } : {}),
        title: clampStr(calTitle, 200),
        platform: clampStr(calPlatform, 80),
        scheduledDate: calDate,
        status: 'planned',
      });
      setCalTitle('');
      notify('Added entry to Content Calendar.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to add calendar item.', 'error');
    }
  };

  const handleCalendarStatus = async (item: ContentCalendarItem, status: ContentCalendarItem['status']) => {
    try {
      await updateScopedDoc('content_calendar', item.id, { status });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update status.', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Viral Content Creation Studio</h1>
          <p className="text-sm text-zinc-400">
            Generate 15s, 30s, and 60s scripts, hooks, scene instructions, captions, and schedule them directly to your release calendar.
          </p>
        </div>

        <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#121216] border border-white/10">
          {(
            [
              { id: 'studio', label: `All Concepts (${contentIdeas.length})` },
              { id: 'favorites', label: `Favorites (${contentIdeas.filter((i) => i.isFavorite).length})` },
              { id: 'calendar', label: `Calendar (${contentCalendar.length})` },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                tab === t.id ? 'bg-[#FF5500] text-white' : 'text-zinc-400 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'calendar' ? (
        <div className="space-y-5">
          <form
            onSubmit={(e) => void handleAddCalendarEntry(e)}
            className="rounded-xl border border-white/10 bg-[#121216] p-5 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end"
          >
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-zinc-300 mb-1">Content Deliverable Title *</label>
              <input
                type="text"
                required
                value={calTitle}
                onChange={(e) => setCalTitle(e.target.value)}
                placeholder="e.g. Studio Hook Teaser #1"
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Platform</label>
              <select
                value={calPlatform}
                onChange={(e) => setCalPlatform(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              >
                <option value="TikTok">TikTok</option>
                <option value="Instagram Reels">Instagram Reels</option>
                <option value="YouTube Shorts">YouTube Shorts</option>
                <option value="X">X</option>
                <option value="Facebook">Facebook</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Date</label>
              <input
                type="date"
                value={calDate}
                onChange={(e) => setCalDate(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              />
            </div>
            <div className="flex gap-2">
              <select
                value={calCampaignId}
                onChange={(e) => setCalCampaignId(e.target.value)}
                className="hidden"
              >
                <option value="">None</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="w-full py-2 px-4 text-xs font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] min-h-[38px]"
              >
                Add Slot
              </button>
            </div>
          </form>

          <div className="rounded-xl border border-white/10 bg-[#121216] overflow-x-auto">
            {contentCalendar.length === 0 ? (
              <p className="p-8 text-center text-sm text-zinc-400">
                No scheduled items yet. Schedule concepts from the studio or add a slot above.
              </p>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 text-xs text-zinc-400">
                    <th className="py-3 px-4 font-medium">Date</th>
                    <th className="py-3 px-4 font-medium">Deliverable</th>
                    <th className="py-3 px-4 font-medium">Platform</th>
                    <th className="py-3 px-4 font-medium">Status</th>
                    <th className="py-3 px-4 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10 text-sm">
                  {contentCalendar.map((item) => (
                    <tr key={item.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 px-4 font-mono-tabular text-xs text-zinc-300">{item.scheduledDate}</td>
                      <td className="py-3 px-4 text-white font-medium">{item.title}</td>
                      <td className="py-3 px-4 text-xs text-zinc-400">{item.platform}</td>
                      <td className="py-3 px-4">
                        <select
                          value={item.status}
                          onChange={(e) =>
                            void handleCalendarStatus(item, e.target.value as ContentCalendarItem['status'])
                          }
                          className="rounded border border-white/10 bg-[#18181E] px-2 py-1 text-xs text-zinc-200"
                        >
                          <option value="planned">Planned</option>
                          <option value="in_production">In Production</option>
                          <option value="ready">Ready</option>
                          <option value="published">Published</option>
                        </select>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => void deleteScopedDoc('content_calendar', item.id)}
                          className="p-1.5 text-zinc-500 hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Generator Form */}
          <form
            onSubmit={(e) => void handleGenerate(e)}
            className="xl:col-span-4 rounded-xl border border-white/10 bg-[#121216] p-5 space-y-4 h-fit"
          >
            <h2 className="font-display text-base font-semibold text-white">Generate Video & Social Scripts</h2>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Artist</label>
              <select
                value={artistId || activeArtists[0]?.id || ''}
                onChange={(e) => {
                  setArtistId(e.target.value);
                  setSongId('');
                }}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              >
                {activeArtists.length === 0 ? (
                  <option value="">No artist created yet</option>
                ) : (
                  activeArtists.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Song</label>
              <select
                value={songId}
                onChange={(e) => setSongId(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              >
                {artistSongs.length === 0 ? (
                  <option value="">General Artist Release</option>
                ) : (
                  artistSongs.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Content Department Format</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              >
                {CONTENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Format Duration</label>
              <div className="grid grid-cols-3 gap-2">
                {([15, 30, 60] as const).map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => setDurationSeconds(sec)}
                    className={`py-2 text-xs font-semibold rounded-lg border ${
                      durationSeconds === sec
                        ? 'border-[#FF5500] bg-[#FF5500]/15 text-white'
                        : 'border-white/10 bg-[#18181E] text-zinc-300'
                    }`}
                  >
                    {sec} sec
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Variations to Generate</label>
              <select
                value={variationsCount}
                onChange={(e) => setVariationsCount(Number(e.target.value))}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              >
                <option value={2}>2 Variations</option>
                <option value={3}>3 Variations</option>
                <option value={4}>4 Variations</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={generating || activeArtists.length === 0}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] disabled:opacity-60 min-h-[44px]"
            >
              <Sparkles className="h-4 w-4" />
              {generating ? 'Generating Scripts...' : 'Generate Content Concepts'}
            </button>
          </form>

          {/* Concepts Grid */}
          <div className="xl:col-span-8 space-y-4">
            {displayedIdeas.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-10 text-center space-y-2">
                <Clapperboard className="h-6 w-6 text-zinc-500 mx-auto" />
                <p className="font-display text-base font-semibold text-white">
                  {tab === 'favorites' ? 'No favorite concepts saved yet' : 'No content concepts generated yet'}
                </p>
                <p className="text-sm text-zinc-400">
                  Generate scripts on the left for TikTok, Reels, YouTube Shorts, challenges, skits, and UGC briefs.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {displayedIdeas.map((idea) => (
                  <div
                    key={idea.id}
                    className="rounded-xl border border-white/10 bg-[#121216] p-5 flex flex-col justify-between space-y-4"
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs text-[#FF5500] font-medium">
                            {idea.category} · {idea.durationSeconds}s
                          </p>
                          <h3 className="font-display text-base font-semibold text-white mt-0.5">
                            {idea.title}
                          </h3>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void toggleFavorite(idea)}
                            className={`p-1.5 rounded-lg ${
                              idea.isFavorite ? 'text-amber-400' : 'text-zinc-500 hover:text-white'
                            }`}
                            title="Save to favorites"
                          >
                            <Star className="h-4 w-4 fill-current" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteScopedDoc('content_ideas', idea.id)}
                            className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400"
                            title="Delete concept"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2 text-xs text-zinc-300">
                        <div>
                          <span className="text-zinc-500 font-medium">Opening Hook: </span>
                          {idea.openingHook}
                        </div>
                        <div>
                          <span className="text-zinc-500 font-medium">Scenes: </span>
                          {idea.sceneInstructions}
                        </div>
                        {idea.onScreenText && (
                          <div>
                            <span className="text-zinc-500 font-medium">On-Screen Text: </span>
                            {idea.onScreenText}
                          </div>
                        )}
                        {idea.audioPlacement && (
                          <div>
                            <span className="text-zinc-500 font-medium">Audio Cue: </span>
                            {idea.audioPlacement}
                          </div>
                        )}
                        <div>
                          <span className="text-zinc-500 font-medium">Caption & CTA: </span>
                          {idea.caption} — <span className="text-white">{idea.callToAction}</span>
                        </div>
                        {idea.hashtags && (
                          <p className="text-zinc-500 font-mono-tabular">{idea.hashtags}</p>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => void scheduleIdeaToCalendar(idea)}
                      className="inline-flex items-center justify-center gap-1.5 w-full py-2 px-3 text-xs font-medium rounded-lg border border-white/15 bg-[#18181E] text-zinc-200 hover:bg-white/5"
                    >
                      <CalendarPlus className="h-3.5 w-3.5 text-[#8B5CF6]" />
                      Schedule to Content Calendar
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
