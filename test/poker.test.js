const test = require('node:test');
const assert = require('node:assert');
const { bestHand } = require('../server/poker/cards');
const { Table } = require('../server/poker/table');

const h = (s) => bestHand(s.split(' '));

test('hand categories', () => {
  assert.equal(h('As Ks Qs Js Ts 2d 3c').name, 'Royal Flush');
  assert.equal(h('5s 4s 3s 2s As Kd Kc').name, 'Straight Flush');
  assert.equal(h('9c 9d 9h 9s 2c 3d 4h').name, 'Four of a Kind');
  assert.equal(h('9c 9d 9h 2s 2c 3d 4h').name, 'Full House');
  assert.equal(h('2h 7h 9h Jh Kh 3d 4c').name, 'Flush');
  assert.equal(h('Ad 2c 3h 4s 5d Kc Qh').name, 'Straight');
  assert.equal(h('7d 7c 7h Ks 2d 4c 9h').name, 'Three of a Kind');
  assert.equal(h('7d 7c Kh Ks 2d 4c 9h').name, 'Two Pair');
  assert.equal(h('7d 7c Ah Ks 2d 4c 9h').name, 'Pair');
  assert.equal(h('7d 3c Ah Ks 2d 4c 9h').name, 'High Card');
});

test('hand comparisons and kickers', () => {
  assert.ok(h('As Ad Kc 7h 2d').score > h('As Ad Qc Jh Td').score);
  assert.ok(h('6s 5d 4c 3h 2d').score > h('5s 4d 3c 2h Ad').score); // wheel is lowest straight
  assert.ok(h('Ks Kd 2c 2h Ad').score > h('Qs Qd Jc Jh Ad').score);
  assert.equal(h('As Kd Qc Jh 9d 3s 2s').score, h('Ac Kh Qd Js 9c 4h 2d').score);
});

test('random hands conserve chips and finish cleanly', async () => {
  const fast = { action: 1000, disconnected: 5, street: 0, runout: 0, showdown: 0, uncontested: 0, nextHand: 0 };
  let table;
  let hands = 0;
  let done = false;
  let ready = false;
  const TARGET = 150;
  const players = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, color: '#fff' }));
  let total = 8 * 2000;

  await new Promise((resolve, reject) => {
    let lastHand = 0;
    const watchdog = setTimeout(() => reject(new Error(`stuck at hand ${table.handId} phase ${table.phase} toAct ${table.toAct} timer ${!!table.timer}`)), 20000);
    table = new Table({ id: 't', name: 'T', sb: 10, bb: 20, timing: fast }, {
      update(t) {
        if (done || !ready) return;
        try {
          const onTable = t.seats.reduce((a, s) => a + (s ? s.stack + s.contributed : 0), 0);
          // During a hand, chips are either in stacks or contributed to the pot.
          if (t.phase !== 'showdown') assert.equal(onTable, total, `chips leaked in hand ${t.handId}`);
          if (t.handId !== lastHand) { lastHand = t.handId; hands++; }
          if (hands >= TARGET) { done = true; clearTimeout(watchdog); return resolve(); }
          // Rebuy busted players so the game keeps going.
          if (!t.handActive) t.seats.forEach((s) => { if (s && s.stack === 0) { s.stack = 2000; s.sittingOut = false; total += 2000; } });
          if (t.toAct >= 0) {
            const i = t.toAct;
            const hand = t.handId;
            setImmediate(() => {
              if (t.toAct !== i || t.handId !== hand) return;
              const s = t.seats[i];
              const legal = t.legalFor(i);
              const r = Math.random();
              let res;
              if (r < 0.15) res = t.act(s.playerId, 'fold');
              else if (r < 0.55) res = t.act(s.playerId, legal.canCheck ? 'check' : 'call');
              else if (r < 0.9 && legal.canRaise) {
                const to = legal.minRaiseTo + Math.floor(Math.random() * (legal.maxRaiseTo - legal.minRaiseTo + 1) * 0.3);
                res = t.act(s.playerId, 'raise', to);
              } else res = t.act(s.playerId, 'allin');
              if (res.error) reject(new Error(res.error));
            });
          }
        } catch (e) { reject(e); }
      },
    });
    players.slice(0, 7).forEach((p, i) => table.sit(i, p, 2000));
    ready = true;
    table.sit(7, players[7], 2000);
  }).finally(() => { done = true; });
  table.clearTimer();
  assert.ok(hands > 10, `played ${hands} hands`);
});

test('side pots pay the right players', () => {
  const t = new Table({ id: 't', name: 'T', sb: 1, bb: 2 });
  const mk = (id, contributed, hole) => ({ playerId: id, name: id, stack: 0, contributed, hole, inHand: true, folded: false, bet: 0 });
  t.button = 0;
  t.board = ['2c', '7d', '9h', 'Js', '3s'];
  t.seats[0] = mk('short', 100, ['Ah', 'Ad']); // best hand, all-in short
  t.seats[1] = mk('mid', 300, ['Kh', 'Kd']);   // second best
  t.seats[2] = mk('big', 300, ['Qh', 'Qd']);
  t.seats[3] = { ...mk('folder', 50, ['4c', '5c']), folded: true };
  t.handActive = true;
  t.showdown();
  t.clearTimer();
  assert.equal(t.seats[0].stack, 350); // 100*3 + 50 folded
  assert.equal(t.seats[1].stack, 400); // side pot 200*2
  assert.equal(t.seats[2].stack, 0);
});
