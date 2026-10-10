// Progress and safety-gating logic. Pure functions over a plain state object, so
// they can be unit tested in Node (see tests/progress.test.js).
//
// state = {
//   range: "low" | "mid" | "high",
//   mic: bool,  // pitch check on
//   sessions: [{ date: ISO string, stage: number, warmupOnly: bool, feeling: FEELING,
//                pitchAccuracy: 0-100 | null }]
// }

(function (root) {
  const Curriculum = root.Curriculum || (typeof require !== "undefined" ? require("./curriculum.js") : null);

  const FEELINGS = {
    fresh: { label: "Fresh / same as before", healthy: true },
    tired: { label: "A little tired", healthy: true },
    scratchy: { label: "Scratchy, tickly or hoarse", healthy: false },
    pain: { label: "Pain or soreness", healthy: false },
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  function defaultState() {
    return { range: "mid", mic: false, sessions: [] };
  }

  function isHealthy(session) {
    return Boolean(FEELINGS[session.feeling] && FEELINGS[session.feeling].healthy);
  }

  // Healthy technique sessions completed at each stage.
  function healthyCounts(state) {
    const counts = {};
    for (const s of state.sessions) {
      if (s.warmupOnly || !isHealthy(s)) continue;
      counts[s.stage] = (counts[s.stage] || 0) + 1;
    }
    return counts;
  }

  // Highest stage the user may practise. Stages unlock in order.
  function highestUnlocked(state, stages = Curriculum.STAGES) {
    const counts = healthyCounts(state);
    let unlocked = stages[0].id;
    for (const stage of stages) {
      if (stage.sessionsToUnlock == null) break;
      if ((counts[stage.id] || 0) >= stage.sessionsToUnlock) {
        const next = stages.find((s) => s.id === stage.id + 1);
        if (!next) break;
        unlocked = next.id;
      } else {
        break;
      }
    }
    return unlocked;
  }

  function stageProgress(state, stageId, stages = Curriculum.STAGES) {
    const stage = stages.find((s) => s.id === stageId);
    const done = healthyCounts(state)[stageId] || 0;
    return { done, needed: stage ? stage.sessionsToUnlock : null };
  }

  function lastSession(state) {
    return state.sessions.length ? state.sessions[state.sessions.length - 1] : null;
  }

  // Distortion stays locked until the next healthy check-in after a bad one.
  function distortionBlocked(state) {
    const last = lastSession(state);
    return Boolean(last && !isHealthy(last));
  }

  // How long the voice has been reported unhealthy without a healthy check-in.
  function unhealthyStreakDays(state, now = new Date()) {
    let firstBad = null;
    for (let i = state.sessions.length - 1; i >= 0; i--) {
      const s = state.sessions[i];
      if (isHealthy(s)) break;
      firstBad = s;
    }
    if (!firstBad) return 0;
    return Math.floor((now - new Date(firstBad.date)) / DAY_MS);
  }

  // Safety messages to show on the home screen, most serious first.
  function safetyAdvice(state, now = new Date()) {
    const advice = [];
    const last = lastSession(state);
    if (!last || isHealthy(last)) return advice;

    const streak = unhealthyStreakDays(state, now);
    if (streak >= 14) {
      advice.push({
        level: "doctor",
        text:
          "You've reported hoarseness or pain for about two weeks. Stop distortion practice and see an ENT / laryngologist " +
          "or a voice-specialised speech therapist. Persistent hoarseness needs a proper look at the vocal folds.",
      });
    }
    if (last.feeling === "pain") {
      advice.push({
        level: "rest",
        text:
          "Last session hurt. Rest your voice for at least 48 hours: no screaming, no shouting, and as little talking as you can. " +
          "Pain means the true vocal folds were taking the load, so go back a stage when you return.",
      });
    } else {
      advice.push({
        level: "caution",
        text:
          "Your voice felt scratchy last time. Distortion is paused until a session ends with a healthy check-in. " +
          "Do a gentle warm-up-only session, drink water, and keep the volume down.",
      });
    }
    return advice;
  }

  // Build the ordered list of exercises for a session at the chosen stage.
  function buildSession(state, stageId, curriculum = Curriculum) {
    const stage = curriculum.STAGES.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Unknown stage ${stageId}`);
    const blocked = stage.distortion && distortionBlocked(state);
    const items = [];
    for (const ex of curriculum.WARMUP) items.push({ section: "Warm-up", exercise: ex });
    if (!blocked) {
      for (const ex of stage.exercises) items.push({ section: `Stage ${stage.id}: ${stage.name}`, exercise: ex });
    }
    for (const ex of curriculum.COOLDOWN) items.push({ section: "Cool-down", exercise: ex });
    return { stage, items, warmupOnly: blocked };
  }

  function recordSession(state, { stage, warmupOnly, feeling, pitchAccuracy = null, date = new Date() }) {
    if (!FEELINGS[feeling]) throw new Error(`Unknown feeling ${feeling}`);
    const session = { date: date.toISOString(), stage, warmupOnly: Boolean(warmupOnly), feeling, pitchAccuracy };
    return { ...state, sessions: [...state.sessions, session] };
  }

  function totalSeconds(items) {
    return items.reduce((sum, it) => sum + it.exercise.seconds, 0);
  }

  // Equal-tempered frequency for a MIDI note number.
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  const api = {
    FEELINGS,
    defaultState,
    healthyCounts,
    highestUnlocked,
    stageProgress,
    distortionBlocked,
    unhealthyStreakDays,
    safetyAdvice,
    buildSession,
    recordSession,
    totalSeconds,
    midiToFreq,
  };
  root.Progress = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
