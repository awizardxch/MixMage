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
| `shroomEdit` | "Chips" (country rock) as an EDM edit: beat box, build and drop, Shroom FX over cowboys and mushrooms |
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
- **Lock the grid to the deck.** A video starts a little after `play()`, so a beat started on the
  same event lands about 20 ms early. Every 2 bars set `beat.start` from the deck's `currentTime`
  against the song bar's clip start (the `lock` helper in `shroomEdit`); corrections then stay within
  a few ms. Check with `beat-phase.js`.
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
5. Build a contact sheet from the new clips' `.jpg` thumbnails, Read it, and note the indexes to
   exclude (logos, credits, title cards, near-black). Put them in the `drop(...)` list in `reelFor`.

## Checking the app itself

`SMOKE_SRC=<a synthetic mp4> npx electron . --smoke` must end with `SMOKE_DONE errors 0` (the
earlier `SMOKE ... errors` line is printed before most checks run; only `SMOKE_DONE` is the verdict). Run it after any
change under `src/`. Synthetic test videos are made with ffmpeg `lavfi` (`testsrc` plus a gated
`sine`); never test against the user's library except through `READONLY_LIBRARY=1 SMOKE_JS=<script>`.

## Reporting back

Lead with the files. Then, in this order: what each piece is, what you measured, what you could not
judge (always: how it sounds), and anything you excluded or changed on your own. Keep it short; the
user reads on a phone between takes and sends follow-ups quickly.
