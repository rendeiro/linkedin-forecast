import { readRehydrationText, extractPostSummaryStats } from '../payload';
import { SEL, RE, URL_PATTERNS } from '../selectors';
import { send, health, waitFor } from './common';
import { parseCount } from '../../shared/numbers';
import { mountPostOverlay } from '../overlay';

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

  // DOM: the Discovery card renders "<p><span>311</span></p><p>Impressions</p>"; text fallback after.
  const domImpr = await waitFor(() => {
    const label = Array.from(doc.querySelectorAll('p, span, div')).find(e => e.children.length === 0 && /^impressions$/i.test((e.textContent || '').trim()));
    const block = label?.parentElement;
    if (block) {
      const m = (block.textContent || '').match(/([\d][\d.,]*[kKmM]?)/);
      const v = m ? parseCount(m[1]) : null;
      if (v !== null) return v;
    }
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
  // Post line under the Impressions figure, above the breakdown.
  const breakdown = doc.querySelector('#impressionsBreakdown, #impressionsBreakdownCA');
  if (breakdown?.parentElement) {
    const mount = () => mountPostOverlay(breakdown.parentElement!, urn, undefined, { parent: breakdown.parentElement!, before: breakdown });
    void mount();
    setInterval(mount, 60_000);
  }
  return true;
}
