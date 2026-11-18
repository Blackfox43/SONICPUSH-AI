import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  createScopedDoc,
  makeDocId,
  subscribeScopedCollection,
  updateScopedDoc,
} from '../lib/firebase';
import type {
  AdPlan,
  AiUsageLog,
  Artist,
  Campaign,
  CampaignMetric,
  CampaignTask,
  ClientRecord,
  ContentCalendarItem,
  ContentIdea,
  CurrencyCode,
  InfluencerContact,
  InvoiceRecord,
  MediaContact,
  NotificationItem,
  OutreachHistoryItem,
  PaymentRecord,
  PlaylistOpportunity,
  ServerAuthSession,
  ServicePackage,
  Song,
  UserProfile,
  WorkspaceSection,
} from '../types/sonicpush';

interface WorkspaceContextValue {
  user: UserProfile;
  isBootstrappedAdmin: boolean;
  isSuperAdmin: boolean;
  canManageClients: boolean;
  currency: CurrencyCode;
  setCurrency: (c: CurrencyCode) => Promise<void>;
  activeSection: WorkspaceSection;
  setActiveSection: (s: WorkspaceSection) => void;
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  loadingData: boolean;
  artists: Artist[];
  songs: Song[];
  campaigns: Campaign[];
  tasks: CampaignTask[];
  contentIdeas: ContentIdea[];
  contentCalendar: ContentCalendarItem[];
  influencers: InfluencerContact[];
  mediaContacts: MediaContact[];
  playlists: PlaylistOpportunity[];
  outreachHistory: OutreachHistoryItem[];
  metrics: CampaignMetric[];
  clients: ClientRecord[];
  servicePackages: ServicePackage[];
  invoices: InvoiceRecord[];
  payments: PaymentRecord[];
  notifications: NotificationItem[];
  aiUsageLogs: AiUsageLog[];
  adPlans: AdPlan[];
  allUsers: UserProfile[];
  logAiUsage: (feature: string, model: string, status: 'success' | 'error', latencyMs: number) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace must be used inside WorkspaceProvider');
  }
  return ctx;
}

export const WorkspaceProvider: React.FC<{
  user: UserProfile;
  sessionAuth?: ServerAuthSession | null;
  children: React.ReactNode;
}> = ({ user, sessionAuth, children }) => {
  const isSuperAdmin =
    Boolean(sessionAuth?.isSuperAdmin) || user.role === 'SUPER_ADMIN';
  const isBootstrappedAdmin = isSuperAdmin;
  const canManageClients =
    sessionAuth?.capabilities?.canManageClients ??
    (user.role === 'SUPER_ADMIN' || user.role === 'PROMOTER');
  const [currency, setCurrencyState] = useState<CurrencyCode>(user.preferredCurrency || 'NGN');
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('dashboard');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [loadingData, setLoadingData] = useState(true);

  const [artists, setArtists] = useState<Artist[]>([]);
  const [songs, setSongs] = useState<Song[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [tasks, setTasks] = useState<CampaignTask[]>([]);
  const [contentIdeas, setContentIdeas] = useState<ContentIdea[]>([]);
  const [contentCalendar, setContentCalendar] = useState<ContentCalendarItem[]>([]);
  const [influencers, setInfluencers] = useState<InfluencerContact[]>([]);
  const [mediaContacts, setMediaContacts] = useState<MediaContact[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistOpportunity[]>([]);
  const [outreachHistory, setOutreachHistory] = useState<OutreachHistoryItem[]>([]);
  const [metrics, setMetrics] = useState<CampaignMetric[]>([]);
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [servicePackages, setServicePackages] = useState<ServicePackage[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [aiUsageLogs, setAiUsageLogs] = useState<AiUsageLog[]>([]);
  const [adPlans, setAdPlans] = useState<AdPlan[]>([]);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);

  useEffect(() => {
    setCurrencyState(user.preferredCurrency || 'NGN');
  }, [user.preferredCurrency]);

  useEffect(() => {
    setLoadingData(true);
    const uid = user.uid;
    const unsubs: Array<() => void> = [];

    const onSubError = (err: Error) => {
      console.warn('Firestore subscription notice:', err.message);
    };

    unsubs.push(
      subscribeScopedCollection<Artist>('artists', uid, isBootstrappedAdmin, (items) => {
        setArtists(items);
        setLoadingData(false);
      }, onSubError),
      subscribeScopedCollection<Song>('songs', uid, isBootstrappedAdmin, setSongs, onSubError),
      subscribeScopedCollection<Campaign>('campaigns', uid, isBootstrappedAdmin, setCampaigns, onSubError),
      subscribeScopedCollection<CampaignTask>('campaign_tasks', uid, isBootstrappedAdmin, setTasks, onSubError),
      subscribeScopedCollection<ContentIdea>('content_ideas', uid, isBootstrappedAdmin, setContentIdeas, onSubError),
      subscribeScopedCollection<ContentCalendarItem>('content_calendar', uid, isBootstrappedAdmin, setContentCalendar, onSubError),
      subscribeScopedCollection<InfluencerContact>('influencer_contacts', uid, isBootstrappedAdmin, setInfluencers, onSubError),
      subscribeScopedCollection<MediaContact>('media_contacts', uid, isBootstrappedAdmin, setMediaContacts, onSubError),
      subscribeScopedCollection<PlaylistOpportunity>('playlist_opportunities', uid, isBootstrappedAdmin, setPlaylists, onSubError),
      subscribeScopedCollection<OutreachHistoryItem>('outreach_history', uid, isBootstrappedAdmin, setOutreachHistory, onSubError),
      subscribeScopedCollection<CampaignMetric>('campaign_metrics', uid, isBootstrappedAdmin, setMetrics, onSubError),
      subscribeScopedCollection<InvoiceRecord>('invoices', uid, isBootstrappedAdmin, setInvoices, onSubError),
      subscribeScopedCollection<PaymentRecord>('payments', uid, isBootstrappedAdmin, setPayments, onSubError),
      subscribeScopedCollection<NotificationItem>('notifications', uid, isBootstrappedAdmin, setNotifications, onSubError),
      subscribeScopedCollection<AiUsageLog>('ai_usage_logs', uid, isBootstrappedAdmin, setAiUsageLogs, onSubError),
      subscribeScopedCollection<AdPlan>('ad_plans', uid, isBootstrappedAdmin, setAdPlans, onSubError),
    );

    if (canManageClients) {
      unsubs.push(
        subscribeScopedCollection<ClientRecord>('clients', uid, isBootstrappedAdmin, setClients, onSubError)
      );
    }

    // service_packages are public to all authenticated users (or all for admin)
    unsubs.push(
      subscribeScopedCollection<ServicePackage>(
        'service_packages',
        uid,
        true,
        setServicePackages,
        onSubError
      )
    );

    if (isSuperAdmin) {
      unsubs.push(
        subscribeScopedCollection<UserProfile>(
          'users',
          uid,
          isBootstrappedAdmin,
          setAllUsers,
          onSubError
        )
      );
    }

    const timer = setTimeout(() => setLoadingData(false), 1200);
    return () => {
      clearTimeout(timer);
      unsubs.forEach((u) => u());
    };
  }, [user.uid, user.role, isBootstrappedAdmin, isSuperAdmin, canManageClients]);

  const setCurrency = useCallback(
    async (c: CurrencyCode) => {
      setCurrencyState(c);
      try {
        await updateScopedDoc('users', user.uid, { preferredCurrency: c });
      } catch (e) {
        console.warn('Currency preference update failed:', e);
      }
    },
    [user.uid]
  );

  const logAiUsage = useCallback(
    async (feature: string, model: string, status: 'success' | 'error', latencyMs: number) => {
      try {
        await createScopedDoc('ai_usage_logs', makeDocId('ailog'), {
          organizationId: user.organizationId,
          ownerId: user.uid,
          assignedUserIds: [user.uid],
          feature: feature.slice(0, 100),
          model: model.slice(0, 80),
          status,
          latencyMs: Math.max(0, Math.round(latencyMs)),
        });
      } catch (err) {
        console.warn('AI usage log skipped:', err);
      }
    },
    [user.organizationId, user.uid]
  );

  return (
    <WorkspaceContext.Provider
      value={{
        user,
        isBootstrappedAdmin,
        isSuperAdmin,
        canManageClients,
        currency,
        setCurrency,
        activeSection,
        setActiveSection,
        assistantOpen,
        setAssistantOpen,
        loadingData,
        artists,
        songs,
        campaigns,
        tasks,
        contentIdeas,
        contentCalendar,
        influencers,
        mediaContacts,
        playlists,
        outreachHistory,
        metrics,
        clients,
        servicePackages,
        invoices,
        payments,
        notifications,
        aiUsageLogs,
        adPlans,
        allUsers,
        logAiUsage,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
};
