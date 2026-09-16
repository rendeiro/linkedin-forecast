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
  // Current build: every post is a [role="article"] with data-urn.
  const article = link.closest('[role="article"], article, [data-urn]');
  if (article && article.querySelectorAll(SEL.ownPostAnalyticsLink).length === 1) return article;
  // Fallback: climb to the ancestor that also holds the reaction bar (Like / Comment controls).
  let el: Element | null = link.parentElement;
  let fallback: Element | null = null;
  for (let i = 0; i < 20 && el && el !== document.body; i++) {
    if (!fallback && el.matches('[data-urn], [data-id], article, [role="article"], li, [componentkey]')) fallback = el;
    const hasBar = Array.from(el.querySelectorAll('button')).some(b => /^(like|react|comment)\b/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
    if (hasBar && el.querySelectorAll(SEL.ownPostAnalyticsLink).length === 1) return el;
    el = el.parentElement;
  }
  return fallback ?? link.closest('div') ?? link;
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

/**
 * Relative age from the header: "2h • Edited •", "5h •", "2d". The label is often a bare text
 * node inside a span with siblings, so scan short spans rather than leaves, header first.
 */
export function readAgeHint(card: Element): number | null {
  const link = card.querySelector(SEL.ownPostAnalyticsLink);
  const spans = Array.from(card.querySelectorAll('span, time, p'));
  for (const e of spans) {
    // Only elements before the analytics row (the post header), never comment timestamps.
    if (link && !(e.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const t = (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40) continue;
    const m = t.match(/(?:^|\s)(\d+)\s*(mo|m|h|d|w)\b/i);
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
