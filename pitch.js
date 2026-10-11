// Pitch detection and note maths. Pure functions (plus one stateful tracker),
// unit tested in Node (see tests/pitch.test.js).
//
// Live input goes through createTracker(): YIN (cumulative mean normalised
// difference) with pYIN-style candidate periods on a FRAME_SIZE window, and a
// causal Viterbi that picks among them with continuity and voicing
// hysteresis, so low, quiet and breathy notes hold steady and fry, breath and
// mains hum read as no pitch. detectPitch() is the same analysis as a one-off
// decision on a single block.

(function (root) {
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  function rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  // ---- Pitch analysis: YIN with pYIN-style candidates ---------------------
  //
  // For a frame x[0..n) and a lag tau, the squared difference between the
  // frame and itself shifted by tau is
  //   d(tau) = sum_{j < n-tau} (x[j] - x[j+tau])^2 = E(tau) - 2 r(tau),
  // with E(tau) the energy of the two overlapping parts and r(tau) the
  // autocorrelation (computed with an FFT, so long frames stay cheap).
  // a(tau) = d / E is the share of the energy that does NOT repeat after tau
  // samples: about 1 / (1 + harmonics-to-noise ratio) at the true period, ~1
  // for noise. c(tau) is YIN's cumulative-mean-normalised version of it, which
  // discounts the short lags where any smooth (low-passed) sound looks
  // self-similar.

  // Analysis window the tracker wants (an AnalyserNode fftSize) at 44.1 or
  // 48 kHz. 4096 samples (85 ms at 48 kHz) holds three or more periods of a
  // low G1 (49 Hz), which a 2048 window can't, and is still short enough for
  // vibrato and glides. frameSizeFor() gives the same span at other rates
  // (8192 at 96 kHz; the tracker decimates such input back to ~48 kHz).
  const FRAME_SIZE = 4096;
  function frameSizeFor(sampleRate) {
    let n = 2048;
    while (n < 0.085 * sampleRate && n < 32768) n <<= 1;
    return n;
  }

  const fftPlans = new Map();
  function fftPlan(h) {
    let p = fftPlans.get(h);
    if (p) return p;
    const bits = Math.round(Math.log2(h));
    const rev = new Uint32Array(h);
    for (let i = 0; i < h; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(h >> 1);
    const sin = new Float64Array(h >> 1);
    for (let i = 0; i < h >> 1; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / h);
      sin[i] = Math.sin((2 * Math.PI * i) / h);
    }
    // Twiddles of the size-2h real transform built on this complex one.
    const wc = new Float64Array(h + 1);
    const ws = new Float64Array(h + 1);
    for (let k = 0; k <= h; k++) {
      wc[k] = Math.cos((Math.PI * k) / h);
      ws[k] = Math.sin((Math.PI * k) / h);
    }
    p = { h, rev, cos, sin, wc, ws, re: new Float64Array(h), im: new Float64Array(h), pw: new Float64Array(h + 1) };
    fftPlans.set(h, p);
    return p;
  }

  // In-place radix-2 complex FFT (unnormalised; inverse = conjugate twiddles).
  function fft(p, re, im, inverse) {
    const { h, rev, cos, sin } = p;
    for (let i = 0; i < h; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= h; size <<= 1) {
      const half = size >> 1;
      const step = h / size;
      for (let i = 0; i < h; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k];
          const wi = sgn * sin[k];
          const a = i + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  // Linear autocorrelation out[0..maxLag] of x[0..n): power spectrum of the
  // zero-padded frame and back, using a half-size complex FFT each way.
  function autocorrelation(x, n, maxLag, out) {
    let m = 4;
    while (m < n + maxLag + 1) m <<= 1;
    const h = m >> 1;
    const p = fftPlan(h);
    const { re, im, pw, wc, ws } = p;
    for (let j = 0; j < h; j++) {
      const i0 = 2 * j;
      re[j] = i0 < n ? x[i0] : 0;
      im[j] = i0 + 1 < n ? x[i0 + 1] : 0;
    }
    fft(p, re, im, false);
    for (let k = 0; k <= h; k++) {
      const k1 = k === h ? 0 : k;
      const k2 = k === 0 ? 0 : h - k;
      const zr = re[k1];
      const zi = im[k1];
      const cr = re[k2];
      const ci = -im[k2];
      const er = (zr + cr) / 2;
      const ei = (zi + ci) / 2;
      const or = (zi - ci) / 2;
      const oi = -(zr - cr) / 2;
      const xr = er + or * wc[k] + oi * ws[k];
      const xi = ei + oi * wc[k] - or * ws[k];
      pw[k] = xr * xr + xi * xi;
    }
    for (let k = 0; k < h; k++) {
      const e = (pw[k] + pw[h - k]) / 2;
      const o = (pw[k] - pw[h - k]) / 2;
      re[k] = e - o * ws[k];
      im[k] = o * wc[k];
    }
    fft(p, re, im, true);
    for (let t = 0; t <= maxLag; t++) out[t] = (t & 1 ? im[t >> 1] : re[t >> 1]) / h;
    return out;
  }

  const workspaces = new Map();
  function workspace(n, slot = 0) {
    const key = n * 4 + slot;
    let w = workspaces.get(key);
    if (!w) {
      w = { x: new Float64Array(n), y: new Float64Array(n), cs: new Float64Array(n + 1), r: new Float64Array(n + 2), a: new Float64Array(n + 2), c: new Float64Array(n + 2), ha: new Float64Array(n + 2) };
      workspaces.set(key, w);
    }
    return w;
  }

  // Normalised difference a(tau) of x[from..n) into `a`, and (optionally) its
  // cumulative-mean-normalised form into `c`, for tau = 0..maxTau+1.
  function differenceFunction(x, from, n, maxTau, w, a, c) {
    const len = n - from;
    const cs = w.cs;
    cs[0] = 0;
    for (let i = 0; i < len; i++) cs[i + 1] = cs[i] + x[from + i] * x[from + i];
    const r = autocorrelation(from ? x.subarray(from) : x, len, maxTau + 1, w.r);
    const total = cs[len];
    a[0] = 0;
    if (c) c[0] = 1;
    let sum = 0;
    for (let t = 1; t <= maxTau + 1; t++) {
      const e = cs[len - t] + total - cs[t];
      const v = e > 0 ? Math.max(0, (e - 2 * r[t]) / e) : 1;
      a[t] = v;
      if (c) {
        sum += v;
        c[t] = sum > 0 ? (v * t) / sum : 1;
      }
    }
    return total;
  }

  // Least-squares fit of mains hum (exactly humHz and its harmonics up to
  // 300 Hz) to x[0..n), subtracted in place; returns the hum's energy. Mains
  // frequency is held to a small fraction of a hertz, so the nominal value is
  // exact enough over one frame. The basis and its inverse Gram matrix are
  // cached per (n, rate, hum).
  const humBases = new Map();
  function humBasis(n, sampleRate, humHz) {
    const key = n + "/" + sampleRate + "/" + humHz;
    let hb = humBases.get(key);
    if (hb) return hb;
    const harmonics = Math.floor(300 / humHz);
    const k = 2 * harmonics;
    const B = [];
    for (let h = 1; h <= harmonics; h++) {
      const cs = new Float64Array(n);
      const sn = new Float64Array(n);
      const w = (2 * Math.PI * h * humHz) / sampleRate;
      for (let i = 0; i < n; i++) {
        cs[i] = Math.cos(w * (i - n / 2));
        sn[i] = Math.sin(w * (i - n / 2));
      }
      B.push(cs, sn);
    }
    // Invert the Gram matrix (Gauss-Jordan; it's small and well conditioned).
    const g = [];
    for (let r = 0; r < k; r++) {
      g.push(new Float64Array(2 * k));
      for (let c = 0; c < k; c++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += B[r][i] * B[c][i];
        g[r][c] = s;
      }
      g[r][k + r] = 1;
    }
    for (let c = 0; c < k; c++) {
      let p = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(g[r][c]) > Math.abs(g[p][c])) p = r;
      [g[c], g[p]] = [g[p], g[c]];
      const d = g[c][c];
      for (let j = 0; j < 2 * k; j++) g[c][j] /= d;
      for (let r = 0; r < k; r++) {
        if (r === c || g[r][c] === 0) continue;
        const f = g[r][c];
        for (let j = 0; j < 2 * k; j++) g[r][j] -= f * g[c][j];
      }
    }
    hb = { B, inv: g.map((row) => row.slice(k)), proj: new Float64Array(k), coef: new Float64Array(k) };
    humBases.set(key, hb);
    return hb;
  }

  function removeHum(x, n, sampleRate, humHz) {
    const { B, inv, proj, coef } = humBasis(n, sampleRate, humHz);
    const k = B.length;
    for (let r = 0; r < k; r++) {
      let s = 0;
      const b = B[r];
      for (let i = 0; i < n; i++) s += b[i] * x[i];
      proj[r] = s;
    }
    let energy = 0;
    for (let r = 0; r < k; r++) {
      let s = 0;
      for (let c = 0; c < k; c++) s += inv[r][c] * proj[c];
      coef[r] = s;
      energy += s * proj[r];
    }
    for (let r = 0; r < k; r++) {
      const b = B[r];
      const s = coef[r];
      for (let i = 0; i < n; i++) x[i] -= s * b[i];
    }
    return energy;
  }

  // CDF of the pYIN-style distribution of YIN thresholds: Beta(2, 6), mean 0.25.
  function thresholdCdf(s) {
    if (s <= 0) return 0;
    if (s >= 1) return 1;
    const u = 1 - s;
    const u6 = u * u * u * u * u * u;
    return 1 - u6 * u - 7 * s * u6;
  }

  // One frame: DC removed, a(tau) and c(tau) over the lag range, and the
  // candidate periods. For each YIN threshold s the candidate is the first
  // dip of c below s (YIN's "absolute threshold" step), so a dip's weight is
  // the probability of the thresholds that pick it: the earliest good dip wins
  // most of the mass, which is what keeps YIN off the sub-octaves (2T, 3T are
  // periods too).
  function analyseFrame(buf, sampleRate, minFreq, maxFreq, humHz = 0, slot = 0, maxDip = 0.6) {
    const n = buf.length;
    const w = workspace(n, slot);
    const x = w.x;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += buf[i];
    mean /= n;
    for (let i = 0; i < n; i++) x[i] = buf[i] - mean;
    const humEnergy = humHz ? removeHum(x, n, sampleRate, humHz) : 0;
    const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
    const maxTau = Math.min(Math.ceil(sampleRate / minFreq), n >> 1);
    const frame = { n, sampleRate, x, a: w.a, c: w.c, minTau, maxTau, rms: 0, humEnergy, cands: [], w, hb: null };
    if (maxTau <= minTau + 2) {
      frame.rms = rms(x); // too short to hold a period
      return frame;
    }
    const energy = differenceFunction(x, 0, n, maxTau, w, w.a, w.c);
    frame.rms = Math.sqrt(energy / n);
    if (energy <= 0) return frame;
    const { a, c } = frame;

    let level = maxDip;
    const cands = frame.cands;
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (c[tau] >= level) continue;
      let t = tau;
      while (t < maxTau && c[t + 1] < c[t]) t++;
      const v = c[t];
      const weight = thresholdCdf(level) - thresholdCdf(v);
      level = v;
      tau = t;
      if (t === minTau && c[t - 1] < v) continue; // the slope of a dip below the range
      if (t === maxTau && c[t + 1] < v) continue; // ... or above it
      const prev = cands[cands.length - 1];
      if (prev && t - prev.tau <= Math.max(2, 0.01 * prev.tau)) {
        prev.tau = t; // same dip, split by a wiggle
        prev.v = v;
        prev.weight += weight;
      } else cands.push({ tau: t, v, weight });
    }
    // A dip followed by a deeper one that isn't at a multiple of its lag can't
    // be the period (a true period repeats at 2T, 3T, ...): it is a partial
    // match, e.g. T(1 - 1/h) when harmonic h sits on a strong formant. Its
    // thresholds belong to the deeper dip.
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        if (cands[j].v >= cands[i].v) continue;
        const ratio = cands[j].tau / cands[i].tau;
        const m = Math.round(ratio);
        if (m >= 2 && Math.abs(ratio / m - 1) < 0.03) continue;
        cands[j].weight += cands[i].weight;
        cands.splice(i--, 1);
        break;
      }
    }
    let total = 0;
    for (const k of cands) total += k.weight;
    for (const k of cands) {
      k.q = total > 0 ? k.weight / total : 1 / cands.length;
      // Sub-sample period: parabola through a() around its minimum.
      let t = k.tau;
      if (t > 1 && a[t - 1] < a[t]) t--;
      else if (a[t + 1] < a[t]) t++;
      t = Math.max(1, Math.min(t, maxTau));
      const y0 = a[t - 1];
      const y1 = a[t];
      const y2 = a[t + 1];
      const den = y0 - 2 * y1 + y2;
      let shift = den > 0 ? (0.5 * (y0 - y2)) / den : 0;
      shift = Math.max(-1, Math.min(1, shift));
      const am = Math.max(0, y1 - 0.25 * (y0 - y2) * shift);
      k.period = t + shift;
      k.freq = sampleRate / k.period;
      k.a = am;
      k.c = a[t] > 0 ? Math.min(c[k.tau], (am * c[t]) / a[t]) : c[k.tau];
      // Periodicity evidence for "the period is T" also comes from 2T and 3T
      // (a sound that repeats every T repeats every 2T). Using the best of
      // them for voicing leaves the choice between T and its multiples to the
      // weights above and to continuity, so a hum or a second voice that
      // happens to line up better at 2T can't tip a note down an octave.
      k.cv = k.c;
      for (let m = 2; m <= 3; m++) {
        const lo = Math.floor(m * k.period * 0.995) - 1;
        const hi = Math.ceil(m * k.period * 1.005) + 1;
        if (hi > maxTau) break;
        for (let j = lo; j <= hi; j++) if (c[j] < k.cv) k.cv = c[j];
      }
    }
    return frame;
  }

  // Aperiodicity of the frame above ~250 Hz at (about) `period`: singing has
  // harmonics up through the formants, while mains hum, rumble and handling
  // noise are periodic only at the bottom of the spectrum.
  const HB_HZ = 250;
  function highBandAperiodicity(frame, period) {
    const { n, sampleRate, x, w } = frame;
    if (!frame.hb) {
      // 4th-order Butterworth high-pass (two RBJ biquads), started from rest
      // at x[0] so there's no step; the first 4 ms are dropped anyway.
      const y = w.y;
      const w0 = (2 * Math.PI * HB_HZ) / sampleRate;
      const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
      const cw = Math.cos(w0);
      const a0 = 1 + alpha;
      const b0 = (1 + cw) / 2 / a0;
      const b1 = -(1 + cw) / a0;
      const a1 = (-2 * cw) / a0;
      const a2 = (1 - alpha) / a0;
      let src = x;
      for (let pass = 0; pass < 2; pass++) {
        let x1 = src[0];
        let x2 = src[0];
        let y1 = 0;
        let y2 = 0;
        for (let i = 0; i < n; i++) {
          const xi = src[i];
          const v = b0 * xi + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
          x2 = x1;
          x1 = xi;
          y2 = y1;
          y1 = v;
          y[i] = v;
        }
        src = y;
      }
      const skip = Math.min(n >> 3, Math.round(0.004 * sampleRate));
      const cs = w.ha; // prefix sums of y^2 from skip
      cs[0] = 0;
      for (let i = skip; i < n; i++) cs[i - skip + 1] = cs[i - skip] + y[i] * y[i];
      frame.hb = { skip, len: n - skip, memo: new Map() };
    }
    const { skip, len, memo } = frame.hb;
    const y = w.y;
    const cs = w.ha;
    const lo = Math.max(1, Math.floor(period * 0.995) - 1);
    const hi = Math.min(len >> 1, Math.ceil(period * 1.005) + 1);
    if (cs[len] <= 0 || lo > hi) return 1;
    let best = 1;
    for (let t = lo; t <= hi; t++) {
      let v = memo.get(t);
      if (v === undefined) {
        let r = 0;
        for (let i = skip, j = skip + t; j < n; i++, j++) r += y[i] * y[j];
        const e = cs[len - t] + cs[len] - cs[t];
        v = e > 0 ? Math.max(0, (e - 2 * r) / e) : 1;
        memo.set(t, v);
      }
      if (v < best) best = v;
    }
    return best;
  }

  const sigmoid = (z) => 1 / (1 + Math.exp(-z));

  // Voicing tuning. c at the period is ~1/(1 + HNR): 0.3 is an HNR of ~4 dB.
  const VOICING = {
    centre: 0.3, // c where a frame is as likely voiced as not
    shortCentre: 0.2, // same, for the half-length window
    width: 0.05,
    hbCentre: 0.8, // high-band aperiodicity where voicing is doubted
    hbWidth: 0.04,
    absFloorDb: -74, // below this the input is effectively silent
    floorMarginDb: 3, // must be this far above the learned noise floor
  };

  // Probability that candidate k is a sung pitch, from its periodicity and
  // the high-band periodicity (the level is judged by the caller).
  function voicedProb(frame, k) {
    // A short window compares fewer periods, so even noise and rough voices
    // match better in it: it has to be more periodic to count.
    const centre = frame.short ? VOICING.shortCentre : VOICING.centre;
    let p = sigmoid((centre - k.cv) / VOICING.width);
    if (p > 0.01) p *= sigmoid((VOICING.hbCentre - highBandAperiodicity(frame, k.period)) / VOICING.hbWidth);
    return p;
  }

  // Returns {freq, clarity} or null when there is no clear pitch (silence,
  // breath, fry, mains hum or heavy distortion). A one-off decision on a
  // single block with no history, so it needs what starting a note needs;
  // `clarity` is 1 - c at the chosen period. A period that fits fewer than
  // twice in the rest of the block has less evidence behind it and must be
  // proportionally clearer (fry pulses can line up once by chance). Live
  // input should go through createTracker instead.
  function detectPitch(buf, sampleRate, opts = {}) {
    const minFreq = opts.minFreq || 40;
    const maxFreq = opts.maxFreq || 1100;
    const minRms = opts.minRms == null ? 0.0002 : opts.minRms;
    const minClarity = opts.minClarity == null ? 0.8 : opts.minClarity;
    if (rms(buf) < minRms) return null;
    const frame = analyseFrame(buf, sampleRate, minFreq, maxFreq);
    let best = null;
    let bestScore = 0;
    for (const k of frame.cands) {
      const repeats = (frame.n - k.period) / k.period;
      const maxC = (1 - minClarity) * Math.min(1, (repeats / 2) ** 2);
      if (k.c > maxC || k.freq < minFreq || k.freq > maxFreq) continue;
      const s = k.q * voicedProb(frame, k);
      if (s > bestScore) {
        bestScore = s;
        best = k;
      }
    }
    if (!best || highBandAperiodicity(frame, best.period) > VOICING.hbCentre || humMains(frame, best.freq)) return null;
    return { freq: best.freq, clarity: 1 - best.c };
  }

  // ---- Tracker --------------------------------------------------------------
  //
  // A causal Viterbi over each frame's candidates plus an "unvoiced" state:
  // the reading is the end of the cheapest path so far. Costs are negative log
  // probabilities. Staying voiced or unvoiced is free; starting a note costs
  // SWITCH_ON and ending one SWITCH_OFF, which is the voicing hysteresis (it
  // takes clear periodicity to start a note and less to keep one going; notes
  // last longer than the gaps between them, so ending one costs more).
  // Moving between pitches costs jumpCost(): next to nothing for vibrato, a
  // fixed price for a leap, so a stray octave or sub-octave dip in one frame
  // doesn't beat a continuing track, but a real leap that's held does, from
  // its first clear frame. A glide is cheap too: the change is measured from
  // where the track was heading as well as from where it was. A track can
  // coast through one frame with no fitting candidate (a click, a crackly
  // cycle) at MISS cost.
  const SWITCH_ON = 2;
  const SWITCH_OFF = 3;
  const JUMP_MAX = 3;
  const JUMP_CENTS = 200;
  const MISS = 3.5; // more than any jump, so a new note is never held back
  const MAX_GLIDE = 250; // cents per frame (~4 octaves/s) still read as a glide
  const CONTINUITY = 1; // nats
  const CONTINUITY_CENTS = 50;
  function jumpCost(cents, bonus) {
    const d = cents / JUMP_CENTS;
    const e = cents / CONTINUITY_CENTS;
    return JUMP_MAX * (1 - Math.exp(-d * d)) - (bonus ? CONTINUITY * Math.exp(-e * e) : 0);
  }
  const nlog = (p) => -Math.log(Math.min(1 - 1e-4, Math.max(1e-4, p)));
  const centsBetween = (f1, f2) => 1200 * Math.log2(f2 / f1);

  // Mains hum is the one periodic background that's common in quiet rooms,
  // and it sits in the bass range: 50 or 60 Hz plus harmonics, held by the
  // grid to a small fraction of a hertz, and as steady as a sine wave. A
  // candidate near 50/60/100/120 Hz is checked with a phase measurement: the
  // tone's phase advance between the two halves of the frame gives its
  // frequency far more precisely than the period estimate. If it's within
  // ~0.15 Hz of mains and carries a good share of the sound, it is hum, not a
  // note (no in-tune note is that close: mains is a third to half a semitone
  // off every note). Hum seen while nothing is sung is learned; from then on
  // each frame is also read with the hum fitted out (see push), so it can't
  // drag a quiet note off its period (a G2 over 50 Hz hum otherwise repeats
  // best at 49 Hz). It's forgotten once it has been inaudible for a few
  // seconds.
  function toneAt(frame, hz) {
    const { x, n, sampleRate } = frame;
    const half = n >> 1;
    const w = (2 * Math.PI * hz) / sampleRate;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const cwin = Math.cos((2 * Math.PI) / half);
    const swin = Math.sin((2 * Math.PI) / half);
    let r1 = 0;
    let i1 = 0;
    let r2 = 0;
    let i2 = 0;
    let wsum = 0;
    let c = 1; // e^{jwi}, by rotation
    let s = 0;
    let wc = 1; // cos(2 pi i / half), for the Hann window
    let ws = 0;
    for (let i = 0; i < half; i++) {
      const win = 0.5 - 0.5 * wc;
      const a = win * x[i];
      const b = win * x[i + half];
      r1 += a * c;
      i1 -= a * s;
      r2 += b * c;
      i2 -= b * s;
      wsum += win;
      const nc = c * cw - s * sw;
      s = c * sw + s * cw;
      c = nc;
      const nwc = wc * cwin - ws * swin;
      ws = wc * swin + ws * cwin;
      wc = nwc;
    }
    let dphi = Math.atan2(i2 * r1 - r2 * i1, r2 * r1 + i2 * i1) - w * half;
    dphi -= 2 * Math.PI * Math.round(dphi / (2 * Math.PI));
    const amp = (Math.sqrt(r1 * r1 + i1 * i1) + Math.sqrt(r2 * r2 + i2 * i2)) / wsum; // ~A
    const power = (amp * amp) / 2;
    return { offsetHz: (dphi * sampleRate) / (2 * Math.PI * half), share: power / (frame.rms * frame.rms + 1e-30) };
  }
  const MAINS_ZONE = 40; // cents: wide, the period estimate of a pure tone is loose
  function humMains(frame, freq) {
    for (const m of [50, 60]) {
      for (const h of [1, 2]) {
        if (Math.abs(centsBetween(h * m, freq)) > MAINS_ZONE) continue;
        frame.tones ||= {};
        const t = (frame.tones[h * m] ||= toneAt(frame, h * m));
        if (Math.abs(t.offsetHz) < 0.15 * h && t.share > 0.25) return m;
      }
    }
    return 0;
  }

  // Stateful per-frame pitch reading: push() the latest FRAME_SIZE samples
  // every tick; returns Hz or null. tracker.last has {freq, clarity, voiced,
  // floorDb} for the latest frame.
  function createTracker(opts = {}) {
    const minFreq = opts.minFreq || 40;
    const maxFreq = opts.maxFreq || 1100;
    let states;
    let unvoiced;
    let floorDb;
    let voicedDb;
    let humVotes;
    let hum;
    let last;
    let decimated = null;
    function reset() {
      // No history: voiced and unvoiced equally likely, any pitch.
      states = [{ freq: null, slope: 0, cost: 0, held: true }];
      unvoiced = 0;
      floorDb = null; // background level, from quiet frames with no pitch
      voicedDb = null; // recent singing level (decaying peak)
      humVotes = { 50: 0, 60: 0 }; // recent unvoiced frames that look like hum
      hum = null; // {hz, quiet} once hum has been recognised
      last = { freq: null, clarity: 0, voiced: 0, floorDb: null };
    }
    reset();

    function push(input, sampleRate) {
      // Above ~64 kHz, average down to ~48 kHz first: same span, same cost.
      let buf = input;
      const factor = Math.round(sampleRate / 48000);
      if (factor >= 2) {
        const m = Math.floor(input.length / factor);
        if (!decimated || decimated.length !== m) decimated = new Float32Array(m);
        for (let i = 0, j = input.length - m * factor; i < m; i++) {
          let s = 0;
          for (let k = 0; k < factor; k++) s += input[j++];
          decimated[i] = s / factor;
        }
        buf = decimated;
        sampleRate /= factor;
      }
      // With hum learned, the frame is read twice, as is and with the hum
      // fitted out, and the tracker takes whichever reading explains it
      // better: subtracting 50 Hz hum also strips the low harmonics of a G1
      // (49 Hz), which is better read as is.
      const frame = analyseFrame(buf, sampleRate, minFreq, maxFreq, 0, 0);
      const frames = hum ? [frame, analyseFrame(buf, sampleRate, minFreq, maxFreq, hum.hz, 1)] : [frame];
      // Also the middle half of the frame (same centre, half the span): when
      // the pitch moves fast (sirens, wide vibrato) the long window smears it.
      // Fewer periods make it weaker evidence, so it can carry a note on but
      // not start one (and isn't read when no note is within reach).
      if (buf.length >= 4096 && states.some((s) => s.freq != null && s.cost < SWITCH_OFF + 1)) {
        const q = buf.length >> 2;
        const short = analyseFrame(buf.subarray(q, 3 * q), sampleRate, minFreq, maxFreq, hum ? hum.hz : 0, 2);
        short.short = true;
        frames.push(short);
      }
      const db = 20 * Math.log10(frame.rms + 1e-12);

      // The background can't be louder than any frame, nor than the part of
      // a frame that doesn't repeat at its best period.
      let minA = 1;
      for (const f of frames) for (const k of f.cands) minA = Math.min(minA, k.a);
      if (floorDb != null) floorDb = Math.min(floorDb, db + 10 * Math.log10(Math.max(minA, 1e-3)));
      let levelOk = sigmoid((db - VOICING.absFloorDb) / 2);
      if (floorDb != null) levelOk *= sigmoid((db - floorDb - VOICING.floorMarginDb) / 1.5);

      const next = [];
      let pMax = 0;
      let periodic = 0; // same, ignoring the level
      let mainsNow = 0; // mains frequency of a hum-like candidate
      for (const f of frames) for (const k of f.cands) {
        if (k.freq < minFreq || k.freq > maxFreq) continue;
        const p = voicedProb(f, k);
        periodic = Math.max(periodic, p);
        let pv = p * levelOk;
        const mains = humMains(frame, k.freq);
        if (mains) {
          mainsNow = mains;
          pv *= 0.02;
        }
        pMax = Math.max(pMax, pv);
        let from = f.short ? Infinity : unvoiced + SWITCH_ON;
        let slope = 0;
        for (const s of states) {
          if (s.freq == null) {
            if (s.cost < from && !f.short) from = s.cost;
            continue;
          }
          const d = centsBetween(s.freq, k.freq);
          const bonus = !f.short && !s.short;
          const cost = s.cost + Math.min(jumpCost(d, bonus), jumpCost(d - s.slope, bonus));
          if (cost < from) {
            from = cost;
            slope = Math.abs(d) <= MAX_GLIDE ? d : 0;
          }
        }
        next.push({ freq: k.freq, slope, cost: from + nlog(pv) + nlog(k.q), clarity: 1 - k.c, held: false, short: !!f.short });
      }
      let hold = null;
      for (const s of states) {
        if (!s.held && (!hold || s.cost + MISS < hold.cost)) hold = { freq: s.freq, slope: 0, cost: s.cost + MISS, clarity: 0, held: true };
      }
      if (hold) next.push(hold);
      let u = unvoiced;
      for (const s of states) u = Math.min(u, s.cost + SWITCH_OFF);
      u += nlog(1 - pMax);

      let best = null;
      let min = u;
      for (const s of next) {
        if (s.cost < min) {
          min = s.cost;
          best = s;
        }
      }
      next.sort((p, q) => p.cost - q.cost);
      states = next.slice(0, 8);
      for (const s of states) s.cost -= min;
      unvoiced = u - min;

      // Background level: quiet frames with no pitch, well below the recent
      // singing (so breath, fry or a rough patch of the voice itself don't
      // count); it rises slowly (~2.5 dB/s) and drops at once (above).
      if (best && !best.held) voicedDb = voicedDb == null ? db : Math.max(db, voicedDb - 0.1);
      else if (voicedDb != null) voicedDb -= 0.1;
      if (!best && periodic < 0.2 && db > VOICING.absFloorDb && (voicedDb == null || db < voicedDb - 10)) {
        floorDb = floorDb == null ? db : Math.min(db, floorDb + 0.15);
      }

      // Hum: learned from unvoiced frames, forgotten after ~3 s of unvoiced
      // frames where what it explained was under 1% of the sound.
      if (!best) {
        for (const m of [50, 60]) humVotes[m] = mainsNow === m ? humVotes[m] + 1 : 0;
        if (!hum && (humVotes[50] >= 2 || humVotes[60] >= 2)) hum = { hz: humVotes[50] >= 2 ? 50 : 60, quiet: 0 };
        else if (hum) {
          const sub = frames[1];
          const share = sub.humEnergy / (sub.humEnergy + sub.rms * sub.rms * sub.n + 1e-20);
          hum.quiet = share < 0.01 ? hum.quiet + 1 : 0;
          if (hum.quiet > 50) hum = null;
        }
      }
      last = { freq: best ? best.freq : null, clarity: best ? best.clarity : 0, voiced: pMax, floorDb };
      return last.freq;
    }

    return {
      push,
      reset,
      get last() {
        return last;
      },
    };
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

  function median(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Median of the last 3 detections, for a steadier readout. Any gap (null)
  // clears the history so a new note shows up immediately.
  function smooth3(recent, freq) {
    if (freq == null) return { recent: [], value: null };
    const next = [...recent.slice(-2), freq];
    return { recent: next, value: [...next].sort((a, b) => a - b)[Math.floor(next.length / 2)] };
  }

  // Error against a target note for the Pitch tab. Unlike compareToTarget this
  // doesn't fold every octave: a singer 7 semitones sharp is told +700 ("go
  // lower"), and only a near-octave copy of the target (within slipCents) is
  // folded and treated as the right note in another octave.
  function pitchError(freq, targetMidi, slipCents = 200) {
    const sungMidi = freqToMidi(freq);
    const rawCents = 100 * (sungMidi - targetMidi);
    const octaves = Math.round(rawCents / 1200);
    const folded = rawCents - 1200 * octaves;
    const octaveSlip = octaves !== 0 && Math.abs(folded) <= slipCents;
    return { cents: octaveSlip ? folded : rawCents, rawCents, octaves, octaveSlip, sungMidi };
  }

  // Find the steadiest stretch near `targetMidi` at the end of a recording, to
  // play the singer's own note back to them. Returns sample indices or null.
  function pickClip(samples, sampleRate, targetMidi, opts = {}) {
    const { clipSec = 1.2, searchSec = 3, frame = 2048, tolCents = 60, minSec = 0.8 } = opts;
    const from = Math.max(0, samples.length - Math.round(searchSec * sampleRate));
    const blocks = [];
    for (let s = from; s + frame <= samples.length; s += frame) {
      const r = detectPitch(samples.subarray(s, s + frame), sampleRate);
      const midi = r ? freqToMidi(r.freq) : null;
      blocks.push({ s, midi, good: midi != null && Math.abs(100 * (midi - targetMidi)) <= tolCents });
    }

    // Longest run of good blocks; on a tie the later one wins.
    let best = null;
    let runStart = -1;
    for (let i = 0; i <= blocks.length; i++) {
      if (i < blocks.length && blocks[i].good) {
        if (runStart < 0) runStart = i;
        continue;
      }
      if (runStart >= 0) {
        const len = i - runStart;
        if (!best || len >= best.len) best = { from: runStart, len };
        runStart = -1;
      }
    }
    if (!best) return null;
    const runSec = (best.len * frame) / sampleRate;
    if (runSec < minSec) return null;

    const runFrom = blocks[best.from].s;
    const runTo = runFrom + best.len * frame;
    const clipLen = Math.round(Math.min(clipSec, runSec) * sampleRate);
    const start = Math.round((runFrom + runTo) / 2 - clipLen / 2);
    const end = start + clipLen;
    const run = blocks.slice(best.from, best.from + best.len);
    const inClip = run.filter((b) => b.s >= start && b.s + frame <= end);
    return { start, end, midi: median((inClip.length ? inClip : run).map((b) => b.midi)) };
  }

  // Gain that brings a clip up to a comfortable playback level.
  function clipGain(samples, start, end, targetRms = 0.08, maxGain = 4) {
    const r = rms(samples.subarray(start, end));
    return r > 0 ? Math.min(maxGain, targetRms / r) : 1;
  }

  const api = {
    FRAME_SIZE,
    frameSizeFor,
    createTracker,
    detectPitch,
    freqToMidi,
    midiToFreq,
    noteName,
    compareToTarget,
    judge,
    rms,
    targetAt,
    bestMatch,
    median,
    smooth3,
    pitchError,
    pickClip,
    clipGain,
  };
  root.Pitch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
