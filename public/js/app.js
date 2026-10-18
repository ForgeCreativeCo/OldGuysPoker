import { TableView, fmt, slotPos } from './table-view.js';
import { Voice } from './voice.js';
import { sfx } from './sound.js';
import { WinnerCard } from './winner-card.js';

const $ = (id) => document.getElementById(id);
// Empty URL = same origin (local dev). On Netlify this is the Render server.
const socket = window.OGP_SERVER_URL ? io(window.OGP_SERVER_URL, { transports: ['websocket', 'polling'] }) : io();
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const app = {
  me: null,
  bankroll: 0,
  tables: [],
  tableId: null,
  state: null,
  view: null,
  pendingSeat: null,
};

// ---------- screens ----------
function show(screen) {
  for (const id of ['login', 'lobby', 'table-screen']) $(id).classList.toggle('hidden', id !== screen);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

const emit = (event, payload) => new Promise((resolve) => socket.emit(event, payload, (res) => {
  if (res && res.error) toast(res.error);
  resolve(res || {});
}));

// ---------- login ----------
$('login-name').value = store.get('ogp-name') || '';
$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('login-name').value.trim();
  if (!name) return;
  store.set('ogp-name', name);
  hello(name);
});

async function hello(name) {
  const res = await emit('hello', { token: store.get('ogp-token'), name });
  if (!res.ok) return;
  store.set('ogp-token', res.token);
  app.me = res.player;
  setBankroll(res.player.bankroll);
  voice.iceServers = res.iceServers;
  app.tables = res.tables;
  $('lobby-name').textContent = app.me.name;
  $('lobby-color').style.background = app.me.color;
  renderLobby();
  if (app.tableId || res.resumeTableId) openTable(app.tableId || res.resumeTableId);
  else show('lobby');
}

socket.on('connect', () => {
  const name = store.get('ogp-name');
  if (name) hello(name);
});

function setBankroll(v) {
  app.bankroll = v;
  $('lobby-bankroll').textContent = fmt(v);
  $('t-bankroll').textContent = fmt(v);
}
socket.on('bankroll', setBankroll);
$('refill-btn').addEventListener('click', () => emit('bankroll:refill'));

// ---------- lobby ----------
socket.on('lobby', (tables) => { app.tables = tables; renderLobby(); });

function renderLobby() {
  const list = $('table-list');
  list.innerHTML = '';
  for (const t of app.tables) {
    const seated = t.seats.filter(Boolean).length;
    const card = document.createElement('div');
    card.className = `table-card ${t.bots ? 'practice' : ''}`;
    card.innerHTML = `
      <div class="mini-wrap"><div class="mini">
        <div class="mini-felt"></div><div class="mini-dealer">🤖</div>
      </div></div>
      <div class="tc-info">
        <div class="tc-name">${escapeHTML(t.name)}${t.bots ? ' <span class="badge">🤖 Bots</span>' : ''}</div>
        <div class="tc-meta">Blinds ${fmt(t.sb)}/${fmt(t.bb)} · Buy-in ${fmt(t.minBuyIn)}–${fmt(t.maxBuyIn)}</div>
        <div class="tc-meta">${t.bots ? 'Computer players fill in when you sit down' : `${seated}/8 seated`} ${t.handActive ? '· <span class="live">hand in progress</span>' : ''}</div>
      </div>
      <button class="btn small ghost watch">Watch</button>`;
    const mini = card.querySelector('.mini');
    t.seats.forEach((s, i) => {
      const p = slotPos(i);
      const dot = document.createElement('button');
      dot.className = `mini-seat ${s ? 'taken' : 'open'}`;
      dot.style.left = `${p.x}%`;
      dot.style.top = `${p.y}%`;
      if (s) {
        dot.style.background = s.color;
        dot.textContent = s.name[0].toUpperCase();
        dot.title = `${s.name} · ${fmt(s.stack)}`;
      } else {
        dot.textContent = '+';
        dot.title = 'Open seat — click to sit';
        dot.addEventListener('click', () => openTable(t.id, i));
      }
      mini.appendChild(dot);
    });
    card.querySelector('.watch').addEventListener('click', () => openTable(t.id));
    list.appendChild(card);
  }
}

const escapeHTML = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- table ----------
async function openTable(tableId, seat) {
  const res = await emit('table:watch', { tableId });
  if (!res.ok) return;
  if (app.tableId !== tableId) {
    $('log').innerHTML = '';
    if (app.view) app.view.destroy();
    app.view = new TableView($('stage'), { onSit: (i) => askBuyIn(i) });
    app.view.prev = null;
  }
  app.tableId = tableId;
  show('table-screen');
  app.view.resize(); // it was measured while the screen was still hidden
  renderTable(res.state);
  if (seat != null) {
    if (res.state.seats[seat]) toast('Someone just took that seat');
    else if (!res.state.me) askBuyIn(seat);
  }
}

$('back-btn').addEventListener('click', async () => {
  if (app.state && app.state.me) {
    if (!confirm('Leave the table? Your chips go back to your bankroll.')) return;
    await emit('table:stand');
  }
  voice.leave();
  await emit('table:leave');
  app.tableId = null;
  app.state = null;
  show('lobby');
});

socket.on('table:state', (state) => { if (state.id === app.tableId) renderTable(state); });

function renderTable(state) {
  const prev = app.state;
  app.state = state;
  $('t-name').textContent = state.name;
  $('t-blinds').textContent = `Blinds ${fmt(state.sb)}/${fmt(state.bb)}`;
  app.view.render(state, app.me.id);

  const me = state.me ? state.seats[state.me.seat] : null;
  $('stand-btn').classList.toggle('hidden', !me);
  $('sitout-btn').classList.toggle('hidden', !me);
  $('rebuy-btn').classList.toggle('hidden', !me || me.stack >= state.maxBuyIn);
  if (me) $('sitout-btn').textContent = me.sittingOut ? "I'm back" : 'Sit out';

  renderActions(state);

  const myTurn = state.me && state.me.legal;
  const wasMyTurn = prev && prev.handId === state.handId && prev.me && prev.me.legal;
  if (myTurn && !wasMyTurn) sfx.turn();
  // End of hand: the winner's card.
  const sameHand = prev && prev.id === state.id && prev.handId === state.handId;
  if (state.results && !(sameHand && prev.results)) winnerCard.show(state, app.me.id);
  else if (!state.results && prev && prev.results) winnerCard.hide();
}

const winnerCard = new WinnerCard($('stage'), {
  onShow: ({ tier, iWon, uncontested }) => {
    sfx.allin(); // the pot sliding over
    if (iWon || tier >= 3) setTimeout(() => sfx.fanfare(uncontested ? 0 : tier, iWon), 350);
  },
});

// ---------- actions ----------
function potRaiseTo(frac, state, legal) {
  // Pot-sized raise: call first, then raise by a fraction of the resulting pot.
  const bets = state.seats.reduce((t, s) => t + (s ? s.bet : 0), 0);
  const potAfterCall = state.pot + bets + legal.toCall;
  return state.currentBet + Math.round(potAfterCall * frac);
}

function renderActions(state) {
  const bar = $('action-bar');
  const legal = state.me && state.me.legal;
  bar.classList.toggle('idle', !legal);
  if (!legal) {
    const me = state.me && state.seats[state.me.seat];
    bar.dataset.idle = !me ? 'Click an open seat to join the game'
      : me.sittingOut ? (me.stack ? "You're sitting out — click I'm back to play" : 'Out of chips — Add chips to keep playing')
      : state.toAct >= 0 && state.seats[state.toAct] ? `Waiting on ${state.seats[state.toAct].name}…`
      : state.handActive ? 'Dealing…' : 'Next hand starting soon…';
    return;
  }
  bar.querySelector('.call').innerHTML = legal.canCheck
    ? 'Check <kbd>C</kbd>'
    : `Call ${fmt(legal.toCall)} <kbd>C</kbd>`;
  const raiseBtn = bar.querySelector('.raise');
  const box = bar.querySelector('.raise-box');
  raiseBtn.classList.toggle('hidden', !legal.canRaise);
  box.classList.toggle('hidden', !legal.canRaise);
  if (!legal.canRaise) return;

  const range = $('raise-range');
  const input = $('raise-input');
  range.min = input.min = legal.minRaiseTo;
  range.max = input.max = legal.maxRaiseTo;
  range.step = input.step = state.bb >= 10 ? Math.max(1, Math.floor(state.sb)) : 1;
  if (!(Number(input.value) >= legal.minRaiseTo && Number(input.value) <= legal.maxRaiseTo) || state.handId !== renderActions.hand || state.currentBet !== renderActions.bet) {
    input.value = range.value = legal.minRaiseTo;
  }
  renderActions.hand = state.handId;
  renderActions.bet = state.currentBet;
  updateRaiseLabel();
}

function updateRaiseLabel() {
  const legal = app.state && app.state.me && app.state.me.legal;
  if (!legal) return;
  const v = Number($('raise-input').value);
  const word = v >= legal.maxRaiseTo ? 'All-in' : legal.isBet ? 'Bet' : 'Raise to';
  $('action-bar').querySelector('.raise').innerHTML = `${word} ${fmt(v)} <kbd>R</kbd>`;
}

$('raise-range').addEventListener('input', (e) => { $('raise-input').value = e.target.value; updateRaiseLabel(); });
$('raise-input').addEventListener('input', (e) => { $('raise-range').value = e.target.value; updateRaiseLabel(); });

document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const state = app.state;
  const legal = state.me.legal;
  const p = b.dataset.preset;
  let v = p === 'min' ? legal.minRaiseTo : p === 'max' ? legal.maxRaiseTo : potRaiseTo(Number(p), state, legal);
  v = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, v));
  $('raise-input').value = $('raise-range').value = v;
  updateRaiseLabel();
}));

function doAction(kind) {
  const legal = app.state && app.state.me && app.state.me.legal;
  if (!legal) return;
  if (kind === 'fold') emit('table:action', { action: 'fold' });
  else if (kind === 'call') emit('table:action', { action: legal.canCheck ? 'check' : 'call' });
  else if (kind === 'raise' && legal.canRaise) {
    emit('table:action', { action: 'raise', amount: Number($('raise-input').value) });
  }
}
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => doAction(b.dataset.act)));
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  const k = e.key.toLowerCase();
  if (k === 'f') doAction('fold');
  else if (k === 'c') doAction('call');
  else if (k === 'r') doAction('raise');
});

$('stand-btn').addEventListener('click', () => emit('table:stand'));
$('sitout-btn').addEventListener('click', () => {
  const me = app.state.seats[app.state.me.seat];
  socket.emit('table:sitout', { value: !me.sittingOut });
});
$('rebuy-btn').addEventListener('click', () => {
  const me = app.state.seats[app.state.me.seat];
  const max = Math.min(app.state.maxBuyIn - me.stack, app.bankroll);
  if (max <= 0) return toast('Not enough play money — refill in the lobby');
  openModal({
    title: 'Add chips', sub: `Top up to at most ${fmt(app.state.maxBuyIn)} on the table.`,
    min: Math.min(app.state.bb * 10, max), max, value: max, ok: 'Add chips',
    onOk: (amount) => emit('table:rebuy', { amount }),
  });
});

// ---------- buy-in modal ----------
function askBuyIn(seat) {
  const t = app.state;
  if (t.me) return;
  if (app.bankroll < t.minBuyIn) return toast(`You need ${fmt(t.minBuyIn)} to sit here — refill in the lobby`);
  const max = Math.min(t.maxBuyIn, app.bankroll);
  openModal({
    title: `Sit at ${t.name}`,
    sub: `Seat ${seat + 1} · Blinds ${fmt(t.sb)}/${fmt(t.bb)} · Bankroll ${fmt(app.bankroll)}`,
    min: t.minBuyIn, max, value: max, ok: 'Sit down',
    onOk: (buyIn) => emit('table:sit', { seat, buyIn }),
  });
}

function openModal({ title, sub, min, max, value, ok, onOk }) {
  $('modal-title').textContent = title;
  $('modal-sub').textContent = sub;
  const r = $('modal-range');
  r.min = min; r.max = max; r.step = 1; r.value = value;
  const upd = () => { $('modal-amount').textContent = fmt(r.value); };
  r.oninput = upd;
  upd();
  $('modal-ok').textContent = ok;
  $('modal-ok').onclick = () => { $('modal').classList.add('hidden'); onOk(Number(r.value)); };
  $('modal').classList.remove('hidden');
}
$('modal-cancel').addEventListener('click', () => $('modal').classList.add('hidden'));

// ---------- dealer log & chat ----------
function log(html, cls = '') {
  const box = $('log');
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  line.innerHTML = html;
  box.appendChild(line);
  while (box.children.length > 200) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

socket.on('table:event', (evt) => {
  log(`<b class="dealer-name">Dealer</b> ${escapeHTML(evt.text)}`, evt.type);
  if (app.view && ['deal', 'board', 'win'].includes(evt.type)) app.view.say(evt.text);
  playEventSound(evt);
});

// Sounds follow the dealer's events, so everyone hears every action.
function playEventSound(evt) {
  if (evt.type === 'deal') sfx.card(4);
  else if (evt.type === 'board') sfx.card(evt.text.startsWith('The flop') ? 3 : 1);
  else if (evt.type === 'action') {
    if (evt.action === 'All-in') sfx.allin();
    else if (evt.action === 'Check') sfx.check();
    else if (['Call', 'Bet', 'Raise'].includes(evt.action)) sfx.chips();
  }
}

// Sound on/off (remembered on this device).
function renderSoundBtn() {
  $('sound-btn').textContent = sfx.enabled ? '🔊' : '🔇';
  $('sound-btn').title = sfx.enabled ? 'Sound on' : 'Sound off';
}
$('sound-btn').addEventListener('click', () => { sfx.setEnabled(!sfx.enabled); renderSoundBtn(); });
renderSoundBtn();

socket.on('table:chat', ({ name, color, text }) => {
  log(`<b style="color:${escapeHTML(color)}">${escapeHTML(name)}</b> ${escapeHTML(text)}`, 'chat');
  if (!chatOpen()) { unread++; renderBadge(); }
});

// ---------- chat panel show/hide ----------
// Remembered per device. Small screens start hidden so the table gets the room.
let unread = 0;
const chatSaved = (() => { try { return localStorage.getItem('ogp-chat'); } catch { return null; } })();
const smallScreen = () => matchMedia('(max-width: 900px), (orientation: landscape) and (max-height: 520px)').matches;
const chatOpen = () => !document.body.classList.contains('chat-hidden');
function setChat(open, remember = true) {
  document.body.classList.toggle('chat-hidden', !open);
  if (open) { unread = 0; renderBadge(); $('log').scrollTop = $('log').scrollHeight; }
  if (app.view) requestAnimationFrame(() => app.view.resize()); // table gets/loses the room
  $('chat-btn').title = open ? 'Hide chat' : 'Show chat';
  if (remember) try { localStorage.setItem('ogp-chat', open ? 'open' : 'closed'); } catch { /* private mode */ }
}
function renderBadge() {
  $('chat-badge').textContent = unread > 9 ? '9+' : unread;
  $('chat-badge').classList.toggle('hidden', !unread);
}
setChat(chatSaved ? chatSaved === 'open' : !smallScreen(), false);
$('chat-btn').addEventListener('click', () => setChat(!chatOpen()));
$('chat-close').addEventListener('click', () => setChat(false));
// On a phone the panel covers the table: tapping the table closes it.
$('stage').addEventListener('pointerdown', () => { if (smallScreen() && chatOpen()) setChat(false); });

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (text) socket.emit('chat', { text });
  $('chat-input').value = '';
});

// ---------- voice ----------
const voice = new Voice(socket, {
  onSpeaking: (set) => app.view && app.view.setSpeaking(set),
  onChange: () => {
    $('voice-join').classList.toggle('hidden', voice.active);
    $('voice-mute').classList.toggle('hidden', !voice.active);
    $('voice-leave').classList.toggle('hidden', !voice.active);
    $('voice-mute').innerHTML = voice.muted ? '🔇<span class="lbl"> Unmute</span>' : '🎙<span class="lbl"> Mute</span>';
    $('voice-mute').classList.toggle('danger', voice.muted);
    $('voice-count').textContent = voice.active ? `${voice.count} in voice` : '';
  },
});

$('voice-join').addEventListener('click', async () => {
  try {
    await voice.join(app.me.id);
    log('<b class="dealer-name">Voice</b> You joined voice chat. Others at this table who join will hear you.', 'info');
  } catch (e) {
    toast(location.protocol !== 'https:' && location.hostname !== 'localhost'
      ? 'Voice needs HTTPS (or localhost) to use your microphone'
      : 'Microphone permission was denied');
  }
});
$('voice-mute').addEventListener('click', () => voice.setMuted(!voice.muted));
$('voice-leave').addEventListener('click', () => voice.leave());

socket.on('disconnect', () => { voice.leave(); toast('Connection lost — reconnecting…'); });
socket.on('connect_error', () => toast('Waking up the game server… this can take up to a minute'));

if (!store.get('ogp-name')) show('login');

// ---------- landscape only ----------
// Installed app: the manifest asks for landscape. In a phone browser, landscape
// can only be locked while fullscreen, so touch devices get a fullscreen button.
// iPhones can't do either, so the portrait "turn your phone" screen covers them.
const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
const touch = matchMedia('(pointer: coarse)').matches;
const canFullscreen = !!(document.documentElement.requestFullscreen && document.fullscreenEnabled);

async function lockLandscape() {
  try { await screen.orientation.lock('landscape'); } catch { /* not supported here */ }
}
async function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { return; }
  lockLandscape();
}
document.querySelectorAll('.fs-btn').forEach((b) => {
  b.classList.toggle('hidden', !touch || standalone || !canFullscreen);
  b.addEventListener('click', toggleFullscreen);
});
if (standalone) lockLandscape();

// Installable app: register the service worker scoped to this app.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('service worker failed', e));
  });
}
