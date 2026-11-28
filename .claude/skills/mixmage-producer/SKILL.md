---
name: mixmage-producer
description: Produce finished music videos, DJ-style sets and promo videos (including Forge / forge.awizard.dev promos) with this repo's Mixmage app (formerly Video Sampler), by scripting a performance and letting the app record it. Use this whenever the user asks for a promo, a post, a "set", a mix, a music video, a new variant of an existing video, to add a YouTube video or song to the mix, to change titles or picture clips in a video, or to check how a rendered video sounds or looks, even if they do not mention Mixmage or the sampler by name.
---

# Mixmage producer

Mixmage, "the spellweaver of sound and vision", is the user's audio and video sampler and mixer
(it was called Video Sampler at first; the user's library folder keeps that name).

You make short videos (about 20-30 seconds) by scripting a performance inside the Mixmage app
and having the app record its own output. You never edit video by hand with ffmpeg: the app plays
real clips on real decks and pads, so the result is something the user could have played live.

The user's style, in their words: the digital, AI-era equivalent of 1980s turntable mixing and
sampling. Their own music is the record; cartoons and other videos are the crate of samples. The
pieces must be actual DJ-quality music with flow, not a tour of the app's buttons.

## What you cannot do, and what replaces it

You cannot hear audio or watch video. Do not claim a piece "sounds good". Measure instead, and tell
the user plainly which judgments are measured and which are theirs to make by ear.

| Instead of | Do this |
|---|---|
| Listening for balance | `node scripts/analyze-mix.js demo/<name>-output.mp4` (five frequency bands per half-second; flags what sticks out) |
| Listening for loudness | ffmpeg `volumedetect` on the file, or per 2 s with `-ss`/`-t` |
| Watching the video | Extract a contact sheet with ffmpeg (`fps=1/1.85,scale=160:-2,tile=16x1`) and Read the image |
| Hearing the words | `node scripts/captions.js <video id> [from] [to]` prints YouTube captions with times (many music uploads have none; YouTube rate-limits this, retry later) |
| Hearing the key | `node scripts/key.js <file> [from] [to]`: the key (Krumhansl profiles) and the strongest bass notes |
| Hearing the song's form | `node scripts/bars.js <library> <source id>`: every bar's root note and level, 8 a row, from the app's one-bar clips; sections and chord cycles show up as repeating rows |
| Hearing where it is sung | `node scripts/vocals.js <library> <source id>`: per bar, the center-to-side ratio in the voice band (the lead vocal is mixed center); runs of V are sung, runs without are instrumental. A rough signal (±3 dB): read it as runs alongside `bars.js`, never bar by bar |
| Finding every beat | `node scripts/beats.js <file> <bpm hint> [--json out.json]`: tracks each beat (src/beats.js: librosa's dynamic-programming tracker on log-band flux, Essentia's multi-feature agreement, aubio's HFC and peak picking, HPSS bass roots with a confidence), prints tempo per 8 bars (a live band drifts) |
| Hearing whether the added kick is on the band | `node scripts/sync-check.js <render> <song> <beats.json> <from> <to>`: matched-filters the beat box's kick in the render against the song's tracked beats; in sync = median within ~5 ms, most beats within 15 ms |
| Hearing whether the added parts are subtle | `node scripts/compare-mix.js <remix> <original> <from> <to> [originalTimeAtFrom]`: each band's share of the total in the original and the remix over the same music. Subtle = low bands within +2 dB, the rest within 1.5 dB; mids losing share means the added beat buries the voice and guitars. Give the last argument when the song repeats itself, or it can match the wrong chorus |
| Knowing when each lyric line is sung | `.venv-whisper/Scripts/python.exe scripts/lyrics-align.py <audio> <lyrics.txt> <out.json> medium`: local Whisper word times, then every line matched to them globally. `medium` timed all 58 lines of one song; on another it hallucinated "na-na" over a verse that `small` heard correctly, so run both and combine when scores are low. Never time a storyline by assuming four bars per four lines: that put the pictures on the wrong lines. Suno MP3s carry their lyrics in a `lyrics-eng` tag |
| Finding a record's real tempo, or its acapella | `.venv-demucs/Scripts/demucs.exe -o demo/<folder>/stems <song>` splits it (htdemucs: drums, bass, vocals, other). Track beats on `drums.wav`, not the full mix: "Nothing Stays at Zero" reads a false 112 BPM whole and 139.65 (96% agreement) from its drum stem. A wrong tempo is why two records clash |
| Watching for dark, washed-out, frozen or flashing picture | `node scripts/check-video.js <video>`: DARK/WASHED/FROZEN stretches and the worst flashes per second (over 3 fails) |
| Hearing a flam | `node scripts/beat-phase.js <file> <bpm> <from> <to>`: folds low-band onsets over the beat; one peak = added drums land with the song, two = they don't |

Read every contact sheet you make. Bugs found this way so far: a black opening, credit frames, title
cards used as picture, the same clips in every video, clips that had not loaded.

## Rules that protect the user

- **Never write to `Videos\Video Sampler`** (the old name is kept on purpose; do not rename it). That is the user's live library and their app is usually
  open; anything written underneath it is lost or orphaned. Demo mode opens it read-only. New videos
  go into the separate demo library, `demo/extra-library`.
- **Never use bash heredocs or `node -e` strings to write code containing backslashes.** They are
  silently stripped. Use the Write and Edit tools for all source changes.
- **Promo wording must come from the user's own sources**: forge.awizard.dev/docs, the titles of the
  Chia Network talk on CHIP-0062, the @aWizardxch bio. Do not invent claims about a financial
  product. The end card is exactly: title `Enter the Beta`, sub `at Forge.aWizard.dev`.
- **No credits, logos or title cards as picture.** Exclude them by eye from a contact sheet of the
  clip thumbnails (see "Adding a video").
- **Every video gets its own picture clips** (`reelFor(L, slot, count)` deals each source's clips out
  to six slots; give each video a different slot).
- Say once, briefly, that third-party footage in public posts invites takedowns. The user knows; do
  not repeat it every turn.

## Rendering a video

Run from the repo root. The window pops up on top for about a minute per render; that is expected.

```
DEMO_VARIANT=<name> DEMO_JS=scripts/demo-performance.js DEMO_OUT=demo DEMO_EXTRA=demo/extra-library npx electron .
```

It writes `demo/<name>-output.mp4` (the piece, mastered to -14 LUFS) and `demo/<name>-app.mp4` (the
app being played). The log lines to read are `DEMO_PREPARE`, `DEMO_RUN`, `DEMO_ERROR` and any
`[renderer:3]` (a script error). Renders are sequential; one at a time.

Existing variants (all in `scripts/demo-performance.js`, in the `variants` object):

| Variant | What it is |
|---|---|
| `promo2`..`promo6` | Forge promos: one song each, picture cut per bar, titles |
| `cut80s` | The 80s-turntable style: half-bar cuts, transformer, beat juggle, stabs, scratch wobble, echo-out |
| `style80s`, `styleSmooth`, `styleBass` | The three styles on the second, all-new crate |
| `rodeoEdit` | "Chips" (country rock) as a 33-bar dance edit: beat box following the band, build and drop, Shroom FX over rodeo footage |
| `rodeoFull` | The whole of "Chips" (5:43, every lyric) as a dance record: three builds, four drops, two breakdowns, picture telling the song |
| `fxSampler` | Every effect preset in turn over "Chips", named on screen, then text and a freeze |
| `mothershipVideo` | aWizard's "Mothership" exactly as recorded: a disco-in-space story (contact, launch, warp, spacewalk under the mirror ball, then everyone dancing everywhere: streets, rooftops, beaches, clubs, raves, festivals, 1920s dance halls, moon hops; a drift past Earth for the breakdown). The user turned down the space-station crew as the dancers: party footage should be people having fun in many places, not one group cut to its tracked bars, with the light presets; then `original-audio.js`. `trackSong(id, bpm)` tracks any record with the app's bar numbers |
| `etfPromo` | The ⚒️ emoji-market product promo (29 s, the only cut; the user asked for one video, not a short and a long): "Nothing Stays at Zero" by itself, from "Hit the panic button now!" to "until they don't!", cut to its drum-stem beats. Panic (servers, swarms, 💎 🪙 🪄⚡ 🛸) → one ant (💗 🐜) → the colony → built from the ground up (🌱 🧩: wafers, chips, puzzle, boards) → launch (🛸) → orbit, ending on the pool ticker ⚒️ 🛰️ 🐜 🧩. See "The ⚒️ promo" below |
| `rodeoVideo` | The music video: "Chips" exactly as recorded, the rodeo story cut to its tracked bars, Shroom FX pulsing on the band's beats; then `original-audio.js` lays in the record's own sound |

**When the user wants the song itself** (they did, after hearing the dance versions): play it from
one deck, add nothing to the sound, cut the picture to its tracked bars (`timeOf`), let the effects
pulse on its beats (`fx.follow = { deck, beats }`), then replace the render's sound with the
original's: `node scripts/original-audio.js demo/<name>-output.mp4 <original file> <out.mp4>`
(it finds the offset by cross-correlation, to the millisecond). A render that starts partway into
the record needs a 4th argument, the record's time at the render's start, roughly; check that it
prints a match strength well above 0.3. Do not pipe its output through `Select-Object -First`: that
stops the tool before it writes the file. The app's output always passes its
limiter, so without that step a mastered record is squashed. A shorter version is a stretch cut from
that file with ffmpeg and a fade, not a re-edit of the song.

**Picture tells the song.** Before choosing footage, find out what the song is about (lyrics, the
user's description) and cut a story to its sections. "Chips" is a get-back-up rodeo song you'd play
in an old truck or a dive bar, so: the bar and the arena lights for the intro, a truck in the mud as
the band comes in, riders thrown in the dirt for the breakdown, getting up for the build, the ride
for the drops, the open road for the outro. Effects (mushroom color) are seasoning, not the subject.
Prefer archival home movies, public-domain films and amateur footage; skip official league
channels (aggressive takedowns), stock sites (watermarks) and private people's faces.

Long pieces (over about two minutes): add `DEMO_NO_APP=1`. Filming the app window holds every
frame in memory (about 250 KB each, 20 a second); with it set, only the output is made. Run the
render in the background; it takes the piece's length plus about a minute.
| `set1`..`set3` | Song-to-song DJ sets with a loop roll into each drop |
| `ours1`..`ours3` | The user's track with cartoon picture, with and without Peggy Gou |
| `mix`, `decks`, `instrument`, `blend` | Captioned feature tours of the app (not what the user wants for posts) |

After rendering, always: build and Read a contact sheet, run `analyze-mix.js`, then send the file
with SendUserFile.

## Writing a new piece

Almost everything is `djSet(L, parts, options)`:

- `parts`: `[{ id, bars, still?, skip? }]`. Each part is a song section played from a deck, starting
  at the song's loudest four bars (`skip` shifts that by bars). Parts alternate decks; between parts
  the outgoing song's last bar is loop-rolled (halves, quarters, eighths) and the next song drops on
  the downbeat. Songs never overlap for long, so keys cannot clash.
- `still: true` marks a song whose own video is only a cover image. Picture is then cut in from
  `options.pictures`, one clip per `options.cut` bars (default 1; 0.5 for fast cutting).
- `options.bpm`: the master tempo. Use the main song's own tempo (`bpmOf(id)`), so it is not shifted.
- `options.extra(at)`: add your own timed events. `at(bars, fn)` schedules `fn` at that bar.
- Titles: `extra: titled(TITLE_LIST, bars)`. Each entry is `[bar, { title, sub, center? }]`, written
  for 16 bars and stretched. `center: true` is a full card (use for the first and last).

Inside events you can call the app's own functions: `hit(pad)`, `stop(pad, quick?)`,
`playNote(pad, midiNote, velocity)` / `stopNote(note)`, `setBlend(seconds)`, `setPitch(semitones)`,
`setDeckPlaying(deck, on)`, `fade(0..1)` (crossfader), `setOutputTitle({...})`. Per-pad settings are
set on `state.pads[i]`: `mode` (`oneshot`/`gate`/`loop`), `gain`, `pitch`, `trim`, `loop`.
Set `rt[i].pin = true` for any pad you trigger faster than once a bar, or its video will not have
loaded and the picture goes black. Set `rt[i].noPic = true` on a pad that should be heard but never
shown (juggling a bar of a track whose video is only its cover art, or the cover flashes up).
Sound gains are not portable between sources: a gain that fixed one sample made another 5 dB too
loud. Set gains near 1 (level match already evens sources), render, and adjust from `analyze-mix.js`.
`cut80s(L, { id, pictures, stabs, tone, titles })` plays the 80s routine on any track and crate;
`style80s`, `styleSmooth` and `styleBass` are the three styles on the second, all-new crate.

### Turning a record into a dance track: the beat box and Shroom FX

`shroomEdit` (a country-rock record, "Chips" by Choctaw Wildfire, made into an EDM edit with
psychedelic color) is the example. Read it before writing a remix. The pieces:

- **Beat box** (`src/renderer/beat.js`, also the Beat button in the mixer): a synthesized 909-style
  kit locked to a tempo. `startBeat({ bpm, roots, duck, parts })` with bar 0 now; `setBeatParts({ kick,
  clap, hat, closed, bass })`; `beat.roots` is one MIDI note per bar (C2 = 36) for the off-beat bass:
  take them from `bars.js`, never guess; `beat.duck` is the sidechain pump on the decks (0.35 verse,
  0.55 drop); `beat.roll = { from, to }` a snare roll in bars; `riser(ctxTime, seconds)`; `beat.hats`
  scales the hats; `stopBeat()`.
- **Follow the record's own beats; never a fixed grid.** A record played by a live band drifts
  (this one 138-142 BPM phrase to phrase). A fixed 139.7 grid, even re-locked to the deck every two
  bars, measured 52 ms late in one drop and 26 ms early in another, and the user heard it. Track
  the beats (`window.api.beats({ file, bpm })`, a few seconds, cached) and start the beat box in
  follow mode: `startBeat({ follow: { deck, beats, down, offset: 0 }, ... })`, where `down` is the
  index of the beat that starts bar 0 (bar numbers then match yours). Switch decks by assigning a
  new `beat.follow`. Give the piece `timeOf(bar)` (ms from the start, from the tracked bars) so
  drops, cuts and titles land on the band's bars too. `trackChips` in `rodeoEdit` shows the
  mapping from the app's clip bars to tracked beats. Measure with `sync-check.js` after rendering.
- **Known timing fault: a deck started partway through a piece is heard about 37 ms after the
  position it reports** (a deck started with the piece is right, within 2 ms; swapping the decks'
  roles moved the fault with the late start, not with the deck). `rodeoEdit` drops on such a deck
  and its kick lands early there. Until it is fixed, play a follow-mode piece from one deck started
  at bar 0, or measure the second deck with `sync-check.js` and set `beat.follow.offset` (+0.037).
  A listening lock that correlated the deck's live sound with the tracked beats was tried and
  wandered by tens of milliseconds on a dense band record; do not bring it back as it was.
- **Levels: the beat is an addition, not a takeover.** Measured with `compare-mix.js`: the beat bus
  at 0.9, pump depths of 0.45-0.6 and the record's bass at +4 dB took 5 dB of share from the record's
  mids, and the user heard it as the added bass overwhelming the song. Now the beat bus is 0.5, pumps
  0.12-0.3, the bass boost about +1 dB; verse bands land within 1 dB of the original.
- **No synth bass under a band record unless the roots are certain.** Two root analyses agreed on
  only half the bars of "Chips"; a wrong bass note sounds out of time even when it is on time. Boost
  the record's own bass instead (`setDeckBass(deck, 1.3)`, about +4 dB; 1.5 is +6) and let the kick's
  duck pump it.
- **Build and drop:** `setDeckLowCut(0..1, seconds)` sweeps a low cut on the decks; take the kick out
  4 bars before the drop, roll and riser in, one beat of silence (deck `vol` 0), then everything on
  the one with `setDeckLowCut(0, 0.01)`.
- **Shroom FX** (`src/renderer/fx.js`, the FX menu under the viewer): `fx.mode` `'shroom'` or
  `'mirror'` (kaleidoscope), `fx.amount`, `fx.trails`, `fx.beat` (pulse per beat), `fx.spin`, and
  `fx.bpm` / `fx.t0` to put the pulse on the beat; `fxFlash()` on a drop. It colors black-and-white
  footage too, and fills the frame (crops) while on.
- Measured in that piece: a quiet intro is short of highs, so even soft hats stand 8 dB out; keep
  intro hats at about 0.2. A riser at full level stood 17 dB out in the air band; 0.16 is right.
  Pick sections by the bar map: a pre-chorus that runs into the chorus gives a build and drop with
  no edit at all.

**A full-song remix that keeps the lyrics** (`shroomFull`): play the record start to finish on
one deck, never cut, and build the dance arrangement around it. Then no word can be lost to a wrong
guess about where the singing is. Use `vocals.js` only to decide *where* the arrangement moves go:
builds with the low cut, beats of silence and the biggest drop on instrumental runs; on sung bars
keep the low cut open and put at most a snare roll before a drop. Bring the beat in and out by
section (intro hats, verse groove, breakdowns with the drums out, drops with everything), and
pin picture clips a few cuts ahead instead of all at once.

Read `cut80s` before writing anything rhythmic; it shows sixteenth-note scheduling, gating the deck,
juggling a bar, stabs and the echo-out.

### What makes it sound like a DJ and not a demo

- One master tempo for the whole piece; change songs only on bar lines, preferably every 4 or 8 bars.
- Let whole song sections play. Chopping every bar of a song into pads sounds like a demo.
- Samples (cartoon sounds) are seasoning: off-beats, bar ends, answers to the beat. Measured fact:
  at matched loudness cartoon stabs sit about 10 dB hot in the 2-6 kHz band against a full track,
  so play them at `gain` around 0.4.
- After any change, re-run `analyze-mix.js`. Flags at the very start and end are the fades. A flagged
  run in the middle with `sub -10 dB` is usually the song's own breakdown (compare with the same
  song in another render before "fixing" it). A single flagged half-second is something you added.

### Mixing two records, and when not to (the ⚒️ promo)

What the user turned down, in order, so it is not tried again:
1. Fade one song out and the next in: "we need to be true DJs". A transition overlaps: the incoming
   record enters behind a filter, the outgoing one's filter closes as the new one takes over.
   `setDeckFilter(deck, v, seconds)` is that one knob (-1 full low-pass … 0 open … 1 full high-pass);
   an entry at 0.45 opening to 0.03 over 4 bars, an exit closing to 0.85 over 2.
2. Quick filtered blends between several songs: "too fast and forced". Let rhythm patterns develop;
   use few songs and long passages.
3. A whole second record over a disco bed: its drums ran at another speed ("the intro clashes and
   rubs the ear"). Fix the tempo first (Demucs drum stem, above), lay in only its acapella, stretched
   to the bed with pitch kept: `ffmpeg -i vocals.wav -af rubberband=tempo=<bed/own>:pitch=1 out.wav`,
   then start it on a bed downbeat with its own downbeat. Check the keys are compatible (`key.js`).
4. Even beat-matched, two songs in a 30 s piece did not work: "the song order doesn't mix well".
   **Under about a minute, play one song.** Pick the section by its lyrics (`lyrics-align.py`) and
   start on a downbeat that a line lands on.

A deck started mid-piece is heard about 37 ms after the position it reports; start overlays that
much further in.

### The ⚒️ promo

- The product is named ⚒️ for now. Words on screen are emojis only: the emoji market's own tickers
  (forge.awizard.dev `/api/public/v1/tokens`): 💗 LOVE, 🐜, 🧩, 🛰️, 🌱 SPROUT, 🛸 UFO, 💎, 🪙,
  🪄⚡, and the pool ⚒️ 🛰️ 🐜 🧩 in its ticker order. Put each where the picture and the lyric say it
  (🐜 on the ants, 🧩 on the chips, 🛸 on the launch). Check the ticker list before reusing it; the
  market changes.
- No brands: no NVIDIA, no SpaceX, no logos, no channel watermarks, generic footage.
- Sources and the clips kept from each are `etfSources` and `etfKeep` in the script; the song and
  its stems and lyric timing are in `demo/set2672/`.

## Effects: what is available and how to choose

Everything is in `src/renderer/fx.js`; the user picks the same things from the FX menu under the
viewer (a preset) and "Effects ▾" (tick any effects). The user or the piece decides which to use;
nothing is applied unless chosen. `fxSampler` (render it, then `original-audio.js ... 68.3`) shows
every preset in turn, named on screen.

**Presets** (`fxPreset(name)`), by mood:

| Preset | What it is | Suits |
|---|---|---|
| `shroom`, `shroomMirror` | Rainbow color wash, trails; with kaleidoscope | psychedelic, EDM |
| `rodeo` | Light shroom color, film, zoom punch | country, archival Americana |
| `archival` | Film (grain, scratches, flicker, weave, fade) and sepia | old footage, documentary |
| `vhsParty` | VHS tracking, bleed, scanlines, PLAY stamp; shake; zoom punch | 80s/90s throwback, lo-fi |
| `neonClub` | Neon grade, zoom punch, strobe every 4 beats, trails | club, house, EDM |
| `comic` | Halftone print dots, zoom punch | cartoons, pop |
| `heat` | Thermal camera colors, shake | dark, heavy, a breakdown |
| `nightVision` | Green phosphor, noise, vignette | night footage, tension |
| `noir` | High-contrast black and white, film | drama, a quiet section |
| `brand` | Duotone in Forge colors (`dark`, `light` settable) | promos |
| `splitBeat` | Four panes of recent clips trading places every two beats | call and response, montage |
| `dream` | Double exposure, trails, warm grade | intros, ballads |
| `discoSpace` | Neon grade, mirror-ball light spots, glow, zoom punch | disco, space, a party section |
| `warp` | Warp stars surging on the beat, glow, zoom punch | launches, builds, leaving Earth |
| `laserShow` | Cold grade, sweeping lasers, glow, a strobe every 8 beats | the peak, club drops |
| `cosmos` | Slow stars, double exposure, glow | space intros, breakdowns, outros |

**Single effects** (`fxUse([...])`, `fxAdd(name, settings)`, `fxSet`, `fxRemove`; each takes an
`amount` 0..1, defaults in `FX_CATALOG`):

- On the beat: `zoomPunch` {every}, `shake` {every}, `strobe` {every, color 'white'|'black'},
  `stutter` {every: 0.25 = the picture steps in quarter beats}. `every` is in beats.
- Looks: `film` {grain, scratches, flicker, weave, fade}, `vhs` {stamp}, `grade` {look: sepia, noir,
  warm, cold, tealOrange, neon}, `duotone` {dark, light}, `halftone` {cell}, `thermal`,
  `nightVision`, `mirror`, `trails`.
- Light (added on top in light, after the trails, so they never smear; none is a full-frame flash):
  `starfield` {speed, count, every: the surge}, `discoBall` {spots, every}, `lasers` {beams, every:
  the color change}, `glow` (bloom). They also work over footage that is mostly black, which is
  where most space footage lives.
- Compose (they use the clips shown before the current one): `split` {panes 2|4}, `pip` {size,
  corner 'tl'|'tr'|'bl'|'br'}, `double`, `chroma` {key '#00ff00', tolerance}.
- Text: `fxText(text, { style: 'caption'|'pop'|'type'|'slide', where: 'bottom'|'center'|'top',
  every (beats per word for pop), hold (s) })`; `fxText(null)` clears.
- `fxFreeze(seconds)` holds the picture. Freeze a moment after a cut, never on it: on the cut the
  old clip has stopped and the new one has not drawn, so the freeze holds the deck's cover art.

They all follow the beat: set `fx.bpm` (and `fx.t0`), or better `fx.follow = { deck, beats }` with
tracked beats, so hits land on a live band's beats.

**Section by section** (in a piece script): `fxSections(at, [[0, 'intro'], [8, 'verse'],
[32, 'build'], [40, 'chorus'], [72, 'breakdown'], ...])` scales every effect (`fx.master`): intro
0.45, verse 0.6, build 0.85, chorus/drop 1, breakdown 0.35, outro 0.4. Switch presets on section
changes with `at(bar, () => fxPreset('...'))`. Lyrics: `lyricsAt(at, [[bar, 'words', { style:
'pop' }], ...])`; take the words from the user or from captions (`captions.js`), never invent them.

**Choosing:** let the song and the user decide. Match the footage (archival film on archival
footage, comic on cartoons), keep a look per section rather than changing every bar, and keep the
strongest effects for the drops. Several looks stacked at once turns to mud; one look plus one beat
effect is usually enough.

**Safety and checking:** every full-frame flash (strobe, `fxFlash`) passes one limiter: at most 3 a
second, the broadcast photosensitive-epilepsy line, whatever a script asks. After rendering run
`node scripts/check-video.js <video>`: it reports DARK, WASHED and FROZEN stretches and the worst
flash rate; a FLASHES FAIL must be fixed before posting. Dark night footage shows up as short DARK
runs; that is fine if the footage is meant to be dark.

## The live-blend style (measured from a real set)

The user points at live house sets as the model. `node scripts/study-mix.js <audio> <t1,t2,...>`
measures one: give it the tracklist times from the video description (`yt-dlp --print "%(description)s"`)
and it prints each track's tempo and, around every change, the bass and level in 4-second steps.
What a 35-minute stretch of a soulful deep house set showed (TEE EM DEE, Brooklyn block party):

- **One tempo.** 121.6, then 123.0, then 123.8 BPM across eight records: never more than about
  1 BPM (1.2%) between neighbors, creeping upward. Pick records within about 1.5% of each other.
- **Level never moves.** Within 1 dB through every change. A change is not an event in the level.
- **Long blends with a bass swap.** Two records run together for about a minute; the bass drops out
  for 2-4 bars near the start of the blend, or sits 5 dB down for the whole overlap, then returns.
  There are no hard cuts.

In `djSet`, give a part `mix: <bars>` to blend it into the next part this way instead of a loop
roll: the next deck comes in with its bass cut (`setDeckBass(deck, 0)`), the crossfader travels
across over the overlap, the bass is swapped half-way, and the outgoing deck leaves. `live1` and
`live2` are the examples. In a 30-second piece use 8 bars; in anything longer use 16 or 32.
A correct blend measures flat in `analyze-mix.js` except one short dip at the bass swap.
Not yet measurable here: whether the two kicks land together (both decks start on bar-cut clip
starts, so they should, within a few tens of milliseconds). Say so; the user's ear is the check.

A second set, with no tracklist, was read with `node scripts/study-mix.js <audio> scan` (tempo per
minute, every bass drop-out, how steady the level is). IDRIS at Black House Radio, 62 minutes:

- The same slow tempo creep (122.3 to 124.5 BPM over the hour). Readings near 98-105 are the
  estimator slipping to a 4:5 ratio in breakdowns, not real changes; ignore isolated ones.
- A much more hands-on low end: 43 bass drop-outs, one every 1.4 minutes, mostly 4-16 bars long and
  13-23 dB deep (the first set had one every 3.1 minutes, mostly 2-4 bars). Level is looser too:
  39% of the set within 1.5 dB of its norm against 67%.
- So there are two house styles to choose between: the smooth one (long invisible blends) and the
  bass-play one (cut the low end for a phrase, bring it back on the one as a drop). `live3` is the
  bass-play move on one record: `setDeckBass(deck, 0)` for two bars, back to 1 on a bar divisible by 4.
  A correct bass cut shows in `analyze-mix.js` as `sub -14 dB` or lower for exactly those bars.
- Its video opens on an archival film clip before the set starts: a sampled cold open, the same
  idea as `opener` in `djSet`.

Use the roll-and-drop (`set1`..`set3`, the default) for the 80s cut style and the long blend for
the house-set style. They are different traditions; do not mix them in one short piece.

## Adding a video or song

1. Look it up first: `./bin/yt-dlp.exe --js-runtimes node --no-playlist --print "%(id)s | %(title)s | %(duration)s" <url>`.
   `--js-runtimes node` is required or YouTube answers "video not available". To find videos by
   topic, use `ytsearch10:<words>` as the URL with `--flat-playlist`, or the app's own search box.
2. Download into `demo/extra-library/library/<id>.mp4` with the same format flags the app uses
   (`-S "vcodec:h264,res:720,acodec:m4a" --merge-output-format mp4 --ffmpeg-location <ffmpeg-static path>`).
   For anything over about 8 minutes add `--download-sections "*<from>-<to>"`.
3. Add it to `sources` in `demo/extra-library/state.json` (id, title, duration, file, url).
4. Cut it by running the app on that library with a small script:
   `SMOKE_ROOT=demo/extra-library SMOKE_JS=<script> npx electron . --smoke`. In the script: `setSource`,
   set `$('autoMode').value` (`hits` for songs, `equal` for picture, `sounds` for one-shots) and
   `$('autoLen').value` (`1` = whole song in one-bar clips, `0` = fill one page), `await autoCut()`,
   then `await window.api.save(state)`. Name picture clips so they can be found (`Wizard pic ...`).
5. Build a contact sheet with `node scripts/clip-sheet.js demo/extra-library <source id> <out.jpg>`
   (three labeled frames per clip), Read it, and note the indexes to exclude (logos, credits, title
   cards, banners, brand signs, watermarks, near-black). A sheet of first frames only is not enough:
   "EVERY JULY" banners inside a newsreel clip got into a render that way. Look in the corners and
   along the edges too: a channel watermark in one army-ant clip, and a caption strip naming NVIDIA
   and SpaceX across the top of the only orbit-data-center footage, both reached a render. When the
   footage is worth keeping, crop the strip off its clip files in `demo/extra-library/clips` (back
   them up first; crop to 16:9 and scale back to 1280x720) rather than dropping it.
6. Picture clips must last as long as the cut they fill. A one-shot that ends early leaves the
   viewer on the deck's own picture, which for a record is its cover art. `picturePlan` in the rodeo
   pieces only deals clips long enough.

## Checking the app itself

`SMOKE_SRC=<a synthetic mp4> npx electron . --smoke` must end with `SMOKE_DONE errors 0` (the
earlier `SMOKE ... errors` line is printed before most checks run; only `SMOKE_DONE` is the verdict). Run it after any
change under `src/`. Synthetic test videos are made with ffmpeg `lavfi` (`testsrc` plus a gated
`sine`); never test against the user's library except through `READONLY_LIBRARY=1 SMOKE_JS=<script>`.

## Reporting back

Lead with the files. Then, in this order: what each piece is, what you measured, what you could not
judge (always: how it sounds), and anything you excluded or changed on your own. Keep it short; the
user reads on a phone between takes and sends follow-ups quickly.
