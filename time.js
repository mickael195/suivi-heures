// Outils de calcul des durées (tout est stocké en minutes entières)

// "7.53" (centièmes) | "7,53" | "7h32" | "7:32" | "7h" | "-4h00" | "-4" -> minutes (ou null si invalide)
export function parseDuree(input, { allowNegative = false } = {}) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase().replace(/\s+/g, '').replace(',', '.').replace('−', '-');
  if (!s) return null;
  let sign = 1;
  if (s[0] === '-' || s[0] === '+') {
    if (s[0] === '-') {
      if (!allowNegative) return null;
      sign = -1;
    }
    s = s.slice(1);
  }
  let m = s.match(/^(\d{1,4})[h:](\d{0,2})(min|m)?$/);
  if (m) {
    const h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    if (min >= 60) return null;
    return sign * (h * 60 + min);
  }
  m = s.match(/^(\d{1,4})(\.\d+)?$/);
  if (m) {
    return sign * Math.round(parseFloat(s) * 60);
  }
  return null;
}

// 452 -> "7h32"
export function fmt(min) {
  const a = Math.abs(Math.round(min));
  return `${Math.floor(a / 60)}h${String(a % 60).padStart(2, '0')}`;
}

// -240 -> "−4h00", 32 -> "+0h32", 0 -> "0h00"
export function fmtSigned(min) {
  const r = Math.round(min);
  if (r === 0) return '0h00';
  return (r < 0 ? '−' : '+') + fmt(r);
}

// Date locale -> "2026-10-26"
export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseIso(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Bornes [début, fin] (ISO inclus) d'une période contenant la date ref
export function periodBounds(kind, ref) {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  if (kind === 'week') {
    const dow = (d.getDay() + 6) % 7; // lundi = 0
    const start = new Date(d); start.setDate(d.getDate() - dow);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    return [isoDate(start), isoDate(end)];
  }
  if (kind === 'month') {
    return [isoDate(new Date(d.getFullYear(), d.getMonth(), 1)), isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
  }
  if (kind === 'year') {
    return [`${d.getFullYear()}-01-01`, `${d.getFullYear()}-12-31`];
  }
  return ['0000-01-01', '9999-12-31'];
}

export function shiftRef(kind, ref, dir) {
  const d = new Date(ref);
  if (kind === 'week') d.setDate(d.getDate() + 7 * dir);
  else if (kind === 'month') d.setMonth(d.getMonth() + dir, 1);
  else if (kind === 'year') d.setFullYear(d.getFullYear() + dir);
  return d;
}

export function summarize(entries) {
  let prevu = 0, fait = 0;
  for (const e of entries) { prevu += e.prevu_min; fait += e.travail_min; }
  return { prevu, fait, ecart: fait - prevu };
}
