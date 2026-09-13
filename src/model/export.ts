/** §4.6 LinkedIn creator analytics .xlsx parser. Runs in the options page (SheetJS is heavy). */
import * as XLSX from 'xlsx';
import { decodeUrnTime } from './urn';

export interface ExportResult {
  daily: { utcDate: string; impressions: number; engagements?: number }[];
  posts: { urn: string; lifetime: number; publishedAt?: string; publishedApprox: boolean }[];
  followers: { utcDate: string; count: number }[];
  notes: string[];
}

type Row = unknown[];

function cellStr(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function toUtcDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = cellStr(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(cellStr(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) && cellStr(v) !== '' ? n : null;
}

/** Find the header row (within first 15 rows) containing all required substrings; returns row index and column map. */
function findHeader(rows: Row[], required: string[][]): { row: number; cols: number[] } | null {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const cells = (rows[r] ?? []).map(c => cellStr(c).toLowerCase());
    const cols = required.map(alts => cells.findIndex(c => alts.some(a => c.includes(a))));
    if (cols.every(c => c >= 0)) return { row: r, cols };
  }
  return null;
}

export function parseExport(data: ArrayBuffer | Uint8Array): ExportResult {
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  const out: ExportResult = { daily: [], posts: [], followers: [], notes: [] };
  for (const name of wb.SheetNames) {
    const upper = name.toUpperCase();
    const rows: Row[] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    if (upper.includes('DISCOVERY') || upper.includes('ENGAGEMENT')) {
      const h = findHeader(rows, [['date'], ['impression']]);
      if (!h) { out.notes.push(`${name}: header not found`); continue; }
      const eng = (rows[h.row] ?? []).findIndex(c => cellStr(c).toLowerCase().includes('engagement'));
      for (const row of rows.slice(h.row + 1)) {
        const d = toUtcDate(row[h.cols[0]]);
        const v = toNum(row[h.cols[1]]);
        if (!d || v === null) continue;
        const e = eng >= 0 ? toNum(row[eng]) : null;
        const existing = out.daily.find(x => x.utcDate === d);
        if (existing) { existing.impressions = v; if (e !== null) existing.engagements = e; }
        else out.daily.push({ utcDate: d, impressions: v, engagements: e ?? undefined });
      }
    } else if (upper.includes('TOP POSTS') || upper.includes('TOP_POSTS')) {
      // Two side-by-side tables; locate every "impression" header column and the nearest post/url column to its left.
      for (let r = 0; r < Math.min(rows.length, 15); r++) {
        const cells = (rows[r] ?? []).map(c => cellStr(c).toLowerCase());
        const imprCols = cells.map((c, i) => (c.includes('impression') ? i : -1)).filter(i => i >= 0);
        if (!imprCols.length) continue;
        for (const ic of imprCols) {
          let urlCol = -1, dateCol = -1;
          for (let i = ic - 1; i >= 0; i--) {
            if (urlCol < 0 && (cells[i].includes('url') || cells[i].includes('post') || cells[i].includes('link'))) urlCol = i;
            if (dateCol < 0 && cells[i].includes('date')) dateCol = i;
            if (urlCol >= 0 && (dateCol >= 0 || i === 0)) break;
          }
          if (urlCol < 0) continue;
          for (const row of rows.slice(r + 1)) {
            const url = cellStr(row[urlCol]);
            const m = url.match(/(\d{15,20})/);
            const v = toNum(row[ic]);
            if (!m || v === null) continue;
            const urn = m[1];
            const decoded = decodeUrnTime(urn);
            const dateOnly = dateCol >= 0 ? toUtcDate(row[dateCol]) : null;
            let publishedAt: string | undefined;
            let approx = true;
            if (decoded && (!dateOnly || decoded.toISOString().slice(0, 10) === dateOnly)) {
              const h = decoded.getUTCHours();
              if (h >= 4 && h <= 22) { publishedAt = decoded.toISOString(); approx = false; }
              else publishedAt = decoded.toISOString();
            } else if (dateOnly) {
              publishedAt = dateOnly + 'T08:00:00.000Z';
            }
            const existing = out.posts.find(p => p.urn === urn);
            if (existing) existing.lifetime = Math.max(existing.lifetime, v);
            else out.posts.push({ urn, lifetime: v, publishedAt, publishedApprox: approx });
          }
        }
        break;
      }
    } else if (upper.includes('FOLLOWERS')) {
      const h = findHeader(rows, [['date'], ['follower']]);
      if (!h) { out.notes.push(`${name}: header not found`); continue; }
      let running = 0;
      const isNew = cellStr((rows[h.row] ?? [])[h.cols[1]]).toLowerCase().includes('new');
      for (const row of rows.slice(h.row + 1)) {
        const d = toUtcDate(row[h.cols[0]]);
        const v = toNum(row[h.cols[1]]);
        if (!d || v === null) continue;
        running = isNew ? running + v : v;
        out.followers.push({ utcDate: d, count: running });
      }
      if (isNew) out.notes.push(`${name}: cumulative "new followers" series, counts are relative to the export start`);
    }
  }
  out.daily.sort((a, b) => (a.utcDate < b.utcDate ? -1 : 1));
  out.posts = out.posts.slice(0, 50);
  return out;
}
