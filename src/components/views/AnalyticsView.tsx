import React, { useMemo, useState } from 'react';
import { BarChart3, Download, Printer, Plus, Trash2, Info } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { convertCurrency, formatMoney, formatNumber } from '../../lib/currency';
import { downloadCsv } from '../../lib/exportUtils';
import { clampStr, createScopedDoc, deleteScopedDoc, makeDocId } from '../../lib/firebase';
import type { CurrencyCode } from '../../types/sonicpush';

export const AnalyticsView: React.FC = () => {
  const { user, currency, campaigns, metrics } = useWorkspace();
  const { notify } = useToast();

  const [campaignId, setCampaignId] = useState(campaigns[0]?.id || '');
  const [platform, setPlatform] = useState('TikTok');
  const [recordedDate, setRecordedDate] = useState(new Date().toISOString().slice(0, 10));
  const [metricCurrency, setMetricCurrency] = useState<CurrencyCode>(currency);

  const [reach, setReach] = useState('');
  const [impressions, setImpressions] = useState('');
  const [videoViews, setVideoViews] = useState('');
  const [engagement, setEngagement] = useState('');
  const [shares, setShares] = useState('');
  const [comments, setComments] = useState('');
  const [saves, setSaves] = useState('');
  const [linkClicks, setLinkClicks] = useState('');
  const [reportedStreams, setReportedStreams] = useState('');
  const [followersGained, setFollowersGained] = useState('');
  const [adSpend, setAdSpend] = useState('');
  const [saving, setSaving] = useState(false);

  const [filterCampaignId, setFilterCampaignId] = useState('ALL');

  const filteredMetrics = useMemo(() => {
    const base =
      filterCampaignId === 'ALL'
        ? metrics
        : metrics.filter((m) => m.campaignId === filterCampaignId);
    return [...base].sort((a, b) => a.recordedDate.localeCompare(b.recordedDate));
  }, [metrics, filterCampaignId]);

  const totals = useMemo(() => {
    return filteredMetrics.reduce(
      (acc, m) => {
        acc.reach += m.reach || 0;
        acc.impressions += m.impressions || 0;
        acc.videoViews += m.videoViews || 0;
        acc.engagement += m.engagement || 0;
        acc.shares += m.shares || 0;
        acc.comments += m.comments || 0;
        acc.saves += m.saves || 0;
        acc.linkClicks += m.linkClicks || 0;
        acc.reportedStreams += m.reportedStreams || 0;
        acc.followersGained += m.followersGained || 0;
        acc.adSpend += convertCurrency(m.adSpend || 0, m.currency, currency);
        return acc;
      },
      {
        reach: 0,
        impressions: 0,
        videoViews: 0,
        engagement: 0,
        shares: 0,
        comments: 0,
        saves: 0,
        linkClicks: 0,
        reportedStreams: 0,
        followersGained: 0,
        adSpend: 0,
      }
    );
  }, [filteredMetrics, currency]);

  const platformComparison = useMemo(() => {
    const map = new Map<
      string,
      { platform: string; reach: number; videoViews: number; engagement: number; reportedStreams: number }
    >();
    for (const m of filteredMetrics) {
      const existing = map.get(m.platform) || {
        platform: m.platform,
        reach: 0,
        videoViews: 0,
        engagement: 0,
        reportedStreams: 0,
      };
      existing.reach += m.reach || 0;
      existing.videoViews += m.videoViews || 0;
      existing.engagement += m.engagement || 0;
      existing.reportedStreams += m.reportedStreams || 0;
      map.set(m.platform, existing);
    }
    return Array.from(map.values());
  }, [filteredMetrics]);

  const handleLogMetric = async (e: React.FormEvent) => {
    e.preventDefault();
    const chosenId = campaignId || campaigns[0]?.id;
    const camp = campaigns.find((c) => c.id === chosenId);
    if (!camp) {
      notify('Create a campaign first before logging metrics.', 'error');
      return;
    }

    setSaving(true);
    try {
      const num = (v: string) => (v.trim() === '' ? 0 : Math.max(0, Number(v) || 0));
      await createScopedDoc('campaign_metrics', makeDocId('met'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        campaignId: camp.id,
        campaignName: clampStr(camp.name, 200),
        platform: clampStr(platform, 80),
        recordedDate,
        entrySource: 'manual',
        reach: num(reach),
        impressions: num(impressions),
        videoViews: num(videoViews),
        engagement: num(engagement),
        shares: num(shares),
        comments: num(comments),
        saves: num(saves),
        linkClicks: num(linkClicks),
        reportedStreams: num(reportedStreams),
        followersGained: num(followersGained),
        adSpend: num(adSpend),
        currency: metricCurrency,
      });

      setReach('');
      setImpressions('');
      setVideoViews('');
      setEngagement('');
      setShares('');
      setComments('');
      setSaves('');
      setLinkClicks('');
      setReportedStreams('');
      setFollowersGained('');
      setAdSpend('');
      notify('Logged campaign metric entry.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to save metric entry.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleExportCsv = () => {
    if (filteredMetrics.length === 0) {
      notify('No metrics to export.', 'info');
      return;
    }
    downloadCsv(
      `sonicpush_analytics_${new Date().toISOString().slice(0, 10)}.csv`,
      [
        'Date',
        'Campaign',
        'Platform',
        'Source',
        'Reach',
        'Impressions',
        'Video Views',
        'Engagement',
        'Shares',
        'Comments',
        'Saves',
        'Link Clicks',
        'Reported Streams',
        'Followers Gained',
        'Ad Spend',
        'Currency',
      ],
      filteredMetrics.map((m) => [
        m.recordedDate,
        m.campaignName,
        m.platform,
        m.entrySource,
        m.reach || 0,
        m.impressions || 0,
        m.videoViews || 0,
        m.engagement || 0,
        m.shares || 0,
        m.comments || 0,
        m.saves || 0,
        m.linkClicks || 0,
        m.reportedStreams || 0,
        m.followersGained || 0,
        m.adSpend || 0,
        m.currency,
      ])
    );
  };

  const costPerClick =
    totals.adSpend > 0 && totals.linkClicks > 0 ? totals.adSpend / totals.linkClicks : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 no-print">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Campaign Analytics & Reports</h1>
          <p className="text-sm text-zinc-400">
            Track manual and API-retrieved performance telemetry, compare platforms transparently, and export CSV or PDF reports.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filterCampaignId}
            onChange={(e) => setFilterCampaignId(e.target.value)}
            className="rounded-lg border border-white/10 bg-[#121216] px-3 py-2 text-xs text-zinc-200"
          >
            <option value="ALL">All Campaigns</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-white/15 bg-[#121216] text-zinc-200 hover:bg-white/5"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00]"
          >
            <Printer className="h-3.5 w-3.5" />
            PDF Report
          </button>
        </div>
      </div>

      {/* Log Real Metrics Form */}
      <form
        onSubmit={(e) => void handleLogMetric(e)}
        className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-4 no-print"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-white">Log Campaign Telemetry (Manual Entry)</h2>
          <span className="text-xs text-zinc-400">Tagged automatically as source: manual</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <select
            value={campaignId || campaigns[0]?.id || ''}
            onChange={(e) => setCampaignId(e.target.value)}
            className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          >
            {campaigns.length === 0 ? (
              <option value="">No campaigns available</option>
            ) : (
              campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))
            )}
          </select>

          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          >
            <option value="TikTok">TikTok</option>
            <option value="Instagram">Instagram</option>
            <option value="YouTube">YouTube</option>
            <option value="Spotify">Spotify</option>
            <option value="Apple Music">Apple Music</option>
            <option value="Audiomack">Audiomack</option>
            <option value="Boomplay">Boomplay</option>
            <option value="Radio / DJ">Radio / DJ</option>
            <option value="X">X</option>
          </select>

          <input
            type="date"
            required
            value={recordedDate}
            onChange={(e) => setRecordedDate(e.target.value)}
            className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          />

          <select
            value={metricCurrency}
            onChange={(e) => setMetricCurrency(e.target.value as CurrencyCode)}
            className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
          >
            <option value="NGN">Spend Currency: NGN</option>
            <option value="USD">Spend Currency: USD</option>
            <option value="GBP">Spend Currency: GBP</option>
            <option value="EUR">Spend Currency: EUR</option>
          </select>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          <input type="number" min={0} placeholder="Reach" value={reach} onChange={(e) => setReach(e.target.value)} className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white font-mono-tabular" />
          <input type="number" min={0} placeholder="Impressions" value={impressions} onChange={(e) => setImpressions(e.target.value)} className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white font-mono-tabular" />
          <input type="number" min={0} placeholder="Video Views" value={videoViews} onChange={(e) => setVideoViews(e.target.value)} className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white font-mono-tabular" />
          <input type="number" min={0} placeholder="Engagement" value={engagement} onChange={(e) => setEngagement(e.target.value)} className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white font-mono-tabular" />
          <input type="number" min={0} placeholder="Shares" value={shares} onChange={(e) => setShares(e.target.value)} className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white font-mono-tabular" />
          <input type="number" min={0} placeholder="Comments" value={comments} onChange={(e) => setComments(e.target.value)} className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white font-mono-tabular" />
          <input type="number" min={0} placeholder="Saves" value={saves} onChange={(e) => setSaves(e.target.value)} className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white font-mono-tabular" />
          <input type="number" min={0} placeholder="Link Clicks" value={linkClicks} onChange={(e) => setLinkClicks(e.target.value)} className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white font-mono-tabular" />
          <input type="number" min={0} placeholder="Reported Streams" value={reportedStreams} onChange={(e) => setReportedStreams(e.target.value)} className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white font-mono-tabular" />
          <input type="number" min={0} placeholder="Followers Gained" value={followersGained} onChange={(e) => setFollowersGained(e.target.value)} className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white font-mono-tabular" />
          <input type="number" min={0} placeholder="Ad Spend" value={adSpend} onChange={(e) => setAdSpend(e.target.value)} className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white font-mono-tabular" />
          <button
            type="submit"
            disabled={saving || campaigns.length === 0}
            className="inline-flex items-center justify-center gap-1 rounded-lg bg-[#FF5500] px-3 py-2 text-xs font-semibold text-white hover:bg-[#e04b00] disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            Save Entry
          </button>
        </div>
      </form>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: 'Reach', val: formatNumber(totals.reach) },
          { label: 'Impressions', val: formatNumber(totals.impressions) },
          { label: 'Video Views', val: formatNumber(totals.videoViews) },
          { label: 'Engagement', val: formatNumber(totals.engagement) },
          { label: 'Reported Streams', val: formatNumber(totals.reportedStreams) },
          {
            label: `Ad Spend (${currency})`,
            val: formatMoney(totals.adSpend, currency),
            sub: costPerClick ? `Cost/Click: ${formatMoney(costPerClick, currency)}` : undefined,
          },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-white/10 bg-[#121216] p-4 print-surface">
            <p className="text-xs text-zinc-400">{card.label}</p>
            <p className="font-mono-tabular text-lg font-bold text-white mt-1">{card.val}</p>
            {card.sub && <p className="font-mono-tabular text-[11px] text-zinc-400 mt-0.5">{card.sub}</p>}
          </div>
        ))}
      </div>

      {/* Methodology Note */}
      <div className="rounded-lg border border-white/10 bg-[#121216] p-3.5 flex items-start gap-2.5 text-xs text-zinc-400 print-surface">
        <Info className="h-4 w-4 text-[#8B5CF6] shrink-0 mt-0.5" />
        <span>
          <strong>Metric Transparency:</strong> Social video views (TikTok/Reels/YouTube), DSP streams (Spotify/Apple Music/Audiomack/Boomplay), and link clicks measure distinct user behaviors and are broken out separately by platform below. Each row indicates whether it was logged manually or via future API sync.
        </span>
      </div>

      {/* Graphs */}
      {filteredMetrics.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-10 text-center space-y-2">
          <BarChart3 className="h-6 w-6 text-zinc-500 mx-auto" />
          <p className="font-display text-base font-semibold text-white">No analytics records yet</p>
          <p className="text-sm text-zinc-400">Log your first campaign metric entry above to view charts and exportable reports.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-3 print-surface">
            <h3 className="font-display text-sm font-semibold text-white">Reach & Video Views Over Time</h3>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={filteredMetrics}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="recordedDate" stroke="#71717A" fontSize={11} />
                  <YAxis stroke="#71717A" fontSize={11} />
                  <Tooltip contentStyle={{ backgroundColor: '#18181E', borderColor: 'rgba(255,255,255,0.12)', fontSize: '12px' }} />
                  <Line type="monotone" dataKey="reach" name="Reach" stroke="#FF5500" strokeWidth={2} />
                  <Line type="monotone" dataKey="videoViews" name="Video Views" stroke="#8B5CF6" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-3 print-surface">
            <h3 className="font-display text-sm font-semibold text-white">Platform Comparison</h3>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={platformComparison}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="platform" stroke="#71717A" fontSize={11} />
                  <YAxis stroke="#71717A" fontSize={11} />
                  <Tooltip contentStyle={{ backgroundColor: '#18181E', borderColor: 'rgba(255,255,255,0.12)', fontSize: '12px' }} />
                  <Bar dataKey="videoViews" name="Video Views" fill="#FF5500" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="reportedStreams" name="Reported Streams" fill="#8B5CF6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Detailed Ledger Table */}
      {filteredMetrics.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-[#121216] overflow-x-auto print-surface">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 text-xs text-zinc-400">
                <th className="py-3 px-4 font-medium">Date</th>
                <th className="py-3 px-4 font-medium">Campaign & Platform</th>
                <th className="py-3 px-4 font-medium">Source</th>
                <th className="py-3 px-4 font-medium text-right">Reach</th>
                <th className="py-3 px-4 font-medium text-right">Views</th>
                <th className="py-3 px-4 font-medium text-right">Engagement</th>
                <th className="py-3 px-4 font-medium text-right">Clicks / Saves</th>
                <th className="py-3 px-4 font-medium text-right">Streams</th>
                <th className="py-3 px-4 font-medium text-right">Spend</th>
                <th className="py-3 px-4 font-medium text-right no-print">Del</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10 text-xs">
              {filteredMetrics.map((m) => (
                <tr key={m.id} className="hover:bg-white/[0.02]">
                  <td className="py-3 px-4 font-mono-tabular text-zinc-300">{m.recordedDate}</td>
                  <td className="py-3 px-4">
                    <p className="font-medium text-white">{m.campaignName}</p>
                    <p className="text-zinc-400">{m.platform}</p>
                  </td>
                  <td className="py-3 px-4 text-zinc-400 capitalize">{m.entrySource}</td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-zinc-200">{formatNumber(m.reach)}</td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-zinc-200">{formatNumber(m.videoViews)}</td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-zinc-200">{formatNumber(m.engagement)}</td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-zinc-200">
                    {formatNumber(m.linkClicks)} / {formatNumber(m.saves)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-zinc-200">{formatNumber(m.reportedStreams)}</td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-zinc-200">
                    {formatMoney(m.adSpend || 0, m.currency)}
                  </td>
                  <td className="py-3 px-4 text-right no-print">
                    <button
                      type="button"
                      onClick={() => void deleteScopedDoc('campaign_metrics', m.id)}
                      className="p-1 text-zinc-500 hover:text-red-400"
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
