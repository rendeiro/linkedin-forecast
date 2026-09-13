import { SEL } from '../selectors';
import { send, health, cardOf, readImpressionsFromCard, detectPostType, readAgeHint, textPreview, readTotal7 } from './common';
import { urnFromHref } from '../../model/urn';
import type { PageType } from '../../shared/types';
import { mountPostOverlay } from '../overlay';

const seenMinute = new Map<string, string>();

export function scanOwnPosts(doc: Document, page: PageType): number {
  const links = Array.from(doc.querySelectorAll(SEL.ownPostAnalyticsLink));
  let n = 0;
  const handled = new Set<Element>();
  for (const link of links) {
    const urn = urnFromHref(link.getAttribute('href'));
    if (!urn) continue;
    const card = cardOf(link);
    if (handled.has(card)) continue;
    handled.add(card);
    const impressions = readImpressionsFromCard(card, link);
    const minuteKey = new Date().toISOString().slice(0, 16);
    if (impressions === null) continue;
    if (seenMinute.get(urn) !== minuteKey) {
      seenMinute.set(urn, minuteKey);
      void send({
        type: 'snapshot',
        payload: {
          urn, observedAt: new Date().toISOString(), impressions,
          source: page === 'post_page' ? 'post_page' : 'feed',
          post: { urn, type: detectPostType(card), textPreview: textPreview(card), ageHintHours: readAgeHint(card) ?? undefined },
        },
      });
      n++;
    }
    mountPostOverlay(card, urn);
  }
  return n;
}

export async function readFeed(doc: Document, page: PageType): Promise<boolean> {
  const total7 = readTotal7(doc);
  if (total7 !== null) void send({ type: 'total7', payload: { value: total7, observedAt: new Date().toISOString() } });
  let n = scanOwnPosts(doc, page);
  const root = doc.querySelector(SEL.mainFeed) ?? doc.body;
  const stop = Date.now() + 30_000;
  let pending = false;
  const obs = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      n += scanOwnPosts(doc, page);
      if (Date.now() > stop) obs.disconnect();
    }, 500);
  });
  obs.observe(root, { childList: true, subtree: true });
  // Also keep scanning on scroll while the page lives (the feed inserts cards lazily).
  let scrollTimer: number | undefined;
  doc.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => scanOwnPosts(doc, page), 600) as unknown as number;
  }, { passive: true });
  setTimeout(() => {
    const ok = n > 0 || total7 !== null;
    void health(page, ok, ok ? undefined : 'no own posts or 7-day total seen');
  }, 3000);
  return true;
}
