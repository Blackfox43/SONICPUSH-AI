import React, { useMemo } from 'react';
import {
  Plus,
  Sparkles,
  Rocket,
  BarChart3,
  CalendarClock,
  Bell,
  ArrowUpRight,
  Music2,
  CheckCircle2,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { useWorkspace } from '../../context/WorkspaceContext';
import { convertCurrency, formatMoney, formatNumber } from '../../lib/currency';

export const DashboardView: React.FC = () => {
  const {
    user,
    currency,
    artists,
    songs,
    campaigns,
    metrics,
    tasks,
    notifications,
    loadingData,
    setActiveSection,
    setAssistantOpen,
  } = useWorkspace();

  const stats = useMemo(() => {
    const activeArtists = artists.filter((a) => !a.archived).length;
    const activeCampaigns = campaigns.filter((c) => c.status === 'active').length;
    const completedCampaigns = campaigns.filter((c) => c.status === 'completed').length;
    const promotedSongs = songs.length;

    let totalReach = 0;
    let totalViews = 0;
    let totalEngagement = 0;
    let totalStreams = 0;
    let totalSpendConverted = 0;

    for (const m of metrics) {
      totalReach += m.reach || 0;
      totalViews += m.videoViews || 0;
      totalEngagement += m.engagement || 0;
      totalStreams += m.reportedStreams || 0;
      if (m.adSpend) {
        totalSpendConverted += convertCurrency(m.adSpend, m.currency, currency);
      }
    }

    // Also sum campaign budgets if no adSpend telemetry has been logged yet? No, show actual campaign expenditure from metrics + planned budgets separately so numbers are 100% honest!
    const plannedBudgetConverted = campaigns.reduce(
      (sum, c) => sum + convertCurrency(c.budget || 0, c.currency, currency),
      0
    );

    return {
      activeArtists,
      activeCampaigns,
      completedCampaigns,
      promotedSongs,
      totalReach,
      totalViews,
      totalEngagement,
      totalStreams,
      totalSpendConverted,
      plannedBudgetConverted,
    };
  }, [artists, songs, campaigns, metrics, currency]);

  const chartData = useMemo(() => {
    const byDate = new Map<string, { date: string; reach: number; views: number; streams: number }>();
    const sorted = [...metrics].sort((a, b) => a.recordedDate.localeCompare(b.recordedDate));
    for (const m of sorted) {
      const existing = byDate.get(m.recordedDate) || {
        date: m.recordedDate,
        reach: 0,
        views: 0,
        streams: 0,
      };
      existing.reach += m.reach || 0;
      existing.views += m.videoViews || 0;
      existing.streams += m.reportedStreams || 0;
      byDate.set(m.recordedDate, existing);
    }
    return Array.from(byDate.values());
  }, [metrics]);

  const upcomingReleases = useMemo(() => {
    return [...songs]
      .filter((s) => Boolean(s.releaseDate))
      .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate))
      .slice(0, 5);
  }, [songs]);

  const recentActivity = useMemo(() => {
    const items: Array<{ id: string; label: string; detail: string; target: () => void }> = [];
    campaigns.slice(0, 3).forEach((c) => {
      items.push({
        id: `c_${c.id}`,
        label: `Campaign: ${c.name}`,
        detail: `${c.artistName} · ${c.status} · ${c.durationDays} days`,
        target: () => setActiveSection('campaigns'),
      });
    });
    songs.slice(0, 2).forEach((s) => {
      items.push({
        id: `s_${s.id}`,
        label: `Song: ${s.title}`,
        detail: `${s.artistName} · ${s.audioProcessed ? 'Audio analyzed' : 'Metadata saved'}`,
        target: () => setActiveSection('song-intelligence'),
      });
    });
    tasks.slice(0, 2).forEach((t) => {
      items.push({
        id: `t_${t.id}`,
        label: `Task: ${t.title}`,
        detail: `${t.department} · Due ${t.dueDate} · ${t.status}`,
        target: () => setActiveSection('notifications'),
      });
    });
    return items.slice(0, 6);
  }, [campaigns, songs, tasks, setActiveSection]);

  const unreadNotifications = notifications.filter((n) => !n.read).slice(0, 4);
  const isNewWorkspace = artists.length === 0 && songs.length === 0 && campaigns.length === 0;

  return (
    <div className="space-y-8">
      {/* Header & Quick Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-[#FF5500]">
            {user.role === 'SUPER_ADMIN'
              ? 'Super Admin Command Center'
              : user.role === 'PROMOTER'
              ? 'Agency Promoter Workspace'
              : 'Artist & Client Studio'}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-white mt-1">
            Welcome back, {user.displayName}
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Every figure below is calculated directly from your saved Firestore records.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => setActiveSection('artists')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] transition-colors whitespace-nowrap min-h-[40px]"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Artist
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('song-intelligence')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-white/15 bg-[#121216] text-zinc-200 hover:bg-white/5 transition-colors whitespace-nowrap min-h-[40px]"
          >
            <Sparkles className="h-3.5 w-3.5 text-[#8B5CF6]" />
            Song Intelligence
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('campaigns')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-white/15 bg-[#121216] text-zinc-200 hover:bg-white/5 transition-colors whitespace-nowrap min-h-[40px]"
          >
            <Rocket className="h-3.5 w-3.5 text-[#FF5500]" />
            New Campaign
          </button>
          <button
            type="button"
            onClick={() => setAssistantOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-[#8B5CF6]/40 bg-[#8B5CF6]/10 text-zinc-100 hover:bg-[#8B5CF6]/20 transition-colors whitespace-nowrap min-h-[40px]"
          >
            Ask SONICPUSH AI
          </button>
        </div>
      </div>

      {/* Empty-state guided onboarding for new accounts */}
      {!loadingData && isNewWorkspace && (
        <div className="rounded-xl border border-[#FF5500]/30 bg-[#121216] p-6 space-y-5">
          <div className="space-y-1">
            <h2 className="font-display text-lg font-semibold text-white">
              Launch your first release workflow
            </h2>
            <p className="text-sm text-zinc-400">
              Your database is ready. Complete these three steps to populate live dashboard telemetry and AI strategy context:
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <button
              type="button"
              onClick={() => setActiveSection('artists')}
              className="text-left rounded-lg border border-white/10 bg-[#18181E] p-4 hover:border-[#FF5500]/60 transition-colors space-y-2"
            >
              <p className="font-mono-tabular text-xs text-[#FF5500]">Step 01</p>
              <p className="font-display text-sm font-semibold text-white">Create an Artist Profile</p>
              <p className="text-xs text-zinc-400">Add genre, target markets, streaming links, and career objectives.</p>
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('song-intelligence')}
              className="text-left rounded-lg border border-white/10 bg-[#18181E] p-4 hover:border-[#8B5CF6]/60 transition-colors space-y-2"
            >
              <p className="font-mono-tabular text-xs text-[#8B5CF6]">Step 02</p>
              <p className="font-display text-sm font-semibold text-white">Run Song Intelligence</p>
              <p className="text-xs text-zinc-400">Upload an audio track or lyrics for verified observations & marketing angles.</p>
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('campaigns')}
              className="text-left rounded-lg border border-white/10 bg-[#18181E] p-4 hover:border-[#FF5500]/60 transition-colors space-y-2"
            >
              <p className="font-mono-tabular text-xs text-[#FF5500]">Step 03</p>
              <p className="font-display text-sm font-semibold text-white">Build AI Release Campaign</p>
              <p className="text-xs text-zinc-400">Generate a 15-section promotional blueprint in NGN or USD.</p>
            </button>
          </div>
        </div>
      )}

      {/* Database-Driven KPI Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <div className="rounded-xl border border-white/10 bg-[#121216] p-4 space-y-1">
          <p className="text-xs text-zinc-400">Registered Artists</p>
          <p className="font-mono-tabular text-2xl font-bold text-white">{formatNumber(stats.activeArtists)}</p>
          <p className="text-xs text-zinc-500">{artists.length} total in roster</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-[#121216] p-4 space-y-1">
          <p className="text-xs text-zinc-400">Active Campaigns</p>
          <p className="font-mono-tabular text-2xl font-bold text-[#FF5500]">{formatNumber(stats.activeCampaigns)}</p>
          <p className="text-xs text-zinc-500">{formatNumber(stats.completedCampaigns)} completed</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-[#121216] p-4 space-y-1">
          <p className="text-xs text-zinc-400">Songs Promoted</p>
          <p className="font-mono-tabular text-2xl font-bold text-white">{formatNumber(stats.promotedSongs)}</p>
          <p className="text-xs text-zinc-500">Tracked in Song Intel</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-[#121216] p-4 space-y-1">
          <p className="text-xs text-zinc-400">Tracked Reach</p>
          <p className="font-mono-tabular text-2xl font-bold text-white">{formatNumber(stats.totalReach)}</p>
          <p className="text-xs text-zinc-500">{formatNumber(stats.totalViews)} video views</p>
        </div>
        <div className="col-span-2 md:col-span-2 xl:col-span-1 rounded-xl border border-white/10 bg-[#121216] p-4 space-y-1">
          <p className="text-xs text-zinc-400">Reported Streams</p>
          <p className="font-mono-tabular text-2xl font-bold text-[#8B5CF6]">{formatNumber(stats.totalStreams)}</p>
          <p className="text-xs text-zinc-500">{formatNumber(stats.totalEngagement)} engagements</p>
        </div>
      </div>

      {/* Expenditure + Performance Chart Row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 rounded-xl border border-white/10 bg-[#121216] p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-semibold text-white">
                Campaign Performance Trends
              </h2>
              <p className="text-xs text-zinc-400">
                Aggregated from logged campaign metrics (Reach, Video Views & Reported Streams).
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveSection('analytics')}
              className="inline-flex items-center gap-1 text-xs font-medium text-[#FF5500] hover:underline"
            >
              Open Analytics
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {chartData.length === 0 ? (
            <div className="h-60 rounded-lg border border-dashed border-white/10 flex flex-col items-center justify-center text-center p-6 space-y-3">
              <BarChart3 className="h-6 w-6 text-zinc-500" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-zinc-200">No performance telemetry recorded yet</p>
                <p className="text-xs text-zinc-500 max-w-sm">
                  Log real reach, video views, engagement, and stream figures in Campaign Analytics to populate trend charts.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveSection('analytics')}
                className="px-3.5 py-2 text-xs font-medium rounded-lg bg-[#18181E] border border-white/10 text-zinc-200 hover:bg-white/5"
              >
                Log First Metric Entry
              </button>
            </div>
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="date" stroke="#71717A" fontSize={11} />
                  <YAxis stroke="#71717A" fontSize={11} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#18181E',
                      borderColor: 'rgba(255,255,255,0.12)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Area type="monotone" dataKey="reach" name="Reach" stroke="#FF5500" fill="#FF5500" fillOpacity={0.14} />
                  <Area type="monotone" dataKey="views" name="Video Views" stroke="#8B5CF6" fill="#8B5CF6" fillOpacity={0.14} />
                  <Area type="monotone" dataKey="streams" name="Streams" stroke="#16A34A" fill="#16A34A" fillOpacity={0.1} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Expenditure & Campaign Progress */}
        <div className="lg:col-span-4 rounded-xl border border-white/10 bg-[#121216] p-5 sm:p-6 flex flex-col justify-between space-y-6">
          <div className="space-y-4">
            <h2 className="font-display text-base font-semibold text-white">Expenditure Summary</h2>
            <div className="space-y-3">
              <div className="rounded-lg border border-white/10 bg-[#18181E] p-4">
                <p className="text-xs text-zinc-400">Logged Campaign Spend ({currency})</p>
                <p className="font-mono-tabular text-xl font-bold text-white mt-1">
                  {formatMoney(stats.totalSpendConverted, currency)}
                </p>
              </div>
              <div className="rounded-lg border border-white/10 bg-[#18181E] p-4">
                <p className="text-xs text-zinc-400">Allocated Campaign Budgets ({currency})</p>
                <p className="font-mono-tabular text-xl font-bold text-zinc-200 mt-1">
                  {formatMoney(stats.plannedBudgetConverted, currency)}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-4 border-t border-white/10">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-zinc-300">Campaign Progress</p>
              <span className="font-mono-tabular text-xs text-zinc-400">
                {campaigns.length} total
              </span>
            </div>
            {campaigns.slice(0, 3).map((c) => {
              const pct =
                c.status === 'completed' ? 100 : c.status === 'active' ? 60 : c.status === 'paused' ? 35 : 15;
              return (
                <div key={c.id} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-200 truncate max-w-[180px]">{c.name}</span>
                    <span className="text-zinc-400 capitalize">{c.status}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#FF5500]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {campaigns.length === 0 && (
              <p className="text-xs text-zinc-500">No campaigns created yet.</p>
            )}
          </div>
        </div>
      </div>

      {/* Bottom 3-Column Operations Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Activities */}
        <div className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-4">
          <h2 className="font-display text-base font-semibold text-white">Recent Activities</h2>
          {recentActivity.length === 0 ? (
            <p className="text-xs text-zinc-500">Activities appear automatically as you add artists, songs, campaigns, and tasks.</p>
          ) : (
            <div className="divide-y divide-white/10">
              {recentActivity.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={item.target}
                  className="w-full text-left py-2.5 first:pt-0 last:pb-0 hover:text-[#FF5500] transition-colors"
                >
                  <p className="text-sm font-medium text-zinc-200 truncate">{item.label}</p>
                  <p className="text-xs text-zinc-500 mt-0.5 truncate">{item.detail}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Upcoming Releases */}
        <div className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-white">Release Schedule</h2>
            <CalendarClock className="h-4 w-4 text-zinc-400" />
          </div>
          {upcomingReleases.length === 0 ? (
            <p className="text-xs text-zinc-500">Add songs with release dates in Song Intelligence to track upcoming drops.</p>
          ) : (
            <div className="divide-y divide-white/10">
              {upcomingReleases.map((s) => (
                <div key={s.id} className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-200 truncate flex items-center gap-1.5">
                      <Music2 className="h-3.5 w-3.5 text-[#FF5500] shrink-0" />
                      {s.title}
                    </p>
                    <p className="text-xs text-zinc-500 truncate">{s.artistName} · {s.genre}</p>
                  </div>
                  <span className="font-mono-tabular text-xs text-zinc-300 shrink-0">{s.releaseDate}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Notifications Preview */}
        <div className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-white">Alerts & Reminders</h2>
            <button
              type="button"
              onClick={() => setActiveSection('notifications')}
              className="text-xs font-medium text-[#FF5500] hover:underline"
            >
              View All
            </button>
          </div>
          {unreadNotifications.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
              <span>No unread alerts. Create task or outreach follow-up reminders anytime.</span>
            </div>
          ) : (
            <div className="divide-y divide-white/10">
              {unreadNotifications.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setActiveSection('notifications')}
                  className="w-full text-left py-2.5 first:pt-0 last:pb-0 space-y-0.5"
                >
                  <p className="text-sm font-medium text-zinc-200 flex items-center gap-1.5">
                    <Bell className="h-3.5 w-3.5 text-[#8B5CF6] shrink-0" />
                    <span className="truncate">{n.title}</span>
                  </p>
                  <p className="text-xs text-zinc-400 line-clamp-2">{n.message}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
