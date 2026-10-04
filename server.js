const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname + '/public'));

const R = 16, C = 30, M = 99, N = R * C, MAX_PLAYERS = 3;
const COLORS = ['#ff5d6c', '#4da3ff', '#4cd96f'];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const rooms = new Map();

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
    players: [...r.players].map(([id, p]) => ({ id, ...p })),
  };
}

const makeCode = () => {
  let code;
  do code = Array.from({ length: 4 }, () => LETTERS[(Math.random() * LETTERS.length) | 0]).join('');
  while (rooms.has(code));
  return code;
};
const cleanName = (n) => String(n || '').trim().slice(0, 12) || 'Player';

io.on('connection', (socket) => {
  let room = null;

  const enter = (r, name) => {
    const used = new Set([...r.players.values()].map((p) => p.color));
    r.players.set(socket.id, { name, color: COLORS.find((c) => !used.has(c)) });
    room = r;
    socket.join(r.code);
    io.to(r.code).emit('state', snapshot(r));
  };

  socket.on('create', (name, ack) => {
    if (room) return;
    const r = { code: makeCode(), players: new Map(), game: newGame() };
    rooms.set(r.code, r);
    enter(r, cleanName(name));
    ack({ ok: true });
  });

  socket.on('join', ({ code, name } = {}, ack) => {
    if (room) return;
    const r = rooms.get(String(code || '').trim().toUpperCase());
    if (!r) return ack({ error: 'Room not found. Check the code.' });
    if (r.players.size >= MAX_PLAYERS) return ack({ error: 'Room is full (3 players max).' });
    enter(r, cleanName(name));
    ack({ ok: true });
  });

  const act = (i, fn) => {
    if (!room || !Number.isInteger(i) || i < 0 || i >= N) return;
    const g = room.game;
    if (g.status === 'won' || g.status === 'lost') return;
    g.by = room.players.get(socket.id).name;
    fn(g);
    settle(g);
    io.to(room.code).emit('state', snapshot(room));
  };

  // Revealing an already-open number "chords": opens neighbours if enough flags surround it.
  socket.on('reveal', (i) =>
    act(i, (g) => {
      if (!g.rev[i]) return reveal(g, i);
      if (count(g, i) === nbrs(i).filter((n) => g.flag[n]).length) nbrs(i).forEach((n) => reveal(g, n));
    })
  );

  socket.on('flag', (i) => act(i, (g) => { if (!g.rev[i]) g.flag[i] = !g.flag[i]; }));

  socket.on('cursor', (i) => {
    if (room && Number.isInteger(i)) socket.to(room.code).emit('cursor', { id: socket.id, i });
  });

  socket.on('restart', () => {
    if (!room || !['won', 'lost'].includes(room.game.status)) return;
    room.game = newGame();
    io.to(room.code).emit('state', snapshot(room));
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.players.delete(socket.id);
    if (!room.players.size) rooms.delete(room.code);
    else io.to(room.code).emit('state', snapshot(room));
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Co-op Minesweeper is running'));
