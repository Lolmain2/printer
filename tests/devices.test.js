// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../devices.js");

const LIST = [
  { kind: "audioinput", deviceId: "default", label: "Default - USB Mic (Focusrite)" },
  { kind: "audioinput", deviceId: "communications", label: "Communications - Laptop Mic" },
  { kind: "audioinput", deviceId: "mic-a", label: "Laptop Mic" },
  { kind: "audioinput", deviceId: "mic-b", label: "USB Mic (Focusrite)" },
  { kind: "audiooutput", deviceId: "default", label: "Default - Speakers" },
  { kind: "audiooutput", deviceId: "out-a", label: "Speakers" },
  { kind: "audiooutput", deviceId: "out-b", label: "Headphones" },
  { kind: "videoinput", deviceId: "cam", label: "Webcam" },
];

test("deviceOptions lists real devices of one kind without pseudo-devices", () => {
  assert.deepEqual(
    D.deviceOptions(LIST, "audioinput").map((o) => o.id),
    ["mic-a", "mic-b"],
  );
  assert.deepEqual(
    D.deviceOptions(LIST, "audiooutput").map((o) => o.label),
    ["Speakers", "Headphones"],
  );
  assert.deepEqual(D.deviceOptions(null, "audioinput"), []);
});

test("deviceOptions gives placeholders when names are hidden", () => {
  const hidden = [
    { kind: "audioinput", deviceId: "x1", label: "" },
    { kind: "audioinput", deviceId: "x2", label: "" },
    { kind: "audioinput", deviceId: "", label: "" }, // no id at all: unusable
  ];
  const opts = D.deviceOptions(hidden, "audioinput");
  assert.deepEqual(opts.map((o) => o.label), ["Microphone 1", "Microphone 2"]);
  assert.ok(opts.every((o) => !o.named));
});

test("defaultName strips the 'Default - ' prefix", () => {
  assert.equal(D.defaultName(LIST, "audioinput"), "USB Mic (Focusrite)");
  assert.equal(D.defaultName(LIST, "audiooutput"), "Speakers");
  assert.equal(D.defaultName([], "audioinput"), null);
});

test("resolveChoice keeps, re-maps by name, or falls back to default", () => {
  const opts = D.deviceOptions(LIST, "audioinput");
  assert.deepEqual(D.resolveChoice(opts, { id: "", label: "" }), { id: "", missing: false });
  assert.deepEqual(D.resolveChoice(opts, { id: "mic-b", label: "USB Mic (Focusrite)" }), { id: "mic-b", missing: false });
  // Same device, new id (e.g. after a driver update): found by name.
  assert.deepEqual(D.resolveChoice(opts, { id: "old-id", label: "Laptop Mic" }), { id: "mic-a", missing: false });
  // Unplugged.
  assert.deepEqual(D.resolveChoice(opts, { id: "gone", label: "Blue Yeti" }), { id: "", missing: true });
  // No names yet (permission not granted): don't throw the choice away.
  const hidden = D.deviceOptions([{ kind: "audioinput", deviceId: "h1", label: "" }], "audioinput");
  assert.deepEqual(D.resolveChoice(hidden, { id: "mic-b", label: "USB Mic" }), { id: "mic-b", missing: false });
});

test("normalizeAudioSettings repairs anything", () => {
  const empty = { input: { id: "", label: "" }, output: { id: "", label: "" } };
  assert.deepEqual(D.normalizeAudioSettings(undefined), empty);
  assert.deepEqual(D.normalizeAudioSettings("x"), empty);
  assert.deepEqual(D.normalizeAudioSettings({ input: { id: 5, label: null } }), empty);
  const ok = { input: { id: "mic-b", label: "USB" }, output: { id: "out-b", label: "Headphones" } };
  assert.deepEqual(D.normalizeAudioSettings(ok), ok);
});

test("choiceLabel", () => {
  assert.equal(D.choiceLabel({ id: "", label: "" }), "System default");
  assert.equal(D.choiceLabel({ id: "mic-b", label: "USB Mic" }), "USB Mic");
  assert.equal(D.choiceLabel({ id: "mic-b", label: "" }), "Selected device");
});

test("micErrorMessage explains each failure", () => {
  const e = (name) => ({ name });
  assert.match(D.micErrorMessage(e("NotAllowedError")), /blocked/);
  assert.match(D.micErrorMessage(e("NotReadableError"), "USB Mic"), /^USB Mic is busy or blocked/);
  assert.match(D.micErrorMessage(e("NotReadableError"), "System default"), /^The microphone is busy/);
  assert.match(D.micErrorMessage(e("NotFoundError")), /No microphone is connected/);
  assert.equal(D.micErrorMessage(e("Weird")), "Couldn't open the microphone.");
  assert.equal(D.micErrorMessage(null), "Couldn't open the microphone.");
});
