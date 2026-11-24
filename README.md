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
- **One viewer.** Shows whatever is playing, with dissolves between clips.
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

`.claude/skills/mixmage-producer` is a skill that teaches an agent to produce finished pieces with
the app.

## A note on content

Mixmage plays clips of whatever you load into it. You are responsible for having the rights to use
the footage and music you sample, especially in anything you publish.
