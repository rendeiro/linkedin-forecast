export type PostType = 'video' | 'image' | 'text' | 'document' | 'unknown';
export type SnapshotSource = 'post_summary' | 'feed' | 'post_page' | 'notification' | 'export';
export type PageType = 'analytics' | 'post_summary' | 'feed' | 'post_page' | 'notifications' | 'other';

export interface Post {
  urn: string;                 // 19-digit activity id
  publishedAt: string;         // ISO
  publishedApprox: boolean;
  timeTrusted?: boolean;       // publish time confirmed by a page label or an early first reading
  type: PostType;
  textPreview?: string;
  firstSeenAt: string;
  actual24h?: number;
  actual24hApprox?: boolean;
  lifetime?: number;
}

export interface Snapshot {
  id?: number;
  urn: string;
  observedAt: string;
  impressions: number;
  inNetworkShare?: number;
  membersReached?: number;
  reactions?: number;
  comments?: number;
  reposts?: number;
  source: SnapshotSource;
}

export interface Daily {
  utcDate: string;             // YYYY-MM-DD
  impressions: number;
  engagements?: number;
  final: boolean;
  source: 'analytics' | 'export' | 'derived';
  updatedAt: string;
}

export interface DailyReading {
  id?: number;
  utcDate: string;
  observedAt: string;
  value: number;
  source: 'analytics' | 'derived' | 'partial';
}

export interface FollowerPoint { utcDate: string; count: number; }

export type Horizon = '24h' | 'eod' | 'dayahead';
export interface ForecastRecord {
  id?: number;
  createdAt: string;
  target: 'post' | 'day';
  key: string;
  horizon: Horizon;
  point: number;
  low: number;
  high: number;
  shareObserved: number;
  modelVersion: number;
  regime: Regime;
  postType?: PostType;
  actual?: number;
  errorPct?: number;
  inBand?: boolean;
}

export interface NudgeRecord {
  id?: number;
  type: string;
  firedAt: string;
  key: string;
  text: string;
  clicked: boolean;
}

export type Regime = 'priors' | 'calibrating' | 'fitted';

export interface Settings {
  goal: { kind: 'daily' | 'monthly' | null; value: number };
  quietHours: { start: number; end: number };
  autoVisit: { enabled: boolean; analyticsMin: number; postMin: number };
  notifCap: number;
  tzOverride?: string;
  overlay: boolean;
  noPostToday?: string;        // utcDate for which the user toggled "no post"
}

export const DEFAULT_SETTINGS: Settings = {
  goal: { kind: null, value: 0 },
  quietHours: { start: 23, end: 7 },
  autoVisit: { enabled: true, analyticsMin: 60, postMin: 30 },
  notifCap: 4,
  overlay: true,
};

export type Table = Record<string, number>;

export interface ModelState {
  version: number;
  sPost: Table;
  sDay: Table;
  dow: number[];
  recentTotals: number[];
  recentDaily: number[];
  nPostActuals: number;
  typeActuals: Partial<Record<PostType, number[]>>;
  sdScale: { post: number; day: number };
}

export interface Onboarding {
  step: number;
  done: boolean;
  profileId?: string;
  timezone?: string;
  postsToRead?: string[];
  postsRead?: string[];
}

export interface HealthEntry { lastOkAt?: string; lastErrorAt?: string; lastError?: string; path?: string; }
export type CaptureHealth = Partial<Record<PageType, HealthEntry>>;

// ---- Messages from content scripts to background ----
export interface PostSeen {
  urn: string;
  type?: PostType;
  textPreview?: string;
  ageHintHours?: number;       // from "3h" / "2d" labels
}

export type ContentMessage =
  | { type: 'snapshot'; payload: Snapshot & { post?: PostSeen } }
  | { type: 'daily'; payload: { points: { utcDate: string; impressions: number; engagements?: number }[]; observedAt: string; timezone?: string; profileId?: string } }
  | { type: 'total7'; payload: { value: number; observedAt: string } }
  | { type: 'posts'; payload: { posts: PostSeen[]; topPosts?: { urn: string; impressions: number }[] } }
  | { type: 'followers'; payload: { points: FollowerPoint[] } }
  | { type: 'health'; payload: { page: PageType; ok: boolean; error?: string; path?: string } }
  | { type: 'forecast:post'; payload: { urn: string } }
  | { type: 'forecast:day'; payload?: { days?: number } };

export interface PostForecastView {
  urn: string;
  publishedAt: string;
  hours: number;
  impressions: number;
  point: number;               // count expected at the end of the current UTC day
  low: number;
  high: number;
  total24?: number;            // internal scale estimate
  gainPerHour?: number;
  tailMode: boolean;
  status: 'starting' | 'rising' | 'slowing' | 'tail';
  series: [number, number][];  // [hours since publish, impressions], subsampled
  textPreview?: string;
  regime: Regime;
  type: PostType;
  observedAt: string;
}

export interface GoalView {
  target: number;               // monthly target, 0 when unset
  recordedMonth: number;        // completed days this month
  todayEod: number;
  monthEod: number;             // recorded + today's EOD
  daysLeft: number;             // including today
  paceNeeded: number;           // per day, from today
  expectedByNow: number;        // target * elapsed share of the month
  postedToday: number;
  verdict: 'set-target' | 'post-first' | 'on-pace' | 'post-again' | 'too-late';
  secondPostAdd: number;
  bestSlot: number;
  postByLocal?: string;
  suggestion: number;
  scenario?: { slotLocal: string; tomorrowLocal: string; addToday: number; lossToday: number; netToday: number; reach48Today: number; reach48Tomorrow: number; sacrifice: number; second: boolean };
}

export interface DayForecastView {
  utcDate: string;
  u: number;
  dailyNow: number;
  dailyNowSource: 'analytics' | 'derived' | 'partial' | 'none';
  early: boolean;              // before the first S_DAY key: no usable EOD forecast yet
  point: number;
  low: number;
  high: number;
  pace: number;
  fromTodayPosts: number;
  fromTails: number;
  regime: Regime;
  postByLocal?: string;
  rangePct: number;             // half-width of the 80% range as a share of the point, at this hour
  rangeByHour: { localHour: number; pct: number }[];
  rangeSource: 'measured' | 'prior';
  rangeDays: number;            // closed days behind the measured range
  method: 'posts' | 'curve';    // posts: today's count plus each live post's remaining gain; curve: day share
}
