# Scream Coach: vocal warm-ups up to extreme vocals

A small offline web app that walks you through a proper vocal warm-up, then
step by step toward vocal fry, fry screams, false cord screams, highs and lows.
The curriculum and safety rules are based on the research in
[RESEARCH.md](RESEARCH.md).

## Running it

No install or build step. Open `index.html` in a browser (double-click it),
or serve the folder and open it on your phone:

```
cd vocal_warmup
python -m http.server 8000
# then open http://<your-computer's-ip>:8000 on your phone
```

Progress is saved in the browser (localStorage) on that device.

## How it works

- **Every session:** warm-up (body release, support breath, lip trills, straw
  sirens, humming), then the technique block for your stage, then a cool-down.
- **7 stages:** clean fry → retraction (the "silent laugh") → inhale fry → fry
  screams → false cord screams → highs & pitch control → lows & gutturals.
  Each one unlocks after 3–4 sessions at the previous stage with a healthy
  check-in.
- **Reference tones** play scales, sirens and drones in a low, mid or high
  range, so you have pitches to follow.
- **Check-in after each session:** "scratchy" or "pain" pauses all distortion
  stages until a healthy session. Pain shows rest advice, and about two weeks
  of bad check-ins tells you to see an ENT / laryngologist.
- **"Stop: my voice doesn't feel right"** ends a session immediately and goes
  straight to the check-in.

## Files

| File | What |
|---|---|
| `curriculum.js` | All exercises and stages (edit this to change the content) |
| `progress.js` | Unlocking, safety gating, session building (pure functions) |
| `app.js` | UI, timer and Web Audio reference tones |
| `tests/progress.test.js` | Unit tests: `node --test vocal_warmup/tests/*.test.js` |

This is a practice aid, not a substitute for a voice teacher.
