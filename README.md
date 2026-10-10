# Scream Coach: vocal warm-ups up to extreme vocals

A small offline web app that walks you through a proper vocal warm-up, then
step by step toward vocal fry, fry screams, false cord screams, highs and lows.
The curriculum and safety rules are based on the research in
[RESEARCH.md](RESEARCH.md).

## Desktop app (Windows .exe)

`ScreamCoach.exe` is a single portable file. There's nothing to install, just
double-click it.

**Getting the exe:** GitHub builds it on every push (or click **Run
workflow** on the Actions page to build it on demand). Open the repo's **Actions** tab, then the latest **Build Scream Coach
exe** run, and download **ScreamCoach-windows-exe** under *Artifacts*. It comes
as a zip, so unzip it to get `ScreamCoach.exe`. Pushing a tag such as
`coach-v1.0.0` also attaches the exe to a GitHub Release.

**First launch:**
- The exe isn't code-signed, so Windows SmartScreen may say "Windows protected
  your PC". Click **More info → Run anyway**.
- It takes a few seconds to open because the portable exe unpacks itself
  first.
- For the pitch check, Windows has to allow desktop apps to use the mic:
  **Settings → Privacy & security → Microphone → Let desktop apps access your
  microphone**.

Progress is saved in `%APPDATA%\Scream Coach`, so it survives moving or
replacing the exe.

**Building it yourself** (Node 22):

```
npm install
npm start        # run the desktop app
npm test         # unit tests
npm run dist     # build dist/ScreamCoach.exe (works on Windows and Linux)
```

## Running in a browser

No install or build step. Open `index.html` in a browser (double-click it),
or serve the folder and open it on your phone:

```
python -m http.server 8000
# then open http://<your-computer's-ip>:8000 on your phone
```

Progress is saved in the browser (localStorage) on that device.

**Microphone / pitch check:** browsers only allow the mic on `https://` pages,
`localhost`, or a file opened directly on a computer. Opening the
`http://<ip>:8000` address on your phone works for everything else, but the
pitch check will be greyed out. To use it on a phone, host the folder on
something with HTTPS (for example GitHub Pages).

## How it works

- **Practice tab:** today's session with one Start button, and your path
  through the stages. Click any unlocked stage to practise it instead.
- **Every session:** warm-up (body release, support breath, lip trills, straw
  sirens, humming), then the technique block for your stage, then a cool-down.
- **7 stages:** clean fry → retraction (the "silent laugh") → inhale fry → fry
  screams → false cord screams → highs & pitch control → lows & gutturals.
  Each one unlocks after 3–4 sessions at the previous stage with a healthy
  check-in.
- **Reference tones** play scales, sirens and drones in a low, mid or high
  range, so you have pitches to follow.
- **Pitch check (mic):** turn it on in a session and the app listens while you
  sing. It shows your note next to the target note, a flat/sharp meter, and
  "On the note ✓" when you're within 50 cents (half a semitone). The right note
  in a different octave counts, and it allows for singing slightly behind the
  reference. You get a per-exercise score and an overall accuracy for the
  session, which is saved in your history. Wear headphones so the mic doesn't
  pick up the reference tone. You can also mute the reference and keep the
  pitch check running to test yourself. Fry and distortion have no clear
  pitch, so the meter ignores them on purpose.
- **Check-in after each session:** "scratchy" or "pain" pauses all distortion
  stages until a healthy session. Pain shows rest advice, and about two weeks
  of bad check-ins tells you to see an ENT / laryngologist.
- **Keyboard (desktop):** Space starts or pauses, ← and → move between
  exercises, and Esc quits the session.
- **"My voice doesn't feel right. Stop now."** ends a session immediately and goes
  straight to the check-in.

## Files

| File | What |
|---|---|
| `curriculum.js` | All exercises and stages (edit this to change the content) |
| `progress.js` | Unlocking, safety gating, session building (pure functions) |
| `app.js` | UI, timer, Web Audio reference tones, mic capture |
| `pitch.js` | Pitch detection (McLeod method) and note/target maths (pure functions) |
| `desktop/main.js` | Electron shell for the desktop app (window, mic-only permission) |
| `desktop/icon.png` | App icon |
| `tests/` | Unit tests: `npm test` |

This is a practice aid, not a substitute for a voice teacher.
