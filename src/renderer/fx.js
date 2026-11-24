// Music-video effects over the picture, in the viewer and in the recorded output.
//
// Two layers of control:
//   fx.mode   'off' | 'shroom' | 'mirror': the psychedelic color wash (rainbow in the canvas "color"
//             blend, so even black-and-white footage takes color), hue drift, trails, and for
//             'mirror' a kaleidoscope. fx.amount sets its strength.
//   fx.effects  a stack of named effects, any mix, each { name, amount, ...settings }. Choose them by
//             name (fxUse, fxAdd, fxSet, fxRemove) or with a preset (fxPreset). FX_CATALOG lists every
//             effect with its settings; the app's FX menu offers the same.
// Everything can breathe on the beat: fx.bpm/fx.t0 for a fixed tempo, or fx.follow = { deck, beats }
// to pulse on a record's tracked beats (src/beats.js). fx.master scales every effect at once (the
// section helper sets it: quieter in a breakdown, full in a drop).
//
// Paint order (each stage reads the one before):
//   1 timing   2 motion (zoom punch, shake, film weave)   3 picture (plain, stutter/freeze, or a
//   composition: split, pip, double, chroma)   4 Shroom color   5 looks (grade, duotone, thermal,
//   night vision, halftone, film, vhs)   6 mirror   7 trails   7b light (glow, warp stars, mirror
//   ball, lasers)   8 strobe and flash   9 text
//
// Safety: every full-frame flash (strobe, fxFlash) goes through one limiter that allows at most three
// a second, the photosensitive-epilepsy line broadcasters use. scripts/check-video.js measures it too.
const fx = {
  mode: 'off',
  amount: 0.8,
  trails: 0.55,
  bpm: 0,
  t0: 0,
  beat: 0.6,
  flashAt: -1,
  spin: 1,
  follow: null,
  master: 1,
  effects: [],
  preset: 'off',
  text: null, // the text on screen (fxText)
  freezeUntil: 0, // performance.now()/1000 until which the picture holds (fxFreeze)
};

// Every effect, its settings and what it is for. The UI, presets and docs read this.
const FX_CATALOG = {
  zoomPunch: { group: 'beat', label: 'Zoom punch', about: 'pushes in on each hit', defaults: { amount: 0.6, every: 1 } },
  shake: { group: 'beat', label: 'Shake', about: 'a jolt on each hit', defaults: { amount: 0.5, every: 1 } },
  strobe: { group: 'beat', label: 'Strobe', about: 'white or black flash frames on the beat (capped at 3 a second)', defaults: { amount: 0.7, every: 2, color: 'white' } },
  stutter: { group: 'beat', label: 'Stutter', about: 'the picture steps in beat fractions instead of moving smoothly', defaults: { amount: 1, every: 0.25 } },
  film: { group: 'look', label: 'Film', about: 'grain, scratches, flicker, gate weave, faded warm color, vignette', defaults: { amount: 0.7, grain: 0.6, scratches: 0.5, flicker: 0.4, weave: 0.5, fade: 0.5 } },
  vhs: { group: 'look', label: 'VHS', about: 'tracking jitter, color bleed, scanlines, a noise band, PLAY timestamp', defaults: { amount: 0.7, stamp: true } },
  grade: { group: 'look', label: 'Color grade', about: 'a named look: sepia, noir, warm, cold, tealOrange, neon', defaults: { amount: 0.8, look: 'warm' } },
  duotone: { group: 'look', label: 'Duotone', about: 'two colors from shadow to light (brand colors)', defaults: { amount: 0.85, dark: '#1b0636', light: '#ff5a36' } },
  halftone: { group: 'look', label: 'Halftone', about: 'comic print dots', defaults: { amount: 0.9, cell: 9 } },
  thermal: { group: 'look', label: 'Thermal', about: 'a heat-camera color map', defaults: { amount: 0.9 } },
  nightVision: { group: 'look', label: 'Night vision', about: 'green phosphor, noise and a dark vignette', defaults: { amount: 0.9 } },
  split: { group: 'compose', label: 'Split screen', about: 'the current clip beside recent ones, 2 or 4 panes', defaults: { amount: 1, panes: 2 } },
  pip: { group: 'compose', label: 'Picture in picture', about: 'the previous clip small in a corner', defaults: { amount: 1, size: 0.32, corner: 'br' } },
  double: { group: 'compose', label: 'Double exposure', about: 'the current and previous clip printed together', defaults: { amount: 0.55 } },
  chroma: { group: 'compose', label: 'Chroma key', about: 'removes a key color from the current clip; the previous clip shows through', defaults: { amount: 1, key: '#00ff00', tolerance: 0.32 } },
  mirror: { group: 'look', label: 'Kaleidoscope', about: 'mirrors left to right and top to bottom', defaults: { amount: 1 } },
  trails: { group: 'look', label: 'Trails', about: 'zoomed ghosts of the last frames', defaults: { amount: 0.5 } },
  starfield: { group: 'light', label: 'Warp stars', about: 'stars streaking out from the center, surging on the beat', defaults: { amount: 0.7, speed: 1, count: 220, every: 1 } },
  discoBall: { group: 'light', label: 'Mirror ball', about: 'colored light spots sweeping round the frame, flaring on the beat', defaults: { amount: 0.7, spots: 70, every: 1 } },
  lasers: { group: 'light', label: 'Lasers', about: 'colored beams fanning up from below, sweeping, changing color on the beat', defaults: { amount: 0.7, beams: 7, every: 2 } },
  glow: { group: 'light', label: 'Glow', about: 'bloom: the bright parts of the picture bleed light', defaults: { amount: 0.5 } },
};

// Presets by mood. Each is a Shroom mode and a stack. Scripts call fxPreset(name); the menu lists them.
const FX_PRESETS = {
  off: { mode: 'off', effects: [] },
  shroom: { mode: 'shroom', effects: [] },
  shroomMirror: { mode: 'mirror', effects: [] },
  rodeo: { mode: 'shroom', amount: 0.35, effects: [['film', { amount: 0.55 }], ['zoomPunch', { amount: 0.35, every: 1 }]] },
  archival: { mode: 'off', effects: [['film', { amount: 0.85 }], ['grade', { look: 'sepia', amount: 0.6 }]] },
  vhsParty: { mode: 'off', effects: [['vhs', { amount: 0.8 }], ['shake', { amount: 0.35, every: 2 }], ['zoomPunch', { amount: 0.4 }]] },
  neonClub: { mode: 'off', effects: [['grade', { look: 'neon', amount: 0.9 }], ['zoomPunch', { amount: 0.6 }], ['strobe', { amount: 0.5, every: 4 }], ['trails', { amount: 0.45 }]] },
  comic: { mode: 'off', effects: [['halftone', { amount: 0.9 }], ['zoomPunch', { amount: 0.5, every: 2 }]] },
  heat: { mode: 'off', effects: [['thermal', { amount: 0.95 }], ['shake', { amount: 0.4 }]] },
  nightVision: { mode: 'off', effects: [['nightVision', { amount: 0.95 }], ['film', { amount: 0.3, fade: 0, scratches: 0 }]] },
  noir: { mode: 'off', effects: [['grade', { look: 'noir', amount: 1 }], ['film', { amount: 0.6, fade: 0 }]] },
  brand: { mode: 'off', effects: [['duotone', { amount: 0.85 }], ['zoomPunch', { amount: 0.4 }]] },
  splitBeat: { mode: 'off', effects: [['split', { panes: 4 }], ['zoomPunch', { amount: 0.4 }]] },
  dream: { mode: 'off', effects: [['double', { amount: 0.5 }], ['trails', { amount: 0.6 }], ['grade', { look: 'warm', amount: 0.5 }]] },
  discoSpace: { mode: 'off', effects: [['grade', { look: 'neon', amount: 0.55 }], ['discoBall', { amount: 0.75 }], ['glow', { amount: 0.45 }], ['zoomPunch', { amount: 0.4 }]] },
  warp: { mode: 'off', effects: [['starfield', { amount: 0.9, speed: 1.4 }], ['glow', { amount: 0.4 }], ['zoomPunch', { amount: 0.5 }]] },
  laserShow: { mode: 'off', effects: [['grade', { look: 'cold', amount: 0.5 }], ['lasers', { amount: 0.85 }], ['glow', { amount: 0.5 }], ['strobe', { amount: 0.45, every: 8 }]] },
  cosmos: { mode: 'off', effects: [['starfield', { amount: 0.45, speed: 0.4 }], ['double', { amount: 0.4 }], ['glow', { amount: 0.55 }]] },
};

// Section intensity, for fxSection(kind): how much of every effect a part of a song gets.
const FX_SECTION = { intro: 0.45, verse: 0.6, prechorus: 0.75, build: 0.85, chorus: 1, drop: 1, breakdown: 0.35, bridge: 0.55, solo: 0.9, outro: 0.4 };

const fxPrev = new WeakMap(); // canvas -> previous frame, for trails
const fxScratch = new WeakMap(); // canvas -> scratch canvases
let fxHistory = []; // recent distinct picture elements, newest first, for compositions
let fxLastFlash = -10; // the flash limiter's clock (seconds)

function fxEffect(name) { return fx.effects.find((e) => e.name === name); }
// Remember the last few distinct pictures shown (newest first), whether or not effects are on, so
// a composition (split, pip, double, chroma) has "the previous clip" the moment it is switched on.
function fxNote(layers) {
  const top = layers && layers.length ? layers[layers.length - 1].el : null;
  if (top && top !== fxHistory[0]) fxHistory = [top, ...fxHistory.filter((e) => e !== top)].slice(0, 4);
}
function fxActive() {
  return (fx.mode !== 'off' && fx.amount > 0) || fx.effects.length > 0 || !!fx.text || fx.freezeUntil > performance.now() / 1000;
}
function fxUse(list) {
  fx.effects = (list || []).map((e) => (typeof e === 'string' ? [e, {}] : Array.isArray(e) ? e : [e.name, e])).map(([name, o]) => {
    if (!FX_CATALOG[name]) throw new Error(`unknown effect "${name}"; see FX_CATALOG`);
    return { name, ...FX_CATALOG[name].defaults, ...o };
  });
  fxSync();
}
function fxAdd(name, o = {}) { fxRemove(name, true); fxUse([...fx.effects.map((e) => [e.name, e]), [name, o]]); }
function fxRemove(name, quiet) { fx.effects = fx.effects.filter((e) => e.name !== name); if (!quiet) fxSync(); }
function fxSet(name, o) { const e = fxEffect(name); if (e) Object.assign(e, o); else fxAdd(name, o); }
function fxPreset(name) {
  const p = FX_PRESETS[name];
  if (!p) throw new Error(`unknown preset "${name}"; see FX_PRESETS`);
  fx.mode = p.mode;
  if (p.amount != null) fx.amount = p.amount;
  fx.preset = name;
  fxUse(p.effects);
}
function fxSection(kind) { if (FX_SECTION[kind] == null) throw new Error(`unknown section "${kind}"`); fx.master = FX_SECTION[kind]; }
function fxFreeze(seconds) { fx.freezeUntil = performance.now() / 1000 + seconds; }

// A one-off flash (a drop). Goes through the limiter like the strobe.
function fxFlash() {
  const now = performance.now() / 1000;
  if (now - fxLastFlash < 1 / 3) return;
  fxLastFlash = now;
  fx.flashAt = now;
}

// Text over the picture. style: 'caption' (a line, fades in and out), 'pop' (words appear one per
// `every` beats, each popping in), 'type' (typed out), 'slide' (slides in). where: 'bottom', 'center',
// 'top'. hold: seconds on screen (default: long enough to read). Pass null to clear.
function fxText(text, o = {}) {
  if (!text) { fx.text = null; return; }
  const words = String(text).split(/\s+/);
  fx.text = { text: String(text), words, style: o.style || 'caption', where: o.where || 'bottom', size: o.size || 54, color: o.color || '#fff', every: o.every || 1, at: performance.now() / 1000, hold: o.hold || Math.max(2.5, 0.45 * words.length + 1.5) };
}

function fxTempo() {
  if (fx.bpm) return fx.bpm;
  for (const d of decks) if (d.playing && d.item && d.item.bpm) return d.item.bpm * (d.video.playbackRate || 1);
  return (currentSource && currentSource.bpm) || 120;
}

// Where we are in the beat: { beatLen, phase (0..1 in the beat), count (beats so far, fractional) }.
function fxTiming(now) {
  const beatLen = 60 / fxTempo();
  let count = (now - fx.t0) / beatLen;
  const fl = fx.follow;
  if (fl && fl.deck && fl.deck.video && fl.beats && fl.beats.length > 1) {
    const t = fl.deck.video.currentTime;
    const B = fl.beats;
    let lo = 0;
    let hi = B.length - 1;
    if (t >= B[0] && t < B[hi]) {
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (B[mid] <= t) lo = mid; else hi = mid; }
      count = lo + (t - B[lo]) / (B[lo + 1] - B[lo]);
    }
  }
  return { beatLen, count, phase: ((count % 1) + 1) % 1 };
}
// An envelope that is 1 on every `every` beats and falls away sharply.
function fxHit(tm, every, sharp = 5) { const p = ((tm.count / every) % 1 + 1) % 1; return Math.pow(1 - p, sharp); }
// A random number that holds for one beat fraction (so shakes and scratches change on the rhythm).
function fxRand(tm, every, salt) { const k = Math.floor(tm.count / every); const x = Math.sin((k + 1) * 12.9898 + salt * 78.233) * 43758.5453; return x - Math.floor(x); }

function scratch(canvas, key, w, h) {
  let s = fxScratch.get(canvas);
  if (!s) { s = {}; fxScratch.set(canvas, s); }
  let c = s[key];
  if (!c || c.width !== w || c.height !== h) { c = document.createElement('canvas'); c.width = w; c.height = h; s[key] = c; }
  return c;
}
function drawCover(g, el, x, y, w, h, zoom = 1) {
  if (!el || !el.videoWidth) return;
  const s = Math.max(w / el.videoWidth, h / el.videoHeight) * zoom;
  const dw = el.videoWidth * s;
  const dh = el.videoHeight * s;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  g.restore();
}
function hexRgb(h) { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
let noiseTiles = null;
function noiseTile(k) {
  if (!noiseTiles) {
    noiseTiles = [0, 1, 2, 3].map(() => {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 256;
      const g = c.getContext('2d');
      const img = g.createImageData(256, 256);
      for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
      g.putImageData(img, 0, 0);
      return c;
    });
  }
  return noiseTiles[k % 4];
}

function fxPaint(g, canvas, layers) {
  const W = canvas.width;
  const H = canvas.height;
  const now = performance.now() / 1000;
  const tm = fxTiming(now);
  const M = fx.master;
  const E = (name) => { const e = fxEffect(name); return e ? { ...e, amt: Math.max(0, Math.min(1, e.amount * M)) } : null; };
  const shroomOn = fx.mode !== 'off' && fx.amount > 0;
  const a = fx.amount * M;
  const pulse = shroomOn ? fx.beat * Math.pow(1 - tm.phase, 4) : 0;
  const flash = fx.flashAt >= 0 ? Math.max(0, 1 - (now - fx.flashAt) / (tm.beatLen * 2)) : 0;
  const hue = (now * 55 * fx.spin) % 360;
  const top = layers.length ? layers[layers.length - 1].el : null;
  fxNote(layers);

  // 2. Motion: zoom punch, shake and film weave move the whole picture.
  let zoom = 1 + 0.045 * pulse;
  let dx = 0;
  let dy = 0;
  const zp = E('zoomPunch');
  if (zp) zoom *= 1 + 0.09 * zp.amt * fxHit(tm, zp.every);
  const sh = E('shake');
  if (sh) { const k = fxHit(tm, sh.every, 3) * sh.amt * 22; dx += (fxRand(tm, sh.every / 4, 1) - 0.5) * 2 * k; dy += (fxRand(tm, sh.every / 4, 2) - 0.5) * 2 * k; }
  const fl = E('film');
  if (fl) { dy += (fxRand(tm, 0.125, 3) - 0.5) * 4 * fl.weave * fl.amt; dx += (fxRand(tm, 0.25, 4) - 0.5) * 1.5 * fl.weave * fl.amt; }

  // 3. The picture.
  g.save();
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const src = scratch(canvas, 'src', W, H); // the picture before looks, kept for stutter and freeze
  const sg = src.getContext('2d');
  const st = E('stutter');
  const frozen = fx.freezeUntil > now;
  const stepKey = st ? Math.floor(tm.count / st.every) : null;
  const holdSrc = frozen || (st && st.amt > 0 && src.stepKey === stepKey);
  if (!holdSrc) {
    sg.save();
    sg.globalCompositeOperation = 'source-over';
    sg.globalAlpha = 1;
    sg.fillStyle = '#000';
    sg.fillRect(0, 0, W, H);
    sg.translate(W / 2 + dx, H / 2 + dy);
    sg.scale(zoom, zoom);
    sg.translate(-W / 2, -H / 2);
    if (shroomOn) sg.filter = `hue-rotate(${hue.toFixed(0)}deg) saturate(${(1 + 1.8 * a).toFixed(2)}) contrast(${(1 + 0.3 * a).toFixed(2)}) brightness(${(1 + 0.35 * pulse + 0.6 * flash).toFixed(2)})`;
    const prevEl = fxHistory.find((e) => e !== top && e.videoWidth);
    const split = E('split');
    const pip = E('pip');
    const dbl = E('double');
    const ck = E('chroma');
    if (split && top) {
      const panes = split.panes >= 4 ? 4 : 2;
      const els = [top, ...fxHistory.filter((e) => e !== top && e.videoWidth)];
      const rot = Math.floor(tm.count / 2); // panes trade places every two beats
      for (let k = 0; k < panes; k++) {
        const el = els[(k + rot) % Math.max(1, Math.min(panes, els.length))] || top;
        const pw = panes === 4 ? W / 2 : W / 2;
        const ph = panes === 4 ? H / 2 : H;
        drawCover(sg, el, (k % 2) * pw + 2, Math.floor(k / 2) * ph + 2, pw - 4, ph - 4);
      }
    } else {
      for (const { el, alpha } of layers) {
        if (!el || !el.videoWidth || alpha <= 0) continue;
        sg.globalAlpha = alpha;
        if (ck && el === top && prevEl) {
          // Chroma key at working size: pixels near the key color become see-through.
          sg.globalAlpha = 1;
          drawCover(sg, prevEl, 0, 0, W, H);
          const kw = 480;
          const kh = Math.round((kw * H) / W);
          const kc = scratch(canvas, 'key', kw, kh);
          const kg = kc.getContext('2d', { willReadFrequently: true });
          kg.clearRect(0, 0, kw, kh);
          drawCover(kg, el, 0, 0, kw, kh);
          const img = kg.getImageData(0, 0, kw, kh);
          const [kr, kgc, kb] = hexRgb(ck.key);
          const tol = ck.tolerance * 441;
          for (let i = 0; i < img.data.length; i += 4) {
            const d = Math.hypot(img.data[i] - kr, img.data[i + 1] - kgc, img.data[i + 2] - kb);
            if (d < tol) {
              const soft = Math.max(0, Math.min(1, (d / tol - 0.7) / 0.3)); // a soft edge in the last 30% of the tolerance
              img.data[i + 3] = Math.round(255 * (1 - ck.amt + ck.amt * soft));
            }
          }
          kg.putImageData(img, 0, 0);
          sg.drawImage(kc, 0, 0, W, H);
        } else drawCover(sg, el, 0, 0, W, H);
      }
      sg.globalAlpha = 1;
      if (dbl && prevEl) { sg.globalCompositeOperation = 'screen'; sg.globalAlpha = dbl.amt; drawCover(sg, prevEl, 0, 0, W, H); sg.globalCompositeOperation = 'source-over'; sg.globalAlpha = 1; }
      if (pip && prevEl) {
        const pw = W * pip.size;
        const ph = H * pip.size;
        const m = 24;
        const x = pip.corner.includes('l') ? m : W - pw - m;
        const y = pip.corner.includes('t') ? m : H - ph - m;
        sg.globalAlpha = pip.amt;
        sg.fillStyle = '#fff';
        sg.fillRect(x - 4, y - 4, pw + 8, ph + 8);
        drawCover(sg, prevEl, x, y, pw, ph);
        sg.globalAlpha = 1;
      }
    }
    sg.restore();
    src.stepKey = stepKey;
  }
  g.drawImage(src, 0, 0);

  // 4. Shroom color: the rainbow wash travelling across the frame.
  if (shroomOn) {
    const ang = now * 0.6 * fx.spin;
    const r = Math.hypot(W, H) / 2;
    const grad = g.createLinearGradient(W / 2 - Math.cos(ang) * r, H / 2 - Math.sin(ang) * r, W / 2 + Math.cos(ang) * r, H / 2 + Math.sin(ang) * r);
    for (let k = 0; k <= 6; k++) grad.addColorStop(k / 6, `hsl(${(hue * 2 + k * 60) % 360}, 100%, 50%)`);
    g.globalCompositeOperation = 'color';
    g.globalAlpha = Math.min(1, 0.85 * a + 0.3 * flash);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    // "color" keeps white white; a light multiply tints the whites too.
    g.globalCompositeOperation = 'multiply';
    g.globalAlpha = 0.4 * a;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }

  // 5. Looks. Each paints the frame through a scratch copy, mixed in by its amount.
  const look = (amt, fn) => {
    if (amt <= 0) return;
    const c = scratch(canvas, 'look', W, H);
    const cg = c.getContext('2d', { willReadFrequently: true });
    cg.save();
    cg.globalCompositeOperation = 'copy';
    cg.globalAlpha = 1;
    cg.filter = 'none';
    cg.drawImage(canvas, 0, 0);
    cg.restore();
    fn(cg, c);
    g.globalAlpha = amt;
    g.drawImage(c, 0, 0);
    g.globalAlpha = 1;
  };
  const filtered = (filter) => (cg, c) => {
    const t = scratch(canvas, 'tmp', W, H);
    const tg = t.getContext('2d');
    tg.globalCompositeOperation = 'copy';
    tg.filter = filter;
    tg.drawImage(c, 0, 0);
    tg.filter = 'none';
    cg.globalCompositeOperation = 'copy';
    cg.drawImage(t, 0, 0);
    cg.globalCompositeOperation = 'source-over';
  };
  const gr = E('grade');
  if (gr) {
    const looks = {
      sepia: 'sepia(1) contrast(1.05) brightness(1.02)',
      noir: 'grayscale(1) contrast(1.55) brightness(0.92)',
      warm: 'sepia(0.35) saturate(1.35) contrast(1.05)',
      cold: 'saturate(0.75) hue-rotate(195deg) contrast(1.05) brightness(1.03)',
      tealOrange: 'saturate(1.25) contrast(1.12)',
      neon: 'saturate(2.3) contrast(1.35) hue-rotate(-18deg) brightness(1.05)',
    };
    look(gr.amt, (cg, c) => {
      filtered(looks[gr.look] || looks.warm)(cg, c);
      if (gr.look === 'tealOrange') {
        cg.globalCompositeOperation = 'soft-light';
        cg.fillStyle = 'rgba(255,140,50,0.55)';
        cg.fillRect(0, 0, W, H);
        cg.globalCompositeOperation = 'multiply';
        cg.fillStyle = 'rgba(70,170,180,0.35)';
        cg.fillRect(0, 0, W, H);
        cg.globalCompositeOperation = 'source-over';
      }
    });
  }
  const duo = E('duotone');
  if (duo) {
    look(duo.amt, (cg, c) => {
      filtered('grayscale(1) contrast(1.15)')(cg, c);
      cg.globalCompositeOperation = 'multiply';
      cg.fillStyle = duo.light;
      cg.fillRect(0, 0, W, H);
      cg.globalCompositeOperation = 'lighten';
      cg.fillStyle = duo.dark;
      cg.fillRect(0, 0, W, H);
      cg.globalCompositeOperation = 'source-over';
    });
  }
  const pixelLook = (amt, size, map) => look(amt, (cg) => {
    const w = size;
    const h = Math.round((size * H) / W);
    const t = scratch(canvas, 'px', w, h);
    const tg = t.getContext('2d', { willReadFrequently: true });
    tg.drawImage(cg.canvas, 0, 0, w, h);
    const img = tg.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      const [r, gg, b] = map(l);
      d[i] = r; d[i + 1] = gg; d[i + 2] = b;
    }
    tg.putImageData(img, 0, 0);
    cg.save();
    cg.imageSmoothingEnabled = true;
    cg.globalCompositeOperation = 'copy';
    cg.drawImage(t, 0, 0, W, H);
    cg.restore();
  });
  const th = E('thermal');
  if (th) {
    // Black, blue, purple, red, orange, yellow, white: the iron palette of heat cameras.
    const stops = [[0, [0, 0, 10]], [0.2, [30, 0, 120]], [0.4, [140, 0, 140]], [0.6, [230, 40, 20]], [0.78, [255, 150, 0]], [0.92, [255, 240, 60]], [1, [255, 255, 255]]];
    pixelLook(th.amt, 480, (l) => {
      let k = 0;
      while (k < stops.length - 2 && l > stops[k + 1][0]) k++;
      const [l0, c0] = stops[k];
      const [l1, c1] = stops[k + 1];
      const f = Math.max(0, Math.min(1, (l - l0) / (l1 - l0)));
      return c0.map((v, i) => v + (c1[i] - v) * f);
    });
  }
  const nv = E('nightVision');
  if (nv) {
    look(nv.amt, (cg, c) => {
      filtered('grayscale(1) brightness(1.45) contrast(1.25)')(cg, c);
      cg.globalCompositeOperation = 'multiply';
      cg.fillStyle = '#4dff7a';
      cg.fillRect(0, 0, W, H);
      cg.globalCompositeOperation = 'overlay';
      cg.globalAlpha = 0.35;
      cg.fillStyle = cg.createPattern(noiseTile(Math.floor(now * 24)), 'repeat');
      cg.fillRect(0, 0, W, H);
      cg.globalAlpha = 1;
      const v = cg.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.78);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.92)');
      cg.globalCompositeOperation = 'source-over';
      cg.fillStyle = v;
      cg.fillRect(0, 0, W, H);
    });
  }
  const ht = E('halftone');
  if (ht) {
    look(ht.amt, (cg) => {
      const cell = Math.max(5, ht.cell);
      const w = Math.ceil(W / cell);
      const h = Math.ceil(H / cell);
      const t = scratch(canvas, 'ht', w, h);
      const tg = t.getContext('2d', { willReadFrequently: true });
      tg.drawImage(cg.canvas, 0, 0, w, h);
      const d = tg.getImageData(0, 0, w, h).data;
      cg.save();
      cg.globalCompositeOperation = 'source-over';
      cg.fillStyle = '#fbf3df';
      cg.fillRect(0, 0, W, H);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
          const rad = cell * 0.5 * Math.sqrt(1 - l) * 1.15;
          if (rad < 0.6) continue;
          // Push the color toward print ink: more saturated, a touch darker.
          cg.fillStyle = `rgb(${Math.min(255, d[i] * 1.1) | 0},${Math.min(255, d[i + 1] * 1.1) | 0},${Math.min(255, d[i + 2] * 1.1) | 0})`;
          cg.beginPath();
          cg.arc(x * cell + cell / 2 + (y % 2 ? cell / 2 : 0), y * cell + cell / 2, rad, 0, Math.PI * 2);
          cg.fill();
        }
      }
      cg.restore();
    });
  }
  if (fl) {
    look(fl.amt, (cg, c) => {
      if (fl.fade > 0) {
        filtered(`sepia(${(0.45 * fl.fade).toFixed(2)}) contrast(${(1 - 0.12 * fl.fade).toFixed(2)}) brightness(${(1.02 + 0.05 * fl.fade).toFixed(2)}) saturate(${(1 - 0.3 * fl.fade).toFixed(2)})`)(cg, c);
        cg.globalCompositeOperation = 'lighten';
        cg.fillStyle = `rgba(38,28,18,${(0.5 * fl.fade).toFixed(2)})`; // lifted, milky blacks
        cg.fillRect(0, 0, W, H);
      }
      if (fl.flicker > 0) {
        const f = (fxRand(tm, 0.0625, 5) - 0.5) * 0.18 * fl.flicker;
        cg.globalCompositeOperation = f > 0 ? 'screen' : 'multiply';
        cg.fillStyle = f > 0 ? `rgba(255,250,235,${f.toFixed(3)})` : `rgba(0,0,0,${(-f).toFixed(3)})`;
        cg.fillRect(0, 0, W, H);
      }
      if (fl.grain > 0) {
        cg.globalCompositeOperation = 'overlay';
        cg.globalAlpha = 0.5 * fl.grain;
        cg.save();
        cg.translate(-Math.random() * 256, -Math.random() * 256);
        cg.fillStyle = cg.createPattern(noiseTile(Math.floor(now * 24)), 'repeat');
        cg.fillRect(0, 0, W + 256, H + 256);
        cg.restore();
        cg.globalAlpha = 1;
      }
      if (fl.scratches > 0) {
        cg.globalCompositeOperation = 'source-over';
        const n = Math.floor(fxRand(tm, 0.125, 6) * 4 * fl.scratches);
        for (let k = 0; k < n; k++) {
          const x = fxRand(tm, 0.125, 10 + k) * W;
          cg.strokeStyle = `rgba(${k % 2 ? '255,250,235' : '20,15,10'},${(0.25 + 0.4 * fxRand(tm, 0.125, 20 + k)).toFixed(2)})`;
          cg.lineWidth = 1 + fxRand(tm, 0.125, 30 + k) * 1.5;
          cg.beginPath();
          cg.moveTo(x, 0);
          cg.lineTo(x + (fxRand(tm, 0.125, 40 + k) - 0.5) * 30, H);
          cg.stroke();
        }
      }
      const v = cg.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.55)');
      cg.globalCompositeOperation = 'source-over';
      cg.fillStyle = v;
      cg.fillRect(0, 0, W, H);
    });
  }
  const vhs = E('vhs');
  if (vhs) {
    look(vhs.amt, (cg, c) => {
      const t = scratch(canvas, 'tmp', W, H);
      const tg = t.getContext('2d');
      tg.globalCompositeOperation = 'copy';
      tg.filter = 'saturate(1.35) contrast(1.1) blur(0.6px)';
      tg.drawImage(c, 0, 0);
      tg.filter = 'none';
      // Tracking jitter: a few horizontal strips nudged sideways.
      cg.globalCompositeOperation = 'copy';
      cg.drawImage(t, 0, 0);
      cg.globalCompositeOperation = 'source-over';
      for (let k = 0; k < 6; k++) {
        const y = Math.floor(fxRand(tm, 0.25, 50 + k) * H);
        const sh2 = 4 + fxRand(tm, 0.25, 60 + k) * 16;
        const off = (fxRand(tm, 0.125, 70 + k) - 0.5) * 24;
        cg.drawImage(t, 0, y, W, sh2, off, y, W, sh2);
      }
      // Color bleed: a red-shifted copy printed a few pixels to the side.
      cg.globalCompositeOperation = 'screen';
      cg.globalAlpha = 0.28;
      cg.filter = 'sepia(1) saturate(6) hue-rotate(-40deg)';
      cg.drawImage(t, 5, 0);
      cg.filter = 'none';
      cg.globalAlpha = 1;
      // Scanlines.
      cg.globalCompositeOperation = 'multiply';
      cg.fillStyle = 'rgba(0,0,0,0.22)';
      for (let y = 0; y < H; y += 3) cg.fillRect(0, y, W, 1);
      // The noise band rolling up the frame.
      const by = H - ((now * 90) % (H + 60));
      cg.globalCompositeOperation = 'screen';
      cg.globalAlpha = 0.5;
      cg.drawImage(noiseTile(Math.floor(now * 30)), 0, 0, 256, 16, 0, by, W, 26);
      cg.globalAlpha = 1;
      cg.globalCompositeOperation = 'source-over';
      if (vhs.stamp) {
        cg.font = `bold ${Math.round(H / 18)}px "Consolas", monospace`;
        cg.fillStyle = 'rgba(255,255,255,0.9)';
        cg.shadowColor = 'rgba(0,0,0,0.8)';
        cg.shadowBlur = 4;
        cg.fillText('PLAY ▶', W * 0.05, H * 0.11);
        const d = new Date();
        cg.fillText(`${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()]}. ${d.getDate()} 1989`, W * 0.66, H * 0.92);
        cg.shadowBlur = 0;
      }
    });
  }

  // 6. Kaleidoscope: the left half mirrored onto the right, then the top onto the bottom.
  const mir = E('mirror');
  if (fx.mode === 'mirror' || (mir && mir.amt > 0.5)) {
    g.save();
    g.translate(W, 0);
    g.scale(-1, 1);
    g.drawImage(canvas, 0, 0, W / 2, H, 0, 0, W / 2, H);
    g.restore();
    g.save();
    g.translate(0, H);
    g.scale(1, -1);
    g.drawImage(canvas, 0, 0, W, H / 2, 0, 0, W, H / 2);
    g.restore();
  }

  // 7. Trails: the previous frame, zoomed and turned, where it is lighter ("lighten", not "screen":
  // screen adds up frame after frame and bleaches the picture white).
  let prev = fxPrev.get(canvas);
  if (!prev || prev.width !== W || prev.height !== H) {
    prev = document.createElement('canvas');
    prev.width = W;
    prev.height = H;
    fxPrev.set(canvas, prev);
  }
  const tr = E('trails');
  const trailAmt = (shroomOn ? fx.trails * (0.55 + 0.45 * a) : 0) + (tr ? tr.amt * 0.8 : 0);
  if (trailAmt > 0) {
    g.save();
    g.globalCompositeOperation = 'lighten';
    g.globalAlpha = Math.min(0.85, trailAmt);
    g.translate(W / 2, H / 2);
    g.rotate(0.012 * Math.sin(now * 0.7));
    const z = 1.035 + 0.03 * pulse;
    g.scale(z, z);
    g.drawImage(prev, -W / 2, -H / 2);
    g.restore();
  }
  const pg = prev.getContext('2d');
  pg.globalCompositeOperation = 'copy';
  pg.drawImage(canvas, 0, 0);

  // 7b. Light: glow, warp stars, mirror-ball spots and lasers, added in light ("screen"/"lighter")
  // after the trails are taken, so they never smear into ghosts. None is a full-frame flash.
  fxPaintLight(g, canvas, W, H, now, tm, E);

  // 8. Strobe: full-frame flash frames on the beat, through the flash limiter (3 a second at most).
  const sb = E('strobe');
  if (sb && sb.amt > 0) {
    const beatIdx = Math.floor(tm.count / sb.every);
    if (beatIdx !== sb.lastIdx) {
      sb.lastIdx = beatIdx;
      const e = fxEffect('strobe');
      if (e) e.lastIdx = beatIdx;
      if (now - fxLastFlash >= 1 / 3) { fxLastFlash = now; fx.strobeAt = now; }
    }
    if (fx.strobeAt && now - fx.strobeAt < 0.06) {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = sb.amt;
      g.fillStyle = sb.color === 'black' ? '#000' : '#fff';
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }
  }

  // 9. Text.
  if (fx.text) fxPaintText(g, W, H, now, tm);
  g.restore();
}

// A fixed pseudo-random number for item i (stars, spots), the same every frame.
function fxSeed(i, salt) { const x = Math.sin((i + 1) * 91.345 + salt * 47.853) * 24634.6345; return x - Math.floor(x); }
const FX_LIGHT_COLORS = ['#ff3df2', '#36e7ff', '#ffe23d', '#7dff5a', '#ff7a2e', '#a46bff'];

function fxPaintLight(g, canvas, W, H, now, tm, E) {
  const gl = E('glow');
  const sf = E('starfield');
  const db = E('discoBall');
  const lz = E('lasers');
  if (!gl && !sf && !db && !lz) return;
  const S = Math.min(W, H);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);

  // Glow: a blurred copy of the bright parts, screened back on.
  if (gl && gl.amt > 0) {
    const t = scratch(canvas, 'glow', Math.max(1, W >> 2), Math.max(1, H >> 2));
    const tg = t.getContext('2d');
    tg.globalCompositeOperation = 'copy';
    tg.filter = `brightness(0.75) contrast(2.2) blur(${Math.max(1, Math.round(S / 160))}px)`;
    tg.drawImage(canvas, 0, 0, t.width, t.height);
    tg.filter = 'none';
    g.globalCompositeOperation = 'screen';
    g.globalAlpha = Math.min(1, gl.amt * 1.1);
    g.drawImage(t, 0, 0, W, H);
    g.globalAlpha = 1;
  }

  // Warp stars: each star flies out from the center along its own ray; the beat pushes the speed.
  if (sf && sf.amt > 0) {
    const n = Math.max(20, Math.min(600, sf.count | 0));
    const surge = 1 + 2.2 * fxHit(tm, sf.every, 3);
    // Distance is time-based with a beat surge folded in as extra travel (beats so far, eased).
    const travel = now * 0.16 * sf.speed + 0.05 * sf.speed * (Math.floor(tm.count / sf.every) + (1 - Math.pow(1 - ((tm.count / sf.every) % 1), 3)));
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.hypot(W, H) / 2;
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const ang = fxSeed(i, 1) * Math.PI * 2;
      const z = (fxSeed(i, 2) + travel * (0.6 + 0.8 * fxSeed(i, 3))) % 1; // 0 = far, 1 = here
      const d = Math.pow(z, 2.4) * R;
      const len = Math.max(1, d * 0.09 * sf.speed * surge);
      const x = cx + Math.cos(ang) * d;
      const y = cy + Math.sin(ang) * d;
      const x0 = cx + Math.cos(ang) * Math.max(0, d - len);
      const y0 = cy + Math.sin(ang) * Math.max(0, d - len);
      const b = Math.min(1, z * 1.4) * sf.amt;
      g.strokeStyle = fxSeed(i, 4) < 0.18 ? `rgba(160,210,255,${b})` : `rgba(255,255,255,${b})`;
      g.lineWidth = Math.max(0.6, (S / 360) * (0.5 + 1.6 * z));
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x, y);
      g.stroke();
    }
  }

  // Mirror ball: spots on a turning sphere projected round the room; they sweep left to right,
  // swell on the beat and shift color every bar.
  if (db && db.amt > 0) {
    const n = Math.max(10, Math.min(200, db.spots | 0));
    const hit = fxHit(tm, db.every, 4);
    const turn = now * 0.35;
    const bar = Math.floor(tm.count / 4);
    g.globalCompositeOperation = 'screen';
    for (let i = 0; i < n; i++) {
      const lon = fxSeed(i, 5) * Math.PI * 2 + turn;
      const lat = (fxSeed(i, 6) - 0.5) * 1.2;
      const facing = Math.cos(lon); // only spots on the near side reach the wall
      if (facing < 0.05) continue;
      const x = W / 2 + Math.sin(lon) * W * 0.62;
      const y = H / 2 + Math.sin(lat) * H * 0.62 + Math.cos(lon) * lat * H * 0.08;
      const r = (S / 70) * (0.6 + 0.6 * fxSeed(i, 7)) * (1 + 0.6 * hit) * (0.6 + 0.4 * facing);
      const col = FX_LIGHT_COLORS[(i + bar) % FX_LIGHT_COLORS.length];
      const [cr, cgc, cb] = hexRgb(col);
      const al = db.amt * (0.35 + 0.45 * hit) * facing;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(255,255,255,${al})`);
      grad.addColorStop(0.35, `rgba(${cr},${cgc},${cb},${al})`);
      grad.addColorStop(1, `rgba(${cr},${cgc},${cb},0)`);
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  // Lasers: thin beams from a point below the frame, sweeping; the set changes color on the beat.
  if (lz && lz.amt > 0) {
    const n = Math.max(2, Math.min(24, lz.beams | 0));
    const step = Math.floor(tm.count / lz.every);
    const hit = fxHit(tm, lz.every, 3);
    const ox = W / 2;
    const oy = H * 1.05;
    const L = Math.hypot(W, H) * 1.3;
    const sweep = Math.sin(now * 0.9) * 0.55;
    const col = FX_LIGHT_COLORS[step % FX_LIGHT_COLORS.length];
    const [cr, cgc, cb] = hexRgb(col);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'butt';
    for (let i = 0; i < n; i++) {
      const spread = (i / (n - 1) - 0.5) * (1.1 + 0.4 * hit);
      const ang = -Math.PI / 2 + spread + sweep * (i % 2 ? 1 : -1);
      const x1 = ox + Math.cos(ang) * L;
      const y1 = oy + Math.sin(ang) * L;
      for (const [w, a] of [[S / 60, 0.12], [S / 220, 0.55], [S / 700, 0.9]]) {
        g.strokeStyle = `rgba(${cr},${cgc},${cb},${a * lz.amt * (0.65 + 0.35 * hit)})`;
        g.lineWidth = Math.max(0.5, w);
        g.beginPath();
        g.moveTo(ox, oy);
        g.lineTo(x1, y1);
        g.stroke();
      }
    }
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.restore();
}

function fxPaintText(g, W, H, now, tm) {
  const t = fx.text;
  const age = now - t.at;
  if (age > t.hold + 0.4) { fx.text = null; return; }
  const out = age > t.hold ? 1 - (age - t.hold) / 0.4 : 1;
  const size = Math.round((t.size * H) / 720);
  g.save();
  g.font = `800 ${size}px "Segoe UI", sans-serif`;
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.75)';
  g.shadowBlur = size * 0.35;
  g.fillStyle = t.color;
  const y = t.where === 'top' ? H * 0.16 : t.where === 'center' ? H * 0.5 : H * 0.82;
  const beatLen = tm.beatLen;
  if (t.style === 'pop') {
    // One word per `every` beats, each popping in; the line stays centered as it grows.
    const n = Math.min(t.words.length, 1 + Math.floor(age / (beatLen * t.every)));
    const shown = t.words.slice(0, n);
    const widths = shown.map((w) => g.measureText(`${w} `).width);
    let x = (W - widths.reduce((p, q) => p + q, 0)) / 2;
    shown.forEach((w, k) => {
      const since = age - k * beatLen * t.every;
      const s = k === n - 1 ? 1 + 0.35 * Math.max(0, 1 - since / (beatLen * 0.5)) : 1;
      g.save();
      g.globalAlpha = out;
      g.translate(x + widths[k] / 2, y);
      g.scale(s, s);
      g.textAlign = 'center';
      g.fillText(w, 0, 0);
      g.restore();
      x += widths[k];
    });
  } else {
    let text = t.text;
    let dx = 0;
    let alpha = Math.min(1, age / 0.25) * out;
    if (t.style === 'type') text = t.text.slice(0, Math.max(1, Math.floor(age / (beatLen / 4))));
    if (t.style === 'slide') { dx = -W * 0.6 * Math.pow(Math.max(0, 1 - age / 0.35), 3); alpha = out; }
    g.globalAlpha = alpha;
    g.textAlign = 'center';
    g.fillText(text, W / 2 + dx, y);
  }
  g.restore();
}

// ---------- the viewer and the FX menu ----------
let fxCanvas = null;
function fxViewer() {
  if (!fxCanvas) return;
  const on = fxActive() && viewerLayers && viewerLayers.length > 0;
  fxCanvas.hidden = !on;
  if (!on) return;
  const box = $('viewer');
  const w = Math.max(320, Math.round(box.clientWidth * 0.75));
  const h = Math.max(180, Math.round(box.clientHeight * 0.75));
  if (fxCanvas.width !== w || fxCanvas.height !== h) { fxCanvas.width = w; fxCanvas.height = h; }
  fxPaint(fxCanvas.getContext('2d'), fxCanvas, viewerLayers);
}

// Keep the menu and the saved state in step with fx.
function fxSync() {
  if (typeof state !== 'undefined' && state) state.fx = { mode: fx.mode, amount: fx.amount, preset: fx.preset, effects: fx.effects.map(({ lastIdx, ...e }) => e) };
  if (!$('fxMode')) return;
  $('fxMode').value = FX_PRESETS[fx.preset] ? fx.preset : 'custom';
  $('fxAmount').value = fx.amount;
  for (const box of document.querySelectorAll('#fxPanel input[data-fx]')) box.checked = !!fxEffect(box.dataset.fx);
}

// Older code and saved states call setFx(mode, amount).
function setFx(mode, amount) {
  if (mode != null) {
    if (FX_PRESETS[mode]) fxPreset(mode);
    else if (mode === 'mirror') fxPreset('shroomMirror');
    else fx.mode = mode;
  }
  if (amount != null) fx.amount = Math.max(0, Math.min(1, amount));
  fxSync();
}

function initFx() {
  fxCanvas = document.createElement('canvas');
  fxCanvas.id = 'fxView';
  fxCanvas.hidden = true;
  $('viewer').appendChild(fxCanvas);
  const sel = $('fxMode');
  const names = { off: 'Off', shroom: 'Shroom', shroomMirror: 'Shroom + mirror', rodeo: 'Rodeo', archival: 'Archival film', vhsParty: 'VHS party', neonClub: 'Neon club', comic: 'Comic', heat: 'Heat', nightVision: 'Night vision', noir: 'Noir', brand: 'Brand duotone', splitBeat: 'Split on the beat', dream: 'Dream', discoSpace: 'Disco space', warp: 'Warp', laserShow: 'Laser show', cosmos: 'Cosmos' };
  sel.innerHTML = Object.keys(FX_PRESETS).map((k) => `<option value="${k}">${names[k] || k}</option>`).join('') + '<option value="custom">Custom</option>';
  // The effects panel: every effect, tick to add or remove it.
  const panel = $('fxPanel');
  const groups = { beat: 'On the beat', look: 'Looks', light: 'Light', compose: 'Compose' };
  panel.innerHTML = Object.entries(groups).map(([g, label]) => `<div class="fxGroup"><b>${label}</b>${Object.entries(FX_CATALOG).filter(([, c]) => c.group === g).map(([k, c]) => `<label title="${c.about}"><input type="checkbox" data-fx="${k}"> ${c.label}</label>`).join('')}</div>`).join('');
  panel.addEventListener('change', (e) => {
    const k = e.target.dataset.fx;
    if (!k) return;
    if (e.target.checked) fxAdd(k); else fxRemove(k);
    fx.preset = 'custom';
    fxSync();
    save();
  });
  $('fxMore').addEventListener('click', () => { panel.hidden = !panel.hidden; });
  const saved = state.fx;
  if (saved) {
    if (saved.preset && FX_PRESETS[saved.preset]) fxPreset(saved.preset);
    else fx.mode = saved.mode || 'off';
    if (saved.effects && saved.preset === 'custom') { fx.preset = 'custom'; fxUse(saved.effects.map((e) => [e.name, e])); }
    if (typeof saved.amount === 'number') fx.amount = saved.amount;
  }
  fxSync();
  sel.addEventListener('change', (e) => { if (e.target.value !== 'custom') fxPreset(e.target.value); fxSync(); save(); });
  $('fxAmount').addEventListener('input', (e) => { fx.amount = Number(e.target.value); fxSync(); save(); });
  setInterval(fxViewer, 33);
}

// Smoke-test only: every effect and preset paints without error and changes the picture; the
// flash limiter holds a strobe asked for 8 flashes a second to 3.
window.__smokeFx = async () => {
  const src = document.createElement('canvas');
  src.width = 64;
  src.height = 36;
  const sg = src.getContext('2d');
  const grad = sg.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, '#203040');
  grad.addColorStop(1, '#e0d0b0');
  sg.fillStyle = grad;
  sg.fillRect(0, 0, 64, 36);
  sg.fillStyle = '#00ff00';
  sg.fillRect(20, 8, 24, 20); // a green patch for the chroma key
  const src2 = document.createElement('canvas');
  src2.width = 64;
  src2.height = 36;
  const s2 = src2.getContext('2d');
  s2.fillStyle = '#a03020';
  s2.fillRect(0, 0, 64, 36);
  const el1 = Object.assign(src, { videoWidth: 64, videoHeight: 36 });
  const el2 = Object.assign(src2, { videoWidth: 64, videoHeight: 36 });
  const out = document.createElement('canvas');
  out.width = 64;
  out.height = 36;
  const og = out.getContext('2d', { willReadFrequently: true });
  const pixels = () => og.getImageData(0, 0, 64, 36).data;
  const differ = (p, q) => { let s = 0; for (let k = 0; k < p.length; k += 4) s += Math.abs(p[k] - q[k]) + Math.abs(p[k + 1] - q[k + 1]) + Math.abs(p[k + 2] - q[k + 2]); return s / (p.length / 4); };
  const saved = { mode: fx.mode, amount: fx.amount, effects: fx.effects, preset: fx.preset, master: fx.master, bpm: fx.bpm, follow: fx.follow };
  fx.follow = null;
  fx.bpm = 120;
  fxPreset('off');
  fxNote([{ el: el2, alpha: 1 }]);
  fxNote([{ el: el1, alpha: 1 }]); // el2 is now "the previous clip"
  paintLayers(og, out, [{ el: el1, alpha: 1 }]);
  const plain = pixels();
  const res = { effects: {}, presets: {}, errors: [] };
  for (const name of Object.keys(FX_CATALOG)) {
    try {
      fxUse([[name, { amount: 1 }]]);
      fx.mode = 'off';
      fx.t0 = performance.now() / 1000; // on a downbeat, so beat effects are at their peak
      fxPaint(og, out, [{ el: el1, alpha: 1 }]);
      fxPaint(og, out, [{ el: el1, alpha: 1 }]);
      res.effects[name] = +differ(pixels(), plain).toFixed(1);
    } catch (e) { res.errors.push(`${name}: ${e.message}`); }
  }
  for (const name of Object.keys(FX_PRESETS)) {
    try { fxPreset(name); fxPaint(og, out, [{ el: el1, alpha: 1 }]); res.presets[name] = +differ(pixels(), plain).toFixed(1); } catch (e) { res.errors.push(`preset ${name}: ${e.message}`); }
  }
  try { fxPreset('off'); fxText('when the chips are down', { style: 'pop' }); fxPaint(og, out, [{ el: el1, alpha: 1 }]); res.text = +differ(pixels(), plain).toFixed(1); fxText(null); } catch (e) { res.errors.push(`text: ${e.message}`); }
  // Flash limiter: a strobe on every eighth of a beat at 240 BPM asks for 16 a second.
  fxPreset('off');
  fx.bpm = 240;
  fxUse([['strobe', { amount: 1, every: 0.5 }]]);
  const t0 = performance.now();
  let flashes = 0;
  let wasWhite = false;
  while (performance.now() - t0 < 2000) {
    fxPaint(og, out, [{ el: el1, alpha: 1 }]);
    const p = og.getImageData(32, 18, 1, 1).data;
    const white = p[0] > 250 && p[1] > 250 && p[2] > 250;
    if (white && !wasWhite) flashes++;
    wasWhite = white;
    await new Promise((r) => setTimeout(r, 8));
  }
  res.flashesIn2s = flashes;
  Object.assign(fx, saved);
  fxSync();
  return { ...res, viewerCanvas: !!document.getElementById('fxView') };
};
