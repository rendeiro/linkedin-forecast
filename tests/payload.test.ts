// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRehydrationText, extractDailySeries, extractTimezone, extractProfileId, extractActivityIds, extractPostSummaryStats } from '../src/content/payload';
import { cardOf, readImpressionsFromCard, detectPostType, readAgeHint, readTotal7, textPreview } from '../src/content/readers/common';
import { SEL } from '../src/content/selectors';
import { urnFromHref } from '../src/model/urn';

function load(name: string): Document {
  const html = readFileSync(resolve(process.cwd(), 'tests/fixtures', name), 'utf8');
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('rehydration payload', () => {
  const doc = load('analytics.html');
  const text = readRehydrationText(doc)!;
  it('joins chunks', () => { expect(text).toContain('Impressions'); });
  it('extracts the daily series with UTC dates and the partial last day', () => {
    const s = extractDailySeries(text);
    expect(s).toEqual([
      { utcDate: '2026-09-02', impressions: 3010 },
      { utcDate: '2026-09-03', impressions: 2870 },
      { utcDate: '2026-09-04', impressions: 3320 },
      { utcDate: '2026-09-05', impressions: 1512 },
    ]);
  });
  it('extracts timezone and profile id', () => {
    expect(extractTimezone(text)).toBe('Europe/Lisbon');
    expect(extractProfileId(text)).toBe('ACoAAB-redacted');
  });
  it('extracts activity ids', () => {
    expect(extractActivityIds(text)).toContain('7503731490816000000');
  });
  it('returns nothing when the script tag is absent', () => {
    const d = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(readRehydrationText(d)).toBeNull();
  });
  it('post summary stats', () => {
    const st = extractPostSummaryStats('{"impressions":1530,"membersReached":1200,"inNetworkPercentage":42.5,"numLikes":12}');
    expect(st.impressions).toBe(1530);
    expect(st.membersReached).toBe(1200);
    expect(st.inNetworkShare).toBeCloseTo(0.425);
    expect(st.reactions).toBe(12);
  });
});

describe('feed DOM hooks', () => {
  const doc = load('feed.html');
  it('finds only the own post via the analytics link', () => {
    const links = Array.from(doc.querySelectorAll(SEL.ownPostAnalyticsLink));
    expect(links.length).toBe(1);
    const link = links[0];
    expect(urnFromHref(link.getAttribute('href'))).toBe('7503731490816000000');
    const card = cardOf(link);
    expect(card.tagName).toBe('ARTICLE');
    expect(readImpressionsFromCard(card, link)).toBe(1530);
    expect(detectPostType(card)).toBe('image');
    expect(readAgeHint(card)).toBe(3);
    expect(textPreview(card)!.length).toBeLessThanOrEqual(80);
    expect(card.querySelector(SEL.actorYou)).not.toBeNull();
  });
  it('reads the left-rail 7-day total', () => {
    expect(readTotal7(doc)).toBe(21483);
  });
});

describe('daily series robustness', () => {
  it('differences a cumulative series', () => {
    const t = '{"name":"Impressions","data":[{"y":100,"x":1788307200000},{"y":250,"x":1788393600000},{"y":300,"x":1788480000000}]}';
    expect(extractDailySeries(t, { cumulative: true }).map(p => p.impressions)).toEqual([100, 150, 50]);
    expect(extractDailySeries(t).map(p => p.impressions)).toEqual([100, 250, 300]);
  });
  it('falls back to the longest day-spaced array when the name is missing', () => {
    const t = '{"series":[{"data":[{"x":1788307200000,"y":5}]},{"data":[{"x":1788307200000,"y":1},{"x":1788393600000,"y":2},{"x":1788480000000,"y":3}]}]}';
    expect(extractDailySeries(t).length).toBe(3);
  });
});
