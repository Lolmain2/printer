// Pitch tab: the Pitch home screen, the drill view (find your voice, explore,
// train) and the scrolling pitch lane. Pure logic lives in pitch-trainer.js.
(function () {
  const REDUCED_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SHARPS = new Set([1, 3, 6, 8, 10]);

  // ---- Pitch lane (canvas) ----------------------------------------------

  // Piano-roll lane: one row per semitone, your voice as a line scrolling
  // left, the target as a band. Colours come from the CSS tokens.
  function createLane(container, canvas, clock) {
    const PT = window.PitchTrainer;
    const Pt = window.Pitch;
    const g = canvas.getContext("2d");
    const colors = {};
    let W = 0;
    let H = 0;
    let dpr = 1;
    let grid = null;
    let raf = 0;
    const s = {
      view: { lo: 45, hi: 59 },
      target: null,
      tol: 50,
      hold: 0,
      pulse: false,
      blind: false,
      frozenAt: null,
      nearest: false,
      follow: false, // setup/Explore: scroll the view to keep the voice on screen
      farSince: null,
      points: [],
    };

    // Lowest/highest notes the lane will ever show (E1 to C6).
    const LANE_MIN = 28;
    const LANE_MAX = 84;

    // Keep the voice in view: when the head leaves the view, re-centre on it
    // (same span), so low or high notes don't disappear off the edge.
    function followHead(head) {
      if (!s.follow || !head) return;
      const m = head.midi;
      if (m >= s.view.lo + 0.5 && m <= s.view.hi - 0.5) return;
      const span = s.view.hi - s.view.lo;
      let lo = Math.round(m) - Math.floor(span / 2);
      lo = Math.max(LANE_MIN, Math.min(LANE_MAX - span, lo));
      s.view = { lo, hi: lo + span };
    }

    function readColors() {
      const cs = getComputedStyle(document.documentElement);
      for (const k of ["bg", "surface-2", "border", "text", "muted", "faint", "accent", "ok", "warn", "ok-soft", "lane-sharp"]) {
        colors[k] = cs.getPropertyValue(`--${k}`).trim();
      }
    }

    function resize() {
      // Content box: the border isn't part of the drawing surface.
      if (!container.clientWidth || !container.clientHeight) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = container.clientWidth;
      H = container.clientHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      readColors();
      grid = null;
      draw();
    }
    new ResizeObserver(resize).observe(container);

    function geo() {
      const small = window.matchMedia("(max-width: 700px)").matches;
      const gutter = small ? 34 : 44;
      const playX = gutter + (W - gutter) * 0.85;
      const history = small ? 4 : 5;
      const top = 6;
      const height = H - 12;
      const L = height / (s.view.hi - s.view.lo + 1);
      return { gutter, playX, history, pxPerSec: (playX - gutter) / history, top, height, L };
    }

    const yOf = (midi, G) => PT.laneY(midi, s.view, G.top, G.height);

    // Cents from the target, folding only near-octave copies (as pitchError).
    function centsOff(midi) {
      const raw = 100 * (midi - s.target);
      const oct = Math.round(raw / 1200);
      const folded = raw - 1200 * oct;
      return oct !== 0 && Math.abs(folded) <= 200 ? folded : raw;
    }

    function colorFor(midi) {
      if (s.target == null) return colors.text;
      const c = Math.abs(centsOff(midi));
      return c <= s.tol ? colors.ok : c <= 2 * s.tol ? colors.warn : colors.text;
    }

    function buildGrid(G) {
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const o = off.getContext("2d");
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
      o.fillStyle = colors.bg;
      o.fillRect(0, 0, W, H);
      o.lineWidth = 1;
      for (let m = s.view.lo; m <= s.view.hi; m++) {
        const { y } = yOf(m, G);
        if (SHARPS.has(((m % 12) + 12) % 12)) {
          o.fillStyle = colors["lane-sharp"];
          o.fillRect(G.gutter, y - G.L / 2, W - G.gutter, G.L);
        }
        // The line under each C marks the octave.
        const edge = Math.round(y + G.L / 2) + 0.5;
        o.strokeStyle = m % 12 === 0 ? colors.muted : colors.border;
        o.globalAlpha = m % 12 === 0 ? 0.5 : 0.7;
        o.beginPath();
        o.moveTo(G.gutter, edge);
        o.lineTo(W, edge);
        o.stroke();
        o.globalAlpha = 1;
      }
      grid = { canvas: off, w: W, h: H, lo: s.view.lo, hi: s.view.hi };
    }

    function draw() {
      if (!W || !H) return;
      const G = geo();
      if (!grid || grid.w !== W || grid.h !== H || grid.lo !== s.view.lo || grid.hi !== s.view.hi) buildGrid(G);
      g.clearRect(0, 0, W, H);
      g.drawImage(grid.canvas, 0, 0, W, H);
      const now = s.frozenAt != null ? s.frozenAt : clock() - 0.06;
      const showTrace = !s.blind || s.frozenAt != null;
      const visible = s.points.filter((p) => p.t >= now - G.history - 0.2 && p.t <= now + 0.05);
      const last = visible.length ? visible[visible.length - 1] : null;
      const head = last && last.midi != null && now - last.t < 0.2 ? last : null;
      if (showTrace && s.follow) {
        const before = s.view;
        followHead(head);
        if (s.view !== before) {
          grid = null;
          return draw(); // redraw with the new view
        }
      }

      // Soft highlight on the row you're nearest to (Explore).
      if (s.nearest && head && showTrace) {
        const { y, clip } = yOf(Math.round(head.midi), G);
        if (!clip) {
          g.fillStyle = colors["surface-2"];
          g.fillRect(G.gutter, y - G.L / 2, W - G.gutter, G.L);
        }
      }

      // Target band, with the hold progress filling it from the left.
      let band = null;
      if (s.target != null) {
        const { y } = yOf(s.target, G);
        const half = Math.max(2, (s.tol / 100) * G.L);
        band = { top: y - half, bottom: y + half };
        let alpha = 1;
        if (s.pulse && !REDUCED_MOTION) alpha = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin((performance.now() / 1000) * 4 * Math.PI));
        g.globalAlpha = alpha;
        g.fillStyle = colors["ok-soft"];
        g.fillRect(G.gutter, band.top, W - G.gutter, 2 * half);
        if (s.hold > 0) {
          g.globalAlpha = alpha * 0.35;
          g.fillStyle = colors.ok;
          g.fillRect(G.gutter, band.top, (W - G.gutter) * Math.min(1, s.hold), 2 * half);
        }
        g.globalAlpha = alpha;
        g.strokeStyle = colors.ok;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(G.gutter, Math.round(band.top) + 0.5);
        g.lineTo(W, Math.round(band.top) + 0.5);
        g.moveTo(G.gutter, Math.round(band.bottom) - 0.5);
        g.lineTo(W, Math.round(band.bottom) - 0.5);
        g.stroke();
        g.globalAlpha = 1;
      }

      // Playhead.
      g.strokeStyle = colors.border;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(G.playX) + 0.5, 0);
      g.lineTo(Math.round(G.playX) + 0.5, H);
      g.stroke();

      const xOf = (t) => G.playX - (now - t) * G.pxPerSec;

      if (showTrace) {
        g.lineWidth = 3;
        g.lineJoin = "round";
        g.lineCap = "round";
        for (const seg of PT.traceSegments(visible)) {
          if (seg.length === 1) {
            const { y } = yOf(seg[0].midi, G);
            g.fillStyle = colorFor(seg[0].midi);
            g.beginPath();
            g.arc(xOf(seg[0].t), y, 1.5, 0, 2 * Math.PI);
            g.fill();
            continue;
          }
          for (let i = 1; i < seg.length; i++) {
            const a = seg[i - 1];
            const b = seg[i];
            g.strokeStyle = colorFor(b.midi);
            g.beginPath();
            g.moveTo(xOf(a.t), yOf(a.midi, G).y);
            g.lineTo(xOf(b.t), yOf(b.midi, G).y);
            g.stroke();
          }
        }

        if (head) {
          const { y, clip } = yOf(head.midi, G);
          const x = xOf(head.t);
          const inBand = s.target != null && Math.abs(centsOff(head.midi)) <= s.tol;
          if (inBand) {
            g.fillStyle = colors["ok-soft"];
            g.beginPath();
            g.arc(x, y, 12, 0, 2 * Math.PI);
            g.fill();
          }
          g.fillStyle = colorFor(head.midi);
          g.beginPath();
          g.arc(x, y, 5, 0, 2 * Math.PI);
          g.fill();
          if (clip) drawChevron(x, clip, Pt.noteName(head.midi));
          drawTether(head, x, y, band, now, G);
        } else {
          s.farSince = null;
        }
      }

      // Fade the oldest part of the trace into the gutter.
      const fade = g.createLinearGradient(G.gutter, 0, G.gutter + 40, 0);
      fade.addColorStop(0, colors.bg);
      fade.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = fade;
      g.fillRect(G.gutter, 0, 40, H);

      drawLabels(G);
    }

    function drawLabels(G) {
      g.fillStyle = colors.bg;
      g.fillRect(0, 0, G.gutter, H);
      g.textAlign = "right";
      g.textBaseline = "middle";
      for (let m = s.view.lo; m <= s.view.hi; m++) {
        const isTarget = s.target != null && Math.round(s.target) === m;
        if (SHARPS.has(((m % 12) + 12) % 12) && !isTarget) continue;
        if (G.L < 9 && !isTarget && m % 12 !== 0) continue;
        const { y } = yOf(m, G);
        g.font = `${isTarget ? "700 " : ""}11px "Segoe UI", system-ui, sans-serif`;
        g.fillStyle = isTarget ? colors.accent : colors.faint;
        g.fillText(Pt.noteName(m), G.gutter - 6, y);
      }
    }

    function drawChevron(x, clip, label) {
      // clip > 0: above the view (top edge, pointing up); clip < 0: below.
      const y = clip > 0 ? 10 : H - 10;
      const d = clip > 0 ? -1 : 1;
      g.fillStyle = colors.text;
      g.beginPath();
      g.moveTo(x - 7, y - 4 * d);
      g.lineTo(x + 7, y - 4 * d);
      g.lineTo(x, y + 4 * d);
      g.closePath();
      g.fill();
      g.font = '600 11px "Segoe UI", system-ui, sans-serif';
      g.textAlign = "right";
      g.textBaseline = "middle";
      g.fillText(label, x - 12, y);
    }

    // After 0.8 s far from the band, point the way with a dashed arrow.
    function drawTether(head, x, y, band, now, G) {
      if (!band || s.blind) {
        s.farSince = null;
        return;
      }
      const c = centsOff(head.midi);
      if (Math.abs(c) <= 2 * s.tol) {
        s.farSince = null;
        return;
      }
      if (s.farSince == null) s.farSince = now;
      if (now - s.farSince < 0.8) return;
      const yHead = Math.max(4, Math.min(H - 4, y));
      // Aim at the pitch the folded cents refer to (it can be an octave copy).
      const half = (band.bottom - band.top) / 2;
      const gy = Math.max(half, Math.min(H - half, yOf(head.midi - c / 100, G).y));
      const yEdge = c < 0 ? gy + half : gy - half;
      const dir = yEdge < yHead ? -1 : 1;
      g.strokeStyle = colors.text;
      g.lineWidth = 1.5;
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(x, yHead);
      g.lineTo(x, yEdge - 6 * dir);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = colors.text;
      g.beginPath();
      g.moveTo(x - 5, yEdge - 8 * dir);
      g.lineTo(x + 5, yEdge - 8 * dir);
      g.lineTo(x, yEdge - 1 * dir);
      g.closePath();
      g.fill();
      const semis = Math.max(1, Math.round(Math.abs(c) / 100));
      g.font = '600 12px "Segoe UI", system-ui, sans-serif';
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(`${c < 0 ? "+" : "−"}${semis}`, x + 9, (yHead + yEdge) / 2);
    }

    function loop() {
      draw();
      raf = requestAnimationFrame(loop);
    }

    return {
      get target() {
        return s.target;
      },
      start() {
        if (!raf) raf = requestAnimationFrame(loop);
      },
      stop() {
        cancelAnimationFrame(raf);
        raf = 0;
      },
      setView(view) {
        s.view = view;
      },
      setTarget(midi, tol = 50) {
        s.target = midi;
        s.tol = tol;
        s.hold = 0;
        s.farSince = null;
      },
      setHold(frac) {
        s.hold = frac;
      },
      setPulse(on) {
        s.pulse = on;
      },
      setBlind(on) {
        s.blind = on;
      },
      setNearest(on) {
        s.nearest = on;
      },
      setFollow(on) {
        s.follow = on;
      },
      freeze(t) {
        s.frozenAt = t;
      },
      unfreeze() {
        s.frozenAt = null;
      },
      clear() {
        s.points = [];
        s.frozenAt = null;
        s.farSince = null;
      },
      push(t, midi) {
        s.points.push({ t, midi });
        const cutoff = t - 6;
        if (s.points.length > 200 || (s.points[0] && s.points[0].t < cutoff)) {
          s.points = s.points.filter((p) => p.t >= cutoff);
        }
      },
    };
  }

  // ---- Controller -------------------------------------------------------

  function create(deps) {
    const { $, el, icon, show, goView, getState, setPitch, setRange, renderAdvice, safetyAdvice, deviceSummary, micErrorText, RANGES } =
      deps;
    const { Tones, Mic, Recorder } = window.Sound;
    const PT = window.PitchTrainer;
    const Pt = window.Pitch;
    const T = PT.TIMING;
    const rng = PT.mulberry32(Date.now() >>> 0);

    const ps = () => getState().pitch;
    const nameOf = (m) => Pt.noteName(m);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const plural = (n, word) => `${n} ${n === 1 ? word : word === "try" ? "tries" : `${word}s`}`;
    const centsWord = (c) => (Math.abs(c) <= 10 ? "dead on" : `${Math.abs(Math.round(c))}¢ ${c < 0 ? "flat" : "sharp"}`);
    const stageDef = (id) => PT.TRAIN_STAGES.find((st) => st.id === id);
    const clock = () => (Tones.ctx ? Tones.ctx.currentTime : 0);
    const homeMidi = () => ps().profile.homeMidi;
    const baseCenter = () => RANGES[getState().range].baseMidi + 4;
    const timbre = () => PT.timbreFor(homeMidi() != null ? homeMidi() : baseCenter(), ps().settings.timbre);

    const lane = createLane($("d-lane"), $("d-canvas"), clock);

    let selectedStage = null; // null = recommended
    let mode = null; // "setup" | "explore" | "train"
    let runId = 0;
    let active = null; // { resolve } for whatever is consuming mic frames
    let frameHandler = null;
    let feedTrace = false;
    let gateUntil = 0;
    let lastFrameT = null;
    let voicedPending = 0;
    let set = null;
    let bank = []; // recent clips of the user's own voice, in memory only
    let hintAt = 0;
    let hintKey = null;
    let toastTimer = null;
    let fallbackNoticeShown = false;
    let lockTipShown = false;
    let dipTipShown = false;
    let fatigueShown = {}; // { "YYYY-MM-DD:break": true }

    // ---- Run control ------------------------------------------------------

    function newRun() {
      runId++;
      if (active) active.resolve(null);
      active = null;
      frameHandler = null;
      return runId;
    }

    async function until(t, id) {
      while (id === runId && clock() < t) await sleep(25);
      return id === runId;
    }

    async function wait(ms, id) {
      await sleep(ms);
      return id === runId;
    }

    // Feed mic frames to `fn` until it returns something other than
    // undefined. Resolves null if the run is cancelled.
    function collect(fn) {
      return new Promise((resolve) => {
        const a = {
          resolve(v) {
            if (active === a) {
              active = null;
              frameHandler = null;
            }
            resolve(v);
          },
        };
        active = a;
        frameHandler = (f) => {
          const v = fn(f);
          if (v !== undefined) a.resolve(v);
        };
      });
    }

    // Run a trial on mic frames until it finishes.
    function runTrial(trial, onStep) {
      const holder = { trial };
      const promise = collect((f) => {
        holder.trial = PT.stepTrial(holder.trial, f);
        if (onStep) onStep(holder.trial, f);
        if (holder.trial.status !== "running") return holder.trial.result;
        return undefined;
      });
      return { holder, promise };
    }

    function onFrame(f) {
      // While a reference plays, whatever the mic hears isn't the user.
      const userTurn = feedTrace && f.t >= gateUntil;
      if (userTurn && lastFrameT != null && f.freq != null) voicedPending += Math.min(0.1, Math.max(0, f.t - lastFrameT));
      lastFrameT = f.t;
      if (userTurn) lane.push(f.t, f.freq ? Pt.freqToMidi(f.freq) : null);
      renderReadout(userTurn ? f : { ...f, freq: null });
      if (frameHandler) frameHandler(f);
    }

    function flushVoiced() {
      if (voicedPending > 0) setPitch(PT.addVoicedTime(ps(), voicedPending, new Date()));
      voicedPending = 0;
    }

    // Opens the mic for run `id`. Returns null when listening, an error
    // message, or STALE if the user left (or started over) while the
    // permission prompt was up; then nothing may be touched, since the mic
    // may already belong to a guided session.
    const STALE = "stale";
    async function openMic(id) {
      Tones.ensureCtx();
      let opened;
      try {
        opened = await Mic.open({ echoCancellation: false });
      } catch (e) {
        if (id !== runId) return STALE;
        Mic.close();
        return micErrorText(e);
      }
      if (!opened || id !== runId) return STALE;
      Mic.subscribe(onFrame);
      lastFrameT = null;
      return null;
    }

    // Reopen the mic (from a click) and then continue, e.g. after a summary.
    async function resumeWith(fn) {
      Tones.ensureCtx();
      const id = runId;
      const err = await openMic(id);
      if (err === STALE) return;
      if (err) {
        goView("pitch");
        showHomeError(err);
        return;
      }
      fn();
    }

    // ---- Drill chrome -----------------------------------------------------

    function setInstruction(text) {
      $("d-instruction").textContent = text;
    }

    function setHeader(label, count) {
      $("d-label").textContent = label;
      $("d-count").textContent = count || "";
    }

    function setHold(frac) {
      const bar = $("d-hold");
      bar.firstElementChild.style.width = `${Math.round(100 * Math.min(1, Math.max(0, frac)))}%`;
      lane.setHold(frac);
    }

    function renderDots() {
      const box = $("d-dots");
      box.innerHTML = "";
      if (!set) return;
      for (let i = 0; i < PT.SET_SIZE; i++) {
        const d = set.dots[i];
        const span = el("span", d ? `${d.cls}${d.blind ? " blind" : ""}` : i === set.dots.length ? "now" : "");
        box.appendChild(span);
      }
    }

    function panel() {
      return $("d-panel");
    }

    function clearPanel() {
      panel().innerHTML = "";
    }

    function button(label, cls, onClick) {
      const b = el("button", `btn ${cls || ""}`.trim(), label);
      b.type = "button";
      b.addEventListener("click", onClick);
      return b;
    }

    function toast(text) {
      const t = $("d-toast");
      t.textContent = text;
      t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (t.hidden = true), 3500);
    }

    function showControls({ again = false, range = null, skip = false, pause = false } = {}) {
      $("d-again").hidden = !again;
      $("d-range").hidden = !range;
      if (range) $("d-range").textContent = range === "high" ? "Too high?" : "Too low?";
      $("d-range").dataset.dir = range || "";
      $("d-skip").hidden = !skip;
      $("d-pause").hidden = !pause;
      $("d-controls").hidden = !(again || range || skip || pause);
    }

    function setReadoutTarget(midi) {
      $("d-target").textContent = midi == null ? "–" : nameOf(midi);
    }

    let hideYou = false;
    function renderReadout(f) {
      if (hideYou) {
        $("d-you").textContent = "–";
        $("d-you-cents").textContent = "";
        return;
      }
      if (!f.freq) {
        $("d-you").textContent = "–";
        $("d-you-cents").textContent = "";
        return;
      }
      const midi = Pt.freqToMidi(f.freq);
      $("d-you").textContent = nameOf(midi);
      const target = lane.target;
      if (target != null) {
        const c = Math.round(Pt.pitchError(f.freq, target).cents);
        $("d-you-cents").textContent = Math.abs(c) <= 150 ? `${c > 0 ? "+" : c < 0 ? "−" : ""}${Math.abs(c)}¢` : "";
      } else {
        $("d-you-cents").textContent = "";
      }
      if (mode === "explore") renderExploreNote(midi);
      if (mode === "setup") $("d-level").firstElementChild.style.width = `${Math.round(100 * Math.min(1, f.rms / 0.1))}%`;
    }

    function enterDrill() {
      show("drill");
      $("d-summary").hidden = true;
      $("d-body").hidden = false;
      $("d-overlay").hidden = true;
      $("d-toast").hidden = true;
      $("d-level").hidden = true;
      $("d-hold").hidden = true;
      $("d-dots").innerHTML = "";
      hideYou = false;
      setReadoutTarget(null);
      clearPanel();
      showControls();
      lane.setTarget(null);
      lane.setBlind(false);
      lane.setNearest(false);
      lane.setFollow(false);
      lane.setPulse(false);
      lane.clear();
      if (!document.hidden) lane.start();
    }

    function viewAround(center, below, above) {
      let lo = Math.round(center) - below;
      let hi = Math.round(center) + above;
      if (lo < 28) {
        hi += 28 - lo;
        lo = 28;
      }
      if (hi > 84) {
        lo -= hi - 84;
        hi = 84;
      }
      return { lo, hi };
    }

    // ---- Safety & starting ------------------------------------------------

    function okToStart() {
      const adv = safetyAdvice();
      if (adv.some((a) => a.level === "rest" || a.level === "doctor")) {
        return confirm("Your last check-in reported pain. Resting is the safest choice. Do gentle pitch practice anyway?");
      }
      return true;
    }

    // Must be called from a click: creates the audio context before any await.
    async function begin(kind, stageId) {
      Tones.ensureCtx();
      if (!okToStart()) return;
      if ((kind === "setup" || kind === "explore") && !ps().settings.introSeen) {
        showIntro(kind);
        return;
      }
      enterDrill();
      const id = newRun();
      setInstruction("Opening the microphone…");
      const err = await openMic(id);
      if (err === STALE) return;
      if (err) {
        goView("pitch");
        showHomeError(err);
        return;
      }
      if (Tones.ctx.state === "suspended") {
        showOverlay("Tap to start listening", () => startMode(kind, stageId));
        return;
      }
      startMode(kind, stageId);
    }

    function startMode(kind, stageId) {
      if (kind === "setup") runSetup();
      else if (kind === "explore") runExplore();
      else startSet(stageId);
    }

    function showIntro(kind) {
      enterDrill();
      const id = newRun();
      mode = null;
      setHeader(kind === "explore" ? "Explore" : "Find your voice");
      setInstruction("Before you start");
      const card = el("div", "intro-card");
      for (const [title, text] of INTRO_ROWS) {
        const row = el("div", "intro-row");
        row.append(el("strong", null, title), el("p", null, text));
        card.appendChild(row);
      }
      const go = button("Allow mic and start", "btn-primary btn-lg", async () => {
        Tones.ensureCtx();
        setPitch({ ...ps(), settings: { ...ps().settings, introSeen: true } });
        go.disabled = true;
        const err = await openMic(id);
        if (err === STALE) return;
        if (err) {
          go.disabled = false;
          const p = card.querySelector(".mic-error") || card.appendChild(el("p", "mic-error"));
          p.textContent = err;
          return;
        }
        clearPanel();
        startMode(kind);
      });
      card.appendChild(go);
      panel().appendChild(card);
    }

    function showOverlay(label, onResume) {
      const id = runId;
      const o = $("d-overlay");
      o.innerHTML = "";
      const b = button(label, "btn-primary btn-lg", async () => {
        Tones.ensureCtx();
        b.disabled = true;
        const err = await openMic(id);
        if (err === STALE) return;
        if (err) {
          b.disabled = false;
          (o.querySelector(".mic-error") || o.appendChild(el("p", "mic-error"))).textContent = err;
          return;
        }
        if (Tones.ctx.state === "suspended") await Tones.ctx.resume();
        if (id !== runId) return;
        o.hidden = true;
        if (!document.hidden) lane.start();
        onResume();
      });
      o.append(b, button("Exit", "", () => goView("pitch")));
      o.hidden = false;
    }

    // ---- Find your voice --------------------------------------------------

    async function runSetup() {
      const id = newRun();
      mode = "setup";
      lane.setNearest(false);
      if (exploreState) clearTimeout(exploreState.ideaTimer);
      exploreState = null;
      const center = baseCenter();
      lane.setView(viewAround(center, 7, 7));
      lane.setFollow(true);
      lane.setTarget(null);
      lane.clear();
      feedTrace = true;
      gateUntil = 0;
      clearPanel();
      showControls();
      const chips = el("div", "capture-chips");
      panel().appendChild(chips);
      const msg = el("p", "panel-note");
      panel().appendChild(msg);

      // 1. Mic check
      setHeader("Find your voice", "Step 1 of 4");
      setInstruction("Hum 'mmm' at any easy pitch.");
      $("d-level").hidden = false;
      let voiced = 0;
      let passedAt = null;
      let unclear = 0;
      let last = null;
      const ok = await collect((f) => {
        const dt = last == null ? PT.FRAME_SEC : Math.min(0.1, Math.max(0, f.t - last));
        last = f.t;
        if (f.freq) {
          voiced += dt;
          unclear = 0;
        } else {
          unclear = f.rms >= 0.02 ? unclear + dt : 0;
        }
        msg.textContent = unclear >= 1 ? UNCLEAR_TEXT : "";
        if (voiced >= 0.5 && passedAt == null) {
          passedAt = f.t;
          setInstruction("Got it ✓");
        }
        if (passedAt != null && f.t - passedAt >= 0.8) return true;
        return undefined;
      });
      if (!ok || id !== runId) return;
      $("d-level").hidden = true;
      msg.textContent = "";

      // 2. Speaking voice
      setHeader("Find your voice", "Step 2 of 4");
      setInstruction("Count down from 10 to 1 out loud, in your normal speaking voice.");
      const speechFrames = await captureFrames((first, f, start) => (first != null && f.t - first >= 6) || f.t - start >= 10);
      if (!speechFrames || id !== runId) return;
      const speech = PT.captureMedian(speechFrames);
      if (speech != null) chips.appendChild(el("span", "chip-note", `Speaking voice ≈ ${nameOf(speech)}`));

      // 3. Comfortable note, 2–4 times
      setHeader("Find your voice", "Step 3 of 4");
      const hums = [];
      let attempted = 0;
      let fails = 0;
      let skipBtn = null;
      while (PT.needMoreHums(hums, attempted)) {
        setInstruction(
          hums.length
            ? "Good. Once more: a comfortable 'oo', held for 2 seconds."
            : "Sing a comfortable 'oo' (not high, not low) and hold it for 2 seconds.",
        );
        let voicedSec = 0;
        let lastT = null;
        const fr = await captureFrames((first, f, start) => {
          const dt = lastT == null ? PT.FRAME_SEC : Math.min(0.1, Math.max(0, f.t - lastT));
          lastT = f.t;
          if (f.freq) voicedSec += dt;
          return voicedSec >= 2.0 || f.t - start >= 8;
        });
        if (fr === "skip") break;
        if (!fr || id !== runId) return;
        const m = PT.captureMedian(fr);
        if (m == null) {
          fails++;
          msg.textContent = "Didn't catch that. Try a bit louder, like a relaxed 'oo'.";
          if (fails >= 3 && !skipBtn) {
            skipBtn = button("Skip this step", "", () => active && active.resolve("skip"));
            panel().appendChild(skipBtn);
          }
          if (!(await wait(900, id))) return;
          continue;
        }
        msg.textContent = "";
        hums.push(m);
        attempted++;
        chips.appendChild(el("span", "chip-note", `'oo' ≈ ${nameOf(m)}`));
        if (!(await wait(500, id))) return;
      }
      if (skipBtn) skipBtn.remove();

      // 4. Summary. Nothing to listen to here, so the mic closes.
      const home = PT.homeFromCaptures([speech, ...hums]);
      setHeader("Find your voice", "Step 4 of 4");
      feedTrace = false;
      mode = "setup-done";
      Mic.close();
      flushVoiced();
      $("d-you").textContent = "–";
      $("d-you-cents").textContent = "";
      if (home.homeMidi == null) {
        setInstruction("I couldn't find a steady note this time.");
        msg.textContent = "Try somewhere quieter, a little closer to the mic, with a relaxed 'oo'.";
        panel().append(
          button("Try again", "btn-primary", () => resumeWith(() => runSetup())),
          button("Done", "", () => goView("pitch")),
        );
        return;
      }
      setPitch(PT.setHome(ps(), home.homeMidi, { captures: [speech, ...hums], now: new Date() }));
      lane.setTarget(home.homeMidi, 50);
      setReadoutTarget(home.homeMidi);
      setInstruction(`Your home note: ${nameOf(home.homeMidi)}. Your training notes start here and spread out as you improve.`);
      msg.textContent = home.confident ? "" : "Your hums varied a lot. That's fine; you can re-measure any time.";
      const suggested = PT.suggestRange(home.homeMidi, RANGES);
      if (suggested !== getState().range) {
        const p = el("p", "panel-note");
        p.append(
          `Guided-session reference tones are set to ${rangeName(getState().range)}. ${rangeName(suggested)} fits your voice better. `,
        );
        const use = button(`Use ${rangeName(suggested)}`, "btn-small", () => {
          setRange(suggested);
          p.textContent = `Guided sessions now use ${rangeName(suggested)}.`;
        });
        p.appendChild(use);
        panel().appendChild(p);
      }
      const actions = el("div", "panel-actions");
      actions.append(
        button("Start training", "btn-primary", () =>
          resumeWith(() => startSet(PT.recommendedStage(ps()) === "setup" ? 1 : PT.recommendedStage(ps()))),
        ),
        button("Done", "", () => goView("pitch")),
      );
      panel().appendChild(actions);
    }

    // Collect frames until `done(firstVoicedT, frame, startT)` is true.
    function captureFrames(done) {
      const frames = [];
      let first = null;
      let start = null;
      return collect((f) => {
        if (start == null) start = f.t;
        frames.push({ t: f.t, freq: f.freq, rms: f.rms });
        if (f.freq && first == null) first = f.t;
        return done(first, f, start) ? frames : undefined;
      });
    }

    function rangeName(key) {
      return { low: "Low", mid: "Mid", high: "High" }[key] || key;
    }

    // ---- Explore ----------------------------------------------------------

    let exploreState = null;

    function runExplore() {
      const id = newRun();
      mode = "explore";
      const c = homeMidi() != null ? homeMidi() : baseCenter();
      lane.setView(viewAround(c, 7, 12));
      lane.setFollow(true);
      lane.setTarget(null);
      lane.setNearest(true);
      lane.clear();
      feedTrace = true;
      gateUntil = 0;
      setHeader("Explore", "");
      setInstruction("Make any sound you like and watch your voice move the line.");
      showControls();
      clearPanel();

      const big = el("div", "explore-note");
      const note = el("span", "explore-name", "–");
      const cents = el("span", "explore-cents", "");
      const steady = el("span", "chip-ok", "Steady ✓");
      steady.hidden = true;
      big.append(note, cents, steady);
      const idea = el("div", "idea-card");
      const ideaText = el("p");
      idea.append(ideaText, button("Next idea", "btn-small", () => nextIdea()));
      const ready = el("div", "panel-note");
      ready.hidden = true;
      ready.append(
        "Nice. Ready to try matching notes? ",
        button("Start training", "btn-small btn-primary", () => {
          Tones.ensureCtx();
          if (homeMidi() == null) runSetup();
          else startSet(selectedOrRecommended());
        }),
      );
      panel().append(big, idea, ready);

      exploreState = { note, cents, steady, ready, ideaText, ideaIndex: -1, ideaTimer: null, voiced: 0, recent: [], lastT: null };
      const nextIdea = () => {
        const st = exploreState;
        if (!st || id !== runId) return;
        st.ideaIndex = (st.ideaIndex + 1) % EXPLORE_IDEAS.length;
        st.ideaText.textContent = EXPLORE_IDEAS[st.ideaIndex];
        clearTimeout(st.ideaTimer);
        st.ideaTimer = setTimeout(nextIdea, 20000);
      };
      nextIdea();

      collect((f) => {
        const st = exploreState;
        const dt = st.lastT == null ? PT.FRAME_SEC : Math.min(0.1, Math.max(0, f.t - st.lastT));
        st.lastT = f.t;
        if (f.freq) {
          st.voiced += dt;
          st.recent.push({ t: f.t, c: 100 * Pt.freqToMidi(f.freq) });
        } else {
          st.recent.push({ t: f.t, c: null });
        }
        st.recent = st.recent.filter((r) => r.t >= f.t - 1);
        const voicedC = st.recent.filter((r) => r.c != null).map((r) => r.c);
        const sd = PT.steadiness(voicedC);
        st.steady.hidden = !(f.freq && sd != null && sd <= 20);
        if (!f.freq) {
          st.note.textContent = "–";
          st.cents.textContent = "";
        }
        if (st.voiced >= 60) st.ready.hidden = false;
        return undefined;
      });
    }

    function renderExploreNote(midi) {
      const st = exploreState;
      if (!st) return;
      const nearest = Math.round(midi);
      const c = Math.round(100 * (midi - nearest));
      st.note.textContent = nameOf(nearest);
      st.cents.textContent = `${c > 0 ? "+" : c < 0 ? "−" : "±"}${Math.abs(c)}¢`;
    }

    // ---- Train ------------------------------------------------------------

    function selectedOrRecommended() {
      const rec = PT.recommendedStage(ps());
      if (rec === "setup") return 1;
      if (selectedStage && PT.stageStatus(ps(), selectedStage).unlocked) return selectedStage;
      return rec;
    }

    function startSet(stageId) {
      set = {
        stageId,
        dots: [],
        counted: 0,
        missRun: 0,
        prevTarget: null,
        lastOutcome: null,
        lastGrade: null,
        lastRetry: false,
        blindOwed: false,
        autoNext: true,
        results: [],
        monotoneShown: false,
        passedBefore: ps().stages[String(stageId)].passed,
        changes: [],
        prevClip: null,
        lockBefore: PT.weekSummary(ps(), new Date()).lockAvg,
      };
      continueSet();
    }

    async function continueSet() {
      const id = newRun();
      mode = "train";
      exploreState = null;
      const stage = stageDef(set.stageId);
      $("d-summary").hidden = true;
      $("d-body").hidden = false;
      lane.setNearest(false);
      lane.setFollow(false); // training keeps a fixed view around the targets
      const home = homeMidi();
      if (set.stageId === 1) {
        lane.setView(viewAround(home, 7, 7));
      } else {
        const pool = PT.targetPool(ps(), set.stageId);
        lane.setView(PT.viewForPool([...pool, home]));
      }
      $("d-pause").textContent = set.autoNext ? "Pause auto-next" : "Resume auto-next";
      while (id === runId && set.counted < PT.SET_SIZE) {
        setHeader(`Stage ${stage.id} · ${stage.name}`, `Try ${set.counted + 1} of ${PT.SET_SIZE}`);
        renderDots();
        const t = set.stageId === 1 ? await echoTrial(id) : await matchTrial(id);
        if (!t || id !== runId) return;
        if (!(await afterTrial(id, t))) return;
      }
      if (id === runId) showSummary();
    }

    function singText(stageId, blind) {
      if (blind) return "Blind try: no line this time. Trust your ear.";
      const base = "Your turn: sing 'oo'";
      if (stageId === 4) return `${base}, straight onto the note.`;
      return `${base}. Slide until the line sits in the green band, then hold.`;
    }

    // Shared singing phase for Stages 1–4: runs the trial on mic frames.
    async function singPhase(id, { spec, target, t0, blind, replay }) {
      gateUntil = t0;
      feedTrace = true;
      hideYou = blind;
      lane.setBlind(blind);
      $("d-hold").hidden = blind;
      setHold(0);
      hintKey = null;
      hintAt = 0;
      const { holder, promise } = runTrial(PT.createTrial({ kind: "match", spec, target, t0 }), (tr, f) => {
        if (!blind) setHold(tr.hold / spec.holdSec);
        if (blind) return;
        const h = PT.coachHint(tr, f.t);
        if (!h) return;
        const nowMs = performance.now();
        if (h.text !== hintKey && (h.key === "on" || h.key === "octave" || nowMs - hintAt >= 700)) {
          hintKey = h.text;
          hintAt = nowMs;
          setInstruction(h.text);
        }
      });
      const singLine = singText(set.stageId, blind);
      setInstruction(singLine);
      replayFn = () => {
        if (clock() < gateUntil) return; // the last replay is still playing
        const r = replay();
        if (!r) return;
        gateUntil = r.end + T.replayTailSec;
        holder.trial = PT.replayTrial(holder.trial, gateUntil);
        setHold(0);
        lane.setPulse(true);
        setInstruction("Listen…");
        setTimeout(() => {
          if (id !== runId) return;
          lane.setPulse(false);
          hintKey = null;
          setInstruction(singLine);
        }, Math.max(0, (gateUntil - clock()) * 1000));
      };
      showControls({ again: true, range: rangeButtonFor(target), skip: true, pause: true });
      const result = await promise;
      replayFn = null;
      hideYou = false;
      return result;
    }

    let replayFn = null;

    // "Too high?" / "Too low?" only appears when pressing it would really
    // take the note out of practice (notes right next to home always stay).
    function rangeButtonFor(target) {
      const home = homeMidi();
      if (set.stageId === 1 || home == null || Math.round(target) === home) return null;
      const dir = target > home ? "high" : "low";
      const narrowed = { ...ps(), profile: PT.adjustRange(ps().profile, target, dir) };
      return PT.targetPool(narrowed, set.stageId).includes(Math.round(target)) ? null : dir;
    }

    async function listen(id, play, label) {
      lane.setPulse(true);
      setInstruction(label || "Listen…");
      const r = play();
      if (!(await until(r.end, id))) return null;
      lane.setPulse(false);
      setInstruction("Hear it in your head…");
      const t0 = r.end + T.imagineSec;
      if (!(await until(t0, id))) return null;
      return t0;
    }

    async function matchTrial(id) {
      const P0 = ps();
      const plan = PT.nextTrialPlan(P0, set.stageId, {
        prevTarget: set.prevTarget,
        lastOutcome: set.lastOutcome,
        lastGrade: set.lastGrade,
        missRun: set.missRun,
        lastRetry: set.lastRetry,
        setIndex: set.counted,
        rng,
      });
      const spec = PT.trialSpec(P0, set.stageId, { rescue: plan.rescue });
      const target = plan.target;
      // A retry or rescue can land on a blind slot; owe that blind try to the
      // next fresh note so blind tries still happen.
      let blind = plan.blind;
      if (plan.retry || plan.rescue) {
        if (PT.isBlind(P0, set.stageId, set.counted)) set.blindOwed = true;
      } else if (set.blindOwed) {
        blind = true;
        set.blindOwed = false;
      }
      feedTrace = false;
      lane.clear();
      lane.setBlind(blind);
      lane.setTarget(target, spec.tol);
      setReadoutTarget(target);
      clearPanel();
      showControls();
      $("d-hold").hidden = blind;
      setHold(0);
      const play = () => Tones.note(Pt.midiToFreq(target), { dur: spec.refSec, timbre: timbre() });
      const t0 = await listen(id, play, plan.rescue ? "Easy one: your home note. Listen…" : "Listen…");
      if (t0 == null) return null;
      const result = await singPhase(id, { spec, target, t0, blind, replay: play });
      if (!result) return null;
      return { result, target, counted: !plan.rescue, blind, rescue: plan.rescue, retry: plan.retry, spec };
    }

    // Stage 1: hum any note, hear your own recording, sing it back.
    async function echoTrial(id) {
      const spec = PT.trialSpec(ps(), 1, { rescue: false });
      let lockMidi = null;
      for (;;) {
        clearPanel();
        lane.clear();
        lane.setBlind(false);
        lane.setTarget(null);
        setReadoutTarget(null);
        feedTrace = true;
        gateUntil = 0;
        $("d-hold").hidden = false;
        setHold(0);
        showControls({ skip: false });
        setInstruction(
          `Hum or sing 'oo' on any easy note, and hold it.${set.counted >= 2 ? " Try a different note than last time." : ""}`,
        );
        let recording = false;
        if (Recorder.supported() && Mic.stream) {
          try {
            Recorder.start(Mic.stream);
            recording = true;
          } catch (e) {
            recording = false;
          }
        }
        let lockedAt = null;
        const { promise } = runTrial(PT.createTrial({ kind: "capture", spec: PT.CAPTURE, t0: clock() }), (tr, f) => {
          // The capture can let go of a note and lock onto a new one.
          if (tr.target == null && lockedAt != null) {
            lockedAt = null;
            lane.setTarget(null);
            setReadoutTarget(null);
          } else if (tr.target != null && lockedAt !== tr.lockT) {
            lockedAt = tr.lockT;
            lane.setTarget(tr.target, PT.CAPTURE.tol);
            setReadoutTarget(tr.target);
            setInstruction(`That's ${nameOf(tr.target)}. Stay with it…`);
          }
          setHold(tr.hold / PT.CAPTURE.holdSec);
          const h = PT.coachHint(tr, f.t);
          if (h && (h.key === "unclear" || h.key === "quiet" || h.key === "steady")) setInstruction(h.text);
        });
        const res = await promise;
        if (!res || id !== runId) {
          Recorder.cancel();
          return null;
        }
        if (res.outcome === "hit") {
          lockMidi = res.target;
          if (recording) {
            setInstruction(`That was ${nameOf(lockMidi)}. Now listen to yourself…`);
            const buf = await Promise.race([Recorder.stop(), sleep(2000).then(() => null)]);
            if (id !== runId) return null;
            const clip = buf ? makeClip(buf, lockMidi) : null;
            if (clip) bank = [...bank.slice(-3), clip];
            return echoPart(id, lockMidi, clip, spec, true);
          }
          return echoPart(id, lockMidi, null, spec, false);
        }
        Recorder.cancel();
        setInstruction(
          res.outcome === "silent" ? "I couldn't hear you. Check the mic or hum a little louder." : "A bit wobbly. Try a quieter, easier note.",
        );
        if (!(await wait(1500, id))) return null;
      }
    }

    async function echoPart(id, lockMidi, clip, spec, recorded) {
      feedTrace = false;
      // Once the basics work, sometimes echo an earlier clip at a different note.
      let target = clip;
      const hits = ps().stages["1"].window.filter((v) => v === 1).length;
      if (hits >= 2) {
        const alt = [...bank].reverse().find((b) => {
          const d = Math.abs(b.midi - lockMidi);
          return d >= 2 && d <= 7 && b !== set.prevClip;
        });
        if (alt) target = alt;
      }
      if (!target && (!fallbackNoticeShown || recorded)) {
        fallbackNoticeShown = true;
        const sound = timbre() === "plain" ? "a plain tone" : "a voice-like tone";
        toast(`${recorded ? "Couldn't get a clean clip this time" : "Couldn't record on this device"}. Using ${sound} instead.`);
      }
      set.prevClip = target;
      const targetMidi = target ? target.midi : lockMidi;
      const play = target
        ? () => Tones.playBuffer(target.buffer)
        : () => Tones.note(Pt.midiToFreq(lockMidi), { dur: 1.5, timbre: timbre() });
      if (!(await wait(600, id))) return null;
      lane.clear();
      lane.setTarget(targetMidi, spec.tol);
      setReadoutTarget(targetMidi);
      setHold(0);
      const t0 = await listen(id, play, target ? "Listen to yourself…" : "Listen…");
      if (t0 == null) return null;
      const result = await singPhase(id, { spec, target: targetMidi, t0, blind: false, replay: play });
      if (!result) return null;
      return { result, target: targetMidi, counted: true, blind: false, rescue: false, spec };
    }

    function makeClip(buf, midi) {
      const data = buf.getChannelData(0);
      // Same window as live input, so clips of low notes are found too.
      const c = Pt.pickClip(data, buf.sampleRate, midi, { frame: Pt.frameSizeFor(buf.sampleRate) });
      if (!c) return null;
      const gain = Pt.clipGain(data, c.start, c.end);
      const out = Tones.ctx.createBuffer(1, c.end - c.start, buf.sampleRate);
      const ch = out.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = data[c.start + i] * gain;
      return { buffer: out, midi: c.midi };
    }

    // Record the result, show feedback, and pause before the next try.
    // Returns false if the run was cancelled.
    async function afterTrial(id, t) {
      const { result, target, counted, blind, rescue } = t;
      feedTrace = false;
      showControls();
      // One rescue per miss streak: whatever happens on it, carry on normally.
      if (rescue) set.missRun = 0;
      if (result.skipped) {
        Tones.stop(); // a "Hear it again" may still be playing
        // A skipped note shouldn't come straight back as a "retry".
        set.lastOutcome = null;
        set.lastGrade = null;
        set.lastRetry = false;
        set.prevTarget = target;
        if (result.range) {
          const profile = PT.adjustRange(ps().profile, target, result.range);
          setPitch({ ...ps(), profile });
          toast(`Got it. No more notes that ${result.range === "high" ? "high" : "low"} for now. Re-measure any time to reset.`);
        }
        return wait(300, id);
      }

      const before = ps();
      const out = PT.recordTrial(before, set.stageId, result, { now: new Date(), counted, blind });
      setPitch(out.ps);
      flushVoiced();
      if (out.change) set.changes.push(out.change);

      const silent = result.outcome === "silent";
      if (counted && !silent) {
        const cls = result.outcome === "hit" ? (set.stageId === 4 && result.grade === "found" ? "close" : "hit") : result.outcome === "close" ? "close" : "miss";
        set.dots.push({ cls, blind });
        set.counted++;
        set.results.push(result);
      }
      if (!rescue) {
        if (result.outcome === "miss") set.missRun++;
        else if (!silent) set.missRun = 0;
      }
      if (!silent) {
        set.prevTarget = target;
        set.lastOutcome = rescue ? null : result.outcome; // never retry the rescue note
        set.lastGrade = result.grade || null;
        set.lastRetry = Boolean(t.retry);
      }
      renderDots();

      // Blind tries: reveal the frozen trace with the verdict.
      if (blind) {
        lane.setBlind(false);
        const last = result.frames && result.frames.length ? result.frames[result.frames.length - 1].t : clock();
        lane.freeze(last + 0.06);
      }
      setHold(result.outcome === "hit" ? 1 : 0);
      const card = renderResult(result, target, t.spec.tol);
      clearPanel();
      panel().appendChild(card.node);
      setInstruction(`${card.title}. ${card.detail}`);

      const mono = PT.detectMonotone(ps().recent);
      if (mono.monotone && !set.monotoneShown) {
        set.monotoneShown = true;
        const p = el("div", "panel-note");
        p.textContent = `You're landing on about the same note each time (around ${nameOf(mono.aroundMidi)}). That's really common when you're starting out. Start on your own note, then slide slowly toward the green band.`;
        panel().appendChild(p);
      }

      if (result.outcome === "miss" && result.sungMidi != null) {
        if (!(await wait(400, id))) return false;
        await hearTheGap(id, result.sungMidi, target, card, result.octaveSlip);
        if (!(await wait(1000, id))) return false;
      } else if (set.autoNext) {
        if (!(await wait(1500, id))) return false;
      }
      if (!set.autoNext && id === runId) {
        setInstruction(`${card.title}. Ready when you are.`);
        const next = button("Next try", "btn-primary", () => active && active.resolve(true));
        panel().appendChild(next);
        const r = await collect(() => undefined);
        if (!r) return false;
      }
      return id === runId;
    }

    async function hearTheGap(id, sungMidi, target, card, slipped) {
      const sung = Math.round(sungMidi);
      // If the singer was near another octave of the note, compare with that one.
      if (slipped) {
        target += 12 * Math.round((sungMidi - target) / 12);
        card.note.textContent = `Note: ${nameOf(target)}`;
      }
      setInstruction("Listen: your note, then the target…");
      const a = Tones.note(Pt.midiToFreq(sung), { dur: T.gapNoteSec, timbre: timbre() });
      card.you.classList.add("lit");
      if (!(await until(a.end, id))) return;
      card.you.classList.remove("lit");
      const b = Tones.note(Pt.midiToFreq(target), { at: a.end + T.gapPauseSec, dur: T.gapNoteSec, timbre: timbre() });
      if (!(await until(b.start, id))) return;
      card.note.classList.add("lit");
      await until(b.end, id);
      card.note.classList.remove("lit");
    }

    function renderResult(r, target, tol) {
      const node = el("div", "result-card");
      node.setAttribute("aria-live", "polite");
      let title;
      let detail;
      let tone;
      if (r.outcome === "silent") {
        title = "Didn't hear you";
        detail = "I couldn't hear you. Check the mic or sing a little louder. (Not counted.)";
        tone = "neutral";
      } else if (r.outcome === "hit" && set.stageId === 4 && r.grade === "direct") {
        title = "Landed it ✓";
        detail = `Straight onto the note · ${centsWord(r.steadyCents)}`;
        tone = "ok";
      } else if (r.outcome === "hit" && set.stageId === 4) {
        title = "Found it";
        if (r.onsetCents == null) detail = "You slid into it. Next: same note, land it straight on.";
        else if (Math.abs(r.onsetCents) <= tol) detail = "You landed on it, then wavered. Next: same note, land it and stay.";
        else {
          detail = `You started ${Math.abs(Math.round(r.onsetCents))}¢ ${r.onsetCents < 0 ? "flat" : "sharp"}, then fixed it. Next: same note, land it straight on.`;
        }
        tone = "warn";
      } else if (r.outcome === "hit") {
        title = "On the note ✓";
        detail = `${r.lockSec != null ? `Found it in ${r.lockSec.toFixed(1)} s · ` : ""}${centsWord(r.steadyCents)}`;
        tone = "ok";
      } else if (r.outcome === "close") {
        title = "Close";
        detail =
          Math.abs(r.steadyCents) <= tol
            ? "Right note. Hold it steady a little longer next time to count it."
            : `${Math.abs(Math.round(r.steadyCents))}¢ ${r.steadyCents < 0 ? "flat" : "sharp"}. Almost there.`;
        tone = "warn";
      } else {
        title = "Not this time";
        if (r.sungMidi != null && r.octaveSlip && r.steadyCents != null) {
          const n = Math.max(1, Math.round(Math.abs(r.steadyCents) / 100));
          const octave = r.sungMidi < target ? "lower" : "higher";
          detail = `You were ${plural(n, "note")} ${r.steadyCents < 0 ? "below" : "above"} the note, one octave ${octave}. Aim a little ${r.steadyCents < 0 ? "higher" : "lower"}.`;
        } else if (r.sungMidi != null) {
          const diff = target - r.sungMidi;
          const n = Math.max(1, Math.round(Math.abs(diff)));
          detail = `You were around ${nameOf(Math.round(r.sungMidi))}. The note was ${nameOf(target)}, ${plural(n, "note")} ${diff > 0 ? "higher" : "lower"}.`;
        } else {
          detail = "I couldn't find a steady note. Try a clean 'oo' or a hum.";
        }
        tone = "neutral";
      }
      if (r.outcome === "hit" && r.octaveSlip && r.sungMidi != null) {
        detail += ` · right note, one octave ${r.sungMidi < target ? "lower" : "higher"}. That counts.`;
      }
      node.classList.add(tone);
      node.append(el("strong", "result-title", title), el("p", "result-detail", detail));
      const chips = el("div", "gap-chips");
      const you = el("span", "chip-note", r.sungMidi != null ? `You: ${nameOf(Math.round(r.sungMidi))}` : "You: –");
      const note = el("span", "chip-note", `Note: ${nameOf(target)}`);
      chips.append(you, note);
      if (r.outcome === "miss") node.appendChild(chips);
      return { node, you, note, title, detail };
    }

    function showSummary() {
      flushVoiced();
      Mic.close(); // nothing to listen to on the summary
      const now = new Date();
      const P1 = ps();
      const stage = stageDef(set.stageId);
      $("d-body").hidden = true;
      showControls();
      setHeader(`Stage ${stage.id} · ${stage.name}`, "Set done");
      renderDots();
      const box = $("d-summary");
      box.innerHTML = "";
      const hits = set.results.filter((r) => r.outcome === "hit").length;
      const direct = set.results.filter((r) => r.outcome === "hit" && r.grade === "direct").length;
      const title =
        set.stageId === 4
          ? `${direct}/${PT.SET_SIZE} landed straight on · ${hits - direct} found`
          : `${hits}/${PT.SET_SIZE} on the note`;
      box.appendChild(el("h1", null, title));

      const locks = set.results.filter((r) => r.outcome === "hit" && r.lockSec != null).map((r) => r.lockSec);
      if (locks.length) {
        const avg = locks.reduce((a, b) => a + b, 0) / locks.length;
        let line = `Average time to find the note: ${avg.toFixed(1)} s`;
        if (set.lockBefore != null) line += ` (earlier this week: ${set.lockBefore.toFixed(1)} s)`;
        box.appendChild(el("p", "summary-line", line));
        if (!lockTipShown) {
          lockTipShown = true;
          box.appendChild(el("p", "summary-tip", "Time to find the note often improves before accuracy does. Watch this number."));
        }
      }
      const blindRes = set.results.filter((r, i) => set.dots[i] && set.dots[i].blind);
      if (blindRes.length) {
        box.appendChild(
          el("p", "summary-line", `Blind tries: ${blindRes.filter((r) => r.outcome === "hit").length}/${blindRes.length}`),
        );
      }
      const bias = PT.biasSummary(set.results.map((r) => r.steadyCents).filter((c) => c != null));
      if (bias.tendency) {
        box.appendChild(
          el(
            "p",
            "summary-tip",
            `You tend to land ${bias.tendency} (about ${Math.abs(Math.round(bias.mean))}¢). Aim a little ${bias.tendency === "flat" ? "higher" : "lower"} than feels right.`,
          ),
        );
      }
      for (const msg of changeMessages(P1)) box.appendChild(el("p", "summary-change", msg));
      if (hits < 5 && !dipTipShown) {
        dipTipShown = true;
        box.appendChild(el("p", "summary-tip", "Scores can dip while you're learning to read the line. That's normal and it passes."));
      }
      const status = PT.stageStatus(P1, set.stageId);
      if (status.suggestEasier && set.stageId > 1) {
        const p = el("p", "summary-tip", "This one's tough right now. ");
        const easier = set.stageId - 1;
        p.appendChild(button(`Practise Stage ${easier} for a set`, "btn-small", () => resumeWith(() => startSet(easier))));
        box.appendChild(p);
      }
      const fatigue = PT.fatigueNotice(P1, now);
      const fkey = `${PT.dayKey(now)}:${fatigue}`;
      if (fatigue && !fatigueShown[fkey]) {
        fatigueShown[fkey] = true;
        box.appendChild(
          el(
            "div",
            "panel-note",
            fatigue === "stop"
              ? "20 minutes today. Give your voice a rest and come back tomorrow."
              : "That's 10 minutes of singing today. Short daily practice beats long sessions. This is a good place to stop; sip some water.",
          ),
        );
      }
      const passedNow = !set.passedBefore && P1.stages[String(set.stageId)].passed;
      const nextStage = passedNow && PT.recommendedStage(P1) !== "setup" ? PT.recommendedStage(P1) : set.stageId;
      const actions = el("div", "panel-actions");
      const again = button(
        nextStage !== set.stageId ? `Start Stage ${nextStage}` : "Another set",
        "btn-primary btn-lg",
        () => resumeWith(() => startSet(nextStage)),
      );
      again.id = "d-another";
      actions.append(again, button("Done", "btn-lg", () => goView("pitch")));
      box.appendChild(actions);
      box.hidden = false;
      mode = "summary";
    }

    function changeMessages(P1) {
      const out = [];
      const seen = new Set();
      for (const c of [...set.changes].reverse()) {
        if (seen.has(c.type)) continue;
        seen.add(c.type);
        if (c.type === "span-up") out.unshift(`Range widened: notes up to ${c.to} away from home.`);
        else if (c.type === "span-down") out.unshift("Keeping notes a bit closer for now.");
        else if (c.type === "tol-up") out.unshift(`Target tightened to ±${PT.TOL_LADDER[c.to]}¢.`);
        else if (c.type === "tol-down") out.unshift(`Target relaxed to ±${PT.TOL_LADDER[c.to]}¢.`);
      }
      const passedNow = !set.passedBefore && P1.stages[String(set.stageId)].passed;
      if (set.stageId === 4 && (passedNow || seen.has("mastered"))) {
        out.push("You're landing notes within a quarter-tone. That's accurate singing by any standard.");
      } else if (passedNow) {
        out.push(`Stage ${set.stageId + 1} unlocked: ${stageDef(set.stageId + 1).name}.`);
      }
      return out;
    }

    // ---- Pitch home -------------------------------------------------------

    function showHomeError(text) {
      const p = $("pitch-error");
      p.textContent = text;
      p.hidden = false;
    }

    function render() {
      const P0 = ps();
      const now = new Date();
      const home = P0.profile.homeMidi;
      renderAdvice("pitch-advice");
      $("pitch-error").hidden = true;
      const noMic = !Mic.supported();
      if (noMic) showHomeError("Pitch practice needs the microphone. Open the app over https:// or localhost, or use the desktop app.");

      // Hero
      const rec = PT.recommendedStage(P0);
      const start = $("ph-start");
      const explore = $("ph-explore");
      start.disabled = noMic;
      explore.disabled = noMic;
      if (home == null) {
        $("ph-eyebrow").textContent = "Start here";
        $("ph-title").textContent = "Find your voice";
        $("ph-text").textContent =
          "A 2-minute sound check: count down from 10, then hold an easy 'oo'. Every note you practise is built around it.";
        $("ph-start-label").textContent = "Start sound check";
        $("ph-length").textContent = "";
        start.onclick = () => begin("setup");
      } else {
        const id = selectedOrRecommended();
        const st = stageDef(id);
        $("ph-eyebrow").textContent = id === rec ? "Next up" : "Practise";
        $("ph-title").textContent = `Stage ${st.id} · ${st.name}`;
        $("ph-text").textContent = st.blurb || "";
        $("ph-start-label").textContent = `Start (${PT.SET_SIZE} tries)`;
        $("ph-length").textContent = "About 4 min";
        start.onclick = () => begin("train", id);
      }
      explore.onclick = () => begin("explore");

      // Stats (nothing to show before the sound check)
      $("ph-stats").hidden = home == null;
      const week = PT.weekSummary(P0, now);
      $("ps-home").textContent = home == null ? "–" : nameOf(home);
      $("ps-remeasure").hidden = home == null;
      $("ps-remeasure").disabled = noMic;
      $("ps-rate").textContent = week.rate == null ? "–" : `${Math.round(week.rate * 100)}%`;
      $("ps-rate-sub").textContent = week.blindRate == null ? "" : `Blind tries ${Math.round(week.blindRate * 100)}%`;
      $("ps-streak").textContent = PT.dayStreak(P0, now);

      renderTrend(P0, now, week);
      renderLadder(P0);
      renderNotes(P0);

      for (const b of $("ph-timbre").querySelectorAll("button")) {
        b.setAttribute("aria-checked", String(b.dataset.timbre === P0.settings.timbre));
      }
      $("ph-devices").textContent = deviceSummary();
    }

    // 14 columns: bar height = share of tries on the note that day.
    function renderTrend(P0, now, week) {
      const days = PT.trend(P0, now, 14);
      const box = $("ph-trend");
      box.innerHTML = "";
      const any = days.some((d) => d.tries > 0);
      $("ph-trend-wrap").hidden = !any;
      if (!any) return;
      const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
      const summary = [];
      days.forEach((d, i) => {
        const col = el("div", "trend-col");
        const [y, m, dd] = d.key.split("-").map(Number);
        const label = i === days.length - 1 ? "Today" : fmt.format(new Date(y, m - 1, dd));
        if (d.tries > 0 && d.rate != null) {
          const bar = el("span", `trend-bar${d.tries < 5 ? " few" : ""}`);
          bar.style.height = `${Math.max(4, Math.round(d.rate * 100))}%`;
          const tip = `${label}: ${Math.round(d.rate * 100)}% on the note (${plural(d.tries, "try")})`;
          col.title = tip;
          col.tabIndex = 0;
          col.setAttribute("aria-label", tip);
          col.appendChild(bar);
          summary.push(tip);
        } else {
          col.title = `${label}: no practice`;
        }
        box.appendChild(col);
      });
      box.setAttribute("aria-label", `Last 14 days. ${summary.join(". ")}`);
      const lock = week.lockAvg;
      $("ph-lock").textContent =
        lock == null
          ? ""
          : `Time to find the note: ${lock.toFixed(1)} s this week${week.prevLockAvg != null ? ` (${week.prevLockAvg.toFixed(1)} s the week before)` : ""}`;
    }

    function renderLadder(P0) {
      const list = $("ph-ladder");
      list.innerHTML = "";
      const home = P0.profile.homeMidi;
      const rec = PT.recommendedStage(P0);
      const active = home == null ? null : selectedOrRecommended();
      for (const st of PT.TRAIN_STAGES) {
        const status = PT.stageStatus(P0, st.id);
        const locked = !status.unlocked;
        const li = el("li");
        const btn = el("button", "path-item");
        btn.type = "button";
        btn.disabled = locked;
        btn.classList.toggle("locked", locked);
        btn.classList.toggle("done", status.passed);
        btn.classList.toggle("current", st.id === rec);
        btn.classList.toggle("selected", st.id === active);
        btn.addEventListener("click", () => {
          selectedStage = st.id;
          render();
        });
        const dot = el("span", "path-dot");
        if (locked) dot.appendChild(icon("lock"));
        else if (status.passed) dot.appendChild(icon("check"));
        else dot.textContent = st.id;
        const text = el("span", "path-text");
        text.append(el("span", "path-name", st.name), el("span", "path-goal", st.blurb || ""));
        if (!locked) {
          const meta = el("span", "path-meta");
          // Progress toward the next step: 5 of the last 6 (Stage 1), else 8 of 10.
          const frac = st.id === 1 ? status.window.slice(-6).reduce((a, v) => a + v, 0) / 5 : status.hits / 8;
          const bar = el("span", "mini-bar");
          const fill = el("span");
          fill.style.width = `${Math.round(100 * Math.min(1, frac))}%`;
          bar.appendChild(fill);
          meta.append(bar, status.label || "");
          text.appendChild(meta);
        }
        btn.append(dot, text);
        li.appendChild(btn);
        list.appendChild(li);
      }
      // Range note when "Too high/low" has narrowed it.
      const note = $("ph-range-note");
      note.innerHTML = "";
      if (PT.rangeClipped(P0)) {
        const { lowMidi, highMidi } = P0.profile;
        note.append(`Range limited to ${nameOf(lowMidi)}–${nameOf(highMidi)} · `);
        const reset = el("button", "link-btn", "Reset range");
        reset.type = "button";
        reset.addEventListener("click", () => {
          setPitch(PT.resetRange(ps()));
          render();
        });
        note.appendChild(reset);
      }
    }

    function renderNotes(P0) {
      const box = $("ph-notes");
      box.innerHTML = "";
      const chips = P0.profile.homeMidi == null ? [] : PT.noteChips(P0);
      const any = chips.some((c) => c.n > 0);
      $("ph-notes-wrap").hidden = !any;
      if (!any) return;
      for (const c of chips) {
        const cls = c.rate == null ? "untried" : c.rate >= 0.8 ? "good" : c.rate >= 0.5 ? "fair" : "low";
        const chip = el("span", `note-chip ${cls}${c.isHome ? " home" : ""}`);
        chip.appendChild(el("span", "note-chip-name", c.name));
        if (c.bias != null && Math.abs(c.bias) >= 30) chip.appendChild(el("span", "note-chip-bias", c.bias < 0 ? "flat" : "sharp"));
        let tip = `${c.name}: `;
        if (!c.n) tip += "not tried yet";
        else {
          tip += `${Math.round(c.hits)} of ${Math.round(c.n)} on the note`;
          if (c.bias != null) tip += `, usually ${Math.abs(Math.round(c.bias))}¢ ${c.bias < 0 ? "flat" : "sharp"}`;
          if (c.spread != null) tip += `, spread ±${Math.round(c.spread)}¢`;
        }
        if (c.isHome) tip += " (home note)";
        chip.title = tip;
        chip.setAttribute("aria-label", tip);
        chip.setAttribute("role", "button");
        chip.tabIndex = 0;
        const showTip = () => ($("ph-note-detail").textContent = tip);
        chip.addEventListener("click", showTip);
        chip.addEventListener("focus", showTip);
        box.appendChild(chip);
      }
    }

    // ---- Lifecycle --------------------------------------------------------

    function stopAudio() {
      newRun();
      Recorder.cancel();
      Tones.stop();
      Mic.close();
      lane.stop();
      if (exploreState) clearTimeout(exploreState.ideaTimer);
      exploreState = null;
    }

    function leave() {
      stopAudio();
      flushVoiced();
      mode = null;
      set = null;
      $("d-overlay").hidden = true;
    }

    // Window hidden: stop everything, discard the current try, offer resume.
    function pause() {
      const resumeMode = mode;
      if (!resumeMode) return;
      // Resting screens keep their card; just make sure nothing is listening.
      if (resumeMode === "summary" || resumeMode === "setup-done") {
        Mic.close();
        flushVoiced();
        return;
      }
      stopAudio();
      flushVoiced();
      showOverlay("Paused. Tap to resume", () => {
        if (resumeMode === "train") {
          if (set) continueSet();
        } else startMode(resumeMode);
      });
    }

    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        goView("pitch");
        return;
      }
      const onButton = e.target.closest && e.target.closest("button");
      if (mode === "summary" && e.key === "Enter") {
        if (onButton) return; // a focused button activates itself
        e.preventDefault();
        const b = document.getElementById("d-another");
        if (b) b.click();
        return;
      }
      if (e.target.closest && e.target.closest("input, textarea, select")) return;
      if (e.code === "Space") {
        // app.js swallows Space on keyup in the drill, so handle buttons here.
        e.preventDefault();
        if (e.repeat) return;
        if (replayFn) replayFn();
        else if (onButton) onButton.click();
      } else if (e.key === "s" || e.key === "S") {
        if (!$("d-skip").hidden) $("d-skip").click();
      } else if (e.key === "p" || e.key === "P") {
        if (!$("d-pause").hidden) $("d-pause").click();
      }
    }

    // ---- Wiring -----------------------------------------------------------

    $("d-exit").addEventListener("click", () => goView("pitch"));
    $("d-again").addEventListener("click", () => replayFn && replayFn());
    $("d-skip").addEventListener("click", () => active && active.resolve({ skipped: true }));
    $("d-range").addEventListener("click", (e) => active && active.resolve({ skipped: true, range: e.currentTarget.dataset.dir }));
    $("d-pause").addEventListener("click", () => {
      if (!set) return;
      set.autoNext = !set.autoNext;
      $("d-pause").textContent = set.autoNext ? "Pause auto-next" : "Resume auto-next";
    });
    $("ps-remeasure").addEventListener("click", () => begin("setup"));
    $("ph-devices-change").addEventListener("click", () => {
      goView("settings");
      $("dev-input").focus();
    });
    for (const b of $("ph-timbre").querySelectorAll("button")) {
      b.addEventListener("click", () => {
        setPitch({ ...ps(), settings: { ...ps().settings, timbre: b.dataset.timbre } });
        render();
      });
    }
    const how = $("ph-how");
    for (const [title, text] of INTRO_ROWS) {
      const row = el("div", "intro-row");
      row.append(el("strong", null, title), el("p", null, text));
      how.appendChild(row);
    }

    // A message from outside (e.g. the mic fell back or was lost).
    function notice(text) {
      toast(text);
    }

    return { render, leave, pause, onKey, notice };
  }

  const UNCLEAR_TEXT = "I hear sound but no clear note. Use a clean 'oo' or a hum; fry and grit don't show pitch.";

  // Research-backed intro (see RESEARCH.md, "Pitch training").
  const INTRO_ROWS = [
    ["Listen first, then sing.", "The note plays, stops, then it's your turn. Nothing plays while you sing, so speakers are fine."],
    ["Hear yourself.", "With headphones, keep them quiet or slip one ear off so you can hear your own voice."],
    [
      "Your ear is probably fine.",
      "Most people who miss notes hear pitch just fine. The work is teaching your voice to follow your ear, and that's what this trains.",
    ],
    ["Little and often.", "Hitting notes is a skill you build with reps. 5–10 minutes a day beats one long session."],
    ["Use a clean tone.", "Sing 'oo' or hum. Fry and grit don't have a clear pitch, so the app can't read them."],
  ];

  const EXPLORE_IDEAS = [
    "Siren: say 'weee' like a fire engine, from high to low. Watch the line follow you.",
    "Sigh from the top of your voice down to the bottom.",
    "Hum low, then slide up slowly. Higher sound = line goes up.",
    "Pick a line and keep your voice on it for 2 seconds.",
  ];

  window.PitchTab = { create, createLane };
})();
