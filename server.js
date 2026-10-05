const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname + '/public'));

const R = 16, C = 30, M = 99, N = R * C, MAX_PLAYERS = 3;
const COLORS = ['#ff5d6c', '#4da3ff', '#4cd96f'];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const rooms = new Map();

// Leaderboard: every won game is saved with its date and clear time, fastest first.
const LB_FILE = path.join(process.env.DATA_DIR || __dirname, 'leaderboard.json');
let board = [];
try { board = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); } catch (e) { /* no file yet */ }
const top = () => board.slice(0, 10);

// Player stats. Guests aren't tracked. A game counts as played for anyone who made a move in it.
const STATS_FILE = path.join(process.env.DATA_DIR || __dirname, 'stats.json');
let stats = {};
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (e) { /* no file yet */ }
const pstat = (g) => (g.ps[g.by] ||= { reveals: 0, mines: 0 });
function tally(r) {
  const g = r.game;
  for (const [name, s] of Object.entries(g.ps)) {
    if (name === 'Guest' || !NAMES.includes(name)) continue;
    const t = (stats[name] ||= { games: 0, wins: 0, mines: 0, reveals: 0, ms: 0 });
    t.games++;
    if (g.status === 'won') t.wins++;
    t.mines += s.mines;
    t.reveals += s.reveals;
    t.ms += g.end - g.start;
  }
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch (e) { console.error('Could not save stats:', e.message); }
  io.to(r.code).emit('stats', stats);
}
function record(r) {
  const g = r.game;
  board.push({ date: new Date().toISOString(), ms: g.end - g.start, players: [...r.players.values()].map((p) => p.name) });
  board.sort((a, b) => a.ms - b.ms);
  board = board.slice(0, 200);
  try { fs.writeFileSync(LB_FILE, JSON.stringify(board)); } catch (e) { console.error('Could not save leaderboard:', e.message); }
  io.to(r.code).emit('board', top());
}

const nbrs = (i) => {
  const r = (i / C) | 0, c = i % C, out = [];
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if ((dr || dc) && rr >= 0 && rr < R && cc >= 0 && cc < C) out.push(rr * C + cc);
    }
  return out;
};
const count = (g, i) => nbrs(i).filter((n) => g.mines[n]).length;

const newGame = () => ({
  mines: null,
  rev: Array(N).fill(false),
  flag: Array(N).fill(false),
  status: 'ready', // ready -> playing -> won | lost
  start: 0,
  end: 0,
  by: '',
  ps: {}, // per-player counts for this game
});

// Mines are placed on the first click, keeping that cell and its neighbours safe.
function place(g, first) {
  const safe = new Set([first, ...nbrs(first)]);
  const pool = [...Array(N).keys()].filter((i) => !safe.has(i));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  g.mines = Array(N).fill(false);
  pool.slice(0, M).forEach((i) => (g.mines[i] = true));
  g.status = 'playing';
  g.start = Date.now();
}

function reveal(g, i) {
  if (g.rev[i] || g.flag[i]) return;
  if (!g.mines) place(g, i);
  const stack = [i];
  while (stack.length && g.status === 'playing') {
    const j = stack.pop();
    if (g.rev[j] || g.flag[j]) continue;
    g.rev[j] = true;
    if (g.mines[j]) { g.status = 'lost'; return; }
    if (count(g, j) === 0) stack.push(...nbrs(j));
  }
}

function settle(g) {
  if (g.status === 'playing' && g.rev.filter(Boolean).length === N - M) {
    g.status = 'won';
    g.mines.forEach((m, i) => { if (m) g.flag[i] = true; });
  }
  if (g.status === 'won' || g.status === 'lost') g.end = Date.now();
}

// Cell codes: -1 hidden, -2 flag, 0-8 revealed, 9 mine, 10 exploded, 11 wrong flag.
// Mine positions are never sent until the game is lost.
function snapshot(r) {
  const g = r.game, lost = g.status === 'lost';
  const cells = g.rev.map((open, i) => {
    if (open) return g.mines[i] ? 10 : count(g, i);
    if (lost && g.mines[i] && !g.flag[i]) return 9;
    if (lost && g.flag[i] && !g.mines[i]) return 11;
    return g.flag[i] ? -2 : -1;
  });
  const end = g.status === 'playing' ? Date.now() : g.end;
  return {
    code: r.code,
    cells,
    status: g.status,
    by: g.by,
    left: M - g.flag.filter(Boolean).length,
    elapsed: g.start ? end - g.start : 0,
    players: [...r.players].map(([id, p]) => ({ id, name: p.name, color: p.color })),
  };
}

const makeCode = () => {
  let code;
  do code = Array.from({ length: 4 }, () => LETTERS[(Math.random() * LETTERS.length) | 0]).join('');
  while (rooms.has(code));
  return code;
};
const NAMES = ['Ayis', 'Bryan', 'Mollie', 'David', 'Guest'];
const cleanName = (n) => (NAMES.includes(n) ? n : 'Guest');
const okId = (p) => typeof p === 'string' && /^[\w-]{8,40}$/.test(p);

io.on('connection', (socket) => {
  let room = null, pid = null;

  // Players are keyed by a per-browser id, so someone who drops can reconnect into their old seat.
  const enter = (r, name, id) => {
    const old = r.players.get(id);
    const used = new Set([...r.players.values()].map((p) => p.color));
    r.players.set(id, { name, color: old ? old.color : COLORS.find((c) => !used.has(c)), sid: socket.id });
    clearTimeout(r.timer);
    room = r;
    pid = id;
    socket.join(r.code);
    socket.emit('board', top());
    socket.emit('stats', stats);
    io.to(r.code).emit('state', snapshot(r));
  };

  socket.on('create', ({ name, pid: id } = {}, ack) => {
    if (room) return;
    if (!okId(id)) return ack({ error: 'Please refresh the page and try again.' });
    const r = { code: makeCode(), players: new Map(), game: newGame(), timer: null };
    rooms.set(r.code, r);
    enter(r, cleanName(name), id);
    ack({ ok: true });
  });

  socket.on('join', ({ code, name, pid: id } = {}, ack) => {
    if (room) return;
    if (!okId(id)) return ack({ error: 'Please refresh the page and try again.' });
    const r = rooms.get(String(code || '').trim().toUpperCase());
    if (!r) return ack({ error: 'Room not found. Check the code.' });
    if (!r.players.has(id) && r.players.size >= MAX_PLAYERS) return ack({ error: 'Room is full (3 players max).' });
    const nm = cleanName(name);
    if (nm !== 'Guest' && [...r.players].some(([k, p]) => k !== id && p.name === nm)) return ack({ error: `${nm} is already in this room.` });
    enter(r, nm, id);
    ack({ ok: true });
  });

  const act = (i, fn) => {
    if (!room || !Number.isInteger(i) || i < 0 || i >= N) return;
    const g = room.game;
    if (g.status === 'won' || g.status === 'lost') return;
    g.by = room.players.get(pid).name;
    fn(g);
    settle(g);
    if (g.status === 'won') record(room);
    if (g.status === 'won' || g.status === 'lost') tally(room);
    io.to(room.code).emit('state', snapshot(room));
  };

  // Revealing an already-open number "chords": opens neighbours if enough flags surround it.
  socket.on('reveal', (i) =>
    act(i, (g) => {
      const ps = pstat(g), before = g.rev.filter(Boolean).length;
      if (!g.rev[i]) reveal(g, i);
      else if (count(g, i) === nbrs(i).filter((n) => g.flag[n]).length) nbrs(i).forEach((n) => reveal(g, n));
      if (g.rev.filter(Boolean).length > before) ps.reveals++; // a click that opened at least one cell
      if (g.status === 'lost') ps.mines++; // this click hit the mine
    })
  );

  socket.on('flag', (i) => act(i, (g) => { pstat(g); if (!g.rev[i]) g.flag[i] = !g.flag[i]; }));

  socket.on('cursor', (i) => {
    if (room && Number.isInteger(i)) socket.to(room.code).emit('cursor', { id: pid, i });
  });

  socket.on('restart', () => {
    if (!room || !['won', 'lost'].includes(room.game.status)) return;
    room.game = newGame();
    io.to(room.code).emit('state', snapshot(room));
  });

  socket.on('disconnect', () => {
    const r = room, p = r && r.players.get(pid);
    if (!p || p.sid !== socket.id) return; // seat already taken over by a newer connection
    r.players.delete(pid);
    if (r.players.size) io.to(r.code).emit('state', snapshot(r));
    else r.timer = setTimeout(() => rooms.delete(r.code), 5 * 60 * 1000); // keep an empty room briefly
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Co-op Minesweeper is running'));
