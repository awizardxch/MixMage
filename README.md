# Mixmage

*The spellweaver of sound and vision.*

Mixmage is a desktop sampler, two-deck mixer and recorder for audio **and** video. Fetch a video,
cut it into pads, play the pads from a MIDI controller (built on a Launchkey Mini MK3), mix two
decks with tempo sync and a crossfader, and record the finished output, picture and sound together.
It is the digital, AI-era take on 1980s turntable mixing and sampling.

## Features

- **Pads with pages.** 16 pads a page, as many pages as a song needs. Drag to rearrange, Delete to
  clear, MIDI-learn any pad or page button.
- **Auto cut.** Cut a source on its hits, into equal bars at the source's own tempo, or into isolated
  sounds that play as instruments across the keyboard (pitch, speed, trim).
- **Clean playback.** Click-free starts, loops snapped to the tempo and zero crossings, level matching
  across sources, and a limiter on the output.
- **Two decks and a mixer.** BPM detection and sync, an equal-power crossfader, and a bass control
  for blends and bass cuts.
- **Beat box.** A synthesized 909-style kit (kick, clap, hats, off-beat bass) that follows the playing
  record's own tracked beats, so it stays with a live drummer, pumping the decks on every kick, plus a
  low-cut sweep for builds.
- **One viewer.** Shows whatever is playing, with dissolves between clips.
- **Music-video effects.** Presets by mood (Shroom, Rodeo, Archival film, VHS party, Neon club, Comic,
  Heat, Night vision, Noir, Brand duotone, Split on the beat, Dream, Disco space, Warp, Laser show,
  Cosmos) or any mix of single effects: zoom punch, shake, strobe, stutter, freeze, film, VHS, color
  grades, duotone, halftone, thermal, night vision, kaleidoscope, trails, warp stars, mirror-ball
  light, lasers, glow, split screen, picture in picture, double exposure, chroma key, and
  beat-timed text. They pulse on the song's tracked beats, show in the viewer and record into the
  output. Strobes are capped at 3 flashes a second.
- **Recording.** Record pads into a deck, or record the final output with titles to MP4.
- **YouTube search** from the address box.

## Setup

Requires Node.js 18 or newer.

```
npm install     # also downloads yt-dlp into bin/
npm start
```

Your library lives in `Videos/Video Sampler` (the app's original name).

## Analysis tools

These measure a mix when you cannot listen to it, so a script or an agent can check its own work.

- `node scripts/analyze-mix.js <file>`: five frequency bands per half-second; flags anything that
  sticks out.
- `node scripts/study-mix.js <file> <t1,t2,...>` or `<file> scan`: studies a DJ set's tempo, bass
  swaps and level steadiness.
- `node scripts/captions.js <video id> [from] [to]`: prints a video's captions with times.
- `node scripts/key.js <file>`: the song's key and strongest bass notes.
- `node scripts/bars.js <library> <source id>`: each bar's root note and level, to read a song's form.
- `node scripts/vocals.js <library> <source id>`: which bars are sung, from where the voice sits in the stereo image.
- `node scripts/beats.js <file> <bpm hint>`: every beat, downbeat and bass root of a song, even one
  played by a live band whose tempo moves (the beat box follows these beats).
- `node scripts/sync-check.js <render> <song> <beats.json> <from> <to>`: whether the beat box's kick
  lands on the band's beats in a render.
- `node scripts/clip-sheet.js <library> <source id> <out.jpg>`: three labeled frames from every clip of a
  source, to spot titles, banners and credits to leave out.
- `node scripts/compare-mix.js <remix> <original> <from> <to>`: each frequency band's share in a remix
  against the original over the same music, to keep added parts subtle.
- `node scripts/original-audio.js <render> <original> <out> [originalTimeAtStart]`: lays a record's own
  sound under a rendered video, lined up to the millisecond.
- `node scripts/check-video.js <video>`: dark, washed-out and frozen stretches, and the flash rate.
- `.venv-whisper/Scripts/python.exe scripts/lyrics-align.py <audio> <lyrics.txt> <out.json> [model]`:
  when each lyric line is sung, from local speech-to-text (faster-whisper; set up with
  `py -3 -m venv .venv-whisper` and `pip install faster-whisper`). Nothing is uploaded.
- `node scripts/beat-phase.js <file> <bpm> <from> <to>`: whether added drums land on the song's beat.

`.claude/skills/mixmage-producer` is a skill that teaches an agent to produce finished pieces with
the app.

## A note on content

Mixmage plays clips of whatever you load into it. You are responsible for having the rights to use
the footage and music you sample, especially in anything you publish.
