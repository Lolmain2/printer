// Tests for the tracker API added to pitch.js (createTracker, FRAME_SIZE,
// frameSizeFor).
const test = require("node:test");
const assert = require("node:assert/strict");
const Pitch = require("../pitch.js");

const SR = 48000;
const HOP = Math.round(0.06 * SR); // the app's 60 ms tick

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

// Pulse-train "voice": a decaying resonance retriggered every period, with
// small period jitter, plus optional noise; `f0(t)` gives the pitch.
function voice(secs, f0, { level = 0.01, noise = 0, jitter = 0.005, seed = 1 } = {}) {
  const r = rng(seed);
  const n = Math.round(secs * SR);
  const out = new Float32Array(n);
  let next = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    if (i >= next) {
      phase = 0;
      next = i + (SR / f0(i / SR)) * (1 + jitter * r());
    }
    out[i] = Math.exp(-phase / 120) * Math.sin(phase * 0.045) + noise * r();
    phase++;
  }
  let sum = 0;
  for (const v of out) sum += v * v;
  const k = level / Math.sqrt(sum / n);
  return out.map((v) => v * k);
}

function noise(secs, level, seed = 3) {
  const r = rng(seed);
  return new Float32Array(Math.round(secs * SR)).map(() => level * r() * 1.7);
}

function track(samples, tracker = Pitch.createTracker()) {
  const N = Pitch.FRAME_SIZE;
  const out = [];
  for (let end = N; end <= samples.length; end += HOP) out.push(tracker.push(samples.subarray(end - N, end), SR));
  return out;
}

const cents = (a, b) => 1200 * Math.log2(a / b);

test("FRAME_SIZE is an AnalyserNode-friendly power of two; frameSizeFor keeps ~85 ms", () => {
  assert.equal(Pitch.FRAME_SIZE, 4096);
  assert.equal(Pitch.frameSizeFor(48000), 4096);
  assert.equal(Pitch.frameSizeFor(44100), 4096);
  assert.equal(Pitch.frameSizeFor(96000), 8192);
});

test("silence and room noise read as no pitch", () => {
  assert.ok(track(new Float32Array(SR)).every((f) => f === null));
  assert.ok(track(noise(1.5, 0.01)).every((f) => f === null));
});

test("a quiet low G1 (49 Hz) is read steadily, with no gaps", () => {
  const f = Pitch.midiToFreq(31);
  const out = track(voice(1.5, () => f, { level: 0.004, noise: 0.05 }));
  const tail = out.slice(1);
  assert.ok(tail.every((v) => v !== null), `gaps: ${out.map((v) => (v ? v.toFixed(1) : "-")).join(" ")}`);
  assert.ok(tail.every((v) => Math.abs(cents(v, f)) < 30));
});

test("mains hum alone is not a note", () => {
  for (const hz of [50, 60]) {
    const r = rng(9);
    const hum = new Float32Array(2 * SR).map((_, i) => 0.003 * (Math.sin((2 * Math.PI * hz * i) / SR) + 0.5 * Math.sin((4 * Math.PI * hz * i) / SR)) + 0.0002 * r());
    assert.ok(track(hum).every((v) => v === null), `${hz} Hz hum read as a note`);
  }
});

test("follows a leap and a glide without sticking to the old note", () => {
  const a = Pitch.midiToFreq(40);
  const b = Pitch.midiToFreq(52); // an octave up
  const out = track(voice(1.6, (t) => (t < 0.8 ? a : b), { level: 0.02 }));
  const late = out.slice(-6);
  assert.ok(late.every((v) => v && Math.abs(cents(v, b)) < 30), `after the leap: ${late}`);
  // 1 octave/s siren: every reading within a semitone of where the voice was ~50 ms ago
  const g = (t) => a * Math.pow(2, Math.min(1, Math.max(0, t - 0.3)));
  const samples = voice(1.6, g, { level: 0.02 });
  const N = Pitch.FRAME_SIZE;
  const tr = Pitch.createTracker();
  for (let end = N; end <= samples.length; end += HOP) {
    const v = tr.push(samples.subarray(end - N, end), SR);
    assert.ok(v && Math.abs(cents(v, g(end / SR - 0.05))) < 100, `at ${(end / SR).toFixed(2)} s: ${v}`);
  }
});

test("reset() forgets the note; last carries the frame's details", () => {
  const f = Pitch.midiToFreq(45);
  const tr = Pitch.createTracker();
  track(voice(0.6, () => f, { level: 0.02 }), tr);
  assert.ok(tr.last.freq && tr.last.clarity > 0.5);
  tr.reset();
  assert.equal(tr.last.freq, null);
  assert.equal(tr.push(new Float32Array(Pitch.FRAME_SIZE), SR), null);
});

test("detectPitch still works one-off on 2048-sample blocks (pickClip)", () => {
  const f = Pitch.midiToFreq(45);
  const r = Pitch.detectPitch(voice(0.2, () => f, { level: 0.004 }).subarray(4000, 4000 + 2048), SR);
  assert.ok(r && Math.abs(cents(r.freq, f)) < 10, `got ${r && r.freq}`);
  assert.equal(Pitch.detectPitch(noise(0.1, 0.02).subarray(0, 2048), SR), null);
});
