// Pablo-päiväkirja – frontend
const $ = id => document.getElementById(id);

const TYPE_INFO = {
  pissa: { emoji: '💛', label: 'Pissa' },
  kakka: { emoji: '💩', label: 'Kakka' },
  ruoka: { emoji: '🍖', label: 'Ruoka' },
  leikki: { emoji: '🎾', label: 'Leikki' },
  tyhja: { emoji: '🐾', label: 'Tyhjä reissu' },
};

let config = null;
let status = null;
let dayOffset = 0; // 0 = tänään, -1 = eilen…
let pendingType = null;
let pendingAt = null; // ISO-aika jälkikäteen kirjattaessa, null = nyt

// ---------- apurit ----------

async function api(path, opts) {
  const res = await fetch(`./api/${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

function dayStr(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
}

function fmtDur(min) {
  min = Math.round(min);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---------- ennuste ----------

function renderPrediction() {
  if (!status) return;
  const el = $('prediction');
  const p = status.prediction;
  const now = new Date();
  const next = new Date(p.nextPissaAt);
  const minLeft = (next - now) / 60000;

  el.classList.remove('due', 'soon');
  let title, pct;
  if (!p.lastPissa) {
    title = 'Ei vielä kirjauksia – vie Pablo ulos ja kirjaa 💛';
    pct = 100;
    el.classList.add('soon');
  } else if (minLeft <= 0) {
    title = '🚨 Vie Pablo ulos nyt!';
    pct = 100;
    el.classList.add('due');
  } else if (minLeft <= 15) {
    title = `Pissatauko pian – ${fmtDur(minLeft)}`;
    pct = 100 - (minLeft / p.pissaIntervalMin) * 100;
    el.classList.add('soon');
  } else {
    title = `Seuraava pissatauko ~ ${fmtDur(minLeft)}`;
    pct = Math.max(4, 100 - (minLeft / p.pissaIntervalMin) * 100);
  }

  $('pred-title').textContent = title;
  $('pred-bar').style.width = `${Math.min(100, Math.max(0, pct))}%`;

  // Detaljirivi: vain se mikä on juuri nyt olennaista
  const parts = [];
  if (p.lastPissa) {
    const sinceMin = (now - new Date(p.lastPissa)) / 60000;
    parts.push(`Edellisestä pissasta ${fmtDur(sinceMin)}`);
  }
  const reasons = {
    ruoka: 'aikaistettu ruokailun takia',
    leikki: 'aikaistettu leikin takia',
    tyhja: 'siirretty tyhjän reissun takia',
  };
  if (reasons[p.nextPissaReason]) parts.push(reasons[p.nextPissaReason]);
  if (p.nextKakkaAt) {
    const kMin = (new Date(p.nextKakkaAt) - now) / 60000;
    if (kMin <= 0) parts.push('💩 kakkakin voi tulla');
    else if (kMin <= 60) parts.push(`💩 kakka ~ ${fmtDur(kMin)}`);
  }
  $('pred-detail').textContent = parts.join(' · ');

  // Treenitila: kuiva putki tai vahinkokiristys
  const ts = $('train-state');
  if (p.accidentTightened) {
    ts.textContent = '⚠️ Välit kiristetty sisävahinkojen takia';
    ts.className = 'train-state warn';
  } else if (p.dryStreak >= 1) {
    ts.textContent = `✅ ${p.dryStreak} kuivaa päivää putkeen`
      + (p.dryStreak >= 3 ? ' 🎉' : '')
      + (p.safetyFactor > 1 ? ' · välejä venytetty' : '');
    ts.className = 'train-state good';
  } else {
    ts.className = 'train-state hidden';
  }
}

// ---------- päivän tapahtumat ----------

async function loadDay() {
  const day = dayStr(dayOffset);
  const list = await api(`events?day=${day}`);
  const label = dayOffset === 0 ? 'Tänään'
    : dayOffset === -1 ? 'Eilen'
    : new Date(day).toLocaleDateString('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric' });
  $('day-label').textContent = label;
  $('next-day').disabled = dayOffset >= 0;

  const counts = { pissa: 0, kakka: 0, ruoka: 0, leikki: 0, tyhja: 0 };
  list.forEach(e => counts[e.type]++);
  $('day-summary').innerHTML = Object.entries(counts).map(([t, n]) =>
    `<span class="chip${n === 0 ? ' zero' : ''}">${TYPE_INFO[t].emoji} <span class="n">${n}</span></span>`).join('');

  const ul = $('timeline');
  ul.innerHTML = '';
  if (!list.length) {
    ul.innerHTML = '<li class="empty">Ei tapahtumia 🐾</li>';
    return;
  }
  for (const e of list) {
    const li = document.createElement('li');
    const info = TYPE_INFO[e.type];
    li.innerHTML = `
      <span class="emoji">${info.emoji}</span>
      <span class="time">${fmtTime(e.at)}</span>
      <span class="label">${info.label}</span>
      ${e.location ? `<span class="loc-tag ${e.location}">${e.location === 'ulkona' ? '🌳 ulkona' : '🏠 sisällä'}</span>` : ''}
      <button class="del" title="Poista">✕</button>`;
    li.querySelector('.del').onclick = async () => {
      if (!confirm(`Poistetaanko ${info.label.toLowerCase()} klo ${fmtTime(e.at)}?`)) return;
      await api(`events/${e.id}`, { method: 'DELETE' });
      toast('Poistettu');
      refresh();
    };
    ul.appendChild(li);
  }
}

// ---------- tilastot ----------

async function loadStats() {
  const s = await api('stats');
  const el = $('stats');
  const dayKeys = Object.keys(s.days).sort().reverse();
  if (!dayKeys.length) {
    el.innerHTML = '<div class="empty">Tilastot kertyvät kirjauksista 🐾</div>';
    return;
  }
  const dayNote = s.completeDays
    ? ` (${s.completeDays} täyttä pv)`
    : '';
  el.innerHTML = `
    <div class="stat-row"><span>🌳 Ulkona onnistuneet</span><b>${s.successRate === null ? '–' : s.successRate + ' %'}</b></div>
    <div class="stat-row"><span>💛 Pissoja / pv${dayNote}</span><b>${s.avgPissa ?? '–'}</b></div>
    <div class="stat-row"><span>💩 Kakkoja / pv${dayNote}</span><b>${s.avgKakka ?? '–'}</b></div>
    <div class="stat-row"><span>Kirjauksia yhteensä (7 pv)</span><b>${s.totalPotty}</b></div>
    ${s.completeDays ? '' : '<div class="empty">Keskiarvot lasketaan ensimmäisen täyden seurantapäivän jälkeen</div>'}`;
  renderTodChart();
}

// Opitut vuorokaudenaikavälit pieninä palkkeina (yksi mittari, sama sävy)
function renderTodChart() {
  const el = $('tod-chart');
  const tod = status && status.prediction && status.prediction.todLearned;
  if (!tod) { el.innerHTML = ''; return; }
  const rows = [
    ['Aamun eka', tod.firstMorning],
    ['Päivä', tod.day],
    ['Ilta', tod.evening],
  ].filter(([, v]) => v != null);
  if (!rows.length) { el.innerHTML = ''; return; }
  const max = Math.max(...rows.map(([, v]) => v));
  el.innerHTML = '<div class="tc-title">Opitut pissavälit</div>' + rows.map(([label, v]) => `
    <div class="tod-row" title="${label}: ${fmtDur(v)}">
      <span class="tl">${label}</span>
      <div><div class="tod-bar" style="width:${Math.round(v / max * 100)}%"></div></div>
      <span class="tv">${fmtDur(v)}</span>
    </div>`).join('');
}

// ---------- kirjaaminen ----------

function openLocSheet(type) {
  pendingType = type;
  $('loc-title').textContent = `${TYPE_INFO[type].emoji} Missä ${TYPE_INFO[type].label.toLowerCase()} tuli?`;
  $('loc-sheet').classList.remove('hidden');
}

async function logEvent(type, location, at) {
  await api('events', { method: 'POST', body: JSON.stringify({ type, location, at: at || undefined }) });
  const info = TYPE_INFO[type];
  toast(at ? `${info.emoji} ${info.label} kirjattu (klo ${fmtTime(at)})` : `${info.emoji} ${info.label} kirjattu!`);
  if (navigator.vibrate) navigator.vibrate(30);
  refresh();
}

document.querySelectorAll('.log-btn').forEach(btn => {
  btn.onclick = () => {
    const type = btn.dataset.type;
    pendingAt = null;
    if (type === 'pissa' || type === 'kakka') openLocSheet(type);
    else logEvent(type);
  };
});
$('loc-ulkona').onclick = () => { $('loc-sheet').classList.add('hidden'); logEvent(pendingType, 'ulkona', pendingAt); };
$('loc-sisalla').onclick = () => { $('loc-sheet').classList.add('hidden'); logEvent(pendingType, 'sisalla', pendingAt); };
$('loc-cancel').onclick = () => $('loc-sheet').classList.add('hidden');
$('loc-sheet').onclick = e => { if (e.target === $('loc-sheet')) $('loc-sheet').classList.add('hidden'); };

// Jälkikäteen kirjaus
$('late-btn').onclick = () => {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  $('late-time').value = `${p(now.getHours())}:${p(now.getMinutes())}`;
  $('late-sheet').classList.remove('hidden');
};
$('late-cancel').onclick = () => $('late-sheet').classList.add('hidden');
$('late-sheet').onclick = e => { if (e.target === $('late-sheet')) $('late-sheet').classList.add('hidden'); };

function lateTimestamp() {
  const [h, m] = ($('late-time').value || '00:00').split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d > new Date()) d.setDate(d.getDate() - 1); // tulevaisuuden aika = eilen
  return d.toISOString();
}

document.querySelectorAll('.late-types button').forEach(btn => {
  btn.onclick = () => {
    const type = btn.dataset.type;
    const at = lateTimestamp();
    $('late-sheet').classList.add('hidden');
    if (type === 'pissa' || type === 'kakka') {
      pendingAt = at;
      openLocSheet(type);
    } else {
      logEvent(type, null, at);
    }
  };
});

$('prev-day').onclick = () => { dayOffset--; loadDay(); };
$('next-day').onclick = () => { if (dayOffset < 0) { dayOffset++; loadDay(); } };

// ---------- push-ilmoitukset ----------

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function updateBell() {
  const bell = $('bell');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    bell.style.display = 'none';
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  bell.classList.toggle('on', !!sub);
  bell.title = sub ? 'Ilmoitukset käytössä' : 'Salli ilmoitukset';
}

$('bell').onclick = async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  // iPhonella push toimii vain kotivalikkoon lisätyssä sovelluksessa
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const isIOS = /iPhone|iPad/.test(navigator.userAgent);
  if (isIOS && !standalone) {
    alert('Lisää sovellus ensin kotivalikkoon:\n\nJaa-nappi (neliö + nuoli) → "Lisää Koti-valikkoon".\n\nAvaa sitten sovellus kotivalikosta ja paina kelloa uudestaan. 🐶');
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    if (confirm('Ilmoitukset ovat päällä tällä laitteella. Poistetaanko käytöstä?')) {
      await api('unsubscribe', { method: 'POST', body: JSON.stringify({ subscription: existing.toJSON() }) });
      await existing.unsubscribe();
      toast('Ilmoitukset pois päältä');
      updateBell();
    }
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Ilmoituslupa evätty'); return; }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
  });
  await api('subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
  toast('Ilmoitukset käytössä! 🔔');
  updateBell();
};

// ---------- ikä ----------

function renderAge() {
  if (!config) return;
  const born = new Date(config.birthday + 'T00:00:00');
  const days = Math.floor((Date.now() - born) / 86400000);
  const weeks = Math.floor(days / 7);
  $('age').textContent = `MAS-pentu · ${weeks} vk ${days % 7} pv`;
}

// ---------- päivitys ----------

async function refresh() {
  try {
    status = await api('status');
    renderPrediction();
    await loadDay();
    await loadStats();
  } catch (e) {
    console.log('refresh error', e);
  }
}

async function init() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch (e) { console.log('sw', e); }
  }
  config = await api('config');
  renderAge();
  await refresh();
  updateBell();
  setInterval(() => { renderPrediction(); }, 30000);
  setInterval(refresh, 5 * 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

init();
