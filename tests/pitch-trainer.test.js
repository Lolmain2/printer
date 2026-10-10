// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const Pitch = require("../pitch.js");
const C = require("../curriculum.js");
const T = require("../pitch-trainer.js");

const STEP = T.FRAME_SEC;
const TARGET = 50;
const NOW = new Date(2026, 9, 10, 12, 0, 0);

// Synthetic Mic frames {t, freq, rms} every `step` seconds over [from, to).
// `cents` is the offset from `target`: a number, a function of t, or null for
// an unvoiced frame.
function frames({ from, to, cents = 0, step = STEP, target = TARGET, rms }) {
  const out = [];
  const n = Math.round((to - from) / step);
  for (let i = 0; i < n; i++) {
    const t = from + i * step;
    const c = typeof cents === "function" ? cents(t) : cents;
    const voiced = c != null;
    const freq = voiced ? Pitch.midiToFreq(target + c / 100) : null;
    out.push({ t, freq, rms: rms != null ? rms : voiced ? 0.1 : 0 });
  }
  return out;
}

const capture = (t0 = 0) => T.createTrial({ kind: "capture", spec: T.CAPTURE, t0 });
const EMPTY_DAY = { tries: 0, hits: 0, blindTries: 0, blindHits: 0, lockSum: 0, lockN: 0, voicedSec: 0 };
const MEASURED = "2026-10-01T10:00:00.000Z";

function run(trial, list) {
  return list.reduce((tr, f) => T.stepTrial(tr, f), trial);
}

function near(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, msg || `${actual} is not within ${tol} of ${expected}`);
}

function withHome(home = 50, patch = {}) {
  const ps = T.defaultPitchState();
  return { ...ps, profile: { ...ps.profile, homeMidi: home, ...T.defaultRange(home) }, ...patch };
}

function match(stageId = 2, { t0 = 10, target = TARGET, ps = withHome(), rescue = false } = {}) {
  return T.createTrial({ kind: "match", spec: T.trialSpec(ps, stageId, { rescue }), target, t0 });
}

// ---- setup ------------------------------------------------------------------

test("captureMedian drops the first 0.2 s of voice and needs 0.8 s after that", () => {
  const lead = frames({ from: 0, to: 0.5, cents: null });
  // 0.2 s dropped + 13 frames (0.78 s) is too short; 14 frames (0.84 s) is enough.
  assert.equal(T.captureMedian([...lead, ...frames({ from: 0.5, to: 0.5 + 0.24 + 0.78 })]), null);
  near(T.captureMedian([...lead, ...frames({ from: 0.5, to: 0.5 + 0.24 + 0.84 })]), 50, 1e-9);
  assert.equal(T.captureMedian(frames({ from: 0, to: 0.7 })), null);
  assert.equal(T.captureMedian([]), null);
});

test("captureMedian ignores the onset scoop and takes the median", () => {
  const scoop = frames({ from: 0, to: 0.18, cents: -500 }); // 3 frames, all dropped
  const body = frames({ from: 0.18, to: 1.5, cents: (t) => [0, 20, 40][Math.round(t / STEP) % 3] });
  near(T.captureMedian([...scoop, ...body]), 50.2, 1e-9);
});

test("homeFromCaptures rounds, clamps and flags spread", () => {
  assert.deepEqual(
    { ...T.homeFromCaptures([48.2, 52.1, 52.6]), spread: undefined },
    { homeMidi: 52, spread: undefined, confident: false },
  );
  near(T.homeFromCaptures([48.2, 52.1, 52.6]).spread, 4.4, 1e-9);
  const one = T.homeFromCaptures([null, 50.4]);
  assert.equal(one.homeMidi, 50);
  assert.equal(one.confident, false);
  assert.equal(T.homeFromCaptures([30]).homeMidi, 40);
  assert.equal(T.homeFromCaptures([90, 91]).homeMidi, 72);
  assert.equal(T.homeFromCaptures([null, null]).homeMidi, null);
  assert.equal(T.homeFromCaptures([50.2, 51.0, 49.6]).confident, true);
});

test("needMoreHums", () => {
  assert.equal(T.needMoreHums([], 0), true);
  assert.equal(T.needMoreHums([50.1], 1), true);
  assert.equal(T.needMoreHums([50.1, null], 2), true);
  assert.equal(T.needMoreHums([50.1, 50.6], 2), false);
  assert.equal(T.needMoreHums([48, 52], 2), true); // spread 4
  assert.equal(T.needMoreHums([48, 52, 50], 3), true);
  assert.equal(T.needMoreHums([48, 52, 50, 51], 4), false); // capped at 4
});

test("defaultRange is an octave around home inside 36-84", () => {
  assert.deepEqual(T.defaultRange(50), { lowMidi: 44, highMidi: 56 });
  assert.deepEqual(T.defaultRange(40), { lowMidi: 36, highMidi: 46 });
  assert.deepEqual(T.defaultRange(80), { lowMidi: 74, highMidi: 84 });
});

test("adjustRange pulls the range in, but not past home +/- 2", () => {
  const p = withHome(50).profile;
  assert.equal(T.adjustRange(p, 55, "high").highMidi, 54);
  assert.equal(T.adjustRange(p, 55, "high").lowMidi, 44);
  assert.equal(T.adjustRange(p, 52, "high").highMidi, 52);
  assert.equal(T.adjustRange(p, 45, "low").lowMidi, 46);
  assert.equal(T.adjustRange(p, 48, "low").lowMidi, 48);
  assert.equal(T.adjustRange(p, 50, "high"), p);
  assert.equal(T.adjustRange(p, 50, "low"), p);
  // Already narrower than the target: unchanged.
  assert.equal(T.adjustRange({ ...p, highMidi: 53 }, 55, "high").highMidi, 53);
});

test("suggestRange and timbreFor", () => {
  assert.equal(T.suggestRange(48, C.RANGES), "low");
  assert.equal(T.suggestRange(53, C.RANGES), "mid");
  assert.equal(T.suggestRange(61, C.RANGES), "high");
  assert.equal(T.suggestRange(53), "mid");
  assert.equal(T.suggestRange(46, { b: { baseMidi: 44 }, a: { baseMidi: 40 } }), "a"); // tie goes low
  assert.equal(T.timbreFor(54, "voice"), "voice-low");
  assert.equal(T.timbreFor(55, "voice"), "voice-high");
  assert.equal(T.timbreFor(60, "plain"), "plain");
});

test("setHome resets the range, and a big move restarts the adaptive steps", () => {
  let ps = withHome(50, { span: 5, tolLevel: 2 });
  ps.profile.highMidi = 53;
  ps.stages["3"] = { passed: true, window: [1, 1, 0], tries: 3 };
  const small = T.setHome(ps, 52, { captures: [52.1], now: NOW });
  assert.deepEqual([small.profile.lowMidi, small.profile.highMidi], [46, 58]);
  assert.equal(small.span, 5);
  assert.deepEqual(small.stages["3"].window, [1, 1, 0]);
  assert.equal(small.profile.measuredAt, NOW.toISOString());
  const big = T.setHome(ps, 53, { now: NOW });
  assert.equal(big.span, 3);
  assert.equal(big.tolLevel, 0);
  assert.deepEqual(big.stages["3"], { passed: true, window: [], tries: 3 });
  assert.equal(ps.span, 5, "input not mutated");
});

// ---- targets ------------------------------------------------------------------

test("targetPool per stage, clipped to the range", () => {
  const ps = withHome(50);
  assert.deepEqual(T.targetPool(ps, 2), [48, 49, 50, 51, 52]);
  assert.deepEqual(T.targetPool(ps, 3), [47, 48, 49, 51, 52, 53]);
  assert.deepEqual(T.targetPool({ ...ps, span: 6 }, 3), [44, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56]);
  assert.equal(T.targetPool(ps, 4).length, 12);
  const narrowed = { ...ps, profile: { ...ps.profile, highMidi: 51 } };
  assert.deepEqual(T.targetPool(narrowed, 3), [47, 48, 49, 51]);
  const low = withHome(40);
  assert.deepEqual(T.targetPool(low, 4), [36, 37, 38, 39, 41, 42, 43, 44, 45, 46]);
  const empty = { ...ps, profile: { ...ps.profile, lowMidi: 50, highMidi: 50 } };
  assert.deepEqual(T.targetPool(empty, 3), [50]);
});

test("pickTarget never repeats the previous note", () => {
  const ps = withHome(50);
  const rng = T.mulberry32(1);
  let prev = null;
  for (let i = 0; i < 500; i++) {
    const m = T.pickTarget(ps, 3, { prev, rng });
    assert.notEqual(m, prev);
    assert.ok(T.targetPool(ps, 3).includes(m));
    prev = m;
  }
  // A one-note pool still returns that note.
  const one = { ...ps, profile: { ...ps.profile, lowMidi: 50, highMidi: 50 } };
  assert.equal(T.pickTarget(one, 3, { prev: 50, rng }), 50);
});

test("pickTarget weights weak notes about 3x and untried notes 1.25x", () => {
  const counts = (ps) => {
    const rng = T.mulberry32(1);
    const c = {};
    for (let i = 0; i < 3000; i++) {
      const m = T.pickTarget(ps, 2, { rng });
      c[m] = (c[m] || 0) + 1;
    }
    return c;
  };
  const strong = { n: 10, hits: 10, nC: 0, sumC: 0, sumC2: 0 };
  const notes = { 48: { ...strong, hits: 0 }, 49: strong, 50: strong, 51: strong, 52: strong };
  let c = counts(withHome(50, { notes }));
  let others = (c[49] + c[50] + c[51] + c[52]) / 4;
  near(c[48] / others, 3, 0.75);

  const untried = { 49: strong, 50: strong, 51: strong, 52: strong };
  c = counts(withHome(50, { notes: untried }));
  others = (c[49] + c[50] + c[51] + c[52]) / 4;
  near(c[48] / others, 1.25, 0.15);
});

test("mulberry32 is seeded and in [0, 1)", () => {
  const a = T.mulberry32(42);
  const b = T.mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(T.mulberry32(1)(), T.mulberry32(2)());
});

test("isBlind schedule", () => {
  const blindAt = (ps, stage) => [...Array(10).keys()].filter((i) => T.isBlind(ps, stage, i));
  const ps = withHome(50);
  assert.deepEqual(blindAt(ps, 1), []);
  assert.deepEqual(blindAt(ps, 2), []);
  assert.deepEqual(blindAt(ps, 3), [3, 7]);
  assert.deepEqual(blindAt(ps, 4), [3, 7]);
  assert.deepEqual(blindAt({ ...ps, tolLevel: 1 }, 4), [1, 3, 5, 7, 9]);
  assert.deepEqual(blindAt({ ...ps, tolLevel: 2 }, 4), [1, 3, 5, 7, 9]);
});

test("nextTrialPlan precedence: rescue, retry, then a fresh pick", () => {
  const ps = withHome(50);
  const rng = T.mulberry32(3);
  const rescue = T.nextTrialPlan(ps, 3, { prevTarget: 53, lastOutcome: "miss", missRun: 2, setIndex: 3, rng });
  assert.deepEqual(rescue, { target: 50, rescue: true, retry: false, blind: false });

  const retry = T.nextTrialPlan(ps, 3, { prevTarget: 53, lastOutcome: "miss", missRun: 1, setIndex: 3, rng });
  assert.deepEqual(retry, { target: 53, rescue: false, retry: true, blind: false });

  const found = T.nextTrialPlan(ps, 4, { prevTarget: 55, lastOutcome: "hit", lastGrade: "found", setIndex: 3, rng });
  assert.deepEqual(found, { target: 55, rescue: false, retry: true, blind: false });

  const fresh = T.nextTrialPlan(ps, 3, { prevTarget: 53, lastOutcome: "hit", missRun: 0, setIndex: 3, rng });
  assert.equal(fresh.retry, false);
  assert.equal(fresh.rescue, false);
  assert.equal(fresh.blind, true);
  assert.notEqual(fresh.target, 53);
  assert.equal(T.nextTrialPlan(ps, 3, { prevTarget: 53, lastOutcome: "close", setIndex: 2, rng }).blind, false);

  // A note cut by "Too high?" isn't retried.
  const cut = { ...ps, profile: { ...ps.profile, highMidi: 52 } };
  const after = T.nextTrialPlan(cut, 3, { prevTarget: 53, lastOutcome: "miss", missRun: 1, rng });
  assert.equal(after.retry, false);
  assert.ok(after.target <= 52);
});

test("trialSpec: Stage 4 tolerance ladder and rescue", () => {
  const ps = withHome(50, { tolLevel: 1 });
  assert.deepEqual(T.trialSpec(ps, 2), { tol: 50, holdSec: 1.0, windowSec: 8, refSec: 1.5, onset: false });
  assert.deepEqual(T.trialSpec(ps, 4), { tol: 35, holdSec: 0.8, windowSec: 5, refSec: 1.2, onset: true });
  const rescue = T.trialSpec(ps, 4, { rescue: true });
  assert.deepEqual(rescue, { tol: 60, holdSec: 0.8, windowSec: 5, refSec: 1.2, onset: false });
  assert.equal(T.trialSpec(withHome(50, { tolLevel: 2 }), 4).tol, 25);
  assert.equal(T.trialSpec(ps, 1).refSec, null);
});

// ---- trial engine -------------------------------------------------------------

test("stepTrial: steady on target from t0+0.5 hits after the onset grace plus the hold", () => {
  const t0 = 10;
  const quiet = frames({ from: t0, to: t0 + 0.5, cents: null });
  const tr = run(match(), [...quiet, ...frames({ from: t0 + 0.5, to: t0 + 4 })]);
  assert.equal(tr.status, "done");
  assert.equal(tr.result.outcome, "hit");
  near(tr.result.endT, t0 + 0.5 + 0.3 + 1.0, STEP);
  near(tr.result.lockSec, 0.3, 0.01);
  near(tr.result.steadyCents, 0, 1e-6);
  near(tr.result.sungMidi, 50, 1e-6);
  assert.equal(tr.result.octaveSlip, false);
  assert.equal(tr.result.grade, null);
  assert.equal(tr.result.target, 50);
});

test("stepTrial: a glide from -400 cents into the band, then held", () => {
  const t0 = 10;
  const start = t0 + 0.2;
  const glide = (t) => (t - start < 1 ? -400 + 350 * (t - start) : 0);
  const quiet = frames({ from: t0, to: start, cents: null });
  const tr = run(match(), [...quiet, ...frames({ from: start, to: start + 4, cents: glide })]);
  assert.equal(tr.result.outcome, "hit");
  assert.ok(tr.result.lockSec >= 1.0 && tr.result.lockSec <= 1.1, `lockSec ${tr.result.lockSec}`);
  near(tr.result.steadyCents, 0, 1);
});

test("stepTrial: a short unvoiced dropout keeps the hold, a long one resets it", () => {
  const t0 = 10;
  const pre = frames({ from: t0, to: t0 + 0.84 }); // 0.3 s grace + 0.54 s hold
  const short = run(match(), [
    ...pre,
    ...frames({ from: t0 + 0.84, to: t0 + 1.08, cents: null }), // 0.24 s
    ...frames({ from: t0 + 1.08, to: t0 + 4 }),
  ]);
  assert.equal(short.result.outcome, "hit");
  assert.equal(short.resets, 0);
  assert.ok(short.result.endT < t0 + 1.6, "hold carried on");

  const long = run(match(), [
    ...pre,
    ...frames({ from: t0 + 0.84, to: t0 + 1.34, cents: null }), // 0.48 s
    ...frames({ from: t0 + 1.34, to: t0 + 4 }),
  ]);
  assert.equal(long.result.outcome, "hit");
  assert.equal(long.resets, 1);
  assert.ok(long.result.endT > t0 + 1.34 + 1.2, "hold started over after a new onset");
});

test("stepTrial: a short out-of-band blip keeps the hold, a 0.3 s one resets it", () => {
  const t0 = 10;
  const pre = frames({ from: t0, to: t0 + 0.84 });
  const blip = run(match(), [
    ...pre,
    ...frames({ from: t0 + 0.84, to: t0 + 0.96, cents: 200 }),
    ...frames({ from: t0 + 0.96, to: t0 + 4 }),
  ]);
  assert.equal(blip.result.outcome, "hit");
  assert.equal(blip.resets, 0);
  assert.ok(blip.result.endT < t0 + 1.5);

  const long = run(match(), [
    ...pre,
    ...frames({ from: t0 + 0.84, to: t0 + 1.14, cents: 200 }),
    ...frames({ from: t0 + 1.14, to: t0 + 4 }),
  ]);
  assert.equal(long.result.outcome, "hit");
  assert.equal(long.resets, 1);
  assert.ok(long.result.endT >= t0 + 1.14 + 0.9);
});

test("stepTrial: reset thresholds are strict on the 60 ms frame grid", () => {
  // 14 frames on the note (0.3 s grace + 0.54 s hold), k odd frames, then on the note again.
  const resetsAfter = (k, cents) => {
    const odd = (t) => Math.round((t - 10) / STEP) >= 14 && Math.round((t - 10) / STEP) < 14 + k;
    const tr = run(match(), frames({ from: 10, to: 10 + 80 * STEP, cents: (t) => (odd(t) ? cents : 0) }));
    assert.equal(tr.result.outcome, "hit");
    return tr.resets;
  };
  assert.equal(resetsAfter(5, null), 0, "0.30 s unvoiced is not over 0.3 s");
  assert.equal(resetsAfter(6, null), 1);
  assert.equal(resetsAfter(3, 200), 0, "0.18 s out of band");
  assert.equal(resetsAfter(4, 200), 1, "0.24 s out of band");
});

test("stepTrial: an octave low at +20 cents is a hit with octaveSlip", () => {
  const tr = run(match(), frames({ from: 10, to: 13, cents: -1200 + 20 }));
  assert.equal(tr.result.outcome, "hit");
  assert.equal(tr.result.octaveSlip, true);
  near(tr.result.steadyCents, 20, 1e-6);
  near(tr.result.sungMidi, 38.2, 1e-6);
});

test("stepTrial: 7 semitones sharp misses at the deadline", () => {
  const t0 = 10;
  const tr = run(match(), frames({ from: t0, to: t0 + 9, cents: 700 }));
  assert.equal(tr.result.outcome, "miss");
  assert.ok(tr.result.endT >= t0 + 8 && tr.result.endT < t0 + 8 + STEP + 1e-9);
  near(tr.result.steadyCents, 700, 1e-6);
  near(tr.result.sungMidi, 57, 1e-6);
  assert.equal(tr.result.lockSec, null);
  near(tr.result.wobbleCents, 0, 1e-6);
});

test("stepTrial: held at +80 cents with tol 50 is close; silence is silent", () => {
  const close = run(match(), frames({ from: 10, to: 19, cents: 80 }));
  assert.equal(close.result.outcome, "close");
  near(close.result.steadyCents, 80, 1e-6);

  const silent = run(match(), frames({ from: 10, to: 19, cents: null }));
  assert.equal(silent.result.outcome, "silent");
  assert.equal(silent.result.steadyCents, null);
});

test("stepTrial: on-target bleed before t0 doesn't count", () => {
  const t0 = 10;
  const start = match();
  const bled = run(start, frames({ from: t0 - 2, to: t0 }));
  assert.deepEqual(bled, start);
  const tr = run(bled, frames({ from: t0, to: t0 + 9, cents: null }));
  assert.equal(tr.result.outcome, "silent");
  assert.equal(tr.result.frames.filter((f) => f.midi != null).length, 0);
});

test("replayTrial resets the hold and moves the deadline", () => {
  const t0 = 10;
  let tr = run(match(), frames({ from: t0, to: t0 + 0.9 }));
  assert.ok(tr.hold > 0.5);
  const nFrames = tr.frames.length;
  const voiced = tr.voicedSec;
  const gate = t0 + 3;
  tr = T.replayTrial(tr, gate);
  assert.equal(tr.hold, 0);
  assert.equal(tr.holdStartT, null);
  assert.equal(tr.deadline, gate + 8);
  assert.equal(tr.replays, 1);
  assert.equal(tr.frames.length, nFrames);
  assert.equal(tr.voicedSec, voiced);
  // Frames during the replay are gated out.
  tr = run(tr, frames({ from: t0 + 0.9, to: gate }));
  assert.equal(tr.hold, 0);
  assert.equal(tr.frames.length, nFrames);
  tr = run(tr, frames({ from: gate, to: gate + 3 }));
  assert.equal(tr.result.outcome, "hit");
  assert.equal(tr.result.replays, 1);
  near(tr.result.lockSec, 0.3, 0.01);
});

test("a 1 s gap between frames adds at most 0.1 s of hold", () => {
  let tr = run(match(), frames({ from: 10, to: 10.6 }));
  const before = tr.hold;
  assert.ok(before > 0);
  tr = T.stepTrial(tr, { t: tr.lastT + 1.0, freq: Pitch.midiToFreq(50), rms: 0.1 });
  assert.ok(tr.hold > before && tr.hold - before <= 0.1 + 1e-9);
});

test("capture: a +/-100 cent wobble never locks", () => {
  const wobble = (t) => 100 * Math.sin(2 * Math.PI * 3 * t);
  const tr = run(capture(), frames({ from: 0, to: 16, cents: wobble }));
  assert.equal(tr.status, "done");
  assert.equal(tr.target, null);
  assert.equal(tr.result.outcome, "miss");
  assert.ok(tr.result.endT >= 15);
});

test("capture: 0.6 s steady locks to the unrounded median, 1.5 s held is a hit", () => {
  const cents = (t) => [30, 35, 40][Math.round(t / STEP) % 3];
  const all = frames({ from: 0, to: 4, cents });
  let tr = capture();
  assert.equal(tr.deadline, null);
  tr = run(tr, all.filter((f) => f.t < 0.5));
  assert.equal(tr.target, null);
  tr = run(tr, all.filter((f) => f.t >= 0.5 && f.t < 0.7));
  assert.ok(tr.target != null, "locked by 0.66 s");
  near(tr.target, 50.35, 0.051);
  assert.notEqual(tr.target, Math.round(tr.target));
  assert.equal(tr.deadline, 15);
  tr = run(tr, all.filter((f) => f.t >= 0.7));
  assert.equal(tr.result.outcome, "hit");
  assert.ok(tr.result.endT <= 0.66 + 1.5 + 1e-9, `endT ${tr.result.endT}`);
  near(tr.result.target, 50.35, 0.051);
  near(tr.result.lockSec, 0.6, 0.07);
});

test("capture: 3 hold resets is a miss, no voice for 20 s is silent", () => {
  // Lock at 50, then alternate 0.3 s out of band and 0.3 s back in.
  const wobbly = (t) => (t < 0.65 ? 0 : Math.floor((t - 0.65) / 0.3) % 2 === 0 ? 200 : 0);
  const tr = run(capture(), frames({ from: 0, to: 6, cents: wobbly }));
  near(tr.target, 50, 1e-6);
  assert.equal(tr.result.outcome, "miss");
  assert.equal(tr.resets, 3);

  const quiet = run(capture(5), frames({ from: 5, to: 30, cents: null }));
  assert.equal(quiet.result.outcome, "silent");
  near(quiet.result.endT, 25, STEP);
});

test("onset grading at tol 50: found after a flat start, direct when landed, scoops forgiven", () => {
  const t0 = 10;
  const st4 = (list) => run(match(4), list);
  const flat = frames({ from: t0, to: t0 + 0.5, cents: -150 });
  const flatStart = st4([...flat, ...frames({ from: t0 + 0.5, to: t0 + 3 })]);
  assert.equal(flatStart.result.outcome, "hit");
  assert.equal(flatStart.result.grade, "found");
  near(flatStart.result.onsetCents, -150, 1e-6);

  const on = st4(frames({ from: t0, to: t0 + 3 }));
  assert.equal(on.result.outcome, "hit");
  assert.equal(on.result.grade, "direct");
  near(on.result.onsetCents, 0, 1e-6);

  const scoop = st4(frames({ from: t0, to: t0 + 3, cents: (t) => (t - t0 < 0.08 ? -300 : 0) }));
  assert.equal(scoop.result.grade, "direct");

  // A late landing within tol still counts as found.
  const late = st4(frames({ from: t0, to: t0 + 3, cents: (t) => (t - t0 < 0.7 ? -30 + (t - t0 < 0.4 ? 0 : 200) : 0) }));
  assert.equal(late.result.outcome, "hit");
  assert.equal(late.result.grade, "found");
});

test("onset grading only looks after the latest replay gate", () => {
  const t0 = 10;
  let tr = run(match(4), frames({ from: t0, to: t0 + 0.6, cents: -150 }));
  tr = T.replayTrial(tr, t0 + 2);
  tr = run(tr, frames({ from: t0 + 2, to: t0 + 5 }));
  assert.equal(tr.result.grade, "direct");
});

// ---- hints --------------------------------------------------------------------

test("coachHint by distance from the note", () => {
  const t0 = 10;
  const hint = (cents) => {
    const tr = T.stepTrial(match(2, { t0 }), { t: t0, freq: Pitch.midiToFreq(50 + cents / 100), rms: 0.1 });
    return T.coachHint(tr, t0);
  };
  assert.equal(hint(30).key, "on");
  assert.equal(hint(-30).key, "on");
  assert.equal(hint(30).text, "Hold it there…");
  const nudge = hint(80);
  assert.equal(nudge.key, "nudge");
  assert.equal(nudge.dir, -1);
  assert.equal(nudge.text, "A little lower");
  const close = hint(-180);
  assert.deepEqual([close.key, close.semis, close.dir], ["close", 2, 1]);
  assert.equal(close.text, "Higher, about 2 notes");
  assert.equal(hint(-120).text, "Higher, about 1 note");
  const far = hint(700);
  assert.deepEqual([far.key, far.semis, far.dir], ["far", 7, -1]);
  assert.equal(far.text, "Go lower (about 7 notes)");
  const oct = hint(-1200 + 20);
  assert.equal(oct.key, "octave");
  assert.match(oct.text, /one octave lower/);
});

test("coachHint: quiet, unclear, last frame unvoiced, capture steady", () => {
  const t0 = 10;
  let tr = match(2, { t0 });
  assert.equal(T.coachHint(tr, t0 + 2.9), null);
  assert.equal(T.coachHint(tr, t0 + 3).key, "quiet");

  tr = run(match(2, { t0 }), frames({ from: t0, to: t0 + 0.9, cents: null, rms: 0.05 }));
  assert.equal(T.coachHint(tr, t0 + 0.9), null);
  tr = run(tr, frames({ from: t0 + 0.9, to: t0 + 1.08, cents: null, rms: 0.05 }));
  assert.equal(T.coachHint(tr, t0 + 1.08).key, "unclear");

  tr = run(match(2, { t0 }), frames({ from: t0, to: t0 + 0.6 }));
  assert.equal(T.coachHint(tr, t0 + 0.6).key, "on");
  tr = T.stepTrial(tr, { t: t0 + 0.6, freq: null, rms: 0 });
  assert.equal(T.coachHint(tr, t0 + 0.6), null);

  const wobble = (t) => 100 * Math.sin(2 * Math.PI * 3 * t);
  let cap = run(capture(), frames({ from: 0, to: 1.5, cents: wobble }));
  assert.equal(T.coachHint(cap, 1.5), null);
  cap = run(cap, frames({ from: 1.5, to: 2.2, cents: wobble }));
  assert.equal(T.coachHint(cap, 2.2).key, "steady");
});

// ---- recording ----------------------------------------------------------------

function res(outcome, extra = {}) {
  const hit = outcome === "hit";
  return {
    outcome,
    grade: null,
    lockSec: hit ? 1.2 : null,
    steadyCents: hit ? 5 : outcome === "close" ? 80 : 150,
    sungMidi: 50.04,
    target: 50,
    kind: "match",
    ...extra,
  };
}

function feed(ps, stageId, list, opts = {}) {
  let change = null;
  const changes = [];
  for (const item of list) {
    const r = T.recordTrial(ps, stageId, typeof item === "string" ? res(item) : item, { now: NOW, ...opts });
    ps = r.ps;
    change = r.change;
    if (change) changes.push(change);
  }
  return { ps, change, changes };
}

const times = (n, x) => Array.from({ length: n }, () => x);

test("recordTrial keeps the last 10 window entries and counts tries", () => {
  const { ps } = feed(withHome(50), 2, times(12, "miss"));
  assert.equal(ps.stages["2"].window.length, 10);
  assert.equal(ps.stages["2"].tries, 12);
});

test("recordTrial returns a new object", () => {
  const ps = withHome(50);
  const before = JSON.stringify(ps);
  const out = T.recordTrial(ps, 2, res("hit"), { now: NOW });
  assert.notEqual(out.ps, ps);
  assert.equal(JSON.stringify(ps), before);
});

test("Stage 1 passes at 5 hits in the last 6", () => {
  let { ps } = feed(withHome(50), 1, ["hit", "hit", "miss", "hit", "miss", "hit"]);
  assert.equal(ps.stages["1"].passed, false);
  ps = feed(withHome(50), 1, ["hit", "hit", "hit", "hit", "hit"]).ps;
  assert.equal(ps.stages["1"].passed, false, "needs 6 entries");
  ps = feed(ps, 1, ["miss"]).ps;
  assert.equal(ps.stages["1"].passed, true);
  ps = feed(ps, 1, times(8, "miss")).ps;
  assert.equal(ps.stages["1"].passed, true, "passed never reverts");
  assert.equal(ps.notes["50"], undefined, "Stage 1 doesn't touch note stats");
});

test("Stage 2 passes at 8/10, or by fast track at 6/6 first tries", () => {
  let { ps } = feed(withHome(50), 2, ["miss", "miss", ...times(7, "hit")]);
  assert.equal(ps.stages["2"].passed, false);
  ps = feed(ps, 2, ["hit"]).ps;
  assert.equal(ps.stages["2"].passed, true);

  ps = feed(withHome(50), 2, times(5, "hit")).ps;
  assert.equal(ps.stages["2"].passed, false);
  ps = feed(ps, 2, ["hit"]).ps;
  assert.equal(ps.stages["2"].tries, 6);
  assert.equal(ps.stages["2"].passed, true);

  ps = feed(withHome(50), 2, ["miss", ...times(6, "hit")]).ps;
  assert.equal(ps.stages["2"].passed, false, "fast track is only for the first 6 tries");
});

test("Stage 3 span goes up at 8/10, down at 2/6, and passes at span 6", () => {
  let out = feed(withHome(50), 3, [...times(8, "hit"), "miss", "miss"]);
  assert.equal(out.ps.span, 4);
  assert.deepEqual(out.ps.stages["3"].window, []);
  assert.deepEqual(out.change, { type: "span-up", from: 3, to: 4 });

  out = feed(out.ps, 3, ["hit", "hit", "miss", "miss", "miss"]);
  assert.equal(out.ps.span, 4);
  out = feed(out.ps, 3, ["miss"]);
  assert.equal(out.ps.span, 3);
  assert.deepEqual(out.change, { type: "span-down", from: 4, to: 3 });
  assert.deepEqual(out.ps.stages["3"].window, []);

  // At the floor nothing changes and the window keeps filling.
  out = feed(out.ps, 3, times(7, "miss"));
  assert.equal(out.ps.span, 3);
  assert.equal(out.change, null);
  assert.equal(out.ps.stages["3"].window.length, 7);

  out = feed(withHome(50, { span: 6 }), 3, times(10, "hit"));
  assert.equal(out.ps.stages["3"].passed, true);
  assert.equal(out.ps.span, 6);
  assert.deepEqual(out.change, { type: "stage-passed", from: 3, to: 4 });
  assert.deepEqual(out.ps.stages["3"].window, []);
});

test("Stage 4 tolerance steps up and down; direct counts, found doesn't", () => {
  const direct = res("hit", { grade: "direct" });
  const found = res("hit", { grade: "found" });
  let out = feed(withHome(50), 4, times(10, found));
  assert.equal(out.ps.tolLevel, 0);
  assert.deepEqual(out.ps.stages["4"].window, times(10, 0));

  out = feed(withHome(50), 4, [...times(8, direct), found, found]);
  assert.equal(out.ps.tolLevel, 1);
  assert.deepEqual(out.change, { type: "tol-up", from: 0, to: 1 });
  assert.deepEqual(out.ps.stages["4"].window, []);
  assert.equal(T.TOL_LADDER[out.change.to], 35);

  out = feed(withHome(50, { tolLevel: 2 }), 4, [direct, direct, found, found, found, found]);
  assert.equal(out.ps.tolLevel, 1);
  assert.deepEqual(out.change, { type: "tol-down", from: 2, to: 1 });

  out = feed(withHome(50, { tolLevel: 2 }), 4, times(10, direct));
  assert.equal(out.ps.tolLevel, 2);
  assert.equal(out.ps.stages["4"].passed, true);
  assert.deepEqual(out.ps.stages["4"].window, []);
  out = feed(out.ps, 4, times(6, found));
  assert.equal(out.ps.stages["4"].passed, true);
});

test("uncounted and silent trials leave the window untouched", () => {
  const ps = feed(withHome(50), 2, ["hit", "miss"]).ps;
  for (const [result, opts] of [
    [res("hit"), { counted: false }],
    [res("silent"), {}],
    [{ ...res("hit"), kind: "capture" }, {}],
    [null, {}],
  ]) {
    const out = T.recordTrial(ps, 2, result, { now: NOW, ...opts });
    assert.equal(out.ps, ps);
    assert.equal(out.change, null);
  }
});

test("note stats halve past 40 tries and skip wild cents", () => {
  let { ps } = feed(withHome(50), 2, [res("miss", { steadyCents: 700 }), res("close", { steadyCents: -80 })]);
  assert.deepEqual(ps.notes["50"], { n: 2, hits: 0, nC: 1, sumC: -80, sumC2: 6400 });
  ps = feed(withHome(50), 3, times(40, res("hit", { target: 53, steadyCents: 10 }))).ps;
  assert.deepEqual(ps.notes["53"], { n: 40, hits: 40, nC: 40, sumC: 400, sumC2: 4000 });
  ps = feed(ps, 3, [res("hit", { target: 53, steadyCents: 10 })]).ps;
  assert.deepEqual(ps.notes["53"], { n: 20.5, hits: 20.5, nC: 20.5, sumC: 205, sumC2: 2050 });
});

test("days aggregate blind tries and lock times; recent is capped at 20", () => {
  let { ps } = feed(withHome(50), 3, [res("hit", { lockSec: 1.2 }), res("miss")], { blind: true });
  ps = feed(ps, 3, [res("hit", { lockSec: 0.8 })]).ps;
  const day = ps.days[T.dayKey(NOW)];
  assert.equal(day.tries, 3);
  assert.equal(day.hits, 2);
  assert.equal(day.blindTries, 2);
  assert.equal(day.blindHits, 1);
  near(day.lockSum, 2.0, 1e-9);
  assert.equal(day.lockN, 2);
  assert.equal(day.voicedSec, 0);

  ps = feed(ps, 2, times(25, res("close", { sungMidi: 50.456, steadyCents: 12.6 }))).ps;
  assert.equal(ps.recent.length, 20);
  assert.deepEqual(ps.recent[19], { s: 2, t: 50, sung: 50.46, c: 13, o: "close", g: null });
});

test("days keep the newest 60", () => {
  let ps = withHome(50);
  for (let i = 0; i < 65; i++) ps = T.recordTrial(ps, 2, res("miss"), { now: new Date(2026, 0, 1 + i, 12) }).ps;
  const keys = Object.keys(ps.days).sort();
  assert.equal(keys.length, 60);
  assert.equal(keys[0], T.dayKey(new Date(2026, 0, 6)));
});

// ---- stage status -------------------------------------------------------------

test("stageStatus and recommendedStage: setup first, then unlocks in order", () => {
  const none = T.defaultPitchState();
  assert.equal(T.recommendedStage(none), "setup");
  assert.equal(T.stageStatus(none, 1).unlocked, false);

  let ps = withHome(50);
  assert.equal(T.recommendedStage(ps), 1);
  assert.deepEqual([1, 2, 3, 4].map((id) => T.stageStatus(ps, id).unlocked), [true, false, false, false]);
  const pass = (p, id) => ({ ...p, stages: { ...p.stages, [id]: { ...p.stages[id], passed: true } } });
  ps = pass(ps, 1);
  assert.equal(T.recommendedStage(ps), 2);
  assert.deepEqual([1, 2, 3, 4].map((id) => T.stageStatus(ps, id).unlocked), [true, true, false, false]);
  // Passing a later stage doesn't skip a locked one.
  assert.equal(T.stageStatus(pass(ps, 3), 4).unlocked, false);
  ps = pass(pass(ps, 2), 3);
  assert.equal(T.recommendedStage(ps), 4);
  ps = pass(ps, 4);
  assert.equal(T.recommendedStage(ps), 4);
  assert.equal(T.stageStatus(ps, 4).passed, true);
});

test("stageStatus labels and hits", () => {
  const ps = withHome(50, { span: 4, tolLevel: 1 });
  ps.stages["1"] = { passed: false, window: [1, 0, 1, 0, 1, 1, 0, 1], tries: 8 };
  ps.stages["3"] = { passed: false, window: [1, 1, 0], tries: 3 };
  const s1 = T.stageStatus(ps, 1);
  assert.equal(s1.hits, 5);
  assert.equal(s1.label, "4 of your last 6 (need 5)");
  assert.equal(T.stageStatus(ps, 2).label, "0 of your last 10 (need 8)");
  assert.equal(T.stageStatus(ps, 3).label, "Notes up to 4 from home (goal 6) · 2/10 this step");
  assert.equal(T.stageStatus(ps, 4).label, "Target ±35¢ (next ±25¢) · 0/10 landed");
  assert.equal(T.stageStatus({ ...ps, tolLevel: 2 }, 4).label, "Target ±25¢ · 0/10 landed");
  assert.equal(T.TRAIN_STAGES.every((s) => typeof s.blurb === "string" && s.blurb.length > 20), true);
});

test("suggestEasier only at a stage's floor, with 6+ tries under 30%", () => {
  const poor = { passed: false, window: [0, 0, 0, 0, 0, 1], tries: 6 };
  const ps = (patch) => {
    const p = withHome(50, patch);
    for (const id of ["1", "2", "3", "4"]) p.stages[id] = poor;
    return p;
  };
  assert.equal(T.stageStatus(ps({}), 1).suggestEasier, false);
  assert.equal(T.stageStatus(ps({}), 2).suggestEasier, true);
  assert.equal(T.stageStatus(ps({ span: 3 }), 3).suggestEasier, true);
  assert.equal(T.stageStatus(ps({ span: 4 }), 3).suggestEasier, false);
  assert.equal(T.stageStatus(ps({ tolLevel: 0 }), 4).suggestEasier, true);
  assert.equal(T.stageStatus(ps({ tolLevel: 1 }), 4).suggestEasier, false);
  const short = withHome(50);
  short.stages["2"] = { passed: false, window: [0, 0, 0, 0, 0], tries: 5 };
  assert.equal(T.stageStatus(short, 2).suggestEasier, false);
  const ok = withHome(50);
  ok.stages["2"] = { passed: false, window: [0, 0, 0, 0, 1, 1], tries: 6 };
  assert.equal(T.stageStatus(ok, 2).suggestEasier, false);
});

// ---- stats --------------------------------------------------------------------

test("detectMonotone", () => {
  const e = (t, sung, s = 2) => ({ s, t, sung, c: null, o: "miss", g: null });
  const mono = [e(48, 49.8), e(52, 50.3), e(50, 50.1), e(53, 49.9), e(49, 50.4)];
  assert.deepEqual(T.detectMonotone(mono), { monotone: true, aroundMidi: 50 });
  assert.equal(T.detectMonotone(mono.slice(1)).monotone, false, "needs 5");
  assert.equal(T.detectMonotone([...mono.slice(1), e(49, 50.4, 1)]).monotone, false, "Stage 1 ignored");
  assert.equal(T.detectMonotone([...mono.slice(1), e(49, null)]).monotone, false, "null sung ignored");
  const tracking = [e(48, 48.1), e(52, 51.8), e(50, 50.1), e(53, 52.9), e(49, 49.2)];
  assert.equal(T.detectMonotone(tracking).monotone, false);
  const sameTarget = [e(50, 50), e(51, 50), e(50, 50.2), e(51, 50.1), e(50, 50)];
  assert.equal(T.detectMonotone(sameTarget).monotone, false, "target span under 3");
});

test("biasSummary", () => {
  assert.equal(T.biasSummary([-40, -40, -40, -40, -40]).tendency, null);
  assert.equal(T.biasSummary([-40, -40, -40, -40, -40]).mean, null);
  assert.deepEqual(T.biasSummary(times(6, -40)), { mean: -40, n: 6, tendency: "flat" });
  assert.equal(T.biasSummary(times(6, 35)).tendency, "sharp");
  assert.equal(T.biasSummary(times(6, 20)).tendency, null);
  assert.equal(T.biasSummary([...times(5, -40), 900, null, NaN]).n, 5);
  assert.equal(T.biasSummary([...times(20, 100), ...times(10, -40)]).mean, -40, "last 10 only");
});

test("addVoicedTime and fatigueNotice", () => {
  let ps = T.addVoicedTime(withHome(50), 599, NOW);
  assert.equal(T.fatigueNotice(ps, NOW), null);
  ps = T.addVoicedTime(ps, 1, NOW);
  assert.equal(T.fatigueNotice(ps, NOW), "break");
  ps = T.addVoicedTime(ps, 600, NOW);
  assert.equal(T.fatigueNotice(ps, NOW), "stop");
  assert.equal(T.fatigueNotice(ps, new Date(2026, 9, 11, 9)), null, "a new day starts fresh");
  assert.equal(ps.days[T.dayKey(NOW)].voicedSec, 1200);
  assert.equal(ps.days[T.dayKey(NOW)].tries, 0);
  assert.equal(T.addVoicedTime(ps, 0, NOW), ps);
});

test("dayStreak", () => {
  const day = (offset) => T.dayKey(new Date(2026, 9, 10 + offset, 12));
  const withDays = (offsets) => {
    const days = {};
    for (const o of offsets) days[day(o)] = { ...EMPTY_DAY, tries: 2, hits: 1 };
    return withHome(50, { days });
  };
  assert.equal(T.dayStreak(withDays([0, -1]), NOW), 2);
  assert.equal(T.dayStreak(withDays([-1]), NOW), 1);
  assert.equal(T.dayStreak(withDays([0, -2, -3]), NOW), 1);
  assert.equal(T.dayStreak(withDays([-1, -2, -4]), NOW), 2);
  assert.equal(T.dayStreak(withDays([-2]), NOW), 0);
  assert.equal(T.dayStreak(withDays([]), NOW), 0);
  assert.equal(T.dayStreak(withDays([0, -1]), NOW.getTime()), 2, "accepts ms");
});

test("trend is 14 days oldest first; weekSummary compares two weeks", () => {
  const days = {};
  const put = (offset, d) => {
    days[T.dayKey(new Date(2026, 9, 10 + offset, 12))] = { ...EMPTY_DAY, ...d };
  };
  put(0, { tries: 10, hits: 6, blindTries: 2, blindHits: 1, lockSum: 6, lockN: 4 });
  put(-6, { tries: 10, hits: 4 });
  put(-7, { tries: 4, hits: 1, lockSum: 3, lockN: 1 });
  put(-20, { tries: 50, hits: 50 });
  const ps = withHome(50, { days });

  const tr = T.trend(ps, NOW);
  assert.equal(tr.length, 14);
  assert.equal(tr[13].key, "2026-10-10");
  assert.equal(tr[0].key, "2026-09-27");
  assert.deepEqual(tr[13], { key: "2026-10-10", tries: 10, rate: 0.6, lockAvg: 1.5 });
  assert.deepEqual(tr[12], { key: "2026-10-09", tries: 0, rate: null, lockAvg: null });

  const w = T.weekSummary(ps, NOW);
  assert.equal(w.rate, 0.5);
  assert.equal(w.blindRate, 0.5);
  assert.equal(w.lockAvg, 1.5);
  assert.equal(w.prevRate, 0.25);
  assert.equal(w.prevLockAvg, 3);
  const empty = T.weekSummary(withHome(50), NOW);
  for (const k of ["rate", "blindRate", "lockAvg", "prevRate", "prevLockAvg"]) assert.equal(empty[k], null, k);
});

test("dayKey uses the local date", () => {
  assert.equal(T.dayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(T.dayKey(new Date(2026, 11, 31, 0, 1)), "2026-12-31");
  assert.equal(T.dayKey(new Date(2026, 2, 9, 0, 30).getTime()), "2026-03-09");
  assert.throws(() => T.dayKey(undefined));
});

test("steadiness is the population SD of 8+ values", () => {
  assert.equal(T.steadiness([0, 10, 0, 10, 0, 10, 0]), null);
  near(T.steadiness([0, 10, 0, 10, 0, 10, 0, 10]), 5, 1e-9);
  near(T.steadiness(times(8, 12)), 0, 1e-9);
});

test("noteChips cover the range with accuracy and consistency", () => {
  const notes = {
    48: { n: 12, hits: 9, nC: 12, sumC: -240, sumC2: 12 * (35 * 35 + 20 * 20) },
    50: { n: 2, hits: 2, nC: 2, sumC: 10, sumC2: 50 },
  };
  const chips = T.noteChips(withHome(50, { notes }));
  assert.deepEqual(chips.map((c) => c.midi), [44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56]);
  const c48 = chips.find((c) => c.midi === 48);
  assert.equal(c48.name, "C3");
  near(c48.rate, 0.75, 1e-9);
  near(c48.bias, -20, 1e-9);
  near(c48.spread, 35, 1e-9);
  assert.equal(c48.isHome, false);
  const home = chips.find((c) => c.isHome);
  assert.equal(home.midi, 50);
  assert.deepEqual([home.n, home.rate, home.bias, home.spread], [2, null, null, null]);
  assert.deepEqual(T.noteChips(T.defaultPitchState()), []);
});

// ---- lane geometry --------------------------------------------------------------

test("viewForPool: minimum span, maximum span, and shifting at 36 and 84", () => {
  assert.deepEqual(T.viewForPool([50]), { lo: 44, hi: 56 });
  assert.deepEqual(T.viewForPool([48, 49, 50, 51, 52]), { lo: 44, hi: 56 });
  assert.deepEqual(T.viewForPool([40, 60]), { lo: 41, hi: 59 });
  assert.deepEqual(T.viewForPool([36, 37]), { lo: 36, hi: 48 });
  assert.deepEqual(T.viewForPool([83, 84]), { lo: 72, hi: 84 });
  const frac = T.viewForPool([50.3]);
  assert.ok(Number.isInteger(frac.lo) && Number.isInteger(frac.hi));
  assert.ok(frac.lo <= 48.3 && frac.hi >= 52.3 && frac.hi - frac.lo === 12);
  const wide = T.viewForPool([44, 56]);
  assert.equal(wide.hi - wide.lo, 16);
});

test("laneY puts higher notes nearer the top and flags clipping", () => {
  const view = { lo: 44, hi: 56 };
  assert.deepEqual(T.laneY(56, view, 0, 130), { y: 5, clip: 0 });
  assert.deepEqual(T.laneY(44, view, 0, 130), { y: 125, clip: 0 });
  assert.ok(T.laneY(51, view, 0, 130).y < T.laneY(50, view, 0, 130).y);
  assert.deepEqual(T.laneY(60, view, 10, 130), { y: 10, clip: 1 });
  assert.deepEqual(T.laneY(40, view, 10, 130), { y: 140, clip: -1 });
  assert.equal(T.laneY(56.5, view, 0, 130).clip, 0);
});

test("traceSegments breaks on nulls, gaps over 0.15 s and jumps over 3 semitones", () => {
  const pts = [
    { t: 0, midi: 50 },
    { t: 0.06, midi: 50.1 },
    { t: 0.12, midi: null },
    { t: 0.18, midi: 50 },
    { t: 0.24, midi: 50.2 },
    { t: 0.5, midi: 50.3 }, // 0.26 s gap
    { t: 0.56, midi: 54 }, // 3.7 semitone jump
    { t: 0.62, midi: 54.1 },
    { t: 0.68, midi: 51.2 }, // 2.9: no break
  ];
  const segs = T.traceSegments(pts);
  assert.deepEqual(segs.map((s) => s.map((p) => p.t)), [[0, 0.06], [0.18, 0.24], [0.5], [0.56, 0.62, 0.68]]);
  assert.deepEqual(T.traceSegments([]), []);
});

// ---- persisted state --------------------------------------------------------------

test("normalizePitchState turns garbage into a valid default-shaped state", () => {
  const def = T.defaultPitchState();
  const wrongTypes = { profile: [], stages: [], notes: [], days: [], recent: {}, settings: [] };
  for (const raw of [null, undefined, "x", 42, [], wrongTypes]) assert.deepEqual(T.normalizePitchState(raw), def);
  assert.equal(T.normalizePitchState({ profile: { homeMidi: NaN } }).profile.homeMidi, null);
  assert.equal(T.normalizePitchState({ profile: { homeMidi: "50" } }).profile.homeMidi, null);
  const big = T.normalizePitchState({ profile: { homeMidi: 200, lowMidi: 10, highMidi: 300 } });
  assert.deepEqual(big.profile, { homeMidi: 72, lowMidi: 66, highMidi: 78, captures: [], measuredAt: null });

  const s = T.normalizePitchState({
    v: 7,
    profile: { homeMidi: 50, lowMidi: 46, highMidi: 53, captures: [50.2, "x", null], measuredAt: MEASURED },
    stages: {
      1: { passed: true, window: [1, 5, 0, "1", 1], tries: 3 },
      2: "nope",
      3: { passed: "yes", window: "1,1", tries: -4 },
    },
    span: 4.4,
    tolLevel: 9,
    notes: {
      50: { n: 4, hits: 3, nC: 4, sumC: -80, sumC2: 2000 },
      999: { n: 1, hits: 1, nC: 0, sumC: 0, sumC2: 0 },
      51: { n: -1, hits: 0, nC: 0, sumC: 0, sumC2: 0 },
      52: { n: 2, hits: 1 },
      abc: { n: 1, hits: 1, nC: 0, sumC: 0, sumC2: 0 },
    },
    days: { "2026-10-10": { tries: 3, hits: "2", voicedSec: 30 }, "2026-1-1": { tries: 1 }, "2026-10-09": 5 },
    recent: [
      { s: 2, t: 50, sung: 49.5, c: -50, o: "miss", g: null },
      { s: 9, t: 50, sung: 49.5, c: -50, o: "miss", g: null },
      { s: 2, t: 50, sung: "x", c: -50, o: "miss", g: null },
      "junk",
    ],
    settings: { timbre: "x", introSeen: "true" },
  });
  assert.equal(s.v, 1);
  assert.deepEqual(s.profile, {
    homeMidi: 50,
    lowMidi: 46,
    highMidi: 53,
    captures: [50.2, null, null],
    measuredAt: MEASURED,
  });
  assert.deepEqual(s.stages["1"], { passed: true, window: [1, 0, 1], tries: 3 });
  assert.deepEqual(s.stages["2"], def.stages["2"]);
  assert.deepEqual(s.stages["3"], { passed: false, window: [], tries: 0 });
  assert.equal(s.span, 4);
  assert.equal(s.tolLevel, 2);
  assert.deepEqual(Object.keys(s.notes), ["50"]);
  assert.deepEqual(s.notes["50"], { n: 4, hits: 3, nC: 4, sumC: -80, sumC2: 2000 });
  assert.deepEqual(Object.keys(s.days), ["2026-10-10"]);
  assert.deepEqual(s.days["2026-10-10"], { ...EMPTY_DAY, tries: 3, voicedSec: 30 });
  assert.deepEqual(s.recent, [{ s: 2, t: 50, sung: 49.5, c: -50, o: "miss", g: null }]);
  assert.deepEqual(s.settings, { timbre: "voice", introSeen: false });

  // A range that doesn't leave 2 notes either side of home falls back to the default.
  const tight = T.normalizePitchState({ profile: { homeMidi: 50, lowMidi: 49, highMidi: 60 } });
  assert.deepEqual([tight.profile.lowMidi, tight.profile.highMidi], [44, 56]);
  assert.equal(T.normalizePitchState({ span: "x" }).span, 3);
  assert.equal(T.normalizePitchState({ settings: { timbre: "plain", introSeen: true } }).settings.timbre, "plain");
});

test("normalizePitchState caps windows, days and recent", () => {
  const days = {};
  for (let i = 0; i < 70; i++) days[T.dayKey(new Date(2026, 0, 1 + i))] = { tries: 1 };
  const entry = (i) => ({ s: 3, t: 50 + (i % 3), sung: null, c: null, o: "close", g: null });
  const recent = Array.from({ length: 30 }, (_, i) => entry(i));
  const s = T.normalizePitchState({ stages: { 4: { passed: false, window: times(15, 1), tries: 15 } }, days, recent });
  assert.equal(s.stages["4"].window.length, 10);
  assert.equal(Object.keys(s.days).length, 60);
  assert.ok(!(T.dayKey(new Date(2026, 0, 1)) in s.days));
  assert.equal(s.recent.length, 20);
});

test("defaultPitchState round-trips through normalize and JSON unchanged", () => {
  const def = T.defaultPitchState();
  assert.deepEqual(T.normalizePitchState(def), def);
  assert.deepEqual(T.normalizePitchState(JSON.parse(JSON.stringify(def))), def);
  // A state built by the trainer survives a save and load too.
  let ps = withHome(50);
  ps = feed(ps, 2, ["hit", "miss", res("close", { steadyCents: -60 })]).ps;
  ps = T.addVoicedTime(ps, 42, NOW);
  assert.deepEqual(T.normalizePitchState(JSON.parse(JSON.stringify(ps))), ps);
});

// ---- review regressions -------------------------------------------------------

test("singing ~2 s and stopping is scored from the singing, not the silent end", () => {
  // Stage 2 (8 s window): sing +80¢ from t0+0.5 for 2 s, then silence to the deadline.
  const tr = run(match(2), [
    ...frames({ from: 10, to: 10.5, cents: null }),
    ...frames({ from: 10.5, to: 12.5, cents: 80 }),
    ...frames({ from: 12.5, to: 18.2, cents: null }),
  ]);
  assert.equal(tr.status, "done");
  assert.equal(tr.result.outcome, "close");
  near(tr.result.steadyCents, 80, 1);
  near(tr.result.sungMidi, TARGET + 0.8, 0.02);

  // Far off and stopping early still reports where the singer was.
  const far = run(match(2), [
    ...frames({ from: 10.5, to: 12.5, cents: -300 }),
    ...frames({ from: 12.5, to: 18.2, cents: null }),
  ]);
  assert.equal(far.result.outcome, "miss");
  near(far.result.sungMidi, TARGET - 3, 0.02);
});

test("Stage 4 retries a 'found' note once, then moves on", () => {
  const ps = withHome(50, { stages: { 1: { passed: true, window: [], tries: 0 }, 2: { passed: true, window: [], tries: 0 }, 3: { passed: true, window: [], tries: 0 }, 4: { passed: false, window: [], tries: 0 } } });
  const rng = T.mulberry32(3);
  const first = T.nextTrialPlan(ps, 4, { prevTarget: 53, lastOutcome: "hit", lastGrade: "found", missRun: 0, setIndex: 1, rng });
  assert.equal(first.retry, true);
  assert.equal(first.target, 53);
  const second = T.nextTrialPlan(ps, 4, { prevTarget: 53, lastOutcome: "hit", lastGrade: "found", lastRetry: true, missRun: 0, setIndex: 2, rng });
  assert.equal(second.retry, false);
  assert.notEqual(second.target, 53);
});

test("a capture that drifts to another note lets go and re-locks", () => {
  // Hum D3 (lock), breathe, then hold E3 (+200¢) steadily.
  const tr = run(capture(0), [
    ...frames({ from: 0, to: 1.0, cents: 0 }),
    ...frames({ from: 1.0, to: 1.5, cents: null }),
    ...frames({ from: 1.5, to: 6.0, cents: 200 }),
  ]);
  assert.equal(tr.status, "done");
  assert.equal(tr.result.outcome, "hit");
  near(tr.result.target, TARGET + 2, 0.01);
  assert.ok(tr.result.endT < 5.0, `expected a hit within ~4.3 s, got ${tr.result.endT}`);
});

test("coachHint says 'unclear' for pitchless sound even before any voiced frame", () => {
  const tr = run(match(2), frames({ from: 10, to: 14, cents: null, rms: 0.05 }));
  assert.equal(T.coachHint(tr, 14).key, "unclear");
  const quiet = run(match(2), frames({ from: 10, to: 14, cents: null }));
  assert.equal(T.coachHint(quiet, 14).key, "quiet");
});

test("noteChips report raw hit counts for honest tooltips", () => {
  const ps = withHome(50, { notes: { 50: { n: 20.5, hits: 15, nC: 0, sumC: 0, sumC2: 0 } } });
  const chip = T.noteChips(ps).find((c) => c.midi === 50);
  assert.equal(chip.hits, 15);
  assert.equal(Math.round(chip.n), 21);
});
