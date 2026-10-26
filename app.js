import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { parseDuree, fmt, fmtSigned, isoDate, parseIso, periodBounds, shiftRef, summarize } from './time.js';

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

function defaultPrevu() {
  // dernière valeur saisie, sinon réglage par défaut
  return state.entries[0]?.prevu_min ?? state.profile.prevu_defaut_min ?? 420;
}

function toDecimal(min) {
  return (Math.round((min / 60) * 100) / 100).toFixed(2);
}

function resetForm(jour) {
  $('f-date').value = jour;
  const ex = entryFor(jour);
  $('form-title').textContent = ex ? 'Modifier la journée' : (jour === isoDate(new Date()) ? 'Ma journée' : 'Ajouter une journée');
  $('f-prevu').value = fmt(ex ? ex.prevu_min : defaultPrevu());
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
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
  const text = `Je t'invite sur l'app de suivi d'heures. Ouvre ${url} , clique sur "Créer un compte" et mets ce code : ${code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Mes heures', text }); return; } catch { /* annulé */ }
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
