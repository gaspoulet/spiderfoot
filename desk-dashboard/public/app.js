'use strict';

/* ════════════════════════════════════════════════════════════════════
   Bureau — dashboard de bureau (iPhone en paysage, toujours allumé)
   ════════════════════════════════════════════════════════════════════ */

const HK = 'Asia/Hong_Kong';
const PARIS = 'Europe/Paris';
const NIGHT_START = 23, NIGHT_END = 7;           // mode nuit 23 h → 7 h (heure de HK)
const SHIFT_EVERY = 2 * 60 * 1000;               // anti-marquage OLED
const SYNC_EVERY = 15 * 60 * 1000;               // devoirs : toutes les 15 min
const RING_MAX = 10 * 60 * 1000;                 // la sonnerie s'arrête seule après 10 min
const SNOOZE = 5 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const pad = (n) => String(n).padStart(2, '0');

/* ───────── Stockage (localStorage, protégé) ───────── */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('bureau.' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('bureau.' + key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  },
};

/* ───────── Fuseaux horaires ───────── */
const fmtCache = {};
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function zoned(tz, date = new Date()) {
  const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  const z = { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, dow: WD.indexOf(o.weekday) };
  z.day = Date.UTC(z.y, z.mo - 1, z.d) / 864e5;   // numéro de jour (pour comparer des dates)
  z.wall = Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi, z.s);
  z.key = `${z.y}-${pad(z.mo)}-${pad(z.d)}`;
  z.min = z.h * 60 + z.mi;
  return z;
}
const frDate = new Intl.DateTimeFormat('fr-FR', { timeZone: HK, weekday: 'long', day: 'numeric', month: 'long' });
const frShort = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function durationFr(mins) {
  if (mins < 1) return "moins d'1 min";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${pad(m)}` : `${h} h`;
}

/* ───────── Couleurs par matière (palette système iOS) ───────── */
const PALETTE = ['#0A84FF', '#FF9F0A', '#30D158', '#BF5AF2', '#FF453A', '#64D2FF', '#FFD60A', '#AC8E68'];
function colorFor(name) {
  if (!name) return '#8E8E93';
  const s = name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* ════════════════════ Horloges ════════════════════ */
let lastMinuteKey = '';
function renderClocks(now) {
  const hk = zoned(HK, now), pa = zoned(PARIS, now);
  $('hk-hm').textContent = `${pad(hk.h)}:${pad(hk.mi)}`;

  const minuteKey = `${hk.key} ${hk.min}`;
  const minuteChanged = minuteKey !== lastMinuteKey;
  lastMinuteKey = minuteKey;
  if (minuteChanged) {
    $('hk-date').textContent = cap(frDate.format(now));
    $('paris-time').textContent = `${pad(pa.h)}:${pad(pa.mi)}`;
  }
  return { hk, minuteChanged };
}

/* ════════════════════ Mode nuit, Wake Lock, anti-marquage ════════════════════ */
let revealUntil = 0;
function applyNight(hk) {
  const nightHours = hk.h >= NIGHT_START || hk.h < NIGHT_END;
  const night = nightHours && Date.now() > revealUntil && !sheetOpen;
  document.body.classList.toggle('night', night);
}
document.addEventListener('click', () => {
  if (document.body.classList.contains('night')) {
    revealUntil = Date.now() + 20000;                // un tapotement rallume tout 20 s
    applyNight(zoned(HK));
  }
}, true);

let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* refusé : on réessaiera au prochain geste */ }
}

function shiftPixels() {
  const x = Math.round(Math.random() * 8 - 4), y = Math.round(Math.random() * 6 - 3);
  $('app').style.transform = `translate(${x}px, ${y}px)`;
}

/* ════════════════════ Audio (réveil) ════════════════════ */
let actx = null, master = null, ringTimer = null, ringStarted = 0, keepAliveNode = null;

function audioRunning() { return !!actx && actx.state === 'running'; }

function armSound() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* iOS 17+ : ignore le bouton silence */ }
  try {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      actx.addEventListener('statechange', renderArm);
    }
    actx.resume();
    // Tampon silencieux : débloque l'audio sur iOS
    const b = actx.createBuffer(1, 1, 22050), src = actx.createBufferSource();
    src.buffer = b; src.connect(actx.destination); src.start(0);
    // Source inaudible permanente : garde la session audio active
    if (!keepAliveNode) {
      const osc = actx.createOscillator(), g = actx.createGain();
      g.gain.value = 0; osc.connect(g).connect(actx.destination); osc.start();
      keepAliveNode = osc;
    }
  } catch { /* pas d'audio */ }
  setTimeout(renderArm, 150);
}

function renderArm() {
  const ok = audioRunning();
  const b = $('arm-btn');
  b.classList.toggle('armed', ok);
  b.querySelector('span').textContent = ok ? 'Son armé' : 'Armer le son';
}

function chime(t, gainNode) {
  // Petit carillon (3 notes douces) façon « Radar » adouci
  const notes = [1046.5, 1318.5, 1568];
  notes.forEach((f, i) => {
    const start = t + i * 0.16;
    const o = actx.createOscillator(), o2 = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    o2.type = 'triangle'; o2.frequency.value = f * 2;
    const g2 = actx.createGain(); g2.gain.value = 0.12;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
    o.connect(g); o2.connect(g2).connect(g); g.connect(gainNode);
    o.start(start); o2.start(start); o.stop(start + 1); o2.stop(start + 1);
  });
}

function startSound() {
  if (!actx) armSound();
  if (!actx) return;
  actx.resume();
  master = actx.createGain();
  const t = actx.currentTime;
  master.gain.setValueAtTime(0.04, t);
  master.gain.linearRampToValueAtTime(0.25, t + 20);   // montée progressive
  master.gain.linearRampToValueAtTime(1.0, t + 60);
  master.connect(actx.destination);
  let next = actx.currentTime + 0.05;
  const schedule = () => {
    while (next < actx.currentTime + 1.5) { chime(next, master); next += 1.8; }
  };
  schedule();
  ringTimer = setInterval(schedule, 400);
}

function stopSound() {
  clearInterval(ringTimer); ringTimer = null;
  if (master && actx) {
    const t = actx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(0, t + 0.3);
    const m = master; setTimeout(() => m.disconnect(), 400);
  }
  master = null;
}

/* ════════════════════ Réveil ════════════════════ */
const DAY_LETTERS = [['L', 1], ['M', 2], ['M', 3], ['J', 4], ['V', 5], ['S', 6], ['D', 0]];
const DAY_NAMES = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
let alarm = Object.assign({ time: '07:00', enabled: false, days: [1, 2, 3, 4, 5], label: 'Réveil' }, store.get('alarm', {}));
let alarmRt = Object.assign({ lastFired: '', snoozeUntil: 0 }, store.get('alarmRt', {}));
let ringing = false;

function daysLabel(days) {
  const s = [...days].sort().join(',');
  if (days.length === 7) return 'Tous les jours';
  if (s === '1,2,3,4,5') return 'En semaine';
  if (s === '0,6') return 'Le week-end';
  if (!days.length) return 'Une seule fois';
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).map((d) => DAY_NAMES[d]).join(' ');
}

function renderAlarm() {
  $('alarm-time').textContent = alarm.time;
  $('alarm-enabled').checked = alarm.enabled;
  $('alarm-widget').classList.toggle('off', !alarm.enabled);
  const small = $('alarm-days');
  if (alarmRt.snoozeUntil > Date.now()) {
    const z = zoned(HK, new Date(alarmRt.snoozeUntil));
    small.textContent = `Rappel à ${pad(z.h)}:${pad(z.mi)}`;
    small.classList.add('alarm-snoozed');
  } else {
    small.textContent = alarm.enabled ? daysLabel(alarm.days) : 'Désactivé';
    small.classList.remove('alarm-snoozed');
  }
}
function saveAlarm() { store.set('alarm', alarm); store.set('alarmRt', alarmRt); renderAlarm(); }

function checkAlarm(hk) {
  if (ringing) {
    if (Date.now() - ringStarted > RING_MAX) stopRing();
    return;
  }
  if (alarmRt.snoozeUntil && Date.now() >= alarmRt.snoozeUntil) {
    alarmRt.snoozeUntil = 0; saveAlarm(); startRing(); return;
  }
  if (!alarm.enabled) return;
  const [h, m] = alarm.time.split(':').map(Number);
  const fireKey = `${hk.key} ${alarm.time}`;
  const dayOk = !alarm.days.length || alarm.days.includes(hk.dow);
  if (dayOk && hk.h === h && hk.mi === m && alarmRt.lastFired !== fireKey) {
    alarmRt.lastFired = fireKey;
    if (!alarm.days.length) alarm.enabled = false;        // réveil « une seule fois »
    saveAlarm();
    startRing();
  }
}

function startRing() {
  ringing = true; ringStarted = Date.now();
  const hk = zoned(HK);
  $('ring-time').textContent = `${pad(hk.h)}:${pad(hk.mi)}`;
  $('ring-label').textContent = (alarm.label || 'Réveil') + (audioRunning() ? '' : ' · son non armé');
  $('ring').hidden = false;
  startSound();
}
function stopRing() {
  ringing = false;
  $('ring').hidden = true;
  stopSound();
  renderAlarm();
}
$('ring-stop').addEventListener('click', () => { alarmRt.snoozeUntil = 0; saveAlarm(); stopRing(); });
$('ring-snooze').addEventListener('click', () => { alarmRt.snoozeUntil = Date.now() + SNOOZE; saveAlarm(); stopRing(); });
$('arm-btn').addEventListener('click', armSound);
$('alarm-enabled').addEventListener('change', (e) => {
  alarm.enabled = e.target.checked;
  if (!alarm.enabled) alarmRt.snoozeUntil = 0;
  if (alarm.enabled && !audioRunning()) armSound();
  saveAlarm();
});

function openAlarmSheet() {
  const body = el('div');
  const g = el('div', 'group');
  const r1 = el('div', 'row'); r1.append(el('label', null, 'Heure'));
  const t = el('input'); t.type = 'time'; t.value = alarm.time; r1.append(t);
  const r2 = el('div', 'row'); r2.append(el('label', null, 'Libellé'));
  const lab = el('input'); lab.value = alarm.label || ''; lab.placeholder = 'Réveil'; r2.append(lab);
  const r3 = el('div', 'row'); r3.append(el('span', 'lbl', 'Activé'));
  const sw = el('label', 'ios-switch'); sw.style.marginLeft = 'auto';
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = alarm.enabled; sw.append(cb, el('span')); r3.append(sw);
  g.append(r1, r2, r3);

  const g2 = el('div', 'group');
  const days = el('div', 'days');
  const sel = new Set(alarm.days);
  for (const [letter, d] of DAY_LETTERS) {
    const b = el('button', 'day-chip' + (sel.has(d) ? ' on' : ''), letter);
    b.type = 'button';
    b.addEventListener('click', () => { sel.has(d) ? sel.delete(d) : sel.add(d); b.classList.toggle('on'); });
    days.append(b);
  }
  g2.append(days);
  const foot = el('p', 'foot', 'Aucun jour sélectionné = une seule fois. Le son monte progressivement pendant une minute.');

  const test = el('button', 'danger-btn', 'Tester la sonnerie (5 s)');
  test.style.color = 'var(--label)';
  test.addEventListener('click', () => { armSound(); startSound(); setTimeout(stopSound, 5000); });

  body.append(g, g2, foot, test);
  openSheet('Réveil', body, () => {
    alarm.time = t.value || alarm.time;
    alarm.label = lab.value.trim() || 'Réveil';
    alarm.enabled = cb.checked;
    alarm.days = [...sel];
    alarmRt.lastFired = '';
    alarmRt.snoozeUntil = 0;
    if (alarm.enabled && !audioRunning()) armSound();
    saveAlarm();
  });
}
$('alarm-edit').addEventListener('click', openAlarmSheet);
$('alarm-time-btn').addEventListener('click', openAlarmSheet);

/* ════════════════════ Emploi du temps ════════════════════ */
const DEFAULT_TT = `# Un jour par titre, puis un cours par ligne :
# début-fin Matière @ Salle

Lundi
09:30-10:15 Chimie @ 404 PC
10:40-11:25 Chimie @ 404 PC
11:30-12:15 Anglais @ 206
12:35-13:15 Science Plus

Mardi
08:30-09:30 Maths @ 106 FS
09:30-10:15 Learning Support
10:40-11:25 Anglais @ 107
12:35-13:15 Géographie @ 504
13:32-14:15 Anglais @ 507A
14:30-15:15 Physique @ 402

Mercredi
08:30-09:30 Français @ 304/G03
09:30-10:15 Géographie @ 202
10:40-11:25 Chimie @ 404 PC
12:35-13:15 Learning Support @ UG-04
13:32-14:15 Biologie @ 402
14:30-15:15 Biologie @ 402
15:40-16:15 Maths @ 107

Jeudi
08:30-09:30 Maths @ 508
09:30-10:15 Français @ 304
10:40-11:25 Learning Support @ UG-04
11:30-12:15 Biologie @ 402
12:35-13:15 Maths @ 107
14:30-15:15 Français @ 106 FS

Vendredi
08:30-09:30 EPS
09:30-10:15 EPS
10:40-11:25 PSHE @ 507B
11:30-12:15 Physique @ 402
12:35-13:15 Physique @ 402
14:30-15:15 Géographie @ 201
15:40-16:15 Anglais @ 206
`;
const DAY_ALIASES = {
  dim: 0, dimanche: 0, sun: 0, sunday: 0,
  lun: 1, lundi: 1, mon: 1, monday: 1,
  mar: 2, mardi: 2, tue: 2, tuesday: 2,
  mer: 3, mercredi: 3, wed: 3, wednesday: 3,
  jeu: 4, jeudi: 4, thu: 4, thursday: 4,
  ven: 5, vendredi: 5, fri: 5, friday: 5,
  sam: 6, samedi: 6, sat: 6, saturday: 6,
};
const COURSE_RE = /^(\d{1,2})\s*[:hH.]\s*(\d{2})\s*[-–—>]+\s*(\d{1,2})\s*[:hH.]\s*(\d{2})\s+(.+?)(?:\s+@\s*(.+))?$/;

function parseTimetable(text) {
  const days = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  const errors = [];
  let current = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    const head = line.replace(/:$/, '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const names = head.split(/\s*[,/+]\s*|\s+/);
    if (names.every((n) => n.replace('.', '') in DAY_ALIASES)) {
      current = names.map((n) => DAY_ALIASES[n.replace('.', '')]);
      return;
    }
    const m = line.match(COURSE_RE);
    if (!m) { errors.push(i + 1); return; }
    const start = +m[1] * 60 + +m[2], end = +m[3] * 60 + +m[4];
    if (end <= start || !current.length) { errors.push(i + 1); return; }
    for (const d of current) days[d].push({ start, end, name: m[5].trim(), room: (m[6] || '').trim() });
  });
  for (const d in days) days[d].sort((a, b) => a.start - b.start);
  return { days, errors };
}

let ttText = store.get('timetable', DEFAULT_TT);   // emploi du temps réel, repris de Blubee
let timetable = parseTimetable(ttText).days;
const hm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
let calRefs = [];

function renderSchedule(hk) {
  const list = $('cal-list');
  list.textContent = '';
  calRefs = [];
  const today = timetable[hk.dow] || [];
  $('cal-title').textContent = "Aujourd'hui";
  if (!today.length) {
    list.append(el('li', 'cal-empty', 'Pas de cours aujourd’hui'));
  }
  for (const c of today) {
    const li = el('li', 'cal-item');
    li.style.setProperty('--c', colorFor(c.name));
    const bar = el('span', 'cal-bar');
    const main = el('div', 'cal-main');
    main.append(el('div', 'cal-name', c.name));
    main.append(el('div', 'cal-meta', `${hm(c.start)} – ${hm(c.end)}${c.room ? ' · ' + c.room : ''}`));
    const prog = el('div', 'cal-progress'); const fill = el('i'); prog.append(fill);
    main.append(prog);
    li.append(bar, main);
    list.append(li);
    calRefs.push({ c, li, prog, fill });
  }
  tickSchedule(hk);
}

function tickSchedule(hk) {
  const nowMin = hk.h * 60 + hk.mi + hk.s / 60;
  const today = timetable[hk.dow] || [];
  let currentEl = null;
  for (const r of calRefs) {
    const isNow = nowMin >= r.c.start && nowMin < r.c.end;
    const past = nowMin >= r.c.end;
    r.li.classList.toggle('now', isNow);
    r.li.classList.toggle('past', past);
    r.prog.hidden = !isNow;
    if (isNow) {
      r.fill.style.width = `${((nowMin - r.c.start) / (r.c.end - r.c.start) * 100).toFixed(2)}%`;
      currentEl = r.li;
    }
  }
  const cur = today.find((c) => nowMin >= c.start && nowMin < c.end);
  const next = today.find((c) => c.start > nowMin);
  const line = $('next-line');
  line.textContent = '';
  if (next) {
    line.append('Prochain : ', el('b', null, next.name), ` dans ${durationFr(Math.floor(next.start - nowMin))}`);
  } else if (cur) {
    line.append('Dernier cours · fin dans ', el('b', null, durationFr(Math.ceil(cur.end - nowMin))));
  } else if (today.length) {
    line.textContent = 'Plus de cours aujourd’hui';
  }
  // garde le cours en cours visible
  if (currentEl && currentEl.dataset.scrolled !== hk.key) {
    currentEl.dataset.scrolled = hk.key;
    currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function openTimetableSheet() {
  const body = el('div');
  const ta = el('textarea', 'tt');
  ta.value = ttText; ta.spellcheck = false; ta.autocapitalize = 'off'; ta.setAttribute('autocorrect', 'off');
  const foot = el('p', 'foot');
  foot.innerHTML = 'Un titre de jour (<code>Lundi</code>, <code>Mar</code>, <code>Lun, Jeu</code>…) puis une ligne par cours : <code>08:00-08:55 Maths @ B204</code>. Les lignes qui commencent par <code>#</code> sont ignorées.';
  foot.style.marginTop = '8px';
  const err = el('p', 'foot'); err.style.color = 'var(--red)';
  const reset = el('button', 'danger-btn', 'Remettre l’exemple');
  reset.addEventListener('click', () => { ta.value = DEFAULT_TT; });
  body.append(ta, foot, err, reset);
  openSheet('Emploi du temps', body, () => {
    const parsed = parseTimetable(ta.value);
    if (parsed.errors.length) {
      err.textContent = `Ligne${parsed.errors.length > 1 ? 's' : ''} non comprise${parsed.errors.length > 1 ? 's' : ''} : ${parsed.errors.slice(0, 8).join(', ')}`;
      return false;   // garde la feuille ouverte
    }
    ttText = ta.value; timetable = parsed.days;
    store.set('timetable', ttText);
    renderSchedule(zoned(HK));
  });
}
$('tt-edit').addEventListener('click', openTimetableSheet);

/* ════════════════════ Devoirs ════════════════════ */
let manual = store.get('manual', []);        // devoirs ajoutés à la main
let doneMap = store.get('done', {});         // id → date à laquelle on l'a coché
let remote = store.get('remote', null);      // dernière réponse de /api/devoirs
let syncState = { busy: false, error: null, code: null };
let apiKey = store.get('apiKey', '');

// Nettoyage : oublie les coches de plus de 60 jours
(() => {
  const limit = Date.now() - 60 * 864e5;
  for (const [id, t] of Object.entries(doneMap)) if (t < limit) delete doneMap[id];
  manual = manual.filter((m) => !(doneMap[m.id] && doneMap[m.id] < Date.now() - 14 * 864e5));
  store.set('done', doneMap); store.set('manual', manual);
})();

function dueInfo(item, hk) {
  if (!item.due) return { sort: Infinity, badge: null };
  let dayNum, ms;
  if (/^\d{4}-\d{2}-\d{2}$/.test(item.due)) {
    const [y, m, d] = item.due.split('-').map(Number);
    dayNum = Date.UTC(y, m - 1, d) / 864e5;
    ms = null;
  } else {
    const dt = new Date(item.due);
    if (isNaN(dt)) return { sort: Infinity, badge: null };
    ms = dt.getTime();
    dayNum = zoned(HK, dt).day;
  }
  const diff = dayNum - hk.day;
  const late = ms != null ? ms < Date.now() : diff < 0;
  let badge;
  if (late) badge = ['late', 'En retard'];
  else if (diff === 0) badge = ['today', 'Aujourd’hui'];
  else if (diff === 1) badge = ['tomorrow', 'Demain'];
  else badge = ['later', frShort.format(new Date(dayNum * 864e5)).replace(/\.$/, '')];
  return { sort: ms ?? (dayNum * 864e5 + 86399e3 - 8 * 36e5), badge };
}

function allHomework() {
  const list = [];
  for (const r of (remote && remote.devoirs) || []) list.push({ ...r, manual: false });
  for (const m of manual) list.push({ ...m, manual: true });
  return list.filter((h) => !doneMap[h.id]);
}

function renderHomework() {
  const hk = zoned(HK);
  const ul = $('hw-list');
  ul.textContent = '';
  const items = allHomework().map((h) => ({ h, info: dueInfo(h, hk) })).sort((a, b) => a.info.sort - b.info.sort);
  $('hw-count').textContent = items.length ? String(items.length) : '';
  if (!items.length) ul.append(el('li', 'rem-empty', !remote && syncState.busy ? 'Chargement…' : 'Aucun devoir à rendre'));
  for (const { h, info } of items) {
    const li = el('li', 'rem-item');
    li.style.setProperty('--c', colorFor((h.subject || '').split(' · ')[0]));
    const check = el('button', 'rem-check');
    check.setAttribute('aria-label', 'Marquer comme fait');
    check.innerHTML = '<svg><use href="#i-check"/></svg>';
    check.addEventListener('click', () => completeHomework(h, li));
    const body = el('div', 'rem-body');
    body.append(el('div', 'rem-title', h.title));
    if (h.url) {
      body.classList.add('has-link');
      body.addEventListener('click', () => window.open(h.url, '_blank', 'noopener'));
    }
    const sub = el('div', 'rem-sub');
    if (info.badge) sub.append(el('span', 'badge ' + info.badge[0], info.badge[1]));
    if (h.subject) sub.append(el('span', 'rem-subject', h.subject));
    body.append(sub);
    li.append(check, body);
    ul.append(li);
  }
  renderSync();
}

let toastTimer = null, lastDone = null;
function completeHomework(h, li) {
  if (li.classList.contains('done')) return;
  li.classList.add('done');
  doneMap[h.id] = Date.now();
  store.set('done', doneMap);
  lastDone = h.id;
  setTimeout(() => {
    li.classList.add('leaving');
    setTimeout(renderHomework, 480);
  }, 650);
  showToast('Devoir terminé');
}
function showToast(text) {
  $('toast-text').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4000);
}
$('toast-undo').addEventListener('click', () => {
  if (lastDone) { delete doneMap[lastDone]; store.set('done', doneMap); lastDone = null; renderHomework(); }
  $('toast').classList.remove('show');
});

function agoFr(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

function renderSync() {
  const line = $('sync-line');
  const src = (remote && remote.sourceLabel) || 'Blubee';
  line.classList.toggle('busy', syncState.busy);
  line.classList.toggle('err', !!syncState.error);
  let text;
  if (syncState.busy) text = 'Synchronisation…';
  else if (syncState.code === 'not_configured') text = 'Source non configurée · voir le README';
  else if (syncState.code === 'unauthorized') text = 'Clé d’accès requise · touche ⚙︎';
  else if (syncState.error) text = `${syncState.error}${remote ? ' · liste d’' + agoFr(remote.fetchedAt).replace('il y a ', 'il y a ') : ''}`;
  else if (remote) text = `${src} · mis à jour ${agoFr(remote.fetchedAt)}`;
  else text = 'Pas encore synchronisé';
  $('sync-text').textContent = text;
}

async function syncHomework() {
  if (syncState.busy) return;
  syncState = { busy: true, error: null, code: null };
  renderSync();
  try {
    const headers = apiKey ? { 'x-dashboard-key': apiKey } : {};
    const r = await fetch('/api/devoirs', { headers, cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.message || `Erreur ${r.status}`);
      e.code = j.error;
      throw e;
    }
    remote = { fetchedAt: Date.now(), source: j.source, sourceLabel: j.sourceLabel, devoirs: Array.isArray(j.devoirs) ? j.devoirs : [] };
    store.set('remote', remote);
    syncState = { busy: false, error: null, code: null };
  } catch (e) {
    syncState = {
      busy: false,
      code: e.code || null,
      error: !navigator.onLine ? 'Hors ligne' : (e.message || 'Source injoignable'),
    };
  }
  renderHomework();
}
$('sync-line').addEventListener('click', syncHomework);

function openAddSheet() {
  const body = el('div');
  const g = el('div', 'group');
  const r1 = el('div', 'row');
  const title = el('input', 'left'); title.placeholder = 'Titre'; title.autocapitalize = 'sentences'; r1.append(title);
  const r2 = el('div', 'row');
  const subj = el('input', 'left'); subj.placeholder = 'Matière'; subj.autocapitalize = 'words';
  const dl = el('datalist'); dl.id = 'subjects';
  const known = new Set();
  Object.values(timetable).flat().forEach((c) => known.add(c.name));
  allHomework().forEach((h) => h.subject && known.add(h.subject));
  for (const k of known) { const o = el('option'); o.value = k; dl.append(o); }
  subj.setAttribute('list', 'subjects');
  r2.append(subj, dl);
  const r3 = el('div', 'row'); r3.append(el('label', null, 'Pour le'));
  const date = el('input'); date.type = 'date';
  const tm = zoned(HK, new Date(Date.now() + 864e5)); date.value = tm.key;
  r3.append(date);
  g.append(r1, r2, r3);
  body.append(g, el('p', 'foot', 'Les devoirs ajoutés ici restent sur cet iPhone, en plus de ceux récupérés automatiquement.'));
  openSheet('Nouveau devoir', body, () => {
    const t = title.value.trim();
    if (!t) { title.focus(); return false; }
    manual.push({ id: 'm-' + Date.now().toString(36), title: t, subject: subj.value.trim(), due: date.value || null });
    store.set('manual', manual);
    renderHomework();
  }, 'Ajouter');
  setTimeout(() => title.focus(), 450);
}
$('hw-add').addEventListener('click', openAddSheet);

function openSettingsSheet() {
  const body = el('div');
  const g = el('div', 'group');
  const r1 = el('div', 'row'); r1.append(el('label', null, 'Clé d’accès'));
  const key = el('input'); key.type = 'password'; key.value = apiKey; key.placeholder = 'facultative'; key.autocapitalize = 'off';
  r1.append(key);
  g.append(r1);
  const foot = el('p', 'foot');
  foot.innerHTML = 'Si tu as défini <code>DASHBOARD_KEY</code> sur Vercel, saisis la même valeur ici. Elle reste sur cet iPhone.';
  const refresh = el('button', 'danger-btn', 'Rafraîchir maintenant');
  refresh.style.color = 'var(--label)'; refresh.style.marginBottom = '10px';
  refresh.addEventListener('click', () => { apiKey = key.value.trim(); store.set('apiKey', apiKey); closeSheet(); syncHomework(); });
  const g2 = el('div', 'group');
  const done = Object.keys(doneMap).length;
  const r2 = el('div', 'row'); r2.append(el('span', 'lbl', 'Devoirs cochés'), el('span', 'lbl', String(done)));
  r2.lastChild.style.cssText = 'margin-left:auto;color:var(--gray)';
  g2.append(r2);
  const clear = el('button', 'danger-btn', 'Réafficher les devoirs cochés');
  clear.addEventListener('click', () => { doneMap = {}; store.set('done', doneMap); closeSheet(); renderHomework(); });
  body.append(g, foot, refresh, g2, clear);
  openSheet('Devoirs', body, () => {
    apiKey = key.value.trim(); store.set('apiKey', apiKey); syncHomework();
  });
}
$('hw-settings').addEventListener('click', openSettingsSheet);

/* ════════════════════ Feuilles iOS ════════════════════ */
let sheetOpen = false, sheetOk = null;
function openSheet(title, bodyNode, onOk, okLabel = 'OK') {
  $('sheet-title').textContent = title;
  $('sheet-ok').textContent = okLabel;
  const b = $('sheet-body'); b.textContent = ''; b.append(bodyNode); b.scrollTop = 0;
  sheetOk = onOk;
  sheetOpen = true;
  document.body.classList.remove('night');
  $('sheet').style.transform = '';
  requestAnimationFrame(() => { $('sheet').classList.add('open'); $('sheet-backdrop').classList.add('open'); });
}
function closeSheet() {
  sheetOpen = false;
  if (document.activeElement) document.activeElement.blur();
  $('sheet').style.transform = '';
  $('sheet').classList.remove('open', 'dragging');
  $('sheet-backdrop').classList.remove('open');
}
$('sheet-cancel').addEventListener('click', closeSheet);
$('sheet-backdrop').addEventListener('click', closeSheet);
$('sheet-ok').addEventListener('click', () => { if (sheetOk && sheetOk() === false) return; closeSheet(); });

// Glisser vers le bas pour fermer (depuis la barre grise ou l'en-tête)
(() => {
  const sheet = $('sheet');
  let startY = null, dy = 0;
  const down = (e) => {
    if (e.target.closest('button')) return;
    startY = e.clientY; dy = 0; sheet.classList.add('dragging');
    sheet.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (startY == null) return;
    dy = e.clientY - startY;
    const d = dy > 0 ? dy : dy / 6;                 // résistance vers le haut
    sheet.style.transform = `translate(-50%, ${d}px)`;
  };
  const up = () => {
    if (startY == null) return;
    startY = null; sheet.classList.remove('dragging');
    if (dy > 90) closeSheet(); else sheet.style.transform = '';
  };
  for (const node of [sheet.querySelector('.grabber'), sheet.querySelector('.sheet-head')]) {
    node.addEventListener('pointerdown', down);
  }
  sheet.addEventListener('pointermove', move);
  sheet.addEventListener('pointerup', up);
  sheet.addEventListener('pointercancel', up);
})();

/* ════════════════════ Boucle principale ════════════════════ */
function tick() {
  const now = new Date();
  const { hk, minuteChanged } = renderClocks(now);
  if (minuteChanged) {
    renderSchedule(hk);
    renderAlarm();
    renderSync();
    if (hk.min === 0) renderHomework();             // les badges changent à minuit
  } else {
    tickSchedule(hk);
  }
  applyNight(hk);
  checkAlarm(hk);
}

function scheduleTick() {
  tick();
  setTimeout(scheduleTick, 1000 - (Date.now() % 1000) + 5);   // aligné sur la seconde
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake();
    renderArm();
    tick();
    if (!remote || Date.now() - remote.fetchedAt > SYNC_EVERY) syncHomework();
  }
});
window.addEventListener('online', syncHomework);
document.addEventListener('pointerdown', keepAwake, { passive: true });
document.addEventListener('gesturestart', (e) => e.preventDefault());   // pas de zoom

renderAlarm();
renderArm();
renderHomework();
scheduleTick();
keepAwake();
shiftPixels();
setInterval(shiftPixels, SHIFT_EVERY);
setInterval(keepAwake, 60 * 1000);
setInterval(renderArm, 30 * 1000);
syncHomework();
setInterval(syncHomework, SYNC_EVERY);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
