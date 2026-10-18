const crypto = require('crypto');

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';

function newDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  // Fisher-Yates with a CSPRNG so the computer dealer can't be gamed.
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const rankValue = (card) => RANKS.indexOf(card[0]) + 2;

const CATEGORY_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

// Scores a 5-card hand as a single comparable integer (higher wins).
function score5(cards) {
  const vals = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  let straightHigh = 0;
  if (new Set(vals).size === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals[0] === 14 && vals[1] === 5) straightHigh = 5; // wheel
  }
  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts].map(([v, c]) => [c, v]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const byGroup = groups.map((g) => g[1]);

  let cat, tie;
  if (straightHigh && flush) [cat, tie] = [8, [straightHigh]];
  else if (groups[0][0] === 4) [cat, tie] = [7, byGroup];
  else if (groups[0][0] === 3 && groups[1][0] === 2) [cat, tie] = [6, byGroup];
  else if (flush) [cat, tie] = [5, vals];
  else if (straightHigh) [cat, tie] = [4, [straightHigh]];
  else if (groups[0][0] === 3) [cat, tie] = [3, byGroup];
  else if (groups[0][0] === 2 && groups[1][0] === 2) [cat, tie] = [2, byGroup];
  else if (groups[0][0] === 2) [cat, tie] = [1, byGroup];
  else [cat, tie] = [0, vals];

  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (tie[i] || 0);
  return { score, cat, straightHigh };
}

// Best 5-card hand out of 5-7 cards.
function bestHand(cards) {
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const r = score5(five);
            if (!best || r.score > best.score) best = { ...r, cards: five };
          }
  let name = CATEGORY_NAMES[best.cat];
  if (best.cat === 8 && best.straightHigh === 14) name = 'Royal Flush';
  return { score: best.score, name, cards: best.cards };
}

module.exports = { newDeck, bestHand, score5, RANKS };
