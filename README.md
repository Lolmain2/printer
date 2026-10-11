# Scream Coach: vocal warm-ups up to extreme vocals

A small offline web app that walks you through a proper vocal warm-up, then
step by step toward vocal fry, fry screams, false cord screams, highs and lows.
The curriculum and safety rules are based on the research in
[RESEARCH.md](RESEARCH.md).

## Desktop app (Windows)

**Install once, then it updates itself.**

1. Download `ScreamCoach-Setup-<version>.exe` from the
   [latest release](https://github.com/Lolmain2/printer/releases/latest).
2. Run it. It installs just for you, with no admin rights needed, and adds
   Start menu and desktop shortcuts.

**Updates:** the app checks for updates when it starts and every 4 hours, and
downloads them in the background. When one is ready, a banner offers
**Restart now**. It never restarts by itself, and the banner stays out of the
way during sessions. If you don't restart, the update installs the next time
you close the app. Settings → App updates shows your version, with a
**Check now** button.

**First install:**
- The installer isn't code-signed, so Windows SmartScreen may say "Windows
  protected your PC". Click **More info → Run anyway**.
- **If you used the old portable `ScreamCoach.exe`:** close it before
  installing, then delete it and start Scream Coach from the Start menu.
  Your progress carries over.
- For the pitch check, Windows has to allow desktop apps to use the mic:
  **Settings → Privacy & security → Microphone → Let desktop apps access your
  microphone**.

Progress is saved in `%APPDATA%\Scream Coach`. It survives updates, and
uninstalling keeps it.

**How releases are made:** every push to the main (default) branch builds the
installer on GitHub and publishes it as release `v1.1.<build number>`. Installed
apps pick that up. Pushes to other branches only build the installer, which you
can download from the run's **Artifacts** (`ScreamCoach-windows-installer`).

**Building it yourself** (Node 22):

```
npm install
npm start        # run the desktop app from source (updates are off)
npm test         # unit tests
npm run dist     # build dist/ScreamCoach-Setup-<version>.exe (Windows, or Linux with wine)
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
- **Pitch tab, for learning to hit notes:**
  - **Find your voice:** a 2-minute sound check (count down from 10, hold an
    easy "oo") finds your *home note*. Every practice note is built around it,
    in your own octave.
  - **Explore:** sing anything and watch your voice as a line on a scrolling
    note grid.
  - **Train:** 4 stages, 10 tries per set.
    1. Echo your own recorded note.
    2. Notes near home.
    3. Widen to an octave.
    4. Land notes straight on, with a tightening target.

  The note plays, stops, then you sing, so nothing plays while you're scored.
  Every try ends with a verdict (how far, which direction, time to find the
  note), and misses play "the gap" between your note and the target. Some tries
  are blind, to check what you've really learned. The home screen tracks your
  7-day accuracy, a day streak, a 14-day chart, and which notes you tend to
  sing flat or sharp. It's based on the pitch-training research in
  [RESEARCH.md](RESEARCH.md#7-learning-to-hit-notes-the-pitch-tab).
- **Audio devices (Settings):**
  - **Choosing devices:** pick the microphone and the output (speakers or
    headphones). There's a mic test with a level meter and the note it hears,
    and a test tone for the output.
  - **When a device is missing:** if your chosen device isn't plugged in, the
    app uses the system default and says so. It switches back automatically
    when the device returns, including mid-session.
  - **Errors:** a mic another app is holding (a DAW, Discord) or one blocked
    by Windows privacy settings gets a specific message.
  - **Pitch tab:** shows which devices are in use.
- **Keyboard (desktop):** Space starts or pauses, ← and → move between
  exercises, and Esc quits the session. In Pitch practice, Space replays the
  note, S skips, P pauses auto-advance, and Esc exits.
- **"My voice doesn't feel right. Stop now."** ends a session immediately and goes
  straight to the check-in.

## Files

| File | What |
|---|---|
| `curriculum.js` | All exercises and stages (edit this to change the content) |
| `progress.js` | Unlocking, safety gating, session building (pure functions) |
| `app.js` | App shell, guided sessions, timer and check-ins |
| `pitch.js` | Pitch detection (YIN with pYIN-style candidates and a tracker that holds low, quiet and breathy notes steady while fry, breath and mains hum read as no pitch) and note/target maths |
| `pitch-trainer.js` | Pitch tab logic: home note, stages, trial scoring, adaptation, stats (pure functions) |
| `pitch-tab.js` | Pitch tab screens and the scrolling pitch lane |
| `audio.js` | Reference tones (incl. a voice-like "oo"), microphone frames, voice recording, device switching |
| `devices.js` | Mic/output device lists and matching a saved choice to what's plugged in (pure functions) |
| `desktop/main.js` | Electron shell for the desktop app (window, mic and output permissions only) |
| `desktop/updater.js` | Automatic updates from GitHub Releases |
| `desktop/preload.js` | Exposes only the update status/actions to the page (`window.desktop`) |
| `updates.js` | Update status text for Settings and the banner (pure functions) |
| `desktop/icon.png` | App icon |
| `tests/` | Unit tests: `npm test` |

This is a practice aid, not a substitute for a voice teacher.
