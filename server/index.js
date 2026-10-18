const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Table } = require('./poker/table');
const store = require('./store');
const { BotManager } = require('./bots');

const PORT = process.env.PORT || 3000;
const RECONNECT_GRACE_MS = 90_000;

const TABLE_CONFIGS = [
  // Bots fill this one whenever a human sits down, so you can always get a game.
  { id: 'practice', name: 'Practice Table', sb: 5, bb: 10, bots: true },
  { id: 'penny', name: 'Penny Ante', sb: 1, bb: 2 },
  { id: 'porch', name: 'The Front Porch', sb: 5, bb: 10 },
  { id: 'vfw', name: 'VFW Hall', sb: 10, bb: 20 },
  { id: 'backroom', name: 'The Back Room', sb: 25, bb: 50 },
  { id: 'highroller', name: 'High Rollers', sb: 100, bb: 200 },
];

// Optional TURN server for players behind strict NATs (see README).
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) {
  ICE_SERVERS.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
}

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, file) {
    if (file.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
    if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
const server = http.createServer(app);
const io = new Server(server);

const room = (id) => `table:${id}`;
const voiceRoom = (id) => `voice:${id}`;
const socketsIn = (name) => [...(io.sockets.adapter.rooms.get(name) || [])].map((id) => io.sockets.sockets.get(id)).filter(Boolean);

// ---------- table broadcasting ----------
let lobbyTimer = null;
function broadcastLobby() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    io.to('lobby').emit('lobby', lobbySummary());
  }, 250);
}
const lobbySummary = () => [...tables.values()].map((t) => t.summary());

function sendBankroll(playerId) {
  const p = store.get(playerId);
  if (!p) return;
  for (const s of playerSockets.get(playerId) || []) io.to(s).emit('bankroll', p.bankroll);
}

const bots = new BotManager();
const hooks = {
  update(table) {
    bots.onUpdate(table);
    for (const s of socketsIn(room(table.id))) s.emit('table:state', table.view(s.data.playerId));
    broadcastLobby();
  },
  event(table, evt) { io.to(room(table.id)).emit('table:event', evt); },
  cashout(playerId, amount) { store.adjust(playerId, amount); sendBankroll(playerId); },
};

const tables = new Map(TABLE_CONFIGS.map((cfg) => [cfg.id, new Table(cfg, hooks)]));
const findSeatedTable = (playerId) => [...tables.values()].find((t) => t.seatOf(playerId) !== -1);

// ---------- connection tracking ----------
const playerSockets = new Map(); // playerId -> Set(socketId)
const dropTimers = new Map();    // playerId -> timeout for standing up after disconnect

function standUp(playerId) {
  const t = findSeatedTable(playerId);
  if (!t) return;
  const cash = t.stand(playerId);
  if (cash > 0) store.adjust(playerId, cash);
  sendBankroll(playerId);
}

function leaveVoice(socket) {
  const t = socket.data.voiceTable;
  if (!t) return;
  socket.leave(voiceRoom(t));
  socket.to(voiceRoom(t)).emit('voice:peer-left', socket.id);
  socket.data.voiceTable = null;
}

function leaveTableView(socket) {
  const t = socket.data.tableId;
  if (!t) return;
  leaveVoice(socket);
  socket.leave(room(t));
  socket.data.tableId = null;
}

io.on('connection', (socket) => {
  const player = () => store.get(socket.data.playerId);
  const ok = (cb, data = {}) => typeof cb === 'function' && cb({ ok: true, ...data });
  const fail = (cb, error) => typeof cb === 'function' && cb({ error });

  socket.on('hello', ({ token, name } = {}, cb) => {
    const { token: tok, player: p } = store.login(token, name);
    socket.data.playerId = p.id;
    if (!playerSockets.has(p.id)) playerSockets.set(p.id, new Set());
    playerSockets.get(p.id).add(socket.id);
    clearTimeout(dropTimers.get(p.id));
    dropTimers.delete(p.id);

    const seated = findSeatedTable(p.id);
    if (seated) seated.setDisconnected(p.id, false);
    socket.join('lobby');
    ok(cb, {
      token: tok,
      player: { id: p.id, name: p.name, color: p.color, bankroll: p.bankroll },
      tables: lobbySummary(),
      resumeTableId: seated ? seated.id : null,
      iceServers: ICE_SERVERS,
    });
  });

  socket.on('table:watch', ({ tableId } = {}, cb) => {
    const t = tables.get(tableId);
    if (!t || !player()) return fail(cb, 'No such table');
    if (socket.data.tableId !== tableId) {
      leaveTableView(socket);
      socket.join(room(tableId));
      socket.data.tableId = tableId;
    }
    ok(cb, { state: t.view(socket.data.playerId) });
  });

  socket.on('table:leave', (_, cb) => {
    leaveTableView(socket);
    ok(cb);
  });

  socket.on('table:sit', ({ seat, buyIn } = {}, cb) => {
    const p = player();
    const t = tables.get(socket.data.tableId);
    if (!p || !t) return fail(cb, 'Open a table first');
    const other = findSeatedTable(p.id);
    if (other && other !== t) return fail(cb, `You're already seated at ${other.name}`);
    buyIn = Math.floor(Number(buyIn));
    if (!(buyIn <= p.bankroll)) return fail(cb, 'Not enough play money — hit Refill in the lobby');
    store.adjust(p.id, -buyIn);
    const res = t.sit(seat, p, buyIn);
    if (res.error) { store.adjust(p.id, buyIn); return fail(cb, res.error); }
    sendBankroll(p.id);
    ok(cb);
  });

  socket.on('table:stand', (_, cb) => { if (player()) standUp(socket.data.playerId); ok(cb); });

  socket.on('table:action', ({ action, amount } = {}, cb) => {
    const t = tables.get(socket.data.tableId);
    if (!t) return fail(cb, 'No table');
    const res = t.act(socket.data.playerId, action, amount);
    res.error ? fail(cb, res.error) : ok(cb);
  });

  socket.on('table:rebuy', ({ amount } = {}, cb) => {
    const p = player();
    const t = tables.get(socket.data.tableId);
    if (!p || !t) return fail(cb, 'No table');
    amount = Math.floor(Number(amount));
    if (!(amount > 0 && amount <= p.bankroll)) return fail(cb, 'Not enough play money');
    const res = t.rebuy(p.id, amount);
    if (res.error) return fail(cb, res.error);
    store.adjust(p.id, -amount);
    sendBankroll(p.id);
    ok(cb);
  });

  socket.on('table:sitout', ({ value } = {}) => {
    const t = tables.get(socket.data.tableId);
    if (t) t.setSittingOut(socket.data.playerId, value);
  });

  socket.on('bankroll:refill', (_, cb) => {
    const p = store.refill(socket.data.playerId);
    if (p) sendBankroll(p.id);
    ok(cb);
  });

  let lastChat = 0;
  socket.on('chat', ({ text } = {}) => {
    const p = player();
    const t = socket.data.tableId;
    const now = Date.now();
    if (!p || !t || now - lastChat < 600) return;
    lastChat = now;
    const clean = String(text || '').trim().slice(0, 200);
    if (clean) io.to(room(t)).emit('table:chat', { name: p.name, color: p.color, text: clean });
  });

  // ---------- voice chat signaling (WebRTC mesh per table) ----------
  socket.on('voice:join', () => {
    const p = player();
    const t = socket.data.tableId;
    if (!p || !t || socket.data.voiceTable === t) return;
    const peers = socketsIn(voiceRoom(t)).map((s) => ({ id: s.id, playerId: s.data.playerId }));
    socket.to(voiceRoom(t)).emit('voice:peer-joined', { id: socket.id, playerId: p.id });
    socket.join(voiceRoom(t));
    socket.data.voiceTable = t;
    socket.emit('voice:peers', peers);
  });

  socket.on('voice:leave', () => leaveVoice(socket));

  socket.on('voice:signal', ({ to, data } = {}) => {
    const target = io.sockets.sockets.get(to);
    if (!target || !socket.data.voiceTable || target.data.voiceTable !== socket.data.voiceTable) return;
    target.emit('voice:signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    leaveTableView(socket);
    const id = socket.data.playerId;
    if (!id) return;
    const set = playerSockets.get(id);
    set.delete(socket.id);
    if (set.size > 0) return;
    playerSockets.delete(id);
    const t = findSeatedTable(id);
    if (!t) return;
    t.setDisconnected(id, true);
    dropTimers.set(id, setTimeout(() => { dropTimers.delete(id); standUp(id); }, RECONNECT_GRACE_MS));
  });
});

server.listen(PORT, () => console.log(`Old Guys Poker running at http://localhost:${PORT}`));
