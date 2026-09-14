/** §4.2 rehydration payload parsing. Works on a Document (content script or jsdom tests). */

export interface DailyPoint { utcDate: string; impressions: number; }

export function readRehydrationText(doc: Document): string | null {
  const el = doc.querySelector('script#rehydrate-data');
  const raw = el?.textContent ?? '';
  if (!raw) return null;
  const eq = raw.indexOf('=');
  if (eq < 0) return null;
  const json = raw.slice(eq + 1).trim().replace(/;$/, '');
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) return arr.map(x => (typeof x === 'string' ? x : '')).join('');
    if (typeof arr === 'string') return arr;
    return JSON.stringify(arr);
  } catch {
    return null;
  }
}

/** Legacy pages: code[id^="bpr-guid-"] JSON envelopes concatenated. */
export function readLegacyText(doc: Document): string | null {
  const els = Array.from(doc.querySelectorAll('code[id^="bpr-guid-"]'));
  if (!els.length) return null;
  return els.map(e => e.textContent ?? '').join('\n');
}

/** The React Flight chunks are string-escaped JSON; unescape common forms for regexing. */
export function normalise(text: string): string {
  return text.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

export interface SeriesOptions { cumulative?: boolean }

/**
 * Daily series from the Highcharts config. Prefers a "data" array that follows an "Impressions"
 * series name; otherwise the longest day-spaced x/y array in the payload. With `cumulative`,
 * consecutive values are differenced (the chart's Cumulative mode).
 */
export function extractDailySeries(text: string, opts: SeriesOptions = {}): DailyPoint[] {
  const t = normalise(text);
  const candidates: { points: DailyPoint[]; named: boolean }[] = [];
  const re = /"data"\s*:\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const start = m.index + m[0].length - 1;
    const arrText = sliceBalanced(t, start);
    if (!arrText) continue;
    const pts = parsePoints(arrText);
    if (pts.length < 2) continue;
    const before = t.slice(Math.max(0, m.index - 300), m.index);
    const named = /"name"\s*:\s*"impressions"/i.test(before) || /impression/i.test(before);
    candidates.push({ points: pts, named });
    re.lastIndex = start + arrText.length;
  }
  if (!candidates.length) return [];
  candidates.sort((a, b) => Number(b.named) - Number(a.named) || b.points.length - a.points.length);
  let pts = candidates[0].points;
  const nonDecreasing = pts.every((p, i) => i === 0 || p.impressions >= pts[i - 1].impressions);
  if (opts.cumulative && nonDecreasing && pts.length >= 2) {
    pts = pts.map((p, i) => ({ utcDate: p.utcDate, impressions: i === 0 ? p.impressions : p.impressions - pts[i - 1].impressions }));
  }
  return pts;
}

function parsePoints(arrText: string): DailyPoint[] {
  const out: DailyPoint[] = [];
  const re = /\{[^{}]*?"y"\s*:\s*(-?[\d.]+)[^{}]*?"x"\s*:\s*(\d{10,13})[^{}]*?\}|\{[^{}]*?"x"\s*:\s*(\d{10,13})[^{}]*?"y"\s*:\s*(-?[\d.]+)[^{}]*?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arrText))) {
    const y = Number(m[1] ?? m[4]);
    const x = Number(m[2] ?? m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const ms = x < 1e11 ? x * 1000 : x;
    out.push({ utcDate: new Date(ms).toISOString().slice(0, 10), impressions: Math.round(y) });
  }
  const byDate = new Map<string, number>();
  for (const p of out) byDate.set(p.utcDate, p.impressions);
  const pts = Array.from(byDate, ([utcDate, impressions]) => ({ utcDate, impressions })).sort((a, b) => (a.utcDate < b.utcDate ? -1 : 1));
  // Day-spaced check: at least half the gaps are exactly one day.
  let dayGaps = 0;
  for (let i = 1; i < pts.length; i++) if (new Date(pts[i].utcDate).getTime() - new Date(pts[i - 1].utcDate).getTime() === 86400000) dayGaps++;
  return pts.length >= 2 && dayGaps >= (pts.length - 1) / 2 ? pts : [];
}

function sliceBalanced(s: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

export function extractTimezone(text: string): string | null {
  const m = normalise(text).match(/"timezone"\s*:\s*"([A-Za-z_]+\/[A-Za-z_+\-0-9]+(?:\/[A-Za-z_]+)?)"/);
  return m ? m[1] : null;
}

export function extractProfileId(text: string): string | null {
  const m = normalise(text).match(/"currentUserNonIterableProfileId"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

export function extractActivityIds(text: string): string[] {
  const t = normalise(text);
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  const re = /"activityId"\s*:\s*"?(\d{15,20})"?/g;
  while ((m = re.exec(t))) ids.add(m[1]);
  const re2 = /urn:li:activity:(\d{15,20})/g;
  while ((m = re2.exec(t))) ids.add(m[1]);
  return Array.from(ids);
}

/** Post-summary payload: impressions and companions when present. */
export interface PostSummaryStats {
  impressions?: number; membersReached?: number; inNetworkShare?: number;
  reactions?: number; comments?: number; reposts?: number;
}

export function extractPostSummaryStats(text: string): PostSummaryStats {
  const t = normalise(text);
  const out: PostSummaryStats = {};
  const num = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]) : undefined; };
  out.impressions = num(/"(?:impressions|impressionCount|numImpressions)"\s*:\s*(\d+)/i);
  out.membersReached = num(/"(?:membersReached|uniqueImpressionsCount|numUniqueImpressions)"\s*:\s*(\d+)/i);
  out.reactions = num(/"(?:numLikes|reactionCount|reactions|totalReactions)"\s*:\s*(\d+)/i);
  out.comments = num(/"(?:numComments|commentCount|comments)"\s*:\s*(\d+)/i);
  out.reposts = num(/"(?:numShares|repostCount|reposts|shares)"\s*:\s*(\d+)/i);
  const inNet = t.match(/"(?:inNetwork|in_network)[A-Za-z]*(?:Percentage|Percent|Share|Pct)?"\s*:\s*([\d.]+)/i);
  if (inNet) {
    const v = Number(inNet[1]);
    out.inNetworkShare = v > 1 ? v / 100 : v;
  }
  for (const k of Object.keys(out) as (keyof PostSummaryStats)[]) if (out[k] === undefined || !Number.isFinite(out[k]!)) delete out[k];
  return out;
}
