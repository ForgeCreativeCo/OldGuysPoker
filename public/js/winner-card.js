// The winner's card: a gold-foil showcard that bursts onto the table at the end
// of every hand. The bigger the hand, the bigger the celebration.
import { cardHTML, fmt } from './table-view.js';

const NAMES = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };
const PLURAL = { ...Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k, `${v}s`])), 6: 'Sixes' };
const ORDER = '23456789TJQKA';
const SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };

// How loud to celebrate (0 quiet .. 5 royal).
const TIER = {
  'High Card': 0, Pair: 0, 'Two Pair': 1, 'Three of a Kind': 1, Straight: 2, Flush: 2,
  'Full House': 3, 'Four of a Kind': 4, 'Straight Flush': 4, 'Royal Flush': 5,
};
const CONFETTI = [0, 18, 50, 90, 140, 220];

const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Group the five cards (pairs/trips first) and describe the hand in words. */
export function describe(handName, cards) {
  if (!cards || cards.length < 5) return { text: '', cards: cards || [] };
  const counts = {};
  cards.forEach((c) => { counts[c[0]] = (counts[c[0]] || 0) + 1; });
  const ranks = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || ORDER.indexOf(b) - ORDER.indexOf(a));
  const sorted = [...cards].sort((a, b) => ranks.indexOf(a[0]) - ranks.indexOf(b[0]) || ORDER.indexOf(b[0]) - ORDER.indexOf(a[0]));
  const [r1, r2] = ranks;
  const suit = SUITS[cards[0][1]];
  const isWheel = ranks.includes('A') && ranks.includes('5') && !ranks.includes('K');
  const high = isWheel ? '5' : ranks.reduce((m, r) => (ORDER.indexOf(r) > ORDER.indexOf(m) ? r : m));
  const low = isWheel ? 'A' : ranks.reduce((m, r) => (ORDER.indexOf(r) < ORDER.indexOf(m) ? r : m));
  if (isWheel) sorted.sort((a, b) => (a[0] === 'A') - (b[0] === 'A') || ORDER.indexOf(b[0]) - ORDER.indexOf(a[0]));
  const text = {
    'Royal Flush': `Ten to Ace, all ${suit}. The nuts.`,
    'Straight Flush': `${NAMES[low]} to ${NAMES[high]}, all ${suit}`,
    'Four of a Kind': `Four ${PLURAL[r1]}`,
    'Full House': `${PLURAL[r1]} full of ${PLURAL[r2]}`,
    Flush: `${NAMES[r1 === high ? r1 : high]}-high flush in ${suit}`,
    Straight: `${NAMES[low]} to ${NAMES[high]}`,
    'Three of a Kind': `Three ${PLURAL[r1]}`,
    'Two Pair': `${PLURAL[r1]} and ${PLURAL[r2]}`,
    Pair: `Pair of ${PLURAL[r1]}`,
    'High Card': `${NAMES[r1]} high`,
  }[handName] || '';
  return { text, cards: sorted };
}

export class WinnerCard {
  constructor(stage, { onShow } = {}) {
    this.stage = stage;
    this.onShow = onShow;
    this.el = null;
    this.timer = null;
  }

  hide() {
    clearTimeout(this.timer);
    if (!this.el) return;
    const el = this.el;
    this.el = null;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 350);
  }

  show(state, myId) {
    this.hide();
    const res = state.results;
    const main = res.pots[0];
    const seat = state.seats[main.winners[0]];
    if (!seat) return;
    const winnersNames = main.winners.map((w) => state.seats[w]?.name).filter(Boolean);
    const iWon = state.me && res.won[state.me.seat] != null;
    const total = main.winners.reduce((t, w) => t + (res.won[w] || 0), 0);
    const handName = res.uncontested ? null : main.handName;
    const tier = handName ? TIER[handName] ?? 0 : 0;
    const desc = handName ? describe(handName, seat.bestCards) : { text: '', cards: [] };
    const split = main.winners.length > 1;

    const sidePots = res.pots.slice(1).filter((p) => p.amount > 0).map((p, i) => {
      const names = p.winners.map((w) => state.seats[w]?.name).filter(Boolean).join(' & ');
      return `<div class="wc-side">Side pot ${i + 1}: <b>${escapeHTML(names)}</b> · ${fmt(p.amount)}${p.handName ? ` · ${escapeHTML(p.handName)}` : ''}</div>`;
    }).join('');

    const el = document.createElement('div');
    el.className = `winner-overlay tier-${tier} ${res.uncontested ? 'uncontested' : ''} ${iWon ? 'mine' : ''}`;
    el.innerHTML = `
      <div class="wc-rays"></div>
      <div class="wc-card">
        <div class="wc-shine"></div>
        <div class="wc-corner tl">♠</div><div class="wc-corner tr">♥</div>
        <div class="wc-corner bl">♦</div><div class="wc-corner br">♣</div>
        <div class="wc-kicker">${iWon ? (split ? 'You split the pot' : 'You win!') : split ? 'Split pot' : 'Winner'}</div>
        <div class="wc-name">
          <span class="wc-dot" style="background:${escapeHTML(seat.color || '#888')}"></span>${escapeHTML(winnersNames.join(' & '))}
        </div>
        ${handName ? `<div class="wc-hand">${escapeHTML(handName)}</div>` : '<div class="wc-hand small">Everyone else folded</div>'}
        ${desc.text ? `<div class="wc-desc">${escapeHTML(desc.text)}</div>` : ''}
        ${desc.cards.length ? `<div class="wc-cards">${desc.cards.map((c, i) => cardHTML(c, '').replace('class="card', `style="--i:${i}" class="card wc-c`)).join('')}</div>` : ''}
        <div class="wc-amount">+<span class="wc-count">0</span></div>
        ${sidePots}
      </div>
      <div class="wc-confetti"></div>`;
    el.addEventListener('pointerdown', () => this.hide());
    this.stage.appendChild(el);
    this.el = el;

    this.countUp(el.querySelector('.wc-count'), total, res.uncontested ? 500 : 1100);
    this.confetti(el.querySelector('.wc-confetti'), res.uncontested ? 0 : CONFETTI[tier] + (iWon ? 30 : 0), tier);
    this.onShow && this.onShow({ tier, iWon, uncontested: res.uncontested });
    this.timer = setTimeout(() => this.hide(), res.uncontested ? 2000 : 4600);
  }

  countUp(node, total, ms) {
    const start = performance.now();
    const step = (t) => {
      if (!node.isConnected) return;
      const k = Math.min(1, (t - start) / ms);
      node.textContent = fmt(Math.round(total * (1 - (1 - k) ** 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  confetti(box, count, tier) {
    const colors = tier >= 4 ? ['#f7de97', '#e7c35a', '#fff6d5', '#b8902c'] : ['#e7c35a', '#f7de97', '#d64541', '#4ade80', '#3a86ff', '#fff'];
    const bits = [];
    for (let i = 0; i < count; i++) {
      const shape = i % 5 === 0 ? 'chip' : i % 3 === 0 ? 'suit' : 'strip';
      const style = [
        `left:${Math.random() * 100}%`,
        `--c:${colors[i % colors.length]}`,
        `--d:${(1.6 + Math.random() * 1.8).toFixed(2)}s`,
        `--delay:${(Math.random() * (tier >= 3 ? 1.2 : 0.6)).toFixed(2)}s`,
        `--x:${Math.round((Math.random() - 0.5) * 160)}px`,
        `--r:${Math.round(Math.random() * 720 - 360)}deg`,
      ].join(';');
      const glyph = shape === 'suit' ? '♠♥♦♣'[i % 4] : '';
      bits.push(`<i class="cf ${shape}" style="${style}">${glyph}</i>`);
    }
    box.innerHTML = bits.join('');
  }
}
