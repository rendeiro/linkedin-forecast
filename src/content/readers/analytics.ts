import { readRehydrationText, readLegacyText, extractDailySeries, extractTimezone, extractProfileId, extractActivityIds } from '../payload';
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
  if (text) {
    const points = extractDailySeries(text);
    const timezone = extractTimezone(text) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const profileId = extractProfileId(text) ?? undefined;
    if (points.length) {
      await send({ type: 'daily', payload: { points, observedAt, timezone, profileId } });
      ok = true;
    }
  }
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
  await health('analytics', ok, ok ? undefined : 'no daily series found', path);
  return ok;
}
