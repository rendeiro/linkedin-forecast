import { readRehydrationText, extractPostSummaryStats } from '../payload';
import { SEL, RE, URL_PATTERNS } from '../selectors';
import { send, health, waitFor } from './common';
import { parseCount } from '../../shared/numbers';

export async function readPostSummary(doc: Document, url: string): Promise<boolean> {
  const m = url.match(URL_PATTERNS.postSummary);
  if (!m) return false;
  const urn = m[1];
  const observedAt = new Date().toISOString();
  let path = 'dom';
  const stats: Record<string, number | undefined> = {};

  const text = readRehydrationText(doc);
  if (text) {
    Object.assign(stats, extractPostSummaryStats(text));
    if (stats.impressions) path = 'rehydrate';
  }

  // DOM/text fallback and lazy sections (up to 10 s).
  const domImpr = await waitFor(() => {
    const body = doc.body?.innerText ?? '';
    const mm = body.match(RE.impressionsAnywhere);
    return mm ? parseCount(mm[1]) : null;
  }, 10000, 500);
  if (domImpr !== null && (!stats.impressions || Math.abs(domImpr - stats.impressions) / Math.max(stats.impressions, 1) > 0.5)) {
    // DOM wins when the payload number is missing or clearly a different field.
    stats.impressions = domImpr;
  }
  const lazy = await waitFor(() => {
    for (const id of SEL.lazySections) {
      const el = doc.querySelector(id);
      if (el && /\d/.test(el.textContent ?? '')) return el;
    }
    return null;
  }, 10000, 500);
  if (lazy) {
    const body = doc.body?.innerText ?? '';
    const inNet = body.match(RE.inNetworkPct);
    if (inNet) stats.inNetworkShare = Number(inNet[1]) / 100;
    const mr = body.match(RE.membersReached);
    if (mr) stats.membersReached = parseCount(mr[1]) ?? undefined;
  }

  if (!stats.impressions) {
    await health('post_summary', false, 'no impressions found', path);
    return false;
  }
  await send({
    type: 'snapshot',
    payload: {
      urn, observedAt, impressions: stats.impressions, source: 'post_summary',
      inNetworkShare: stats.inNetworkShare, membersReached: stats.membersReached,
      reactions: stats.reactions, comments: stats.comments, reposts: stats.reposts,
      post: { urn },
    },
  });
  await health('post_summary', true, undefined, path);
  return true;
}
