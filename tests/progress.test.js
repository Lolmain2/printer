// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../curriculum.js");
const P = require("../progress.js");

function withSessions(list) {
  return list.reduce((s, x) => P.recordSession(s, x), P.defaultState());
}

const healthy = (stage, n, feeling = "fresh") => Array.from({ length: n }, () => ({ stage, feeling }));

test("starts with only stage 1 unlocked", () => {
  assert.equal(P.highestUnlocked(P.defaultState()), 1);
});

test("stages unlock in order after enough healthy sessions", () => {
  assert.equal(P.highestUnlocked(withSessions(healthy(1, 2))), 1);
  assert.equal(P.highestUnlocked(withSessions(healthy(1, 3))), 2);
  assert.equal(P.highestUnlocked(withSessions([...healthy(1, 3), ...healthy(2, 3, "tired")])), 3);
});

test("unhealthy and warm-up-only sessions don't count toward unlocking", () => {
  const s = withSessions([
    { stage: 1, feeling: "fresh" },
    { stage: 1, feeling: "scratchy" },
    { stage: 1, feeling: "pain" },
    { stage: 1, feeling: "fresh", warmupOnly: true },
  ]);
  assert.equal(P.stageProgress(s, 1).done, 1);
  assert.equal(P.highestUnlocked(s), 1);
});

test("sessions at a later stage can't skip an earlier one", () => {
  assert.equal(P.highestUnlocked(withSessions(healthy(3, 10))), 1);
});

test("the last stage is reachable and has no unlock target", () => {
  const all = C.STAGES.filter((st) => st.sessionsToUnlock).flatMap((st) => healthy(st.id, st.sessionsToUnlock));
  const last = C.STAGES[C.STAGES.length - 1];
  assert.equal(P.highestUnlocked(withSessions(all)), last.id);
  assert.equal(P.stageProgress(P.defaultState(), last.id).needed, null);
});

test("a bad check-in blocks distortion until a healthy one", () => {
  let s = withSessions([...healthy(1, 3), ...healthy(2, 3), { stage: 3, feeling: "scratchy" }]);
  assert.equal(P.distortionBlocked(s), true);

  const plan = P.buildSession(s, 3);
  assert.equal(plan.warmupOnly, true);
  assert.ok(plan.items.every((it) => it.section === "Warm-up" || it.section === "Cool-down"));

  // Non-distortion stages are still fully available.
  assert.equal(P.buildSession(s, 2).warmupOnly, false);

  s = P.recordSession(s, { stage: 3, warmupOnly: true, feeling: "fresh" });
  assert.equal(P.distortionBlocked(s), false);
  assert.equal(P.buildSession(s, 3).warmupOnly, false);
});

test("session plan is warm-up, then stage, then cool-down", () => {
  const plan = P.buildSession(P.defaultState(), 1);
  const sections = plan.items.map((it) => it.section);
  assert.equal(sections[0], "Warm-up");
  assert.equal(sections[sections.length - 1], "Cool-down");
  assert.equal(plan.items.length, C.WARMUP.length + C.STAGES[0].exercises.length + C.COOLDOWN.length);
});

test("safety advice escalates from caution to rest to doctor", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  assert.deepEqual(P.safetyAdvice(withSessions(healthy(1, 1)), now), []);

  const scratchy = withSessions([{ stage: 1, feeling: "scratchy", date: new Date("2026-10-19T12:00:00Z") }]);
  assert.deepEqual(P.safetyAdvice(scratchy, now).map((a) => a.level), ["caution"]);

  const pain = withSessions([{ stage: 1, feeling: "pain", date: new Date("2026-10-19T12:00:00Z") }]);
  assert.deepEqual(P.safetyAdvice(pain, now).map((a) => a.level), ["rest"]);

  const longTerm = withSessions([
    { stage: 1, feeling: "fresh", date: new Date("2026-09-01T12:00:00Z") },
    { stage: 1, feeling: "scratchy", date: new Date("2026-10-04T12:00:00Z") },
    { stage: 1, feeling: "scratchy", date: new Date("2026-10-19T12:00:00Z") },
  ]);
  assert.equal(P.unhealthyStreakDays(longTerm, now), 16);
  assert.deepEqual(P.safetyAdvice(longTerm, now).map((a) => a.level), ["doctor", "caution"]);
});

test("rejects unknown feelings and stages", () => {
  assert.throws(() => P.recordSession(P.defaultState(), { stage: 1, feeling: "great" }));
  assert.throws(() => P.buildSession(P.defaultState(), 99));
});

test("curriculum is well-formed", () => {
  const ids = new Set();
  for (const ex of [...C.WARMUP, ...C.COOLDOWN, ...C.STAGES.flatMap((s) => s.exercises)]) {
    assert.ok(!ids.has(ex.id), `duplicate id ${ex.id}`);
    ids.add(ex.id);
    assert.ok(ex.seconds > 0 && ex.steps.length && ex.cue, ex.id);
    if (ex.tone) assert.ok(["scale", "glide", "drone"].includes(ex.tone.type), ex.id);
  }
  C.STAGES.forEach((s, i) => assert.equal(s.id, i + 1));
  // Distortion never comes before the retraction stage.
  const firstDistortion = C.STAGES.find((s) => s.distortion).id;
  const retraction = C.STAGES.find((s) => /retraction/i.test(s.name)).id;
  assert.ok(retraction < firstDistortion);
});

test("midiToFreq matches concert pitch", () => {
  assert.equal(P.midiToFreq(69), 440);
  assert.ok(Math.abs(P.midiToFreq(57) - 220) < 1e-9);
});

test("recordSession stores pitch accuracy when given", () => {
  const s = withSessions([{ stage: 1, feeling: "fresh", pitchAccuracy: 82 }, { stage: 1, feeling: "fresh" }]);
  assert.equal(s.sessions[0].pitchAccuracy, 82);
  assert.equal(s.sessions[1].pitchAccuracy, null);
});
