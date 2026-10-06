const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname + '/public'));

const MAX_PLAYERS = 3;

// Map settings. Hard is 99 mines on 16x30 (about 20.6%); the other difficulties are fixed shares of the board.
const SIZES = { small: [9, 9], medium: [16, 16], large: [16, 30], xl: [24, 30] };
const RATES = { easy: 0.12, intermediate: 0.15, hard: 99 / 480, expert: 0.25 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function cleanSettings(s) {
  s = s || {};
  const difficulty = RATES[s.difficulty] ? s.difficulty : 'hard';
  const size = SIZES[s.size] || s.size === 'custom' ? s.size : 'large';
  let rows, cols, mines;
  if (size === 'custom') {
    rows = clamp(Math.floor(Number(s.rows)) || 0, 5, 40);
    cols = clamp(Math.floor(Number(s.cols)) || 0, 5, 40);
    mines = clamp(Math.floor(Number(s.mines)) || 0, 1, rows * cols - 9); // first click keeps 9 squares mine-free
  } else {
    [rows, cols] = SIZES[size];
    mines = clamp(Math.round(rows * cols * RATES[difficulty]), 1, rows * cols - 9);
  }
  return { size, difficulty, rows, cols, mines };
}
const COLORS = ['#ff5d6c', '#4da3ff', '#4cd96f'];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const rooms = new Map();

// Leaderboard: every won game is saved with its date and clear time, fastest first.
let board = [];
const sameMap = (e, c) => (e.rows || 16) === c.rows && (e.cols || 30) === c.cols && (e.mines || 99) === c.mines;
const top = (c) => board.filter((e) => sameMap(e, c)).sort((a, b) => a.ms - b.ms).slice(0, 10);

// Player stats. Guests aren't tracked. A game counts as played for anyone who made a move in it.
let stats = {};
let replays = []; // saved replay index, newest first

// A replay is a move log plus the mine layout, so it stays tiny (a few KB) compared with video.
// Offered after any win, or after a loss that lasted more than 120 seconds.
function makeReplay(r) {
  const g = r.game, ms = g.end - g.start;
  if (g.status === 'lost' && ms <= 120000) return;
  g.rp = {
    saved: false,
    data: {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      date: new Date().toISOString(),
      status: g.status,
      ms,
      rows: g.R,
      cols: g.C,
      players: g.pl.map(({ name, color }) => ({ name, color })),
      mines: g.mines.flatMap((m, i) => (m ? [i] : [])),
      ev: g.ev,
    },
  };
}
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
  save('stats', stats);
  io.to(r.code).emit('stats', stats);
}
function record(r) {
  const g = r.game;
  board.push({ date: new Date().toISOString(), ms: g.end - g.start, rows: g.R, cols: g.C, mines: g.M, players: [...r.players.values()].map((p) => p.name) });
  const same = board.filter((e) => sameMap(e, r.settings)).sort((a, b) => a.ms - b.ms).slice(0, 50);
  board = board.filter((e) => !sameMap(e, r.settings)).concat(same); // keep the 50 fastest per map
  save('leaderboard', board);
  io.to(r.code).emit('board', top(r.settings));
}

const nbrs = (g, i) => {
  const { R, C } = g, r = (i / C) | 0, c = i % C, out = [];
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if ((dr || dc) && rr >= 0 && rr < R && cc >= 0 && cc < C) out.push(rr * C + cc);
    }
  return out;
};
const count = (g, i) => nbrs(g, i).filter((n) => g.mines[n]).length;

const newGame = (cfg) => ({
  R: cfg.rows,
  C: cfg.cols,
  M: cfg.mines,
  N: cfg.rows * cfg.cols,
  mines: null,
  rev: Array(cfg.rows * cfg.cols).fill(false),
  flag: Array(cfg.rows * cfg.cols).fill(false),
  status: 'ready', // ready -> playing -> won | lost
  start: 0,
  end: 0,
  by: '',
  ps: {}, // per-player counts for this game
  ev: [], // replay log: [ms since first move, player slot, 0 reveal / 1 flag / 2 cursor, data]
  pl: [], // replay: players who acted
  t0: 0,
  rp: null, // replay offered once the game ends
});

// Mines are placed on the first click, keeping that cell and its neighbours safe.
function place(g, first) {
  const safe = new Set([first, ...nbrs(g, first)]);
  const pool = [...Array(g.N).keys()].filter((i) => !safe.has(i));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  g.mines = Array(g.N).fill(false);
  pool.slice(0, g.M).forEach((i) => (g.mines[i] = true));
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
    if (count(g, j) === 0) stack.push(...nbrs(g, j));
  }
}

function settle(g) {
  if (g.status === 'playing' && g.rev.filter(Boolean).length === g.N - g.M) {
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
    rp: g.rp ? { saved: g.rp.saved } : null,
    rows: g.R,
    cols: g.C,
    mines: g.M,
    set: r.settings,
    left: g.M - g.flag.filter(Boolean).length,
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
    socket.emit('board', top(r.settings));
    socket.emit('stats', stats);
    socket.emit('replays', replays);
    io.to(r.code).emit('state', snapshot(r));
  };

  socket.on('create', ({ name, pid: id, settings } = {}, ack) => {
    if (room) return;
    if (!okId(id)) return ack({ error: 'Please refresh the page and try again.' });
    const cfg = cleanSettings(settings);
    const r = { code: makeCode(), players: new Map(), settings: cfg, game: newGame(cfg), timer: null };
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

  // Add one event to this game's replay log.
  const note = (g, type, data) => {
    let k = g.pl.findIndex((p) => p.id === pid);
    if (k < 0) {
      const p = room.players.get(pid);
      k = g.pl.push({ id: pid, name: p.name, color: p.color }) - 1;
    }
    g.t0 = g.t0 || Date.now();
    g.ev.push([Date.now() - g.t0, k, type, data]);
  };

  const act = (i, fn) => {
    if (!room || !Number.isInteger(i) || i < 0 || i >= room.game.N) return;
    const g = room.game;
    if (g.status === 'won' || g.status === 'lost') return;
    g.by = room.players.get(pid).name;
    fn(g);
    settle(g);
    if (g.status === 'won') record(room);
    if (g.status === 'won' || g.status === 'lost') { tally(room); makeReplay(room); }
    io.to(room.code).emit('state', snapshot(room));
  };

  // Revealing an already-open number "chords": opens neighbours if enough flags surround it.
  socket.on('reveal', (i) =>
    act(i, (g) => {
      const ps = pstat(g), before = g.rev.slice();
      if (!g.rev[i]) {
        reveal(g, i);
        if (g.rev[i] && !g.mines[i]) ps.reveals++; // only the clicked square counts, and only if it isn't a mine
      } else if (count(g, i) === nbrs(g, i).filter((n) => g.flag[n]).length) nbrs(g, i).forEach((n) => reveal(g, n));
      if (g.status === 'lost') ps.mines++; // this click hit the mine
      // Record what this click opened as cell * 16 + value (0-8 number, 9 mine).
      const opened = [];
      g.rev.forEach((o, c) => { if (o && !before[c]) opened.push(c * 16 + (g.mines[c] ? 9 : count(g, c))); });
      if (opened.length) note(g, 0, opened);
    })
  );

  socket.on('flag', (i) => act(i, (g) => { pstat(g); if (!g.rev[i]) { g.flag[i] = !g.flag[i]; note(g, 1, i); } }));

  socket.on('cursor', (i) => {
    if (!room || !Number.isInteger(i) || i < 0 || i >= room.game.N) return;
    socket.to(room.code).emit('cursor', { id: pid, i });
    const g = room.game;
    if (g.status === 'playing' && g.ev.length < 5000) note(g, 2, i); // cap keeps replays small
  });

  // Watching is private: only the asking player gets the replay. Saving is shared by the whole room.
  const reply = (ack, v) => typeof ack === 'function' && ack(v);
  socket.on('getReplay', (ack) => reply(ack, room && room.game.rp ? room.game.rp.data : null));

  socket.on('saveReplay', () => {
    const g = room && room.game;
    if (!g || !g.rp || g.rp.saved) return;
    g.rp.saved = true;
    const d = g.rp.data;
    save('replay-' + d.id, d);
    replays.unshift({ id: d.id, date: d.date, status: d.status, ms: d.ms, players: d.players.map((p) => p.name) });
    replays.splice(200).forEach((old) => drop('replay-' + old.id)); // keep only the newest 200
    save('replays', replays);
    io.emit('replays', replays);
    io.to(room.code).emit('state', snapshot(room));
  });

  socket.on('loadReplay', (id, ack) => {
    if (!/^[a-z0-9]{4,20}$/.test(String(id))) return reply(ack, null);
    load('replay-' + id, null).then((d) => reply(ack, d)).catch(() => reply(ack, null));
  });

  // Changing the map starts a fresh game for everyone in the room.
  socket.on('settings', (s) => {
    if (!room) return;
    const cfg = cleanSettings(s), cur = room.settings;
    room.settings = cfg;
    if (cfg.rows !== cur.rows || cfg.cols !== cur.cols || cfg.mines !== cur.mines) {
      clearTimeout(room.timer);
      room.game = newGame(cfg);
    }
    io.to(room.code).emit('board', top(cfg));
    io.to(room.code).emit('state', snapshot(room));
  });

  socket.on('restart', () => {
    if (!room || !['won', 'lost'].includes(room.game.status)) return;
    room.game = newGame(room.settings);
    io.to(room.code).emit('state', snapshot(room));
  });

  const exit = () => {
    const r = room, p = r && r.players.get(pid);
    if (!p || p.sid !== socket.id) return; // seat already taken over by a newer connection
    r.players.delete(pid);
    if (r.players.size) io.to(r.code).emit('state', snapshot(r));
    else r.timer = setTimeout(() => rooms.delete(r.code), 5 * 60 * 1000); // keep an empty room briefly
  };
  socket.on('disconnect', exit);
  // Home button: leave the room (leave the socket room first so we don't get the update that follows).
  socket.on('leave', () => {
    const r = room;
    if (r) socket.leave(r.code);
    exit();
    room = null;
  });
});

// Storage: Upstash Redis when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set (survives
// restarts and redeploys); otherwise local files, which a free host erases on restart.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

async function redis(cmd) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const out = await res.json();
  if (!res.ok || out.error) throw new Error(out.error || `HTTP ${res.status}`);
  return out.result;
}
const fileFor = (key) => path.join(process.env.DATA_DIR || __dirname, key + '.json');

async function load(key, fallback) {
  if (useRedis) {
    const v = await redis(['GET', 'minesweeper:' + key]);
    return v ? JSON.parse(v) : fallback;
  }
  try { return JSON.parse(fs.readFileSync(fileFor(key), 'utf8')); } catch (e) { return fallback; }
}

function save(key, data) {
  const json = JSON.stringify(data);
  const job = useRedis ? redis(['SET', 'minesweeper:' + key, json]) : fs.promises.writeFile(fileFor(key), json);
  job.catch((e) => console.error(`Could not save ${key}:`, e.message));
}

function drop(key) {
  const job = useRedis ? redis(['DEL', 'minesweeper:' + key]) : fs.promises.unlink(fileFor(key));
  job.catch(() => {});
}

// Load saved data before accepting players. If the database can't be reached, exit (the host restarts
// us) instead of starting empty and overwriting saved results.
(async () => {
  let err;
  for (let tries = 0; tries < 5; tries++) {
    try {
      board = await load('leaderboard', []);
      stats = await load('stats', {});
      replays = await load('replays', []);
      server.listen(process.env.PORT || 3000, () =>
        console.log(`Co-op Minesweeper is running (saving to ${useRedis ? 'Redis' : 'local files'})`));
      return;
    } catch (e) {
      err = e;
      console.error('Could not load saved data, retrying:', e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error('Giving up:', err.message);
  process.exit(1);
})();
