// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const Pitch = require("../pitch.js");

const SR = 48000;
const N = 2048;

// A voice-like tone: fundamental plus decaying harmonics.
function voiceLike(freq, { harmonics = 6, amp = 0.5, noise = 0, phase = 0.3 } = {}) {
  const buf = new Float32Array(N);
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * freq * h * (i / SR) + phase * h) / h;
    buf[i] = amp * v * 0.5 + noise * rand();
  }
  return buf;
}

function cents(a, b) {
  return 1200 * Math.log2(a / b);
}

test("detects voice-like tones across the singing range within 5 cents", () => {
  for (const midi of [40, 45, 50, 57, 62, 69, 76]) {
    const f = Pitch.midiToFreq(midi);
    const r = Pitch.detectPitch(voiceLike(f), SR);
    assert.ok(r, `no pitch at midi ${midi}`);
    assert.ok(Math.abs(cents(r.freq, f)) < 5, `midi ${midi}: got ${r.freq.toFixed(2)} want ${f.toFixed(2)}`);
  }
});

test("doesn't jump an octave when the fundamental is weak", () => {
  const f = 110;
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    buf[i] = 0.1 * Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * 2 * f * t) + 0.3 * Math.sin(2 * Math.PI * 3 * f * t);
  }
  const r = Pitch.detectPitch(buf, SR);
  assert.ok(r);
  assert.ok(Math.abs(cents(r.freq, f)) < 10, `got ${r.freq}`);
});

test("tolerates light noise", () => {
  const r = Pitch.detectPitch(voiceLike(196, { noise: 0.05 }), SR);
  assert.ok(r && Math.abs(cents(r.freq, 196)) < 10);
});

test("returns null for silence and for noise (breath, heavy distortion)", () => {
  assert.equal(Pitch.detectPitch(new Float32Array(N), SR), null);
  const noise = new Float32Array(N);
  let seed = 7;
  for (let i = 0; i < N; i++) noise[i] = ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.6;
  assert.equal(Pitch.detectPitch(noise, SR), null);
});

test("note names", () => {
  assert.equal(Pitch.noteName(69), "A4");
  assert.equal(Pitch.noteName(60), "C4");
  assert.equal(Pitch.noteName(45), "A2");
  assert.equal(Pitch.noteName(Pitch.freqToMidi(146.83)), "D3");
});

test("compareToTarget folds octaves and keeps the sign", () => {
  const t = 220;
  assert.ok(Math.abs(Pitch.compareToTarget(220, t).cents) < 1e-9);
  const flat = Pitch.compareToTarget(220 * Math.pow(2, -30 / 1200), t);
  assert.ok(Math.abs(flat.cents + 30) < 1e-6 && flat.octaves === 0);
  const octDown = Pitch.compareToTarget(110 * Math.pow(2, 20 / 1200), t);
  assert.ok(Math.abs(octDown.cents - 20) < 1e-6);
  assert.equal(octDown.octaves, -1);
});

test("judge buckets", () => {
  assert.equal(Pitch.judge(0), "on");
  assert.equal(Pitch.judge(-49), "on");
  assert.equal(Pitch.judge(-70), "slightly-flat");
  assert.equal(Pitch.judge(80), "slightly-sharp");
  assert.equal(Pitch.judge(-300), "flat");
  assert.equal(Pitch.judge(250), "sharp");
});

test("targetAt follows held notes and siren glides", () => {
  const segs = [
    { start: 0, end: 1, from: 220 },
    { start: 2, end: 6, from: 220, to: 440 },
  ];
  assert.equal(Pitch.targetAt(segs, 0.5), 220);
  assert.equal(Pitch.targetAt(segs, 1.5), null); // gap between notes
  assert.ok(Math.abs(Pitch.targetAt(segs, 4) - 440) < 1e-9); // top of the siren
  assert.ok(Math.abs(Pitch.targetAt(segs, 3) - 220 * Math.SQRT2) < 1e-9); // halfway up
  assert.ok(Math.abs(Pitch.targetAt(segs, 5) - 220 * Math.SQRT2) < 1e-9); // halfway down
  assert.equal(Pitch.targetAt(segs, 6), null);
});

test("bestMatch forgives singing slightly behind the reference", () => {
  const segs = [
    { start: 0, end: 1, from: 220 },
    { start: 1, end: 2, from: 247 },
  ];
  // At t=1.1 the reference moved to 247 Hz but the singer is still on 220.
  const m = Pitch.bestMatch(segs, 1.1, 220);
  assert.equal(m.target, 220);
  assert.equal(Pitch.judge(m.cents), "on");
  assert.equal(Pitch.bestMatch([], 1, 220), null);
});

test("smooth3 matches the old Mic.read median-of-3", () => {
  let st = { recent: [] };
  const out = [100, 110, 105].map((f) => (st = Pitch.smooth3(st.recent, f)).value);
  assert.deepEqual(out, [100, 110, 105]);
  assert.equal(Pitch.smooth3([200], 100).value, 200); // two values -> the larger
  assert.deepEqual(Pitch.smooth3([1, 2, 3], null), { recent: [], value: null });
  assert.deepEqual(Pitch.smooth3([1, 2, 3], 4).recent, [2, 3, 4]);
});

test("median", () => {
  assert.equal(Pitch.median([]), null);
  const xs = [3, 1, 2];
  assert.equal(Pitch.median(xs), 2);
  assert.deepEqual(xs, [3, 1, 2]); // not mutated
  assert.equal(Pitch.median([1, 2, 3, 4]), 2.5);
});

test("pitchError only folds near-octave copies of the target", () => {
  const at = (midi) => Pitch.midiToFreq(midi);
  const near = (a, b) => Math.abs(a - b) < 1e-6;

  let e = Pitch.pitchError(at(57), 50); // 7 semitones sharp
  assert.ok(near(e.cents, 700) && e.octaves === 1 && !e.octaveSlip);

  e = Pitch.pitchError(at(38.3), 50); // octave low, +30
  assert.ok(near(e.cents, 30) && e.octaveSlip && e.octaves === -1);

  e = Pitch.pitchError(at(36.5), 50); // octave low, -150
  assert.ok(e.octaveSlip && near(e.cents, -150));

  e = Pitch.pitchError(at(42), 50); // raw -800
  assert.ok(near(e.cents, -800) && !e.octaveSlip);

  e = Pitch.pitchError(at(65), 50); // raw +1500
  assert.ok(near(e.cents, 1500) && !e.octaveSlip);

  assert.ok(!Pitch.pitchError(at(56), 50).octaveSlip); // +600 boundary
  assert.ok(!Pitch.pitchError(at(44), 50).octaveSlip); // -600 boundary
  assert.ok(near(Pitch.pitchError(at(50), 50).cents, 0));
});

function tone(midi, secs) {
  const f = Pitch.midiToFreq(midi);
  const out = new Float32Array(Math.round(secs * SR));
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * (i / SR) + 0.3 * h) / h;
    out[i] = 0.25 * v;
  }
  return out;
}

function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const silence = (secs) => new Float32Array(Math.round(secs * SR));

test("pickClip finds the steady part of a recording", () => {
  const rec = concat(silence(1), tone(50, 2));
  const c = Pitch.pickClip(rec, SR, 50);
  assert.ok(c, "expected a clip");
  assert.ok(c.start >= SR * 1 && c.end <= rec.length, `clip ${c.start}-${c.end} outside the steady part`);
  assert.ok(Math.abs((c.end - c.start) / SR - 1.2) < 0.01);
  assert.ok(Math.abs(c.midi - 50) < 0.1);
});

test("pickClip returns null without a usable steady note", () => {
  assert.equal(Pitch.pickClip(silence(3), SR, 50), null);
  assert.equal(Pitch.pickClip(tone(55, 2), SR, 50), null); // 5 semitones off
  assert.equal(Pitch.pickClip(concat(silence(2.5), tone(50, 0.5)), SR, 50), null); // too short
});

test("pickClip prefers the longer run, and the later one on a tie", () => {
  // 1.5 s run, gap, 0.9 s run: the longer (first) wins.
  let rec = concat(tone(50, 1.5), silence(0.4), tone(50, 0.9));
  let c = Pitch.pickClip(rec, SR, 50, { searchSec: 2.8 });
  assert.ok(c.end <= 1.6 * SR, "longer first run should win");
  // Two equal 1 s runs: the later one wins.
  rec = concat(tone(50, 1), silence(0.5), tone(50, 1));
  c = Pitch.pickClip(rec, SR, 50, { searchSec: 2.5 });
  assert.ok(c.start >= 1.4 * SR, "later run should win the tie");
});

test("clipGain", () => {
  const sq = (a) => new Float32Array(1000).map((_, i) => (i % 2 ? a : -a));
  assert.equal(Pitch.clipGain(sq(0.02), 0, 1000), 4);
  assert.ok(Math.abs(Pitch.clipGain(sq(0.08), 0, 1000) - 1) < 1e-6);
  assert.equal(Pitch.clipGain(new Float32Array(1000), 0, 1000), 1);
});
