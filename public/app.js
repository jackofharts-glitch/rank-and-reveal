(() => {
'use strict';

/* =====================================================================
   Rank & Reveal — phone client
   Talks to the server with POST /api/<action> and listens on an
   EventSource stream (/api/stream) for live game state.
   ===================================================================== */

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};
const app = $('#app');
const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const hue = str => { let h = 7; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = name => {
  const ch = [...String(name)][0] || '?';
  return `<span class="avatar" style="background:hsl(${hue(name)} 70% 52%)">${esc(ch.toUpperCase())}</span>`;
};

/* ---------- sound & haptics (tiny WebAudio synth, no files) ---------- */
let AC = null;
let muted = ls.get('rr_muted') === '1';
function ac() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AC = null; } }
  if (AC && AC.state === 'suspended') AC.resume();
  return AC;
}
function tone(freq, dur = 0.15, type = 'sine', vol = 0.15, when = 0, slideTo = 0) {
  if (muted) return;
  const a = ac(); if (!a) return;
  const t = a.currentTime + when;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(a.destination);
  o.start(t); o.stop(t + dur + 0.03);
}
const sfx = {
  drum(ms) { let t = 0, gap = 0.17; while (t < ms / 1000 - 0.12) { tone(120, 0.1, 'triangle', 0.22, t, 55); t += gap; gap = Math.max(0.05, gap * 0.92); } },
  ding() { tone(880, 0.3, 'sine', 0.18); tone(1320, 0.4, 'sine', 0.12, 0.08); },
  good() { tone(660, 0.12, 'square', 0.07); tone(990, 0.2, 'square', 0.07, 0.1); },
  bad() { tone(200, 0.3, 'sawtooth', 0.08, 0, 90); },
  sad() { [392, 370, 349, 311].forEach((f, i) => tone(f, 0.4, 'sawtooth', 0.07, i * 0.3, f * 0.96)); },
  fanfare() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.24, 'triangle', 0.16, i * 0.13)); tone(1047, 0.7, 'triangle', 0.18, 0.55); tone(1319, 0.7, 'triangle', 0.12, 0.55); },
  tick() { tone(1300, 0.04, 'square', 0.04); },
  lock() { tone(520, 0.08, 'square', 0.08); tone(780, 0.16, 'square', 0.08, 0.07); },
};
const buzz = p => { try { if (!muted && navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } };
document.addEventListener('pointerdown', () => ac(), { once: true });
const soundBtn = $('#soundBtn');
const paintSound = () => { soundBtn.textContent = muted ? '🔇' : '🔊'; };
soundBtn.onclick = () => { muted = !muted; ls.set('rr_muted', muted ? '1' : '0'); paintSound(); if (!muted) sfx.ding(); };
paintSound();

/* ---------- visual effects ---------- */
const cv = $('#confetti');
let cx = null; try { cx = cv.getContext('2d'); } catch (e) { cx = null; }
let parts = [], raf = 0;
function sizeCanvas() { const d = window.devicePixelRatio || 1; cv.width = innerWidth * d; cv.height = innerHeight * d; }
addEventListener('resize', sizeCanvas); sizeCanvas();
function confetti(n = 120, mode = 'burst') {
  if (!cx) return;
  const colors = ['#ffd23f', '#ff4fa3', '#35e0ff', '#38e08c', '#8b5cff', '#ffffff'];
  const d = window.devicePixelRatio || 1, W = cv.width, H = cv.height;
  for (let i = 0; i < n; i++) {
    const p = { c: colors[i % colors.length], s: (6 + Math.random() * 7) * d, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3 };
    if (mode === 'burst') {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.7, v = (9 + Math.random() * 11) * d;
      p.x = W / 2; p.y = H * 0.6; p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v;
    } else {
      p.x = Math.random() * W; p.y = -20 * d; p.vx = (Math.random() - 0.5) * 3 * d; p.vy = (2 + Math.random() * 4) * d;
    }
    parts.push(p);
  }
  if (!raf) raf = requestAnimationFrame(stepConfetti);
}
function stepConfetti() {
  const d = window.devicePixelRatio || 1;
  cx.clearRect(0, 0, cv.width, cv.height);
  parts = parts.filter(p => p.y < cv.height + 40);
  for (const p of parts) {
    p.vy += 0.22 * d; p.vx *= 0.992; p.x += p.vx; p.y += p.vy; p.r += p.vr;
    cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r); cx.fillStyle = p.c; cx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * 0.6); cx.restore();
  }
  raf = parts.length ? requestAnimationFrame(stepConfetti) : 0;
}
function flash(color) {
  const f = $('#flash'); f.style.background = color || '#fff';
  f.classList.remove('on'); void f.offsetWidth; f.classList.add('on');
}
function shake() { app.classList.remove('shake'); void app.offsetWidth; app.classList.add('shake'); }
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3300);
}
function banner(msg) {
  let b = $('#banner');
  if (!msg) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('div'); b.id = 'banner'; document.body.appendChild(b); }
  b.textContent = msg;
}
let fxTimers = [];
const later = (fn, ms) => fxTimers.push(setTimeout(fn, ms));
const clearFx = () => { fxTimers.forEach(clearTimeout); fxTimers = []; };

/* ---------- session + networking ---------- */
let session = null;
try { session = JSON.parse(ls.get('rr_session') || 'null'); } catch (e) { session = null; }
const urlCode = ((location.pathname.match(/^\/([A-Za-z]{4})\/?$/) || [])[1] || '').toUpperCase();
if (session && urlCode && session.room !== urlCode) session = null; // opened a different room's invite link
const saveSession = s => { session = s; if (s) ls.set('rr_session', JSON.stringify(s)); else ls.del('rr_session'); };

let S = null, offset = 0, viewKey = null, es = null, lastMsg = 0;

async function post(action, body) {
  const r = await fetch('/api/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ room: session && session.room, pid: session && session.pid }, body || {})),
  });
  return r.json();
}
async function act(type, body) {
  try {
    const r = await post(type, body);
    if (r && r.gone) lostGame();
    else if (r && !r.ok && r.error) toast(r.error);
    return r;
  } catch (e) { toast('Connection hiccup — try again'); return null; }
}
function lostGame() {
  closeStream(); saveSession(null); history.replaceState(null, '', '/');
  showHome('That game is no longer running. Start a new one!');
}

// Drafts (work-in-progress rankings) are sent one at a time so they can never arrive out of order.
let draftBusy = false, draftPending = null;
function sendDraft(order) { draftPending = order.slice(); pumpDraft(); }
async function pumpDraft() {
  if (draftBusy) return;
  draftBusy = true;
  try { while (draftPending) { const o = draftPending; draftPending = null; try { await post('draft', { order: o }); } catch (e) { /* retry on next change */ } } }
  finally { draftBusy = false; }
}

function closeStream() { if (es) { es.close(); es = null; } }
function openStream() {
  closeStream();
  if (!session) return;
  lastMsg = Date.now();
  es = new EventSource('/api/stream?room=' + encodeURIComponent(session.room) + '&pid=' + encodeURIComponent(session.pid));
  es.addEventListener('state', e => { banner(''); onState(JSON.parse(e.data)); });
  es.addEventListener('ping', () => { lastMsg = Date.now(); });
  es.addEventListener('toast', e => toast(JSON.parse(e.data)));
  es.addEventListener('kicked', () => { closeStream(); saveSession(null); history.replaceState(null, '', '/'); showHome('The host removed you from that room.'); });
  es.addEventListener('replaced', () => { closeStream(); S = null; showHome('This game was opened in another tab or window, so this one paused.'); });
  es.onerror = () => {
    if (es && es.readyState === 2) rejoin();      // server refused the stream -> go through the front door again
    else banner('Reconnecting…');                  // otherwise the browser retries by itself
  };
}
async function rejoin() {
  if (!session) return;
  try {
    const r = await post('join', { name: session.name });
    if (r.ok) { saveSession({ room: r.code, pid: r.pid, name: r.name }); openStream(); }
    else if (r.gone) lostGame();
    else { closeStream(); showHome(r.error); }
  } catch (e) { banner('Reconnecting…'); setTimeout(rejoin, 2000); }
}
// phones love to silently kill connections when the screen sleeps — notice and reconnect
setInterval(() => { if (session && es && Date.now() - lastMsg > 40000) { banner('Reconnecting…'); openStream(); } }, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  if (session && (!es || es.readyState === 2 || Date.now() - lastMsg > 20000)) openStream();
});
let wakeLock = null;
async function keepAwake() {
  try { if (S && S.phase !== 'lobby' && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* not supported */ }
}

function onState(st) {
  S = st; offset = st.now - Date.now(); lastMsg = Date.now();
  render(); keepAwake();
}

/* ---------- home ---------- */
function showHome(msg) {
  viewKey = null; S = null; clearFx(); $('#topbar').hidden = true;
  const name = ls.get('rr_name') || '';
  app.innerHTML = `
  <section class="screen home">
    <div class="logo">Rank<span>&amp; Reveal</span></div>
    <p class="tag">Rank 5 things from favorite to least favorite.<br>Everyone else guesses your list. Drama ensues.</p>
    ${msg ? `<div class="notice">${esc(msg)}</div>` : ''}
    <div class="panel">
      <label class="lbl" for="name">Your name</label>
      <input id="name" class="text" maxlength="16" placeholder="e.g. Grandma" value="${esc(name)}" autocomplete="off" autocapitalize="words" enterkeyhint="go">
      ${urlCode ? `
        <button class="btn primary big" id="joinBtn">Join game ${esc(urlCode)}</button>
        <button class="btn ghost small" id="newBtn">…or start a new game instead</button>`
      : `
        <button class="btn primary big" id="createBtn">Create a game</button>
        <div class="or">or join your friends</div>
        <div class="row"><input id="code" class="text code" maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters"><button class="btn" id="joinBtn">Join</button></div>`}
      <div id="err"></div>
    </div>
    <details class="how"><summary>How to play</summary>
      <ol>
        <li>Each turn, one player gets <b>5 random cards</b> and ranks them <b>1 (favorite) to 5 (least favorite)</b> — purely their opinion.</li>
        <li>Everyone else sees the same cards and <b>guesses that exact order</b>.</li>
        <li><b>1 point</b> for every card you place in exactly the right spot.</li>
        <li>If someone nails all 5, the ranker gets a <b>bonus</b> — so rank honestly!</li>
        <li>Everybody takes turns ranking. Most points after 3 rounds wins.</li>
      </ol>
    </details>
  </section>`;
  const go = kind => {
    const nm = $('#name').value.replace(/\s+/g, ' ').trim();
    const err = $('#err');
    if (!nm) { err.textContent = 'Please enter your name.'; $('#name').focus(); return; }
    ls.set('rr_name', nm);
    let code = urlCode;
    if (kind === 'join' && !code) code = ($('#code').value || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (kind === 'join' && code.length !== 4) { err.textContent = 'Enter the 4-letter room code.'; return; }
    err.textContent = '';
    const body = kind === 'create' ? { name: nm } : { name: nm, room: code, pid: (session && session.room === code) ? session.pid : undefined };
    fetch('/api/' + (kind === 'create' ? 'create' : 'join'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => r.json())
      .then(r => {
        if (!r.ok) { err.textContent = r.error || 'Something went wrong.'; return; }
        saveSession({ room: r.code, pid: r.pid, name: r.name });
        history.replaceState(null, '', '/' + r.code);
        ac(); openStream();
      })
      .catch(() => { err.textContent = "Couldn't reach the game server. Check your connection."; });
  };
  const jb = $('#joinBtn'), cb = $('#createBtn'), nb = $('#newBtn');
  if (jb) jb.onclick = () => go('join');
  if (cb) cb.onclick = () => go('create');
  if (nb) nb.onclick = () => { location.href = '/'; };
  $('#name').addEventListener('keydown', e => { if (e.key === 'Enter') (urlCode ? jb : cb).click(); });
  const ci = $('#code'); if (ci) ci.addEventListener('keydown', e => { if (e.key === 'Enter') jb.click(); });
}

/* ---------- render pipeline ---------- */
function keyOf(s) {
  const h = s.isHost ? 'H' : '';
  switch (s.phase) {
    case 'lobby': return 'lobby:' + h + s.players.map(p => p.id + p.name + (p.connected ? 1 : 0)).join('|');
    case 'ranking': return (s.you === s.turn.rankerId ? 'rank-me:' : 'rank-wait:') + s.turnId + h;
    case 'guessing': {
      const T = s.turn;
      if (s.you === T.rankerId) return 'guess-watch:' + s.turnId + h;
      if (!T.canGuess) return 'guess-spectate:' + s.turnId + h;
      return (T.locked ? 'guess-locked:' : 'guess:') + s.turnId + h;
    }
    case 'reveal': return 'reveal:' + s.turnId + ':' + s.reveal.step + h;
    case 'final': return 'final';
  }
  return s.phase;
}
function render() {
  if (!S) return;
  $('#topbar').hidden = false;
  $('#roomTag').textContent = 'Room ' + S.code;
  $('#roundTag').textContent = S.phase === 'lobby' ? 'Lobby' : S.phase === 'final' ? 'Final results' : `Round ${S.round}/${S.cfg.rounds} · Turn ${S.turnIndex}/${S.turnsInRound}`;
  const k = keyOf(S);
  if (k !== viewKey) { viewKey = k; clearFx(); window.scrollTo(0, 0); mount(); }
  else renderStrip();
}
function mount() {
  const T = S.turn;
  switch (S.phase) {
    case 'lobby': return mountLobby();
    case 'ranking': return S.you === T.rankerId ? mountPlay('rank') : mountWait();
    case 'guessing':
      if (S.you === T.rankerId) return mountGuessOther('watch');
      if (!T.canGuess) return mountGuessOther('spectate');
      return T.locked ? mountGuessOther('locked') : mountPlay('guess');
    case 'reveal': return mountReveal();
    case 'final': return mountFinal();
  }
}

/* ---------- shared bits ---------- */
const timerHTML = () => '<div class="timer"><div class="bar"><i id="tbar"></i></div><span id="ttxt"></span></div>';
function stripHTML() {
  const T = S.turn || {}, sub = new Set(T.submitted || []);
  return S.players.map(p => {
    let st = '';
    if (p.id === T.rankerId) st = S.phase === 'ranking' ? '✍️' : '🔒';
    else if (S.phase === 'guessing') st = sub.has(p.id) ? '✅' : (p.connected ? '🤔' : '💤');
    else if (!p.connected) st = '💤';
    return `<div class="chip ${p.connected ? '' : 'off'} ${p.id === S.you ? 'me' : ''}">${avatar(p.name)}<div class="cn"><b>${esc(p.name)}</b><small>${p.score} pts</small></div><span class="st">${st}</span></div>`;
  }).join('');
}
function renderStrip() { const el = $('#strip'); if (el) el.innerHTML = stripHTML(); }
const hostBar = (label, confirmMsg) => S.isHost
  ? `<div class="hostbar"><button class="btn ghost small" id="hostBtn" ${confirmMsg ? `data-confirm="${esc(confirmMsg)}"` : ''}>${label}</button></div>` : '';
function bindHost() {
  const b = $('#hostBtn'); if (!b) return;
  b.onclick = () => { if (b.dataset.confirm && !confirm(b.dataset.confirm)) return; act('hostSkip'); };
}

// countdown bars + "next turn in" counter
setInterval(() => {
  const bar = $('#tbar'), txt = $('#ttxt');
  if (bar && txt && S && S.turn && S.turn.endsAt) {
    const left = Math.max(0, S.turn.endsAt - (Date.now() + offset));
    bar.style.width = (S.turn.duration ? left / S.turn.duration * 100 : 0) + '%';
    txt.textContent = fmt(left);
    const low = left <= 10000;
    bar.parentElement.classList.toggle('low', low); txt.classList.toggle('low', low);
  }
  const nc = $('#nextCount');
  if (nc && S && S.reveal) nc.textContent = Math.max(0, Math.ceil((S.reveal.nextAt - (Date.now() + offset)) / 1000));
}, 200);

/* ---------- lobby ---------- */
function mountLobby() {
  const link = location.origin + '/' + S.code;
  const n = S.players.length, hostP = S.players.find(p => p.isHost);
  app.innerHTML = `
  <section class="screen lobby">
    <div class="kicker">Room code</div>
    <div class="roomcode">${esc(S.code)}</div>
    <div class="sharebox"><input class="text" id="linkField" readonly value="${esc(link)}"><button class="btn small" id="copyBtn">Copy link</button></div>
    ${navigator.share ? '<button class="btn" id="shareBtn">📲 Send invite</button>' : ''}
    <div class="panel">
      <div class="panelhead"><span>Players</span><span>${n}/${S.cfg.max}</span></div>
      <ul class="plist">${S.players.map(p => `
        <li class="${p.connected ? '' : 'off'}">${avatar(p.name)}<span class="pname">${esc(p.name)}</span>
        ${p.isHost ? '<span class="crown">👑</span>' : ''}${p.id === S.you ? '<span class="you">you</span>' : ''}
        ${S.isHost && p.id !== S.you ? `<button class="kick" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}</li>`).join('')}
      </ul>
    </div>
    <p class="rules"><b>${S.cfg.rounds} rounds</b> — everyone ranks once per round. Rankers get <b>${fmt(S.cfg.rankSeconds * 1000)}</b>, guessers <b>${fmt(S.cfg.guessSeconds * 1000)}</b>. <b>+1</b> per card in the exact right spot. If a guesser nails all 5, the ranker earns <b>+${S.cfg.bonus}</b> — so rank honestly!</p>
    ${S.isHost
      ? `<button class="btn primary big" id="startBtn" ${S.players.filter(p => p.connected).length < S.cfg.min ? 'disabled' : ''}>${n < S.cfg.min ? 'Waiting for friends…' : 'Start game'}</button>`
      : `<div class="waiting">Waiting for ${esc(hostP ? hostP.name : 'the host')} to start…</div>`}
    <button class="linkbtn" id="leaveBtn">Leave room</button>
  </section>`;
  $('#copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied!'); }
    catch (e) { const f = $('#linkField'); f.select(); try { document.execCommand('copy'); toast('Link copied!'); } catch (e2) { toast('Press and hold the link to copy'); } }
  };
  const sb = $('#shareBtn'); if (sb) sb.onclick = () => navigator.share({ title: 'Rank & Reveal', text: `Join my game of Rank & Reveal! Room ${S.code}`, url: link }).catch(() => {});
  const st = $('#startBtn'); if (st) st.onclick = () => { ac(); act('start'); };
  document.querySelectorAll('.kick').forEach(b => { b.onclick = () => { if (confirm('Remove this player?')) act('kick', { target: b.dataset.id }); }; });
  $('#leaveBtn').onclick = async () => { await act('leave'); closeStream(); saveSession(null); location.href = '/'; };
}

/* ---------- ranking & guessing ---------- */
function mountWait() {
  const T = S.turn, rn = esc(T.rankerName);
  app.innerHTML = `
  <section class="screen wait">
    <div class="eyebrow">${rn} is ranking</div>
    <div class="thinking">🤔</div>
    <h2 class="bigmsg">5 cards.<br>1 favorite.<br>Zero mercy.</h2>
    <p class="sub center">When ${rn} locks it in, you'll get ${fmt(S.cfg.guessSeconds * 1000)} to guess their exact order.</p>
    ${timerHTML()}
    <div id="strip" class="strip"></div>
    ${hostBar('Skip this turn (host)', `Skip ${T.rankerName}'s turn?`)}
  </section>`;
  renderStrip(); bindHost();
}

function mountPlay(mode) {
  const T = S.turn, isRank = mode === 'rank', rn = esc(T.rankerName);
  const cards = T.cards, byId = {};
  cards.forEach(c => { byId[c.id] = c; });
  let order = (T.draft || []).filter(id => byId[id]);
  app.innerHTML = `
  <section class="screen play">
    <div class="turnhead">
      <div class="eyebrow">${isRank ? 'Your turn · rank them' : `Guess ${rn}'s ranking`}</div>
      <h2>${isRank ? 'Order these from <u>favorite</u> to <u>least favorite</u>' : `How did <u>${rn}</u> rank these?`}</h2>
      ${timerHTML()}
    </div>
    <div class="ends"><span>▲ 1 = ${isRank ? 'your favorite' : rn + "'s favorite"}</span><span>5 = least favorite ▼</span></div>
    <div id="slots" class="slots"></div>
    <div class="poolhead">Tap cards to place them in order</div>
    <div id="pool" class="pool"></div>
    <button id="submit" class="btn primary big" disabled>${isRank ? 'Lock in my ranking 🔒' : 'Lock in my guess 🔒'}</button>
    ${isRank ? '' : '<div id="strip" class="strip"></div>'}
    ${hostBar(isRank ? 'Skip my turn (host)' : 'Skip to the reveal (host)', isRank ? 'Skip this turn?' : 'End guessing now?')}
  </section>`;
  const slotsEl = $('#slots'), poolEl = $('#pool'), btn = $('#submit');
  function draw() {
    slotsEl.innerHTML = [0, 1, 2, 3, 4].map(i => {
      const id = order[i];
      if (id == null) return `<div class="slot empty"><div class="num">${i + 1}</div><div class="sbody">${i === order.length ? 'Tap a card below ↓' : ''}</div></div>`;
      return `<div class="slot filled" data-i="${i}"><div class="num n${i + 1}">${i + 1}</div><div class="sbody">${esc(byId[id].text)}</div>
        <div class="mv"><button data-act="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>▲</button><button data-act="down" aria-label="Move down" ${i === order.length - 1 ? 'disabled' : ''}>▼</button></div>
        <button class="rm" data-act="remove" aria-label="Remove">✕</button></div>`;
    }).join('');
    const left = cards.filter(c => !order.includes(c.id));
    poolEl.innerHTML = left.length
      ? left.map(c => `<button class="pcard" data-id="${c.id}">${esc(c.text)}</button>`).join('')
      : '<div class="allplaced">All placed! Fine-tune with ▲ ▼ or lock it in.</div>';
    btn.disabled = order.length !== 5;
  }
  slotsEl.addEventListener('click', e => {
    const row = e.target.closest('.slot.filled'), a = e.target.closest('[data-act]');
    if (!row || !a) return;
    const i = +row.dataset.i, act_ = a.dataset.act;
    if (act_ === 'up' && i > 0) [order[i - 1], order[i]] = [order[i], order[i - 1]];
    else if (act_ === 'down' && i < order.length - 1) [order[i + 1], order[i]] = [order[i], order[i + 1]];
    else if (act_ === 'remove') order.splice(i, 1);
    else return;
    sfx.tick(); draw(); sendDraft(order);
  });
  poolEl.addEventListener('click', e => {
    const b = e.target.closest('.pcard');
    if (!b || order.length >= 5) return;
    order.push(+b.dataset.id);
    sfx.tick(); buzz(8); draw(); sendDraft(order);
  });
  btn.onclick = async () => {
    if (order.length !== 5) return;
    btn.disabled = true; btn.textContent = 'Locking in…'; sfx.lock(); buzz(20);
    const r = await act('submit', { order: order.slice() });
    if (!r || !r.ok) { btn.disabled = false; btn.textContent = isRank ? 'Lock in my ranking 🔒' : 'Lock in my guess 🔒'; }
  };
  draw(); renderStrip(); bindHost();
}

function mountGuessOther(kind) {
  const T = S.turn, rn = esc(T.rankerName);
  let top = '';
  if (kind === 'watch') {
    top = `<div class="eyebrow">Your ranking is locked in</div><div class="thinking">🔒</div><h2 class="bigmsg">Now they're guessing…</h2>
      <ol class="myrank">${T.myRanking.map((c, i) => `<li><span class="num n${i + 1}">${i + 1}</span>${esc(c.text)}</li>`).join('')}</ol>
      <p class="sub center">Every guesser who nails all 5 earns you <b>+${S.cfg.bonus}</b>. Poker face on. 😐</p>`;
  } else if (kind === 'locked') {
    top = `<div class="eyebrow">Guess locked in</div><div class="thinking">🔒</div><h2 class="bigmsg">Fingers crossed…</h2>
      <p class="sub center">Waiting for the others to finish guessing ${rn}'s list.</p>`;
  } else {
    top = `<div class="eyebrow">You joined mid-turn</div><div class="thinking">👀</div><h2 class="bigmsg">Sit tight!</h2>
      <p class="sub center">You'll get your own turn ranking later. Enjoy the reveal.</p>`;
  }
  app.innerHTML = `<section class="screen lockedscreen">${top}${timerHTML()}<div id="strip" class="strip"></div>${hostBar('Skip to the reveal (host)', 'End guessing now?')}</section>`;
  renderStrip(); bindHost();
}

/* ---------- the reveal ---------- */
const rankWord = r => (r === 1 ? 'FAVORITE' : r === 5 ? 'LEAST FAVORITE' : '');
function tallyHTML(R) {
  if (!R.guessers.length) return '';
  const done = R.type === 'revealed' ? R.positions.length - 1 : R.positions.length;
  const pts = {}; R.guessers.forEach(g => { pts[g.id] = 0; });
  R.positions.slice(0, done).forEach(p => p.guesses.forEach(g => { if (g.correct) pts[g.id]++; }));
  return `<div class="tally"><span class="tl">This turn</span>${R.guessers.map(g => `<span class="tchip"><b>${esc(g.name)}</b>${pts[g.id]}</span>`).join('')}</div>`;
}

function mountReveal() {
  const R = S.reveal, T = S.turn;
  if (R.type === 'summary') return mountSummary();
  const skipLabel = 'Skip reveal ⏭';

  if (R.type === 'suspense') {
    const w = rankWord(R.rank);
    app.innerHTML = `
    <section class="screen stage suspense ${R.finale ? 'finale' : ''}">
      <div class="eyebrow">${esc(T.rankerName)}'s ${R.rank === 5 ? 'least favorite' : R.rank === 1 ? 'absolute favorite' : 'number ' + R.rank + ' pick'}</div>
      <div class="bignum">#${R.rank}</div>
      <div class="mysterycard"><span>?</span></div>
      <div class="dots"><i></i><i></i><i></i></div>
      <div class="hint">${R.finale ? 'The moment of truth…' : (w ? 'Did you see this coming?' : 'Who called it?')}</div>
      ${tallyHTML(R)}
      ${hostBar(skipLabel)}
    </section>`;
    sfx.drum(R.stepMs || 1900); buzz([40, 60, 40, 60, 40]);
    bindHost();
    return;
  }

  // revealed
  const pos = R.positions[R.positions.length - 1];
  const g = pos.guesses, c = g.filter(x => x.correct).length, base = 900, per = 320;
  let verdict = '';
  if (g.length) {
    if (c === 0) verdict = 'NOBODY saw that coming! 😱';
    else if (c === g.length) verdict = g.length === 1 ? 'Nailed it! 🎯' : 'EVERYONE knew! 🎯';
    else if (c === 1) verdict = `Only ${esc(g.find(x => x.correct).name)} knew!`;
    else verdict = `${c} of ${g.length} got it!`;
  }
  const w = rankWord(pos.rank);
  app.innerHTML = `
  <section class="screen stage revealed ${R.finale ? 'finale' : ''}">
    <div class="rankbadge">#${pos.rank}${w ? ' · ' + w : ''}</div>
    <div class="who">${esc(T.rankerName)} ranked…</div>
    <div class="flipcard"><div class="face">${esc(pos.card)}</div></div>
    <div class="verdict" style="animation-delay:${base + g.length * per}ms">${verdict}</div>
    <div class="guesslist">${g.map((x, i) => `
      <div class="grow ${x.correct ? 'ok' : 'no'}" style="animation-delay:${base + i * per}ms">
        <div class="gname">${esc(x.name)}</div><div class="gguess">${x.card ? esc(x.card) : '—'}</div><div class="gmark">${x.correct ? '✓ +1' : '✗'}</div>
      </div>`).join('')}</div>
    ${tallyHTML(R)}
    ${hostBar(skipLabel)}
  </section>`;
  sfx.ding(); buzz(80); flash('#ffffffaa');
  g.forEach((x, i) => later(() => { if (x.correct) { sfx.good(); buzz(25); } else sfx.bad(); }, base + i * per));
  const after = base + g.length * per;
  if (g.length && (c === g.length || (R.finale && c > 0))) later(() => { confetti(R.finale ? 220 : 120); sfx.fanfare(); buzz([60, 40, 60, 40, 120]); }, after);
  else if (g.length && c === 0) later(() => { shake(); sfx.sad(); buzz(200); }, after);
  bindHost();
}

function mountSummary() {
  const R = S.reveal, M = R.summary;
  const perfect = M.rows.filter(r => r.perfect).map(r => esc(r.name));
  const sorted = S.players.slice().sort((a, b) => b.score - a.score);
  const lastTurn = S.round === S.cfg.rounds && S.turnIndex === S.turnsInRound;
  app.innerHTML = `
  <section class="screen summary">
    <h2>${esc(M.rankerName)}'s ranking</h2>
    <ol class="finalrank">${M.ranking.map(r => `<li style="animation-delay:${r.rank * 70}ms"><span class="num n${r.rank}">${r.rank}</span>${esc(r.text)}</li>`).join('')}</ol>
    ${perfect.length ? `<div class="bonusline">🧠 ${perfect.join(' & ')} ${perfect.length === 1 ? 'went' : 'both went'} <b>5/5</b>!<br>${esc(M.rankerName)} earns <b>+${M.bonus}</b> for being so readable.</div>` : ''}
    <div class="sectionhead">Guessing results</div>
    ${M.rows.map(r => `<div class="rrow ${r.perfect ? 'perfect' : ''}"><div class="rname">${avatar(r.name)}<b>${esc(r.name)}</b></div>
      <div class="pips">${[0, 1, 2, 3, 4].map(i => `<i class="${i < r.correct ? 'on' : ''}"></i>`).join('')}</div><div class="rpts">${r.perfect ? '🧠 ' : ''}+${r.correct}</div></div>`).join('') || '<p class="sub center">No guesses this turn.</p>'}
    ${M.missed.length ? `<p class="sub center">Sat this one out: ${M.missed.map(esc).join(', ')}</p>` : ''}
    <div class="sectionhead">Scoreboard</div>
    <div class="board">${sorted.map((p, i) => { const d = M.deltas[p.id] || 0; return `
      <div class="brow ${p.id === S.you ? 'me' : ''}"><span class="pos">${i + 1}</span>${avatar(p.name)}<b class="bn">${esc(p.name)}</b>${d ? `<span class="delta">+${d}</span>` : ''}<span class="bs">${p.score}</span></div>`; }).join('')}</div>
    <div class="nexthint">${lastTurn ? 'Final results in' : 'Next turn in'} <b id="nextCount">…</b>s</div>
    ${S.isHost ? `<button class="btn primary big" id="hostBtn">${lastTurn ? 'Final results 🏆' : 'Next turn ▶'}</button>` : ''}
  </section>`;
  if (M.perfectCount) { sfx.fanfare(); confetti(160); buzz([60, 40, 60, 40, 120]); flash('#ffd23f99'); } else sfx.ding();
  bindHost();
}

/* ---------- final results ---------- */
function mountFinal() {
  const F = S.final, n = F.standings.length, step = 800;
  const top = n ? F.standings[0].score : 0;
  const winners = F.standings.filter(s => s.winner).map(s => s.name);
  const medals = ['🥇', '🥈', '🥉'];
  const T = n * step + 1100;
  app.innerHTML = `
  <section class="screen final">
    <div class="trophy">🏆</div>
    <div id="ftitle" class="drum">AND THE WINNER IS…</div>
    <div class="frows">${F.standings.map((s, i) => {
      const delay = (n - 1 - i) * step + 500, w = top ? Math.max(6, Math.round(s.score / top * 100)) : 6;
      return `<div class="frow ${s.winner ? 'win' : ''}" style="animation-delay:${delay}ms"><span class="fplace">${medals[s.place - 1] || s.place}</span>${avatar(s.name)}
        <div class="fmid"><b>${esc(s.name)}</b><div class="fbar"><i style="width:${w}%;animation-delay:${delay + 250}ms"></i></div></div><span class="fscore">${s.score}</span></div>`;
    }).join('')}</div>
    <div class="awards" id="awards">${F.awards.map(a => `<div class="award"><span class="aicon">${a.icon}</span><div><b>${a.title}: ${esc(a.who)}</b><small>${esc(a.note)}</small></div></div>`).join('')}</div>
    <div id="fhost" hidden>
      ${S.isHost ? '<button class="btn primary big" id="againBtn">Play again 🔁</button>' : '<div class="waiting">Waiting for the host to start another game…</div>'}
      <button class="linkbtn" id="leaveBtn2">Leave room</button>
    </div>
  </section>`;
  sfx.drum(T - 300);
  F.standings.forEach((s, i) => later(() => { sfx.ding(); buzz(30); }, (n - 1 - i) * step + 500));
  later(() => {
    const t = $('#ftitle'); if (!t) return;
    t.classList.remove('drum');
    t.innerHTML = winners.length > 1 ? `🏆 ${winners.map(esc).join(' & ')}<br>tie for the win!` : `🏆 ${esc(winners[0] || '')} wins!`;
    sfx.fanfare(); confetti(240); buzz([80, 40, 80, 40, 200]); flash('#ffd23fbb');
    [900, 1800, 2700].forEach(d => later(() => confetti(90, 'rain'), d));
  }, T);
  later(() => { const a = $('#awards'); if (a) a.classList.add('in'); const h = $('#fhost'); if (h) h.hidden = false; }, T + 700);
  const again = $('#againBtn'); if (again) again.onclick = () => act('playAgain');
  $('#leaveBtn2').onclick = async () => { await act('leave'); closeStream(); saveSession(null); location.href = '/'; };
}

/* ---------- boot ---------- */
if (session) {
  app.innerHTML = '<section class="screen"><div class="thinking">⏳</div><p class="sub center">Joining your game…</p></section>';
  rejoin();
} else {
  showHome();
}
})();
