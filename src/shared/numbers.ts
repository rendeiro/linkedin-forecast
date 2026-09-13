/** Parse "1,530", "1.2K", "3,4 mil", "12K", "1.5M". Returns null if not finite. */
export function parseCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, ' ').trim();
  const m = s.match(/([\d][\d.,\s]*)\s*(k|m|mil|mi|tsd|mio)?\b/i);
  if (!m) return null;
  let num = m[1].replace(/\s/g, '');
  const suffix = (m[2] || '').toLowerCase();
  let mult = 1;
  if (suffix === 'k' || suffix === 'mil' || suffix === 'tsd') mult = 1000;
  else if (suffix === 'm' || suffix === 'mi' || suffix === 'mio') mult = 1e6;

  if (mult === 1) {
    // Plain integer with thousands separators in either locale.
    num = num.replace(/[.,]/g, '');
  } else {
    // Decimal with either separator (1.2K, 3,4 mil).
    num = num.replace(',', '.');
    const parts = num.split('.');
    if (parts.length > 2) num = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
  }
  const v = Math.round(parseFloat(num) * mult);
  return Number.isFinite(v) ? v : null;
}

export function fmt(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '–';
  return Math.round(n).toLocaleString('en-US');
}

export function pct(n: number | undefined | null, digits = 0): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '–';
  return (n * 100).toFixed(digits) + '%';
}
