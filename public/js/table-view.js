// 2.5D table: a CSS-3D tilted felt with flat cards and stacked chips on it, and
// player "standees" that rotate back up to face the camera.

export const TILT = 42; // degrees the table is tipped away from the viewer
const SEATS = 8;
const HERO_SLOT = 3; // the seat you sit in is always drawn just right of bottom-center
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const CHIP_COLORS = [
  [10000, '#1b1b1b', '#e7c35a'], [5000, '#e07a1f', '#fff'], [1000, '#e7c35a', '#5a3d00'],
  [500, '#7b3fa0', '#fff'], [100, '#222', '#fff'], [25, '#2f8f4e', '#fff'],
  [5, '#c0392b', '#fff'], [1, '#f3efe6', '#333'],
];

// Seats sit on an ellipse around the rail, leaving a gap at the top for the dealer.
function slotPos(slot) {
  const a = ((30 + slot * (300 / 7)) * Math.PI) / 180;
  return { x: 50 + 56 * Math.sin(a), y: 50 - 66 * Math.cos(a) };
}

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
export const fmt = (n) => Number(n || 0).toLocaleString();
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

export function cardHTML(card, extra = '') {
  if (!card) return `<div class="card back ${extra}"></div>`;
  const r = card[0] === 'T' ? '10' : card[0];
  const red = card[1] === 'h' || card[1] === 'd';
  return `<div class="card ${red ? 'red' : ''} ${extra}" data-card="${card}"><span class="cr">${r}</span><span class="cs">${SUIT[card[1]]}</span><span class="cbig">${SUIT[card[1]]}</span></div>`;
}

/** A pile of physically stacked chip discs representing `amount`. */
export function chipsHTML(amount, maxCols = 4) {
  if (!amount) return '';
  const cols = [];
  let rest = amount;
  for (const [v, bg, edge] of CHIP_COLORS) {
    let n = Math.floor(rest / v);
    if (!n) continue;
    rest -= n * v;
    n = Math.min(n, 12);
    cols.push({ n, bg, edge });
    if (cols.length >= maxCols) break;
  }
  return cols.map((c, ci) => {
    let discs = '';
    for (let i = 0; i < c.n; i++) discs += `<i style="--z:${i * 3}px;--bg:${c.bg};--edge:${c.edge}"></i>`;
    return `<div class="chipcol" style="--ci:${ci}">${discs}</div>`;
  }).join('');
}

export class TableView {
  constructor(stage, { onSit }) {
    this.stage = stage;
    this.onSit = onSit;
    this.prev = null;
    this.speaking = new Set();
    this.timerFrame = null;

    stage.innerHTML = '';
    this.world = el('div', 'world');
    this.world.style.setProperty('--tilt', `${TILT}deg`);
    stage.appendChild(this.world);

    this.world.appendChild(el('div', 'table-shadow'));
    for (let i = 6; i >= 1; i--) {
      const edge = el('div', 'rail-edge');
      edge.style.setProperty('--z', `${-i * 4}px`);
      this.world.appendChild(edge);
    }
    this.world.appendChild(el('div', 'rail'));
    this.world.appendChild(el('div', 'felt', '<div class="felt-line"></div><div class="felt-logo">OLD GUYS POKER</div>'));

    this.board = el('div', 'board');
    this.world.appendChild(this.board);
    this.pot = el('div', 'pot', '<div class="chips"></div><div class="stand bb"><div class="pot-label"></div></div>');
    this.world.appendChild(this.pot);
    this.dealerBtn = el('div', 'dealer-btn', 'D');
    this.world.appendChild(this.dealerBtn);

    // The computer dealer.
    this.dealer = el('div', 'dealer');
    this.dealer.innerHTML = `
      <div class="stand">
        <div class="bubble hidden"></div>
        <div class="dealer-bot">🤖</div>
        <div class="plate dealer-plate"><div class="name">Dealer</div><div class="stack">House bot</div></div>
      </div>`;
    this.world.appendChild(this.dealer);
    this.bubble = this.dealer.querySelector('.bubble');

    this.seatEls = [];
    this.betEls = [];
    for (let i = 0; i < SEATS; i++) {
      const seat = el('div', 'seat');
      seat.innerHTML = `
        <div class="stand">
          <div class="hole"></div>
          <div class="avatar"><div class="timer"></div><div class="face"></div></div>
          <div class="plate"><div class="name"></div><div class="stack"></div></div>
          <div class="tag hidden"></div>
          <button class="sit-btn">Sit here</button>
        </div>`;
      seat.querySelector('.sit-btn').addEventListener('click', () => this.onSit(i));
      this.world.appendChild(seat);
      this.seatEls.push(seat);

      const bet = el('div', 'bet', '<div class="chips"></div><div class="stand bb"><div class="bet-label"></div></div>');
      this.world.appendChild(bet);
      this.betEls.push(bet);
    }

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    new ResizeObserver(this.resize).observe(stage);
    this.resize();
  }

  destroy() {
    window.removeEventListener('resize', this.resize);
    cancelAnimationFrame(this.timerFrame);
  }

  resize() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    // On small screens the whole table shrinks; grow players, labels and
    // cards back up so names and chip counts stay readable, and leave extra
    // headroom for the taller standees at the far side of the table.
    const base = Math.min(w / 1240, h / 790);
    const ui = Math.min(2.1, Math.max(1, 0.62 / base));
    const scale = Math.max(0.25, Math.min(w / 1240, h / (790 + 150 * (ui - 1))));
    this.world.style.setProperty('--fit', scale.toFixed(3));
    this.world.style.setProperty('--ui', ui.toFixed(3));
    this.world.style.setProperty('--dy', `${Math.round((ui - 1) * h * 0.07)}px`);
  }

  say(text) {
    this.bubble.textContent = text;
    this.bubble.classList.remove('hidden');
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => this.bubble.classList.add('hidden'), 3500);
  }

  setSpeaking(set) {
    this.speaking = set;
    if (this.state) this.state.seats.forEach((s, i) => {
      this.seatEls[i].classList.toggle('speaking', !!s && set.has(s.playerId));
    });
  }

  slotFor(seat, mySeat) {
    return mySeat == null ? seat : (seat - mySeat + HERO_SLOT + SEATS) % SEATS;
  }

  render(state, myId) {
    const prev = this.prev && this.prev.id === state.id ? this.prev : null;
    this.state = state;
    const mySeat = state.me ? state.me.seat : null;
    const newHand = !prev || prev.handId !== state.handId;
    const winners = state.results ? state.results.won : {};

    // Board
    const prevBoard = newHand ? 0 : prev.board.length;
    const highlight = new Set();
    if (state.results && !state.results.uncontested) {
      for (const w of Object.keys(winners)) (state.seats[w]?.bestCards || []).forEach((c) => highlight.add(c));
    }
    this.board.innerHTML = state.board.map((c, i) =>
      cardHTML(c, `${i >= prevBoard ? 'deal' : ''} ${highlight.size && !highlight.has(c) ? 'dim' : ''}`)).join('');

    // Pot
    this.pot.querySelector('.chips').innerHTML = chipsHTML(state.pot, 5);
    this.pot.querySelector('.pot-label').textContent = state.pot ? `Pot ${fmt(state.pot)}` : '';
    this.pot.classList.toggle('empty', !state.pot);

    // Dealer button
    if (state.button >= 0 && state.seats[state.button]) {
      const p = slotPos(this.slotFor(state.button, mySeat));
      this.dealerBtn.style.left = `${50 + (p.x - 50) * 0.74 + 3}%`;
      this.dealerBtn.style.top = `${50 + (p.y - 50) * 0.74}%`;
      this.dealerBtn.classList.remove('hidden');
    } else this.dealerBtn.classList.add('hidden');

    for (let i = 0; i < SEATS; i++) {
      const s = state.seats[i];
      const seatEl = this.seatEls[i];
      const betEl = this.betEls[i];
      const p = slotPos(this.slotFor(i, mySeat));
      seatEl.style.left = `${p.x}%`;
      seatEl.style.top = `${p.y}%`;
      betEl.style.left = `${50 + (p.x - 50) * 0.6}%`;
      betEl.style.top = `${50 + (p.y - 50) * 0.6}%`;

      seatEl.className = 'seat';
      if (!s) {
        seatEl.classList.add('empty');
        seatEl.classList.toggle('can-sit', mySeat == null);
        betEl.classList.add('hidden');
        continue;
      }
      const isMe = s.playerId === myId;
      seatEl.classList.toggle('me', isMe);
      seatEl.classList.toggle('folded', s.folded);
      seatEl.classList.toggle('out', s.sittingOut || s.disconnected || s.leaving);
      seatEl.classList.toggle('acting', state.toAct === i);
      seatEl.classList.toggle('winner', winners[i] != null);
      seatEl.classList.toggle('speaking', this.speaking.has(s.playerId));

      const face = seatEl.querySelector('.face');
      face.textContent = initials(s.name);
      face.style.background = s.color || '#888';
      seatEl.querySelector('.name').textContent = s.bot ? `${s.name} 🤖` : s.name;
      seatEl.querySelector('.stack').textContent =
        s.disconnected ? 'Disconnected' : s.sittingOut ? `Sitting out · ${fmt(s.stack)}` : fmt(s.stack);

      // Hole cards
      const prevCards = !newHand && prev.seats[i] ? prev.seats[i].cards : [];
      const flipped = prevCards.length && prevCards[0] === null && s.cards[0];
      const holeEl = seatEl.querySelector('.hole');
      holeEl.classList.toggle('big', isMe);
      holeEl.innerHTML = s.cards.map((c, k) => {
        const best = s.bestCards && winners[i] != null && s.bestCards.includes(c);
        const cls = `${k >= prevCards.length ? 'deal' : ''} ${flipped ? 'flip' : ''} ${best ? 'best' : ''}`;
        return cardHTML(c, cls);
      }).join('');

      // Action / result tag
      const tag = seatEl.querySelector('.tag');
      let tagText = '';
      let tagCls = '';
      if (winners[i] != null) { tagText = `+${fmt(winners[i])}${s.handName ? ` · ${s.handName}` : ''}`; tagCls = 'win'; }
      else if (s.handName) tagText = s.handName;
      else if (s.lastAction) { tagText = s.lastAction; tagCls = s.lastAction.toLowerCase().replace(/[^a-z]/g, ''); }
      tag.textContent = tagText;
      tag.className = `tag ${tagCls} ${tagText ? '' : 'hidden'}`;

      // Bet in front of the player
      betEl.classList.toggle('hidden', !s.bet);
      betEl.querySelector('.chips').innerHTML = chipsHTML(s.bet, 3);
      betEl.querySelector('.bet-label').textContent = fmt(s.bet);
    }

    this.runTimer(state);
    this.prev = state;
  }

  runTimer(state) {
    cancelAnimationFrame(this.timerFrame);
    if (state.toAct < 0) return;
    const ring = this.seatEls[state.toAct].querySelector('.timer');
    const end = performance.now() + state.timeLeft;
    const total = state.actionMs;
    const tick = () => {
      const left = Math.max(0, end - performance.now());
      const frac = Math.min(1, left / total);
      ring.style.setProperty('--p', `${frac * 360}deg`);
      ring.style.setProperty('--c', frac > 0.5 ? '#5ee07a' : frac > 0.2 ? '#f2c94c' : '#ff5a4f');
      if (left > 0) this.timerFrame = requestAnimationFrame(tick);
    };
    tick();
  }
}

export { slotPos };
