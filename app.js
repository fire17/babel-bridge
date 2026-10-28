// Babel Bridge — stage 1. Mic (ru-RU Web Speech) -> chunker -> free MT -> speechSynthesis.
import { Chunker, joinResults } from './chunker.js';
import { translate, PROVIDERS, exhausted } from './translate.js';

const $ = (id) => document.getElementById(id);
const now = () => Date.now();
const UA = navigator.userAgent;
const IS_ANDROID = /Android/i.test(UA);
const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;

// ---------- settings (per-viewer, best effort) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('babel.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('babel.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const settings = {
  voice: store.get('voice', ''),
  rate: store.get('rate', 1),
  skipStale: store.get('skipStale', true),
  psalms: store.get('psalms', true),
  provider: store.get('provider', 'auto'),
  earMode: store.get('earMode', 0),
};

// ---------- state ----------
const state = {
  running: false,
  rec: null,
  recActive: false,
  streamSeq: 0,
  streamId: null,
  restarts: 0,
  lastStart: 0,
  quickFails: 0,
  fatal: null,
  seq: 0,
  items: [],       // chunks in order: { seq, ru, endTime, en, state: translating|ready|speaking|done|skipped|failed, el }
  speaking: null,  // item currently being spoken
  lags: [],
  wakeLock: null,
};
const chunker = new Chunker();
const providerStats = Object.fromEntries(Object.keys(PROVIDERS).map((k) => [k, { ok: 0, fail: 0, ms: 0, last: '' }]));

// ---------- UI helpers ----------
const ui = {
  status(msg, kind = '') { const s = $('status'); s.textContent = msg; s.dataset.kind = kind; },
  chip(id, text, kind = '') { const c = $(id); c.textContent = text; c.dataset.kind = kind; },
  clearPlaceholder(feed) { const p = feed.querySelector('.placeholder'); if (p) p.remove(); },
  trim(feed, max = 60) { while (feed.children.length > max) feed.firstElementChild.remove(); },
  scroll(feed) { feed.scrollTop = feed.scrollHeight; },
};

function makeDots(el, n = 6) { for (let i = 0; i < n; i++) el.appendChild(document.createElement('i')); return [...el.children]; }
const micDots = makeDots($('micDots'));
const earDots = makeDots($('earDots'));
function setDots(dots, level) { // level 0..1
  const lit = Math.round(level * dots.length);
  dots.forEach((d, i) => d.classList.toggle('on', i < lit));
}

// ---------- mic level meter ----------
// Desktop: real level via getUserMedia + AnalyserNode. Android Chrome: opening a second
// mic stream can starve SpeechRecognition, so there we animate on recognition activity.
const meter = { ctx: null, stream: null, analyser: null, buf: null, activity: 0, real: false };
async function startMeter() {
  if (IS_ANDROID || !navigator.mediaDevices?.getUserMedia) return;
  try {
    meter.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    meter.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = meter.ctx.createMediaStreamSource(meter.stream);
    meter.analyser = meter.ctx.createAnalyser();
    meter.analyser.fftSize = 512;
    meter.buf = new Uint8Array(meter.analyser.fftSize);
    src.connect(meter.analyser);
    meter.real = true;
  } catch (e) {
    meter.real = false;
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
  }
}
function stopMeter() {
  meter.stream?.getTracks().forEach((t) => t.stop());
  meter.ctx?.close().catch(() => {});
  Object.assign(meter, { ctx: null, stream: null, analyser: null, real: false });
}
function micLevel() {
  if (meter.real && meter.analyser) {
    meter.analyser.getByteTimeDomainData(meter.buf);
    let sum = 0;
    for (const v of meter.buf) { const x = (v - 128) / 128; sum += x * x; }
    return Math.min(1, Math.sqrt(sum / meter.buf.length) * 6);
  }
  meter.activity *= 0.9;
  return state.recActive ? Math.min(1, meter.activity + Math.random() * 0.12) : 0;
}
let earPhase = 0;
function animateMeters() {
  setDots(micDots, state.running ? micLevel() : 0);
  earPhase += 0.35;
  setDots(earDots, state.speaking ? 0.35 + 0.45 * Math.abs(Math.sin(earPhase)) + Math.random() * 0.2 : 0);
  requestAnimationFrame(animateMeters);
}

// ---------- speech recognition ----------
function recErrorMessage(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone is blocked. Click the lock icon next to the address, allow the microphone, then tap the button again.';
    case 'audio-capture': return 'No microphone found. Plug in a headset with a mic, or check your sound settings.';
    case 'network': return 'Speech service unreachable — check the internet connection. Retrying…';
    case 'no-speech': return 'Listening… (no speech heard yet)';
    case 'language-not-supported': return 'This browser cannot recognise Russian. Please use Microsoft Edge or Google Chrome.';
    default: return 'Speech recognition hiccup (' + code + '). Restarting…';
  }
}

function startRecognition() {
  if (!state.running || state.recActive) return;
  const rec = new SR();
  rec.lang = 'ru-RU';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  const id = 'mic-' + (++state.streamSeq);
  state.rec = rec;
  state.streamId = id;
  state.recActive = true;
  state.lastStart = now();

  rec.onstart = () => {
    ui.chip('chipA', 'Listening', 'live');
    if (!state.fatal) ui.status('Listening for Russian…', 'ok');
  };
  rec.onresult = (ev) => {
    meter.activity = 0.8;
    state.quickFails = 0;
    const { finalText, interimText } = joinResults(ev.results, IS_ANDROID);
    enqueue(chunker.update(id, finalText, interimText, now()));
    renderSource(id);
  };
  rec.onsoundstart = () => { meter.activity = 0.5; };
  rec.onerror = (ev) => {
    if (ev.error === 'aborted') return;
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed' || ev.error === 'audio-capture' || ev.error === 'language-not-supported') {
      state.fatal = ev.error;
      ui.status(recErrorMessage(ev.error), 'err');
      stopBridge(true);
      return;
    }
    if (ev.error !== 'no-speech') state.quickFails++;
    ui.status(recErrorMessage(ev.error), ev.error === 'no-speech' ? '' : 'warn');
  };
  rec.onend = () => {
    if (state.rec === rec) { state.rec = null; state.recActive = false; }
    enqueue(chunker.flush(id, now()));
    renderSource(id, true);
    if (!state.running) return;
    // Chrome ends continuous recognition every so often: restart, backing off on rapid failures.
    const quick = now() - state.lastStart < 1500;
    const delay = quick ? Math.min(3000, 250 * 2 ** Math.min(state.quickFails, 4)) : 100;
    state.restarts++;
    $('restarts').textContent = 'Restarts: ' + state.restarts;
    ui.chip('chipA', 'Reconnecting', 'warn');
    setTimeout(startRecognition, delay);
  };
  try { rec.start(); } catch (e) { state.recActive = false; setTimeout(startRecognition, 500); }
}

// ---------- source (Channel A) rendering ----------
const sourceEls = new Map();
function renderSource(id, done = false) {
  const s = chunker.streams.get(id);
  let el = sourceEls.get(id);
  if (!s && !el) return;
  const feed = $('feedA');
  if (!el) {
    if (!s.words.length) return;
    ui.clearPlaceholder(feed);
    el = document.createElement('p');
    el.append(document.createElement('span'), document.createElement('span'));
    el.lastChild.className = 'interim';
    feed.appendChild(el);
    sourceEls.set(id, el);
    ui.trim(feed);
  }
  if (s) {
    el.firstChild.textContent = s.words.slice(0, s.committed).join(' ') + ' ';
    el.lastChild.textContent = s.words.slice(s.committed).join(' ');
  }
  if (done) { el.lastChild.className = ''; sourceEls.delete(id); }
  ui.scroll(feed);
}

// ---------- translation queue ----------
function enqueue(chunks) {
  for (const c of chunks) {
    if (!c.text.trim()) continue;
    const item = { seq: ++state.seq, ru: c.text, endTime: c.endTime, reason: c.reason, en: '', state: 'translating' };
    item.el = document.createElement('p');
    item.el.className = 'pending';
    item.el.textContent = '…';
    const feed = $('feedB');
    ui.clearPlaceholder(feed);
    feed.appendChild(item.el);
    ui.trim(feed);
    ui.scroll(feed);
    state.items.push(item);
    runTranslation(item);
  }
  updateBacklog();
}

async function runTranslation(item) {
  try {
    const r = await translate(item.ru, {
      order: settings.provider,
      glossary: { psalms: settings.psalms },
      onFail: (k, e) => { providerStats[k].fail++; providerStats[k].last = e.message; renderProviders(); },
    });
    Object.assign(providerStats[r.provider], { ok: providerStats[r.provider].ok + 1, ms: r.ms, last: 'ok' });
    $('providerName').textContent = 'Translate: ' + PROVIDERS[r.provider].name.replace(/ \(.*/, '');
    item.en = r.text;
    item.state = item.state === 'skipped' ? 'skipped' : 'ready';
    item.el.textContent = r.text;
    item.el.className = item.state === 'skipped' ? 'skipped' : '';
    item.el.title = 'via ' + PROVIDERS[r.provider].name + ' · ' + r.ms + ' ms · RU: ' + item.ru;
  } catch (e) {
    item.state = 'failed';
    item.el.className = 'failed';
    item.el.textContent = '[translation unavailable] ' + item.ru;
    ui.status('Translation failed (' + e.message + '). Check the internet connection.', 'warn');
  }
  renderProviders();
  pump();
}

function waiting() { return state.items.filter((i) => i.state === 'translating' || i.state === 'ready'); }
function updateBacklog() { $('backlog').textContent = String(waiting().length); }

// ---------- speech output ----------
let voices = [];
function rankVoice(v) {
  const n = v.name, l = (v.lang || '').replace('_', '-');
  if (!/^en/i.test(l)) return -1;
  let s = 0;
  if (/en-US/i.test(l)) s += 20;
  if (/Online \(Natural\)/i.test(n)) s += 100;
  if (/Andrew|Aria/i.test(n) && /Natural/i.test(n)) s += 30;
  if (/Ava|Emma|Brian|Guy|Jenny/i.test(n) && /Natural/i.test(n)) s += 10;
  if (/Google US English/i.test(n)) s += 80;
  if (/Google/i.test(n)) s += 20;
  if (/natural|neural|enhanced|premium/i.test(n)) s += 15;
  return s;
}
function loadVoices() {
  if (!synth) return;
  const all = synth.getVoices();
  voices = all.filter((v) => rankVoice(v) >= 0).sort((a, b) => rankVoice(b) - rankVoice(a));
  const sel = $('voiceSel');
  sel.textContent = '';
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = v.name.replace(/^Microsoft /, '') + (v.localService ? '' : ' · online');
    sel.appendChild(o);
  }
  if (!voices.length) {
    const o = document.createElement('option');
    o.textContent = all.length ? 'No English voice installed' : 'Loading voices…';
    sel.appendChild(o);
  }
  if (settings.voice && voices.some((v) => v.name === settings.voice)) sel.value = settings.voice;
  showVoice();
}
function currentVoice() { return voices.find((v) => v.name === settings.voice) || voices[0] || null; }
function showVoice() { const v = currentVoice(); $('voiceName').textContent = 'Voice: ' + (v ? v.name.replace(/^Microsoft /, '').replace(/ - English.*$/, '') : 'default'); }

function effectiveRate() {
  const n = waiting().length;
  if (n > 3) return Math.min(1.6, settings.rate * 1.25);
  if (n > 2) return Math.min(1.6, settings.rate * 1.15);
  return settings.rate;
}

// Speak queued items strictly in order. One utterance at a time so rate/skip stay adjustable.
function pump() {
  updateBacklog();
  if (state.speaking || !synth) return;
  // Catch-up: drop the oldest waiting chunks if we've fallen far behind.
  if (settings.skipStale) {
    let w = waiting();
    while (w.length > 4) {
      const old = w.shift();
      old.state = 'skipped';
      old.el.classList.add('skipped');
      old.el.title = 'Skipped to catch up';
    }
  }
  const next = state.items.find((i) => i.state !== 'done' && i.state !== 'skipped' && i.state !== 'failed');
  state.items = state.items.filter((i) => i.state === 'translating' || i.state === 'ready' || i.state === 'speaking');
  updateBacklog();
  if (!next) { onQueueIdle(); return; }
  if (next.state !== 'ready') return; // head-of-line still translating — keep order
  speakItem(next);
}

function speakItem(item) {
  // Listening never pauses (owner's rule): the mic stays on while English plays.
  const u = new SpeechSynthesisUtterance(item.en);
  const v = currentVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
  u.rate = effectiveRate();
  item.state = 'speaking';
  item.utt = u; // keep a reference (Chrome can GC utterances and drop onend)
  state.speaking = item;
  item.el.classList.add('speaking');
  ui.chip('chipB', 'Speaking', 'live');
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    item.state = 'done';
    item.el.classList.remove('speaking');
    state.speaking = null;
    pump();
  };
  u.onstart = () => {
    if (item.endTime && !item.sys) recordLag((now() - item.endTime) / 1000);
  };
  u.onend = done;
  u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') ui.status('Voice error: ' + e.error, 'warn'); done(); };
  // Watchdog: some engines occasionally never fire onend.
  const words = item.en.split(/\s+/).length;
  const watchdog = setTimeout(() => { synth.cancel(); done(); }, (words / (2.4 * u.rate)) * 1000 + 6000);
  synth.speak(u);
}

function onQueueIdle() {
  if (!state.speaking) ui.chip('chipB', state.running ? 'Ready' : 'Muted', state.running ? 'ok' : '');
}

function recordLag(sec) {
  state.lags.push(sec);
  if (state.lags.length > 50) state.lags.shift();
  const avg = state.lags.reduce((a, b) => a + b, 0) / state.lags.length;
  $('lagNow').textContent = sec.toFixed(1) + 's';
  $('lagAvg').textContent = avg.toFixed(1) + 's';
  $('lagNow').dataset.kind = sec < 3 ? 'ok' : sec < 5 ? 'warn' : 'err';
}

// Browsers only allow speech after a user gesture: speak a silent utterance inside the tap
// so later (async, post-translation) utterances are allowed.
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked || !synth) return;
  audioUnlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  synth.speak(u);
}

// System lines (e.g. "Bridge on") also unlock audio on mobile — must run inside the tap.
function speakSystem(text) {
  if (!synth) return;
  const item = { seq: ++state.seq, ru: '', en: text, state: 'ready', sys: true, el: document.createElement('span') };
  state.items.push(item);
  pump();
}

// ---------- bridge on/off ----------
async function startBridge() {
  if (state.running) return;
  if (!SR) {
    ui.status(IS_IOS
      ? 'This iPhone browser cannot do live Russian recognition here. Please use Microsoft Edge or Google Chrome on a computer or Android phone. You can still try the Simulate buttons below.'
      : 'This browser has no speech recognition. Please open this page in Microsoft Edge or Google Chrome. The Simulate buttons below still work.', 'err');
    return;
  }
  if (!window.isSecureContext) { ui.status('The microphone needs a secure (https) link. Please open the https:// address.', 'err'); return; }
  state.running = true;
  state.fatal = null;
  document.body.classList.add('on');
  $('engage').setAttribute('aria-pressed', 'true');
  $('engageTitle').textContent = 'Bridge Engaged';
  ui.status('Starting… allow the microphone if asked.', '');
  speakSystem('Bridge on.');
  try { await startMeter(); } catch {
    ui.status(recErrorMessage('not-allowed'), 'err');
    stopBridge(true);
    return;
  }
  if (!state.running) return;
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  startRecognition();
}

function stopBridge(keepStatus = false) {
  state.running = false;
  if (state.rec) { try { state.rec.abort(); } catch { /* noop */ } }
  for (const id of [...chunker.streams.keys()]) if (id.startsWith('mic-')) { enqueue(chunker.flush(id, now())); renderSource(id, true); }
  stopMeter();
  state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
  document.body.classList.remove('on');
  $('engage').setAttribute('aria-pressed', 'false');
  $('engageTitle').textContent = 'Engage Headset Bridge';
  ui.chip('chipA', 'Idle');
  if (!state.speaking) ui.chip('chipB', 'Muted');
  if (!keepStatus) ui.status('Bridge stopped. Tap the button (or press Space) to start again.');
}
const toggleBridge = () => (state.running ? stopBridge() : startBridge());

// ---------- practice phrases ----------
const PHRASES = [
  { ru: 'Дорогие братья и сёстры, мир вам и благодать от Господа нашего Иисуса Христа!', en: 'Dear brothers and sisters, grace and peace to you from our Lord Jesus Christ!' },
  { ru: 'Господи, благодарим Тебя за этот день. Наполни нас Духом Святым.', en: 'Lord, we thank You for this day. Fill us with the Holy Spirit.' },
  { ru: 'Ибо так возлюбил Бог мир, что отдал Сына Своего Единородного, дабы всякий, верующий в Него, не погиб, но имел жизнь вечную.', en: 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life. (John 3:16)' },
  { ru: 'Давайте откроем наши Библии на Псалме 21.', en: "Let us open our Bibles to Psalm 22. (Russian Bibles number it 21.)" },
  { ru: 'Покайтесь, ибо приблизилось Царство Небесное! Сегодня день спасения.', en: 'Repent, for the kingdom of heaven is at hand! Today is the day of salvation.' },
  { ru: 'Аминь.', en: 'Amen.' },
];

let simSeq = 0;
// Feeds a phrase into the pipeline as if recognised: words arrive as interim results
// (~3 words/s, like a preacher), then a final — exercising the real chunker path.
function simulate(text) {
  unlockAudio();
  const id = 'sim-' + (++simSeq);
  const words = text.split(/\s+/);
  let i = 0;
  const step = () => {
    i++;
    const isLast = i >= words.length;
    const fin = isLast ? words.join(' ') : '';
    const inter = isLast ? '' : words.slice(0, i).join(' ');
    meter.activity = 0.7;
    enqueue(chunker.update(id, fin, inter, now()));
    renderSource(id);
    if (isLast) { enqueue(chunker.flush(id, now())); renderSource(id, true); return; }
    setTimeout(step, 330);
  };
  step();
}

function playRussian(text) {
  if (!synth) return;
  const ru = synth.getVoices().find((v) => /^ru/i.test(v.lang));
  if (!ru) { ui.status('No Russian voice is installed in this browser — use Simulate instead.', 'warn'); return; }
  if (state.speaking) { ui.status('Wait until the English voice finishes, then press Play again.', 'warn'); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.voice = ru; u.lang = ru.lang; u.rate = 0.95;
  synth.speak(u);
  ui.status(state.running ? 'Playing Russian aloud. With a headset on, keep the speakers near the mic, or use Simulate.' : 'Playing Russian. Engage the bridge first to translate it.', '');
}

function buildPhrases() {
  const box = $('phrases');
  for (const p of PHRASES) {
    const card = document.createElement('div');
    card.className = 'phrase';
    const ru = document.createElement('p'); ru.className = 'ru'; ru.lang = 'ru'; ru.textContent = '“' + p.ru + '”';
    const en = document.createElement('p'); en.className = 'en'; en.textContent = '“' + p.en + '”';
    const row = document.createElement('div'); row.className = 'phrase-actions';
    const sim = document.createElement('button'); sim.type = 'button'; sim.className = 'btn small'; sim.textContent = 'Simulate';
    sim.title = 'Send this Russian text through the bridge (no microphone)';
    sim.onclick = () => simulate(p.ru);
    const play = document.createElement('button'); play.type = 'button'; play.className = 'iconbtn'; play.setAttribute('aria-label', 'Play Russian aloud');
    play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
    play.onclick = () => playRussian(p.ru);
    row.append(sim, play);
    card.append(ru, en, row);
    box.appendChild(card);
  }
}

// ---------- headset mode ----------
const EAR_MODES = ['Both Earpieces (Stereo)', 'Left Ear Only', 'Right Ear Only'];
function renderEarMode() {
  $('modeLabel').textContent = EAR_MODES[settings.earMode];
  const note = $('modeNote');
  note.hidden = settings.earMode === 0;
  note.textContent = 'Browser voices always play in both ears — a web page cannot route them to one side. For one ear: just wear one earpiece, or set the audio balance (Windows: Settings › System › Sound › your headset › Balance; Android: Accessibility › Audio balance).';
}

// ---------- settings drawer ----------
function renderProviders() {
  const box = $('providerStatus');
  box.textContent = '';
  for (const [k, p] of Object.entries(PROVIDERS)) {
    const s = providerStats[k];
    const row = document.createElement('div');
    const state_ = exhausted.has(k) ? 'limit reached' : s.last === 'ok' ? 'working · ' + s.ms + ' ms' : s.last ? 'failing' : 'not used yet';
    row.innerHTML = '<b></b> <span></span><small></small>';
    row.children[0].textContent = p.name;
    row.children[1].textContent = '— ' + state_ + ' (' + s.ok + ' ok, ' + s.fail + ' failed)';
    row.children[2].textContent = p.terms;
    row.dataset.kind = exhausted.has(k) || (s.last && s.last !== 'ok') ? 'warn' : s.last === 'ok' ? 'ok' : '';
    box.appendChild(row);
  }
}

function openDrawer(open) {
  $('drawer').hidden = !open;
  $('scrim').hidden = !open;
  $('settingsBtn').setAttribute('aria-expanded', String(open));
  if (open) $('voiceSel').focus();
}

function bindSettings() {
  $('settingsBtn').onclick = () => openDrawer(true);
  $('closeDrawer').onclick = () => openDrawer(false);
  $('scrim').onclick = () => openDrawer(false);
  $('voiceSel').onchange = (e) => { settings.voice = e.target.value; store.set('voice', settings.voice); showVoice(); };
  $('testVoice').onclick = () => speakSystem('Grace and peace to you. This is your English voice.');
  const rate = $('rate');
  rate.value = settings.rate;
  $('rateOut').textContent = Number(settings.rate).toFixed(2) + '×';
  rate.oninput = () => { settings.rate = Number(rate.value); $('rateOut').textContent = settings.rate.toFixed(2) + '×'; store.set('rate', settings.rate); };
  for (const k of ['skipStale', 'psalms']) {
    $(k).checked = settings[k];
    $(k).onchange = (e) => { settings[k] = e.target.checked; store.set(k, settings[k]); };
  }
  $('providerSel').value = settings.provider;
  $('providerSel').onchange = (e) => { settings.provider = e.target.value; store.set('provider', settings.provider); };
  $('clearBtn').onclick = () => {
    for (const f of ['feedA', 'feedB']) $(f).textContent = '';
    state.lags = [];
    $('lagNow').textContent = $('lagAvg').textContent = '–';
  };
  $('modeBtn').onclick = () => { settings.earMode = (settings.earMode + 1) % EAR_MODES.length; store.set('earMode', settings.earMode); renderEarMode(); };
}

// ---------- keyboard ----------
const isField = (el) => el && (el.matches('input, select, textarea') || el.isContentEditable);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('drawer').hidden) { openDrawer(false); return; }
  if (e.code !== 'Space' || isField(e.target) || !$('drawer').hidden) return;
  e.preventDefault();
  if (!e.repeat) toggleBridge();
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space' && !isField(e.target)) e.preventDefault(); });

// ---------- init ----------
$('engage').onclick = toggleBridge;
buildPhrases();
bindSettings();
renderEarMode();
renderProviders();
if (synth) {
  loadVoices();
  synth.addEventListener?.('voiceschanged', loadVoices);
  setTimeout(loadVoices, 1500);
} else {
  $('voiceName').textContent = 'Voice: unavailable in this browser';
}
if (!SR) ui.status('This browser has no Russian speech recognition. Please use Microsoft Edge or Google Chrome. Simulate still works.', 'warn');
setInterval(() => {
  const out = chunker.tick(now());
  if (out.length) { enqueue(out); for (const c of out) renderSource(c.stream); }
}, 100);
requestAnimationFrame(animateMeters);
// Test hook for automated checks (no effect on normal use).
window.__babel = { state, chunker, simulate, settings };
