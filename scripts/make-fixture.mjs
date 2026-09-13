// Synthetic fixture (SPEC §9): fictional account, deterministic.
import { writeFileSync } from 'node:fs';

let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const noise = (pct) => 1 + (rnd() * 2 - 1) * pct;

const S_DAY = { 6: 0.05, 8: 0.12, 10: 0.30, 11: 0.40, 12: 0.50, 13: 0.58, 14: 0.66, 15: 0.73, 16: 0.79, 17: 0.85, 18: 0.90, 19: 0.94, 20: 0.96, 21: 0.98, 22: 0.99, 24: 1.00 };
const S_POST = { 0.5: 0.10, 1: 0.18, 2: 0.30, 3: 0.40, 4: 0.48, 5: 0.56, 6: 0.63, 8: 0.74, 10: 0.82, 12: 0.87, 15: 0.92, 18: 0.95, 21: 0.98, 24: 1.00 };
function interp(t, x) {
  const ks = Object.keys(t).map(Number).sort((a, b) => a - b);
  if (x <= ks[0]) return t[ks[0]] * Math.max(x / ks[0], 0.02);
  if (x >= ks[ks.length - 1]) return t[ks[ks.length - 1]];
  for (let i = 1; i < ks.length; i++) if (x <= ks[i]) { const a = ks[i - 1], b = ks[i]; return t[a] + (t[b] - t[a]) * (x - a) / (b - a); }
}

const end = new Date('2026-09-12T00:00:00Z');
const days = [];
for (let i = 27; i >= 0; i--) {
  const d = new Date(end.getTime() - i * 86400000);
  const wd = (d.getUTCDay() + 6) % 7;
  const base = wd >= 5 ? 2300 : 3200;
  days.push({ utcDate: d.toISOString().slice(0, 10), impressions: Math.round(base * noise(0.12)) });
}

const posts = [];
const types = ['text', 'text', 'image', 'text', 'document', 'text', 'image', 'text'];
let pi = 0;
for (let i = 0; i < 28 && posts.length < 20; i++) {
  const day = days[i];
  const wd = (new Date(day.utcDate + 'T00:00:00Z').getUTCDay() + 6) % 7;
  if (wd >= 5 && rnd() < 0.6) continue;
  const nPosts = (i === 9 || i === 16) ? 2 : 1; // two days with two posts
  for (let k = 0; k < nPosts; k++) {
    const hour = k === 0 ? 7 + Math.floor(rnd() * 2) : 14 + Math.floor(rnd() * 3);
    const publishedAt = `${day.utcDate}T${String(hour).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00.000Z`;
    const type = types[pi++ % types.length];
    const actual24h = Math.round(1400 + rnd() * 3400);
    posts.push({ urn: String((BigInt(new Date(publishedAt).getTime()) << 22n)), publishedAt, type, actual24h });
    if (posts.length >= 20) break;
  }
}
posts[5] = { ...posts[5], type: 'video', actual24h: 4800 };

// Intraday replay for the last 5 days: daily readings at UTC hours and post snapshots.
const replay = [];
for (let i = 23; i < 28; i++) {
  const day = days[i];
  const readings = [8, 10, 12, 14, 16, 18, 20, 22].map(u => ({
    observedAt: `${day.utcDate}T${String(u).padStart(2, '0')}:00:00.000Z`,
    value: Math.round(day.impressions * interp(S_DAY, u) * noise(0.07)),
  }));
  replay.push({ utcDate: day.utcDate, actual: day.impressions, readings });
}
const snapshots = [];
for (const p of posts.slice(-6)) {
  for (const h of [0.5, 1, 2, 3, 6, 12, 24]) {
    snapshots.push({ urn: p.urn, observedAt: new Date(new Date(p.publishedAt).getTime() + h * 3600000).toISOString(), impressions: Math.round(p.actual24h * interp(S_POST, h) * noise(0.08)), source: 'post_summary' });
  }
}

writeFileSync('fixtures/account-a.json', JSON.stringify({ account: 'fictional-a', timezone: 'Europe/Lisbon', days, posts, replay, snapshots }, null, 2));
console.log(`fixture: ${days.length} days, ${posts.length} posts, ${replay.length} replay days, ${snapshots.length} snapshots`);
