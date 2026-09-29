// Pablo-päiväkirja – backend
// Cloud Run + Firestore + Web Push. Kaikki reitit salaisen polun takana.

const express = require('express');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const webpush = require('web-push');

const TOKEN = process.env.APP_TOKEN || 'dev-token';
const PORT = process.env.PORT || 8080;
const BIRTHDAY = '2026-04-28';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:jasmin.jutila@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const db = new Firestore();
const events = db.collection('pablo_events');
const subs = db.collection('pablo_subs');
const meta = db.collection('pablo_meta');

const app = express();
app.use(express.json());

const VALID_TYPES = ['pissa', 'kakka', 'ruoka', 'leikki', 'tyhja'];
const QUIET_START_H = 0, QUIET_START_M = 0; // 00:00
const QUIET_END_H = 8, QUIET_END_M = 0;     // 08:00
// Yöunien ympäristö (myös 05:30 pissareissu): näitä välejä ei käytetä oppimiseen
const NIGHT_LEARN_START = 23, NIGHT_LEARN_END = 8;
const NOTIFY_COOLDOWN_MIN = 45;  // ensimmäinen hälytys, tai hälytys viimeisimmän reissukirjauksen jälkeen
const REPEAT_NOTIFY_MIN = 15;    // uusintahälytys kunnes pissa/kakka/tyhjä reissu kirjataan

// ---------- apufunktiot (TZ=Europe/Helsinki asetettu kontissa) ----------

function ageWeeks(now = new Date()) {
  return Math.floor((now - new Date(BIRTHDAY + 'T00:00:00')) / (7 * 24 * 3600 * 1000));
}

function dayBounds(dayStr) {
  const start = new Date(dayStr + 'T00:00:00');
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end };
}

function todayStr(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isQuietHours(now = new Date()) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = QUIET_START_H * 60 + QUIET_START_M;
  const end = QUIET_END_H * 60 + QUIET_END_M;
  return start <= end ? (mins >= start && mins < end) : (mins >= start || mins < end);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Vuorokaudenaikaikkunat: väli opitaan suoraan kirjatusta historiasta per ikkuna.
// Ikkuna valitaan EDELLISEN pissan kellonajan mukaan (sen jälkeinen väli riippuu siitä).
// Analyysi 22 täydestä päivästä (8/2026): aamun eka 170 min, päivä 111 min, ilta 89 min.
// Fallback-kertoimet käytössä kunnes ikkunassa on tarpeeksi omaa dataa.
const TOD_FALLBACK_FACTOR = { firstMorning: 1.55, day: 1.0, evening: 0.8, other: 1.0 };
const TOD_MIN_SAMPLES = { firstMorning: 4, day: 8, evening: 8 };
// Varmuusmarginaali: hälytys ~15 % ennen opittua mediaania (sisävahinkoja ~12 %, nousussa 8/2026).
// Kuivat päivät venyttävät marginaalia takaisin: +4 %-yks / vahingoton päivä, max 1.05
// (eli viiden kuivan päivän jälkeen hälytys tulee vasta ~5 % mediaanin JÄLKEEN → välit
// pitenevät hallitusti kun treeni etenee; ensimmäinen sisävahinko palauttaa 0.85:een).
const PISSA_SAFETY_FACTOR = 0.85;
const DRY_DAY_STRETCH = 0.04;
const SAFETY_FACTOR_MAX = 1.05;

// Peräkkäiset vahingottomat päivät (eiliseen asti, max 7; vain kirjatut päivät lasketaan)
function dryStreakDays(recent, now) {
  let streak = 0;
  for (let i = 1; i <= 7; i++) {
    const day = todayStr(new Date(now.getTime() - i * 24 * 3600 * 1000));
    const dayEvents = recent.filter(e => todayStr(e.at) === day);
    if (!dayEvents.length) break;
    const hadAccident = dayEvents.some(e =>
      (e.type === 'pissa' || e.type === 'kakka') && e.location === 'sisalla');
    if (hadAccident) break;
    streak++;
  }
  return streak;
}

// Aamun ensimmäinen pissa = päivän ensimmäinen klo 5 jälkeen, ennen puoltapäivää
function isFirstMorningPissa(pissat, ref) {
  if (!ref) return false;
  const h = ref.at.getHours();
  if (h < 5 || h >= 12) return false;
  return !pissat.some(e =>
    e.at < ref.at &&
    todayStr(e.at) === todayStr(ref.at) &&
    e.at.getHours() >= 5);
}

function todWindow(pissat, ref) {
  if (!ref) return 'day';
  if (isFirstMorningPissa(pissat, ref)) return 'firstMorning';
  const h = ref.at.getHours();
  if (h >= 17 && h < 22) return 'evening';
  if (h >= 8 && h < 17) return 'day';
  return 'other';
}

// Oppii mediaanivälin per vuorokaudenaikaikkuna kirjatuista pissoista
function learnedTodIntervals(pissat) {
  const buckets = { firstMorning: [], day: [], evening: [] };
  for (let i = 1; i < pissat.length; i++) {
    const prev = pissat[i - 1];
    const gap = (pissat[i].at - prev.at) / 60000;
    if (gap < 15 || gap > 360) continue;
    const w = todWindow(pissat, prev);
    if (buckets[w]) buckets[w].push(gap);
  }
  const out = {};
  for (const w of Object.keys(buckets)) {
    out[w] = buckets[w].length >= TOD_MIN_SAMPLES[w] ? Math.round(median(buckets[w])) : null;
  }
  return out;
}

// Ikäpohjainen oletusväli pissojen välillä (minuutteja, valveilla)
function basePissaInterval(weeks) {
  if (weeks < 12) return 90;
  if (weeks < 16) return 120;
  if (weeks < 24) return 150;
  return 210;
}

function baseKakkaInterval(weeks) {
  if (weeks < 12) return 240;
  if (weeks < 16) return 300;
  return 360;
}

// Laskee opitun mediaanivälin tapahtumille (vain päiväaikaiset välit)
function learnedInterval(list, minGapMin, maxGapMin) {
  const gaps = [];
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1].at, cur = list[i].at;
    if (prev.getHours() >= NIGHT_LEARN_START || prev.getHours() < NIGHT_LEARN_END) continue;
    const gap = (cur - prev) / 60000;
    if (gap >= minGapMin && gap <= maxGapMin) gaps.push(gap);
  }
  return gaps.length >= 5 ? median(gaps) : null;
}

// Ennustealgoritmi: milloin Pablo pitää viedä ulos seuraavaksi
function computePrediction(recent, now = new Date()) {
  const weeks = ageWeeks(now);
  const byType = t => recent.filter(e => e.type === t).sort((a, b) => a.at - b.at);
  const pissat = byType('pissa'), kakat = byType('kakka');
  const ruoat = byType('ruoka'), leikit = byType('leikki');
  const tyhjat = byType('tyhja');
  const last = list => (list.length ? list[list.length - 1] : null);

  const lastPissa = last(pissat), lastKakka = last(kakat);
  const lastRuoka = last(ruoat), lastLeikki = last(leikit);
  const lastTyhja = last(tyhjat);

  // Vuorokaudenaika: käytä ikkunan omaa opittua mediaania jos dataa riittää,
  // muuten yleinen opittu/ikäpohjainen väli × fallback-kerroin
  const todIvals = learnedTodIntervals(pissat);
  const win = todWindow(pissat, lastPissa);
  let pissaInterval;
  if (win !== 'other' && todIvals[win] != null) {
    pissaInterval = clamp(todIvals[win], 35, 300);
  } else {
    const base = clamp(learnedInterval(pissat, 20, 300) ?? basePissaInterval(weeks), 45, 240);
    pissaInterval = clamp(Math.round(base * TOD_FALLBACK_FACTOR[win]), 35, 300);
  }
  const dryStreak = dryStreakDays(recent, now);
  const safetyFactor = Math.min(PISSA_SAFETY_FACTOR + DRY_DAY_STRETCH * dryStreak, SAFETY_FACTOR_MAX);
  pissaInterval = clamp(Math.round(pissaInterval * safetyFactor), 35, 300);
  let kakkaInterval = clamp(
    learnedInterval(kakat, 60, 720) ?? baseKakkaInterval(weeks), 120, 600);

  // Sisävahingot: vahinkoa edeltänyt väli oli liian pitkä → kiristä ennustetta.
  // Mediaani (ei minimi), jotta yksi poikkeuspäivä ei hallitse; alle 30 min
  // "tuplapissat" (innostus, vieraat hoitajat) eivät kerro pidätyskyvystä;
  // leikin lähellä (60 min ennen – 30 min jälkeen) tapahtunut vahinko on
  // innostuspissa ja jätetään kokonaan huomiotta oppimisessa;
  // vaikutus hälvenee lineaarisesti 48 h kuluessa viimeisimmästä vahingosta.
  const playNearby = at => leikit.some(l => {
    const diffMin = (at - l.at) / 60000;
    return diffMin >= -30 && diffMin <= 60;
  });
  // sameWindow: kiristys koskee vain sitä vuorokaudenaikaikkunaa jossa vahingot
  // ovat sattuneet — illan vahingot eivät kiristä aamun ennustetta.
  const accidentAdjusted = (list, floorMin, baseInterval, sameWindow) => {
    const gaps = [];
    let lastAccident = null;
    for (let i = 1; i < list.length; i++) {
      if (list[i].location !== 'sisalla') continue;
      if (playNearby(list[i].at)) continue;
      if (sameWindow && todWindow(list, list[i - 1]) !== win) continue;
      lastAccident = list[i].at;
      const gap = (list[i].at - list[i - 1].at) / 60000;
      if (gap >= 30) gaps.push(gap);
    }
    if (!gaps.length || !lastAccident) return null;
    const cap = Math.max(floorMin, median(gaps) * 0.85);
    if (cap >= baseInterval) return null;
    const hoursSince = (now - lastAccident) / 3600000;
    const weight = clamp(1 - hoursSince / 48, 0, 1);
    if (weight <= 0) return null; // vaikutus hälvennyt (>48 h) → ei kiristystä eikä lippua
    return Math.round(cap * weight + baseInterval * (1 - weight));
  };
  const pissaAdj = accidentAdjusted(pissat, 45, pissaInterval, true);
  const kakkaAdj = accidentAdjusted(kakat, 120, kakkaInterval, false);
  const pissaTightened = pissaAdj !== null;
  const kakkaTightened = kakkaAdj !== null;
  if (pissaTightened) pissaInterval = pissaAdj;
  if (kakkaTightened) kakkaInterval = kakkaAdj;

  // Pissa-ehdokkaat: perusväli + laukaisijat (ruoka, leikki)
  const cand = [];
  if (lastPissa) cand.push({ at: new Date(lastPissa.at.getTime() + pissaInterval * 60000), reason: 'interval' });
  else cand.push({ at: now, reason: 'no-data' });
  if (lastRuoka && (!lastPissa || lastRuoka.at > lastPissa.at)) {
    cand.push({ at: new Date(lastRuoka.at.getTime() + 20 * 60000), reason: 'ruoka' });
  }
  if (lastLeikki && (!lastPissa || lastLeikki.at > lastPissa.at)) {
    cand.push({ at: new Date(lastLeikki.at.getTime() + 15 * 60000), reason: 'leikki' });
  }
  cand.sort((a, b) => a.at - b.at);
  const nextPissa = cand[0];

  // Tyhjä reissu: ei tarvinnut vielä → siirrä ennustetta ~25 min reissusta eteenpäin
  if (lastTyhja && (!lastPissa || lastTyhja.at > lastPissa.at)) {
    const snooze = new Date(lastTyhja.at.getTime() + 25 * 60000);
    if (snooze > nextPissa.at) {
      nextPissa.at = snooze;
      nextPissa.reason = 'tyhja';
    }
  }

  // Kakka: perusväli + ruokailun jälkeinen refleksi
  const candK = [];
  if (lastKakka) candK.push({ at: new Date(lastKakka.at.getTime() + kakkaInterval * 60000), reason: 'interval' });
  if (lastRuoka && (!lastKakka || lastRuoka.at > lastKakka.at)) {
    candK.push({ at: new Date(lastRuoka.at.getTime() + 30 * 60000), reason: 'ruoka' });
  }
  candK.sort((a, b) => a.at - b.at);
  const nextKakka = candK.length ? candK[0] : null;
  if (nextKakka && lastTyhja && (!lastKakka || lastTyhja.at > lastKakka.at)) {
    const snooze = new Date(lastTyhja.at.getTime() + 25 * 60000);
    if (snooze > nextKakka.at) {
      nextKakka.at = snooze;
      nextKakka.reason = 'tyhja';
    }
  }

  return {
    ageWeeks: weeks,
    pissaIntervalMin: Math.round(pissaInterval),
    kakkaIntervalMin: Math.round(kakkaInterval),
    lastPissa: lastPissa ? lastPissa.at.toISOString() : null,
    lastKakka: lastKakka ? lastKakka.at.toISOString() : null,
    nextPissaAt: nextPissa.at.toISOString(),
    nextPissaReason: nextPissa.reason,
    nextKakkaAt: nextKakka ? nextKakka.at.toISOString() : null,
    nextKakkaReason: nextKakka ? nextKakka.reason : null,
    learnedPissa: learnedInterval(pissat, 20, 300) !== null,
    todWindow: win,
    todLearned: todIvals,
    dryStreak,
    safetyFactor,
    accidentTightened: pissaTightened || kakkaTightened,
  };
}

async function recentEvents(hoursBack = 96, now = new Date()) {
  const since = new Date(now.getTime() - hoursBack * 3600 * 1000);
  const snap = await events.where('at', '>=', since).orderBy('at', 'asc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data(), at: d.data().at.toDate() }));
}

// ---------- API salaisen polun takana ----------

const r = express.Router();

r.get('/api/config', (req, res) => {
  res.json({ vapidPublicKey: VAPID_PUBLIC_KEY, birthday: BIRTHDAY, name: 'Pablo' });
});

r.get('/api/events', async (req, res) => {
  const day = req.query.day || todayStr();
  const { start, end } = dayBounds(day);
  const snap = await events.where('at', '>=', start).where('at', '<', end).orderBy('at', 'desc').get();
  res.json(snap.docs.map(d => {
    const e = d.data();
    return { id: d.id, type: e.type, location: e.location || null, at: e.at.toDate().toISOString() };
  }));
});

r.post('/api/events', async (req, res) => {
  const { type, location, at } = req.body || {};
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'invalid type' });
  const when = at ? new Date(at) : new Date();
  if (isNaN(when)) return res.status(400).json({ error: 'invalid at' });
  const doc = {
    type,
    location: (type === 'pissa' || type === 'kakka') ? (location === 'sisalla' ? 'sisalla' : 'ulkona') : null,
    at: when,
    createdAt: new Date(),
  };
  const ref = await events.add(doc);
  res.json({ id: ref.id, ...doc, at: when.toISOString(), createdAt: undefined });
});

r.delete('/api/events/:id', async (req, res) => {
  await events.doc(req.params.id).delete();
  res.json({ ok: true });
});

r.get('/api/status', async (req, res) => {
  const now = new Date();
  const recent = await recentEvents(14 * 24, now);
  const prediction = computePrediction(recent, now);
  const today = todayStr(now);
  const { start } = dayBounds(today);
  const todays = recent.filter(e => e.at >= start);
  const counts = {};
  for (const t of VALID_TYPES) counts[t] = todays.filter(e => e.type === t).length;
  counts.sisapissat = todays.filter(e => e.type === 'pissa' && e.location === 'sisalla').length;
  counts.sisakakat = todays.filter(e => e.type === 'kakka' && e.location === 'sisalla').length;
  res.json({ now: now.toISOString(), prediction, counts, quietHours: isQuietHours(now) });
});

r.get('/api/stats', async (req, res) => {
  const now = new Date();
  const recent = await recentEvents(7 * 24, now);
  const days = {};
  for (const e of recent) {
    const d = todayStr(e.at);
    days[d] = days[d] || { pissa: 0, kakka: 0, ruoka: 0, leikki: 0, ulkona: 0, sisalla: 0 };
    days[d][e.type]++;
    if (e.location) days[d][e.location]++;
  }
  const potty = recent.filter(e => e.type === 'pissa' || e.type === 'kakka');
  const outdoor = potty.filter(e => e.location === 'ulkona').length;
  // Keskiarvot vain täysistä seurantapäivistä (00–24): ensimmäinen (vajaa)
  // kirjauspäivä ja kuluva päivä eivät kuulu keskiarvoon
  const today = todayStr(now);
  let avgPissa = null, avgKakka = null, completeDays = 0;
  if (recent.length) {
    const fullDayKeys = [];
    const d = new Date(dayBounds(todayStr(recent[0].at)).end);
    while (todayStr(d) < today) {
      fullDayKeys.push(todayStr(d));
      d.setDate(d.getDate() + 1);
    }
    completeDays = fullDayKeys.length;
    if (completeDays) {
      const sum = t => fullDayKeys.reduce((a, k) => a + ((days[k] && days[k][t]) || 0), 0);
      avgPissa = (sum('pissa') / completeDays).toFixed(1);
      avgKakka = (sum('kakka') / completeDays).toFixed(1);
    }
  }
  res.json({
    days,
    successRate: potty.length ? Math.round(100 * outdoor / potty.length) : null,
    totalPotty: potty.length,
    avgPissa,
    avgKakka,
    completeDays,
  });
});

r.post('/api/subscribe', async (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  const id = Buffer.from(sub.endpoint).toString('base64url').slice(-60);
  await subs.doc(id).set({ sub, ua: req.headers['user-agent'] || '', createdAt: new Date() });
  res.json({ ok: true });
});

r.post('/api/unsubscribe', async (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  const id = Buffer.from(sub.endpoint).toString('base64url').slice(-60);
  await subs.doc(id).delete();
  res.json({ ok: true });
});

async function sendToAll(payload) {
  const snap = await subs.get();
  const results = await Promise.allSettled(snap.docs.map(async d => {
    try {
      await webpush.sendNotification(d.data().sub, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await d.ref.delete();
      else throw err;
    }
  }));
  return { sent: results.filter(x => x.status === 'fulfilled').length, total: snap.size };
}

r.post('/api/test-push', async (req, res) => {
  const out = await sendToAll({
    title: 'Pablo-päiväkirja 🐶',
    body: 'Testi-ilmoitus toimii! Pablo kiittää.',
  });
  res.json(out);
});

function minutesAgoText(iso, now) {
  const min = Math.round((now - new Date(iso)) / 60000);
  if (min < 60) return `${min} min sitten`;
  return `${Math.floor(min / 60)} h ${min % 60} min sitten`;
}

// Cloud Scheduler kutsuu tätä 10 min välein
r.post('/api/check-reminders', async (req, res) => {
  const now = new Date();
  if (isQuietHours(now)) return res.json({ skipped: 'quiet-hours' });

  const stateRef = meta.doc('state');
  const state = (await stateRef.get()).data() || {};
  const lastNotified = state.lastNotifiedAt ? state.lastNotifiedAt.toDate() : null;

  const recent = await recentEvents(14 * 24, now);
  // Ei muistutuksia, jos sovellusta ei ole käytetty vuorokauteen
  if (!recent.some(e => (now - e.at) < 24 * 3600 * 1000)) {
    return res.json({ skipped: 'inactive' });
  }

  // Uusintatila: hälytetty, eikä sen jälkeen ole kirjattu pissaa/kakkaa/tyhjää reissua
  // → muistutetaan tiheämmin (REPEAT_NOTIFY_MIN) kunnes jotain kirjataan.
  const pottyEvents = recent.filter(e => ['pissa', 'kakka', 'tyhja'].includes(e.type));
  const lastPotty = pottyEvents.length ? pottyEvents[pottyEvents.length - 1].at : null;
  const repeatMode = !!(lastNotified && (!lastPotty || lastPotty <= lastNotified));
  const cooldownMin = repeatMode ? REPEAT_NOTIFY_MIN : NOTIFY_COOLDOWN_MIN;
  if (lastNotified && (now - lastNotified) < cooldownMin * 60000) {
    return res.json({ skipped: 'cooldown', repeatMode });
  }

  const p = computePrediction(recent, now);

  // Muistutukset vain pissoista – kakkaennuste näkyy sovelluksessa, mutta ei hälytä.
  const pissaDue = new Date(p.nextPissaAt) <= now;
  if (!pissaDue) return res.json({ skipped: 'not-due', prediction: p });

  const reasons = [];
  if (p.nextPissaReason === 'ruoka') reasons.push('ruokailusta on hetki');
  else if (p.nextPissaReason === 'leikki') reasons.push('leikin jälkeen pissattaa');
  else if (p.lastPissa) reasons.push(`edellinen pissa ${minutesAgoText(p.lastPissa, now)}`);
  else reasons.push('päivän ensimmäinen pissa puuttuu');

  const out = await sendToAll({
    title: repeatMode ? '🐶 Muistutus: Pablo pitää yhä viedä ulos!' : '🐶 Pablo pitää viedä ulos!',
    body: reasons.join(' · ') + (repeatMode ? ' · kirjaa reissu niin muistutukset loppuvat' : ''),
    tag: 'pablo-potty',
  });
  await stateRef.set({ lastNotifiedAt: now, lastReason: reasons.join(' · ') }, { merge: true });
  res.json({ notified: true, repeatMode, ...out, prediction: p });
});

// Staattiset tiedostot
r.use(express.static(path.join(__dirname, 'public')));

app.use(`/${TOKEN}`, r);
app.get('/', (req, res) => res.status(404).send('Vuf?'));
app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`Pablo-päiväkirja portissa ${PORT}, polku /${TOKEN}/`));
