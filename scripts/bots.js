// Dev helper: seat some simple bots at a table so you can test solo.
// Usage: node scripts/bots.js [tableId=porch] [count=3] [url=http://localhost:3000]
const { io } = require('socket.io-client');

const [tableId = 'porch', count = '3', url = 'http://localhost:3000'] = process.argv.slice(2);
const NAMES = ['Earl', 'Walt', 'Gus', 'Herb', 'Lou', 'Moe', 'Sal'];

for (let n = 0; n < Number(count); n++) {
  const socket = io(url);
  const name = `${NAMES[n % NAMES.length]} (bot)`.slice(0, 16);
  const token = `bot-token-${tableId}-${n}-xxxxxxxx`;
  let lastHandAct = '';
  socket.on('connect', () => {
    socket.emit('hello', { token, name }, () => {
      socket.emit('bankroll:refill');
      const trySit = () => socket.emit('table:watch', { tableId }, ({ state }) => {
        if (state.me) return;
        // Leave seat 0 free for a human; pick a random open seat and retry on a race.
        const open = state.seats.map((s, i) => (!s && i !== 0 ? i : -1)).filter((i) => i >= 0);
        if (!open.length) return console.log(name, 'no open seat');
        const seat = open[Math.floor(Math.random() * open.length)];
        socket.emit('table:sit', { seat, buyIn: state.maxBuyIn }, (r) => r.error && setTimeout(trySit, 300));
      });
      setTimeout(trySit, n * 250);
    });
  });
  socket.on('table:state', (s) => {
    if (!s.me) return;
    const me = s.seats[s.me.seat];
    if (me.stack === 0 && !s.handActive) socket.emit('table:rebuy', { amount: s.maxBuyIn });
    if (me.sittingOut && me.stack > 0) socket.emit('table:sitout', { value: false });
    const legal = s.me.legal;
    const key = `${s.handId}-${s.board.length}-${s.currentBet}`;
    if (!legal || key === lastHandAct) return;
    lastHandAct = key;
    setTimeout(() => {
      const r = Math.random();
      if (!legal.canCheck && r < 0.2) return socket.emit('table:action', { action: 'fold' });
      if (legal.canRaise && r > 0.85) return socket.emit('table:action', { action: 'raise', amount: legal.minRaiseTo });
      socket.emit('table:action', { action: legal.canCheck ? 'check' : 'call' });
    }, 700 + Math.random() * 1300);
  });
}
console.log(`Seating ${count} bots at "${tableId}" on ${url}. Ctrl+C to stop.`);
