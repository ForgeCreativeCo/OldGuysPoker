// Table sounds. Recorded samples (public/sounds) for cards and chips, played
// through Web Audio so they start instantly and can overlap; small synthesized
// tones for check / your turn / win. Can be switched off (remembered per device).
let ctx = null;
let master = null;
const buffers = {};
const FILES = { card: 'sounds/card.mp3', chips: 'sounds/chips.mp3', allin: 'sounds/all-in.mp3' };

let enabled = true;
try { enabled = localStorage.getItem('ogp-sound') !== 'off'; } catch { /* private mode */ }

function ac() {
  if (ctx) return ctx;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = enabled ? 1 : 0;
  master.connect(ctx.destination);
  for (const [name, url] of Object.entries(FILES)) load(name, url);
  return ctx;
}

// Browsers keep audio suspended until the first tap or click.
const unlock = () => { ac().resume(); };
['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, unlock, { once: true, capture: true }));

async function load(name, url) {
  try {
    const data = await (await fetch(url)).arrayBuffer();
    const buf = await ctx.decodeAudioData(data);
    buffers[name] = { buf, start: firstSound(buf) };
  } catch (e) {
    console.warn('sound failed to load', url, e);
  }
}

/** Seconds of leading silence to skip, so the sound lands on the action. */
function firstSound(buf) {
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.02) return Math.max(0, i / buf.sampleRate - 0.005);
  return 0;
}

function sample(name, { delay = 0, volume = 1, maxDur = 1.6 } = {}) {
  const c = ac();
  const s = buffers[name];
  if (!s) return false;
  const src = c.createBufferSource();
  src.buffer = s.buf;
  const g = c.createGain();
  const t = c.currentTime + delay;
  const dur = Math.min(maxDur, s.buf.duration - s.start);
  g.gain.setValueAtTime(volume, t);
  g.gain.setValueAtTime(volume, t + dur - 0.08);
  g.gain.linearRampToValueAtTime(0, t + dur); // fade out instead of clicking off
  src.connect(g).connect(master);
  src.start(t, s.start, dur);
  return true;
}

function noise(duration, freq, gain, delay = 0) {
  const c = ac();
  const len = Math.floor(c.sampleRate * duration);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(master);
  src.start(c.currentTime + delay);
}

function tone(freq, duration, gain = 0.08, delay = 0) {
  const c = ac();
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + duration);
}

export const sfx = {
  /** One card, or several in a quick run (dealing, the flop). */
  card(count = 1) {
    for (let i = 0; i < count; i++) {
      if (!sample('card', { delay: i * 0.14, volume: 0.9, maxDur: 0.5 })) noise(0.06, 3000, 0.5, i * 0.14);
    }
  },
  chips() {
    if (!sample('chips', { volume: 0.7, maxDur: 1.2 })) { noise(0.05, 5200, 0.6); noise(0.05, 4600, 0.5, 0.06); }
  },
  allin() {
    if (!sample('allin', { volume: 1, maxDur: 2 })) this.chips();
  },
  check: () => { noise(0.03, 900, 0.9); noise(0.03, 900, 0.9, 0.11); },
  turn: () => { tone(880, 0.18); tone(1320, 0.25, 0.08, 0.12); },
  win: () => [523, 659, 784].forEach((f, i) => tone(f, 0.3, 0.06, i * 0.11)),
  /** Rising arpeggio; longer and brighter for bigger hands. */
  fanfare(tier = 0, mine = false) {
    const notes = [523, 659, 784, 1047, 1319, 1568].slice(0, 3 + Math.min(3, tier));
    const vol = mine ? 0.07 : 0.045;
    notes.forEach((f, i) => tone(f, 0.32, vol, i * 0.1));
    if (tier >= 3) [1047, 1319, 1568].forEach((f) => tone(f, 0.9, vol * 0.7, notes.length * 0.1 + 0.05));
  },

  get enabled() { return enabled; },
  setEnabled(on) {
    enabled = on;
    try { localStorage.setItem('ogp-sound', on ? 'on' : 'off'); } catch { /* private mode */ }
    if (master) master.gain.value = on ? 1 : 0;
  },
};
