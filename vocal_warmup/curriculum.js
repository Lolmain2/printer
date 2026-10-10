// Exercise and stage definitions. See RESEARCH.md for where each idea comes from.
//
// Tone patterns (played by the session player):
//   {type: "scale", degrees: [...semitones], noteSec, startOffset, steps}
//       - plays the degrees from a base note, then repeats `steps` times,
//         moving the base up a semitone each repetition.
//   {type: "glide", fromOffset, toOffset, sec}  - smooth siren up and back down.
//   {type: "drone", offset}                     - one held reference note.
// Offsets are semitones relative to the voice range's base note.

(function (root) {
  const FIVE_NOTE = [0, 2, 4, 5, 7, 5, 4, 2, 0];
  const THREE_NOTE = [0, 2, 4, 2, 0];

  const WARMUP = [
    {
      id: "body-release",
      name: "Body & jaw release",
      seconds: 60,
      steps: [
        "Slow neck rolls (half circles, front only), 3 each way.",
        "Shoulders up to ears, then drop them. 3 times.",
        "Massage the jaw hinge with your fingertips and let the jaw hang.",
        "Big yawn, then a relaxed sigh on the way out.",
      ],
      cue: "You're aiming for loose, not floppy. Tension in the neck and jaw goes straight into the throat.",
    },
    {
      id: "breath-hiss",
      name: "Support breath: hiss",
      seconds: 90,
      steps: [
        "Breathe in low for 4 counts. Belly and sides expand, shoulders stay still.",
        "Breathe out on a steady \"sss\" for 8 counts, keeping your ribs wide.",
        "Repeat. If it's easy, try a 12-count exhale.",
      ],
      cue: "Every scream technique relies on this steady, supported airflow, so it's worth getting right.",
    },
    {
      id: "lip-trills",
      name: "Lip trills on a 5-note scale",
      seconds: 120,
      tone: { type: "scale", degrees: FIVE_NOTE, noteSec: 0.45, startOffset: 0, steps: 6 },
      steps: [
        "Loose lips, \"brrr\" like a motorboat. Press your cheeks lightly with your fingers if they won't trill.",
        "Follow the reference tones up and down the 5-note pattern.",
        "Each repetition starts a semitone higher.",
      ],
      cue: "Semi-occluded (SOVT) exercise: back-pressure from the lips reduces how hard your vocal folds collide.",
    },
    {
      id: "straw-sirens",
      name: "Straw sirens",
      seconds: 120,
      tone: { type: "glide", fromOffset: 0, toOffset: 12, sec: 4 },
      steps: [
        "Phonate through a drinking straw (no straw? Use a tight \"oo\" or a lip trill).",
        "Glide smoothly from low to high and back down, like a siren.",
        "Go only as high as is easy. The range will open up as you warm up.",
      ],
      cue: "Keep it light and smooth across the register breaks. Don't push to get the high notes.",
    },
    {
      id: "hum-ng",
      name: "Hum into \"ng\"",
      seconds: 90,
      tone: { type: "scale", degrees: THREE_NOTE, noteSec: 0.6, startOffset: 2, steps: 5 },
      steps: [
        "Hum \"mm\" on the pattern, then switch to \"ng\" (as in \"sing\").",
        "Feel buzzing in the lips, nose and face, not in the throat.",
      ],
      cue: "Quiet and buzzy. If you feel it in your throat, back off the volume.",
    },
    {
      id: "ng-ah",
      name: "\"Ng\" to \"ah\" sirens",
      seconds: 90,
      tone: { type: "glide", fromOffset: 0, toOffset: 9, sec: 3.5 },
      steps: [
        "Start the siren on \"ng\" and open to \"ah\" at the top, keeping the same easy feeling.",
        "Medium volume, about as loud as talking.",
      ],
      cue: "Moves the warm-up from closed sounds to open vowels without losing the ease.",
    },
  ];

  const COOLDOWN = [
    {
      id: "cool-straw",
      name: "Gentle straw slides",
      seconds: 60,
      tone: { type: "glide", fromOffset: 7, toOffset: 0, sec: 4 },
      steps: ["Soft descending slides through a straw or on \"oo\"."],
      cue: "Lets the folds settle after distortion work.",
    },
    {
      id: "cool-yawn",
      name: "Yawn-sighs",
      seconds: 60,
      steps: ["Big yawn, then a soft sigh falling from mid to low.", "5 or 6 times, unhurried."],
      cue: "Releases leftover constriction.",
    },
    {
      id: "cool-hydrate",
      name: "Rest & hydrate",
      seconds: 45,
      steps: ["Sip water. Rest your voice for a few minutes, no talking."],
      cue: "Then do the check-in honestly. It's what decides when the next stage unlocks.",
    },
  ];

  // Technique stages. Each one unlocks after `sessionsToUnlock` healthy sessions
  // at the previous stage. `distortion: true` stages are locked while the voice
  // is reported as hoarse or painful.
  const STAGES = [
    {
      id: 1,
      name: "Clean vocal fry",
      distortion: false,
      sessionsToUnlock: 3,
      goal: "Find an effortless, quiet fry and move between fry and clean tone.",
      exercises: [
        {
          id: "find-fry",
          name: "Find your fry",
          seconds: 60,
          tone: { type: "drone", offset: -5 },
          steps: [
            "At the bottom of your range, say a lazy, quiet \"uhhh\" and let it crackle like a creaky door.",
            "Use almost no air, about what you'd use for a whisper.",
            "Short sets: 5 seconds on, 5 seconds rest.",
          ],
          cue: "It should feel like nothing, with no push and no scratch. If it tickles, go quieter.",
        },
        {
          id: "slow-fast-fry",
          name: "Slow fry / fast fry",
          seconds: 90,
          steps: [
            "Make the fry pop slowly (separate clicks), then let it speed up into a smooth rattle.",
            "Go back and forth between the two 4–5 times.",
          ],
          cue: "Builds control over how much air goes through the fry.",
        },
        {
          id: "fry-onset",
          name: "Fry into clean note",
          seconds: 90,
          tone: { type: "scale", degrees: THREE_NOTE, noteSec: 0.7, startOffset: 0, steps: 4 },
          steps: [
            "Start each note with a short fry, then let it smooth into a clean \"ah\".",
            "Follow the pattern. The note should come out with no hard glottal attack.",
          ],
          cue: "Connects fry and your clean voice so neither one turns into a squeeze.",
        },
        {
          id: "fry-vowels",
          name: "Fry on vowels",
          seconds: 60,
          steps: ["Sustain a quiet fry while shaping \"ee – eh – ah – oh – oo\".", "Keep the crackle steady through every vowel."],
          cue: "Vowel shape will change the scream colour later.",
        },
      ],
    },
    {
      id: 2,
      name: "Retraction: the silent laugh",
      distortion: false,
      sessionsToUnlock: 3,
      goal: "Learn to open the false folds on purpose. Every safe scream depends on this.",
      exercises: [
        {
          id: "silent-laugh",
          name: "Silent laugh",
          seconds: 90,
          steps: [
            "Laugh silently at something funny, with no sound, just the airy laugh feeling.",
            "Notice the inside of your throat widening. That's retraction.",
            "Hold the open feeling for 5 seconds, breathing gently. 6 times.",
          ],
          cue: "Compare it with the closed feeling of grunting while you lift something heavy. That closed feeling is constriction, the one to avoid.",
        },
        {
          id: "laugh-hum",
          name: "Silent laugh + hum",
          seconds: 60,
          tone: { type: "drone", offset: 2 },
          steps: ["Set up the silent laugh, then hum on the reference note without losing the open feeling."],
          cue: "Holds retraction while you make sound.",
        },
        {
          id: "retracted-ah",
          name: "Retracted \"ah\" at speaking volume",
          seconds: 90,
          tone: { type: "scale", degrees: FIVE_NOTE, noteSec: 0.5, startOffset: 0, steps: 4 },
          steps: [
            "Silent laugh, then sing \"ah\" on the scale at normal talking volume.",
            "If you feel squeezing on the way up, stop, reset the laugh, and start lower.",
          ],
          cue: "Your clean voice should feel easier and freer here. That's the sign retraction is working.",
        },
        {
          id: "fry-retraction",
          name: "Fry with retraction",
          seconds: 60,
          steps: ["Silent laugh, then add your quiet fry from Stage 1. 5 seconds on, 5 off."],
          cue: "The fry may get a little richer or buzzier. That's your first taste of distortion.",
        },
      ],
    },
    {
      id: 3,
      name: "Inhale fry (soft)",
      distortion: true,
      sessionsToUnlock: 3,
      goal: "Feel the rattle above the vocal folds with very little load on them.",
      exercises: [
        {
          id: "inhale-fry-find",
          name: "Inhale fry",
          seconds: 60,
          steps: [
            "Breathe in slowly through the mouth while making a quiet creak, like a gasp in a horror movie.",
            "2–3 seconds per inhale, then breathe normally through your nose for a few breaths.",
            "Max 8 repetitions.",
          ],
          cue: "Dries the throat fast. Sip water between sets. Should never sting.",
        },
        {
          id: "inhale-vowels",
          name: "Inhale fry vowels",
          seconds: 60,
          steps: ["Same creak on the inhale, shaping \"ee\" then \"oh\".", "Notice how the vowel changes the pitch and colour."],
          cue: "Optional technique. Some singers never use it, and that's fine. Skip it if it irritates.",
        },
        {
          id: "exhale-mirror",
          name: "Mirror it on the exhale",
          seconds: 60,
          steps: [
            "After an inhale fry, try to copy the same throat sensation while breathing out, with retraction.",
            "Keep it quiet. You're looking for the location of the sound, not volume.",
          ],
          cue: "Leads into the exhale fry scream in the next stage.",
        },
      ],
    },
    {
      id: 4,
      name: "Fry screams",
      distortion: true,
      sessionsToUnlock: 4,
      goal: "Turn retracted fry into a controlled exhale scream at modest volume.",
      exercises: [
        {
          id: "fry-plus-air",
          name: "Fry + air",
          seconds: 90,
          steps: [
            "Silent laugh, open the mouth slightly like the start of a yawn.",
            "Start a relaxed fry, then gently increase airflow. Don't increase the squeeze.",
            "1–2 second bursts, rest 5 seconds. 8 bursts.",
          ],
          cue: "Grit should appear from the air, not from tightening. If you feel pressure in the throat, add retraction or lower the volume.",
        },
        {
          id: "fry-scream-vowels",
          name: "Fry scream vowels",
          seconds: 90,
          steps: ["Short bursts on \"eh\", \"ah\" and \"oh\", 3 each.", "Keep the volume at a raised speaking voice, not a full scream."],
          cue: "Volume comes later and comes from support, not effort.",
        },
        {
          id: "fry-scream-pitch",
          name: "Fry scream on pitch",
          seconds: 90,
          tone: { type: "scale", degrees: [0, 4, 7], noteSec: 0.9, startOffset: 3, steps: 4 },
          steps: ["Short fry-scream bursts that follow the reference notes.", "Stop at the first sign of tickle or scratch."],
          cue: "Moving between pitches without losing the distortion is the core skill for screaming in songs.",
        },
        {
          id: "clean-reset",
          name: "Clean reset",
          seconds: 45,
          tone: { type: "glide", fromOffset: 0, toOffset: 7, sec: 3 },
          steps: ["A few gentle clean sirens on \"oo\"."],
          cue: "Always come back to clean between distortion sets.",
        },
      ],
    },
    {
      id: 5,
      name: "False cord screams",
      distortion: true,
      sessionsToUnlock: 4,
      goal: "A thicker, lower, roaring scream driven by support.",
      exercises: [
        {
          id: "growl-find",
          name: "Quiet dog growl",
          seconds: 60,
          steps: [
            "With retraction, make a low, quiet \"grrr\" like an annoyed dog.",
            "Feel the vibration above your voice, not a scrape on it.",
            "3 second sets, rest 5.",
          ],
          cue: "This gentle growl is where false cord distortion starts.",
        },
        {
          id: "huh-bursts",
          name: "\"Huh!\" bursts",
          seconds: 90,
          steps: [
            "Fill up with a supported breath, then a short, roaring \"HUH\" from the belly, with the throat open.",
            "Support from your core, as if you're pushing a heavy door shut, while your throat stays open.",
            "6–8 bursts.",
          ],
          cue: "Power comes from the body. The throat just lets the sound through.",
        },
        {
          id: "clean-to-fc",
          name: "Clean into false cord",
          seconds: 90,
          tone: { type: "scale", degrees: [0, 2, 4], noteSec: 0.9, startOffset: 3, steps: 4 },
          steps: [
            "Sing a clean, chesty \"ah\" on the note, then let distortion engage as you lean into the support.",
            "Release before it turns into a squeeze.",
          ],
          cue: "If the clean note is already strained, the scream on top of it will be too. Go lower.",
        },
        {
          id: "fc-phrases",
          name: "Short phrases",
          seconds: 90,
          steps: ["Scream short words: \"NO\", \"WHY\", \"YEAH\", \"GO\".", "3–4 reps each, full rest between."],
          cue: "Practising with consonants and words prepares you for real lyrics.",
        },
      ],
    },
    {
      id: 6,
      name: "Highs & pitch control",
      distortion: true,
      sessionsToUnlock: 4,
      goal: "Raise pitch and brightness while keeping the open, supported throat.",
      exercises: [
        {
          id: "bright-fry",
          name: "Bright fry",
          seconds: 60,
          steps: [
            "Fry scream on \"ee\" with a slight smile so it sounds thinner and brighter.",
            "Short bursts, moderate volume.",
          ],
          cue: "The vowel and a narrower mouth do most of the work for highs.",
        },
        {
          id: "high-ladder",
          name: "Pitch ladder",
          seconds: 90,
          tone: { type: "scale", degrees: [0, 3, 5, 7], noteSec: 0.8, startOffset: 7, steps: 4 },
          steps: ["Distorted \"eh\" on each step of the ladder. Every round starts higher.", "Stop the moment it feels pinched."],
          cue: "Highs need more retraction, not more force.",
        },
        {
          id: "dist-sirens",
          name: "Distorted sirens",
          seconds: 60,
          tone: { type: "glide", fromOffset: 2, toOffset: 10, sec: 3 },
          steps: ["Light distortion that slides up and down with the siren."],
          cue: "Smooth transitions now mean no cracking mid-song later.",
        },
        {
          id: "clean-dirty-mix",
          name: "Clean / dirty switch",
          seconds: 60,
          tone: { type: "drone", offset: 7 },
          steps: ["On one note: 2 seconds clean, 2 seconds distorted, back to clean. Repeat 5 times."],
          cue: "Being able to switch on purpose is what control means.",
        },
      ],
    },
    {
      id: 7,
      name: "Lows & gutturals (advanced)",
      distortion: true,
      sessionsToUnlock: null,
      goal: "Deep growls and lows with more vocal-tract space.",
      exercises: [
        {
          id: "low-space",
          name: "Low space",
          seconds: 60,
          steps: [
            "Lower the larynx gently, like the start of a yawn, and round the lips.",
            "Make a quiet false-cord growl on \"oh\" or \"oo\".",
          ],
          cue: "The depth comes from the space you make, not from pushing the pitch down.",
        },
        {
          id: "low-bursts",
          name: "Low bursts",
          seconds: 90,
          steps: ["Short, supported low growls on \"uh\" and \"oo\". 6–8 reps with full rest."],
          cue: "Lows tire you out quickly. Keep the sets short.",
        },
        {
          id: "low-words",
          name: "Low words",
          seconds: 60,
          steps: ["Growl short words: \"DOWN\", \"COLD\", \"DOOM\"."],
          cue: "Get a teacher to check your technique at this level if you can.",
        },
      ],
    },
  ];

  // Base notes (MIDI numbers) for the reference tones.
  const RANGES = {
    low: { label: "Low (bass / baritone)", baseMidi: 45 }, // A2
    mid: { label: "Mid (tenor / alto)", baseMidi: 50 }, // D3
    high: { label: "High (mezzo / soprano)", baseMidi: 57 }, // A3
  };

  const api = { WARMUP, COOLDOWN, STAGES, RANGES };
  root.Curriculum = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
