// UI: home screen, session player, reference tones and check-in.
(function () {
  const { STAGES, RANGES } = window.Curriculum;
  const P = window.Progress;
  const STORAGE_KEY = "scream-coach-v1";

  const $ = (id) => document.getElementById(id);

  // ---- Persistence -------------------------------------------------------

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...P.defaultState(), ...JSON.parse(raw) };
    } catch (e) {
      /* storage unavailable or corrupt: start fresh */
    }
    return P.defaultState();
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* private mode etc. Progress just won't persist. */
    }
  }

  let state = loadState();

  // ---- Reference tones ---------------------------------------------------

  const Tones = {
    ctx: null,
    timers: [],
    nodes: [],
    targets: [], // what the singer should be on, for the pitch check
    muted: false, // reference tones can be silenced while targets keep running

    ensureCtx() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
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
      const f = (semi) => P.midiToFreq(baseMidi + semi);
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

  // ---- Microphone pitch check -------------------------------------------

  const Mic = {
    stream: null,
    source: null,
    analyser: null,
    buf: null,
    interval: null,
    recent: [], // last few detections, for a steadier display

    supported() {
      return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    },

    async open() {
      if (this.stream) return;
      const ctx = Tones.ensureCtx();
      // Echo cancellation helps keep the reference tone out of the mic;
      // noise suppression and auto gain mangle sung notes, so they're off.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      });
      this.source = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.buf = new Float32Array(this.analyser.fftSize);
      this.source.connect(this.analyser);
      this.recent = [];
      this.interval = setInterval(pitchTick, 60);
    },

    close() {
      clearInterval(this.interval);
      this.interval = null;
      if (this.source) this.source.disconnect();
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = this.source = this.analyser = null;
    },

    // Median of the last 3 detections; null as soon as the voice stops.
    read() {
      this.analyser.getFloatTimeDomainData(this.buf);
      const r = window.Pitch.detectPitch(this.buf, Tones.ctx.sampleRate);
      if (!r) {
        this.recent = [];
        return null;
      }
      this.recent = [...this.recent.slice(-2), r.freq];
      return [...this.recent].sort((a, b) => a - b)[Math.floor(this.recent.length / 2)];
    },
  };

  const STATUS_TEXT = {
    on: "On the note ✓",
    "slightly-flat": "A little flat, nudge up",
    "slightly-sharp": "A little sharp, ease down",
    flat: "Flat, go higher",
    sharp: "Sharp, go lower",
  };

  function pitchTick() {
    if (!session || !Mic.analyser) return;
    const Pt = window.Pitch;
    const freq = Mic.read();
    const now = Tones.ctx.currentTime;
    const panel = $("pitch-panel");
    const needle = $("meter-needle");
    const status = $("pitch-status");
    const shownTarget = Pt.targetAt(Tones.targets, now);

    $("pitch-note").textContent = freq ? Pt.noteName(Pt.freqToMidi(freq)) : "–";
    panel.dataset.state = "idle";
    needle.hidden = true;

    if (!freq) {
      $("pitch-target").textContent = shownTarget ? Pt.noteName(Pt.freqToMidi(shownTarget)) : "–";
      const noisy = session.plan.stage.distortion && current().section.startsWith("Stage");
      status.textContent = noisy
        ? "No clear pitch. That's normal for fry and distortion."
        : shownTarget
          ? "Sing along with the reference note"
          : "Listening…";
      return;
    }

    const match = Pt.bestMatch(Tones.targets, now, freq);
    if (!match) {
      $("pitch-target").textContent = "–";
      status.textContent = "No target right now, just showing your note";
      return;
    }

    const verdict = Pt.judge(match.cents);
    $("pitch-target").textContent = Pt.noteName(Pt.freqToMidi(match.target));
    panel.dataset.state = verdict === "on" ? "on" : verdict.startsWith("slightly") ? "close" : "off";
    needle.hidden = false;
    const clamped = Math.max(-150, Math.min(150, match.cents));
    needle.style.left = `${50 + (clamped / 150) * 50}%`;
    let text = `${STATUS_TEXT[verdict]} (${match.cents > 0 ? "+" : ""}${Math.round(match.cents)}¢)`;
    if (match.octaves) text += `, an octave ${match.octaves < 0 ? "below" : "above"} the reference, which still counts`;
    status.textContent = text;

    if (session.running) {
      const sc = (session.scores[session.index] ||= { on: 0, voiced: 0 });
      sc.voiced++;
      if (verdict === "on") sc.on++;
      renderExerciseScore();
    }
  }

  // Ticks are ~60 ms apart, so require ~1.5 s of singing before scoring.
  const MIN_SCORED_TICKS = 25;

  function pct(on, voiced) {
    return voiced >= MIN_SCORED_TICKS ? Math.round((100 * on) / voiced) : null;
  }

  function renderExerciseScore() {
    const sc = session.scores[session.index];
    const p = sc && pct(sc.on, sc.voiced);
    $("pitch-score").textContent = p == null ? "" : `On pitch ${p}% of the time in this exercise`;
  }

  function sessionAccuracy() {
    let on = 0;
    let voiced = 0;
    for (const sc of Object.values(session.scores)) {
      on += sc.on;
      voiced += sc.voiced;
    }
    return pct(on, voiced);
  }

  async function setMic(on) {
    state.mic = on;
    saveState();
    $("mic-toggle").checked = on;
    $("pitch-panel").hidden = !on;
    if (!on) {
      Mic.close();
      return;
    }
    try {
      await Mic.open();
    } catch (e) {
      Mic.close();
      state.mic = false;
      saveState();
      $("mic-toggle").checked = false;
      $("pitch-panel").hidden = true;
      $("mic-error").hidden = false;
      $("mic-error").textContent =
        e && e.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in your browser's site settings to use the pitch check."
          : "Couldn't open the microphone.";
    }
  }

  // ---- Home --------------------------------------------------------------

  function show(screenId) {
    for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== screenId;
    window.scrollTo(0, 0);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }

  function renderAdvice() {
    const box = $("advice");
    box.innerHTML = "";
    for (const a of P.safetyAdvice(state)) {
      const div = document.createElement("div");
      div.className = `card advice ${a.level}`;
      const p = document.createElement("p");
      p.textContent = a.text;
      div.appendChild(p);
      box.appendChild(div);
    }
  }

  function renderRange() {
    const box = $("range-picker");
    box.innerHTML = "";
    for (const [key, r] of Object.entries(RANGES)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(state.range === key));
      b.textContent = r.label;
      b.addEventListener("click", () => {
        state.range = key;
        saveState();
        renderRange();
      });
      box.appendChild(b);
    }
  }

  function renderStages() {
    const list = $("stage-list");
    list.innerHTML = "";
    const unlocked = P.highestUnlocked(state);
    const blocked = P.distortionBlocked(state);
    for (const stage of STAGES) {
      const li = document.createElement("li");
      const isLocked = stage.id > unlocked;
      li.className = "stage" + (isLocked ? " locked" : "");

      const h = document.createElement("h3");
      h.textContent = `${stage.id}. ${stage.name}`;
      if (stage.distortion) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "distortion";
        h.appendChild(badge);
      }
      const goal = document.createElement("p");
      goal.textContent = stage.goal;

      const meta = document.createElement("span");
      meta.className = "meta";
      const { done, needed } = P.stageProgress(state, stage.id);
      if (isLocked) meta.textContent = "Locked";
      else if (needed == null) meta.textContent = `${done} healthy sessions`;
      else meta.textContent = `${Math.min(done, needed)} / ${needed} healthy sessions to unlock next`;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = stage.id === unlocked ? "primary" : "secondary";
      btn.disabled = isLocked;
      const warmupOnly = stage.distortion && blocked;
      btn.textContent = isLocked ? "🔒" : warmupOnly ? "Warm-up only" : "Practise";
      btn.addEventListener("click", () => startSession(stage.id));

      li.append(h, btn, goal, meta);
      list.appendChild(li);
    }
  }

  function renderHistory() {
    const ul = $("history");
    ul.innerHTML = "";
    const recent = state.sessions.slice(-10).reverse();
    if (!recent.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No sessions yet. Start with Stage 1.";
      ul.appendChild(li);
      return;
    }
    for (const s of recent) {
      const li = document.createElement("li");
      const left = document.createElement("span");
      const dot = document.createElement("span");
      dot.className = `dot ${s.feeling}`;
      left.append(dot, `Stage ${s.stage}${s.warmupOnly ? " (warm-up only)" : ""}`);
      const right = document.createElement("span");
      right.className = "muted";
      right.textContent =
        (s.pitchAccuracy != null ? `${s.pitchAccuracy}% on pitch · ` : "") + new Date(s.date).toLocaleDateString();
      li.append(left, right);
      ul.appendChild(li);
    }
  }

  function renderHome() {
    renderAdvice();
    renderRange();
    renderStages();
    renderHistory();
    show("home");
  }

  // ---- Session player ----------------------------------------------------

  let session = null; // { plan, index, remaining, running, lastTick, interval }

  function startSession(stageId) {
    const plan = P.buildSession(state, stageId);
    session = { plan, index: 0, remaining: plan.items[0].exercise.seconds, running: false, interval: null, scores: {} };
    renderExercise();
    show("session");
    $("mic-error").hidden = true;
    if (!Mic.supported()) {
      $("mic-toggle").disabled = true;
      $("mic-error").hidden = false;
      $("mic-error").textContent = "Pitch check needs the page to be opened over https:// (or localhost).";
    } else if (state.mic) {
      setMic(true);
    }
  }

  function current() {
    return session.plan.items[session.index];
  }

  function renderExercise() {
    const { section, exercise } = current();
    const items = session.plan.items;
    $("section-label").textContent = section;
    $("step-count").textContent = `${session.index + 1} / ${items.length}`;
    $("ex-name").textContent = exercise.name;

    const steps = $("ex-steps");
    steps.innerHTML = "";
    for (const s of exercise.steps) {
      const li = document.createElement("li");
      li.textContent = s;
      steps.appendChild(li);
    }
    $("ex-cue").textContent = exercise.cue;
    $("tone-toggle-wrap").hidden = !exercise.tone;
    $("prev-btn").disabled = session.index === 0;
    $("next-btn").textContent = session.index === items.length - 1 ? "✓" : "▶";

    const before = P.totalSeconds(items.slice(0, session.index));
    $("overall-bar").style.width = `${(100 * before) / P.totalSeconds(items)}%`;
    renderTimer();
    renderPlayButton();
    renderExerciseScore();
  }

  function renderTimer() {
    const total = current().exercise.seconds;
    $("timer-text").textContent = fmtTime(session.remaining);
    $("timer-bar").style.width = `${(100 * (total - session.remaining)) / total}%`;
  }

  function renderPlayButton() {
    $("play-btn").textContent = session.running ? "Pause" : session.remaining < current().exercise.seconds ? "Resume" : "Start";
  }

  function syncTones() {
    const tone = current().exercise.tone;
    // Targets keep running with the tones muted, so the pitch check still works.
    Tones.muted = !$("tone-toggle").checked;
    if (session.running && tone && (!Tones.muted || Mic.stream)) {
      Tones.start(tone, RANGES[state.range].baseMidi);
    } else {
      Tones.stop();
    }
  }

  function setRunning(on) {
    session.running = on;
    clearInterval(session.interval);
    if (on) {
      session.lastTick = performance.now();
      session.interval = setInterval(tick, 250);
    }
    syncTones();
    renderPlayButton();
  }

  function tick() {
    const now = performance.now();
    session.remaining -= (now - session.lastTick) / 1000;
    session.lastTick = now;
    if (session.remaining <= 0) {
      chime();
      goTo(session.index + 1, true);
      return;
    }
    renderTimer();
  }

  function chime() {
    const ctx = Tones.ensureCtx();
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
  }

  function goTo(index, keepRunning) {
    const wasRunning = keepRunning && session.running;
    setRunning(false);
    if (index >= session.plan.items.length) {
      finishSession();
      return;
    }
    session.index = Math.max(0, index);
    session.remaining = current().exercise.seconds;
    renderExercise();
    if (wasRunning) setRunning(true);
  }

  function endSession() {
    if (!session) return;
    setRunning(false);
    Tones.stop();
    Mic.close();
  }

  function finishSession() {
    const accuracy = sessionAccuracy();
    session.pitchAccuracy = accuracy;
    endSession();
    $("checkin-score").hidden = accuracy == null;
    $("checkin-score").textContent = `Pitch accuracy this session: ${accuracy}%`;
    renderCheckin();
    show("checkin");
  }

  function renderCheckin() {
    const box = $("feelings");
    box.innerHTML = "";
    for (const [key, f] of Object.entries(P.FEELINGS)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "secondary";
      const dot = document.createElement("span");
      dot.className = `dot ${key}`;
      b.append(dot, f.label);
      b.addEventListener("click", () => {
        state = P.recordSession(state, {
          stage: session.plan.stage.id,
          warmupOnly: session.plan.warmupOnly,
          feeling: key,
          pitchAccuracy: session.pitchAccuracy,
        });
        saveState();
        session = null;
        renderHome();
      });
      box.appendChild(b);
    }
  }

  // ---- Wiring ------------------------------------------------------------

  $("play-btn").addEventListener("click", () => {
    Tones.ensureCtx(); // must be created from a user gesture on iOS
    setRunning(!session.running);
  });
  $("next-btn").addEventListener("click", () => goTo(session.index + 1, true));
  $("prev-btn").addEventListener("click", () => goTo(session.index - 1, true));
  $("tone-toggle").addEventListener("change", syncTones);
  $("mic-toggle").addEventListener("change", async (e) => {
    await setMic(e.target.checked);
    syncTones(); // start or stop silent targets for a muted reference
  });
  $("stop-btn").addEventListener("click", finishSession);
  $("quit-btn").addEventListener("click", () => {
    if (!confirm("Quit without recording this session?")) return;
    endSession();
    session = null;
    renderHome();
  });
  $("reset-btn").addEventListener("click", () => {
    if (!confirm("Delete all progress and history?")) return;
    state = P.defaultState();
    saveState();
    renderHome();
  });

  renderHome();
})();
