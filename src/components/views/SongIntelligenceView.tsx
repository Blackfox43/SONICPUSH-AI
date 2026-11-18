import React, { useState } from 'react';
import { Upload, Sparkles, CheckCircle2, AlertCircle, Trash2, Music2, Volume2 } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { deleteJsonApi, fetchAuthorizedBlob, getJsonApi, postFormApi } from '../../lib/api';
import { clampStr, createScopedDoc, makeDocId } from '../../lib/firebase';
import type { Song, SongIntelligenceResult } from '../../types/sonicpush';

export const SongIntelligenceView: React.FC = () => {
  const { user, artists, songs, logAiUsage, setActiveSection } = useWorkspace();
  const { notify } = useToast();

  const activeArtists = artists.filter((a) => !a.archived);
  const [artistId, setArtistId] = useState(activeArtists[0]?.id || '');
  const [title, setTitle] = useState('');
  const [genre, setGenre] = useState('Afrobeats');
  const [language, setLanguage] = useState('English, Pidgin');
  const [releaseDate, setReleaseDate] = useState('');
  const [streamingLink, setStreamingLink] = useState('');
  const [message, setMessage] = useState('');
  const [moodAndStyle, setMoodAndStyle] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [audioFile, setAudioFile] = useState<File | null>(null);

  const [analyzing, setAnalyzing] = useState(false);
  const [selectedSong, setSelectedSong] = useState<Song | null>(songs[0] || null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [loadingAudioUrl, setLoadingAudioUrl] = useState(false);

  const handleAnalyzeAndSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const chosenArtistId = artistId || activeArtists[0]?.id;
    const artist = activeArtists.find((a) => a.id === chosenArtistId);
    if (!artist) {
      notify('Please create an Artist Profile first before analyzing a song.', 'error');
      return;
    }
    if (!title.trim()) {
      notify('Please enter a song title.', 'error');
      return;
    }

    setAnalyzing(true);
    try {
      const formData = new FormData();
      formData.append('organizationId', user.organizationId);
      formData.append('title', title.trim());
      formData.append('artistName', artist.name);
      formData.append('genre', genre.trim());
      formData.append('language', language.trim());
      formData.append('releaseDate', releaseDate);
      formData.append('streamingLink', streamingLink.trim());
      formData.append('message', message.trim());
      formData.append('moodAndStyle', moodAndStyle.trim());
      formData.append('lyrics', lyrics.trim());
      if (audioFile) {
        formData.append('audio', audioFile);
      }

      const aiRes = await postFormApi<
        SongIntelligenceResult & {
          audioUploaded?: boolean;
          audioFileName?: string;
          audioStoragePath?: string;
          audioMimeType?: string;
          audioSignatureFormat?: string;
          audioUploadedAt?: string;
          audioRetentionExpiresAt?: string;
          audioStorageCleanupStatus?: 'active' | 'deleted' | 'cleanup_failed' | 'none';
          latencyMs?: number;
          model?: string;
        }
      >('/api/ai/song-intelligence', formData);

      void logAiUsage('song_intelligence', aiRes.model || 'gemini-4-hydrogen', 'success', aiRes.latencyMs || 0);

      const songId = makeDocId('song');
      const intelligence: SongIntelligenceResult = {
        audioProcessed: aiRes.audioProcessed,
        verifiedObservations: aiRes.verifiedObservations || [],
        aiHypotheses: aiRes.aiHypotheses,
      };

      const songDoc = {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        artistId: artist.id,
        artistName: clampStr(artist.name, 140),
        title: clampStr(title, 180),
        genre: clampStr(genre, 120) || 'Afrobeats',
        language: clampStr(language, 100) || 'English',
        releaseDate: clampStr(releaseDate, 40) || 'TBD',
        ...(streamingLink.trim() ? { streamingLink: clampStr(streamingLink, 1024) } : {}),
        ...(aiRes.audioFileName ? { audioFileName: clampStr(aiRes.audioFileName, 240) } : {}),
        ...(aiRes.audioUploaded && aiRes.audioStoragePath
          ? { audioStoragePath: clampStr(aiRes.audioStoragePath, 512) }
          : {}),
        ...(aiRes.audioMimeType ? { audioMimeType: clampStr(aiRes.audioMimeType, 80) } : {}),
        ...(aiRes.audioSignatureFormat
          ? { audioSignatureFormat: clampStr(aiRes.audioSignatureFormat, 40) }
          : {}),
        ...(aiRes.audioUploadedAt ? { audioUploadedAt: clampStr(aiRes.audioUploadedAt, 40) } : {}),
        ...(aiRes.audioRetentionExpiresAt
          ? { audioRetentionExpiresAt: clampStr(aiRes.audioRetentionExpiresAt, 40) }
          : {}),
        ...(aiRes.audioStorageCleanupStatus
          ? { audioStorageCleanupStatus: aiRes.audioStorageCleanupStatus }
          : {}),
        audioProcessed: Boolean(aiRes.audioProcessed),
        message: clampStr(message, 1500),
        moodAndStyle: clampStr(moodAndStyle, 800),
        ...(lyrics.trim() ? { lyrics: clampStr(lyrics, 8000) } : {}),
        intelligence,
      };

      await createScopedDoc('songs', songId, songDoc);
      setSelectedSong({ ...songDoc, id: songId });
      setAudioPreviewUrl(null);
      setTitle('');
      setLyrics('');
      setAudioFile(null);
      notify(`Song Intelligence generated and saved for "${songDoc.title}".`, 'success');
    } catch (err) {
      void logAiUsage('song_intelligence', 'gemini-4-hydrogen', 'error', 0);
      notify(err instanceof Error ? err.message : 'Song analysis failed.', 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleLoadPrivateAudio = async (song: Song) => {
    setLoadingAudioUrl(true);
    try {
      const res = await getJsonApi<{ mode: 'signed_url' | 'proxy_stream'; url: string }>(
        `/api/songs/${encodeURIComponent(song.id)}/audio-url`
      );
      if (res.mode === 'signed_url') {
        setAudioPreviewUrl(res.url);
      } else {
        const blob = await fetchAuthorizedBlob(res.url);
        setAudioPreviewUrl(URL.createObjectURL(blob));
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to load private audio.', 'error');
    } finally {
      setLoadingAudioUrl(false);
    }
  };

  const handleDeleteSong = async (song: Song) => {
    try {
      const result = await deleteJsonApi<{
        ok?: boolean;
        deleted?: boolean;
        error?: string;
      }>(`/api/songs/${encodeURIComponent(song.id)}`);
      if (result.ok === false || result.deleted === false) {
        throw new Error(result.error || 'Server did not confirm song deletion.');
      }
      if (selectedSong?.id === song.id) {
        setSelectedSong(null);
        setAudioPreviewUrl(null);
      }
      notify(`Removed "${song.title}".`, 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to delete song.', 'error');
    }
  };

  const activeDisplayedSong = selectedSong || songs[0] || null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">Song Intelligence Engine</h1>
        <p className="text-sm text-zinc-400">
          Upload an audio track or provide release metadata and authorized lyrics. Verified audio/metadata facts are separated from AI marketing hypotheses.
        </p>
      </div>

      {activeArtists.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-8 text-center space-y-3">
          <p className="font-display text-base font-semibold text-white">Create an artist profile first</p>
          <p className="text-sm text-zinc-400">Every song record links to an artist in your roster.</p>
          <button
            type="button"
            onClick={() => setActiveSection('artists')}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00]"
          >
            Go to Artist Management
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Submission Form */}
          <form
            onSubmit={(e) => void handleAnalyzeAndSave(e)}
            className="lg:col-span-5 rounded-xl border border-white/10 bg-[#121216] p-5 sm:p-6 space-y-4 h-fit"
          >
            <h2 className="font-display text-base font-semibold text-white">Analyze New Release</h2>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Artist *</label>
              <select
                value={artistId || activeArtists[0]?.id || ''}
                onChange={(e) => setArtistId(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2.5 text-sm text-white"
              >
                {activeArtists.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.genre})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Song Title *</label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Lagos Midnight"
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Release Date</label>
                <input
                  type="date"
                  value={releaseDate}
                  onChange={(e) => setReleaseDate(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Genre</label>
                <input
                  type="text"
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Language(s)</label>
                <input
                  type="text"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">
                Audio Upload (MP3, WAV, M4A, AAC, OGG — max 20 MB)
              </label>
              <label className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-white/20 bg-[#18181E] px-4 py-3 cursor-pointer hover:border-[#FF5500] transition-colors">
                <span className="text-xs text-zinc-300 truncate">
                  {audioFile ? `${audioFile.name} (${Math.round(audioFile.size / 1024)} KB)` : 'Select audio file for Gemini listening'}
                </span>
                <Upload className="h-4 w-4 text-[#FF5500] shrink-0" />
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => setAudioFile(e.target.files?.[0] || null)}
                />
              </label>
              <p className="mt-1 text-[11px] text-zinc-500">
                Server validates binary audio file headers (magic bytes) and private retention metadata; automated antivirus scanning is not performed.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Streaming or Preview Link</label>
              <input
                type="url"
                value={streamingLink}
                onChange={(e) => setStreamingLink(e.target.value)}
                placeholder="https://open.spotify.com/..."
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Song Message / Theme</label>
              <textarea
                rows={2}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What story or emotion drives this track?"
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Mood & Sonic Style</label>
              <input
                type="text"
                value={moodAndStyle}
                onChange={(e) => setMoodAndStyle(e.target.value)}
                placeholder="e.g. Late-night bounce, warm log-drum groove, melodic hook"
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Authorized Lyrics (Optional)</label>
              <textarea
                rows={3}
                value={lyrics}
                onChange={(e) => setLyrics(e.target.value)}
                placeholder="Paste lyrics you hold rights to use..."
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              />
            </div>

            <button
              type="submit"
              disabled={analyzing}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] disabled:opacity-60 transition-colors min-h-[44px]"
            >
              <Sparkles className="h-4 w-4" />
              {analyzing ? 'Analyzing Song & Saving...' : 'Run Song Intelligence'}
            </button>
          </form>

          {/* Song List + Intelligence Output */}
          <div className="lg:col-span-7 space-y-5">
            {songs.length > 0 && (
              <div className="rounded-xl border border-white/10 bg-[#121216] p-4 space-y-2.5">
                <p className="text-xs font-medium text-zinc-400">Saved Songs ({songs.length})</p>
                <div className="flex flex-wrap gap-2">
                  {songs.map((s) => (
                    <div
                      key={s.id}
                      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                        activeDisplayedSong?.id === s.id
                          ? 'border-[#FF5500] bg-[#FF5500]/15 text-white'
                          : 'border-white/10 bg-[#18181E] text-zinc-300 hover:border-white/25'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSong(s);
                          setAudioPreviewUrl(null);
                        }}
                        className="font-medium flex items-center gap-1.5"
                      >
                        <Music2 className="h-3 w-3 text-[#FF5500]" />
                        {s.title}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteSong(s)}
                        className="text-zinc-500 hover:text-red-400"
                        title="Delete song"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!activeDisplayedSong ? (
              <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-10 text-center space-y-2">
                <p className="font-display text-base font-semibold text-white">No song analyzed yet</p>
                <p className="text-sm text-zinc-400">
                  Submit the form on the left to generate verified observations and 9-point strategic intelligence.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-white/10 bg-[#121216] p-5 sm:p-6 space-y-6">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4">
                  <div>
                    <p className="text-xs text-zinc-400">
                      {activeDisplayedSong.artistName} · {activeDisplayedSong.genre} · {activeDisplayedSong.language}
                    </p>
                    <h2 className="font-display text-xl font-bold text-white mt-0.5">
                      {activeDisplayedSong.title}
                    </h2>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs font-medium">
                    {activeDisplayedSong.audioProcessed ? (
                      <span className="inline-flex items-center gap-1.5 text-emerald-400">
                        <CheckCircle2 className="h-4 w-4" />
                        Audio Processed by Gemini
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-amber-400">
                        <AlertCircle className="h-4 w-4" />
                        Metadata & Lyrics Only (No Audio File)
                      </span>
                    )}
                    {activeDisplayedSong.audioStoragePath &&
                      activeDisplayedSong.audioStorageCleanupStatus !== 'deleted' && (
                        <button
                          type="button"
                          disabled={loadingAudioUrl}
                          onClick={() => void handleLoadPrivateAudio(activeDisplayedSong)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#18181E] px-2.5 py-1 text-xs text-zinc-200 hover:border-[#FF5500] disabled:opacity-50"
                        >
                          <Volume2 className="h-3.5 w-3.5 text-[#FF5500]" />
                          {loadingAudioUrl ? 'Authorizing...' : 'Load Private Audio'}
                        </button>
                      )}
                  </div>
                </div>

                {audioPreviewUrl && (
                  <div className="rounded-lg border border-white/10 bg-[#18181E] p-3">
                    <audio controls src={audioPreviewUrl} className="w-full h-9" />
                  </div>
                )}

                {/* Verified Observations */}
                <div className="rounded-lg border border-emerald-500/25 bg-emerald-950/15 p-4 space-y-2">
                  <p className="text-xs font-semibold text-emerald-300">
                    Verified Observations (Strictly Grounded in Submitted Audio / Metadata)
                  </p>
                  <ul className="list-disc pl-5 space-y-1 text-xs sm:text-sm text-zinc-200">
                    {(activeDisplayedSong.intelligence?.verifiedObservations || []).map((obs, idx) => (
                      <li key={idx}>{obs}</li>
                    ))}
                  </ul>
                </div>

                {/* AI Hypotheses (9 dimensions) */}
                {activeDisplayedSong.intelligence?.aiHypotheses && (
                  <div className="space-y-4">
                    <p className="text-xs font-semibold text-[#8B5CF6]">
                      AI Strategic Hypotheses (Agency Recommendations)
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="rounded-lg border border-white/10 bg-[#18181E] p-4 space-y-1.5">
                        <h3 className="text-xs font-semibold text-white">1. Song Positioning</h3>
                        <p className="text-xs text-zinc-300 leading-relaxed">
                          {activeDisplayedSong.intelligence.aiHypotheses.songPositioning}
                        </p>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-[#18181E] p-4 space-y-1.5">
                        <h3 className="text-xs font-semibold text-white">2. Genre & Subgenre Assessment</h3>
                        <p className="text-xs text-zinc-300 leading-relaxed">
                          {activeDisplayedSong.intelligence.aiHypotheses.genreAssessment}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {[
                        { title: '3. Potential Audience Segments', items: activeDisplayedSong.intelligence.aiHypotheses.audienceSegments },
                        { title: '4. Marketing Angles', items: activeDisplayedSong.intelligence.aiHypotheses.marketingAngles },
                        { title: '5. Short-Form Video Opportunities', items: activeDisplayedSong.intelligence.aiHypotheses.shortFormOpportunities },
                        { title: '6. Emotional Storytelling', items: activeDisplayedSong.intelligence.aiHypotheses.emotionalStorytelling },
                        { title: '7. Suggested Campaign Objectives', items: activeDisplayedSong.intelligence.aiHypotheses.suggestedObjectives },
                        { title: '8. Artist Branding Recommendations', items: activeDisplayedSong.intelligence.aiHypotheses.brandingRecommendations },
                        { title: '9. Relevant Promotional Channels', items: activeDisplayedSong.intelligence.aiHypotheses.promotionalChannels },
                      ].map((sec) => (
                        <div key={sec.title} className="rounded-lg border border-white/10 bg-[#18181E] p-4 space-y-2">
                          <h3 className="text-xs font-semibold text-white">{sec.title}</h3>
                          <ul className="list-disc pl-4 space-y-1 text-xs text-zinc-300">
                            {(sec.items || []).map((item, i) => (
                              <li key={i}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
