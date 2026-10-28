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

// Roulement de l'atelier : R1 -> R2 -> R3 -> R1…
const A = [['07:45', '11:15'], ['12:30', '16:30']];
const B = [['08:30', '12:00'], ['13:15', '17:15']];
const C = [['09:00', '13:00'], ['14:15', '17:45']];
export const ROULEMENT = {
  R1: { nom: 'R1', jours: [A, A, A, A, [['07:45', '11:15'], ['12:30', '15:45']], null, null] },
  R2: { nom: 'R2', jours: [B, B, B, B, [['08:30', '12:00'], ['13:15', '16:30']], null, null] },
  R3: { nom: 'R3', jours: [null, C, C, [['09:15', '13:00'], ['14:15', '17:45']], C, [['08:00', '13:00'], ['14:00', '16:00']], null] },
};
export const CYCLE = ['R1', 'R2', 'R3'];

// "Cette semaine je suis en R2" -> planning qui enchaîne R3, R1… les semaines suivantes
export function planningRoulement(rotCetteSemaine, today = new Date(), exceptions = {}) {
  const idx = CYCLE.indexOf(rotCetteSemaine);
  const anchor = mondayOf(today);
  anchor.setDate(anchor.getDate() - idx * 7);
  return { anchor: isoDate(anchor), cycle: [...CYCLE], rotations: structuredClone(ROULEMENT), exceptions };
}

// Hors roulement : mêmes horaires chaque semaine sur les jours choisis
export function planningFixe(jours, plages, today = new Date(), exceptions = {}) {
  const semaine = [0, 1, 2, 3, 4, 5, 6].map((j) => (jours.includes(j) ? plages : null));
  return { anchor: isoDate(mondayOf(today)), cycle: ['FIXE'], rotations: { FIXE: { nom: 'Horaires fixes', jours: semaine } }, exceptions };
}

export function rotLabel(rot) { return rot === 'FIXE' ? 'Horaires fixes' : rot; }
