/** §4.3: every selector and regex in one place. Stable attributes only, never class names. */
export const SEL = {
  rehydrate: 'script#rehydrate-data',
  legacyCode: 'code[id^="bpr-guid-"]',
  ownPostAnalyticsLink: 'a[href*="/analytics/post-summary/urn:li:activity:"]',
  contentAnalytics: '[aria-label="Content analytics"]',
  actorYou: 'a[aria-label$=" You"], a[aria-label$="You"]',
  total7Link: 'a[href$="/analytics/creator/content/"], a[href*="/analytics/creator/content"]',
  total7Label: '[aria-label^="Post impressions"]',
  mainFeed: '[data-testid="mainFeed"], main',
  chartLoader: '[data-testid="chart-loader"]',
  expandableText: '[data-testid="expandable-text-box"]',
  videoPlayer: '[data-vjs-player], button[aria-label="Play video"], video',
  imageShare: 'img[src*="feedshare-shrink"]',
  lazySections: ['#impressionsBreakdownCA', '#membersReachedFeatureCA', '#topPostFeature', '#demographicsFeatureCA'],
  timeLabel: 'time, [aria-label*=" ago"], span[aria-hidden="true"]',
};

export const RE = {
  impressions: /^\s*([\d.,\s]+(?:[kKmM]|mil)?)\s+impressions?\s*$/i,
  impressionsAnywhere: /([\d][\d.,\s]*(?:[kKmM]|mil)?)\s+impressions?/i,
  urn: /urn:li:activity:(\d+)/,
  notificationCount: /your post (?:has|got|reached)\s+([\d.,]+[kKmM]?)\s+impressions/i,
  inNetworkPct: /(\d{1,3})%\s*(?:in[-\s]?network|from your network)/i,
  membersReached: /([\d.,]+[kKmM]?)\s+members? reached/i,
  ageLabel: /^\s*(\d+)\s*(m|h|d|w|mo)\s*(?:•|·)?/i,
};

export const URL_PATTERNS = {
  analytics: /linkedin\.com\/analytics\/creator\/content\/?/,
  postSummary: /linkedin\.com\/analytics\/post-summary\/urn:li:activity:(\d+)/,
  feed: /linkedin\.com\/feed\/?(\?|$)/,
  postPage: /linkedin\.com\/feed\/update\/urn:li:activity:(\d+)/,
  notifications: /linkedin\.com\/notifications/,
};
