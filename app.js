import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { parseDuree, fmt, fmtSigned, isoDate, parseIso, periodBounds, shiftRef, summarize } from './time.js';
import { dayPlan, weekPlan, mondayOf, plagesTotal, cent as centMin, hhmm, toMin } from './planning.js';

const SUPABASE_URL = 'https://ogpidhrvlgkcyyaryjny.supabase.co';
const SUPABASE_KEY = 'sb_publishable_23qQ5heU8A9CF4me4VQ_8Q_le0fzV7H';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const $ = (id) => document.getElementById(id);
const state = {
  user: undefined,      // undefined = pas encore vérifié
  profile: null,
  entries: [],          // triées par date décroissante
  adjustments: [],      // dettes / plus ajoutés à la main
  period: 'month',
  ref: new Date(),
};

const JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

function frError(err) {
  const m = (err && (err.message || err.error_description)) || String(err);
  if (/invalid login credentials/i.test(m)) return 'Email ou mot de passe incorrect';
  if (/code d'invitation/i.test(m) || /database error saving new user/i.test(m)) return 'Code d\'invitation invalide ou déjà utilisé';
  if (/already registered|already exists/i.test(m)) return 'Un compte existe déjà avec cet email';
  if (/password should be at least/i.test(m)) return 'Mot de passe trop court (6 caractères min.)';
  if (/rate limit/i.test(m)) return 'Trop de tentatives, réessaie dans quelques minutes';
  if (/failed to fetch|network/i.test(m)) return 'Pas de connexion internet';
  return m;
}

// ---------- Auth ----------
document.querySelectorAll('[data-auth-tab]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-auth-tab]').forEach((x) => x.classList.toggle('active', x === b));
    $('login-form').hidden = b.dataset.authTab !== 'login';
    $('signup-form').hidden = b.dataset.authTab !== 'signup';
    $('auth-msg').textContent = '';
  });
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  $('auth-msg').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: f.get('email').trim(), password: f.get('password') });
  btn.disabled = false;
  if (error) $('auth-msg').textContent = frError(error);
});

$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  $('auth-msg').textContent = '';
  const email = f.get('email').trim();
  const password = f.get('password');
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { invite_code: f.get('code').trim().toUpperCase(), display_name: f.get('name').trim() } },
  });
  if (error) {
    btn.disabled = false;
    $('auth-msg').textContent = frError(error);
    return;
  }
  if (!data.session) {
    const { error: e2 } = await sb.auth.signInWithPassword({ email, password });
    if (e2) $('auth-msg').textContent = frError(e2);
  }
  btn.disabled = false;
});

sb.auth.onAuthStateChange((_event, session) => {
  const uid = session?.user?.id || null;
  if (state.user !== undefined && uid === (state.user?.id ?? null)) return;
  state.user = session?.user || null;
  setTimeout(route, 0);
});

async function route() {
  if (!state.user) {
    $('app-view').hidden = true;
    $('auth-view').hidden = false;
    return;
  }
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  await loadAll();
}

// ---------- Données ----------
async function loadAll() {
  const [p, e, a] = await Promise.all([
    sb.from('profiles').select('*').eq('id', state.user.id).maybeSingle(),
    sb.from('entries').select('id,jour,prevu_min,travail_min').order('jour', { ascending: false }),
    sb.from('adjustments').select('id,jour,minutes,note').order('jour', { ascending: false }),
  ]);
  const err = p.error || e.error || a.error;
  if (err) { toast(frError(err)); return; }
  state.profile = p.data || { display_name: '', solde_depart_min: 0, prevu_defaut_min: 420, is_admin: false };
  state.entries = e.data || [];
  state.adjustments = a.data || [];
  $('hello-name').textContent = state.profile.display_name || state.user.email;
  renderBalance();
  resetForm(isoDate(new Date()));
  renderHistory();
  state.weekRef = mondayOf(new Date());
  renderWeek();
  loadPause();
}

function renderBalance() {
  const { ecart } = summarize(state.entries);
  const total = (state.profile.solde_depart_min || 0) + ecart + sumAdj(state.adjustments);
  $('balance').textContent = fmtSigned(total);
  const card = $('balance-card');
  card.classList.toggle('neg', total < 0);
  card.classList.toggle('pos', total > 0);
  $('balance-sub').textContent = total < 0 ? 'à rattraper' : total > 0 ? 'd\'avance' : 'à jour';
}

// ---------- Formulaire ----------
function entryFor(jour) { return state.entries.find((x) => x.jour === jour); }

function defaultPrevu(jour) {
  // d'abord le planning (rotation R1/R2/R3), sinon dernière valeur saisie, sinon réglage
  const p = jour && state.profile?.planning ? dayPlan(state.profile.planning, parseIso(jour)) : null;
  if (p) return p.total;
  return state.entries[0]?.prevu_min ?? state.profile.prevu_defaut_min ?? 420;
}

function toDecimal(min) {
  return (Math.round((min / 60) * 100) / 100).toFixed(2);
}

function resetForm(jour) {
  $('f-date').value = jour;
  const ex = entryFor(jour);
  $('form-title').textContent = ex ? 'Modifier la journée' : (jour === isoDate(new Date()) ? 'Ma journée' : 'Ajouter une journée');
  $('f-prevu').value = ex ? fmt(ex.prevu_min) : ''; // saisie à la main, pas de remplissage auto
  $('f-travail').value = ex ? toDecimal(ex.travail_min) : '';
  $('delete-btn').hidden = !ex;
  $('save-btn').textContent = ex ? 'Mettre à jour' : 'Enregistrer';
  $('entry-msg').textContent = '';
  updatePreview();
  document.querySelectorAll('.history li').forEach((li) => li.classList.toggle('selected', li.dataset.jour === jour));
}

function updatePreview() {
  const p = parseDuree($('f-prevu').value);
  const t = parseDuree($('f-travail').value);
  $('c-prevu').textContent = p == null ? '' : `= ${fmt(p)}`;
  $('c-travail').textContent = t == null ? '' : `= ${fmt(t)}`;
  const d = $('day-diff');
  if (p == null || t == null) { d.textContent = '—'; d.className = 'strong'; return; }
  d.textContent = fmtSigned(t - p);
  d.className = 'strong ' + (t - p < 0 ? 'neg-t' : t - p > 0 ? 'pos-t' : '');
}

$('f-prevu').addEventListener('input', updatePreview);
$('f-travail').addEventListener('input', updatePreview);
$('f-date').addEventListener('change', () => { if ($('f-date').value) resetForm($('f-date').value); });

$('entry-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const jour = $('f-date').value;
  const prevu = parseDuree($('f-prevu').value);
  const travail = parseDuree($('f-travail').value);
  const msg = $('entry-msg');
  if (!jour) { msg.textContent = 'Choisis une date'; return; }
  if (prevu == null || prevu > 1440) { msg.textContent = 'Heures prévues invalides (ex : 7.50 ou 7h30)'; return; }
  if (travail == null || travail > 1440) { msg.textContent = 'Temps atelier invalide (ex : 7.53)'; return; }
  msg.textContent = '';
  const btn = $('save-btn');
  btn.disabled = true;
  const { data, error } = await sb.from('entries')
    .upsert({ user_id: state.user.id, jour, prevu_min: prevu, travail_min: travail }, { onConflict: 'user_id,jour' })
    .select('id,jour,prevu_min,travail_min')
    .single();
  btn.disabled = false;
  if (error) { msg.textContent = frError(error); return; }
  state.entries = state.entries.filter((x) => x.jour !== jour).concat(data).sort((a, b) => (a.jour < b.jour ? 1 : -1));
  toast(`Enregistré : ${fmtSigned(travail - prevu)} sur la journée`);
  buzz(15);
  renderBalance();
  renderHistory();
  resetForm(jour);
});

$('delete-btn').addEventListener('click', async () => {
  const jour = $('f-date').value;
  const ex = entryFor(jour);
  if (!ex) return;
  if (!confirm(`Supprimer la journée du ${labelJour(jour)} ?`)) return;
  const { error } = await sb.from('entries').delete().eq('id', ex.id);
  if (error) { $('entry-msg').textContent = frError(error); return; }
  state.entries = state.entries.filter((x) => x.id !== ex.id);
  toast('Journée supprimée');
  renderBalance();
  renderHistory();
  resetForm(isoDate(new Date()));
});

// ---------- Historique ----------
function labelJour(iso) {
  const d = parseIso(iso);
  return `${JOURS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear() !== new Date().getFullYear() ? '/' + String(d.getFullYear()).slice(2) : ''}`;
}

function periodLabel() {
  const r = state.ref;
  if (state.period === 'all') return 'Depuis le début';
  if (state.period === 'year') return String(r.getFullYear());
  if (state.period === 'month') return `${MOIS[r.getMonth()]} ${r.getFullYear()}`;
  const [s, e] = periodBounds('week', r);
  const a = parseIso(s), b = parseIso(e);
  return `Du ${a.getDate()}/${a.getMonth() + 1} au ${b.getDate()}/${b.getMonth() + 1}`;
}

function sumAdj(list) { return list.reduce((t, x) => t + x.minutes, 0); }

function renderHistory() {
  const [start, end] = periodBounds(state.period, state.ref);
  const list = state.entries.filter((x) => x.jour >= start && x.jour <= end);
  const adjs = state.adjustments.filter((x) => x.jour >= start && x.jour <= end);
  $('period-label').textContent = periodLabel();
  const all = state.period === 'all';
  $('prev-period').style.visibility = all ? 'hidden' : 'visible';
  $('next-period').style.visibility = all ? 'hidden' : 'visible';

  const s = summarize(list);
  const ecartTotal = s.ecart + sumAdj(adjs);
  $('st-prevu').textContent = fmt(s.prevu);
  $('st-fait').textContent = fmt(s.fait);
  const ec = $('st-ecart');
  ec.textContent = fmtSigned(ecartTotal);
  ec.className = 'strong ' + (ecartTotal < 0 ? 'neg-t' : ecartTotal > 0 ? 'pos-t' : '');

  const ul = $('history');
  ul.innerHTML = '';
  const rows = list.map((x) => ({ kind: 'day', x })).concat(adjs.map((x) => ({ kind: 'adj', x })))
    .sort((r1, r2) => (r1.x.jour < r2.x.jour ? 1 : r1.x.jour > r2.x.jour ? -1 : (r1.kind === 'adj' ? 1 : -1)));
  for (const { kind, x } of rows) {
    if (kind === 'adj') { ul.appendChild(adjRow(x)); continue; }
    const li = document.createElement('li');
    li.dataset.jour = x.jour;
    const diff = x.travail_min - x.prevu_min;
    const c1 = document.createElement('div');
    c1.innerHTML = `<div class="d"></div><div class="sub"></div>`;
    c1.querySelector('.d').textContent = labelJour(x.jour);
    c1.querySelector('.sub').textContent = `${toDecimal(x.travail_min)} → ${fmt(x.travail_min)}`;
    const c2 = document.createElement('div');
    c2.className = 'sub';
    c2.textContent = `prévu ${fmt(x.prevu_min)}`;
    const c3 = document.createElement('div');
    c3.className = 'ecart ' + (diff < 0 ? 'neg-t' : diff > 0 ? 'pos-t' : '');
    c3.textContent = fmtSigned(diff);
    li.append(c1, c2, c3);
    li.addEventListener('click', () => {
      resetForm(x.jour);
      goTo(1);
    });
    ul.appendChild(li);
  }
  $('history-empty').hidden = rows.length > 0;
}

function adjRow(x) {
  const li = document.createElement('li');
  li.className = 'adj';
  const c1 = document.createElement('div');
  c1.innerHTML = `<div class="d"></div><div class="sub"></div>`;
  c1.querySelector('.d').textContent = labelJour(x.jour);
  c1.querySelector('.sub').textContent = x.note || (x.minutes < 0 ? 'Dette ajoutée' : 'Plus ajouté');
  const c2 = document.createElement('div');
  c2.className = 'sub';
  c2.textContent = x.minutes < 0 ? 'je dois' : 'on me doit';
  const c3 = document.createElement('div');
  c3.className = 'ecart ' + (x.minutes < 0 ? 'neg-t' : 'pos-t');
  c3.textContent = fmtSigned(x.minutes);
  li.append(c1, c2, c3);
  li.addEventListener('click', () => openAdj(x));
  return li;
}

// ---------- Dette / plus ----------
let adjEditing = null;
let adjSens = -1;
function setSens(s) {
  adjSens = s;
  document.querySelectorAll('[data-sens]').forEach((b) => b.classList.toggle('active', Number(b.dataset.sens) === s));
}
document.querySelectorAll('[data-sens]').forEach((b) => b.addEventListener('click', () => setSens(Number(b.dataset.sens))));

function openAdj(x) {
  adjEditing = x || null;
  setSens(x ? Math.sign(x.minutes) : -1);
  $('adj-title').textContent = x ? 'Modifier' : 'Dette ou plus';
  $('adj-duree').value = x ? fmt(x.minutes) : '';
  $('adj-date').value = x ? x.jour : isoDate(new Date());
  $('adj-note').value = x?.note || '';
  $('adj-delete').hidden = !x;
  $('adj-save').textContent = x ? 'Mettre à jour' : 'Ajouter';
  $('adj-msg').textContent = '';
  $('c-adj').textContent = x ? `= ${fmt(x.minutes)}` : '';
  $('adj-dialog').showModal();
}
$('adj-open').addEventListener('click', () => openAdj(null));
$('adj-duree').addEventListener('input', () => {
  const v = parseDuree($('adj-duree').value);
  $('c-adj').textContent = v == null ? '' : `= ${fmt(v)}`;
});

$('adj-save').addEventListener('click', async () => {
  const dur = parseDuree($('adj-duree').value);
  const jour = $('adj-date').value;
  const msg = $('adj-msg');
  if (dur == null || dur === 0) { msg.textContent = 'Durée invalide (ex : 4h00 ou 4)'; return; }
  if (!jour) { msg.textContent = 'Choisis une date'; return; }
  const row = { jour, minutes: adjSens * dur, note: $('adj-note').value.trim() || null };
  const q = adjEditing
    ? sb.from('adjustments').update(row).eq('id', adjEditing.id)
    : sb.from('adjustments').insert({ ...row, user_id: state.user.id });
  const { data, error } = await q.select('id,jour,minutes,note').single();
  if (error) { msg.textContent = frError(error); return; }
  state.adjustments = state.adjustments.filter((x) => x.id !== data.id).concat(data)
    .sort((a, b) => (a.jour < b.jour ? 1 : -1));
  $('adj-dialog').close();
  toast(adjSens < 0 ? `Dette de ${fmt(dur)} enregistrée` : `${fmt(dur)} en plus enregistrées`);
  renderBalance();
  renderHistory();
});

$('adj-delete').addEventListener('click', async () => {
  if (!adjEditing || !confirm('Supprimer cette ligne ?')) return;
  const { error } = await sb.from('adjustments').delete().eq('id', adjEditing.id);
  if (error) { $('adj-msg').textContent = frError(error); return; }
  state.adjustments = state.adjustments.filter((x) => x.id !== adjEditing.id);
  $('adj-dialog').close();
  toast('Ligne supprimée');
  renderBalance();
  renderHistory();
});

document.querySelectorAll('[data-period]').forEach((b) => {
  b.addEventListener('click', () => {
    state.period = b.dataset.period;
    state.ref = new Date();
    document.querySelectorAll('[data-period]').forEach((x) => x.classList.toggle('active', x === b));
    renderHistory();
  });
});
$('prev-period').addEventListener('click', () => { state.ref = shiftRef(state.period, state.ref, -1); renderHistory(); });
$('next-period').addEventListener('click', () => { state.ref = shiftRef(state.period, state.ref, 1); renderHistory(); });

// ---------- Réglages ----------
$('settings-btn').addEventListener('click', () => {
  const p = state.profile;
  $('s-name').value = p.display_name || '';
  $('s-prevu').value = fmt(p.prevu_defaut_min ?? 420);
  $('settings-msg').textContent = '';
  $('admin-zone').hidden = !p.is_admin;
  if (p.is_admin) loadInvites();
  $('diag').textContent = diag();
  $('settings').showModal();
});

$('settings-save').addEventListener('click', async () => {
  const msg = $('settings-msg');
  msg.className = 'msg';
  const prevu = parseDuree($('s-prevu').value);
  if (prevu == null || prevu > 1440) { msg.textContent = 'Heures prévues invalides (ex : 7h00)'; return; }
  const upd = { display_name: $('s-name').value.trim() || null, prevu_defaut_min: prevu };
  const { error } = await sb.from('profiles').update(upd).eq('id', state.user.id);
  if (error) { msg.textContent = frError(error); return; }
  Object.assign(state.profile, upd);
  $('hello-name').textContent = state.profile.display_name || state.user.email;
  renderBalance();
  if (!entryFor($('f-date').value)) resetForm($('f-date').value);
  msg.className = 'msg ok';
  msg.textContent = 'Réglages enregistrés';
});

$('logout-btn').addEventListener('click', async () => {
  $('settings').close();
  await sb.auth.signOut();
  state.entries = [];
  state.profile = null;
});

async function loadInvites() {
  const { data, error } = await sb.from('invite_codes').select('*').order('created_at', { ascending: false }).limit(20);
  const ul = $('invites');
  ul.innerHTML = '';
  if (error) return;
  for (const c of data) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = c.code;
    const usedUp = !c.active || c.uses >= c.max_uses;
    if (usedUp) code.className = 'used';
    const info = document.createElement('span');
    info.className = 'small muted';
    info.textContent = !c.active ? 'désactivé' : c.uses >= c.max_uses ? 'utilisé' : 'libre';
    li.append(code, info);
    if (!usedUp) {
      const share = document.createElement('button');
      share.className = 'btn';
      share.type = 'button';
      share.textContent = 'Partager';
      share.addEventListener('click', () => shareInvite(c.code));
      const off = document.createElement('button');
      off.className = 'btn danger';
      off.type = 'button';
      off.textContent = '✕';
      off.title = 'Désactiver';
      off.addEventListener('click', async () => {
        await sb.from('invite_codes').update({ active: false }).eq('code', c.code);
        loadInvites();
      });
      li.append(share, off);
    }
    ul.appendChild(li);
  }
}

async function shareInvite(code) {
  const url = location.origin + location.pathname;
  const text = `Je t'invite sur l'app Gestion de travail. Ouvre ${url} , clique sur "Créer un compte" et mets ce code : ${code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Gestion de travail', text }); return; } catch { /* annulé */ }
  }
  try { await navigator.clipboard.writeText(text); toast('Invitation copiée'); } catch { prompt('Copie ce message :', text); }
}

$('new-invite').addEventListener('click', async () => {
  const { data, error } = await sb.rpc('create_invite', { p_max_uses: 1 });
  if (error) { $('settings-msg').className = 'msg'; $('settings-msg').textContent = frError(error); return; }
  await loadInvites();
  shareInvite(data);
});

// ---------- PWA ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('install-btn').hidden = false;
});
$('install-btn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('install-btn').hidden = true;
});
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
let iosHintSeen = false;
try { iosHintSeen = localStorage.getItem('iosHint') === '1'; } catch { /* ignore */ }
if (isIOS && !isStandalone && !iosHintSeen) $('ios-hint').hidden = false;
$('ios-hint-close').addEventListener('click', () => {
  $('ios-hint').hidden = true;
  try { localStorage.setItem('iosHint', '1'); } catch { /* ignore */ }
});

// Revenir sur l'app le lendemain : on remet la date du jour si rien n'est en cours
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user && !$('f-travail').value) {
    resetForm(isoDate(new Date()));
  }
});

// ---------- Navigation mobile (pages qu'on fait glisser) ----------
const pager = $('pager');
const tabs = [...document.querySelectorAll('.tab')];
let currentPage = 0;

function buzz(ms = 8) { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* iPhone : pas de vibration web */ } }

function setActiveTab(i) {
  if (i === currentPage) return;
  currentPage = i;
  tabs.forEach((t, k) => t.classList.toggle('active', k === i));
  buzz(6);
  if (document.activeElement && document.activeElement.blur && document.activeElement.tagName === 'INPUT') {
    document.activeElement.blur();
  }
}

function goTo(i, smooth = true) {
  pager.scrollTo({ left: i * pager.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
  setActiveTab(i);
}

let scrollRaf = 0;
pager.addEventListener('scroll', () => {
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    const i = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
    setActiveTab(Math.max(0, Math.min(3, i)));
  });
}, { passive: true });

document.querySelectorAll('[data-tab]').forEach((b) => {
  b.addEventListener('click', () => goTo(Number(b.dataset.tab)));
});
// Garder la bonne page quand on tourne le téléphone / redimensionne
window.addEventListener('resize', () => goTo(currentPage, false));

// ---------- Calculatrice ----------
const dec = (min) => (Math.round((min / 60) * 100) / 100).toFixed(2).replace('.', ',');

$('k-atelier').addEventListener('input', () => {
  const v = parseDuree($('k-atelier').value);
  $('k-atelier-res').textContent = v == null ? '—' : fmt(v);
});

function calcHM() {
  const hs = $('k-h').value.trim(), ms = $('k-m').value.trim();
  if (hs === '' && ms === '') { $('k-hm-res').textContent = '—'; return; }
  const h = hs === '' ? 0 : Number(hs), m = ms === '' ? 0 : Number(ms);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) { $('k-hm-res').textContent = 'Minutes entre 0 et 59'; return; }
  $('k-hm-res').textContent = dec(h * 60 + m);
}
$('k-h').addEventListener('input', calcHM);
$('k-m').addEventListener('input', calcHM);

let kItems = []; // en centièmes d'heure
const cent = (c) => (c / 100).toFixed(2).replace('.', ',');
function renderK() {
  const ul = $('k-list');
  ul.innerHTML = '';
  kItems.forEach((v, i) => {
    const li = document.createElement('li');
    li.textContent = cent(v);
    const x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Retirer');
    x.textContent = '✕';
    x.addEventListener('click', () => { kItems.splice(i, 1); renderK(); });
    li.appendChild(x);
    ul.appendChild(li);
  });
  const tot = kItems.reduce((a, b) => a + b, 0);
  $('k-total').textContent = `${cent(tot)} = ${fmt(tot * 0.6)}`;
}
function addK() {
  // on additionne en centièmes exacts (comme la borne), sans arrondir à la minute
  const raw = $('k-add').value.trim().replace(',', '.');
  let v = /^\d{1,3}(\.\d{1,2})?$/.test(raw) ? Math.round(parseFloat(raw) * 100) : null;
  if (v == null) { const m = parseDuree($('k-add').value); if (m != null) v = Math.round((m / 60) * 100); }
  if (v == null) { $('k-add').focus(); return; }
  kItems.push(v);
  $('k-add').value = '';
  $('k-add').focus();
  buzz(5);
  renderK();
}
$('k-add-btn').addEventListener('click', addK);
$('k-add').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addK(); } });
$('k-clear').addEventListener('click', () => { kItems = []; renderK(); });

// Hauteur de l'app = zone visible réelle
function safeTop() {
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top)';
  document.body.appendChild(p);
  const v = parseInt(getComputedStyle(p).paddingTop) || 0;
  p.remove();
  return v;
}
function fixHeight() {
  const h = window.innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  // Bug iOS (app installée) : la zone de l'app s'arrête avant le bas de l'écran
  // (écran 852, app 793 = écran - barre d'état). On colore la bande du bas comme
  // la barre d'onglets pour qu'elles ne fassent qu'une.
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  const full = portrait ? screen.height : screen.width;
  const gap = standalone && /iphone|ipod/i.test(navigator.userAgent) && full - h > 20 && h + safeTop() <= full + 2;
  document.documentElement.classList.toggle('ios-gap', gap);
}
fixHeight();
window.addEventListener('resize', fixHeight);
window.addEventListener('orientationchange', () => setTimeout(fixHeight, 300));

// Ligne de diagnostic (en bas des réglages) pour régler l'affichage selon le téléphone
const APP_VERSION = 'v16';
function diag() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const st = parseInt(cs.paddingTop) || 0, sb = parseInt(cs.paddingBottom) || 0;
  probe.remove();
  const sa = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'app' : 'web';
  const vv = window.visualViewport ? Math.round(visualViewport.height) + '/' + Math.round(visualViewport.offsetTop) : '-';
  return `${APP_VERSION} · ${sa} · écran ${screen.height} · vue ${innerHeight} · vv ${vv} · haut ${st} · bas ${sb} · app ${$('app-view').getBoundingClientRect().height | 0}${document.documentElement.classList.contains('ios-gap') ? ' · correctif iOS' : ''}`;
}

// ---------- Planning de la semaine (accueil) ----------
const JOURS_COURTS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
state.weekRef = mondayOf(new Date());

function plagesTexte(pl) {
  return pl.map(([a, b]) => `${hhmm(toMin(a))}–${hhmm(toMin(b))}`).join(' · ');
}

function renderWeek() {
  const planning = state.profile?.planning;
  const ul = $('wk-days');
  ul.innerHTML = '';
  const todayIso = isoDate(new Date());
  const thisMonday = mondayOf(new Date());
  const diffW = Math.round((state.weekRef - thisMonday) / (7 * 86400000));
  $('wk-title').textContent = diffW === 0 ? 'Cette semaine' : diffW === 1 ? 'Semaine prochaine' : diffW === -1 ? 'Semaine dernière'
    : `Semaine du ${state.weekRef.getDate()}/${state.weekRef.getMonth() + 1}`;
  updateTodayTile();
  if (!planning) { $('wk-sub').textContent = ''; $('wk-empty').hidden = false; return; }
  $('wk-empty').hidden = true;
  const days = weekPlan(planning, state.weekRef);
  const total = days.reduce((t, d) => t + d.total, 0);
  $('wk-sub').textContent = `${days[0].rot} · ${days[0].nom} · ${centMin(total)}`;
  days.forEach((d, i) => {
    if (i === 6 && !d.plages) return; // dimanche affiché seulement s'il est travaillé
    const li = document.createElement('li');
    li.className = (d.iso === todayIso ? 'today ' : '') + (d.plages ? '' : 'off') + (d.iso < todayIso ? ' past' : '');
    const c1 = document.createElement('div');
    c1.className = 'wd';
    c1.innerHTML = '<span class="wd-n"></span><span class="wd-d"></span>';
    c1.querySelector('.wd-n').textContent = JOURS_COURTS[i];
    c1.querySelector('.wd-d').textContent = d.date.getDate();
    const c2 = document.createElement('div');
    c2.className = 'wh';
    c2.textContent = d.plages ? plagesTexte(d.plages) : 'Repos';
    if (d.exception) {
      const m = document.createElement('span');
      m.className = 'wx';
      m.textContent = 'modifié';
      c2.appendChild(m);
    }
    const c3 = document.createElement('div');
    c3.className = 'wt';
    c3.textContent = d.plages ? centMin(d.total) : '';
    li.append(c1, c2, c3);
    li.addEventListener('click', () => openDay(d));
    ul.appendChild(li);
  });
}

function updateTodayTile() {
  const p = state.profile?.planning ? dayPlan(state.profile.planning, new Date()) : null;
  $('tile-today').textContent = !p ? "Aujourd'hui" : p.plages ? `Prévu ${centMin(p.total)}` : "Repos aujourd'hui";
}

$('wk-prev').addEventListener('click', () => { state.weekRef.setDate(state.weekRef.getDate() - 7); state.weekRef = new Date(state.weekRef); renderWeek(); });
$('wk-next').addEventListener('click', () => { state.weekRef.setDate(state.weekRef.getDate() + 7); state.weekRef = new Date(state.weekRef); renderWeek(); });

// ----- Modifier un jour (repos ↔ travail, horaires) -----
let ddDay = null;
let ddWork = true;
function setDdWork(w) {
  ddWork = w;
  document.querySelectorAll('[data-dd]').forEach((b) => b.classList.toggle('active', (b.dataset.dd === 'work') === w));
  $('dd-hours').hidden = !w;
  ddTotal();
}
document.querySelectorAll('[data-dd]').forEach((b) => b.addEventListener('click', () => setDdWork(b.dataset.dd === 'work')));

function ddPlages() {
  const v = ['dd-a1', 'dd-a2', 'dd-b1', 'dd-b2'].map((id) => $(id).value);
  const out = [];
  if (v[0] && v[1]) out.push([v[0], v[1]]);
  if (v[2] && v[3]) out.push([v[2], v[3]]);
  return out;
}
function ddTotal() {
  const t = plagesTotal(ddPlages());
  $('dd-total').textContent = t ? `${centMin(t)} = ${hhmm(t)}` : '—';
}
['dd-a1', 'dd-a2', 'dd-b1', 'dd-b2'].forEach((id) => $(id).addEventListener('input', ddTotal));

function openDay(d) {
  ddDay = d;
  const name = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][d.date.getDay()];
  $('dd-title').textContent = `${name.charAt(0).toUpperCase() + name.slice(1)} ${d.date.getDate()}/${d.date.getMonth() + 1} · ${d.rot}`;
  const src = d.plages || d.normal || state.profile.planning.rotations?.[d.rot]?.jours?.find((x) => x) || [];
  $('dd-a1').value = src[0]?.[0] || '';
  $('dd-a2').value = src[0]?.[1] || '';
  $('dd-b1').value = src[1]?.[0] || '';
  $('dd-b2').value = src[1]?.[1] || '';
  $('dd-reset').hidden = !d.exception;
  $('dd-msg').textContent = '';
  setDdWork(!!d.plages);
  $('day-dialog').showModal();
}

async function savePlanning(planning) {
  const { error } = await sb.from('profiles').update({ planning }).eq('id', state.user.id);
  if (error) { $('dd-msg').textContent = frError(error); return false; }
  state.profile.planning = planning;
  renderWeek();
  if (!entryFor($('f-date').value)) resetForm($('f-date').value);
  return true;
}

$('dd-save').addEventListener('click', async () => {
  const pl = ddWork ? ddPlages() : null;
  if (ddWork && (!pl.length || pl.some(([a, b]) => toMin(b) <= toMin(a)))) {
    $('dd-msg').textContent = 'Vérifie les horaires (début avant fin)';
    return;
  }
  const planning = structuredClone(state.profile.planning);
  planning.exceptions = planning.exceptions || {};
  if (JSON.stringify(pl) === JSON.stringify(ddDay.normal ?? null)) delete planning.exceptions[ddDay.iso];
  else planning.exceptions[ddDay.iso] = pl;
  if (await savePlanning(planning)) { $('day-dialog').close(); toast('Planning mis à jour'); }
});

$('dd-reset').addEventListener('click', async () => {
  const planning = structuredClone(state.profile.planning);
  delete planning.exceptions?.[ddDay.iso];
  if (await savePlanning(planning)) { $('day-dialog').close(); toast('Horaire normal remis'); }
});

// ---------- Pauses avec notification de fin ----------
const VAPID_PUBLIC = 'BL3x2ukKJbCcuI42vvfnMCmWIv3Hhu_bRdS96yGcm2zHcHtCX8ML8CDBbccRatseSdpFmvrwV1vCp7KRolcho-8';
let pause = null;        // { id, label, minutes, endsAt (ms) }
let pauseTick = 0;
let pauseDismissed = 0; // pause terminée déjà fermée avec OK
let audioCtx = null;

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Demande l'autorisation et enregistre ce téléphone pour recevoir les notifications.
// Renvoie un petit message si ça ne marche pas (sinon '').
async function ensurePush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return /iphone|ipad/i.test(navigator.userAgent)
      ? "Notifications : ouvre l'app depuis l'icône de l'écran d'accueil (pas depuis Safari)."
      : 'Notifications non disponibles sur ce navigateur. Le minuteur marche quand même, app ouverte.';
  }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'Notifications refusées : autorise-les dans Réglages > Notifications > Travail.';
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC) });
  const j = sub.toJSON();
  const { error } = await sb.from('push_subscriptions').insert({ user_id: state.user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
  if (error && error.code !== '23505') return 'Notification pas enregistrée : ' + frError(error);
  return '';
}

function beep() {
  try {
    if (!audioCtx) return;
    [0, 0.35, 0.7].forEach((t) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.4, audioCtx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + 0.25);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.3);
    });
  } catch { /* pas de son */ }
}

function renderPause() {
  clearInterval(pauseTick);
  const running = !!pause;
  $('pause-idle').hidden = running;
  $('pause-run').hidden = !running;
  $('pause-bar-wrap').hidden = !running;
  $('pause-run').classList.remove('done');
  if (!running) return;
  $('pause-label').textContent = pause.label;
  const end = new Date(pause.endsAt);
  $('pause-end').textContent = `Fin à ${end.getHours()}h${String(end.getMinutes()).padStart(2, '0')}`;
  const tick = () => {
    const left = Math.max(0, pause.endsAt - Date.now());
    const s = Math.ceil(left / 1000);
    $('pause-left').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('pause-bar').style.width = `${100 - (left / (pause.minutes * 60000)) * 100}%`;
    if (left <= 0) {
      clearInterval(pauseTick);
      $('pause-run').classList.add('done');
      $('pause-left').textContent = 'Terminée';
      $('pause-cancel').textContent = 'OK';
      if (document.visibilityState === 'visible') { buzz([300, 150, 300, 150, 300]); beep(); }
    }
  };
  $('pause-cancel').textContent = 'Annuler';
  tick();
  pauseTick = setInterval(tick, 1000);
}

async function loadPause() {
  const { data } = await sb.from('pause_timers').select('id,label,minutes,ends_at')
    .gt('ends_at', new Date(Date.now() - 2 * 60000).toISOString()).order('ends_at', { ascending: false }).limit(1);
  const p = data?.[0];
  pause = p && p.id !== pauseDismissed ? { id: p.id, label: p.label, minutes: p.minutes, endsAt: new Date(p.ends_at).getTime() } : null;
  renderPause();
}

document.querySelectorAll('[data-pause]').forEach((b) => b.addEventListener('click', async () => {
  const minutes = Number(b.dataset.pause);
  const label = b.dataset.label;
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* */ }
  const note = $('pause-note');
  note.textContent = '';
  const pushMsg = await ensurePush().catch((e) => 'Notifications : ' + (e.message || e));
  const endsAt = Date.now() + minutes * 60000;
  const { data, error } = await sb.from('pause_timers')
    .insert({ user_id: state.user.id, label, minutes, ends_at: new Date(endsAt).toISOString() })
    .select('id').single();
  if (error) { note.textContent = frError(error); return; }
  pause = { id: data.id, label, minutes, endsAt };
  buzz(15);
  renderPause();
  note.textContent = pushMsg || 'Tu recevras une notification à la fin, même téléphone verrouillé.';
}));

$('pause-cancel').addEventListener('click', async () => {
  if (!pause) return;
  const done = pause.endsAt <= Date.now();
  if (!done) await sb.from('pause_timers').delete().eq('id', pause.id);
  else pauseDismissed = pause.id;
  pause = null;
  $('pause-note').textContent = done ? '' : 'Pause annulée';
  renderPause();
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.user) loadPause(); });
