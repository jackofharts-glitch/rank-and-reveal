'use strict';
/**
 * Best guess? — game server.
 * Zero dependencies: plain Node. Phones get live updates over Server-Sent Events
 * (GET /api/stream) and send their moves with POST /api/<action>.
 * All rooms live in memory in this one process.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/*  Settings — change these to tweak the game                          */
/* ------------------------------------------------------------------ */
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d);
const CFG = {
  ROUNDS: num(process.env.ROUNDS, 3),               // full rounds (everyone ranks once per round)
  RANK_SECONDS: num(process.env.RANK_SECONDS, 60),  // time for the ranker
  GUESS_SECONDS: num(process.env.GUESS_SECONDS, 90),// time for the guessers
  PERFECT_BONUS: num(process.env.PERFECT_BONUS, 3), // ranker bonus for EACH guesser who goes 5/5
  MAX_PLAYERS: 8,
  MIN_PLAYERS: 2,
  HAND: 5,
  // reveal pacing (milliseconds)
  SUSPENSE_MS: num(process.env.SUSPENSE_MS, 1900),
  FINALE_SUSPENSE_MS: num(process.env.FINALE_SUSPENSE_MS, 3400),
  SHOW_MS: num(process.env.SHOW_MS, 3800),
  SHOW_PER_GUESSER_MS: num(process.env.SHOW_PER_GUESSER_MS, 250),
  SUMMARY_MS: num(process.env.SUMMARY_MS, 15000),
  // connection handling
  LOBBY_GRACE_MS: num(process.env.LOBBY_GRACE_MS, 60000),
  DISCONNECT_GRACE_MS: num(process.env.DISCONNECT_GRACE_MS, 15000),
  KEEPALIVE_MS: 15000,
};

const DECK = [...new Set(require('./cards.json').map(s => String(s).trim()).filter(Boolean))];
if (DECK.length < CFG.HAND) throw new Error('cards.json needs at least ' + CFG.HAND + ' cards');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
const rooms = new Map();
const CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels -> no accidental words
const uid = () => crypto.randomBytes(9).toString('hex');
const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const getPlayer = (room, id) => room.players.find(p => p.id === id);

function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cleanName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}
function sanitize(order, full) {
  if (!Array.isArray(order) || order.length > CFG.HAND) return null;
  const out = [];
  for (const x of order) {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 0 || n >= CFG.HAND || out.includes(n)) return null;
    out.push(n);
  }
  if (full && out.length !== CFG.HAND) return null;
  return out;
}

function newRoom(code) {
  return {
    code, hostId: null, players: [], phase: 'lobby',
    round: 0, roundIndex: -1, roundOrder: [], baseOrder: [],
    draw: [], turn: null, turnCounter: 0, timer: null,
    history: [], final: null, lastActive: Date.now(),
  };
}
function addPlayer(room, name) {
  const p = { id: uid(), name, score: 0, res: null, connected: false, disconnectedAt: 0, lobbyTimer: null };
  room.players.push(p);
  return p;
}
// The host is the room creator while connected; otherwise the first connected player.
function hostOf(room) {
  const h = getPlayer(room, room.hostId);
  if (h && h.connected) return h;
  return room.players.find(p => p.connected) || h || null;
}
const clearTimer = room => { if (room.timer) { clearTimeout(room.timer); room.timer = null; } };

/* ---- Server-Sent Events plumbing ---- */
function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* closed */ }
}
function emitAll(room, event, payload) {
  for (const p of room.players) if (p.connected && p.res) sse(p.res, event, payload);
}

/* ------------------------------------------------------------------ */
/*  What each phone gets to see                                        */
/* ------------------------------------------------------------------ */
function revealView(room) {
  const t = room.turn, s = t.revealStep;
  const type = s >= 10 ? 'summary' : (s % 2 === 0 ? 'suspense' : 'revealed');
  const rank = s >= 10 ? 0 : 5 - Math.floor(s / 2);
  const count = s >= 10 ? 5 : Math.floor(s / 2) + (s % 2);
  return {
    step: s, type, rank, finale: rank === 1,
    stepMs: t.stepMs || 0, nextAt: t.nextAt || 0,
    guessers: t.summary.rows.map(r => ({ id: r.id, name: r.name })),
    positions: t.positions.slice(0, count),
    summary: type === 'summary' ? t.summary : null,
  };
}

function view(room, me) {
  const t = room.turn;
  const host = hostOf(room);
  const v = {
    now: Date.now(), code: room.code, phase: room.phase, you: me.id,
    isHost: !!host && host.id === me.id,
    cfg: { rounds: CFG.ROUNDS, rankSeconds: CFG.RANK_SECONDS, guessSeconds: CFG.GUESS_SECONDS, bonus: CFG.PERFECT_BONUS, min: CFG.MIN_PLAYERS, max: CFG.MAX_PLAYERS },
    round: room.round, turnIndex: room.roundIndex + 1, turnsInRound: room.roundOrder.length,
    turnId: t ? t.id : 0,
    players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected,
      isHost: !!host && host.id === p.id, isRanker: !!t && t.rankerId === p.id,
    })),
  };
  if (t && ['ranking', 'guessing', 'reveal'].includes(room.phase)) {
    const ranker = getPlayer(room, t.rankerId);
    v.turn = { rankerId: t.rankerId, rankerName: ranker ? ranker.name : '?', endsAt: t.endsAt, duration: t.duration };
    if (room.phase === 'ranking' && me.id === t.rankerId) {
      v.turn.cards = t.cards;
      v.turn.draft = t.rankerDraft;
    }
    if (room.phase === 'guessing') {
      v.turn.submitted = Object.keys(t.guesses).filter(id => t.guesses[id].submitted);
      if (me.id === t.rankerId) {
        v.turn.myRanking = t.ranking.map(id => t.cards[id]);
      } else if (t.eligible.has(me.id)) {
        const g = t.guesses[me.id];
        v.turn.canGuess = true;
        v.turn.cards = t.displayOrder.map(id => t.cards[id]);
        v.turn.draft = g ? g.order : [];
        v.turn.locked = !!(g && g.submitted);
      }
    }
    if (room.phase === 'reveal') v.reveal = revealView(room);
  }
  if (room.phase === 'final') v.final = room.final;
  return v;
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) {
    if (p.connected && p.res) sse(p.res, 'state', view(room, p));
  }
}

/* ------------------------------------------------------------------ */
/*  Game flow                                                          */
/* ------------------------------------------------------------------ */
function startGame(room) {
  room.players.forEach(p => { p.score = 0; });
  room.history = [];
  room.final = null;
  room.draw = [];
  room.baseOrder = shuffle(room.players.map(p => p.id));
  room.round = 1;
  room.roundOrder = [...room.baseOrder];
  room.roundIndex = -1;
  nextTurn(room);
}

function nextTurn(room) {
  clearTimer(room);
  room.roundIndex++;
  if (room.roundIndex >= room.roundOrder.length) {
    room.round++;
    if (room.round > CFG.ROUNDS) return finishGame(room);
    room.roundOrder = room.baseOrder.filter(id => getPlayer(room, id));
    room.roundIndex = 0;
  }
  startTurn(room);
}

function dealHand(room) {
  const hand = [];
  while (hand.length < CFG.HAND) {
    if (room.draw.length === 0) room.draw = shuffle(DECK.filter(c => !hand.includes(c)));
    hand.push(room.draw.pop());
  }
  return hand;
}

function startTurn(room) {
  clearTimer(room);
  const rankerId = room.roundOrder[room.roundIndex];
  if (!getPlayer(room, rankerId)) return nextTurn(room);
  const cards = dealHand(room).map((text, i) => ({ id: i, text }));
  const duration = CFG.RANK_SECONDS * 1000;
  room.turnCounter++;
  room.turn = {
    id: room.turnCounter, rankerId, cards,
    ranking: null, rankerDraft: [], displayOrder: [], guesses: {}, eligible: new Set(),
    duration, endsAt: Date.now() + duration,
    revealStep: 0, positions: [], summary: null, applied: false, stepMs: 0, nextAt: 0,
  };
  room.phase = 'ranking';
  room.timer = setTimeout(() => onRankTimeout(room), duration + 400);
  broadcast(room);
}

function onRankTimeout(room) {
  const t = room.turn;
  if (!t || room.phase !== 'ranking') return;
  const ranker = getPlayer(room, t.rankerId);
  if (!ranker || !ranker.connected) {
    emitAll(room, 'toast', `${ranker ? ranker.name : 'Someone'} wasn't here — skipping their turn`);
    return nextTurn(room);
  }
  const placed = t.rankerDraft.slice();
  const rest = shuffle(t.cards.map(c => c.id).filter(id => !placed.includes(id)));
  t.ranking = [...placed, ...rest];
  emitAll(room, 'toast', `Time's up! ${ranker.name}'s ranking was auto-filled`);
  startGuessing(room);
}

function startGuessing(room) {
  clearTimer(room);
  const t = room.turn;
  let disp = shuffle(t.cards.map(c => c.id));
  if (sameOrder(disp, t.ranking)) disp.push(disp.shift()); // never show the cards pre-sorted
  t.displayOrder = disp;
  t.eligible = new Set(room.players.filter(p => p.connected && p.id !== t.rankerId).map(p => p.id));
  t.guesses = {};
  t.duration = CFG.GUESS_SECONDS * 1000;
  t.endsAt = Date.now() + t.duration;
  room.phase = 'guessing';
  room.timer = setTimeout(() => finalizeGuessing(room), t.duration + 400);
  broadcast(room);
}

// Everyone who is still around (or only just dropped off) has locked in -> don't wait for the clock.
function checkGuessDone(room) {
  const t = room.turn;
  if (!t || room.phase !== 'guessing') return;
  const now = Date.now();
  const present = [...t.eligible].filter(id => {
    const p = getPlayer(room, id);
    return p && (p.connected || now - p.disconnectedAt < CFG.DISCONNECT_GRACE_MS);
  });
  if (present.length && present.every(id => t.guesses[id] && t.guesses[id].submitted)) finalizeGuessing(room);
}

function buildResults(room) {
  const t = room.turn;
  const rows = [];
  for (const pid of t.eligible) {
    const p = getPlayer(room, pid);
    if (!p) continue;
    const g = t.guesses[pid];
    const order = g ? g.order : [];
    let correct = 0;
    for (let i = 0; i < CFG.HAND; i++) if (order[i] === t.ranking[i]) correct++;
    rows.push({ id: pid, name: p.name, order, placed: order.length, correct, perfect: correct === CFG.HAND });
  }
  // positions are revealed from #5 (least favorite) up to #1 (favorite)
  t.positions = [];
  for (let i = 0; i < CFG.HAND; i++) {
    const rank = CFG.HAND - i, idx = rank - 1, trueId = t.ranking[idx];
    t.positions.push({
      rank, card: t.cards[trueId].text,
      guesses: rows.map(r => {
        const gid = r.order[idx];
        return { id: r.id, name: r.name, card: gid == null ? null : t.cards[gid].text, correct: gid === trueId };
      }),
    });
  }
  const perfectCount = rows.filter(r => r.perfect).length;
  const deltas = {};
  rows.forEach(r => { deltas[r.id] = r.correct; });
  const ranker = getPlayer(room, t.rankerId);
  const bonus = perfectCount * CFG.PERFECT_BONUS;
  if (bonus) deltas[t.rankerId] = (deltas[t.rankerId] || 0) + bonus;
  t.summary = {
    rankerId: t.rankerId, rankerName: ranker ? ranker.name : '?',
    ranking: t.ranking.map((id, i) => ({ rank: i + 1, text: t.cards[id].text })),
    rows: rows.slice().sort((a, b) => b.correct - a.correct),
    perfectCount, bonus, deltas,
    missed: room.players.filter(p => p.id !== t.rankerId && !t.eligible.has(p.id)).map(p => p.name),
  };
}

function finalizeGuessing(room) {
  const t = room.turn;
  if (!t || room.phase !== 'guessing') return;
  clearTimer(room);
  buildResults(room);
  if (!t.summary.rows.some(r => r.placed > 0)) {
    emitAll(room, 'toast', 'Nobody guessed — skipping this turn');
    return nextTurn(room);
  }
  room.phase = 'reveal';
  t.revealStep = 0;
  scheduleReveal(room);
  broadcast(room);
}

function scheduleReveal(room) {
  const t = room.turn;
  clearTimer(room);
  const s = t.revealStep;
  if (s >= 10) return enterSummary(room);
  const suspense = s % 2 === 0;
  const rank = CFG.HAND - Math.floor(s / 2);
  t.stepMs = suspense
    ? (rank === 1 ? CFG.FINALE_SUSPENSE_MS : CFG.SUSPENSE_MS)
    : CFG.SHOW_MS + CFG.SHOW_PER_GUESSER_MS * t.summary.rows.length;
  room.timer = setTimeout(() => { t.revealStep++; scheduleReveal(room); broadcast(room); }, t.stepMs);
}

function enterSummary(room) {
  const t = room.turn;
  clearTimer(room);
  if (!t.applied) {
    t.applied = true;
    for (const r of t.summary.rows) { const p = getPlayer(room, r.id); if (p) p.score += r.correct; }
    const rk = getPlayer(room, t.rankerId);
    if (rk) rk.score += t.summary.bonus;
    room.history.push({ rankerId: t.rankerId, rows: t.summary.rows.map(r => ({ id: r.id, correct: r.correct })) });
  }
  t.nextAt = Date.now() + CFG.SUMMARY_MS;
  room.timer = setTimeout(() => nextTurn(room), CFG.SUMMARY_MS);
}

function computeAwards(room) {
  const awards = [];
  const h = room.history;
  if (h.length < 2) return awards;
  const guessTotals = {}, rankerStats = {};
  for (const t of h) {
    for (const r of t.rows) {
      guessTotals[r.id] = (guessTotals[r.id] || 0) + r.correct;
      const s = rankerStats[t.rankerId] || (rankerStats[t.rankerId] = { sum: 0, n: 0 });
      s.sum += r.correct; s.n++;
    }
  }
  const nm = id => { const p = getPlayer(room, id); return p ? p.name : null; };
  const join = ids => ids.map(nm).filter(Boolean).join(' & ');
  const best = (obj, f) => {
    let top = -Infinity, ids = [];
    for (const id of Object.keys(obj)) {
      const v = f(obj[id]);
      if (v > top + 1e-9) { top = v; ids = [id]; } else if (Math.abs(v - top) < 1e-9) ids.push(id);
    }
    return { top, ids };
  };
  const g = best(guessTotals, v => v);
  if (g.ids.length && g.top > 0) awards.push({ icon: '🔮', title: 'Mind Reader', who: join(g.ids), note: `${g.top} cards guessed right` });
  const rk = Object.keys(rankerStats).filter(id => rankerStats[id].n > 0);
  if (rk.length >= 2) {
    const avgs = Object.fromEntries(rk.map(id => [id, rankerStats[id].sum / rankerStats[id].n]));
    const o = best(avgs, v => v), m = best(avgs, v => -v);
    if (o.ids.length < rk.length) {
      awards.push({ icon: '📖', title: 'Open Book', who: join(o.ids), note: `Easiest to read — friends averaged ${o.top.toFixed(1)}/5` });
      awards.push({ icon: '🕵️', title: 'Most Mysterious', who: join(m.ids), note: `Hardest to read — friends averaged ${(-m.top).toFixed(1)}/5` });
    }
  }
  return awards;
}

function finishGame(room) {
  clearTimer(room);
  room.phase = 'final';
  room.turn = null;
  const sorted = room.players.map(p => ({ id: p.id, name: p.name, score: p.score })).sort((a, b) => b.score - a.score);
  const top = sorted.length ? sorted[0].score : 0;
  room.final = {
    standings: sorted.map(s => ({ ...s, place: 1 + sorted.filter(o => o.score > s.score).length, winner: s.score === top })),
    awards: computeAwards(room),
  };
  broadcast(room);
}

/* ------------------------------------------------------------------ */
/*  Players coming and going                                           */
/* ------------------------------------------------------------------ */
function lateJoin(room, p) {
  if (room.phase === 'lobby' || room.phase === 'final') return;
  room.baseOrder.push(p.id);
  room.roundOrder.push(p.id); // they get a turn at the end of the current round
  emitAll(room, 'toast', `${p.name} joined the game`);
}

function removePlayer(room, id) {
  const i = room.players.findIndex(p => p.id === id);
  if (i < 0) return;
  const [p] = room.players.splice(i, 1);
  if (p.lobbyTimer) clearTimeout(p.lobbyTimer);
  if (room.players.length === 0) { clearTimer(room); rooms.delete(room.code); return; }
  broadcast(room);
}

function markDisconnected(room, p) {
  p.connected = false;
  p.res = null;
  p.disconnectedAt = Date.now();
  if (room.phase === 'lobby') {
    if (p.lobbyTimer) clearTimeout(p.lobbyTimer);
    p.lobbyTimer = setTimeout(() => { if (!p.connected) removePlayer(room, p.id); }, CFG.LOBBY_GRACE_MS);
  } else if (room.phase === 'guessing') {
    setTimeout(() => checkGuessDone(room), CFG.DISCONNECT_GRACE_MS + 300);
  }
  broadcast(room);
}

// A brand-new seat that never opens its live stream shouldn't hold a spot forever.
function expectStream(room, p) {
  if (room.phase !== 'lobby') return;
  if (p.lobbyTimer) clearTimeout(p.lobbyTimer);
  p.lobbyTimer = setTimeout(() => { if (!p.connected) removePlayer(room, p.id); }, 20000);
}

function attachStream(room, p, res) {
  const old = p.res;
  if (old && old !== res) { sse(old, 'replaced', {}); try { old.end(); } catch (e) { /* ignore */ } }
  p.res = res;
  p.connected = true;
  p.disconnectedAt = 0;
  if (p.lobbyTimer) { clearTimeout(p.lobbyTimer); p.lobbyTimer = null; }
  // someone who (re)joins while guessing is still on the clock can guess
  const t = room.turn;
  if (room.phase === 'guessing' && t && p.id !== t.rankerId) t.eligible.add(p.id);
}

/* ------------------------------------------------------------------ */
/*  Player actions (everything arrives as POST /api/<action>)          */
/* ------------------------------------------------------------------ */
const isHost = (room, p) => { const h = hostOf(room); return !!h && h.id === p.id; };
const OK = { ok: true };

function act(room, p, type, body) {
  const t = room.turn;
  switch (type) {
    // live progress while ranking/guessing, so a refresh or timeout never loses work
    case 'draft': {
      const o = sanitize(body.order, false);
      if (!t || !o) return OK;
      if (room.phase === 'ranking' && p.id === t.rankerId) t.rankerDraft = o;
      else if (room.phase === 'guessing' && t.eligible.has(p.id)) {
        const g = t.guesses[p.id];
        if (!(g && g.submitted)) t.guesses[p.id] = { order: o, submitted: false };
      }
      return OK;
    }
    case 'submit': {
      const o = sanitize(body.order, true);
      if (!o) return { ok: false, error: 'Place all 5 cards first.' };
      if (room.phase === 'ranking' && t && p.id === t.rankerId) {
        t.ranking = o;
        startGuessing(room);
        return OK;
      }
      if (room.phase === 'guessing' && t && p.id !== t.rankerId && t.eligible.has(p.id)) {
        const g = t.guesses[p.id];
        if (g && g.submitted) return OK;
        t.guesses[p.id] = { order: o, submitted: true };
        broadcast(room);
        checkGuessDone(room);
        return OK;
      }
      return { ok: false, error: "Can't submit right now." };
    }
    case 'start': {
      if (room.phase !== 'lobby' || !isHost(room, p)) return { ok: false };
      room.players = room.players.filter(x => x.connected);
      if (room.players.length < CFG.MIN_PLAYERS) return { ok: false, error: `Need at least ${CFG.MIN_PLAYERS} players to start` };
      startGame(room);
      return OK;
    }
    // One host button that means "move things along" in whatever phase we're in.
    case 'hostSkip': {
      if (!t || !isHost(room, p)) return { ok: false };
      if (room.phase === 'ranking') {
        emitAll(room, 'toast', 'Host skipped this turn');
        nextTurn(room);
      } else if (room.phase === 'guessing') {
        finalizeGuessing(room);
      } else if (room.phase === 'reveal') {
        if (t.revealStep < 10) { t.revealStep = 10; scheduleReveal(room); broadcast(room); } else nextTurn(room);
      }
      return OK;
    }
    case 'kick': {
      if (room.phase !== 'lobby' || !isHost(room, p) || body.target === p.id) return { ok: false };
      const target = getPlayer(room, String(body.target || ''));
      if (!target) return { ok: false };
      if (target.res) { sse(target.res, 'kicked', {}); try { target.res.end(); } catch (e) { /* ignore */ } target.res = null; }
      removePlayer(room, target.id);
      return OK;
    }
    case 'playAgain': {
      if (room.phase !== 'final' || !isHost(room, p)) return { ok: false };
      clearTimer(room);
      room.players.forEach(x => { x.score = 0; });
      room.phase = 'lobby';
      room.turn = null; room.final = null; room.history = [];
      room.round = 0; room.roundIndex = -1; room.roundOrder = []; room.baseOrder = [];
      broadcast(room);
      return OK;
    }
    case 'leave': {
      const res = p.res;
      p.res = null;
      if (res) { try { res.end(); } catch (e) { /* ignore */ } }
      if (room.phase === 'lobby') removePlayer(room, p.id); else markDisconnected(room, p);
      return OK;
    }
    default:
      return { ok: false, error: 'Unknown action' };
  }
}

/* ------------------------------------------------------------------ */
/*  HTTP                                                               */
/* ------------------------------------------------------------------ */
const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/logo.png': ['logo.png', 'image/png'],
  '/icon.png': ['icon.png', 'image/png'],
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 20000) { b = ''; req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function serveStatic(req, res, pathname) {
  let entry = STATIC[pathname];
  if (!entry && /^\/[A-Za-z]{4}\/?$/.test(pathname)) entry = STATIC['/']; // invite links: /KFTB
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  fs.readFile(path.join(PUBLIC, entry[0]), (err, data) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache', 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function handleStream(req, res, url) {
  const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
  const p = room && getPlayer(room, String(url.searchParams.get('pid') || ''));
  if (!p) return sendJson(res, 404, { ok: false, gone: true });
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true, 15000);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  attachStream(room, p, res);
  req.on('close', () => { if (p.res === res) markDisconnected(room, p); });
  broadcast(room); // everyone sees them appear; they get their first state
}

async function handleApi(req, res, action) {
  const body = await readJson(req);

  if (action === 'create') {
    const name = cleanName(body.name);
    if (!name) return sendJson(res, 200, { ok: false, error: 'Enter your name first.' });
    if (rooms.size >= 300) return sendJson(res, 200, { ok: false, error: 'The server is busy — try again in a bit.' });
    const room = newRoom(makeCode());
    rooms.set(room.code, room);
    const p = addPlayer(room, name);
    room.hostId = p.id;
    expectStream(room, p);
    return sendJson(res, 200, { ok: true, code: room.code, pid: p.id, name: p.name });
  }

  if (action === 'join') {
    const code = String(body.room || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    const room = rooms.get(code);
    if (!room) return sendJson(res, 200, { ok: false, gone: true, error: 'Room not found — check the code, or ask for a fresh link.' });
    let p = body.pid ? getPlayer(room, String(body.pid)) : null;
    if (!p) {
      const name = cleanName(body.name);
      if (!name) return sendJson(res, 200, { ok: false, error: 'Enter your name to join.' });
      const same = room.players.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (same) {
        if (same.connected) return sendJson(res, 200, { ok: false, error: `Someone named "${same.name}" is already in this room — pick a different name.` });
        p = same; // reclaim a seat that dropped off
      } else {
        if (room.players.length >= CFG.MAX_PLAYERS) return sendJson(res, 200, { ok: false, error: `This room is full (${CFG.MAX_PLAYERS} players).` });
        p = addPlayer(room, name);
        lateJoin(room, p);
        expectStream(room, p);
      }
    }
    return sendJson(res, 200, { ok: true, code: room.code, pid: p.id, name: p.name });
  }

  const room = rooms.get(String(body.room || '').toUpperCase());
  const p = room && getPlayer(room, String(body.pid || ''));
  if (!p) return sendJson(res, 404, { ok: false, gone: true, error: 'Not in a game.' });
  room.lastActive = Date.now();
  return sendJson(res, 200, act(room, p, action, body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/stream') return handleStream(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname.slice(5));
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error('request error:', e);
    try { sendJson(res, 500, { ok: false, error: 'Server error' }); } catch (e2) { /* ignore */ }
  }
});

// Keep every live stream warm (proxies close idle connections) and tidy up abandoned rooms.
setInterval(() => {
  for (const room of rooms.values()) {
    for (const p of room.players) if (p.res) sse(p.res, 'ping', 1);
  }
}, CFG.KEEPALIVE_MS).unref();
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.players.some(p => p.connected) && now - room.lastActive > 3 * 3600 * 1000) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

process.on('uncaughtException', e => console.error('uncaught:', e));

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Best guess? is running\n  ➜ On this computer:  http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) console.log(`  ➜ Phones on the same Wi-Fi: http://${i.address}:${PORT}`);
      }
    }
    console.log('');
  });
}

module.exports = { server, rooms, CFG };
