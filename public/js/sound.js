// Tiny synthesized table sounds — no audio files needed.
let ctx = null;
const ac = () => (ctx ||= new AudioContext());

function noise(duration, freq, gain) {
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
  src.connect(f).connect(g).connect(c.destination);
  src.start();
}

function tone(freq, duration, gain = 0.08) {
  const c = ac();
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + duration);
  o.connect(g).connect(c.destination);
  o.start();
  o.stop(c.currentTime + duration);
}

export const sfx = {
  card: () => noise(0.06, 3000, 0.5),
  chips: () => { noise(0.05, 5200, 0.6); setTimeout(() => noise(0.05, 4600, 0.5), 60); },
  check: () => { noise(0.03, 900, 0.9); setTimeout(() => noise(0.03, 900, 0.9), 110); },
  turn: () => { tone(880, 0.18); setTimeout(() => tone(1320, 0.25), 120); },
  win: () => [523, 659, 784].forEach((f, i) => setTimeout(() => tone(f, 0.3, 0.06), i * 110)),
};
