import React, { useState } from 'react';
import { Globe2, ExternalLink, Search, Info } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { postJsonApi } from '../../lib/api';
import type { TrendItem } from '../../types/sonicpush';

export const TrendIntelligenceView: React.FC = () => {
  const { artists, logAiUsage } = useWorkspace();
  const { notify } = useToast();

  const [market, setMarket] = useState('Nigeria');
  const [platform, setPlatform] = useState('TikTok');
  const [genre, setGenre] = useState('Afrobeats');
  const [artistId, setArtistId] = useState('');
  const [loading, setLoading] = useState(false);

  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [summaryMarkdown, setSummaryMarkdown] = useState('');
  const [sources, setSources] = useState<Array<{ uri: string; title: string }>>([]);

  const handleResearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const selectedArtist = artists.find((a) => a.id === artistId);
      const res = await postJsonApi<{
        trends: TrendItem[];
        summaryMarkdown: string;
        sources: Array<{ uri: string; title: string }>;
        latencyMs: number;
        model: string;
      }>('/api/ai/trends', {
        market,
        platform,
        genre,
        artistContext: selectedArtist
          ? `${selectedArtist.name} (${selectedArtist.genre}, ${selectedArtist.country})`
          : '',
      });

      void logAiUsage('trend_intelligence', res.model || 'gemini-4-hydrogen', 'success', res.latencyMs || 0);
      setTrends(res.trends || []);
      setSummaryMarkdown(res.summaryMarkdown || '');
      setSources(res.sources || []);
      notify('Live search-grounded trend briefing ready.', 'success');
    } catch (err) {
      void logAiUsage('trend_intelligence', 'gemini-4-hydrogen', 'error', 0);
      notify(err instanceof Error ? err.message : 'Failed to research live trends.', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">Trend Intelligence</h1>
        <p className="text-sm text-zinc-400">
          Research emerging music conversations, creator formats, and regional opportunities using live Google Search grounding with cited source links.
        </p>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#121216] p-4 flex items-start gap-2.5 text-xs text-zinc-300">
        <Info className="h-4 w-4 text-[#8B5CF6] shrink-0 mt-0.5" />
        <span>
          SONICPUSH AI uses live Google Search grounding rather than fabricated social metrics. Where private platform API telemetry is unavailable, only verified public web sources are cited.
        </span>
      </div>

      <form
        onSubmit={(e) => void handleResearch(e)}
        className="rounded-xl border border-white/10 bg-[#121216] p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 items-end"
      >
        <div>
          <label className="block text-xs font-medium text-zinc-300 mb-1">Geographic Market</label>
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          >
            <option value="Nigeria">Nigeria</option>
            <option value="West Africa (Nigeria & Ghana)">West Africa</option>
            <option value="South Africa">South Africa</option>
            <option value="East Africa">East Africa</option>
            <option value="United Kingdom">United Kingdom</option>
            <option value="United States">United States</option>
            <option value="Global">Global</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-300 mb-1">Platform</label>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          >
            <option value="TikTok">TikTok</option>
            <option value="Instagram Reels">Instagram Reels</option>
            <option value="YouTube Shorts">YouTube Shorts</option>
            <option value="Spotify & Apple Music">Spotify & Apple Music</option>
            <option value="X (Twitter)">X (Twitter)</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-300 mb-1">Genre Focus</label>
          <input
            type="text"
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            placeholder="Afrobeats, Amapiano..."
            className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-300 mb-1">Match Artist (Optional)</label>
          <select
            value={artistId}
            onChange={(e) => setArtistId(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          >
            <option value="">General Market Scan</option>
            {artists.filter((a) => !a.archived).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] disabled:opacity-60 min-h-[42px]"
        >
          <Search className="h-4 w-4" />
          {loading ? 'Researching...' : 'Research Trends'}
        </button>
      </form>

      {trends.length === 0 && !summaryMarkdown ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-12 text-center space-y-2">
          <Globe2 className="h-6 w-6 text-zinc-500 mx-auto" />
          <p className="font-display text-base font-semibold text-white">Run a live trend scan</p>
          <p className="text-sm text-zinc-400">
            Select a market, platform, and genre above to retrieve grounded music trends and clickable web sources.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {trends.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {trends.map((t, idx) => (
                <div key={idx} className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-[#FF5500] font-medium">
                        {t.platform} · {t.geographicMarket} · {t.dateObserved}
                      </p>
                      <h3 className="font-display text-base font-semibold text-white mt-0.5">
                        {t.trendName}
                      </h3>
                    </div>
                    {t.sourceLink && (
                      <a
                        href={t.sourceLink}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-[#8B5CF6] hover:underline shrink-0"
                      >
                        Source
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-zinc-300 leading-relaxed">
                    <span className="text-zinc-500 font-medium">Relevance: </span>
                    {t.relevanceToArtist}
                  </p>
                  <p className="text-xs text-zinc-300 leading-relaxed">
                    <span className="text-zinc-500 font-medium">Recommended Action: </span>
                    {t.recommendedAction}
                  </p>
                </div>
              ))}
            </div>
          )}

          {summaryMarkdown && (
            <div className="rounded-xl border border-white/10 bg-[#121216] p-5 text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">
              {summaryMarkdown}
            </div>
          )}

          {sources.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-2.5">
              <p className="text-xs font-semibold text-zinc-300">
                Grounded Search Citations ({sources.length})
              </p>
              <div className="flex flex-wrap gap-3">
                {sources.map((s, i) => (
                  <a
                    key={i}
                    href={s.uri}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-[#8B5CF6] hover:underline"
                  >
                    {s.title}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
