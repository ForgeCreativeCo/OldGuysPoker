// Computer opponents for practice tables. Bots live entirely on the server,
// play with house chips (never touch a real bankroll), fill seats only while
// a human is sitting, and always leave a seat open for another person.
const { bestHand, RANKS } = require('./poker/cards');

const NAMES = ['Doc', 'Slim', 'Tex', 'Lefty', 'Duke', 'Shorty', 'Hank', 'Buck', 'Red', 'Pops'];
const COLORS = ['#7d8597', '#9c6644', '#6c757d', '#588157', '#9d4edd', '#c9184a', '#4361ee'];
const TARGET_PLAYERS = 6;

const rv = (c) => RANKS.indexOf(c[0]) + 2;
const isBot = (s) => s && s.bot;

class BotManager {
  constructor() {
    this.fillTimers = new Map(); // tableId -> timeout
    this.actKeys = new Map();    // tableId -> key of the decision already scheduled
    this.nextId = 1;
  }

  onUpdate(table) {
    if (!table.botsEnabled) return;
    this.scheduleFill(table);
    this.maybeAct(table);
  }

  // ---------- seating ----------
  scheduleFill(table) {
    if (this.fillTimers.has(table.id)) return;
    this.fillTimers.set(table.id, setTimeout(() => {
      this.fillTimers.delete(table.id);
      this.fill(table);
    }, 800));
  }

  fill(table) {
    if (table.handActive) return; // only reshuffle seats between hands
    const humans = table.seats.filter((s) => s && !s.bot && !s.leaving).length;
    const bots = table.seats.map((s, i) => (isBot(s) ? i : -1)).filter((i) => i >= 0);
    const wanted = humans === 0 ? 0 : Math.max(0, Math.min(TARGET_PLAYERS, 7) - humans);

    // Rebuy busted bots.
    for (const i of bots) {
      const s = table.seats[i];
      if (s.stack === 0) table.rebuy(s.playerId, table.maxBuyIn);
    }
    if (bots.length > wanted) {
      for (const i of bots.slice(0, bots.length - wanted)) table.stand(table.seats[i].playerId);
      return;
    }
    for (let n = bots.length; n < wanted; n++) {
      const open = table.seats.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0);
      if (open.length <= 1) return; // keep one seat free for a human
      const seat = open[Math.floor(Math.random() * open.length)];
      const used = new Set(table.seats.filter(Boolean).map((s) => s.name));
      const name = NAMES.find((nm) => !used.has(nm)) || `Bot ${this.nextId}`;
      table.sit(seat, {
        id: `bot-${this.nextId++}`, name, bot: true,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      }, table.maxBuyIn);
    }
  }

  // ---------- decisions ----------
  maybeAct(table) {
    const i = table.toAct;
    const s = table.seats[i];
    if (i < 0 || !isBot(s)) return;
    const key = `${table.handId}:${i}:${table.board.length}:${table.currentBet}:${s.bet}`;
    if (this.actKeys.get(table.id) === key) return;
    this.actKeys.set(table.id, key);
    setTimeout(() => {
      if (table.toAct !== i || this.actKeys.get(table.id) !== key || !table.seats[i]) return;
      const { action, amount } = decide(table, i);
      const res = table.act(s.playerId, action, amount);
      if (res.error) table.act(s.playerId, table.legalFor(i).canCheck ? 'check' : 'fold');
    }, 600 + Math.random() * 1000);
  }
}

/** Rough 0..1 hand strength. Not solver poker, just a believable regular. */
function strength(hole, board) {
  const [a, b] = hole.map(rv).sort((x, y) => y - x);
  const suited = hole[0][1] === hole[1][1];
  if (board.length === 0) {
    if (a === b) return 0.5 + a / 28;
    let s = (a + b) / 30 + (suited ? 0.06 : 0) + (a - b <= 2 ? 0.04 : 0) + (a === 14 ? 0.08 : 0);
    if (a - b > 4 && a < 13) s -= 0.08;
    return Math.max(0.05, s - 0.15);
  }

  const mine = bestHand([...hole, ...board]);
  const cat = Math.floor(mine.score / 15 ** 5);
  // Does the made hand actually use our hole cards?
  const boardCounts = {};
  board.forEach((c) => { boardCounts[c[0]] = (boardCounts[c[0]] || 0) + 1; });
  const boardPairs = Object.values(boardCounts).filter((n) => n >= 2).length;
  const boardCat = Object.values(boardCounts).some((n) => n >= 3) ? 3 : boardPairs >= 2 ? 2 : boardPairs;
  const usesHole = hole.some((h) => mine.cards.includes(h));

  let s = [0.12, 0.42, 0.62, 0.74, 0.8, 0.84, 0.92, 0.97, 0.99][cat];
  if (cat <= 3 && cat <= boardCat) s = 0.15; // the board is doing the work
  if (!usesHole) s = 0.15;
  if (cat === 1 && usesHole) {
    const pairRank = Object.entries(
      [...hole, ...board].reduce((m, c) => ({ ...m, [c[0]]: (m[c[0]] || 0) + 1 }), {}),
    ).find(([, n]) => n === 2);
    const top = Math.max(...board.map(rv));
    if (pairRank && rv(pairRank[0] + 'x') >= top) s += 0.12; // top pair or overpair
  }
  if (cat === 0 && a >= 13) s += 0.08;
  if (board.length < 5) {
    const suits = {};
    [...hole, ...board].forEach((c) => { suits[c[1]] = (suits[c[1]] || 0) + 1; });
    if (Object.values(suits).some((n) => n === 4) && cat < 5) s += 0.15; // flush draw
  }
  return Math.min(1, s);
}

function decide(table, i) {
  const s = table.seats[i];
  const legal = table.legalFor(i);
  const pot = table.totalPot;
  const st = strength(s.hole, table.board) + (Math.random() - 0.5) * 0.15;
  const clampTo = (v) => Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(v)));
  const preflop = table.board.length === 0;
  const raiseTo = (frac) => clampTo(preflop
    ? Math.max(table.currentBet * 3, table.bb * 3)
    : table.currentBet + (pot + legal.toCall) * frac);

  if (legal.canCheck) {
    if (legal.canRaise && st > 0.7) return { action: 'raise', amount: raiseTo(0.5 + Math.random() * 0.4) };
    if (legal.canRaise && st > 0.5 && Math.random() < 0.35) return { action: 'raise', amount: raiseTo(0.5) };
    if (legal.canRaise && Math.random() < 0.07) return { action: 'raise', amount: raiseTo(0.5) }; // bluff
    return { action: 'check' };
  }
  const potOdds = legal.toCall / (pot + legal.toCall);
  if (legal.canRaise && st > 0.82 && Math.random() < 0.7) return { action: 'raise', amount: raiseTo(0.75) };
  if (st > potOdds + 0.12) return { action: 'call' };
  if (legal.toCall <= table.bb && st > 0.22) return { action: 'call' };
  return { action: 'fold' };
}

module.exports = { BotManager, strength };
