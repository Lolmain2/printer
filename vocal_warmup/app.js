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

  // ---- Navigation ------------------------------------------------------

  let view = "practice";

  function show(viewId) {
    view = viewId;
    for (const s of document.querySelectorAll(".view")) s.hidden = s.id !== `view-${viewId}`;
    for (const b of document.querySelectorAll(".nav-item")) {
      if (b.dataset.view === viewId) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
    document.body.classList.toggle("in-session", viewId === "session" || viewId === "checkin");
    window.scrollTo(0, 0);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    const use = document.createElementNS(ns, "use");
    use.setAttribute("href", `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  // ---- Practice ----------------------------------------------------------

  let selectedStage = null; // null = the highest unlocked stage

  function activeStage() {
    const unlocked = P.highestUnlocked(state);
    return selectedStage && selectedStage <= unlocked ? selectedStage : unlocked;
  }

  function renderAdvice() {
    const box = $("advice");
    box.innerHTML = "";
    for (const a of P.safetyAdvice(state)) {
      const div = el("div", `advice ${a.level}`);
      div.appendChild(el("p", null, a.text));
      box.appendChild(div);
    }
  }

  function renderHero() {
    const plan = P.buildSession(state, activeStage());
    const stage = plan.stage;
    const counts = { Warm: 0, Stage: 0, Cool: 0 };
    for (const it of plan.items) counts[it.section.split(/[- ]/)[0]]++;
    $("hero-title").textContent = `Stage ${stage.id} · ${stage.name}`;
    $("hero-plan").textContent = plan.warmupOnly
      ? "Warm-up and cool-down only. Distortion is paused until your voice feels healthy again."
      : `Warm-up (${counts.Warm}) → ${counts.Stage} technique exercises → cool-down (${counts.Cool}). ${stage.goal}`;
    $("hero-length").textContent = `About ${Math.round(P.totalSeconds(plan.items) / 60)} min`;
  }

  function renderPath() {
    const list = $("path");
    list.innerHTML = "";
    const unlocked = P.highestUnlocked(state);
    const active = activeStage();
    for (const stage of STAGES) {
      const locked = stage.id > unlocked;
      const done = stage.id < unlocked;
      const li = el("li");
      const btn = el("button", "path-item");
      btn.type = "button";
      btn.disabled = locked;
      btn.classList.toggle("locked", locked);
      btn.classList.toggle("done", done);
      btn.classList.toggle("current", stage.id === unlocked);
      btn.classList.toggle("selected", stage.id === active);
      btn.addEventListener("click", () => {
        selectedStage = stage.id;
        renderPractice();
      });

      const dot = el("span", "path-dot");
      if (locked) dot.appendChild(icon("lock"));
      else if (done) dot.appendChild(icon("check"));
      else dot.textContent = stage.id;

      const text = el("span", "path-text");
      const name = el("span", "path-name", stage.name);
      if (stage.distortion) name.appendChild(el("span", "tag", "distortion"));
      text.append(name, el("span", "path-goal", stage.goal));

      if (!locked) {
        const { done: n, needed } = P.stageProgress(state, stage.id);
        const meta = el("span", "path-meta");
        if (needed == null) {
          meta.textContent = `${n} healthy session${n === 1 ? "" : "s"}`;
        } else if (done) {
          meta.textContent = "Complete";
        } else {
          const bar = el("span", "mini-bar");
          const fill = el("span");
          fill.style.width = `${(100 * Math.min(n, needed)) / needed}%`;
          bar.appendChild(fill);
          meta.append(bar, `${Math.min(n, needed)} of ${needed} sessions to unlock the next stage`);
        }
        text.appendChild(meta);
      }

      btn.append(dot, text);
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function renderPractice() {
    renderAdvice();
    renderHero();
    renderPath();
  }

  // ---- Progress ----------------------------------------------------------

  function renderProgress() {
    $("stat-sessions").textContent = state.sessions.length;
    $("stat-stage").textContent = P.highestUnlocked(state);
    const scored = state.sessions.filter((s) => s.pitchAccuracy != null).slice(-5);
    $("stat-pitch").textContent = scored.length
      ? `${Math.round(scored.reduce((a, s) => a + s.pitchAccuracy, 0) / scored.length)}%`
      : "–";

    const ul = $("history");
    ul.innerHTML = "";
    const recent = state.sessions.slice(-30).reverse();
    if (!recent.length) {
      ul.appendChild(el("li", "empty", "No sessions yet. Your history will show up here."));
      return;
    }
    for (const s of recent) {
      const li = el("li");
      const stage = STAGES.find((st) => st.id === s.stage);
      li.append(
        el("span", `dot ${s.feeling}`),
        el("span", "grow", `Stage ${s.stage}: ${stage ? stage.name : ""}${s.warmupOnly ? " (warm-up only)" : ""}`),
      );
      if (s.pitchAccuracy != null) li.appendChild(el("span", "muted small", `${s.pitchAccuracy}% on pitch`));
      li.appendChild(el("span", "muted small", new Date(s.date).toLocaleDateString()));
      li.title = P.FEELINGS[s.feeling] ? P.FEELINGS[s.feeling].label : "";
      ul.appendChild(li);
    }
  }

  // ---- Settings ----------------------------------------------------------

  function renderSettings() {
    const box = $("range-picker");
    box.innerHTML = "";
    for (const [key, r] of Object.entries(RANGES)) {
      const b = el("button", null, r.label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(state.range === key));
      b.addEventListener("click", () => {
        state.range = key;
        saveState();
        renderSettings();
      });
      box.appendChild(b);
    }
    $("mic-default").checked = Boolean(state.mic);
  }

  function goView(v) {
    if (v === "practice") renderPractice();
    if (v === "progress") renderProgress();
    if (v === "settings") renderSettings();
    show(v);
  }

  // ---- Session player ----------------------------------------------------

  let session = null; // { plan, index, remaining, running, lastTick, interval, scores }
  const RING = 2 * Math.PI * 54;

  function startSession(stageId) {
    const plan = P.buildSession(state, stageId);
    session = { plan, index: 0, remaining: plan.items[0].exercise.seconds, running: false, interval: null, scores: {} };
    const seg = $("segments");
    seg.innerHTML = "";
    for (let i = 0; i < plan.items.length; i++) seg.appendChild(el("span"));
    renderExercise();
    show("session");
    $("mic-error").hidden = true;
    $("mic-toggle").checked = false;
    $("pitch-panel").hidden = true;
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
    $("step-count").textContent = `${session.index + 1} of ${items.length}`;
    $("ex-name").textContent = exercise.name;

    const steps = $("ex-steps");
    steps.innerHTML = "";
    for (const s of exercise.steps) steps.appendChild(el("li", null, s));
    $("ex-cue").textContent = exercise.cue;
    const next = items[session.index + 1];
    $("up-next").textContent = next ? `Up next: ${next.exercise.name}` : "Last one. Then a quick check-in.";

    $("tone-toggle-wrap").hidden = !exercise.tone;
    $("prev-btn").disabled = session.index === 0;
    const last = session.index === items.length - 1;
    $("next-icon").setAttribute("href", last ? "#i-check" : "#i-next");
    $("next-btn").setAttribute("aria-label", last ? "Finish session" : "Next exercise");

    [...$("segments").children].forEach((s, i) => {
      s.className = i < session.index ? "done" : i === session.index ? "now" : "";
    });
    renderTimer();
    renderPlayButton();
    renderExerciseScore();
  }

  function renderTimer() {
    const total = current().exercise.seconds;
    $("timer-text").textContent = fmtTime(session.remaining);
    $("ring-fill").style.strokeDasharray = RING;
    $("ring-fill").style.strokeDashoffset = RING * (session.remaining / total);
  }

  function renderPlayButton() {
    $("play-icon").setAttribute("href", session.running ? "#i-pause" : "#i-play");
    $("play-btn").setAttribute("aria-label", session.running ? "Pause" : "Start");
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
      const b = el("button");
      b.type = "button";
      b.append(el("span", `dot ${key}`), f.label);
      b.addEventListener("click", () => {
        state = P.recordSession(state, {
          stage: session.plan.stage.id,
          warmupOnly: session.plan.warmupOnly,
          feeling: key,
          pitchAccuracy: session.pitchAccuracy,
        });
        saveState();
        session = null;
        selectedStage = null;
        goView("practice");
      });
      box.appendChild(b);
    }
  }

  function quitSession() {
    if (!confirm("Quit without recording this session?")) return;
    endSession();
    session = null;
    goView("practice");
  }

  // ---- Wiring ------------------------------------------------------------

  for (const b of document.querySelectorAll(".nav-item")) {
    b.addEventListener("click", () => goView(b.dataset.view));
  }
  $("start-btn").addEventListener("click", () => startSession(activeStage()));
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
  $("mic-default").addEventListener("change", (e) => {
    state.mic = e.target.checked;
    saveState();
  });
  $("stop-btn").addEventListener("click", finishSession);
  $("quit-btn").addEventListener("click", quitSession);
  $("reset-btn").addEventListener("click", () => {
    if (!confirm("Delete all progress and history?")) return;
    state = P.defaultState();
    selectedStage = null;
    saveState();
    renderSettings();
  });

  // Keyboard: Space = start/pause, arrows = previous/next, Esc = quit.
  document.addEventListener("keydown", (e) => {
    if (view !== "session" || !session || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest && e.target.closest("input")) return;
    if (e.code === "Space") {
      e.preventDefault();
      $("play-btn").click();
    } else if (e.key === "ArrowRight") {
      goTo(session.index + 1, true);
    } else if (e.key === "ArrowLeft" && session.index > 0) {
      goTo(session.index - 1, true);
    } else if (e.key === "Escape") {
      quitSession();
    }
  });

  // A focused button would also "click" on Space keyup; the handler above already did.
  document.addEventListener("keyup", (e) => {
    if (view === "session" && e.code === "Space" && !(e.target.closest && e.target.closest("input"))) e.preventDefault();
  });

  goView("practice");
})();
