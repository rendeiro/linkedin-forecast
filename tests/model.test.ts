import { describe, it, expect } from 'vitest';
import {
  postForecast, dailyEod, dayAhead, learnTable, S_POST_PRIOR, secondPostAdd, shiftSDay,
  postByHoursBeforeMidnight, interp, evalTail, pace, learnDow, DOW_PRIOR,
} from '../src/model/simple';
import { decodeUrnTime, resolvePublishedAt, ageLabelToHours } from '../src/model/urn';
import { parseCount } from '../src/shared/numbers';

const within = (got: number, want: number, tol = 0.005) =>
  expect(Math.abs(got - want) / want).toBeLessThanOrEqual(tol);

describe('§9 reference vectors', () => {
  it('A post_24h(h=6, 1300, [2000,2500,2200])', () => {
    const f = postForecast(6, 1300, [2000, 2500, 2200]);
    within(f.point, 2086); within(f.low, 1522); within(f.high, 2860);
  });
  it('B post_24h(h=1.5, 600, [])', () => {
    const f = postForecast(1.5, 600, []);
    within(f.point, 2500); within(f.low, 1457); within(f.high, 4291);
  });
  it('C post_24h(h=1.5, 600, five recents)', () => {
    const f = postForecast(1.5, 600, [1800, 2000, 2600, 2200, 2400]);
    within(f.point, 2338); within(f.low, 1362); within(f.high, 4012);
  });
  it('D daily_eod(u=16, 3148)', () => {
    const f = dailyEod(16, 3148);
    within(f.point, 3985); within(f.low, 3359); within(f.high, 4727);
  });
  it('E daily_eod(u=9.5, 900)', () => {
    const f = dailyEod(9.5, 900);
    within(f.point, 3529); within(f.low, 2341); within(f.high, 5321);
  });
  it('F day_ahead', () => {
    const rd = [3400, 2900, 4100, 3800, 2700, 2100, 2300];
    within(dayAhead(rd, 1), 3523);
    within(dayAhead(rd, 5), 2242);
  });
  it('G learn_post', () => {
    const t = learnTable(S_POST_PRIOR, [[3.0, 900], [6.0, 1500]], 2400);
    within(t['3'], 0.3925); within(t['6'], 0.6285);
  });
  it('H second post add', () => {
    within(secondPostAdd(2400, 7), 1151);
  });
  it('I URN decode', () => {
    expect(decodeUrnTime('7503731490816000000')!.toISOString()).toBe('2026-09-10T08:30:00.000Z');
  });
});

describe('model details', () => {
  it('interpolation boundaries', () => {
    expect(interp(S_POST_PRIOR, 0.25)).toBeCloseTo(0.05, 6);
    expect(interp(S_POST_PRIOR, 0)).toBeCloseTo(0.002, 6);
    expect(interp(S_POST_PRIOR, 30)).toBe(1);
  });
  it('post-by time is about 13.8h before UTC midnight', () => {
    within(postByHoursBeforeMidnight(), 13.8, 0.01);
  });
  it('shiftSDay moves keys and keeps 24 = 1', () => {
    const t = shiftSDay({ '6': 0.05, '8': 0.12, '24': 1 }, 9.5);
    expect(t['8']).toBe(0.05);
    expect(t['10']).toBe(0.12);
    expect(t['24']).toBe(1);
    expect(t['6']).toBeUndefined();
  });
  it('tail mode detection', () => {
    const pts: [number, number][] = [[0.5, 100], [1, 200], [2, 300], [3, 320], [4, 330]];
    expect(evalTail(pts, 4).tailMode).toBe(true);
    expect(evalTail(pts, 2).tailMode).toBe(false);
  });
  it('pace rules', () => {
    expect(pace({ kind: 'daily', value: 3000 }, 0, 10, [1, 2, 3], 0)).toBe(3000);
    within(pace({ kind: 'monthly', value: 90000 }, 30000, 20, [], 1), 3000 * 1.10 / 0.95);
    within(pace({ kind: null, value: 0 }, 0, 0, [3000, 3000, 3000], 5), 3000 * 0.70 / 0.95);
  });
  it('learnDow needs 28 days and renormalises', () => {
    const days = Array.from({ length: 28 }, (_, i) => ({ weekday: i % 7, value: i % 7 === 6 ? 1000 : 3000 }));
    const d = learnDow(DOW_PRIOR, days);
    expect(d.length).toBe(7);
    within(d.reduce((a, b) => a + b, 0) / 7, 1, 1e-9);
    expect(d[6]).toBeLessThan(DOW_PRIOR[6] / (DOW_PRIOR.reduce((a, b) => a + b) / 7) + 0.01);
  });
});

describe('urn sanity rule', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  it('accepts a daytime decode', () => {
    const r = resolvePublishedAt('7503731490816000000', now, { localHourOf: d => d.getUTCHours() + 2 });
    expect(r.approx).toBe(false);
  });
  it('flags odd hour and prefers the label', () => {
    const id = String((BigInt(new Date('2026-09-10T02:00:00Z').getTime()) << 22n));
    const r = resolvePublishedAt(id, now, { ageHintHours: 3, localHourOf: d => d.getUTCHours() });
    expect(r.approx).toBe(true);
    expect(r.publishedAt.toISOString()).toBe('2026-09-10T09:00:00.000Z');
  });
  it('age labels', () => {
    expect(ageLabelToHours('3h')).toBe(3);
    expect(ageLabelToHours('2d')).toBe(48);
    expect(ageLabelToHours('45m')).toBeCloseTo(0.75);
    expect(ageLabelToHours('1w')).toBe(168);
  });
});

describe('parseCount', () => {
  it('handles locales and suffixes', () => {
    expect(parseCount('1,530 impressions')).toBe(1530);
    expect(parseCount('1.530')).toBe(1530);
    expect(parseCount('1.2K')).toBe(1200);
    expect(parseCount('3,4 mil')).toBe(3400);
    expect(parseCount('12K')).toBe(12000);
    expect(parseCount('1.5M')).toBe(1500000);
    expect(parseCount('abc')).toBe(null);
  });
});

describe('post end-of-day forecast', () => {
  it('never goes below the current count, for any hour and any prior', async () => {
    const { postEod } = await import('../src/model/simple');
    for (const h of [0.2, 1, 2.7, 6, 13, 22.8, 24.9, 40, 90]) {
      for (const recent of [[], [50, 60, 70], [2000, 2500, 2200]]) {
        for (const hToMid of [0.5, 7, 21.3]) {
          const f = postEod(h, hToMid, 845, recent);
          expect(f.low).toBeGreaterThanOrEqual(845);
          expect(f.point).toBeGreaterThanOrEqual(f.low);
          expect(f.high).toBeGreaterThanOrEqual(f.point);
        }
      }
    }
  });
  it('gains more with more hours left before midnight', async () => {
    const { postEod } = await import('../src/model/simple');
    expect(postEod(2, 20, 845, [2000]).point).toBeGreaterThan(postEod(2, 5, 845, [2000]).point);
  });
});
