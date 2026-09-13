import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { initialModel, dailyEod, learnDay, learnPost, postForecast, mean, interp } from '../src/model/simple';
import { utcHourOf, hoursBetween } from '../src/shared/time';
import type { ModelState } from '../src/shared/types';

interface Fixture {
  days: { utcDate: string; impressions: number }[];
  posts: { urn: string; publishedAt: string; type: 'text' | 'image' | 'video' | 'document'; actual24h: number }[];
  replay: { utcDate: string; actual: number; readings: { observedAt: string; value: number }[] }[];
  snapshots: { urn: string; observedAt: string; impressions: number }[];
}

const fx: Fixture = JSON.parse(readFileSync(new URL('../fixtures/account-a.json', import.meta.url), 'utf8'));

describe('fixtures/account-a.json', () => {
  it('has the shape §9 asks for', () => {
    expect(fx.days.length).toBe(28);
    expect(Math.abs(mean(fx.days.map(d => d.impressions)) - 3200) / 3200).toBeLessThan(0.15);
    expect(fx.posts.length).toBe(20);
    expect(fx.posts.every(p => p.actual24h >= 1400 && p.actual24h <= 5000)).toBe(true);
    expect(fx.posts.filter(p => p.type === 'video').length).toBe(1);
    expect(fx.posts.find(p => p.type === 'video')!.actual24h).toBe(4800);
    const byDay = new Map<string, number>();
    for (const p of fx.posts) byDay.set(p.publishedAt.slice(0, 10), (byDay.get(p.publishedAt.slice(0, 10)) ?? 0) + 1);
    expect(Array.from(byDay.values()).filter(n => n === 2).length).toBe(2);
    expect(fx.replay.length).toBe(5);
  });
});

describe('end-to-end replay', () => {
  it('EOD at u=16 within 15% on at least 4 of 5 days, interval covers at least 3 of 5', () => {
    let model: ModelState = initialModel();
    model = { ...model, recentDaily: fx.days.slice(0, 23).map(d => d.impressions).slice(-14) };
    let within = 0, covered = 0;
    for (const day of fx.replay) {
      const r = day.readings.find(x => utcHourOf(x.observedAt) === 16)!;
      const f = dailyEod(16, r.value, { sDay: model.sDay, sdScale: model.sdScale.day });
      if (Math.abs(f.point - day.actual) / day.actual <= 0.15) within++;
      if (f.low <= day.actual && day.actual <= f.high) covered++;
      // The day closes: learn from all of its readings.
      model = learnDay(model, day.readings.map(x => [utcHourOf(x.observedAt), x.value] as [number, number]), day.actual);
    }
    expect(within).toBeGreaterThanOrEqual(4);
    expect(covered).toBeGreaterThanOrEqual(3);
    expect(model.recentDaily.length).toBe(14);
  });

  it('post learning moves the curve toward the observed shape and keeps it monotone', () => {
    let model: ModelState = initialModel();
    for (const p of fx.posts.slice(0, 14)) model = learnPost(model, [], p.actual24h, p.type);
    expect(model.nPostActuals).toBe(14);
    expect(model.recentTotals.length).toBe(10);
    const replayPosts = fx.posts.slice(-6);
    let errs: number[] = [];
    for (const p of replayPosts) {
      const snaps = fx.snapshots.filter(s => s.urn === p.urn).sort((a, b) => (a.observedAt < b.observedAt ? -1 : 1));
      const at3 = snaps.find(s => Math.abs(hoursBetween(p.publishedAt, s.observedAt) - 3) < 0.01)!;
      const f = postForecast(3, at3.impressions, model.recentTotals, { sPost: model.sPost });
      errs.push(Math.abs(f.point - p.actual24h) / p.actual24h);
      const readings = snaps.map(s => [hoursBetween(p.publishedAt, s.observedAt), s.impressions] as [number, number]).filter(([h]) => h < 24);
      model = learnPost(model, readings, p.actual24h, p.type);
    }
    expect(mean(errs)).toBeLessThan(0.35);
    const ks = Object.keys(model.sPost).map(Number).sort((a, b) => a - b);
    for (let i = 1; i < ks.length; i++) expect(model.sPost[String(ks[i])]).toBeGreaterThanOrEqual(model.sPost[String(ks[i - 1])]);
    expect(interp(model.sPost, 24)).toBe(1);
  });
});
