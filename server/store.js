// Play-money bankrolls, persisted to a small JSON file. No real money, ever.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'players.json');
const STARTING_BANKROLL = 10000;
const COLORS = ['#e76f51', '#2a9d8f', '#e9c46a', '#8ab17d', '#6d597a', '#457b9d', '#d62828', '#f4a261', '#3a86ff', '#bc6c25'];

let byToken = {};
try { byToken = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first run */ }
const byId = new Map(Object.values(byToken).map((p) => [p.id, p]));

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFile(FILE, JSON.stringify(byToken, null, 1), () => {});
  }, 500);
}

/** Write immediately (used on shutdown). */
function flush() {
  clearTimeout(saveTimer);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(byToken, null, 1));
}

function cleanName(name) {
  const n = String(name || '').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 16);
  return n || 'Player';
}

/** Find or create the player for a client-held secret token. */
function login(token, name) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 100) token = crypto.randomUUID();
  let p = byToken[token];
  if (!p) {
    p = byToken[token] = {
      id: crypto.randomBytes(6).toString('hex'),
      name: cleanName(name),
      bankroll: STARTING_BANKROLL,
      color: COLORS[crypto.randomInt(COLORS.length)],
    };
    byId.set(p.id, p);
  } else if (name) {
    p.name = cleanName(name);
  }
  save();
  return { token, player: p };
}

function get(id) { return byId.get(id); }

function adjust(id, delta) {
  const p = byId.get(id);
  if (!p) return null;
  p.bankroll = Math.max(0, p.bankroll + delta);
  save();
  return p;
}

/** Free top-up back to the starting bankroll. */
function refill(id) {
  const p = byId.get(id);
  if (p && p.bankroll < STARTING_BANKROLL) { p.bankroll = STARTING_BANKROLL; save(); }
  return p;
}

module.exports = { login, get, adjust, refill, flush, STARTING_BANKROLL };
