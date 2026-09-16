import { SEL } from '../selectors';
import { send, health, cardOf, readImpressionsFromCard, detectPostType, readAgeHint, textPreview, readTotal7, placementFor, urnCardsWithoutAnalytics } from './common';
import { urnFromHref } from '../../model/urn';
import type { PageType, PostForecastView } from '../../shared/types';
import { mountPostOverlay } from '../overlay';

const seenMinute = new Map<string, string>();
const mounted = new Map<string, { card: Element; link: Element }>();
let refreshTimer: number | undefined;

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
    const place = placementFor(link);
    if (!place) continue; // reaction bar not hydrated yet; next scan retries
    mounted.set(urn, { card, link });
    if (seenMinute.get(urn) !== minuteKey) {
      seenMinute.set(urn, minuteKey);
      n++;
      // Render from the reply so the line never races the ingest.
      void send({
        type: 'snapshot',
        payload: {
          urn, observedAt: new Date().toISOString(), impressions,
          source: page === 'post_page' ? 'post_page' : 'feed',
          post: { urn, type: detectPostType(card), textPreview: textPreview(card), ageHintHours: readAgeHint(card) ?? undefined },
        },
      }).then(resp => {
        const r = resp as { view?: PostForecastView | null } | undefined;
        void mountPostOverlay(card, urn, r?.view ?? undefined, place);
      });
    } else {
      void mountPostOverlay(card, urn, undefined, place);
    }
  }
  // Profile "Featured" and similar cards: known posts without an analytics row.
  for (const { urn, card } of urnCardsWithoutAnalytics(doc)) {
    void mountPostOverlay(card, urn, undefined, { parent: card, before: null }, true);
  }
  if (refreshTimer === undefined) {
    refreshTimer = setInterval(() => {
      for (const [u, m] of mounted) { const pl = m.card.isConnected ? placementFor(m.link) : null; if (pl) void mountPostOverlay(m.card, u, undefined, pl); else mounted.delete(u); }
    }, 60_000) as unknown as number;
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
  // Hydration and SPA navigation land late: rescan every 5 s for two minutes.
  let ticks = 0;
  const t = setInterval(() => { n += scanOwnPosts(doc, page); if (++ticks >= 24) clearInterval(t); }, 5000);
  setTimeout(() => {
    const ok = n > 0 || total7 !== null;
    void health(page, ok, ok ? undefined : 'no own posts or 7-day total seen');
  }, 3000);
  return true;
}
