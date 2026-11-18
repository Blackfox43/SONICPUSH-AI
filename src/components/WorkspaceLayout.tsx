import React, { useState } from 'react';
import {
  LayoutDashboard,
  Users,
  Sparkles,
  Rocket,
  Clapperboard,
  Globe2,
  UserCheck,
  Radio,
  Disc3,
  Megaphone,
  BarChart3,
  Briefcase,
  CreditCard,
  Bell,
  ShieldCheck,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
  LogOut,
  MessageSquareText,
} from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { BrandMark } from './BrandMark';
import { AiAssistantDrawer } from './AiAssistantDrawer';
import { DashboardView } from './views/DashboardView';
import { ArtistsView } from './views/ArtistsView';
import { SongIntelligenceView } from './views/SongIntelligenceView';
import { CampaignsView } from './views/CampaignsView';
import { ContentStudioView } from './views/ContentStudioView';
import { TrendIntelligenceView } from './views/TrendIntelligenceView';
import { InfluencersView } from './views/InfluencersView';
import { MediaOutreachView } from './views/MediaOutreachView';
import { PlaylistsView } from './views/PlaylistsView';
import { AdvertisingView } from './views/AdvertisingView';
import { AnalyticsView } from './views/AnalyticsView';
import { ClientsPackagesView } from './views/ClientsPackagesView';
import { PaymentsAdminView } from './views/PaymentsAdminView';
import { NotificationsView } from './views/NotificationsView';
import type { CurrencyCode, WorkspaceSection } from '../types/sonicpush';

interface NavItem {
  id: WorkspaceSection;
  label: string;
  icon: React.FC<{ className?: string }>;
  roles?: Array<'SUPER_ADMIN' | 'PROMOTER' | 'ARTIST'>;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { id: 'artists', label: 'Artists & Roster', icon: Users },
  { id: 'song-intelligence', label: 'Song Intelligence', icon: Sparkles },
  { id: 'campaigns', label: 'Campaigns', icon: Rocket },
  { id: 'content-studio', label: 'Content Studio', icon: Clapperboard },
  { id: 'trends', label: 'Trend Intelligence', icon: Globe2 },
  { id: 'influencers', label: 'Influencers', icon: UserCheck },
  { id: 'media-outreach', label: 'DJ, Radio & Media', icon: Radio },
  { id: 'playlists', label: 'Playlists', icon: Disc3 },
  { id: 'advertising', label: 'Ad Manager', icon: Megaphone },
  { id: 'analytics', label: 'Analytics & PDF', icon: BarChart3 },
  { id: 'clients', label: 'Clients & Packages', icon: Briefcase },
  { id: 'payments', label: 'Payments', icon: CreditCard },
  { id: 'notifications', label: 'Tasks & Alerts', icon: Bell },
  { id: 'admin', label: 'Super Admin', icon: ShieldCheck, roles: ['SUPER_ADMIN'] },
];

export const WorkspaceLayout: React.FC<{ onSignOut: () => Promise<void> }> = ({ onSignOut }) => {
  const {
    user,
    isSuperAdmin,
    currency,
    setCurrency,
    activeSection,
    setActiveSection,
    setAssistantOpen,
    notifications,
  } = useWorkspace();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const visibleNav = NAV_ITEMS.filter(
    (item) => !item.roles || item.roles.includes(user.role)
  ).map((item) =>
    item.id === 'clients' && user.role === 'ARTIST'
      ? { ...item, label: 'Service Packages' }
      : item
  );
  const unreadCount = notifications.filter((n) => !n.read).length;
  const activeNavMeta = visibleNav.find((n) => n.id === activeSection);

  const handleSelectSection = (id: WorkspaceSection) => {
    if (id === 'admin' && !isSuperAdmin) {
      setActiveSection('dashboard');
      setMobileNavOpen(false);
      return;
    }
    setActiveSection(id);
    setMobileNavOpen(false);
  };

  const renderSection = () => {
    switch (activeSection) {
      case 'dashboard':
        return <DashboardView />;
      case 'artists':
        return <ArtistsView />;
      case 'song-intelligence':
        return <SongIntelligenceView />;
      case 'campaigns':
        return <CampaignsView />;
      case 'content-studio':
        return <ContentStudioView />;
      case 'trends':
        return <TrendIntelligenceView />;
      case 'influencers':
        return <InfluencersView />;
      case 'media-outreach':
        return <MediaOutreachView />;
      case 'playlists':
        return <PlaylistsView />;
      case 'advertising':
        return <AdvertisingView />;
      case 'analytics':
        return <AnalyticsView />;
      case 'clients':
        return <ClientsPackagesView />;
      case 'payments':
        return <PaymentsAdminView initialTab="payments" />;
      case 'notifications':
        return <NotificationsView />;
      case 'admin':
        return isSuperAdmin ? <PaymentsAdminView initialTab="admin" /> : <DashboardView />;
      default:
        return <DashboardView />;
    }
  };

  return (
    <div className="min-h-screen bg-[#09090B] text-[#FAFAFA] flex">
      {/* Desktop Collapsible Sidebar */}
      <aside
        className={`hidden lg:flex flex-col border-r border-white/10 bg-[#0D0D10] shrink-0 transition-all duration-200 no-print ${
          collapsed ? 'w-[72px]' : 'w-[256px]'
        }`}
      >
        <div className="h-16 px-4 border-b border-white/10 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => handleSelectSection('dashboard')}
            className="overflow-hidden"
          >
            <BrandMark compact={collapsed} />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectSection(item.id)}
                title={collapsed ? item.label : undefined}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-[#FF5500] text-white'
                    : 'text-zinc-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
                {!collapsed && item.id === 'notifications' && unreadCount > 0 && (
                  <span className="ml-auto font-mono-tabular text-[11px]">{unreadCount}</span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-white/10 space-y-2">
          {!collapsed && (
            <div className="px-2 py-1.5">
              <p className="text-xs font-semibold text-white truncate">{user.displayName}</p>
              <p className="text-[11px] text-zinc-400 truncate">
                {user.role.replace('_', ' ')}
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={() => void onSignOut()}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-zinc-400 hover:text-white hover:bg-white/5"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && <span>Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* Mobile Slide-Over Navigation */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex bg-black/75 no-print">
          <div className="w-72 max-w-[85vw] bg-[#0D0D10] border-r border-white/10 h-full flex flex-col">
            <div className="h-14 px-4 border-b border-white/10 flex items-center justify-between">
              <BrandMark />
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="p-2 text-zinc-400 hover:text-white"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3 space-y-1">
              {visibleNav.map((item) => {
                const Icon = item.icon;
                const isActive = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectSection(item.id)}
                    className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium min-h-[44px] ${
                      isActive
                        ? 'bg-[#FF5500] text-white'
                        : 'text-zinc-300 hover:bg-white/5'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-white/10">
              <button
                type="button"
                onClick={() => void onSignOut()}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-zinc-300 hover:text-white min-h-[44px]"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          </div>
          <div className="flex-1" onClick={() => setMobileNavOpen(false)} />
        </div>
      )}

      {/* Main Content Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract (<= 56px mobile height) */}
        <header className="h-14 lg:h-16 border-b border-white/10 bg-[#09090B]/95 backdrop-blur px-4 sm:px-6 flex items-center justify-between gap-4 sticky top-0 z-30 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden inline-flex items-center justify-center h-10 w-10 rounded-lg border border-white/10 text-zinc-200"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 text-xs sm:text-sm text-zinc-400 truncate">
              <span className="hidden sm:inline text-zinc-500">SONICPUSH AI</span>
              <span className="hidden sm:inline text-zinc-600">/</span>
              <span className="font-medium text-white truncate">
                {activeNavMeta?.label || 'Overview'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <select
              value={currency}
              onChange={(e) => void setCurrency(e.target.value as CurrencyCode)}
              aria-label="Workspace Currency"
              className="rounded-lg border border-white/10 bg-[#121216] px-2.5 py-1.5 text-xs font-mono-tabular text-white min-h-[36px]"
            >
              <option value="NGN">NGN</option>
              <option value="USD">USD</option>
              <option value="GBP">GBP</option>
              <option value="EUR">EUR</option>
            </select>

            <button
              type="button"
              onClick={() => handleSelectSection('notifications')}
              className="relative inline-flex items-center justify-center h-9 w-9 rounded-lg border border-white/10 bg-[#121216] text-zinc-300 hover:text-white"
              aria-label="Notifications"
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 h-4 min-w-[16px] px-1 rounded-full bg-[#FF5500] text-[10px] font-bold text-white flex items-center justify-center">
                  {unreadCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setAssistantOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#8B5CF6] text-white hover:bg-[#7C3AED] whitespace-nowrap min-h-[36px]"
            >
              <MessageSquareText className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">AI Strategist</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {renderSection()}
        </main>
      </div>

      <AiAssistantDrawer />
    </div>
  );
};
