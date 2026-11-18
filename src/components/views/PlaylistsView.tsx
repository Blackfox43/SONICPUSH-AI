import React, { useMemo, useState } from 'react';
import { Disc3, Plus, ExternalLink, ShieldAlert, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { clampStr, createScopedDoc, deleteScopedDoc, makeDocId, updateScopedDoc } from '../../lib/firebase';
import type { PlaylistOpportunity } from '../../types/sonicpush';

export const PlaylistsView: React.FC = () => {
  const { user, songs, playlists } = useWorkspace();
  const { notify } = useToast();

  const [typeFilter, setTypeFilter] = useState<'ALL' | 'official_editorial' | 'independent_curator'>('ALL');
  const [playlistName, setPlaylistName] = useState('');
  const [platform, setPlatform] = useState('Spotify');
  const [playlistType, setPlaylistType] = useState<'official_editorial' | 'independent_curator'>('official_editorial');
  const [submissionRequirements, setSubmissionRequirements] = useState('');
  const [submissionLink, setSubmissionLink] = useState('');
  const [songTitle, setSongTitle] = useState(songs[0]?.title || '');
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    if (typeFilter === 'ALL') return playlists;
    return playlists.filter((p) => p.playlistType === typeFilter);
  }, [playlists, typeFilter]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playlistName.trim()) return;
    setSaving(true);
    try {
      await createScopedDoc('playlist_opportunities', makeDocId('pl'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        playlistName: clampStr(playlistName, 180),
        platform: clampStr(platform, 80),
        playlistType,
        ...(submissionRequirements.trim() ? { submissionRequirements: clampStr(submissionRequirements, 1000) } : {}),
        ...(submissionLink.trim() ? { submissionLink: clampStr(submissionLink, 1024) } : {}),
        ...(songTitle.trim() ? { songTitle: clampStr(songTitle, 180) } : {}),
        submissionDate: new Date().toISOString().slice(0, 10),
        status: 'researched',
      });
      setPlaylistName('');
      setSubmissionRequirements('');
      setSubmissionLink('');
      notify('Playlist opportunity added.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to add playlist opportunity.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">Playlist Promotion</h1>
        <p className="text-sm text-zinc-400">
          Track legitimate editorial and independent playlist pitches, submission dates, requirements, and responses.
        </p>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#121216] p-4 flex items-start gap-2.5 text-xs text-zinc-300">
        <ShieldAlert className="h-4 w-4 text-[#FF5500] shrink-0 mt-0.5" />
        <span>
          SONICPUSH AI strictly separates Official Platform Editorial submissions (e.g., Spotify for Artists, Apple Music, Audiomack, Boomplay) from Independent Curators. We never offer paid playlist guarantees, payola, or artificial streams.
        </span>
      </div>

      <form
        onSubmit={(e) => void handleAdd(e)}
        className="rounded-xl border border-white/10 bg-[#121216] p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
      >
        <input
          type="text"
          required
          value={playlistName}
          onChange={(e) => setPlaylistName(e.target.value)}
          placeholder="Playlist Name *"
          className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
        />
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
        >
          <option value="Spotify">Spotify</option>
          <option value="Apple Music">Apple Music</option>
          <option value="Audiomack">Audiomack</option>
          <option value="Boomplay">Boomplay</option>
          <option value="YouTube Music">YouTube Music</option>
          <option value="Deezer">Deezer</option>
        </select>
        <select
          value={playlistType}
          onChange={(e) => setPlaylistType(e.target.value as 'official_editorial' | 'independent_curator')}
          className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
        >
          <option value="official_editorial">Official Platform Editorial</option>
          <option value="independent_curator">Independent Curator</option>
        </select>
        <input
          type="text"
          value={songTitle}
          onChange={(e) => setSongTitle(e.target.value)}
          placeholder="Song Being Pitched"
          className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
        />
        <input
          type="url"
          value={submissionLink}
          onChange={(e) => setSubmissionLink(e.target.value)}
          placeholder="Official Submission URL"
          className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
        />
        <div className="flex gap-2">
          <input
            type="text"
            value={submissionRequirements}
            onChange={(e) => setSubmissionRequirements(e.target.value)}
            placeholder="Lead time / ISRC / pitch notes"
            className="flex-1 rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          />
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-lg bg-[#FF5500] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e04b00] shrink-0"
          >
            <Plus className="h-4 w-4" />
            Save
          </button>
        </div>
      </form>

      <div className="flex flex-wrap gap-2">
        {(
          [
            { id: 'ALL', label: `All (${playlists.length})` },
            { id: 'official_editorial', label: 'Official Platform Editorial' },
            { id: 'independent_curator', label: 'Independent Curators' },
          ] as const
        ).map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setTypeFilter(f.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
              typeFilter === f.id
                ? 'border-[#FF5500] bg-[#FF5500]/15 text-white'
                : 'border-white/10 bg-[#121216] text-zinc-400'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-10 text-center space-y-2">
          <Disc3 className="h-6 w-6 text-zinc-500 mx-auto" />
          <p className="font-display text-base font-semibold text-white">No playlist opportunities tracked</p>
          <p className="text-sm text-zinc-400">
            Log editorial pitch deadlines and independent curator submissions above.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 bg-[#121216] overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 text-xs text-zinc-400">
                <th className="py-3 px-4 font-medium">Playlist & Platform</th>
                <th className="py-3 px-4 font-medium">Classification</th>
                <th className="py-3 px-4 font-medium">Song & Date</th>
                <th className="py-3 px-4 font-medium">Status</th>
                <th className="py-3 px-4 font-medium">Response Notes</th>
                <th className="py-3 px-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10 text-sm">
              {filtered.map((p) => (
                <tr key={p.id} className="hover:bg-white/[0.02]">
                  <td className="py-3 px-4">
                    <p className="font-medium text-white">{p.playlistName}</p>
                    <p className="text-xs text-zinc-400">
                      {p.platform}
                      {p.submissionRequirements ? ` · ${p.submissionRequirements}` : ''}
                    </p>
                  </td>
                  <td className="py-3 px-4 text-xs text-zinc-300">
                    {p.playlistType === 'official_editorial' ? 'Official Editorial' : 'Independent Curator'}
                  </td>
                  <td className="py-3 px-4 text-xs text-zinc-400">
                    <p className="text-zinc-200">{p.songTitle || '—'}</p>
                    <p className="font-mono-tabular">{p.submissionDate || '—'}</p>
                  </td>
                  <td className="py-3 px-4">
                    <select
                      value={p.status}
                      onChange={(e) =>
                        void updateScopedDoc('playlist_opportunities', p.id, {
                          status: e.target.value as PlaylistOpportunity['status'],
                        })
                      }
                      className="rounded border border-white/10 bg-[#18181E] px-2 py-1 text-xs text-zinc-200"
                    >
                      <option value="researched">Researched</option>
                      <option value="submitted">Submitted</option>
                      <option value="under_review">Under Review</option>
                      <option value="accepted">Accepted</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </td>
                  <td className="py-3 px-4">
                    <input
                      type="text"
                      defaultValue={p.responseNotes || ''}
                      onBlur={(e) =>
                        void updateScopedDoc('playlist_opportunities', p.id, {
                          responseNotes: clampStr(e.target.value, 1000),
                        })
                      }
                      placeholder="Add curator note..."
                      className="rounded border border-white/10 bg-[#18181E] px-2 py-1 text-xs text-white w-44"
                    />
                  </td>
                  <td className="py-3 px-4 text-right space-x-2 whitespace-nowrap">
                    {p.submissionLink && (
                      <a
                        href={p.submissionLink}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-[#8B5CF6] hover:underline"
                      >
                        Link
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => void deleteScopedDoc('playlist_opportunities', p.id)}
                      className="p-1.5 text-zinc-500 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
