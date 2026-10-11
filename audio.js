// Audio in and out, shared by the guided session and the Pitch tab: reference
// tones, the microphone pitch feed and short in-memory voice recordings.
// Browser only. Exposed as window.Sound (not `Audio`, which would shadow
// HTMLAudioElement).
(function () {
  // Formants for the voice-like reference: [F1, F2] in Hz.
  const FORMANTS = {
    "voice-low": [300, 870],
    "voice-high": [370, 950], // an "oo"
  };

  // ---- Reference tones ---------------------------------------------------

  const Tones = {
    ctx: null,
    timers: [],
    nodes: [],
    targets: [], // what the singer should be on, for the pitch check
    muted: false, // reference tones can be silenced while targets keep running
    sinkId: "", // chosen output device; "" = system default
    onOutputLost: null, // called when the chosen output can't be used

    ensureCtx() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        if (this.sinkId) this.setOutput(this.sinkId);
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    },

    canChooseOutput() {
      const AC = window.AudioContext;
      return Boolean(AC && typeof AC.prototype.setSinkId === "function");
    },

    // Send all app sound to an output device ("" = system default). Resolves
    // true on success; on failure it goes back to the default.
    async setOutput(id) {
      this.sinkId = id || "";
      if (!this.ctx || !this.canChooseOutput()) return !this.sinkId || this.canChooseOutput();
      try {
        await this.ctx.setSinkId(this.sinkId);
        return true;
      } catch (e) {
        this.sinkId = "";
        try {
          await this.ctx.setSinkId("");
        } catch (e2) {
          /* already on the default */
        }
        if (this.onOutputLost) this.onOutputLost(e);
        return false;
      }
    },

    // One note (or siren, with endFreq) with a short attack/release so it
    // doesn't click. `targetEnd` lets a target outlast the sound (drones).
    voice(startFreq, at, dur, endFreq, targetEnd) {
      this.targets.push({ start: at, end: targetEnd || at + dur, from: startFreq, to: endFreq });
      const ctx = this.ctx;
      this.targets = this.targets.filter((s) => s.end > ctx.currentTime - 1);
      if (this.muted) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(startFreq, at);
      if (endFreq) {
        osc.frequency.exponentialRampToValueAtTime(endFreq, at + dur / 2);
        osc.frequency.exponentialRampToValueAtTime(startFreq, at + dur);
      }
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.18, at + 0.04);
      gain.gain.setValueAtTime(0.18, at + Math.max(0.05, dur - 0.08));
      gain.gain.linearRampToValueAtTime(0, at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + dur + 0.02);
      this.nodes.push(osc);
      osc.onended = () => {
        this.nodes = this.nodes.filter((n) => n !== osc);
      };
    },

    // Schedule one cycle of the pattern; returns its length in seconds.
    scheduleCycle(pattern, baseMidi, cycle) {
      const ctx = this.ctx;
      const t0 = ctx.currentTime + 0.05;
      const f = (semi) => window.Pitch.midiToFreq(baseMidi + semi);
      if (pattern.type === "scale") {
        const step = cycle % pattern.steps;
        const root = pattern.startOffset + step;
        pattern.degrees.forEach((deg, i) => {
          this.voice(f(root + deg), t0 + i * pattern.noteSec, pattern.noteSec * 0.95);
        });
        return pattern.degrees.length * pattern.noteSec + 1.6; // breath between reps
      }
      if (pattern.type === "glide") {
        this.voice(f(pattern.fromOffset), t0, pattern.sec * 2, f(pattern.toOffset));
        return pattern.sec * 2 + 1.2;
      }
      if (pattern.type === "drone") {
        // Sound for 2.5 s, but keep it as the target until the next repeat.
        this.voice(f(pattern.offset), t0, 2.5, null, t0 + 5);
        return 5;
      }
      return 0;
    },

    start(pattern, baseMidi) {
      this.stop();
      if (!pattern || !this.ensureCtx()) return;
      let cycle = 0;
      const loop = () => {
        const len = this.scheduleCycle(pattern, baseMidi, cycle++);
        if (len > 0) this.timers.push(setTimeout(loop, len * 1000));
      };
      loop();
    },

    // A one-shot reference note for the Pitch tab. Unlike voice() it ignores
    // `muted` and isn't a pitch-check target, so the session's tone switch
    // can't silence it. Steady, with no vibrato: that is easiest to imitate.
    // Returns {start, end} in context time, or null without Web Audio.
    note(freq, { at, dur = 1.5, gain = 0.16, timbre = "voice-low" } = {}) {
      const ctx = this.ensureCtx();
      if (!ctx) return null;
      if (at == null) at = ctx.currentTime + 0.05;
      const formants = FORMANTS[timbre];
      const peak = formants ? gain * 0.8 : gain;
      const attack = Math.min(0.06, dur / 2);
      const release = Math.min(0.12, dur - attack);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + attack);
      env.gain.setValueAtTime(peak, at + dur - release);
      env.gain.linearRampToValueAtTime(0, at + dur);
      env.connect(ctx.destination);

      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      const graph = [osc, env];
      if (formants) {
        // Sawtooth through a gentle lowpass plus two formant bands sounds
        // more like a sung vowel than a bare synth tone.
        osc.type = "sawtooth";
        const branches = [
          ["lowpass", Math.min(2.5 * freq, ctx.sampleRate / 2), 0.7, 0.6],
          ["bandpass", formants[0], 5, 0.9],
          ["bandpass", formants[1], 7, 0.35],
        ];
        for (const [type, cutoff, q, level] of branches) {
          const filter = ctx.createBiquadFilter();
          filter.type = type;
          filter.frequency.value = cutoff;
          filter.Q.value = q;
          const branchGain = ctx.createGain();
          branchGain.gain.value = level;
          osc.connect(filter).connect(branchGain).connect(env);
          graph.push(filter, branchGain);
        }
      } else {
        osc.type = "triangle";
        osc.connect(env);
      }
      osc.start(at);
      osc.stop(at + dur + 0.02);
      this.track(osc, graph);
      return { start: at, end: at + dur };
    },

    // Play a recorded clip (the singer's own voice) with 30 ms fades so the
    // cut edges don't click. Returns {start, end}, or null.
    playBuffer(buffer, { at, gain = 1 } = {}) {
      const ctx = this.ensureCtx();
      if (!ctx || !buffer) return null;
      if (at == null) at = ctx.currentTime + 0.05;
      const dur = buffer.duration;
      const fade = Math.min(0.03, dur / 2);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(gain, at + fade);
      g.gain.setValueAtTime(gain, at + dur - fade);
      g.gain.linearRampToValueAtTime(0, at + dur);
      src.connect(g).connect(ctx.destination);
      src.start(at);
      this.track(src, [src, g]);
      return { start: at, end: at + dur };
    },

    // Keep a one-shot stoppable by stop(), and free its whole graph when it
    // ends (naturally or stopped) so repeated notes don't pile up nodes.
    track(src, graph) {
      this.nodes.push(src);
      src.onended = () => {
        this.nodes = this.nodes.filter((n) => n !== src);
        for (const n of graph) n.disconnect();
      };
    },

    // End-of-exercise ding.
    chime() {
      const ctx = this.ensureCtx();
      if (!ctx) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1046.5, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.65);
    },

    stop() {
      this.timers.forEach(clearTimeout);
      this.timers = [];
      this.targets = [];
      for (const n of this.nodes) {
        try {
          n.stop();
        } catch (e) {
          /* already stopped */
        }
      }
      this.nodes = [];
    },
  };

  // ---- Microphone pitch feed ---------------------------------------------

  // One analyser polled every PERIOD_MS; each tick sends a frame
  // {t, freq, rawFreq, clarity, rms} to every subscriber. `freq` is smoothed
  // (median of the last 3 detections), `rawFreq` is this tick's detection.
  const Mic = {
    PERIOD_MS: 60, // the session check's MIN_SCORED_TICKS assumes this
    stream: null,
    source: null,
    analyser: null,
    buf: null,
    interval: null,
    echoCancellation: null, // of the open stream
    recent: [], // last few detections, for a steadier reading
    listeners: new Set(),
    queue: Promise.resolve(),
    generation: 0, // bumped by close(), so an open in flight knows to give up
    deviceId: "", // chosen microphone; "" = system default
    openDeviceId: null, // the choice the open stream was made for
    fellBack: false, // the chosen mic wasn't available, so the default is in use

    supported() {
      return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    },

    // Calls are queued so overlapping opens (a double click, a reopen with
    // other constraints) can't race each other. Resolves true when the mic is
    // open, false when a close() cancelled this open while it was waiting.
    open(opts = {}) {
      const generation = this.generation;
      const p = this.queue.then(() => this.connect(opts, generation));
      this.queue = p.catch(() => {});
      return p;
    },

    async connect({ echoCancellation = true } = {}, generation) {
      if (generation !== this.generation) return false; // closed before its turn
      if (this.stream && this.echoCancellation === echoCancellation && this.openDeviceId === this.deviceId) return true;
      const ctx = Tones.ensureCtx();
      if (!ctx) throw new Error("Web Audio is not supported");
      this.release(); // different constraints: reopen, keeping listeners
      // Echo cancellation helps keep the reference tone out of the mic;
      // noise suppression and auto gain mangle sung notes, so they're off.
      const base = { echoCancellation, noiseSuppression: false, autoGainControl: false };
      const wanted = this.deviceId;
      let stream;
      let fellBack = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: wanted ? { ...base, deviceId: { exact: wanted } } : base,
        });
      } catch (e) {
        // The chosen mic is unplugged or renamed: use the default instead.
        if (!wanted || !e || (e.name !== "OverconstrainedError" && e.name !== "NotFoundError")) throw e;
        if (generation !== this.generation) return false;
        stream = await navigator.mediaDevices.getUserMedia({ audio: base });
        fellBack = true;
      }
      if (generation !== this.generation) {
        // close() ran while the permission prompt was up.
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      this.stream = stream;
      this.echoCancellation = echoCancellation;
      this.openDeviceId = wanted;
      this.fellBack = fellBack;
      // Unplugged mid-use: reopen (falling back to the default), keeping listeners.
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.addEventListener("ended", () => {
          if (this.stream !== stream) return;
          this.release();
          this.open({ echoCancellation }).catch(() => {});
        });
      }
      this.source = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.buf = new Float32Array(this.analyser.fftSize);
      this.source.connect(this.analyser);
      this.recent = [];
      return true;
    },

    // Adding the same fn twice is a no-op, so it can't be fed (and score)
    // twice per tick. Returns the matching unsubscribe function.
    subscribe(fn) {
      this.listeners.add(fn);
      if (!this.interval) this.interval = setInterval(() => this.tick(), this.PERIOD_MS);
      return () => this.unsubscribe(fn);
    },

    unsubscribe(fn) {
      this.listeners.delete(fn);
      if (!this.listeners.size) {
        clearInterval(this.interval);
        this.interval = null;
      }
    },

    tick() {
      if (!this.analyser) return;
      const Pt = window.Pitch;
      const ctx = Tones.ctx;
      this.analyser.getFloatTimeDomainData(this.buf);
      const r = Pt.detectPitch(this.buf, ctx.sampleRate);
      const smoothed = Pt.smooth3(this.recent, r ? r.freq : null);
      this.recent = smoothed.recent;
      const frame = {
        t: ctx.currentTime,
        freq: smoothed.value,
        rawFreq: r ? r.freq : null,
        clarity: r ? r.clarity : 0,
        rms: Pt.rms(this.buf),
      };
      // Copy first: a listener may unsubscribe itself or others, or close().
      for (const fn of [...this.listeners]) {
        if (!this.listeners.has(fn)) continue;
        try {
          fn(frame);
        } catch (e) {
          console.error(e);
        }
      }
    },

    // Drop the stream and audio nodes but keep listeners and the interval.
    // Switch microphones. An open mic reopens on the new one, keeping its
    // listeners; resolves like open().
    async setDevice(id) {
      this.deviceId = id || "";
      if (!this.stream) return true;
      return this.open({ echoCancellation: this.echoCancellation });
    },

    release() {
      if (this.source) this.source.disconnect();
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = this.source = this.analyser = this.buf = null;
      this.echoCancellation = null;
      this.openDeviceId = null;
      this.recent = [];
    },

    close() {
      this.generation++;
      clearInterval(this.interval);
      this.interval = null;
      this.listeners.clear();
      this.release();
    },
  };

  // ---- Voice recorder ----------------------------------------------------

  // decodeAudioData is callback-only in older Safari, promise-based elsewhere.
  function decodeAudio(ctx, data) {
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // Records the mic stream so Stage 1 can play the singer's own note back.
  // Recordings stay in memory only.
  const Recorder = {
    TYPES: ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"],
    STOP_TIMEOUT_MS: 2000, // stop() gives up (null) rather than hang
    take: null, // { rec, chunks, stopped, onStop }

    supported() {
      return typeof MediaRecorder !== "undefined";
    },

    // Starts a new recording, discarding any current one. Returns false when
    // recording isn't possible; stop() then resolves null.
    start(stream) {
      this.cancel();
      if (!this.supported() || !stream) return false;
      const canCheck = typeof MediaRecorder.isTypeSupported === "function";
      const mimeType = this.TYPES.find((t) => canCheck && MediaRecorder.isTypeSupported(t));
      try {
        const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const take = { rec, chunks: [], stopped: false, onStop: null };
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size) take.chunks.push(e.data);
        };
        rec.onstop = () => {
          take.stopped = true;
          if (take.onStop) take.onStop();
        };
        rec.start();
        this.take = take;
        return true;
      } catch (e) {
        return false;
      }
    },

    // Resolves the recording as an AudioBuffer, or null if nothing was being
    // recorded or anything fails (including taking longer than the timeout).
    stop() {
      const take = this.take;
      this.take = null;
      if (!take) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), this.STOP_TIMEOUT_MS);
        const finish = (buffer) => {
          clearTimeout(timer);
          resolve(buffer || null);
        };
        take.onStop = async () => {
          try {
            const ctx = Tones.ctx;
            if (!ctx || !take.chunks.length) return finish(null);
            const blob = new Blob(take.chunks, { type: take.chunks[0].type || take.rec.mimeType });
            finish(await decodeAudio(ctx, await blob.arrayBuffer()));
          } catch (e) {
            finish(null);
          }
        };
        if (take.stopped) {
          take.onStop();
        } else if (take.rec.state !== "inactive") {
          try {
            take.rec.stop(); // the last chunk arrives, then onstop decodes
          } catch (e) {
            finish(null);
          }
        }
        // Otherwise the recorder already ended on its own (its track
        // stopped) and its stop event is still on the way.
      });
    },

    // Stops recording and throws the data away.
    cancel() {
      const take = this.take;
      this.take = null;
      if (!take) return;
      take.rec.ondataavailable = null;
      take.chunks = [];
      if (take.rec.state !== "inactive") {
        try {
          take.rec.stop();
        } catch (e) {
          /* already stopped */
        }
      }
    },
  };

  window.Sound = { Tones, Mic, Recorder };
})();
