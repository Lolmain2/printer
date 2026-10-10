// Pitch tab training logic: setup helpers, target choice, the trial reducer,
// adaptive stages and practice stats. Pure functions over plain objects, unit
// tested in Node (see tests/pitch-trainer.test.js).
//
// Trial times are seconds on the audio clock. Calendar helpers take `now` (a
// Date or ms) from the caller and never read the clock themselves.

(function (root) {
  const Pitch = root.Pitch || (typeof require !== "undefined" ? require("./pitch.js") : null);
  const Curriculum = root.Curriculum || (typeof require !== "undefined" ? require("./curriculum.js") : null);

  // Design parameters inferred from the research (not taken from the papers),
  // kept in one place so they can be tuned.
  const FRAME_SEC = 0.06;
  const TOL_LADDER = [50, 35, 25];
  const GRACE = { outSec: 0.2, unvoicedSec: 0.3, ignoreOnsetSec: 0.3, dtCap: 0.1 };
  const TIMING = { imagineSec: 0.7, replayTailSec: 0.25, autoNextSec: 1.5, gapNoteSec: 0.6, gapPauseSec: 0.15 };
  const CAPTURE = {
    tol: 50,
    holdSec: 1.5,
    windowSec: 15,
    idleSec: 20,
    lockSec: 0.6,
    lockMinFrames: 7,
    lockSpreadCents: 60,
    maxResets: 3,
  };
  const SET_SIZE = 10;
  const TRAIN_STAGES = [
    {
      id: 1,
      key: "echo",
      name: "Your note",
      tol: 50,
      holdSec: 1.0,
      windowSec: 8,
      refSec: null,
      onset: false,
      blurb: "Hum any easy note, then sing your own recording back. Your own voice is the easiest thing to copy.",
    },
    {
      id: 2,
      key: "near",
      name: "Near home",
      tol: 50,
      holdSec: 1.0,
      windowSec: 8,
      refSec: 1.5,
      onset: false,
      blurb: "Notes within 2 of your home note. Slide until the line sits in the green band, then hold still.",
    },
    {
      id: 3,
      key: "widen",
      name: "Widen your range",
      tol: 50,
      holdSec: 1.0,
      windowSec: 7,
      refSec: 1.5,
      onset: false,
      blurb:
        "Random notes spreading out to an octave around home. Wide-range practice is what improved pitch matching " +
        "in training studies. Some tries are blind.",
    },
    {
      id: 4,
      key: "land",
      name: "Land it",
      tol: null, // TOL_LADDER[tolLevel]
      holdSec: 0.8,
      windowSec: 5,
      refSec: 1.2,
      onset: true,
      blurb: "Sliding into notes is normal. Now practise landing straight on, then tighten the target.",
    },
  ];
  // Scoring and hint thresholds used by the trial engine.
  const SCORING = {
    silentSec: 0.3, // less voiced time than this is "silent"
    unclearRms: 0.02, // unvoiced but this loud = sound without a clear pitch
    steadyFromSec: 1.35, // misses are scored on [end - 1.35, end - 0.15]
    steadyToSec: 0.15,
    steadyFallbackSec: 2,
    minSteady: 3,
    wobbleMin: 5,
    onsetRunSec: 0.25,
    onsetGapSec: 0.1,
    onsetFromSec: 0.1,
    onsetToSec: 0.4,
    onsetMin: 3,
    directHoldSec: 0.6, // a direct landing starts its hold within this of the onset
    quietSec: 3,
    unclearSec: 1.0,
    steadyHintSec: 2,
  };
  const HOME_MIN = 40;
  const HOME_MAX = 72;
  const MIDI_MIN = 36;
  const MIDI_MAX = 84;
  const WINDOW_MAX = 10;
  const DAYS_MAX = 60;
  const RECENT_MAX = 20;
  // Frame times carry float noise (0.06 steps), so durations are compared with
  // a tiny margin to make grid-aligned input behave predictably.
  const EPS = 1e-6;

  // ---- small helpers ------------------------------------------------------

  function isNum(x) {
    return typeof x === "number" && Number.isFinite(x);
  }

  function isObj(x) {
    return x != null && typeof x === "object" && !Array.isArray(x);
  }

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  function sum(values) {
    let s = 0;
    for (const v of values) s += v;
    return s;
  }

  function popSd(values) {
    const mean = sum(values) / values.length;
    return Math.sqrt(sum(values.map((v) => (v - mean) * (v - mean))) / values.length);
  }

  function ratio(a, b) {
    return b > 0 ? a / b : null;
  }

  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  function toDate(now) {
    const d = now instanceof Date ? now : isNum(now) ? new Date(now) : null;
    if (!d || Number.isNaN(d.getTime())) throw new TypeError("now must be a Date or a time in ms");
    return d;
  }

  // Local midnight `k` days from `d` (DST-safe, unlike adding 24 h).
  function addDays(d, k) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
  }

  function stageById(id) {
    return TRAIN_STAGES.find((s) => s.id === Number(id)) || null;
  }

  function stageState(ps, id) {
    const st = ps && ps.stages && ps.stages[String(id)];
    return isObj(st) ? st : { passed: false, window: [], tries: 0 };
  }

  function homeOf(ps) {
    const h = ps && ps.profile && ps.profile.homeMidi;
    return isNum(h) ? h : null;
  }

  function spanOf(ps) {
    return ps && isNum(ps.span) ? ps.span : 3;
  }

  function tolLevelOf(ps) {
    return ps && isNum(ps.tolLevel) ? clamp(ps.tolLevel, 0, TOL_LADDER.length - 1) : 0;
  }

  // The profile's range, or the default octave when it isn't set.
  // (normalizePitchState enforces the range rules on load.)
  function rangeOf(profile) {
    const home = profile && profile.homeMidi;
    if (!isNum(home)) return { lowMidi: null, highMidi: null };
    const { lowMidi, highMidi } = profile;
    return isNum(lowMidi) && isNum(highMidi) ? { lowMidi, highMidi } : defaultRange(home);
  }

  function emptyDay() {
    return { tries: 0, hits: 0, blindTries: 0, blindHits: 0, lockSum: 0, lockN: 0, voicedSec: 0 };
  }

  function trimDays(days) {
    const keys = Object.keys(days).sort();
    if (keys.length <= DAYS_MAX) return days;
    const out = {};
    for (const k of keys.slice(-DAYS_MAX)) out[k] = days[k];
    return out;
  }

  // ---- setup ----------------------------------------------------------------

  // Median MIDI of a capture, ignoring the first `dropSec` of voice (the onset
  // scoop). Null when there isn't enough voice to trust.
  function captureMedian(frames, { dropSec = 0.2, minVoicedSec = 0.8 } = {}) {
    const voiced = (frames || []).filter((f) => f && isNum(f.freq) && f.freq > 0);
    if (!voiced.length) return null;
    const from = voiced[0].t + dropSec;
    const kept = voiced.filter((f) => f.t >= from);
    if (kept.length * FRAME_SEC < minVoicedSec) return null;
    return Pitch.median(kept.map((f) => Pitch.freqToMidi(f.freq)));
  }

  function homeFromCaptures(medians) {
    const valid = (medians || []).filter(isNum);
    if (!valid.length) return { homeMidi: null, spread: null, confident: false };
    const spread = Math.max(...valid) - Math.min(...valid);
    return {
      homeMidi: clamp(Math.round(Pitch.median(valid)), HOME_MIN, HOME_MAX),
      spread,
      confident: valid.length >= 2 && spread <= 3,
    };
  }

  function needMoreHums(humMedians, attempted) {
    const valid = (humMedians || []).filter(isNum);
    if (valid.length < 2) return true;
    return Math.max(...valid) - Math.min(...valid) > 3 && attempted < 4;
  }

  function defaultRange(home) {
    if (!isNum(home)) return { lowMidi: null, highMidi: null };
    return { lowMidi: Math.max(MIDI_MIN, home - 6), highMidi: Math.min(MIDI_MAX, home + 6) };
  }

  // "Too high?" / "Too low?": pull the range in just past the target, but
  // never closer than 2 semitones to home.
  function adjustRange(profile, targetMidi, dir) {
    const home = profile && profile.homeMidi;
    if (!isNum(home) || !isNum(targetMidi)) return profile;
    const target = Math.round(targetMidi);
    if (target === home) return profile;
    const r = rangeOf(profile);
    if (dir === "high") return { ...profile, ...r, highMidi: Math.max(home + 2, Math.min(r.highMidi, target - 1)) };
    if (dir === "low") return { ...profile, ...r, lowMidi: Math.min(home - 2, Math.max(r.lowMidi, target + 1)) };
    return profile;
  }

  // Session exercises run from baseMidi to about baseMidi + 12, so the best
  // reference range has its base about 4 below home. Ties go to the lower key.
  function suggestRange(home, ranges = Curriculum.RANGES) {
    const keys = Object.keys(ranges).sort((a, b) => ranges[a].baseMidi - ranges[b].baseMidi);
    let best = null;
    let bestD = Infinity;
    for (const k of keys) {
      const d = Math.abs(ranges[k].baseMidi - (home - 4));
      if (d < bestD) {
        best = k;
        bestD = d;
      }
    }
    return best;
  }

  function timbreFor(homeMidi, setting) {
    if (setting === "plain") return "plain";
    return !isNum(homeMidi) || homeMidi < 55 ? "voice-low" : "voice-high";
  }

  // New home note (setup or Re-measure). The range resets to the default
  // octave; a big move also restarts the adaptive steps, keeping passed flags.
  function setHome(ps, homeMidi, { captures = [], now } = {}) {
    const old = homeOf(ps);
    const profile = {
      homeMidi,
      ...defaultRange(homeMidi),
      captures: captures.slice(),
      measuredAt: toDate(now).toISOString(),
    };
    const out = { ...ps, profile };
    if (old != null && Math.abs(homeMidi - old) >= 3) {
      out.span = 3;
      out.tolLevel = 0;
      out.stages = {};
      for (const s of TRAIN_STAGES) out.stages[String(s.id)] = { ...stageState(ps, s.id), window: [] };
    }
    return out;
  }

  function resetRange(ps) {
    return { ...ps, profile: { ...ps.profile, ...defaultRange(homeOf(ps)) } };
  }

  // True when the user has narrowed the range below the default octave.
  function rangeClipped(ps) {
    const home = homeOf(ps);
    if (home == null) return false;
    const r = rangeOf(ps.profile);
    const d = defaultRange(home);
    return r.lowMidi !== d.lowMidi || r.highMidi !== d.highMidi;
  }

  // ---- stage status -----------------------------------------------------------

  function isUnlocked(ps, id) {
    if (homeOf(ps) == null) return false;
    for (let s = 1; s < id; s++) if (!stageState(ps, s).passed) return false;
    return true;
  }

  function stageLabel(ps, id, window) {
    const hits = sum(window);
    if (id === 1) return `${sum(window.slice(-6))} of 5 in your last 6`;
    if (id === 2) return `${hits} of 8 needed in your last 10`;
    if (id === 3) return `Notes up to ${spanOf(ps)} from home (goal 6) · ${hits}/10 this step`;
    const level = tolLevelOf(ps);
    const next = TOL_LADDER[level + 1];
    return `Target ±${TOL_LADDER[level]}¢${next != null ? ` (next ±${next}¢)` : ""} · ${hits}/10 landed`;
  }

  function stageStatus(ps, id) {
    id = Number(id);
    const st = stageState(ps, id);
    const window = Array.isArray(st.window) ? st.window.slice() : [];
    const hits = sum(window);
    // An easier option exists only at a stage's floor: Stage 2 always, Stage 3
    // at its narrowest span, Stage 4 at its loosest tolerance.
    const atFloor = id === 2 || (id === 3 && spanOf(ps) <= 3) || (id === 4 && tolLevelOf(ps) === 0);
    return {
      unlocked: isUnlocked(ps, id),
      passed: Boolean(st.passed),
      window,
      hits,
      label: stageLabel(ps, id, window),
      suggestEasier: atFloor && window.length >= 6 && hits / window.length < 0.3,
    };
  }

  function recommendedStage(ps) {
    if (homeOf(ps) == null) return "setup";
    for (const s of TRAIN_STAGES) if (isUnlocked(ps, s.id) && !stageState(ps, s.id).passed) return s.id;
    return 4;
  }

  // ---- targets --------------------------------------------------------------

  function targetPool(ps, stageId) {
    const home = homeOf(ps);
    if (home == null) return [];
    const id = Number(stageId);
    const r = rangeOf(ps.profile);
    const lo = Math.max(r.lowMidi, MIDI_MIN);
    const hi = Math.min(r.highMidi, MIDI_MAX);
    const ks = [];
    if (id === 2) {
      for (let k = -2; k <= 2; k++) ks.push(k);
    } else if (id === 3 || id === 4) {
      const reach = id === 3 ? spanOf(ps) : 6;
      for (let k = -reach; k <= reach; k++) if (k !== 0) ks.push(k);
    } else {
      return [home];
    }
    const pool = ks.map((k) => home + k).filter((m) => m >= lo && m <= hi);
    return pool.length ? pool : [home];
  }

  // Weak notes come up more often: 1 at 100% hits, 3 at 0%, 1.25 until tried.
  function noteWeight(ps, midi) {
    const n = ps.notes && ps.notes[String(midi)];
    if (!n || !(n.n >= 3)) return 1.25;
    return 1 + 2 * (1 - clamp(n.hits / n.n, 0, 1));
  }

  function pickTarget(ps, stageId, { prev = null, rng = Math.random } = {}) {
    let pool = targetPool(ps, stageId);
    if (pool.length >= 2) pool = pool.filter((m) => m !== prev);
    if (!pool.length) return null;
    const weights = pool.map((m) => noteWeight(ps, m));
    let r = rng() * sum(weights);
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r < 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  function mulberry32(seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // setIndex counts the counted trials so far in the set (0-9).
  function isBlind(ps, stageId, setIndex) {
    const id = Number(stageId);
    if (id === 3) return setIndex % 4 === 3;
    if (id === 4) return tolLevelOf(ps) === 0 ? setIndex % 4 === 3 : setIndex % 2 === 1;
    return false;
  }

  function nextTrialPlan(ps, stageId, opts = {}) {
    const { prevTarget = null, lastOutcome = null, lastGrade = null, missRun = 0, setIndex = 0 } = opts;
    const rng = opts.rng || Math.random;
    const id = Number(stageId);
    const r = rangeOf(ps.profile);
    if (missRun >= 2) {
      return { target: clamp(homeOf(ps), r.lowMidi, r.highMidi), rescue: true, retry: false, blind: false };
    }
    // Retry only a note that is still in range ("Too high?" may have cut it).
    const retryable = isNum(prevTarget) && prevTarget >= r.lowMidi && prevTarget <= r.highMidi;
    if (retryable && (lastOutcome === "miss" || (id === 4 && lastGrade === "found"))) {
      return { target: prevTarget, rescue: false, retry: true, blind: false };
    }
    return {
      target: pickTarget(ps, id, { prev: prevTarget, rng }),
      rescue: false,
      retry: false,
      blind: isBlind(ps, id, setIndex),
    };
  }

  function trialSpec(ps, stageId, { rescue = false } = {}) {
    const st = stageById(stageId);
    let tol = st.id === 4 ? TOL_LADDER[tolLevelOf(ps)] : st.tol;
    let onset = st.onset;
    if (rescue) {
      tol += 25;
      onset = false;
    }
    return { tol, holdSec: st.holdSec, windowSec: st.windowSec, refSec: st.refSec, onset };
  }

  // ---- trial engine -----------------------------------------------------------

  function createTrial({ kind = "match", spec, target = null, t0 }) {
    const capture = kind === "capture";
    const s = capture ? { ...CAPTURE, ...(spec || {}) } : spec;
    return {
      kind: capture ? "capture" : "match",
      spec: s,
      target: capture ? null : target,
      t0,
      gateUntil: t0,
      deadline: capture ? null : t0 + s.windowSec,
      lastT: null,
      firstVoiceT: null,
      runOnsetT: null,
      voicedSec: 0,
      unvoicedRun: 0,
      unclearRun: 0,
      outRun: 0,
      hold: 0,
      holdStartT: null,
      resets: 0,
      replays: 0,
      frames: [],
      lastErr: null,
      lastVoiced: false,
      lockT: null,
      lockBuf: [], // capture only: recent voiced {t, midi} before the lock
      status: "running",
      result: null,
    };
  }

  function resetHold(tr) {
    tr.hold = 0;
    tr.holdStartT = null;
    tr.resets += 1;
  }

  // Capture: lock onto the note once 0.6 s of the current run sits within a
  // 60-cent spread. The target is the unrounded median.
  function tryLock(tr, t, midi) {
    const spec = tr.spec;
    const from = t - spec.lockSec - EPS;
    tr.lockBuf = tr.lockBuf.filter((f) => f.t >= from).concat({ t, midi });
    if (tr.lockBuf.length < spec.lockMinFrames) return;
    if (t - tr.runOnsetT < spec.lockSec - EPS) return;
    const ms = tr.lockBuf.map((f) => f.midi);
    if (Math.max(...ms) - Math.min(...ms) > spec.lockSpreadCents / 100 + EPS) return;
    tr.target = Pitch.median(ms);
    tr.lockT = t;
    tr.lockBuf = [];
  }

  function stepTrial(trial, frame) {
    if (!trial || trial.status !== "running" || !frame || !isNum(frame.t)) return trial;
    const t = frame.t;
    if (t < trial.gateUntil) return trial;
    const tr = { ...trial };
    const spec = tr.spec;
    const dt = tr.lastT == null ? FRAME_SEC : clamp(t - tr.lastT, 0, GRACE.dtCap);
    tr.lastT = t;
    if (tr.deadline != null && t >= tr.deadline) return finish(tr, t);

    const voiced = isNum(frame.freq) && frame.freq > 0;
    const midi = voiced ? Pitch.freqToMidi(frame.freq) : null;
    tr.lastVoiced = voiced;
    if (voiced) {
      if (tr.runOnsetT == null || tr.unvoicedRun > GRACE.unvoicedSec + EPS) tr.runOnsetT = t;
      tr.unvoicedRun = 0;
      tr.unclearRun = 0;
      if (tr.firstVoiceT == null) {
        tr.firstVoiceT = t;
        if (tr.kind === "capture" && tr.deadline == null) tr.deadline = t + spec.windowSec;
      }
      tr.voicedSec += dt;
    } else {
      tr.unvoicedRun += dt;
      tr.unclearRun = isNum(frame.rms) && frame.rms >= SCORING.unclearRms ? tr.unclearRun + dt : 0;
    }

    if (tr.kind === "capture" && tr.target == null && voiced) tryLock(tr, t, midi);

    if (tr.target != null) {
      let entry;
      if (voiced) {
        const err = Pitch.pitchError(frame.freq, tr.target);
        const inBand = Math.abs(err.cents) <= spec.tol;
        const after = tr.kind === "capture" || t >= tr.runOnsetT + GRACE.ignoreOnsetSec - EPS;
        tr.lastErr = err;
        if (after && inBand) {
          if (tr.hold === 0) tr.holdStartT = t;
          tr.hold += dt;
          tr.outRun = 0;
        } else if (after) {
          tr.outRun += dt;
          if (tr.outRun > GRACE.outSec + EPS && tr.hold > 0) resetHold(tr);
        }
        entry = { t, midi, cents: err.cents, slip: err.octaveSlip, inBand, after };
      } else {
        if (tr.unvoicedRun > GRACE.unvoicedSec + EPS && tr.hold > 0) resetHold(tr);
        entry = { t, midi: null, cents: null, slip: false, inBand: false, after: false };
      }
      tr.frames = tr.frames.concat(entry);
    }

    if (tr.target != null && tr.hold >= spec.holdSec - EPS) return finish(tr, t, "hit");
    if (tr.kind === "capture" && tr.resets >= spec.maxResets) return finish(tr, t, "miss");
    if (tr.kind === "capture" && tr.firstVoiceT == null && t >= tr.t0 + spec.idleSec) return finish(tr, t, "silent");
    return tr;
  }

  // First frame of the first voiced run lasting at least 0.25 s; gaps of up
  // to 0.1 s don't break a run.
  function findOnset(frames) {
    let runStart = null;
    let prevT = null;
    for (const f of frames) {
      if (f.midi == null) continue;
      if (runStart == null || f.t - prevT - FRAME_SEC > SCORING.onsetGapSec + EPS) runStart = f.t;
      prevT = f.t;
      if (prevT - runStart + FRAME_SEC >= SCORING.onsetRunSec - EPS) return runStart;
    }
    return null;
  }

  // End a trial. `forced` is "hit", "miss" or "silent" when the engine knows
  // the outcome; otherwise (deadline) it is scored from the steady frames.
  function finish(trial, t, forced) {
    const tr = { ...trial, status: "done", lastT: t };
    const spec = tr.spec;
    const tol = spec.tol;
    const voiced = tr.frames.filter((f) => f.midi != null);
    const voicedAfter = voiced.filter((f) => f.after);

    // Steady-state scoring: onsets and offsets are left out on purpose.
    let steady;
    if (forced === "hit") {
      steady = voiced.filter((f) => f.t >= tr.holdStartT - EPS);
    } else {
      const from = t - SCORING.steadyFromSec - EPS;
      const to = t - SCORING.steadyToSec + EPS;
      steady = voicedAfter.filter((f) => f.t >= from && f.t <= to);
      if (steady.length < SCORING.minSteady) {
        steady = voicedAfter.filter((f) => f.t >= t - SCORING.steadyFallbackSec - EPS);
      }
    }
    const cents = steady.map((f) => f.cents);
    const steadyCents = steady.length ? Pitch.median(cents) : null;
    const sungMidi = steady.length ? Pitch.median(steady.map((f) => f.midi)) : null;
    const octaveSlip = steady.length > 0 && steady.filter((f) => f.slip).length * 2 > steady.length;
    const wobbleCents = cents.length >= SCORING.wobbleMin ? popSd(cents) : null;

    let outcome;
    if (forced) outcome = forced;
    else if (tr.voicedSec < SCORING.silentSec - EPS) outcome = "silent";
    // A capture either locks and holds or starts again, so it has no "close".
    else if (tr.kind === "match" && steadyCents != null && Math.abs(steadyCents) <= 2 * tol) outcome = "close";
    else outcome = "miss";
    const hit = outcome === "hit";

    let onsetCents = null;
    let grade = null;
    if (spec.onset) {
      const fs = tr.frames.filter((f) => f.t >= tr.gateUntil - EPS);
      const onsetT = findOnset(fs);
      if (onsetT != null) {
        const from = onsetT + SCORING.onsetFromSec - EPS;
        const to = onsetT + SCORING.onsetToSec + EPS;
        const early = fs.filter((f) => f.midi != null && f.t >= from && f.t <= to).map((f) => f.cents);
        if (early.length >= SCORING.onsetMin) onsetCents = Pitch.median(early);
      }
      if (hit) {
        const direct =
          onsetCents != null &&
          Math.abs(onsetCents) <= tol &&
          tr.holdStartT <= onsetT + SCORING.directHoldSec + EPS;
        grade = direct ? "direct" : "found";
      }
    }

    tr.result = {
      outcome,
      grade,
      lockSec: hit && tr.holdStartT != null && tr.firstVoiceT != null ? tr.holdStartT - tr.firstVoiceT : null,
      steadyCents,
      sungMidi,
      octaveSlip,
      wobbleCents,
      onsetCents,
      replays: tr.replays,
      target: tr.target,
      frames: tr.frames,
      kind: tr.kind,
      endT: t,
      voicedSec: tr.voicedSec,
      resets: tr.resets,
    };
    return tr;
  }

  // "Hear it again": the reference replays, so the hold starts over and the
  // window restarts after the replay ends. Frames and voiced time are kept.
  function replayTrial(trial, gateUntil) {
    if (!trial || trial.status !== "running") return trial;
    return {
      ...trial,
      gateUntil,
      deadline: gateUntil + trial.spec.windowSec,
      hold: 0,
      holdStartT: null,
      outRun: 0,
      firstVoiceT: null,
      runOnsetT: null,
      lastT: null,
      lastVoiced: false,
      replays: trial.replays + 1,
    };
  }

  function coachHint(trial, nowT) {
    if (!trial) return null;
    if (trial.firstVoiceT == null && nowT - trial.gateUntil >= SCORING.quietSec - EPS) {
      return { key: "quiet", dir: 0, semis: 0, text: "Hum or sing 'oo'. I'm listening." };
    }
    if (trial.unclearRun >= SCORING.unclearSec - EPS) {
      return {
        key: "unclear",
        dir: 0,
        semis: 0,
        text: "I hear sound but no clear note. Use a clean 'oo' or a hum; fry and grit don't show pitch.",
      };
    }
    if (trial.kind === "capture" && trial.target == null && trial.voicedSec >= SCORING.steadyHintSec - EPS) {
      return { key: "steady", dir: 0, semis: 0, text: "Pick one easy note and hold it still." };
    }
    if (!trial.lastVoiced || !trial.lastErr) return null;

    const err = trial.lastErr;
    const c = err.cents;
    const a = Math.abs(c);
    const dir = c < 0 ? 1 : c > 0 ? -1 : 0;
    const semis = Math.max(1, Math.round(a / 100));
    const up = dir > 0;
    if (a <= trial.spec.tol && err.octaveSlip) {
      const n = Math.abs(err.octaves);
      const octs = n === 1 ? "one octave" : `${n} octaves`;
      const text = `Right note, ${octs} ${err.octaves < 0 ? "lower" : "higher"}. That counts. Hold it…`;
      return { key: "octave", dir, semis, text };
    }
    if (a <= trial.spec.tol) return { key: "on", dir, semis, text: "Hold it there…" };
    if (a <= 100) return { key: "nudge", dir, semis, text: up ? "A little higher" : "A little lower" };
    if (a <= 250) {
      const text = `${up ? "Higher" : "Lower"}, about ${semis} note${semis === 1 ? "" : "s"}`;
      return { key: "close", dir, semis, text };
    }
    return { key: "far", dir, semis, text: `Go ${up ? "higher" : "lower"} (about ${semis} notes)` };
  }

  // ---- recording and adapting ---------------------------------------------------

  const COUNTED_OUTCOMES = ["hit", "close", "miss"];

  function recordTrial(ps, stageId, result, { now, counted = true, blind = false } = {}) {
    if (!result || !counted || result.kind === "capture" || !COUNTED_OUTCOMES.includes(result.outcome)) {
      return { ps, change: null };
    }
    const id = Number(stageId);
    const hit = result.outcome === "hit";
    const old = stageState(ps, id);
    const st = {
      passed: Boolean(old.passed),
      window: (Array.isArray(old.window) ? old.window : []).slice(),
      tries: (isNum(old.tries) ? old.tries : 0) + 1,
    };
    st.window.push(id === 4 ? (result.grade === "direct" ? 1 : 0) : hit ? 1 : 0);
    if (st.window.length > WINDOW_MAX) st.window = st.window.slice(-WINDOW_MAX);

    let span = spanOf(ps);
    let tolLevel = tolLevelOf(ps);
    let change = null;
    const n = st.window.length;
    const hits = sum(st.window);
    const stepUp = n >= WINDOW_MAX && hits >= 8;
    // Stepping down only happens above the floor, so at the floor the window
    // keeps filling and stageStatus can suggest the easier stage instead.
    const stepDown = n >= 6 && hits / n < 0.4;

    if (id === 1) {
      if (n >= 6 && sum(st.window.slice(-6)) >= 5) st.passed = true;
    } else if (id === 2) {
      if (stepUp || (st.tries === 6 && n >= 6 && sum(st.window.slice(-6)) === 6)) st.passed = true;
    } else if (id === 3) {
      if (stepUp) {
        if (span < 6) {
          change = { type: "span-up", from: span, to: span + 1 };
          span += 1;
        } else {
          if (!st.passed) change = { type: "stage-passed", from: 3, to: 4 };
          st.passed = true;
        }
        st.window = [];
      } else if (stepDown && span > 3) {
        change = { type: "span-down", from: span, to: span - 1 };
        span -= 1;
        st.window = [];
      }
    } else if (id === 4) {
      // from/to are tolLevel indices into TOL_LADDER.
      if (stepUp) {
        if (tolLevel < TOL_LADDER.length - 1) {
          change = { type: "tol-up", from: tolLevel, to: tolLevel + 1 };
          tolLevel += 1;
        } else {
          change = { type: "mastered", from: tolLevel, to: tolLevel };
          st.passed = true;
        }
        st.window = [];
      } else if (stepDown && tolLevel > 0) {
        change = { type: "tol-down", from: tolLevel, to: tolLevel - 1 };
        tolLevel -= 1;
        st.window = [];
      }
    }

    let notes = isObj(ps.notes) ? ps.notes : {};
    if (id >= 2 && isNum(result.target)) {
      const key = String(Math.round(result.target));
      const o = notes[key] || { n: 0, hits: 0, nC: 0, sumC: 0, sumC2: 0 };
      const nn = { n: o.n + 1, hits: o.hits + (hit ? 1 : 0), nC: o.nC, sumC: o.sumC, sumC2: o.sumC2 };
      const c = result.steadyCents;
      if (isNum(c) && Math.abs(c) <= 300) {
        nn.nC += 1;
        nn.sumC += c;
        nn.sumC2 += c * c;
      }
      // Halving keeps the stats weighted toward recent tries.
      if (nn.n > 40) for (const k of Object.keys(nn)) nn[k] *= 0.5;
      notes = { ...notes, [key]: nn };
    }

    const dk = dayKey(now);
    const days0 = isObj(ps.days) ? ps.days : {};
    const d = { ...emptyDay(), ...(days0[dk] || {}) };
    d.tries += 1;
    if (hit) d.hits += 1;
    if (blind) {
      d.blindTries += 1;
      if (hit) d.blindHits += 1;
    }
    if (hit && isNum(result.lockSec)) {
      d.lockSum += result.lockSec;
      d.lockN += 1;
    }
    const days = trimDays({ ...days0, [dk]: d });

    const entry = {
      s: id,
      t: isNum(result.target) ? round2(result.target) : null,
      sung: isNum(result.sungMidi) ? round2(result.sungMidi) : null,
      c: isNum(result.steadyCents) ? Math.round(result.steadyCents) : null,
      o: result.outcome,
      g: result.grade || null,
    };
    const recent = [...(Array.isArray(ps.recent) ? ps.recent : []), entry].slice(-RECENT_MAX);

    const stages = { ...(isObj(ps.stages) ? ps.stages : {}), [String(id)]: st };
    return { ps: { ...ps, stages, span, tolLevel, notes, days, recent }, change };
  }

  // ---- stats ------------------------------------------------------------------

  function dayKey(date) {
    const d = toDate(date);
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function dayOf(ps, key) {
    const d = ps && isObj(ps.days) ? ps.days[key] : null;
    return isObj(d) ? { ...emptyDay(), ...d } : emptyDay();
  }

  function addVoicedTime(ps, sec, now) {
    if (!isNum(sec) || sec <= 0) return ps;
    const dk = dayKey(now);
    const d = dayOf(ps, dk);
    d.voicedSec += sec;
    return { ...ps, days: trimDays({ ...(isObj(ps.days) ? ps.days : {}), [dk]: d }) };
  }

  function fatigueNotice(ps, now) {
    const sec = dayOf(ps, dayKey(now)).voicedSec;
    if (sec >= 1200) return "stop";
    if (sec >= 600) return "break";
    return null;
  }

  // Singing about the same note whatever the target: a common starting point.
  function detectMonotone(recent) {
    const list = (recent || []).filter((e) => e && e.s >= 2 && isNum(e.sung) && isNum(e.t)).slice(-5);
    if (list.length < 5) return { monotone: false, aroundMidi: null };
    const ts = list.map((e) => e.t);
    const ss = list.map((e) => e.sung);
    const monotone = Math.max(...ts) - Math.min(...ts) >= 3 && Math.max(...ss) - Math.min(...ss) <= 1.0;
    return { monotone, aroundMidi: monotone ? Math.round(Pitch.median(ss)) : null };
  }

  function biasSummary(values, { min = 6, threshold = 30 } = {}) {
    const vals = (values || []).filter((v) => isNum(v) && Math.abs(v) <= 300).slice(-10);
    const n = vals.length;
    if (n < min) return { mean: null, n, tendency: null };
    const mean = sum(vals) / n;
    const tendency = mean <= -threshold ? "flat" : mean >= threshold ? "sharp" : null;
    return { mean, n, tendency };
  }

  function noteChips(ps) {
    const home = homeOf(ps);
    if (home == null) return [];
    const r = rangeOf(ps.profile);
    const notes = isObj(ps.notes) ? ps.notes : {};
    const out = [];
    for (let m = r.lowMidi; m <= r.highMidi; m++) {
      const e = notes[String(m)] || { n: 0, hits: 0, nC: 0, sumC: 0, sumC2: 0 };
      const enoughC = e.nC >= 3;
      const bias = enoughC ? e.sumC / e.nC : null;
      out.push({
        midi: m,
        name: Pitch.noteName(m),
        n: e.n,
        rate: e.n >= 3 ? e.hits / e.n : null,
        bias,
        spread: enoughC ? Math.sqrt(Math.max(0, e.sumC2 / e.nC - bias * bias)) : null,
        isHome: m === home,
      });
    }
    return out;
  }

  // Consecutive practice days ending today, or yesterday if today has none yet.
  function dayStreak(ps, now) {
    const d = toDate(now);
    const practised = (k) => dayOf(ps, dayKey(addDays(d, -k))).tries >= 1;
    let k = practised(0) ? 0 : practised(1) ? 1 : -1;
    if (k < 0) return 0;
    let n = 0;
    while (n <= DAYS_MAX && practised(k)) {
      n++;
      k++;
    }
    return n;
  }

  function trend(ps, now, days = 14) {
    const d = toDate(now);
    const out = [];
    for (let k = days - 1; k >= 0; k--) {
      const key = dayKey(addDays(d, -k));
      const e = dayOf(ps, key);
      out.push({ key, tries: e.tries, rate: ratio(e.hits, e.tries), lockAvg: ratio(e.lockSum, e.lockN) });
    }
    return out;
  }

  function weekSummary(ps, now) {
    const d = toDate(now);
    const agg = (fromK, toK) => {
      const a = emptyDay();
      for (let k = fromK; k < toK; k++) {
        const e = dayOf(ps, dayKey(addDays(d, -k)));
        for (const f of Object.keys(a)) a[f] += isNum(e[f]) ? e[f] : 0;
      }
      return a;
    };
    const cur = agg(0, 7);
    const prev = agg(7, 14);
    return {
      rate: ratio(cur.hits, cur.tries),
      blindRate: ratio(cur.blindHits, cur.blindTries),
      lockAvg: ratio(cur.lockSum, cur.lockN),
      prevRate: ratio(prev.hits, prev.tries),
      prevLockAvg: ratio(prev.lockSum, prev.lockN),
      tries: cur.tries,
      blindTries: cur.blindTries,
    };
  }

  function steadiness(centsValues) {
    const vals = (centsValues || []).filter(isNum);
    return vals.length < 8 ? null : popSd(vals);
  }

  // ---- lane geometry ----------------------------------------------------------

  function viewForPool(pool, { pad = 2, minSpan = 12, maxSpan = 18, min = MIDI_MIN, max = MIDI_MAX } = {}) {
    const vals = (pool || []).filter(isNum);
    if (!vals.length) vals.push(Curriculum.RANGES.mid.baseMidi);
    let lo = Math.floor(Math.min(...vals) - pad);
    let hi = Math.ceil(Math.max(...vals) + pad);
    const span = hi - lo;
    if (span < minSpan) {
      lo -= Math.floor((minSpan - span) / 2);
      hi += Math.ceil((minSpan - span) / 2);
    } else if (span > maxSpan) {
      lo += Math.floor((span - maxSpan) / 2);
      hi -= Math.ceil((span - maxSpan) / 2);
    }
    if (lo < min) {
      hi += min - lo;
      lo = min;
    }
    if (hi > max) {
      lo -= hi - max;
      hi = max;
    }
    return { lo: Math.max(min, lo), hi };
  }

  // One lane per semitone, higher notes nearer the top. Notes past the view
  // are pinned to its edge and flagged in `clip` (1 above, -1 below).
  function laneY(midi, view, top, height) {
    const L = height / (view.hi - view.lo + 1);
    let m = midi;
    let clip = 0;
    if (m > view.hi + 0.5) {
      m = view.hi + 0.5;
      clip = 1;
    } else if (m < view.lo - 0.5) {
      m = view.lo - 0.5;
      clip = -1;
    }
    return { y: top + (view.hi + 0.5 - m) * L, clip };
  }

  // Split a trace into polylines at nulls, time gaps and big jumps, so
  // detector octave flips don't draw spikes.
  function traceSegments(points, { maxGapSec = 0.15, maxJump = 3 } = {}) {
    const segs = [];
    let cur = null;
    let prev = null;
    for (const p of points || []) {
      if (!p || !isNum(p.midi)) {
        cur = null;
        prev = null;
        continue;
      }
      if (!cur || p.t - prev.t > maxGapSec + EPS || Math.abs(p.midi - prev.midi) > maxJump) {
        cur = [];
        segs.push(cur);
      }
      cur.push(p);
      prev = p;
    }
    return segs;
  }

  // ---- persisted state ----------------------------------------------------------

  function defaultPitchState() {
    const stages = {};
    for (const s of TRAIN_STAGES) stages[String(s.id)] = { passed: false, window: [], tries: 0 };
    return {
      v: 1,
      profile: { homeMidi: null, lowMidi: null, highMidi: null, captures: [], measuredAt: null },
      stages,
      span: 3,
      tolLevel: 0,
      notes: {},
      days: {},
      recent: [],
      settings: { timbre: "voice", introSeen: false },
    };
  }

  function intIn(x, lo, hi, fallback) {
    return isNum(x) ? clamp(Math.round(x), lo, hi) : fallback;
  }

  function nonNeg(x) {
    return isNum(x) && x >= 0;
  }

  const NOTE_FIELDS = ["n", "hits", "nC", "sumC", "sumC2"];
  const DAY_FIELDS = Object.keys(emptyDay());
  const RECENT_OUTCOMES = ["hit", "close", "miss"];

  // localStorage state is only shallow-merged on load, so every field is
  // checked here and anything malformed falls back to its default.
  function normalizePitchState(raw) {
    const out = defaultPitchState();
    if (!isObj(raw)) return out;

    const p = isObj(raw.profile) ? raw.profile : {};
    const home = isNum(p.homeMidi) ? clamp(Math.round(p.homeMidi), HOME_MIN, HOME_MAX) : null;
    if (home != null) {
      const lo = p.lowMidi;
      const hi = p.highMidi;
      const ints = Number.isInteger(lo) && Number.isInteger(hi);
      const ok = ints && lo >= MIDI_MIN && hi <= MIDI_MAX && lo <= home - 2 && hi >= home + 2;
      out.profile = { ...out.profile, homeMidi: home, ...(ok ? { lowMidi: lo, highMidi: hi } : defaultRange(home)) };
    }
    if (Array.isArray(p.captures)) out.profile.captures = p.captures.slice(0, 8).map((c) => (isNum(c) ? c : null));
    if (typeof p.measuredAt === "string" && !Number.isNaN(Date.parse(p.measuredAt))) {
      out.profile.measuredAt = p.measuredAt;
    }

    const stages = isObj(raw.stages) ? raw.stages : {};
    for (const s of TRAIN_STAGES) {
      const st = stages[String(s.id)];
      if (!isObj(st)) continue;
      out.stages[String(s.id)] = {
        passed: st.passed === true,
        window: Array.isArray(st.window) ? st.window.filter((v) => v === 0 || v === 1).slice(-WINDOW_MAX) : [],
        tries: isNum(st.tries) && st.tries >= 0 ? Math.floor(st.tries) : 0,
      };
    }

    out.span = intIn(raw.span, 3, 6, 3);
    out.tolLevel = intIn(raw.tolLevel, 0, TOL_LADDER.length - 1, 0);

    if (isObj(raw.notes)) {
      for (const [k, e] of Object.entries(raw.notes)) {
        const m = Number(k);
        if (!/^\d+$/.test(k) || m < MIDI_MIN || m > MIDI_MAX || !isObj(e)) continue;
        // sumC is a signed sum (flat is negative); the other fields can't be.
        if (!NOTE_FIELDS.every((f) => (f === "sumC" ? isNum(e[f]) : nonNeg(e[f])))) continue;
        out.notes[String(m)] = { n: e.n, hits: Math.min(e.hits, e.n), nC: e.nC, sumC: e.sumC, sumC2: e.sumC2 };
      }
    }

    if (isObj(raw.days)) {
      const keys = Object.keys(raw.days)
        .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && isObj(raw.days[k]))
        .sort()
        .slice(-DAYS_MAX);
      for (const k of keys) {
        const e = raw.days[k];
        const d = emptyDay();
        for (const f of DAY_FIELDS) if (nonNeg(e[f])) d[f] = e[f];
        out.days[k] = d;
      }
    }

    if (Array.isArray(raw.recent)) {
      out.recent = raw.recent
        .filter(
          (e) =>
            isObj(e) &&
            Number.isInteger(e.s) &&
            e.s >= 1 &&
            e.s <= 4 &&
            isNum(e.t) &&
            (e.sung === null || isNum(e.sung)) &&
            (e.c === null || isNum(e.c)) &&
            RECENT_OUTCOMES.includes(e.o) &&
            (e.g == null || e.g === "direct" || e.g === "found"),
        )
        .map((e) => ({ s: e.s, t: e.t, sung: e.sung, c: e.c, o: e.o, g: e.g || null }))
        .slice(-RECENT_MAX);
    }

    const set = isObj(raw.settings) ? raw.settings : {};
    if (set.timbre === "voice" || set.timbre === "plain") out.settings.timbre = set.timbre;
    out.settings.introSeen = set.introSeen === true;
    return out;
  }

  const api = {
    FRAME_SEC,
    TOL_LADDER,
    GRACE,
    TIMING,
    CAPTURE,
    SET_SIZE,
    TRAIN_STAGES,
    SCORING,
    // setup
    captureMedian,
    homeFromCaptures,
    needMoreHums,
    defaultRange,
    adjustRange,
    suggestRange,
    timbreFor,
    setHome,
    resetRange,
    rangeClipped,
    // stages
    stageById,
    stageStatus,
    recommendedStage,
    // targets
    targetPool,
    pickTarget,
    mulberry32,
    isBlind,
    nextTrialPlan,
    trialSpec,
    // trials
    createTrial,
    stepTrial,
    finish,
    replayTrial,
    coachHint,
    // recording and stats
    recordTrial,
    addVoicedTime,
    fatigueNotice,
    detectMonotone,
    biasSummary,
    noteChips,
    dayStreak,
    trend,
    weekSummary,
    dayKey,
    steadiness,
    // lane
    viewForPool,
    laneY,
    traceSegments,
    // state
    defaultPitchState,
    normalizePitchState,
  };
  root.PitchTrainer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
