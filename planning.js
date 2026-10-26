// Planning par rotation (R1, R2, R3…) : quelle rotation tombe quelle semaine,
// et les horaires prévus de chaque jour.
//
// planning = {
//   anchor: "2026-10-26",            // un lundi où l'on connaît la rotation
//   cycle: ["R3", "R1", "R2"],       // ordre des rotations, semaine après semaine
//   rotations: { R1: { nom, jours: [lun, mar, mer, jeu, ven, sam, dim] } },
//                // chaque jour = [["07:45","11:15"],["12:30","16:30"]] ou null (repos)
//   exceptions: { "2026-10-26": [[...]] | null }   // jours changés à la main
// }

import { isoDate, parseIso } from './time.js';

export function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

export function hhmm(min) {
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}

// 450 -> "7,50" (centièmes, comme la borne)
export function cent(min) {
  return (Math.round((min / 60) * 100) / 100).toFixed(2).replace('.', ',');
}

export function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export function plagesTotal(plages) {
  if (!plages) return 0;
  return plages.reduce((t, [a, b]) => t + Math.max(0, toMin(b) - toMin(a)), 0);
}

export function rotationOf(planning, date) {
  if (!planning?.cycle?.length || !planning.anchor) return null;
  const a = mondayOf(parseIso(planning.anchor));
  const m = mondayOf(date);
  const weeks = Math.round((m - a) / (7 * 86400000));
  const n = planning.cycle.length;
  return planning.cycle[((weeks % n) + n) % n];
}

// -> { rot, nom, plages (null = repos), total (min), exception (bool) } ou null si pas de planning
export function dayPlan(planning, date) {
  const rot = rotationOf(planning, date);
  if (!rot) return null;
  const r = planning.rotations?.[rot];
  const iso = isoDate(date);
  const normal = r?.jours?.[(date.getDay() + 6) % 7] ?? null;
  const ex = planning.exceptions && Object.prototype.hasOwnProperty.call(planning.exceptions, iso);
  const plages = ex ? planning.exceptions[iso] : normal;
  return { rot, nom: r?.nom || rot, plages, normal, total: plagesTotal(plages), exception: !!ex };
}

export function weekPlan(planning, monday) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push({ date: d, iso: isoDate(d), ...dayPlan(planning, d) });
  }
  return days;
}
