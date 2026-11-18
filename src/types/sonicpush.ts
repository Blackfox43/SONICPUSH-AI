export type UserRole = 'SUPER_ADMIN' | 'PROMOTER' | 'ARTIST';
export type CurrencyCode = 'NGN' | 'USD' | 'GBP' | 'EUR';

export interface UserProfile {
  uid: string;
  ownerId: string;
  email: string;
  displayName: string;
  photoURL?: string;
  role: UserRole;
  organizationId: string;
  preferredCurrency: CurrencyCode;
  onboardingCompleted: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Organization {
  id: string;
  ownerId: string;
  name: string;
  type: 'AGENCY' | 'INDEPENDENT_ARTIST' | 'LABEL';
  country: string;
  defaultCurrency: CurrencyCode;
  assignedUserIds: string[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Artist {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  name: string;
  avatarUrl?: string;
  bio: string;
  country: string;
  city: string;
  genre: string;
  languages: string;
  targetAudience: string;
  socialLinks?: {
    instagram?: string;
    tiktok?: string;
    x?: string;
    youtube?: string;
  };
  streamingLinks?: {
    spotify?: string;
    appleMusic?: string;
    audiomack?: string;
    boomplay?: string;
  };
  labelOrManagement?: string;
  careerStage: 'Emerging' | 'Developing' | 'Breakout' | 'Established' | 'International';
  marketingObjectives: string;
  archived: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface SongIntelligenceResult {
  audioProcessed: boolean;
  verifiedObservations: string[];
  aiHypotheses: {
    songPositioning: string;
    genreAssessment: string;
    audienceSegments: string[];
    marketingAngles: string[];
    shortFormOpportunities: string[];
    emotionalStorytelling: string[];
    suggestedObjectives: string[];
    brandingRecommendations: string[];
    promotionalChannels: string[];
  };
}

export interface Song {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  artistId: string;
  artistName: string;
  title: string;
  genre: string;
  language: string;
  releaseDate: string;
  streamingLink?: string;
  audioFileName?: string;
  audioStorageUrl?: string;
  audioProcessed: boolean;
  message: string;
  moodAndStyle: string;
  lyrics?: string;
  intelligence?: SongIntelligenceResult;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface CampaignStrategySections {
  overview: string;
  marketingObjectives: string;
  targetAudience: string;
  platformStrategy: string;
  contentCalendar: string;
  promotionalSchedule: string;
  influencerStrategy: string;
  djOutreachStrategy: string;
  radioStrategy: string;
  playlistSubmissionStrategy: string;
  advertisingRecommendations: string;
  budgetBreakdown: string;
  keyPerformanceIndicators: string;
  riskAssessment: string;
  weeklyPerformanceReview: string;
  projectionsDisclaimer: string;
}

export interface Campaign {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  artistId: string;
  artistName: string;
  songId?: string;
  songTitle?: string;
  name: string;
  campaignType: string;
  durationDays: number;
  startDate?: string;
  endDate?: string;
  currency: CurrencyCode;
  budget: number;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  targetMarkets?: string;
  strategySections: CampaignStrategySections;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface CampaignTask {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  campaignId?: string;
  campaignName?: string;
  title: string;
  department: string;
  dueDate: string;
  priority: 'low' | 'medium' | 'high';
  status: 'todo' | 'in_progress' | 'done';
  notes?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ContentIdea {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  artistId?: string;
  songId?: string;
  category: string;
  durationSeconds: 15 | 30 | 60;
  title: string;
  openingHook: string;
  sceneInstructions: string;
  onScreenText?: string;
  audioPlacement?: string;
  caption: string;
  callToAction: string;
  hashtags?: string;
  isFavorite: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ContentCalendarItem {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  campaignId?: string;
  title: string;
  platform: string;
  scheduledDate: string;
  format?: string;
  status: 'planned' | 'in_production' | 'ready' | 'published';
  notes?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface InfluencerContact {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  name: string;
  handle?: string;
  platform: string;
  country: string;
  genreFit: string;
  sourceType: 'researched' | 'manual';
  publicContact?: string;
  discussionStatus: 'identified' | 'contacted' | 'negotiating' | 'agreed' | 'delivered' | 'declined';
  agreedDeliverables?: string;
  campaignResults?: string;
  outreachDraft?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type MediaCategory =
  | 'DJs'
  | 'Radio stations'
  | 'Radio presenters'
  | 'Music bloggers'
  | 'Entertainment journalists'
  | 'Music magazines'
  | 'Playlist curators'
  | 'Event organizers'
  | 'Music influencers';

export interface MediaContact {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  name: string;
  category: MediaCategory;
  country: string;
  location?: string;
  platform: string;
  publicContact?: string;
  outreachStatus: 'not_contacted' | 'pitched' | 'follow_up_due' | 'responded' | 'confirmed' | 'declined';
  lastContactDate?: string;
  followUpDate?: string;
  notes?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PlaylistOpportunity {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  playlistName: string;
  platform: string;
  playlistType: 'official_editorial' | 'independent_curator';
  submissionRequirements?: string;
  submissionLink?: string;
  submissionDate?: string;
  status: 'researched' | 'submitted' | 'under_review' | 'accepted' | 'rejected';
  responseNotes?: string;
  songTitle?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface OutreachHistoryItem {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  contactId?: string;
  contactName: string;
  channel: 'WhatsApp' | 'Instagram DM' | 'Email';
  subject?: string;
  messageBody: string;
  userAuthorized: boolean;
  outcome?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface CampaignMetric {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  campaignId: string;
  campaignName: string;
  platform: string;
  recordedDate: string;
  entrySource: 'manual' | 'api';
  reach?: number;
  impressions?: number;
  videoViews?: number;
  engagement?: number;
  shares?: number;
  comments?: number;
  saves?: number;
  linkClicks?: number;
  reportedStreams?: number;
  followersGained?: number;
  adSpend?: number;
  currency: CurrencyCode;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type PackageTier = 'STARTER' | 'GROWTH' | 'PREMIUM' | 'ELITE' | 'CUSTOM CAMPAIGN';

export interface ClientRecord {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  name: string;
  email: string;
  companyOrLabel?: string;
  country: string;
  packageTier: PackageTier;
  onboardingStatus: 'pending' | 'in_progress' | 'active' | 'completed';
  paymentStatus: 'unpaid' | 'pending_verification' | 'paid' | 'overdue';
  assignedArtistNames?: string;
  internalNotes?: string;
  communicationHistory?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ServicePackage {
  id: string;
  ownerId: string;
  tier: PackageTier;
  title: string;
  description: string;
  priceNGN?: number;
  priceUSD?: number;
  isConfigured: boolean;
  isPublic: boolean;
  campaignLimit: number;
  deliverables: string[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface InvoiceRecord {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  clientName: string;
  packageTier?: string;
  billingType: 'one_time_campaign' | 'monthly_subscription' | 'agency_package' | 'custom_project';
  currency: CurrencyCode;
  amount: number;
  dueDate: string;
  status: 'draft' | 'sent' | 'awaiting_verification' | 'paid' | 'overdue' | 'void';
  notes?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PaymentRecord {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  invoiceId: string;
  provider: 'paystack' | 'flutterwave' | 'stripe' | 'manual_transfer';
  reference: string;
  currency: CurrencyCode;
  amount: number;
  verificationStatus: 'pending' | 'awaiting_provider_integration' | 'verified' | 'failed';
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface NotificationItem {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  category:
    | 'campaign_deadline'
    | 'upcoming_release'
    | 'outreach_followup'
    | 'client_update'
    | 'campaign_completed'
    | 'task_assignment';
  title: string;
  message: string;
  targetDate?: string;
  read: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AiUsageLog {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  feature: string;
  model: string;
  status: 'success' | 'error';
  latencyMs: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AdPlan {
  id: string;
  organizationId: string;
  ownerId: string;
  assignedUserIds: string[];
  campaignId?: string;
  platform: 'Meta Ads' | 'Instagram Ads' | 'Facebook Ads' | 'TikTok Ads' | 'YouTube Ads';
  objective: string;
  audienceDefinition?: string;
  geoTargeting?: string;
  currency: CurrencyCode;
  budget: number;
  durationDays: number;
  creativeRecommendations?: string;
  adCopy?: string;
  humanConfirmed: boolean;
  apiExecutionState: 'manual_plan_only' | 'awaiting_api_integration';
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface TrendItem {
  trendName: string;
  platform: string;
  geographicMarket: string;
  dateObserved: string;
  sourceLink: string;
  relevanceToArtist: string;
  recommendedAction: string;
}

export type WorkspaceSection =
  | 'dashboard'
  | 'artists'
  | 'song-intelligence'
  | 'campaigns'
  | 'content-studio'
  | 'trends'
  | 'influencers'
  | 'media-outreach'
  | 'playlists'
  | 'advertising'
  | 'analytics'
  | 'clients'
  | 'payments'
  | 'notifications'
  | 'admin';
