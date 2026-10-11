// Audio device choice: listing microphones/outputs and matching a saved choice
// to what's plugged in now. Pure functions, unit tested in Node
// (tests/devices.test.js).

(function (root) {
  // Chromium adds pseudo-devices for the system default and the Windows
  // "communications" device; the app offers its own "System default" instead.
  const PSEUDO = new Set(["default", "communications"]);

  // The real devices of one kind ("audioinput" / "audiooutput") from
  // enumerateDevices(). Browsers hide names (and sometimes ids) until mic
  // permission is granted, so unnamed devices get a numbered placeholder.
  function deviceOptions(devices, kind) {
    const word = kind === "audioinput" ? "Microphone" : "Output";
    return (devices || [])
      .filter((d) => d && d.kind === kind && d.deviceId && !PSEUDO.has(d.deviceId))
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${word} ${i + 1}`, named: Boolean(d.label) }));
  }

  // Name of the device the system currently uses by default, if the browser
  // says ("Default - Headset Microphone (USB)" -> "Headset Microphone (USB)").
  function defaultName(devices, kind) {
    const d = (devices || []).find((x) => x && x.kind === kind && x.deviceId === "default" && x.label);
    return d ? d.label.replace(/^Default\s*-\s*/i, "") : null;
  }

  // Which device to use for a saved choice ({id, label}): the same id if it's
  // still there, else a device with the same name (ids can change), else the
  // system default. Without device names (no permission yet) the list can't be
  // trusted, so the saved id is kept.
  function resolveChoice(options, saved) {
    if (!saved || !saved.id) return { id: "", missing: false };
    if (options.some((o) => o.id === saved.id)) return { id: saved.id, missing: false };
    if (!options.some((o) => o.named)) return { id: saved.id, missing: false };
    const byName = saved.label ? options.find((o) => o.named && o.label === saved.label) : null;
    if (byName) return { id: byName.id, missing: false };
    return { id: "", missing: true };
  }

  function normalizeChoice(raw) {
    const ok = raw && typeof raw === "object";
    return {
      id: ok && typeof raw.id === "string" ? raw.id : "",
      label: ok && typeof raw.label === "string" ? raw.label.slice(0, 200) : "",
    };
  }

  // state.audio = { input: {id, label}, output: {id, label} }; "" = system default.
  function normalizeAudioSettings(raw) {
    const ok = raw && typeof raw === "object";
    return { input: normalizeChoice(ok ? raw.input : null), output: normalizeChoice(ok ? raw.output : null) };
  }

  // Short text for a choice, e.g. on the Pitch home.
  function choiceLabel(choice) {
    return choice && choice.id ? choice.label || "Selected device" : "System default";
  }

  const api = { deviceOptions, defaultName, resolveChoice, normalizeAudioSettings, choiceLabel };
  root.Devices = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
