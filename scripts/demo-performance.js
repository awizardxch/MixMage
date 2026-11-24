// Scripted performances, run inside the app by demo mode (see runDemo in src/main.js):
//   DEMO_JS=scripts/demo-performance.js DEMO_OUT=demo DEMO_EXTRA=demo/extra-library DEMO_VARIANT=mix npx electron .
// Each variant plays the real pads, loops, keys, decks and crossfader in time, with a caption naming
// each feature, while the app's own "Record output" captures the result. Nothing is saved to the library.
//   mix         every video in one 12-bar piece, touring every feature
//   decks       two songs on the decks: tempo sync and the crossfader
//   instrument  found sounds played on pads and across the keys, then pitch
//   blend       one bar from each video, crossfaded
(() => {
  const TD = 'a5B29IV2CnM'; // TAKE DOWN: one-bar clips, steady tempo
  const GOLD = 'yebNIHKAC4A'; // Golden
  const PP = 'WDrAKCf6_Sg'; // Pink Panther
  const PG = '63AIpRUren0'; // Peggy Gou - D.A.N.C.E. (extra library)
  const RR = 'prToAbTu-gU'; // Road Runner: one-shot sounds (extra library)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const rmsOf = (d, a, b) => { let s = 0; for (let k = a; k < b; k += 8) s += d[k] * d[k]; return Math.sqrt(s / Math.max(1, (b - a) / 8)); };
  const loudness = (i) => { const b = rt[i].buffer; return b ? rmsOf(b.getChannelData(0), 0, b.length) : 0; };
  const padsOf = (id) => state.pads.map((c, i) => (c && c.sourceId === id && rt[i].buffer ? i : -1)).filter((i) => i >= 0);
  const byLoud = (list) => [...list].sort((x, y) => loudness(y) - loudness(x));
  const byTime = (list) => [...list].sort((x, y) => state.pads[x].start - state.pads[y].start);
  const bpmOf = (id, fallback) => (state.sources.find((s) => s.id === id) || {}).bpm || fallback;
  // The four loudest consecutive clips of a song: its chorus or drop.
  const hook = (id) => {
    const list = byTime(padsOf(id));
    let best = 0;
    let top = -1;
    for (let k = 0; k + 4 <= list.length; k++) {
      const sum = loudness(list[k]) + loudness(list[k + 1]) + loudness(list[k + 2]) + loudness(list[k + 3]);
      if (sum > top) { top = sum; best = k; }
    }
    return list.slice(best, best + 4);
  };
  // Brings a clip from another song to the piece's tempo by pitch (it speeds up or slows down slightly).
  const tune = (i, from, to) => {
    let r = to / from;
    while (r > 1.3) r /= 2;
    while (r < 0.77) r *= 2;
    state.pads[i].pitch = 12 * Math.log2(r);
  };
  const mode = (list, m) => { for (const i of list) state.pads[i].mode = m; };

  let caption;
  const say = (text) => { caption.textContent = text; caption.style.opacity = text ? 1 : 0; };
  const hit = (i) => { if (pageOf(i) !== page) setPage(pageOf(i)); select(i); play(i, 1); };
  const fade = (v) => { $('xfade').value = v; $('xfade').dispatchEvent(new Event('input')); };
  const deckItem = (i, bpm, loopEnd) => { const c = state.pads[i]; return { kind: 'clip', title: c.name, url: c.url, file: c.file, bpm, loopStart: 0, loopEnd }; };
  let run; // { bpm, bars, events(at) } built by the chosen variant

  // ---------- DJ sets ----------
  // A set is a piece of music, not a feature tour: whole song sections play from the decks at one
  // master tempo (key lock holds their pitch), and each change of song is a loop roll — the outgoing
  // song's bar retriggered at halves, quarters, then eighths — that drops into the next song exactly
  // on the downbeat. The songs never overlap for long, so their keys cannot clash.
  //   parts: [{ id, bars }]   opener: a pad clip that plays the bar before the first song
  //   bpm: master tempo (default Take Down's)   pictures: silent clips cut in, one per bar, over any
  //   part marked `still` (a song whose own video is only a cover image)
  async function djSet(L, parts, { opener, extra, bpm, pictures, cut = 1 } = {}) {
    const BPM = bpm || L.tdBpm;
    const lead = opener != null ? 1 : 0;
    const info = parts.map((p, k) => {
      const list = byTime(padsOf(p.id));
      let first = p.id === GOLD ? L.gold[0] : hook(p.id)[0];
      // `skip` starts that many bars after the hook (a different section); always leave room to play the part through.
      if (p.id !== GOLD) first = list[Math.max(0, Math.min(list.indexOf(first) + (p.skip || 0), list.length - p.bars - 2))];
      return { ...p, list, pos: list.indexOf(first), first, bpm: bpmOf(p.id, 125), deck: decks[k % 2], barred: p.id !== GOLD };
    });
    if (pictures) {
      for (const i of pictures) { state.pads[i].mode = 'oneshot'; state.pads[i].gain = 0; rt[i].pin = true; } // picture only, kept loaded
      syncVideos();
      await wait(1500); // let the pinned videos buffer their first frames
    }
    const cue = async (part) => {
      const s = state.sources.find((x) => x.id === part.id);
      const d = part.deck;
      await loadDeck(d, { kind: 'source', title: s.title, url: s.url, file: s.file, bpm: part.bpm });
      if (!d.video.duration) await new Promise((r) => d.video.addEventListener('loadedmetadata', r, { once: true }));
      d.video.currentTime = state.pads[part.first].start;
      d.rate = Math.max(0.7, Math.min(1.4, BPM / part.bpm));
      applyRate(d);
      d.vol = 1;
      d.q('vol').value = 1;
      applyVolumes();
    };
    await cue(info[0]);
    if (info[1]) await cue(info[1]);
    // The bar each roll repeats: the outgoing song's own last bar, at the deck's loudness and tempo.
    let t = lead;
    for (const part of info) {
      part.from = t;
      t += part.bars;
      part.to = t;
      const c = part.barred ? part.list[part.pos + part.bars - 1] : null;
      if (c != null) {
        part.rollClip = c;
        state.pads[c].mode = 'oneshot';
        tune(c, part.bpm, BPM); // level match already puts pads and decks at the same loudness
      }
    }
    if (opener != null) state.pads[opener].mode = 'oneshot';
    setBlend(0.35);
    select(opener != null ? opener : info[0].first);
    const side = (part) => fade(part.deck.idx);
    return {
      bpm: BPM, bars: t, keepDeckTime: true,
      events(at) {
        if (opener != null) at(0, () => hit(opener));
        let shot = 0;
        info.forEach((part, k) => {
          const next = info[k + 1];
          if (part.still && pictures && pictures.length) {
            // A new picture on every bar, dissolving from the last; the roll bar shows the song's own cover.
            // A roll bar shows the song's own cover; a long blend keeps the pictures running straight through.
            const until = next && part.rollClip != null && !part.mix ? part.to - 1 : part.to;
            let prev = null;
            for (let b = part.from; b < until - 0.001; b += cut) {
              const i = pictures[shot++ % pictures.length];
              const was = prev;
              at(b + 0.01, () => { setBlend(cut < 1 ? 0.08 : 0.22); hit(i); if (was != null && was !== i) stop(was); });
              prev = i;
            }
            const last = prev;
            at(until - 0.01, () => { if (last != null) stop(last, until !== part.to); });
          }
          at(part.from, () => {
            side(part);
            setDeckPlaying(part.deck, true);
            if (k === 0 && opener != null) stop(opener);
            // The song after this one goes onto the deck the previous song has just left.
            if (k >= 1 && info[k + 1]) setTimeout(() => cue(info[k + 1]), 300);
          });
          if (!next) {
            // Last song: ride it out over its final bar.
            for (let s = 0; s <= 30; s++) at(part.to - 1 + s / 30, () => { part.deck.vol = 1 - s / 30; applyVolumes(); });
            return;
          }
          const c = part.rollClip;
          if (part.mix) {
            // The long blend, as measured in live house sets: the next record comes in under this one
            // with its bass cut, the two run together at one tempo and one level, the bass is swapped
            // half-way, and this record leaves. `mix` is the length of the overlap in bars.
            const n = part.mix;
            const a = part.deck;
            const b = next.deck;
            const from = a.idx; // crossfader position of the outgoing deck (0 or 1)
            at(part.to - n, () => { setDeckBass(b, 0); setDeckPlaying(b, true); focusViewer('deck', b.idx); });
            for (let s = 0; s <= 40; s++) at(part.to - n + (s / 40) * n, () => fade(from + (b.idx - from) * (s / 40)));
            at(part.to - n / 2, () => { setDeckBass(a, 0); setDeckBass(b, 1); });
            at(part.to - 0.01, () => { setDeckPlaying(a, false); setDeckBass(a, 1); });
          } else if (c != null) {
            at(part.to - 1, () => { setDeckPlaying(part.deck, false); setBlend(0.02); hit(c); });
            for (const b of [0.5, 0.625, 0.75, 0.8125, 0.875, 0.9375]) at(part.to - 1 + b, () => hit(c));
            at(part.to, () => { stop(c, true); setBlend(0.35); });
          } else {
            at(part.to - 0.02, () => setDeckPlaying(part.deck, false));
          }
        });
        if (extra) extra(at);
      },
    };
  }

  // The Forge promo: a two-song set as the soundtrack, titles drawn into the recorded output, and
  // silent picture from the Chia Network talk on weighted N-asset AMMs under the CHIP-0062 title.
  // Every line of text is taken from forge.awizard.dev/docs.
  const TALK = 'hpxxPYg9PMo';
  const TALK_PICKS = (window.__demoTalkPicks || '').split(',').filter(Boolean).map(Number);
  async function promo(L) {
    const talk = byTime(padsOf(TALK));
    const picks = (TALK_PICKS.length ? TALK_PICKS : [0, 1]).map((k) => talk[k]).filter((i) => i != null);
    for (const i of picks) { state.pads[i].mode = 'oneshot'; state.pads[i].gain = 0; } // picture only
    const titles = [
      [0, { title: 'THE FORGE', sub: 'A decentralized exchange on the Chia blockchain', center: true }],
      [2, { title: 'Swap any pair', sub: 'Routed across Forge pools and Dexie' }],
      [4, { title: 'All at once, or not at all', sub: 'Every trade is a Chia offer you approve in your own wallet' }],
      [5.9, null],
      [7, { title: 'Weighted N-asset pools', sub: 'Built on CHIP-0062' }],
      [9, { title: 'Provide liquidity, earn fees', sub: 'Or create a pool of your own' }],
      [11, { title: 'LP rewards, no staking', sub: 'Your LP token never leaves your wallet' }],
      [13, { title: 'Multisig locks', sub: 'Shared Chia vaults: several owners, a set number must approve' }],
      [14.5, { title: 'Enter the Beta', sub: 'at Forge.aWizard.dev', center: true }],
    ];
    return djSet(L, [{ id: TD, bars: 7 }, { id: PG, bars: 9 }], {
      extra(at) {
        for (const [bar, t] of titles) at(bar, () => setOutputTitle(t));
        picks.forEach((i, k) => {
          at(7.02 + k, () => { setBlend(0.35); hit(i); if (k) stop(picks[k - 1]); });
        });
        if (picks.length) at(7 + picks.length, () => stop(picks[picks.length - 1]));
      },
    });
  }

  // ---------- your music, their pictures ----------
  // "Found You" has only a cover image, so it supplies the sound and the picture is cut in bar by bar
  // from Looney Tunes, Pink Panther and Peggy Gou. Peggy Gou's own sections keep their own video.
  const OURS = 'Hvq5Y7TcTGo';
  // Wizard cartoons lead (picked by eye from their contact sheets, skipping logos and credits),
  // with Looney Tunes, Pink Panther and Peggy Gou in between.
  const WOODS = '1EeIyrKe30Q';
  const DUEL = 'XN8kwpnVET4';
  const APPRENTICE = 'B4M-54cEduo';
  const pictureReel = (L) => {
    // Left out: two near-black Looney Tunes clips, and Pink Panther's opening credits (its first 85 seconds).
    const looney = byTime(state.pads.map((c, i) => (c && c.name.startsWith('Looney pic') && rt[i].buffer ? i : -1)).filter((i) => i >= 0)).filter((_, k) => k !== 12 && k !== 15);
    const panther = L.pp.filter((i) => state.pads[i].start >= 85);
    const pick = (id, ks) => { const list = byTime(padsOf(id)); return ks.map((k) => list[k]).filter((i) => i != null); };
    const woods = pick(WOODS, [3, 7, 12, 27, 2, 13, 8, 24, 15, 6, 11, 28]);
    const duel = pick(DUEL, [5, 14, 2, 21, 7, 24, 10, 17, 4, 26, 20, 8]);
    const apprentice = pick(APPRENTICE, [7, 5, 9, 4, 12, 14, 8, 10]);
    const wizards = [];
    for (let k = 0; k < 12; k++) for (const list of [woods, duel, apprentice]) if (list[k] != null) wizards.push(list[k]);
    const pg = hook(PG);
    const reel = [];
    for (let k = 0; k < 16; k++) {
      if (wizards.length) reel.push(wizards[k % wizards.length]);
      reel.push([looney[(k * 5 + 3) % looney.length], panther[k % Math.min(8, panther.length)], pg[k % pg.length]][k % 3]);
    }
    return [...new Set(reel)].filter((i) => i != null);
  };
  // Every video gets picture clips of its own. Each source's usable clips are dealt out like cards to
  // SLOTS videos (clip k goes to video k mod SLOTS), so no two videos ever share a clip. A video's reel
  // then interleaves its sources, wizard films first.
  const SLOTS = 6;
  const reelFor = (L, slot, count) => {
    const drop = (list, bad) => list.filter((_, k) => !bad.includes(k));
    const sources = [
      drop(byTime(padsOf(WOODS)), [0, 1, 14, 18, 29, 30, 31]), // logo, title, sketch, credits
      drop(byTime(padsOf(DUEL)), []),
      drop(byTime(padsOf(APPRENTICE)), [0, 1]), // logo, near-black
      drop(byTime(state.pads.map((c, i) => (c && c.name.startsWith('Looney pic') && rt[i].buffer ? i : -1)).filter((i) => i >= 0)), [12, 15]),
      byTime(L.pp.filter((i) => state.pads[i].start >= 85)), // past Pink Panther's opening credits
      // Peggy Gou: every third bar so shots differ, and not the title cards at either end of her video.
      byTime(padsOf(PG)).filter((i) => state.pads[i].start > 12 && state.pads[i].start < 176).filter((_, k) => k % 3 === 0),
    ].map((list) => list.filter((_, k) => k % SLOTS === slot % SLOTS));
    const reel = [];
    for (let round = 0; reel.length < count && sources.some((s) => s[round] != null); round++) {
      for (const s of sources) if (s[round] != null && reel.length < count) reel.push(s[round]);
    }
    return reel;
  };
  const oursBpm = () => bpmOf(OURS, 134.2);
  const FORGE_TITLES = [
    [0, { title: 'THE FORGE', sub: 'A decentralized exchange on the Chia blockchain', center: true }],
    [2, { title: 'Swap any pair', sub: 'Routed across Forge pools and Dexie' }],
    [4, { title: 'All at once, or not at all', sub: 'Every trade is a Chia offer you approve in your own wallet' }],
    [6, { title: 'Weighted N-asset pools', sub: 'Built on CHIP-0062' }],
    [8, { title: 'Provide liquidity, earn fees', sub: 'Or create a pool of your own' }],
    [10, { title: 'LP rewards, no staking', sub: 'Your LP token never leaves your wallet' }],
    [12, { title: 'Multisig locks', sub: 'Shared Chia vaults: several owners, a set number must approve' }],
    [14, { title: 'Enter the Beta', sub: 'at Forge.aWizard.dev', center: true }],
  ];

  // Three more angles. Every line is worded from forge.awizard.dev/docs or the titles of the Chia
  // Network talk on CHIP-0062; nothing here is a claim the site does not make.
  const END_CARD = { title: 'Enter the Beta', sub: 'at Forge.aWizard.dev', center: true };
  const CHIP_TITLES = [
    [0, { title: 'CHIP-0062', sub: 'Weighted N-asset AMMs on Chia', center: true }],
    [3, { title: 'One pool, many assets', sub: 'Weights fixed at birth' }],
    [6, { title: 'Truly one market', sub: 'Not forty copies of it' }],
    [9, { title: 'The Forge is built on it', sub: 'A decentralized exchange on the Chia blockchain' }],
    [12, { title: 'Swap. Provide liquidity. Earn fees.', sub: 'Every trade settles completely or not at all' }],
    [14, END_CARD],
  ];
  const LP_TITLES = [
    [0, { title: 'Put your tokens to work', sub: 'Liquidity pools on the Forge', center: true }],
    [2, { title: 'Earn a share of trading fees', sub: 'Add tokens to a Forge pool' }],
    [5, { title: 'Take them back out at any time', sub: 'Or create a new pool of your own' }],
    [8, { title: 'LP rewards', sub: 'Campaigns that pay in XCH or a CAT for the time you hold the LP token' }],
    [11, { title: 'No staking', sub: 'Your LP never leaves your wallet' }],
    [14, END_CARD],
  ];
  const SWAP_TITLES = [
    [0, { title: 'Swap on Chia', sub: 'The Forge', center: true }],
    [2, { title: 'The best route, found for you', sub: 'Across Forge pools and Dexie' }],
    [5, { title: 'The whole trade at once', sub: 'Or not at all' }],
    [8, { title: 'You approve every trade', sub: 'A Chia offer, in your own wallet' }],
    [10.5, { title: 'On the web or inside Sage', sub: 'Sage over WalletConnect, or the Forge app in the wallet' }],
    [12.5, { title: 'Markets read from the chain', sub: 'Prices, liquidity, volume and charts' }],
    [14, END_CARD],
  ];
  // From the collective's X profile (@aWizardxch) and the docs.
  const COLLECTIVE_TITLES = [
    [0, { title: 'aWizard Collective', sub: 'Started by the community', center: true }],
    [3, { title: 'Leaving you speechless', sub: '@aWizardxch' }],
    [6, { title: 'The Forge', sub: 'A decentralized exchange on the Chia blockchain' }],
    [9, { title: 'Weighted N-asset pools', sub: 'Built on CHIP-0062' }],
    [12, { title: 'Find us', sub: 'github.com/awizardxch · mintgarden.io/aWizard' }],
    [14, END_CARD],
  ];
  // Title times are written for a 16-bar piece and stretched to the piece's real length.
  const titled = (titles, bars = 16) => (at) => { for (const [bar, t] of titles) at((bar * bars) / 16, () => setOutputTitle(t)); };
  // Other tracks from the Contact album, one per promo, each at its own tempo.
  const ORANGES = 'KoscOXDZCgY'; // All Oranges Up
  const NETWORK = 'yuPIJfzr0uc'; // Wizard_Network.exe
  const SIGNAL = 'gtJ9fjGLF-o'; // Signal Rising
  const songPromo = (L, id, bars, titles, reel) => djSet(L, [{ id, bars, still: true }], { bpm: bpmOf(id, 128), pictures: reel, extra: titled(titles, bars) });

  // ---------- the 80s turntable style, done digitally ----------
  // The moves of a hip-hop DJ with two decks and a sampler, played on video: fast picture cuts,
  // transformer gating (the fader chopping the track into sixteenths), a beat juggle (one bar of the
  // track re-played in a new rhythm), cartoon sound stabs on the off-beats, a scratch-style wobble on a
  // sample, and an echo-out. Your track is the record; the cartoons are the crate of samples.
  // opts: { id, pictures, stabs, tone, titles } to play the same routine on another track and crate.
  function cut80s(L, opts = {}) {
    const id = opts.id || OURS;
    const list = byTime(padsOf(id));
    const d = decks[0];
    const vol = (v) => { d.vol = v; applyVolumes(); };
    const stabs = opts.stabs || L.rr;
    const tone = opts.tone !== undefined ? opts.tone : L.rrTone;
    return djSet(L, [{ id, bars: 16, still: true }], {
      bpm: bpmOf(id, 128), pictures: opts.pictures || reelFor(L, 5, 40), cut: 0.5,
      extra(at) {
        if (opts.titles) titled(opts.titles)(at);
        const pos = Math.max(0, Math.min(list.indexOf(hook(id)[0]), list.length - 18));
        const bar = list[pos + 4]; // the bar the juggle re-plays
        state.pads[bar].mode = 'oneshot';
        // Measured: at matched loudness these stabs sit about 10 dB hot in the 2-6 kHz band against the track, so they play well under it.
        for (const i of stabs) { state.pads[i].mode = 'oneshot'; state.pads[i].gain = 0.4; rt[i].pin = true; }
        rt[bar].pin = true;
        rt[bar].noPic = true; // the juggle is heard; the cartoon cuts keep the picture
        const sixteenths = (b, steps, fn) => steps.forEach((s, k) => at(b + s / 16, () => fn(k, s)));
        // Bar 3, second half: transformer.
        sixteenths(3.5, [0, 1, 2, 3, 4, 5, 6, 7], (k) => vol(k % 2 ? 1 : 0));
        // Bars 4-7: the record stops; one bar of it is juggled, with stabs answering.
        at(4, () => { vol(1); setDeckPlaying(d, false); setBlend(0.02); });
        sixteenths(4, [0, 4, 8, 10, 12, 14], () => hit(bar));
        sixteenths(5, [0, 4, 8, 10, 12, 14], () => hit(bar));
        sixteenths(6, [0, 2, 4, 6, 8, 10, 12, 13, 14, 15], () => hit(bar));
        sixteenths(7, [0, 4, 8, 12], () => hit(bar));
        for (const b of [4, 5, 7]) sixteenths(b, [6, 14], (k) => hit(stabs[(b + k) % stabs.length]));
        sixteenths(7, [2, 10], (k) => hit(stabs[(k + 2) % stabs.length]));
        // Bar 8: the record comes back in on the one.
        at(8, () => { stop(bar, true); setDeckPlaying(d, true); });
        for (const b of [8, 9, 10]) sixteenths(b, [6, 14], (k) => hit(stabs[(b + k) % stabs.length]));
        // Bar 11, second half: scratch-style wobble on a sample while the fader is closed.
        if (tone != null) {
          const dur = rt[tone].buffer.duration;
          state.pads[tone].mode = 'loop';
          // Level match brings any sound to the track's loudness; the old Road Runner tone still measured
          // 18 dB under (it was mostly silence), a Felix tone measured 5 dB over at 2.5. Default to 0.6.
          state.pads[tone].gain = opts.toneGain || (opts.tone !== undefined ? 0.6 : 2.5);
          rt[tone].pin = true;
          state.pads[tone].loop = { start: 0, end: dur, bpm: null, beats: null, beatLen: null, v: 2 };
          at(11.5, () => { vol(0); hit(tone); });
          sixteenths(11.5, [0, 1, 2, 3, 4, 5, 6, 7], (k) => {
            const v = rt[tone].voice;
            if (v && v.src) v.src.playbackRate.setTargetAtTime([0.5, 1.9, 0.6, 1.7, 0.45, 2.1, 0.7, 1.3][k], ctx.currentTime, 0.012);
          });
          at(12, () => { stop(tone, true); vol(1); });
        }
        // Bar 15: echo-out, the same stab repeating quieter each beat.
        [0.4, 0.25, 0.15, 0.08].forEach((g, k) => at(15 + k / 4, () => { state.pads[stabs[0]].gain = g; hit(stabs[0]); }));
      },
    });
  }

  // ---------- the second crate: all-new picture, tracks and sounds ----------
  // Felix the Cat (The Magic Bag, 1958), Betty Boop (Snow-White, 1933), Fleischer Superman (The
  // Magnetic Telescope, 1942), and six Contact tracks not used before. Indexes dropped by eye from
  // the thumbnail sheet: title cards, logos, credits, near-black frames.
  const FELIX = 'lE9J0QypBM0';
  const BETTY = 'cKOSJ5AAwfc';
  const SUPES = '_ZZ-atqiXpo';
  const MOTHERSHIP = '9j7aF6Ovz70';
  const PARTY = '_7H4QeI7FUY';
  const FREAKHZ = 'cjlxW-fEc8U';
  const MANA = 'K9CEjN9sZQE';
  const newPics = (id) => byTime(state.pads.map((c, i) => (c && c.sourceId === id && c.name.startsWith('New pic') && rt[i].buffer ? i : -1)).filter((i) => i >= 0));
  // Dealt across three promos, so no promo shares a clip with another.
  const reel2 = (slot, count) => {
    const drop = (list, bad) => list.filter((_, k) => !bad.includes(k));
    const sources = [drop(newPics(FELIX), [0]), drop(newPics(BETTY), [0, 1, 2, 3]), drop(newPics(SUPES), [0, 10])]
      .map((list) => list.filter((_, k) => k % 3 === slot));
    const reel = [];
    for (let round = 0; reel.length < count && sources.some((s) => s[round] != null); round++) {
      for (const s of sources) if (s[round] != null && reel.length < count) reel.push(s[round]);
    }
    return reel;
  };
  const newSounds = () => state.pads.map((c, i) => (c && c.name.startsWith('New sound') && rt[i].buffer ? i : -1)).filter((i) => i >= 0);

  // ---------- "Chips" by Choctaw Wildfire as a dance record: the rodeo edit and the full mix ----------
  // A traditional when-you're-down-get-back-up rodeo country song, played by a live band (139.7 BPM
  // on average, drifting 138-142 from phrase to phrase), C major. Two pieces:
  //   rodeoEdit  33 bars: the intro, verse with the groove, the pre-chorus as a build, the chorus as the drop
  //   rodeoFull  the whole song, every lyric: the record plays uncut and the dance arrangement goes around it
  // Timing: the record's beats are tracked (src/beats.js); the beat box plays on them (follow mode)
  // and every scripted event lands on the record's own bars (`timeOf`), never on a fixed clock,
  // which drifted up to 50 ms off the band. Low end: no synth bass line (its notes were guesses);
  // the record's own bass is boosted in the drops and pumped by the kick, always in tune and in time.
  // Picture tells the song: the dive bar and the night rodeo, trucks in the mud, cowboys, riders
  // thrown into the dirt, getting back up, the ride, the open road. Mushrooms only glow in the
  // breakdowns. Song sections (scripts/vocals.js with scripts/bars.js, in the app's bar numbers):
  //   0-15 intro, band in | 16-31 sung | 32-39 instrumental | 40-71 sung | 72-87 instrumental |
  //   88-119 sung | 120-135 instrumental | 136-167 sung | 168-183 mixed | 184-199 outro
  const CHIPS = 'diy32tpiipE';
  const sources = {
    gallup: 'dIayNv1S9HU', // Gallup, NM, 1951 night rodeo (home movie)
    reno: '2SV7jcq3ums', // Reno Rodeo, 1950s, restored
    cowboy: '7dZUDluKtBw', // American Cowboy (1950), color
    roadtrip: 'Ist-yZtDIWg', // old trucks road trip (trucks and land only; no faces)
    k10: '89Yq_ezBOrg', // a Chevy K10 in the mud
    neon: 'iKiAgbS6-6Y', // a beer neon sign
    juke47: 'rIVFuYYfS7s', // 1947 Wurlitzer
    juke56: 'RHuGWiTQ6Fg', // 1956 Wurlitzer
    axford: 'nPN--7j5mdI', // fungi time-lapses (glowing accents)
    glow: '-zXzhzEa1aQ', // glowing Mycena
  };
  // Kept by eye from the thumbnail sheets (indexes in time order): no credits, no watermarks, no
  // near-black frames, no brand signs, no private people's faces.
  const keep = {
    gallup: [1, 2, 3, 8, 9, 10, 11, 13, 14, 15, 17, 22, 23, 26, 27, 28, 29, 31, 35, 36, 38],
    fire: [39, 40, 41, 42, 43, 44, 45, 46].map((k) => ['gallup', k]),
    // Reno clips 2 ("RENO Rodeo" poster), 6 and 9 ("JULY 4th", "EVERY JULY" banners) are text: out.
    // Found on a sheet of three frames per clip; a first-frame sheet missed them.
    bucking: [4, 5, 7, 8, 11, 14],
    down: [10, 12, 13, 15],
    grand: [0, 1, 3],
    ranch: [0, 3, 4, 5, 6, 7, 8, 9, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28, 31, 32, 33, 39, 40, 41],
    faces: [11, 13, 27, 29, 42, 43, 44, 45, 47],
    drive: [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62],
    // Road trip vlog: only clips with no faces at any point (checked at 15/50/85% of each clip).
    roadtrip: [5, 6, 11, 12, 25, 29, 30, 31, 32, 33, 34],
    k10: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    neon: [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15],
    juke: [...Array.from({ length: 16 }, (_, k) => ['juke47', k]), ...[0, 4, 5, 10, 11, 14, 15].map((k) => ['juke56', k])],
    // Fungi: only clips without the narrator's captions anywhere in them.
    glow: [...[2, 10, 13, 15, 22, 23, 24, 26, 27, 28].map((k) => ['axford', k]), ['glow', 0]], // the Mycena tutorial subtitles its other glowing shots
  };
  const clipsOf = (id) => byTime(state.pads.map((c, i) => (c && c.sourceId === id ? i : -1)).filter((i) => i >= 0));
  function rodeoPools() {
    const by = {};
    for (const [name, id] of Object.entries(sources)) by[name] = clipsOf(id);
    const from = (src, list) => list.map((k) => (Array.isArray(k) ? by[k[0]][k[1]] : by[src][k])).filter((i) => i != null);
    return {
      nightRodeo: from('gallup', keep.gallup),
      fire: from('gallup', keep.fire),
      bucking: from('reno', keep.bucking),
      down: from('reno', keep.down),
      grand: from('reno', keep.grand),
      ranch: from('cowboy', keep.ranch),
      faces: from('cowboy', keep.faces),
      drive: from('cowboy', keep.drive),
      road: from('roadtrip', keep.roadtrip),
      mud: from('k10', keep.k10),
      neon: from('neon', keep.neon),
      juke: from(null, keep.juke),
      glow: from(null, keep.glow),
    };
  }

  // The record, tracked: beats plus the index of the beat that starts the app's bar `bar`.
  async function trackChips() {
    const s = state.sources.find((x) => x.id === CHIPS);
    const song = byTime(padsOf(CHIPS));
    if (song.length < 199) throw new Error(`"Chips" has ${song.length} bar clips; cut it whole in one-bar clips first`);
    const tr = await window.api.beats({ file: s.file, bpm: s.bpm || 139.7 });
    // Bar numbers follow the app's one-bar clips (the section map uses them): find the tracked beat
    // at the start of clip-bar 8 and count back.
    const at8 = state.pads[song[8]].start;
    let i8 = 0;
    tr.beats.forEach((t, i) => { if (Math.abs(t - at8) < Math.abs(tr.beats[i8] - at8)) i8 = i; });
    const barIndex = i8 - 32; // beat index of bar 0 (may be negative; the grid is extended)
    const barTime = (b) => followSongTime({ beats: tr.beats, down: barIndex }, b * 16); // song seconds of bar b (fractional)
    return { s, song, tr, barIndex, barTime, snap: Math.abs(tr.beats[i8] - at8) };
  }

  async function cueChips(d, s, songTime) {
    await loadDeck(d, { kind: 'source', title: s.title, url: s.url, file: s.file, bpm: s.bpm || 139.7 });
    if (!d.video.duration) await new Promise((r) => d.video.addEventListener('loadedmetadata', r, { once: true }));
    d.video.currentTime = songTime;
    d.rate = 1;
    applyRate(d);
    d.vol = 1;
    d.q('vol').value = 1;
    d.loop = false;
  }

  // Picture cuts: `section(from, to, step, pools)` deals clips round robin from the named pools;
  // a clip comes back only once its pool has been used up. Videos are pinned a few cuts ahead and
  // let go after use.
  function picturePlan(pools, barSeconds = 240 / 139.7) {
    const pos = {};
    // A clip must last as long as its cut: a one-shot that ends early leaves the viewer on the deck's
    // own picture (for a record, its cover art), which flashed up in the first render.
    const dur = (i) => state.pads[i].end - state.pads[i].start;
    const take = (name, need) => {
      const p = pools[name];
      const k0 = pos[name] || 0;
      for (let tries = 0; tries < p.length; tries++) {
        const i = p[(k0 + tries) % p.length];
        if (dur(i) >= need) { pos[name] = k0 + tries + 1; return i; }
      }
      throw new Error(`no clip in "${name}" lasts ${need.toFixed(1)} s`);
    };
    const cuts = [];
    const section = (from, to, step, names, soft) => {
      let k = 0;
      for (let b = from; b < to - 0.001;) {
        const s = typeof step === 'function' ? step(b) : step;
        cuts.push([b, take(names[k++ % names.length], s * barSeconds + 0.4), soft ? 0.6 : 0.12]);
        b += s;
      }
    };
    const faster = (from, to) => (b) => (b < from + (to - from) / 2 ? 1 : b < to - 2 ? 0.5 : 0.25);
    return { cuts, section, faster };
  }
  async function preparePictures(pools, first) {
    for (const i of Object.values(pools).flat()) { state.pads[i].mode = 'oneshot'; state.pads[i].gain = 0; }
    for (const i of first) rt[i].pin = true;
    syncVideos();
    await wait(2000);
  }
  function scheduleCuts(at, cuts) {
    const AHEAD = 5;
    let prev = null;
    cuts.forEach(([b, i, blendS], k) => {
      const was = prev;
      at(b + 0.01, () => {
        setBlend(blendS);
        hit(i);
        if (was != null && was !== i) {
          stop(was);
          if (!cuts.slice(k, k + AHEAD + 1).some(([, j]) => j === was)) setTimeout(() => { rt[was].pin = false; syncVideos(); }, 1200);
        }
        if (cuts[k + AHEAD]) { rt[cuts[k + AHEAD][1]].pin = true; syncVideos(); }
      });
      prev = i;
    });
  }

  const FULL = { kick: true, clap: true, hat: true, closed: true, bass: false };
  const NONE = { kick: false, clap: false, hat: false, closed: false, bass: false };

  async function rodeoEdit() {
    const { s, song, tr, barIndex, barTime, snap } = await trackChips();
    const BPM = tr.bpm;
    const pools = rodeoPools();
    // Piece bars 0-15 are song bars 0-15 on deck A; 16-32 are song bars 112-128 on deck B
    // (the pre-chorus runs straight into the chorus).
    const [A, B] = window.__demoSwap ? [decks[1], decks[0]] : decks; // DEMO_SWAP=1 trades the decks' roles (a timing test)
    await cueChips(A, s, barTime(0));
    await cueChips(B, s, barTime(112));
    applyVolumes();
    setDeckLowCut(0);
    const songOfPiece = (b) => (b < 16 ? barTime(b) : barTime(112 + b - 16));
    const t16 = (barTime(16) - barTime(0)) * 1000;
    const timeOf = (b) => (b < 16 ? (barTime(b) - barTime(0)) * 1000 : t16 + (barTime(112 + b - 16) - barTime(112)) * 1000);
    const { cuts, section, faster } = picturePlan(pools);
    section(0, 8, 2, ['juke', 'nightRodeo', 'neon', 'nightRodeo'], true);
    section(8, 16, 1, ['mud', 'ranch', 'faces', 'road']);
    section(16, 24, faster(16, 24), ['down', 'bucking', 'glow']);
    section(24, 33, 0.5, ['bucking', 'drive', 'fire', 'ranch', 'nightRodeo', 'grand']);
    await preparePictures(pools, cuts.slice(0, 5).map((c) => c[1]));
    select(cuts[0][1]);
    const follow = (d, songBar, pieceBar) => ({ deck: d, beats: tr.beats, down: barIndex + 4 * (songBar - pieceBar), offset: 0 });
    return {
      bpm: BPM, bars: 33, keepDeckTime: true, timeOf,
      info: { tracked: tr.bpm, snapMs: Math.round(snap * 1000), chosen: tr.chosen },
      events(at) {
        scheduleCuts(at, cuts);
        at(0, () => {
          fade(A.idx);
          setDeckPlaying(A, true);
          startBeat({ bpm: BPM, duck: 0, parts: NONE, follow: follow(A, 0, 0) });
          beat.hats = 0.18;
          Object.assign(fx, { mode: 'shroom', amount: 0.3, trails: 0.35, beat: 0, spin: 0.4, bpm: BPM, t0: performance.now() / 1000 });
          setOutputTitle({ title: 'Chips', sub: 'Choctaw Wildfire · Mixmage rodeo edit' });
        });
        at(4, () => setBeatParts({ closed: true }));
        at(6, () => { setBeatParts({ hat: true }); setOutputTitle(null); });
        at(8, () => { beat.hats = 1; beat.duck = 0.15; setBeatParts({ kick: true }); Object.assign(fx, { amount: 0.6, beat: 0.5, spin: 0.7, trails: 0.45 }); });
        at(12, () => setBeatParts({ clap: true }));
        // The build: deck B takes over on the pre-chorus; the beat follows it from here.
        at(16, () => {
          fade(B.idx);
          setDeckPlaying(B, true);
          setDeckPlaying(A, false);
          console.log('EAR deckA ' + JSON.stringify({ ear: beat.follow && Math.round((beat.follow.ear || 0) * 1000), steps: beat.follow && beat.follow.earLog }));
          beat.follow = follow(B, 112, 16);
          setBeatParts({ clap: false });
          beat.duck = 0.12;
          beat.roll = { from: 20, to: 24 };
          fx.mode = 'mirror';
        });
        for (let k = 0; k <= 32; k++) at(16 + (k / 32) * 7.75, () => { setDeckLowCut(0.75 * (k / 32) ** 1.6, 0.25); fx.amount = 0.65 + 0.35 * (k / 32); fx.spin = 1 + 2 * (k / 32); fx.trails = 0.45 + 0.35 * (k / 32); });
        at(20, () => { setBeatParts({ kick: false, hat: false, closed: false }); riser(ctx.currentTime, (songOfPiece(24) - songOfPiece(20)) - 0.05); });
        at(23.75, () => { B.vol = 0; applyVolumes(); });
        at(24, () => {
          setDeckLowCut(0, 0.01);
          B.vol = 1;
          applyVolumes();
          setDeckBass(B, 1.08); // the record's own bass, up about 1 dB, pumped by the kick
          beat.roll = null;
          beat.duck = 0.3;
          setBeatParts(FULL);
          Object.assign(fx, { amount: 1, beat: 1, spin: 1.6, trails: 0.6 });
          fxFlash();
        });
        at(28, () => { fx.mode = 'shroom'; fxFlash(); });
        at(30, () => { fx.mode = 'mirror'; });
        at(32, () => {
          setBeatParts({ ...NONE, kick: true });
          setDeckBass(B, 1);
          fxFlash();
          setOutputTitle({ title: 'Chips', sub: 'Choctaw Wildfire', center: true });
        });
        at(32.1, () => setBeatParts(NONE));
        for (let k = 0; k <= 24; k++) at(32 + k / 24, () => { B.vol = 1 - k / 24; applyVolumes(); fx.amount = 1 - 0.5 * (k / 24); });
        at(32.9, () => console.log('EAR deckB ' + JSON.stringify({ ear: beat.follow && Math.round((beat.follow.ear || 0) * 1000), steps: beat.follow && beat.follow.earLog })));
        at(32.97, () => stopBeat());
      },
    };
  }

  async function rodeoFull() {
    const { s, tr, barIndex, barTime, snap } = await trackChips();
    const BPM = tr.bpm;
    const pools = rodeoPools();
    const A = decks[0];
    await cueChips(A, s, barTime(0));
    applyVolumes();
    setDeckLowCut(0);
    const timeOf = (b) => (barTime(b) - barTime(0)) * 1000;
    const { cuts, section, faster } = picturePlan(pools);
    section(0, 8, 2, ['juke', 'nightRodeo', 'neon', 'nightRodeo'], true); // the bar and the arena lights
    section(8, 16, 1, ['mud', 'road', 'mud', 'ranch']); // the old truck
    section(16, 32, 2, ['faces', 'ranch', 'road', 'ranch']); // cowboy life under verse one
    section(32, 40, faster(32, 40), ['bucking', 'nightRodeo']); // the first build: the buckers
    section(40, 72, 1, ['bucking', 'ranch', 'nightRodeo', 'drive', 'faces', 'grand']);
    section(72, 80, 2, ['down', 'glow', 'down', 'nightRodeo'], true); // the chips are down: thrown into the dirt
    section(80, 88, faster(80, 88), ['mud', 'bucking', 'faces']); // getting back up
    section(88, 120, 1, ['bucking', 'drive', 'road', 'nightRodeo', 'ranch', 'faces']);
    section(120, 136, 0.5, ['fire', 'bucking', 'fire', 'drive', 'nightRodeo', 'mud']); // the big drop
    section(136, 144, 2, ['juke', 'neon', 'glow', 'juke'], true); // back in the dive bar
    section(144, 152, faster(144, 152), ['mud', 'road', 'bucking']);
    section(152, 168, 1, ['bucking', 'drive', 'grand', 'ranch', 'nightRodeo', 'faces']);
    section(168, 184, 0.5, ['drive', 'bucking', 'fire', 'ranch', 'mud', 'grand']);
    section(184, 200, 2, ['drive', 'road', 'neon', 'juke'], true); // the open road home
    await preparePictures(pools, cuts.slice(0, 5).map((c) => c[1]));
    select(cuts[0][1]);
    const BAR = (b) => (barTime(b + 1) - barTime(b)) * 0.999; // a bar's length in seconds, here
    return {
      bpm: BPM, bars: 200, keepDeckTime: true, timeOf,
      info: { tracked: tr.bpm, snapMs: Math.round(snap * 1000), chosen: tr.chosen },
      events(at) {
        scheduleCuts(at, cuts);
        const look = (o) => () => Object.assign(fx, o);
        const sweep = (from, to, a, b) => { for (let k = 0; k <= 24; k++) at(from + ((to - from) * k) / 24, () => setDeckLowCut(a + (b - a) * (k / 24) ** 1.6, 0.25)); };
        const riseTo = (from, to) => riser(ctx.currentTime, barTime(to) - barTime(from) - 0.05);
        const build = (from, to, { gap }) => {
          at(from, () => { fx.mode = 'mirror'; });
          const mid = from + (to - from) / 2;
          at(mid, () => { setBeatParts({ kick: false, hat: false, clap: false }); beat.roll = { from: mid, to }; riseTo(mid, to); });
          for (let k = 0; k <= 16; k++) at(from + ((to - from) * k) / 16, () => { fx.amount = 0.65 + 0.35 * (k / 16); fx.spin = 0.8 + 2.2 * (k / 16); fx.trails = 0.45 + 0.35 * (k / 16); });
          if (gap) at(to - 0.25, () => { A.vol = 0; applyVolumes(); });
        };
        const drop = (bar, o) => at(bar, () => {
          A.vol = 1;
          applyVolumes();
          setDeckLowCut(0, 0.01);
          setDeckBass(A, o.bass || 1.08);
          beat.roll = null;
          beat.duck = o.duck;
          setBeatParts(FULL);
          Object.assign(fx, { mode: o.mode || 'shroom', amount: o.amount, beat: o.beat, spin: 1.2, trails: 0.55 });
          fxFlash();
        });
        const lull = (bar, o) => at(bar, () => { setBeatParts({ ...NONE, ...o.parts }); beat.hats = 0.5; beat.duck = 0; setDeckBass(A, 1); Object.assign(fx, { mode: 'shroom', amount: o.amount, beat: 0.15, spin: 0.3, trails: 0.8 }); });

        // Intro and band-in (0-15)
        at(0, () => {
          fade(0);
          setDeckPlaying(A, true);
          startBeat({ bpm: BPM, duck: 0, parts: NONE, follow: { deck: A, beats: tr.beats, down: barIndex, offset: 0 } });
          beat.hats = 0.18;
          Object.assign(fx, { mode: 'shroom', amount: 0.3, trails: 0.35, beat: 0, spin: 0.4, bpm: BPM, t0: performance.now() / 1000 });
          setOutputTitle({ title: 'Chips', sub: 'Choctaw Wildfire · Mixmage rodeo mix' });
        });
        at(4, () => setBeatParts({ closed: true }));
        at(6, () => { setBeatParts({ hat: true }); setOutputTitle(null); });
        at(8, () => { beat.hats = 1; beat.duck = 0.15; setBeatParts({ kick: true }); look({ amount: 0.55, beat: 0.5, spin: 0.7, trails: 0.45 })(); fxFlash(); });
        // Verse one (16-31): the groove under the voice
        at(16, look({ amount: 0.6, beat: 0.4 }));
        at(24, () => setBeatParts({ clap: true }));
        // Instrumental turnaround (32-39): the first build, one beat of silence
        sweep(32, 39.75, 0, 0.7);
        build(32, 40, { gap: true });
        drop(40, { duck: 0.22, amount: 0.85, beat: 0.8 }); // sung (40-71)
        at(56, () => fxFlash());
        // Instrumental (72-87): the breakdown, then the second build
        lull(72, { parts: { hat: true }, amount: 0.6 });
        at(72, () => setDeckLowCut(0.35, 2 * BAR(72)));
        at(80, () => { beat.hats = 1; beat.duck = 0.15; setBeatParts({ kick: true, closed: true }); });
        sweep(80, 87.75, 0.35, 0.75);
        build(80, 88, { gap: true });
        drop(88, { duck: 0.25, amount: 0.9, beat: 0.9 }); // sung (88-119)
        at(104, look({ mode: 'mirror' }));
        at(112, look({ mode: 'shroom' }));
        at(116, () => { beat.roll = { from: 116, to: 120 }; riseTo(116, 120); }); // sung: a roll, no silence
        drop(120, { duck: 0.3, amount: 1, beat: 1, mode: 'mirror', bass: 1.12 }); // instrumental: the big drop
        for (const b of [124, 128, 132]) at(b, () => { fxFlash(); fx.mode = fx.mode === 'mirror' ? 'shroom' : 'mirror'; });
        // Sung (136-151): a quiet breakdown in the bar, then the third build (low cut stays open)
        lull(136, { parts: { closed: true }, amount: 0.5 });
        at(144, () => { beat.hats = 1; beat.duck = 0.15; setBeatParts({ kick: true, hat: true }); });
        at(148, () => { beat.roll = { from: 148, to: 152 }; riseTo(148, 152); fx.mode = 'mirror'; });
        for (let k = 0; k <= 16; k++) at(144 + k / 2, () => { fx.amount = 0.6 + 0.4 * (k / 16); fx.spin = 0.6 + 2 * (k / 16); });
        drop(152, { duck: 0.28, amount: 1, beat: 1 }); // the final drop (152-183)
        for (const b of [160, 168, 176]) at(b, () => { fxFlash(); fx.mode = fx.mode === 'mirror' ? 'shroom' : 'mirror'; });
        // Outro (184-199): the beat strips away and the record ends on its own chord
        at(184, () => { setBeatParts({ clap: false }); beat.duck = 0.18; setDeckBass(A, 1.04); Object.assign(fx, { mode: 'shroom', amount: 0.8, beat: 0.6, spin: 0.6 }); });
        at(188, () => { setBeatParts({ hat: false }); setDeckBass(A, 1); });
        at(190, () => setBeatParts({ closed: false }));
        at(192, () => { setBeatParts(NONE); beat.duck = 0; fxFlash(); });
        for (let k = 0; k <= 16; k++) at(192 + k / 2, () => { fx.amount = 0.8 - 0.5 * (k / 16); fx.spin = 0.6 - 0.4 * (k / 16); });
        at(194, () => setOutputTitle({ title: 'Chips', sub: 'Choctaw Wildfire · Mixmage rodeo mix', center: true }));
        for (const b of [40, 88, 120, 152, 192]) at(b - 0.05, () => console.log('EAR bar' + b + ' ' + JSON.stringify({ ear: beat.follow && Math.round((beat.follow.ear || 0) * 1000), steps: beat.follow && beat.follow.earLog })));
        at(199.9, () => stopBeat());
      },
    };
  }

  // The music video: "Chips" exactly as recorded, start to finish, with the rodeo story cut to its
  // bars and Shroom FX breathing on the band's tracked beats. Nothing is added to the sound; after the
  // render, scripts/original-audio.js replaces the recorded sound with the original file's, lined up
  // to the millisecond (the app's output passes its limiter, which would squash a mastered record).
  async function rodeoVideo() {
    const { s, tr, barTime, snap } = await trackChips();
    const pools = rodeoPools();
    const A = decks[0];
    await cueChips(A, s, barTime(0));
    applyVolumes();
    setDeckLowCut(0);
    setDeckBass(A, 1);
    const timeOf = (b) => (barTime(b) - barTime(0)) * 1000;
    const { cuts, section, faster } = picturePlan(pools);
    section(0, 8, 2, ['juke', 'nightRodeo', 'neon', 'nightRodeo'], true); // the bar and the arena lights
    section(8, 16, 1, ['mud', 'road', 'mud', 'ranch']); // the old truck as the band comes in
    section(16, 32, 2, ['faces', 'ranch', 'road', 'ranch']); // cowboy life under verse one
    section(32, 40, faster(32, 40), ['bucking', 'nightRodeo']); // the buckers
    section(40, 72, 1, ['bucking', 'ranch', 'nightRodeo', 'drive', 'faces', 'grand']);
    section(72, 80, 2, ['down', 'glow', 'down', 'nightRodeo'], true); // the chips are down: thrown into the dirt
    section(80, 88, faster(80, 88), ['mud', 'bucking', 'faces']); // getting back up
    section(88, 120, 1, ['bucking', 'drive', 'road', 'nightRodeo', 'ranch', 'faces']);
    section(120, 136, 0.5, ['fire', 'bucking', 'fire', 'drive', 'nightRodeo', 'mud']); // the band lets loose
    section(136, 144, 2, ['juke', 'neon', 'glow', 'juke'], true); // back in the dive bar
    section(144, 152, faster(144, 152), ['mud', 'road', 'bucking']);
    section(152, 168, 1, ['bucking', 'drive', 'grand', 'ranch', 'nightRodeo', 'faces']);
    section(168, 184, 0.5, ['drive', 'bucking', 'fire', 'ranch', 'mud', 'grand']);
    section(184, 200, 2, ['drive', 'road', 'neon', 'juke'], true); // the open road home
    await preparePictures(pools, cuts.slice(0, 5).map((c) => c[1]));
    select(cuts[0][1]);
    return {
      bpm: tr.bpm, bars: 200, keepDeckTime: true, timeOf,
      info: { tracked: tr.bpm, snapMs: Math.round(snap * 1000), chosen: tr.chosen },
      events(at) {
        scheduleCuts(at, cuts);
        const look = (o, flash) => () => { Object.assign(fx, o); if (flash) fxFlash(); };
        const ramp = (from, to, a, b) => { for (let k = 0; k <= 16; k++) at(from + ((to - from) * k) / 16, () => { fx.amount = a + (b - a) * (k / 16); fx.spin = 0.4 + 1.4 * (k / 16); }); };
        at(0, () => {
          fade(0);
          setDeckPlaying(A, true);
          Object.assign(fx, { mode: 'shroom', amount: 0.25, trails: 0.35, beat: 0.15, spin: 0.35, bpm: tr.bpm, follow: { deck: A, beats: tr.beats } });
          setOutputTitle({ title: 'Chips', sub: 'Choctaw Wildfire' });
        });
        at(6, () => setOutputTitle(null));
        at(8, look({ amount: 0.45, beat: 0.35, spin: 0.55, trails: 0.45 }, true)); // the band comes in
        at(16, look({ amount: 0.4, beat: 0.3 })); // verse one
        at(32, look({ mode: 'mirror', amount: 0.65, beat: 0.6, spin: 1.2 })); // instrumental
        at(40, look({ mode: 'shroom', amount: 0.6, beat: 0.6, spin: 0.9 }, true));
        at(72, look({ mode: 'shroom', amount: 0.45, beat: 0.2, spin: 0.3, trails: 0.75 })); // down in the dirt
        ramp(80, 88, 0.45, 0.85); // getting up
        at(84, look({ mode: 'mirror' }));
        at(88, look({ mode: 'shroom', amount: 0.7, beat: 0.7, spin: 1, trails: 0.5 }, true));
        at(104, look({ mode: 'mirror' }));
        at(112, look({ mode: 'shroom' }));
        at(120, look({ mode: 'mirror', amount: 1, beat: 1, spin: 1.5, trails: 0.6 }, true)); // the band lets loose
        for (const b of [124, 128, 132]) at(b, () => { fxFlash(); fx.mode = fx.mode === 'mirror' ? 'shroom' : 'mirror'; });
        at(136, look({ mode: 'shroom', amount: 0.45, beat: 0.2, spin: 0.3, trails: 0.8 })); // the dive bar
        ramp(144, 152, 0.45, 0.85);
        at(148, look({ mode: 'mirror' }));
        at(152, look({ mode: 'shroom', amount: 0.9, beat: 0.9, spin: 1.2, trails: 0.55 }, true)); // last chorus
        for (const b of [160, 168, 176]) at(b, () => { fxFlash(); fx.mode = fx.mode === 'mirror' ? 'shroom' : 'mirror'; });
        at(184, look({ mode: 'shroom', amount: 0.6, beat: 0.4, spin: 0.4 })); // the road home
        for (let k = 0; k <= 16; k++) at(192 + k / 2, () => { fx.amount = 0.6 - 0.35 * (k / 16); });
        at(194, () => setOutputTitle({ title: 'Chips', sub: 'Choctaw Wildfire', center: true }));
      },
    };
  }

  // ---------- variants ----------
  const variants = {
    rodeoVideo,
    rodeoEdit,
    rodeoFull,
    promo,
    cut80s,
    // 80s cut on "Mothership", Felix/Betty sounds as the stabs and scratch, swap titles.
    style80s: (L) => {
      const snd = newSounds();
      const stabs = snd.filter((i) => rt[i].buffer.duration < 0.7).sort((x, y) => loudness(y) - loudness(x)).slice(0, 4);
      const tone = snd.find((i) => state.pads[i].root != null && state.pads[i].root >= 55 && state.pads[i].root <= 80 && rt[i].buffer.duration > 0.35 && !stabs.includes(i));
      return cut80s(L, { id: MOTHERSHIP, pictures: reel2(0, 40), stabs, tone: tone == null ? null : tone, titles: SWAP_TITLES });
    },
    // Smooth house blend: "Freak Hz" (123.0) into "aWizard Party" (124.1), 0.9% apart, CHIP-0062 titles.
    styleSmooth: (L) => djSet(L, [{ id: FREAKHZ, bars: 14, still: true, mix: 8 }, { id: PARTY, bars: 8, still: true }], {
      bpm: bpmOf(FREAKHZ, 123), pictures: reel2(1, 30), extra: titled(CHIP_TITLES, 22),
    }),
    // Bass play on "Mana Festation": two-bar cut slammed back on 9, a half-bar cut into 13; LP titles.
    styleBass: (L) => djSet(L, [{ id: MANA, bars: 16, still: true }], {
      bpm: bpmOf(MANA, 128.4), pictures: reel2(2, 30),
      extra(at) {
        titled(LP_TITLES)(at);
        const d = decks[0];
        at(6, () => setDeckBass(d, 0));
        at(8, () => setDeckBass(d, 1));
        at(11.5, () => setDeckBass(d, 0));
        at(12, () => setDeckBass(d, 1));
      },
    }),
    // The live-set blend: two records within 1.5% of each other in tempo, 8 bars together, bass swapped half-way.
    live1: (L) => djSet(L, [{ id: OURS, bars: 12, still: true, mix: 8 }, { id: PG, bars: 6 }], { bpm: oursBpm(), pictures: reelFor(L, 0, 20) }),
    // The bass-play style (IDRIS): the low end is cut for a few bars and slammed back on the phrase.
    // Found You alone, bass out for bars 6-7 and again for the last half of bar 11, back on 8 and 12.
    live3: (L) => djSet(L, [{ id: OURS, bars: 16, still: true }], {
      bpm: oursBpm(), pictures: reelFor(L, 2, 20),
      extra(at) {
        const d = decks[0];
        at(6, () => setDeckBass(d, 0));
        at(8, () => setDeckBass(d, 1));
        at(11.5, () => setDeckBass(d, 0));
        at(12, () => setDeckBass(d, 1));
      },
    }),
    live2: (L) => djSet(L, [{ id: ORANGES, bars: 14, still: true, mix: 8 }, { id: NETWORK, bars: 8, still: true }], { bpm: bpmOf(ORANGES, 161.5), pictures: reelFor(L, 1, 30) }),
    // CHIP-0062: Peggy Gou opens, roll, drop into your track.
    promo3: (L) => djSet(L, [{ id: PG, bars: 6 }, { id: OURS, bars: 10, still: true }], { bpm: oursBpm(), pictures: reelFor(L, 1, 20), extra: titled(CHIP_TITLES) }),
    // Liquidity providers, on "All Oranges Up".
    promo4: (L) => songPromo(L, ORANGES, 20, LP_TITLES, reelFor(L, 2, 24)),
    // Traders, on "Wizard_Network.exe".
    promo5: (L) => songPromo(L, NETWORK, 20, SWAP_TITLES, reelFor(L, 3, 24)),
    // The collective, on "Signal Rising".
    promo6: (L) => songPromo(L, SIGNAL, 16, COLLECTIVE_TITLES, reelFor(L, 4, 20)),
    // Your track for 16 bars, a new picture on every bar.
    ours1: (L) => djSet(L, [{ id: OURS, bars: 16, still: true }], { bpm: oursBpm(), pictures: reelFor(L, 5, 20) }),
    // Your track, roll, drop into Peggy Gou with her own video.
    ours2: (L) => djSet(L, [{ id: OURS, bars: 8, still: true }, { id: PG, bars: 8 }], { bpm: oursBpm(), pictures: reelFor(L, 4, 20) }),
    // Peggy Gou first, roll, drop into your track.
    ours3: (L) => djSet(L, [{ id: PG, bars: 6 }, { id: OURS, bars: 10, still: true }], { bpm: oursBpm(), pictures: reelFor(L, 3, 20) }),
    // The Forge promo on your own track: same titles, cartoon and Peggy Gou picture.
    promo2: (L) => djSet(L, [{ id: OURS, bars: 16, still: true }], {
      bpm: oursBpm(), pictures: reelFor(L, 0, 20),
      extra(at) { for (const [bar, t] of FORGE_TITLES) at(bar, () => setOutputTitle(t)); },
    }),
    // Pink Panther cold open, Take Down, roll, drop into Peggy Gou.
    set1: (L) => djSet(L, [{ id: TD, bars: 5 }, { id: PG, bars: 6 }], { opener: L.pp[0] }),
    // Peggy Gou, roll, drop into Golden.
    set2: (L) => djSet(L, [{ id: PG, bars: 6 }, { id: GOLD, bars: 6 }]),
    // Three songs: Golden, cut to Take Down, roll, drop into Peggy Gou.
    set3: (L) => djSet(L, [{ id: GOLD, bars: 4 }, { id: TD, bars: 4 }, { id: PG, bars: 5 }]),

    async mix(L) {
      const BPM = L.tdBpm;
      const BAR = 240 / BPM;
      const [A, B, C, D] = L.td;
      const [ppIntro, , ppFill] = L.pp;
      const [gSolo, gDeck] = L.gold;
      const pgBar = L.pg[0];
      const key = L.rrTone;
      mode([A, B, C, ppIntro, ppFill, gSolo, pgBar, ...L.rr], 'oneshot');
      state.pads[D].mode = 'loop';
      state.pads[D].loop = { start: 0, end: Math.min(rt[D].buffer.duration, BAR), bpm: BPM, beats: 4, beatLen: 60 / BPM, v: 2 };
      tune(gSolo, L.goldBpm, BPM);
      tune(pgBar, L.pgBpm, BPM);
      state.pads[key].mode = 'gate';
      await loadDeck(decks[0], deckItem(A, BPM, Math.min(rt[A].buffer.duration, BAR)));
      await loadDeck(decks[1], deckItem(gDeck, L.goldBpm, null));
      syncDeck(decks[1]);
      setBlend(0.3);
      select(ppIntro);
      return {
        bpm: BPM, bars: 12,
        events(at) {
          at(0, () => { say('Sample any video: each pad is a clip with its picture and sound'); hit(ppIntro); });
          at(2, () => { say('Blend crossfades one clip into the next, sound and picture'); hit(A); stop(ppIntro); });
          at(3, () => { hit(B); stop(A); });
          at(4, () => { say('Play pads like an instrument'); stop(B); });
          for (let k = 0; k < 2; k++) at(4 + k / 4, () => hit(C));
          for (let k = 0; k < 2; k++) at(4.5 + k / 8, () => hit(C));
          for (let k = 0; k < 4; k++) at(4.75 + k / 16, () => hit(C));
          at(5, () => { say("Auto loop locks a clip to its song's tempo"); hit(D); });
          at(6, () => { say('Find sounds + Keys: any sound becomes an instrument'); setPage(pageOf(key)); select(key); setKeysMode(true); });
          [0, 3, 5, 7, 10, 7, 5, 12].forEach((n, k) => {
            at(6 + k / 8, () => playNote(key, L.rrRoot + n, 1));
            at(6 + k / 8 + 0.1, () => stopNote(L.rrRoot + n));
          });
          at(7, () => { say('Pitch and speed per pad bring another song up to tempo'); setKeysMode(false); hit(pgBar); stop(D); });
          at(8, () => {
            say('Two decks, tempo-synced: the crossfader mixes picture and sound');
            stop(pgBar);
            setDeckPlaying(decks[0], true);
            setDeckPlaying(decks[1], true);
          });
          for (let k = 0; k <= 40; k++) at(8.25 + (k / 40) * 1.25, () => fade(k / 40));
          at(10, () => {
            say('Pages of pads: whole songs auto-cut into clips');
            for (const d of decks) setDeckPlaying(d, false);
            fade(0.5);
            setBlend(0.12);
          });
          [ppFill, L.rr[0], gSolo, pgBar].forEach((i, k) => at(10 + k / 4, () => hit(i)));
          at(11, () => { say('Record output saves the finished take'); stopAll(); setBlend(0.3); hit(B); });
        },
      };
    },

    async decks(L) {
      const BPM = L.pgBpm;
      const [p1] = L.pg;
      const [t1] = L.td;
      const src = (id) => state.sources.find((s) => s.id === id);
      const load = async (d, id, bpm, at) => {
        const s = src(id);
        await loadDeck(d, { kind: 'source', title: s.title, url: s.url, file: s.file, bpm });
        if (!d.video.duration) await new Promise((r) => d.video.addEventListener('loadedmetadata', r, { once: true }));
        d.video.currentTime = at;
      };
      await load(decks[0], PG, L.pgBpm, state.pads[p1].start);
      await load(decks[1], TD, L.tdBpm, state.pads[t1].start);
      syncDeck(decks[1]);
      mode(L.rr, 'oneshot');
      setBlend(0.2);
      select(L.rr[0]);
      return {
        bpm: BPM, bars: 9, keepDeckTime: true,
        events(at) {
          at(0, () => { say('Deck A: load any video, its tempo is detected'); setDeckPlaying(decks[0], true); });
          at(2, () => { say(`Sync: deck B matched to ${BPM.toFixed(1)} BPM, key lock holds its pitch`); setDeckPlaying(decks[1], true); });
          at(3, () => say('The crossfader mixes picture and sound together'));
          for (let k = 0; k <= 60; k++) at(3 + (k / 60) * 2.5, () => fade(k / 60));
          at(6, () => say('Pads still play over both decks'));
          [0, 1, 2, 3, 0, 2, 1, 3].forEach((n, k) => at(6 + k / 4, () => hit(L.rr[n % L.rr.length])));
          at(8, () => { say('Record output saves the mix'); for (let k = 0; k <= 20; k++) setTimeout(() => fade(1 - k / 40), k * 40); });
        },
      };
    },

    async instrument(L) {
      const BPM = L.pgBpm;
      const BAR = 240 / BPM;
      const [bed, alt] = L.pg;
      const key = L.rrTone;
      state.pads[bed].mode = 'loop';
      state.pads[bed].loop = { start: 0, end: Math.min(rt[bed].buffer.duration, BAR), bpm: BPM, beats: 4, beatLen: 60 / BPM, v: 2 };
      mode([alt, ...L.rr], 'oneshot');
      state.pads[key].mode = 'gate';
      setBlend(0.15);
      select(L.rr[0]);
      const R = L.rrRoot;
      return {
        bpm: BPM, bars: 9,
        events(at) {
          at(0, () => { say('Find sounds pulls one-shot sounds out of any video'); hit(bed); });
          [0, 1, 2, 3, 1, 0, 3, 2].forEach((n, k) => at(0.5 + k / 4, () => hit(L.rr[n % L.rr.length])));
          at(2.5, () => { say('Keys play a sound across the keyboard, in tune'); setPage(pageOf(key)); select(key); setKeysMode(true); });
          [0, 3, 5, 7, 5, 3, 10, 7, 12, 10, 7, 5].forEach((n, k) => {
            at(2.5 + k / 8, () => playNote(key, R + n, 1));
            at(2.5 + k / 8 + 0.1, () => stopNote(R + n));
          });
          at(4, () => say('Chords work too'));
          for (const b of [4, 4.5, 5, 5.25]) {
            const shift = b === 5 ? 5 : b === 5.25 ? 7 : 0;
            at(b, () => { for (const n of [0, 4, 7]) playNote(key, R + shift + n, 0.9); });
            at(b + 0.2, () => { for (const n of [0, 4, 7]) stopNote(R + shift + n); });
          }
          at(5.5, () => { say('Pitch works like a record: down is slower and lower'); setKeysMode(false); stop(bed); select(alt); setPitch(-5); hit(alt); });
          at(6.5, () => { say('...and up is faster and higher'); setPitch(7); hit(alt); });
          at(7.25, () => { setPitch(0); say('Level match keeps every source at the same loudness'); hit(bed); });
          [0, 2, 1, 3].forEach((n, k) => at(8 + k / 4, () => hit(L.rr[n % L.rr.length])));
        },
      };
    },

    async blend(L) {
      const BPM = L.tdBpm;
      const [A, B] = L.td;
      const [pp1] = L.pp;
      const [g1, g2] = L.gold;
      const [pg1, pg2] = L.pg;
      mode([A, B, pp1, g1, g2, pg1, pg2, ...L.rr], 'oneshot');
      tune(g1, L.goldBpm, BPM);
      tune(g2, L.goldBpm, BPM);
      tune(pg1, L.pgBpm, BPM);
      tune(pg2, L.pgBpm, BPM);
      setBlend(0.5);
      select(pp1);
      const order = [pp1, g1, A, pg1, null, B, pg2, g2];
      return {
        bpm: BPM, bars: 9,
        events(at) {
          const captions = ['Five videos, one set of pads', 'Blend crossfades sound and picture', 'Every clip pitched to one tempo', 'Level match evens out every source',
            'Found sounds as one-shots', 'Pages keep hundreds of clips a tap away', 'Auto cut chops a whole song by bars', 'Record output saves the finished take'];
          order.forEach((i, k) => at(k, () => {
            say(captions[k]);
            const prev = order[k - 1];
            if (i != null) hit(i);
            if (prev != null) stop(prev);
          }));
          [0, 1, 2, 3, 0, 1, 2, 3].forEach((n, k) => at(4 + k / 8, () => hit(L.rr[n % L.rr.length])));
          at(8, () => { const last = order[order.length - 1]; stop(last); hit(A); });
        },
      };
    },
  };

  // ---------- shared set-up ----------
  window.__demoPrepare = async () => {
    // Add the demo-only library (extra videos) as further pages, in memory only.
    const ex = window.__demoExtra;
    if (ex) {
      for (const s of ex.sources || []) if (!state.sources.some((x) => x.id === s.id)) state.sources.push(s);
      const clips = (ex.pads || []).filter(Boolean);
      const from = state.pads.length;
      state.pads.push(...clips);
      while (state.pads.length % N) state.pads.push(null);
      syncRt();
      const queue = clips.map((_, k) => from + k);
      const loader = async () => { while (queue.length) await loadPad(queue.shift()); };
      await Promise.all([loader(), loader(), loader(), loader()]);
      renderPads();
    }
    const want = state.pads.filter(Boolean).length;
    for (let k = 0; k < 900 && rt.filter((r) => r.buffer).length < want; k++) await wait(100);

    const rrAll = byLoud(padsOf(RR).filter((i) => rt[i].buffer.duration < 1.2));
    const tones = rrAll.filter((i) => state.pads[i].root != null && state.pads[i].root >= 48 && state.pads[i].root <= 84);
    const L = {
      td: hook(TD), tdBpm: bpmOf(TD, 128.4),
      gold: byLoud(padsOf(GOLD)), goldBpm: bpmOf(GOLD, 123),
      pp: byLoud(padsOf(PP)),
      pg: hook(PG), pgBpm: bpmOf(PG, 125),
      rr: rrAll.slice(0, 4),
      rrTone: tones[0] != null ? tones[0] : rrAll[0],
    };
    L.rrRoot = L.rrTone != null && state.pads[L.rrTone].root != null ? state.pads[L.rrTone].root : 60;
    for (const [k, v] of Object.entries({ td: L.td, gold: L.gold, pp: L.pp, pg: L.pg, rr: L.rr })) if (v.length < 2) throw new Error(`not enough clips for "${k}"`);

    caption = document.createElement('div');
    caption.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:999;padding:10px 22px;border-radius:10px;'
      + 'background:rgba(255,90,54,.95);color:#140600;font:700 22px "Segoe UI",sans-serif;box-shadow:0 6px 30px rgba(0,0,0,.6);'
      + 'transition:opacity .15s;opacity:0;white-space:nowrap;pointer-events:none';
    document.body.appendChild(caption);

    stopAll();
    srcVideo.pause();
    fade(0);
    const variant = window.__demoVariant || 'mix';
    if (!variants[variant]) throw new Error(`unknown variant "${variant}"`);
    run = await variants[variant](L);
    if (!run.keepDeckTime) for (const d of decks) d.video.currentTime = 0;
    const name = (i) => `${state.pads[i].name} (p${pageOf(i) + 1})`;
    return {
      variant, bpm: run.bpm, bars: run.bars, info: run.info, loaded: rt.filter((r) => r.buffer).length, of: want, pages: pageCount(),
      tempos: { td: L.tdBpm, gold: L.goldBpm, pg: L.pgBpm }, td: L.td.map(name), pg: L.pg.map(name), rr: L.rr.map(name),
      rrTone: name(L.rrTone), rrRoot: L.rrRoot, levels: [L.td[0], L.gold[0], L.pp[0], L.pg[0], L.rr[0]].map((i) => +(20 * Math.log10(rt[i].level.norm)).toFixed(1)),
    };
  };

  window.__demoRun = async () => {
    const BAR = 240000 / run.bpm;
    // A piece over a live-played record gives `timeOf(bars)` (ms from the start), taken from the
    // record's tracked beats, so its events land on the band's bars, not on a fixed clock.
    const tOf = run.timeOf || ((bars) => bars * BAR);
    const ev = [];
    run.events((bars, fn) => ev.push({ t: tOf(bars), fn }));
    ev.push({ t: tOf(run.bars), fn: () => { stopAll(); for (const d of decks) setDeckPlaying(d, false); } });
    ev.sort((x, y) => x.t - y.t);

    await toggleOutputRec();
    const recStart = Date.now();
    await wait(450);
    const t0 = performance.now();
    await new Promise((done) => {
      const timer = setInterval(() => {
        const now = performance.now() - t0;
        while (ev.length && ev[0].t <= now) { try { ev.shift().fn(); } catch (e) { console.error(`demo event failed: ${e.message}`); } }
        if (!ev.length) { clearInterval(timer); done(); }
      }, 2);
    });
    await wait(800);
    say('');
    const recEnd = Date.now();
    const rec = await toggleOutputRec();
    return { file: rec ? rec.file : null, title: rec ? rec.title : null, recStart, recEnd, seconds: (recEnd - recStart) / 1000 };
  };
})();
