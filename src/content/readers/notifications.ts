import { RE } from '../selectors';
import { send, health } from './common';
import { parseCount } from '../../shared/numbers';
import { urnFromHref } from '../../model/urn';

export async function readNotifications(doc: Document): Promise<boolean> {
  let n = 0;
  const seen = new Set<string>();
  const scan = () => {
    const cards = Array.from(doc.querySelectorAll('article, li, [role="listitem"], a[href*="urn:li:activity:"]'));
    for (const c of cards) {
      const t = c.textContent ?? '';
      const m = t.match(RE.notificationCount);
      if (!m) continue;
      const link = c.matches('a') ? c : c.querySelector('a[href*="urn:li:activity:"]');
      const urn = urnFromHref(link?.getAttribute('href'));
      const v = parseCount(m[1]);
      if (!urn || v === null || seen.has(urn)) continue;
      seen.add(urn);
      n++;
      void send({ type: 'snapshot', payload: { urn, observedAt: new Date().toISOString(), impressions: v, source: 'notification', post: { urn } } });
    }
  };
  scan();
  const obs = new MutationObserver(scan);
  obs.observe(doc.body, { childList: true, subtree: true });
  setTimeout(() => { obs.disconnect(); void health('notifications', true, n ? undefined : 'no impression cards'); }, 30_000);
  return true;
}
