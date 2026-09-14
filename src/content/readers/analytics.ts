import { readRehydrationText, readLegacyText, extractDailySeries, extractTimezone, extractProfileId, extractActivityIds, type DailyPoint } from '../payload';
import { SEL, RE } from '../selectors';
import { send, health, waitFor } from './common';
import { parseCount } from '../../shared/numbers';
import { urnFromHref } from '../../model/urn';

export async function readAnalytics(doc: Document): Promise<boolean> {
  const observedAt = new Date().toISOString();
  let text = readRehydrationText(doc);
  let path = 'rehydrate';
  if (!text) { text = readLegacyText(doc); path = 'legacy'; }
  if (!text) {
    // Payload may be injected late; wait a little.
    text = await waitFor(() => readRehydrationText(doc), 8000);
    path = 'rehydrate-late';
  }
  let ok = false;
  let diag = 'no payload';
  const cumulative = isCumulativeSelected(doc);
  let points: DailyPoint[] = [];
  if (text) {
    points = extractDailySeries(text, { cumulative });
    diag = `payload ${Math.round(text.length / 1000)}k chars, ${points.length} points`;
  }
  if (!points.length) {
    // Current LinkedIn build: no payload script; Highcharts exposes each point as an aria-label.
    const aria = await waitFor(() => { const p = readChartAria(doc, cumulative); return p.length >= 2 ? p : null; }, 12000, 500);
    if (aria) { points = aria; path = 'aria'; }
    else diag += `; chart aria points: ${readChartAria(doc, cumulative).length}`;
  }
  if (points.length) {
    const timezone = (text && extractTimezone(text)) || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const profileId = (text && extractProfileId(text)) || undefined;
    await send({ type: 'daily', payload: { points, observedAt: new Date().toISOString(), timezone, profileId } });
    ok = true;
  }
  void observedAt;
  // Top posts hydrate lazily: observe the section for links to post-summary pages.
  const top = await waitFor(() => {
    const links = Array.from(doc.querySelectorAll(SEL.ownPostAnalyticsLink));
    return links.length ? links : null;
  }, 10000, 500);
  if (top) {
    const seen = new Map<string, number>();
    for (const a of top) {
      const urn = urnFromHref(a.getAttribute('href'));
      if (!urn) continue;
      const row = a.closest('li, tr, article, div') ?? a;
      const m = (row.textContent ?? '').match(RE.impressionsAnywhere);
      const v = m ? parseCount(m[1]) : null;
      if (!seen.has(urn)) seen.set(urn, v ?? -1);
    }
    const posts = Array.from(seen.keys()).map(urn => ({ urn }));
    const topPosts = Array.from(seen).filter(([, v]) => v > 0).map(([urn, impressions]) => ({ urn, impressions }));
    if (posts.length) await send({ type: 'posts', payload: { posts, topPosts } });
    ok = ok || posts.length > 0;
  } else if (text) {
    const ids = extractActivityIds(text);
    if (ids.length) await send({ type: 'posts', payload: { posts: ids.map(urn => ({ urn })) } });
  }
  await health('analytics', ok, ok ? undefined : `no daily series: ${diag}`, path);
  return ok;
}

/** The chart's mode dropdown shows "Cumulative" when selected. */
function isCumulativeSelected(doc: Document): boolean {
  const els = Array.from(doc.querySelectorAll('button, [role="button"], [role="combobox"], select, [aria-haspopup]'));
  return els.some(e => /^\s*cumulative\s*$/i.test((e.textContent || (e as HTMLSelectElement).value || '').trim()));
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Parse "Sunday, Sep 13, 2026, 31,347. Impressions." labels into daily points; difference when cumulative. */
export function readChartAria(doc: Document, cumulative: boolean): DailyPoint[] {
  const els = Array.from(doc.querySelectorAll('[aria-label$="Impressions."], [aria-label*=". Impressions"]'));
  const byDate = new Map<string, number>();
  for (const e of els) {
    const a = e.getAttribute('aria-label') || '';
    const m = a.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s+(\d{4}),\s+([\d.,]+)\.?\s+Impressions/i);
    if (!m) continue;
    const mo = MONTHS[m[1].toLowerCase()];
    if (!mo) continue;
    const v = parseCount(m[4]);
    if (v === null) continue;
    byDate.set(`${m[3]}-${String(mo).padStart(2, '0')}-${m[2].padStart(2, '0')}`, v);
  }
  let pts = Array.from(byDate, ([utcDate, impressions]) => ({ utcDate, impressions })).sort((a, b) => (a.utcDate < b.utcDate ? -1 : 1));
  const nonDecreasing = pts.every((p, i) => i === 0 || p.impressions >= pts[i - 1].impressions);
  if (cumulative && nonDecreasing && pts.length >= 2) {
    pts = pts.map((p, i) => ({ utcDate: p.utcDate, impressions: i === 0 ? p.impressions : p.impressions - pts[i - 1].impressions }));
  }
  return pts;
}
