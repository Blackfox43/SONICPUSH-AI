import React, { useMemo, useState } from 'react';
import { Plus, Search, Archive, RotateCcw, Pencil, Trash2, Music2, ExternalLink, X } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { clampStr, createScopedDoc, deleteScopedDoc, makeDocId, updateScopedDoc } from '../../lib/firebase';
import type { Artist } from '../../types/sonicpush';

const CAREER_STAGES: Artist['careerStage'][] = [
  'Emerging',
  'Developing',
  'Breakout',
  'Established',
  'International',
];

interface ArtistFormState {
  name: string;
  avatarUrl: string;
  bio: string;
  country: string;
  city: string;
  genre: string;
  languages: string;
  targetAudience: string;
  instagram: string;
  tiktok: string;
  x: string;
  youtube: string;
  spotify: string;
  appleMusic: string;
  audiomack: string;
  boomplay: string;
  labelOrManagement: string;
  careerStage: Artist['careerStage'];
  marketingObjectives: string;
}

const EMPTY_FORM: ArtistFormState = {
  name: '',
  avatarUrl: '',
  bio: '',
  country: 'Nigeria',
  city: 'Lagos',
  genre: 'Afrobeats',
  languages: 'English, Yoruba, Pidgin',
  targetAudience: '',
  instagram: '',
  tiktok: '',
  x: '',
  youtube: '',
  spotify: '',
  appleMusic: '',
  audiomack: '',
  boomplay: '',
  labelOrManagement: '',
  careerStage: 'Emerging',
  marketingObjectives: '',
};

export const ArtistsView: React.FC = () => {
  const { user, artists, songs, setActiveSection } = useWorkspace();
  const { notify } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('ALL');
  const [showArchived, setShowArchived] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingArtist, setEditingArtist] = useState<Artist | null>(null);
  const [form, setForm] = useState<ArtistFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [selectedArtistId, setSelectedArtistId] = useState<string | null>(null);

  const filteredArtists = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return artists.filter((a) => {
      if (!showArchived && a.archived) return false;
      if (showArchived && !a.archived) return false;
      if (stageFilter !== 'ALL' && a.careerStage !== stageFilter) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.genre.toLowerCase().includes(q) ||
        a.country.toLowerCase().includes(q) ||
        a.city.toLowerCase().includes(q)
      );
    });
  }, [artists, searchQuery, stageFilter, showArchived]);

  const openCreate = () => {
    setEditingArtist(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEdit = (artist: Artist) => {
    setEditingArtist(artist);
    setForm({
      name: artist.name,
      avatarUrl: artist.avatarUrl || '',
      bio: artist.bio,
      country: artist.country,
      city: artist.city,
      genre: artist.genre,
      languages: artist.languages,
      targetAudience: artist.targetAudience,
      instagram: artist.socialLinks?.instagram || '',
      tiktok: artist.socialLinks?.tiktok || '',
      x: artist.socialLinks?.x || '',
      youtube: artist.socialLinks?.youtube || '',
      spotify: artist.streamingLinks?.spotify || '',
      appleMusic: artist.streamingLinks?.appleMusic || '',
      audiomack: artist.streamingLinks?.audiomack || '',
      boomplay: artist.streamingLinks?.boomplay || '',
      labelOrManagement: artist.labelOrManagement || '',
      careerStage: artist.careerStage,
      marketingObjectives: artist.marketingObjectives,
    });
    setModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      notify('Artist name is required.', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: clampStr(form.name, 140),
        ...(form.avatarUrl.trim() ? { avatarUrl: clampStr(form.avatarUrl, 1024) } : {}),
        bio: clampStr(form.bio, 3000),
        country: clampStr(form.country, 80) || 'Nigeria',
        city: clampStr(form.city, 80) || 'Lagos',
        genre: clampStr(form.genre, 120) || 'Afrobeats',
        languages: clampStr(form.languages, 200),
        targetAudience: clampStr(form.targetAudience, 600),
        socialLinks: {
          instagram: clampStr(form.instagram, 300),
          tiktok: clampStr(form.tiktok, 300),
          x: clampStr(form.x, 300),
          youtube: clampStr(form.youtube, 300),
        },
        streamingLinks: {
          spotify: clampStr(form.spotify, 300),
          appleMusic: clampStr(form.appleMusic, 300),
          audiomack: clampStr(form.audiomack, 300),
          boomplay: clampStr(form.boomplay, 300),
        },
        labelOrManagement: clampStr(form.labelOrManagement, 160),
        careerStage: form.careerStage,
        marketingObjectives: clampStr(form.marketingObjectives, 1200),
      };

      if (editingArtist) {
        await updateScopedDoc('artists', editingArtist.id, payload);
        notify(`Updated profile for ${payload.name}.`, 'success');
      } else {
        const id = makeDocId('art');
        await createScopedDoc('artists', id, {
          ...payload,
          organizationId: user.organizationId,
          ownerId: user.uid,
          assignedUserIds: [user.uid],
          archived: false,
        });
        notify(`Created artist profile for ${payload.name}.`, 'success');
      }
      setModalOpen(false);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save artist.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async (artist: Artist) => {
    try {
      await updateScopedDoc('artists', artist.id, { archived: !artist.archived });
      notify(
        artist.archived ? `${artist.name} restored to active roster.` : `${artist.name} archived.`,
        'info'
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update archive state.', 'error');
    }
  };

  const handleDelete = async (artist: Artist) => {
    try {
      await deleteScopedDoc('artists', artist.id);
      if (selectedArtistId === artist.id) setSelectedArtistId(null);
      notify(`Deleted artist ${artist.name}.`, 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to delete artist.', 'error');
    }
  };

  const selectedArtist = artists.find((a) => a.id === selectedArtistId) || null;
  const selectedArtistSongs = selectedArtist
    ? songs.filter((s) => s.artistId === selectedArtist.id)
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Artist Management</h1>
          <p className="text-sm text-zinc-400">
            Manage artist profiles, streaming & social links, career stages, and attached song catalogs.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] transition-colors whitespace-nowrap min-h-[44px]"
        >
          <Plus className="h-4 w-4" />
          Add Artist Profile
        </button>
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-4 w-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by artist name, genre, city, or country..."
            className="w-full rounded-lg border border-white/10 bg-[#121216] pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-[#FF5500]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="rounded-lg border border-white/10 bg-[#121216] px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-[#FF5500] min-h-[40px]"
          >
            <option value="ALL">All Career Stages</option>
            {CAREER_STAGES.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors min-h-[40px] ${
              showArchived
                ? 'border-[#8B5CF6] bg-[#8B5CF6]/15 text-white'
                : 'border-white/10 bg-[#121216] text-zinc-300 hover:bg-white/5'
            }`}
          >
            <Archive className="h-3.5 w-3.5" />
            {showArchived ? 'Viewing Archived' : 'Show Archived'}
          </button>
        </div>
      </div>

      {/* Artist Cards Grid */}
      {filteredArtists.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-10 text-center space-y-3">
          <p className="font-display text-base font-semibold text-white">
            {showArchived ? 'No archived artists' : 'No artist profiles found'}
          </p>
          <p className="text-sm text-zinc-400 max-w-md mx-auto">
            {showArchived
              ? 'Archived profiles will appear here when you archive an artist.'
              : 'Create your first artist profile to unlock Song Intelligence, AI Campaigns, and Content Studio briefs.'}
          </p>
          {!showArchived && (
            <button
              type="button"
              onClick={openCreate}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00]"
            >
              Create First Artist
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filteredArtists.map((artist) => {
            const artistSongs = songs.filter((s) => s.artistId === artist.id);
            return (
              <div
                key={artist.id}
                className="rounded-xl border border-white/10 bg-[#121216] p-5 flex flex-col justify-between space-y-4"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {artist.avatarUrl ? (
                        <img
                          src={artist.avatarUrl}
                          alt={artist.name}
                          referrerPolicy="no-referrer"
                          className="h-12 w-12 rounded-lg object-cover border border-white/10 shrink-0"
                        />
                      ) : (
                        <div className="h-12 w-12 rounded-lg bg-[#18181E] border border-white/10 flex items-center justify-center font-display font-bold text-[#FF5500] shrink-0">
                          {artist.name.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => setSelectedArtistId(artist.id)}
                          className="font-display text-base font-semibold text-white hover:text-[#FF5500] transition-colors truncate block text-left"
                        >
                          {artist.name}
                        </button>
                        <p className="text-xs text-zinc-400 truncate">
                          {artist.genre} · {artist.city}, {artist.country}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs text-zinc-400 shrink-0">{artist.careerStage}</span>
                  </div>

                  <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">
                    {artist.bio || 'No biography added yet.'}
                  </p>

                  <div className="text-xs text-zinc-500 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>{artistSongs.length} song{artistSongs.length === 1 ? '' : 's'}</span>
                    <span>·</span>
                    <span>{artist.languages || 'Language not specified'}</span>
                    {artist.labelOrManagement && (
                      <>
                        <span>·</span>
                        <span>{artist.labelOrManagement}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="pt-3 border-t border-white/10 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedArtistId(artist.id)}
                    className="text-xs font-medium text-[#FF5500] hover:underline"
                  >
                    Inspect Roster & Songs
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(artist)}
                      className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5"
                      title="Edit artist"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleArchive(artist)}
                      className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5"
                      title={artist.archived ? 'Restore artist' : 'Archive artist'}
                    >
                      {artist.archived ? <RotateCcw className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(artist)}
                      className="p-2 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-white/5"
                      title="Delete artist"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Selected Artist Detail Drawer */}
      {selectedArtist && (
        <div className="rounded-xl border border-white/15 bg-[#121216] p-6 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs text-[#FF5500] font-medium">Artist Dossier</p>
              <h2 className="font-display text-xl font-bold text-white mt-0.5">{selectedArtist.name}</h2>
              <p className="text-xs text-zinc-400 mt-1">
                {selectedArtist.city}, {selectedArtist.country} · {selectedArtist.genre} · {selectedArtist.careerStage}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedArtistId(null)}
              className="p-2 rounded-lg border border-white/10 text-zinc-400 hover:text-white"
              aria-label="Close dossier"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 text-sm">
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-zinc-400">Biography</p>
                <p className="text-zinc-200 mt-1 leading-relaxed">{selectedArtist.bio || '—'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-zinc-400">Target Audience</p>
                <p className="text-zinc-200 mt-1">{selectedArtist.targetAudience || '—'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-zinc-400">Marketing Objectives</p>
                <p className="text-zinc-200 mt-1">{selectedArtist.marketingObjectives || '—'}</p>
              </div>
              <div className="flex flex-wrap gap-3 pt-2">
                {Object.entries({
                  ...(selectedArtist.socialLinks || {}),
                  ...(selectedArtist.streamingLinks || {}),
                })
                  .filter(([, url]) => Boolean(url))
                  .map(([platform, url]) => (
                    <a
                      key={platform}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-[#8B5CF6] hover:underline capitalize"
                    >
                      {platform}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ))}
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-zinc-400">
                  Songs Catalog ({selectedArtistSongs.length})
                </p>
                <button
                  type="button"
                  onClick={() => setActiveSection('song-intelligence')}
                  className="text-xs font-medium text-[#FF5500] hover:underline"
                >
                  + Add / Analyze Song
                </button>
              </div>
              {selectedArtistSongs.length === 0 ? (
                <p className="text-xs text-zinc-500">No songs linked to this artist yet.</p>
              ) : (
                <div className="divide-y divide-white/10 rounded-lg border border-white/10 bg-[#18181E] px-4">
                  {selectedArtistSongs.map((s) => (
                    <div key={s.id} className="py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate flex items-center gap-1.5">
                          <Music2 className="h-3.5 w-3.5 text-[#FF5500] shrink-0" />
                          {s.title}
                        </p>
                        <p className="text-xs text-zinc-400">
                          {s.genre} · {s.language} · {s.releaseDate || 'TBD'}
                        </p>
                      </div>
                      <span className="text-xs text-zinc-400 shrink-0">
                        {s.audioProcessed ? 'Audio Verified' : 'Metadata'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={(e) => void handleSave(e)}
            className="w-full max-w-3xl rounded-xl border border-white/15 bg-[#121216] p-6 space-y-5 my-8 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-white">
                {editingArtist ? `Edit ${editingArtist.name}` : 'Create Artist Profile'}
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-2 rounded-lg text-zinc-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Artist Name *</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Profile Picture URL (Optional)</label>
                <input
                  type="url"
                  value={form.avatarUrl}
                  onChange={(e) => setForm({ ...form, avatarUrl: e.target.value })}
                  placeholder="https://..."
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Country</label>
                <input
                  type="text"
                  value={form.country}
                  onChange={(e) => setForm({ ...form, country: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">City</label>
                <input
                  type="text"
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Primary Genre(s)</label>
                <input
                  type="text"
                  value={form.genre}
                  onChange={(e) => setForm({ ...form, genre: e.target.value })}
                  placeholder="Afrobeats, Amapiano, Afro-fusion"
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Languages</label>
                <input
                  type="text"
                  value={form.languages}
                  onChange={(e) => setForm({ ...form, languages: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Career Stage</label>
                <select
                  value={form.careerStage}
                  onChange={(e) => setForm({ ...form, careerStage: e.target.value as Artist['careerStage'] })}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                >
                  {CAREER_STAGES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Record Label / Management</label>
                <input
                  type="text"
                  value={form.labelOrManagement}
                  onChange={(e) => setForm({ ...form, labelOrManagement: e.target.value })}
                  placeholder="Independent or Label Name"
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Artist Biography</label>
              <textarea
                rows={3}
                value={form.bio}
                onChange={(e) => setForm({ ...form, bio: e.target.value })}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Target Audience</label>
                <textarea
                  rows={2}
                  value={form.targetAudience}
                  onChange={(e) => setForm({ ...form, targetAudience: e.target.value })}
                  placeholder="e.g. Gen-Z Lagos/London Afrobeats listeners, campus DJs"
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Marketing Objectives</label>
                <textarea
                  rows={2}
                  value={form.marketingObjectives}
                  onChange={(e) => setForm({ ...form, marketingObjectives: e.target.value })}
                  placeholder="e.g. Build TikTok sound adoption and Nigerian radio rotation"
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <input
                type="url"
                placeholder="Instagram URL"
                value={form.instagram}
                onChange={(e) => setForm({ ...form, instagram: e.target.value })}
                className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white"
              />
              <input
                type="url"
                placeholder="TikTok URL"
                value={form.tiktok}
                onChange={(e) => setForm({ ...form, tiktok: e.target.value })}
                className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white"
              />
              <input
                type="url"
                placeholder="Spotify URL"
                value={form.spotify}
                onChange={(e) => setForm({ ...form, spotify: e.target.value })}
                className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white"
              />
              <input
                type="url"
                placeholder="Audiomack / Boomplay"
                value={form.audiomack}
                onChange={(e) => setForm({ ...form, audiomack: e.target.value })}
                className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white"
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-white/15 text-zinc-300 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-5 py-2 text-xs font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] disabled:opacity-60"
              >
                {saving ? 'Saving...' : editingArtist ? 'Save Changes' : 'Create Artist'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
