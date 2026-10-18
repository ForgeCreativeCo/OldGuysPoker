const { newDeck, bestHand } = require('./cards');

const MAX_SEATS = 8;
const DEFAULT_TIMING = {
  action: 20000,        // time to act before auto check/fold
  disconnected: 3000,   // time given to a disconnected player
  street: 900,          // pause between betting rounds
  runout: 1400,         // pause between streets when everyone is all-in
  showdown: 5000,       // how long showdown results stay up
  uncontested: 2200,
  nextHand: 2500,
};
const BETTING_PHASES = ['preflop', 'flop', 'turn', 'river'];

/**
 * One Texas Hold'em table. The computer is always the dealer: it shuffles,
 * posts blinds, deals, enforces turn order and timers, and pays out pots.
 *
 * hooks: { update(table), event(table, evt), cashout(playerId, amount) }
 */
class Table {
  constructor(cfg, hooks = {}) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.sb = cfg.sb;
    this.bb = cfg.bb;
    this.minBuyIn = cfg.minBuyIn || cfg.bb * 40;
    this.maxBuyIn = cfg.maxBuyIn || cfg.bb * 100;
    this.timing = { ...DEFAULT_TIMING, ...(cfg.timing || {}) };
    this.hooks = hooks;

    this.seats = new Array(MAX_SEATS).fill(null);
    this.phase = 'waiting';
    this.handActive = false;
    this.handId = 0;
    this.button = -1;
    this.board = [];
    this.deck = [];
    this.toAct = -1;
    this.deadline = 0;
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.results = null;
    this.timer = null;
  }

  // ---------- helpers ----------
  update() { this.hooks.update && this.hooks.update(this); }
  event(evt) { this.hooks.event && this.hooks.event(this, evt); }
  seatOf(playerId) { return this.seats.findIndex((s) => s && s.playerId === playerId); }
  schedule(fn, ms) {
    clearTimeout(this.timer);
    const hand = this.handId;
    this.timer = setTimeout(() => { this.timer = null; if (hand === this.handId) fn(); }, ms);
  }
  clearTimer() { clearTimeout(this.timer); this.timer = null; }

  nextIndex(from, pred) {
    for (let k = 1; k <= MAX_SEATS; k++) {
      const i = (from + k + MAX_SEATS) % MAX_SEATS;
      if (this.seats[i] && pred(this.seats[i], i)) return i;
    }
    return -1;
  }
  isEligible(s) { return s && s.stack > 0 && !s.sittingOut && !s.leaving && !s.disconnected; }
  liveSeats() { return this.indices((s) => s.inHand && !s.folded); }
  indices(pred) {
    const out = [];
    this.seats.forEach((s, i) => { if (s && pred(s, i)) out.push(i); });
    return out;
  }
  pendingSeats() {
    const canAct = this.indices((s) => s.inHand && !s.folded && !s.allIn);
    if (canAct.length === 0) return [];
    if (canAct.length === 1 && this.seats[canAct[0]].bet >= this.currentBet) return [];
    return canAct.filter((i) => !this.seats[i].acted || this.seats[i].bet < this.currentBet);
  }
  commit(s, amount) {
    const amt = Math.min(amount, s.stack);
    s.stack -= amt;
    s.bet += amt;
    s.contributed += amt;
    if (s.stack === 0) s.allIn = true;
    return amt;
  }
  get totalPot() { return this.seats.reduce((t, s) => t + (s ? s.contributed : 0), 0); }

  // ---------- seating ----------
  sit(index, player, buyIn) {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_SEATS) return { error: 'Invalid seat' };
    if (this.seats[index]) return { error: 'Seat is taken' };
    if (this.seatOf(player.id) !== -1) return { error: 'Already seated here' };
    if (!Number.isInteger(buyIn) || buyIn < this.minBuyIn || buyIn > this.maxBuyIn) return { error: 'Invalid buy-in' };
    this.seats[index] = {
      playerId: player.id, name: player.name, color: player.color, stack: buyIn,
      hole: [], bet: 0, contributed: 0, folded: false, allIn: false, acted: false, inHand: false,
      sittingOut: false, leaving: false, disconnected: false, timeouts: 0, lastAction: null, best: null,
    };
    this.event({ type: 'sit', seat: index, text: `${player.name} sits down with ${buyIn.toLocaleString()}.` });
    this.update();
    this.maybeStart();
    return { ok: true };
  }

  /** Stand up. Returns the chips that go straight back to the bankroll. */
  stand(playerId) {
    const i = this.seatOf(playerId);
    if (i === -1) return 0;
    const s = this.seats[i];
    const cash = s.stack;
    s.stack = 0;
    this.event({ type: 'stand', seat: i, text: `${s.name} leaves the table.` });
    if (this.handActive && s.inHand) {
      s.leaving = true;
      if (BETTING_PHASES.includes(this.phase) && !s.folded && !s.allIn) {
        if (this.toAct === i) return this.applyAction(i, 'fold'), cash;
        s.folded = true;
        s.lastAction = 'Fold';
        const live = this.liveSeats();
        if (live.length === 1) this.winUncontested(live[0]);
        else this.update();
      } else this.update();
    } else {
      this.seats[i] = null;
      this.update();
    }
    return cash;
  }

  rebuy(playerId, amount) {
    const i = this.seatOf(playerId);
    if (i === -1) return { error: 'Not seated' };
    const s = this.seats[i];
    if (this.handActive && s.inHand && !s.folded) return { error: 'Wait for the hand to finish' };
    if (!Number.isInteger(amount) || amount <= 0 || s.stack + amount > this.maxBuyIn) return { error: 'Invalid amount' };
    s.stack += amount;
    s.sittingOut = false;
    this.event({ type: 'rebuy', seat: i, text: `${s.name} adds ${amount.toLocaleString()} in chips.` });
    this.update();
    this.maybeStart();
    return { ok: true };
  }

  setSittingOut(playerId, value) {
    const s = this.seats[this.seatOf(playerId)];
    if (!s) return;
    if (!value && s.stack === 0) return;
    s.sittingOut = !!value;
    s.timeouts = 0;
    this.update();
    this.maybeStart();
  }

  setDisconnected(playerId, value) {
    const i = this.seatOf(playerId);
    if (i === -1) return;
    this.seats[i].disconnected = value;
    if (value && this.toAct === i) this.setToAct(i, this.timing.disconnected);
    else this.update();
    if (!value) this.maybeStart();
  }

  // ---------- hand flow ----------
  maybeStart() {
    if (this.handActive || this.timer) return;
    if (this.indices((s) => this.isEligible(s)).length < 2) return;
    this.schedule(() => this.startHand(), this.timing.nextHand);
  }

  startHand() {
    const eligible = this.indices((s) => this.isEligible(s));
    if (eligible.length < 2) { this.phase = 'waiting'; this.update(); return; }

    this.handId++;
    this.handActive = true;
    this.results = null;
    this.board = [];
    this.deck = newDeck();
    for (const s of this.seats) {
      if (!s) continue;
      Object.assign(s, { hole: [], bet: 0, contributed: 0, folded: false, allIn: false, acted: false, lastAction: null, best: null });
      s.inHand = this.isEligible(s);
    }

    this.button = this.nextIndex(this.button, (s) => s.inHand);
    const headsUp = eligible.length === 2;
    const sbIdx = headsUp ? this.button : this.nextIndex(this.button, (s) => s.inHand);
    const bbIdx = this.nextIndex(sbIdx, (s) => s.inHand);
    this.commit(this.seats[sbIdx], this.sb);
    this.commit(this.seats[bbIdx], this.bb);
    this.seats[sbIdx].lastAction = 'SB';
    this.seats[bbIdx].lastAction = 'BB';
    this.currentBet = this.bb;
    this.minRaise = this.bb;

    for (let round = 0; round < 2; round++) {
      let i = sbIdx;
      do {
        this.seats[i].hole.push(this.deck.pop());
        i = this.nextIndex(i, (s) => s.inHand);
      } while (i !== sbIdx);
    }
    this.phase = 'preflop';
    this.event({ type: 'deal', text: `Hand #${this.handId}. ${this.seats[this.button].name} has the button. Blinds ${this.sb}/${this.bb}.` });
    this.advance(bbIdx);
  }

  setToAct(i, ms) {
    this.toAct = i;
    const s = this.seats[i];
    const wait = ms ?? (s.disconnected ? this.timing.disconnected : this.timing.action);
    this.deadline = Date.now() + wait;
    this.schedule(() => this.onTimeout(), wait);
    this.update();
  }

  onTimeout() {
    const i = this.toAct;
    const s = this.seats[i];
    if (!s) return;
    s.timeouts++;
    const canCheck = s.bet >= this.currentBet;
    if (s.timeouts >= 2 && !s.disconnected) {
      s.sittingOut = true;
      this.event({ type: 'info', text: `${s.name} timed out and is sitting out.` });
    }
    this.applyAction(i, canCheck ? 'check' : 'fold');
  }

  /** Player-initiated action. */
  act(playerId, action, amount) {
    const i = this.seatOf(playerId);
    if (i === -1 || i !== this.toAct || !BETTING_PHASES.includes(this.phase)) return { error: 'Not your turn' };
    this.seats[i].timeouts = 0;
    return this.applyAction(i, action, amount);
  }

  applyAction(i, action, amount) {
    const s = this.seats[i];
    const toCall = this.currentBet - s.bet;
    let text;

    if (action === 'allin') {
      const to = s.bet + s.stack;
      if (to > this.currentBet) { action = 'raise'; amount = to; } else action = 'call';
    }

    switch (action) {
      case 'fold':
        s.folded = true;
        s.lastAction = 'Fold';
        text = `${s.name} folds.`;
        break;
      case 'check':
        if (toCall > 0) return { error: 'Cannot check' };
        s.lastAction = 'Check';
        text = `${s.name} checks.`;
        break;
      case 'call': {
        if (toCall <= 0) return this.applyAction(i, 'check');
        const paid = this.commit(s, toCall);
        s.lastAction = s.allIn ? 'All-in' : 'Call';
        text = `${s.name} calls ${paid.toLocaleString()}${s.allIn ? ' and is all-in' : ''}.`;
        break;
      }
      case 'raise': {
        const max = s.bet + s.stack;
        let to = Math.floor(Number(amount));
        if (!Number.isFinite(to)) return { error: 'Invalid amount' };
        if (to >= max) to = max;
        if (to <= this.currentBet) return this.applyAction(i, 'call');
        const minTo = this.currentBet + this.minRaise;
        if (to < minTo && to < max) return { error: `Minimum raise is to ${minTo}` };
        const raiseBy = to - this.currentBet;
        const wasBet = this.currentBet === 0;
        if (raiseBy >= this.minRaise) {
          this.minRaise = raiseBy;
          // A full raise re-opens the action for everyone else.
          for (const o of this.seats) if (o && o !== s) o.acted = false;
        }
        this.currentBet = to;
        this.commit(s, to - s.bet);
        s.lastAction = s.allIn ? 'All-in' : wasBet ? 'Bet' : 'Raise';
        text = s.allIn
          ? `${s.name} goes all-in for ${to.toLocaleString()}.`
          : `${s.name} ${wasBet ? 'bets' : 'raises to'} ${to.toLocaleString()}.`;
        break;
      }
      default:
        return { error: 'Unknown action' };
    }

    s.acted = true;
    this.event({ type: 'action', seat: i, action: s.lastAction, text });
    this.advance(i);
    return { ok: true };
  }

  /** Decide what happens after seat `from` acted (or blinds were posted). */
  advance(from) {
    const live = this.liveSeats();
    if (live.length === 1) return this.winUncontested(live[0]);
    const pending = this.pendingSeats();
    if (pending.length === 0) {
      this.toAct = -1;
      this.update();
      this.schedule(() => this.endStreet(), this.timing.street);
      return;
    }
    this.setToAct(this.nextIndex(from, (s, idx) => pending.includes(idx)));
  }

  endStreet() {
    for (const s of this.seats) if (s) { s.bet = 0; s.acted = false; }
    this.currentBet = 0;
    this.minRaise = this.bb;

    if (this.phase === 'river') return this.showdown();
    this.deck.pop(); // burn
    if (this.phase === 'preflop') {
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'flop';
    } else {
      this.board.push(this.deck.pop());
      this.phase = this.phase === 'flop' ? 'turn' : 'river';
    }
    const label = { flop: 'The flop', turn: 'The turn', river: 'The river' }[this.phase];
    this.event({ type: 'board', text: `${label}: ${this.board.join(' ')}` });

    const pending = this.pendingSeats();
    if (pending.length === 0) {
      // Everyone (or all but one) is all-in: run the board out.
      this.toAct = -1;
      this.update();
      this.schedule(() => this.endStreet(), this.timing.runout);
      return;
    }
    this.setToAct(this.nextIndex(this.button, (s, idx) => pending.includes(idx)));
  }

  buildPots() {
    const contributors = this.indices((s) => s.contributed > 0);
    const live = new Set(this.liveSeats());
    const levels = [...new Set(contributors.map((i) => this.seats[i].contributed))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of levels) {
      let amount = 0;
      for (const i of contributors) {
        const c = this.seats[i].contributed;
        amount += Math.min(c, lvl) - Math.min(c, prev);
      }
      prev = lvl;
      const eligible = contributors.filter((i) => live.has(i) && this.seats[i].contributed >= lvl);
      const last = pots[pots.length - 1];
      if (eligible.length === 0 || (last && last.eligible.join() === eligible.join())) {
        if (last) last.amount += amount;
        else pots.push({ amount, eligible: [...live] });
      } else pots.push({ amount, eligible });
    }
    return pots;
  }

  /** Seat order starting left of the button (who gets odd chips first). */
  orderFromButton(list) {
    return [...list].sort((a, b) =>
      ((a - this.button - 1 + MAX_SEATS) % MAX_SEATS) - ((b - this.button - 1 + MAX_SEATS) % MAX_SEATS));
  }

  showdown() {
    this.phase = 'showdown';
    this.toAct = -1;
    const live = this.liveSeats();
    for (const i of live) this.seats[i].best = bestHand([...this.seats[i].hole, ...this.board]);

    const won = new Map();
    const pots = this.buildPots().map((pot, idx) => {
      const top = Math.max(...pot.eligible.map((i) => this.seats[i].best.score));
      const winners = this.orderFromButton(pot.eligible.filter((i) => this.seats[i].best.score === top));
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      for (const w of winners) {
        const amt = share + (odd-- > 0 ? 1 : 0);
        this.seats[w].stack += amt;
        won.set(w, (won.get(w) || 0) + amt);
      }
      const handName = this.seats[winners[0]].best.name;
      const potName = idx === 0 ? 'the main pot' : `side pot ${idx}`;
      if (pot.eligible.length > 1 || idx === 0) {
        this.event({ type: 'win', text: `${winners.map((w) => this.seats[w].name).join(' & ')} win${winners.length > 1 ? '' : 's'} ${potName} (${pot.amount.toLocaleString()}) with ${handName}.` });
      }
      return { amount: pot.amount, winners, handName };
    });
    this.results = { pots, won: Object.fromEntries(won), uncontested: false };
    this.update();
    this.schedule(() => this.finishHand(), this.timing.showdown);
  }

  winUncontested(i) {
    this.clearTimer();
    this.toAct = -1;
    const s = this.seats[i];
    const amount = this.totalPot;
    s.stack += amount;
    for (const o of this.seats) if (o) o.bet = 0;
    this.results = { pots: [{ amount, winners: [i], handName: null }], won: { [i]: amount }, uncontested: true };
    this.phase = 'showdown';
    this.event({ type: 'win', text: `${s.name} wins ${amount.toLocaleString()}.` });
    this.update();
    this.schedule(() => this.finishHand(), this.timing.uncontested);
  }

  finishHand() {
    this.handActive = false;
    this.phase = 'waiting';
    this.toAct = -1;
    for (const s of this.seats) if (s) { s.contributed = 0; s.bet = 0; }
    this.seats.forEach((s, i) => {
      if (!s) return;
      if (s.leaving) {
        if (s.stack > 0) this.hooks.cashout && this.hooks.cashout(s.playerId, s.stack);
        this.seats[i] = null;
      } else if (s.stack === 0) {
        s.sittingOut = true;
      }
    });
    this.update();
    this.maybeStart();
  }

  // ---------- views ----------
  legalFor(i) {
    const s = this.seats[i];
    const toCall = Math.min(this.currentBet - s.bet, s.stack);
    const maxTo = s.bet + s.stack;
    return {
      toCall,
      canCheck: toCall <= 0,
      canRaise: maxTo > this.currentBet,
      minRaiseTo: Math.min(this.currentBet + this.minRaise, maxTo),
      maxRaiseTo: maxTo,
      isBet: this.currentBet === 0,
    };
  }

  summary() {
    return {
      id: this.id, name: this.name, sb: this.sb, bb: this.bb,
      minBuyIn: this.minBuyIn, maxBuyIn: this.maxBuyIn, handActive: this.handActive,
      seats: this.seats.map((s) => (s ? { name: s.name, color: s.color, stack: s.stack } : null)),
    };
  }

  view(playerId) {
    const mySeat = this.seatOf(playerId);
    const reveal = this.results && !this.results.uncontested;
    const potOnTable = this.totalPot - this.seats.reduce((t, s) => t + (s ? s.bet : 0), 0);
    return {
      ...this.summary(),
      phase: this.phase,
      handId: this.handId,
      button: this.button,
      board: this.board,
      toAct: this.toAct,
      timeLeft: this.toAct >= 0 ? Math.max(0, this.deadline - Date.now()) : 0,
      actionMs: this.timing.action,
      currentBet: this.currentBet,
      pot: potOnTable,
      results: this.results,
      seats: this.seats.map((s, i) => {
        if (!s) return null;
        const showCards = i === mySeat || (reveal && s.inHand && !s.folded);
        return {
          playerId: s.playerId, name: s.name, color: s.color, stack: s.stack, bet: s.bet,
          folded: s.folded, allIn: s.allIn, inHand: s.inHand, sittingOut: s.sittingOut,
          leaving: s.leaving, disconnected: s.disconnected, lastAction: s.lastAction,
          cards: showCards ? s.hole : s.inHand && !s.folded ? s.hole.map(() => null) : [],
          handName: reveal && s.best && !s.folded ? s.best.name : null,
          bestCards: reveal && s.best && !s.folded ? s.best.cards : null,
        };
      }),
      me: mySeat === -1 ? null : {
        seat: mySeat,
        legal: this.toAct === mySeat ? this.legalFor(mySeat) : null,
      },
    };
  }
}

module.exports = { Table, MAX_SEATS };
