import type { ContentMessage, PageType, PostType } from '../../shared/types';
import { SEL, RE } from '../selectors';
import { parseCount } from '../../shared/numbers';
import { ageLabelToHours } from '../../model/urn';

export function send(msg: ContentMessage): Promise<unknown> {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, resp => { void chrome.runtime.lastError; resolve(resp); });
    } catch { resolve(undefined); }
  });
}

export function health(page: PageType, ok: boolean, error?: string, path?: string) {
  return send({ type: 'health', payload: { page, ok, error, path } });
}

export function waitFor<T>(fn: () => T | null | undefined, timeoutMs: number, intervalMs = 400): Promise<T | null> {
  return new Promise(resolve => {
    const start = Date.now();
    const tick = () => {
      let v: T | null | undefined = null;
      try { v = fn(); } catch { /* ignore */ }
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Find the card element enclosing an own-post analytics link. */
export function cardOf(link: Element): Element {
  let el: Element | null = link;
  for (let i = 0; i < 12 && el; i++) {
    if (el.matches('[data-urn], [data-id], article, [role="article"], li, [componentkey], [data-testid*="feed"], [data-testid*="post"]')) return el;
    el = el.parentElement;
  }
  return link.closest('div') ?? link;
}

export function readImpressionsFromCard(card: Element, link: Element): number | null {
  const candidates: (string | null)[] = [];
  card.querySelectorAll(SEL.contentAnalytics + ' p, ' + SEL.contentAnalytics).forEach(e => candidates.push(e.textContent));
  candidates.push(link.textContent);
  candidates.push(link.getAttribute('aria-label'));
  card.querySelectorAll('span, p, a').forEach(e => { if (RE.impressionsAnywhere.test(e.textContent ?? '')) candidates.push(e.textContent); });
  for (const c of candidates) {
    if (!c) continue;
    const m = c.match(RE.impressions) ?? c.match(RE.impressionsAnywhere);
    if (m) {
      const v = parseCount(m[1]);
      if (v !== null) return v;
    }
  }
  return null;
}

export function detectPostType(card: Element): PostType {
  if (card.querySelector(SEL.videoPlayer)) return 'video';
  if (card.querySelector(SEL.imageShare)) return 'image';
  const btns = Array.from(card.querySelectorAll('button')).map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
  if (btns.some(t => /download/i.test(t)) || card.querySelector('iframe[src*="document"], [data-testid*="document"]')) return 'document';
  if (card.querySelector(SEL.expandableText)) return 'text';
  return 'unknown';
}

export function readAgeHint(card: Element): number | null {
  const els = Array.from(card.querySelectorAll(SEL.timeLabel));
  for (const e of els) {
    const t = (e.getAttribute('aria-label') || e.textContent || '').trim();
    const m = t.match(RE.ageLabel);
    if (m) {
      const h = ageLabelToHours(m[1] + m[2]);
      if (h !== null) return h;
    }
  }
  return null;
}

export function textPreview(card: Element): string | undefined {
  const box = card.querySelector(SEL.expandableText) ?? card.querySelector('[dir="ltr"]');
  const t = box?.textContent?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 80) : undefined;
}

export function readTotal7(doc: Document): number | null {
  const links = Array.from(doc.querySelectorAll(SEL.total7Link));
  for (const link of links) {
    const label = link.querySelector(SEL.total7Label) ?? (link.matches(SEL.total7Label) ? link : null);
    const texts = [label?.getAttribute('aria-label'), label?.textContent, link.getAttribute('aria-label'), link.textContent];
    for (const t of texts) {
      if (!t) continue;
      const m = t.match(RE.impressionsAnywhere) ?? t.match(/([\d][\d.,]*[kKmM]?)/);
      if (m) {
        const v = parseCount(m[1]);
        if (v !== null && v > 0) return v;
      }
    }
  }
  return null;
}
