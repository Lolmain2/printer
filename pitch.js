// Pitch detection and note maths. Pure functions, unit tested in Node
// (see tests/pitch.test.js).
//
// detectPitch uses the McLeod Pitch Method (normalised square difference
// function), which copes well with the strong harmonics of a singing voice and
// rarely jumps an octave.

(function (root) {
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  function rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  // Returns {freq, clarity} or null when there is no clear pitch (silence,
  // breath, fry or heavy distortion).
  function detectPitch(buf, sampleRate, opts = {}) {
    const minFreq = opts.minFreq || 60;
    const maxFreq = opts.maxFreq || 1100;
    const minRms = opts.minRms == null ? 0.01 : opts.minRms;
    const minClarity = opts.minClarity == null ? 0.8 : opts.minClarity;

    if (rms(buf) < minRms) return null;

    const n = buf.length;
    const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
    const maxTau = Math.min(Math.floor(sampleRate / minFreq), Math.floor(n / 2));
    const nsdf = new Float32Array(maxTau + 2);

    for (let tau = 0; tau <= maxTau + 1; tau++) {
      let acf = 0;
      let m = 0;
      for (let i = 0; i < n - tau; i++) {
        const a = buf[i];
        const b = buf[i + tau];
        acf += a * b;
        m += a * a + b * b;
      }
      nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
    }

    // Peak picking: the highest point of each positive lobe after the first
    // negative-going zero crossing.
    const peaks = [];
    let tau = 1;
    while (tau <= maxTau && nsdf[tau] > 0) tau++; // skip the lobe around tau = 0
    let best = -1;
    let bestTau = -1;
    for (; tau <= maxTau; tau++) {
      if (nsdf[tau] > 0) {
        if (nsdf[tau] > best) {
          best = nsdf[tau];
          bestTau = tau;
        }
      } else if (bestTau !== -1) {
        peaks.push(bestTau);
        best = -1;
        bestTau = -1;
      }
    }
    if (bestTau !== -1) peaks.push(bestTau);
    const candidates = peaks.filter((t) => t >= minTau);
    if (!candidates.length) return null;

    const highest = Math.max(...candidates.map((t) => nsdf[t]));
    const chosen = candidates.find((t) => nsdf[t] >= 0.9 * highest);

    // Parabolic interpolation around the chosen peak for sub-sample accuracy.
    const y0 = nsdf[chosen - 1];
    const y1 = nsdf[chosen];
    const y2 = nsdf[chosen + 1];
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    const clarity = y1 - 0.25 * (y0 - y2) * shift;
    const period = chosen + shift;

    if (clarity < minClarity) return null;
    const freq = sampleRate / period;
    if (freq < minFreq || freq > maxFreq) return null;
    return { freq, clarity };
  }

  function freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / 440);
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function noteName(midi) {
    const m = Math.round(midi);
    return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }

  // How far `freq` is from `target`, in cents. Singing the right note in a
  // different octave still counts as the right note, so the comparison is
  // folded into +/-600 cents and the octave difference is reported separately.
  function compareToTarget(freq, target) {
    const raw = 1200 * Math.log2(freq / target);
    const octaves = Math.round(raw / 1200);
    return { cents: raw - octaves * 1200, octaves };
  }

  // Classify a cents offset for display and scoring.
  function judge(cents, tolerance = 50) {
    const abs = Math.abs(cents);
    if (abs <= tolerance) return "on";
    if (abs <= tolerance * 2) return cents < 0 ? "slightly-flat" : "slightly-sharp";
    return cents < 0 ? "flat" : "sharp";
  }

  // The note the user should be singing at time `t`, from the reference-tone
  // schedule. Each segment is {start, end, from, to?}: a held note, or (with
  // `to`) a siren that glides from -> to over the first half and back down.
  function targetAt(segments, t) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if (t < s.start || t >= s.end) continue;
      if (!s.to) return s.from;
      const half = (s.end - s.start) / 2;
      const x = t - s.start < half ? (t - s.start) / half : (s.end - t) / half;
      return s.from * Math.pow(s.to / s.from, x);
    }
    return null;
  }

  // Compare against the target now and slightly earlier: singers follow the
  // reference with a short delay, and shouldn't be marked wrong for it.
  function bestMatch(segments, t, freq, lags = [0, 0.15, 0.3]) {
    let best = null;
    for (const lag of lags) {
      const target = targetAt(segments, t - lag);
      if (!target) continue;
      const cmp = compareToTarget(freq, target);
      if (!best || Math.abs(cmp.cents) < Math.abs(best.cents)) best = { target, ...cmp };
    }
    return best;
  }

  const api = { detectPitch, freqToMidi, midiToFreq, noteName, compareToTarget, judge, rms, targetAt, bestMatch };
  root.Pitch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
