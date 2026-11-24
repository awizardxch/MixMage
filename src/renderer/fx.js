// Shroom FX: psychedelic color over the picture, in the viewer and in the recorded output.
//   - a rainbow wash in the canvas "color" blend mode, so even black-and-white footage takes color
//     (the frame keeps its own light and shade; only hue and saturation come from the wash)
//   - hue drift and extra saturation for footage that is already in color
//   - an optional kaleidoscope mirror
//   - trails: the last frame, zoomed and turned a little, ghosted over the new one (the melting tunnel)
//   - everything breathes on the beat: a pulse of zoom and brightness on each beat, a flash on demand
// The same paint runs for the viewer (a canvas laid over the videos) and for "Record output".
const fx = {
  mode: 'off', // 'off' | 'shroom' | 'mirror'
  amount: 0.8, // 0..1, how strong the color is
  trails: 0.55, // 0..1, how long the ghosts last
  bpm: 0, // the beat the picture breathes to; 0 = follow the playing deck or source
  t0: 0, // performance.now()/1000 of a downbeat, so the pulse lands on the beat
  beat: 0.6, // 0..1, how hard each beat pulses
  flashAt: -1, // a one-off flash (a drop)
  spin: 1, // how fast the colors travel
};
const fxPrev = new WeakMap(); // canvas -> its previous frame, for trails

function fxActive() { return fx.mode !== 'off' && fx.amount > 0; }

function fxFlash() { fx.flashAt = performance.now() / 1000; }

// The tempo the picture follows when no script has set one: the playing deck's tempo (at its rate),
// else the current source's.
function fxTempo() {
  if (fx.bpm) return fx.bpm;
  for (const d of decks) if (d.playing && d.item && d.item.bpm) return d.item.bpm * (d.video.playbackRate || 1);
  return (currentSource && currentSource.bpm) || 120;
}

function fxPaint(g, canvas, layers) {
  const W = canvas.width;
  const H = canvas.height;
  const now = performance.now() / 1000;
  const a = fx.amount;
  const beatLen = 60 / fxTempo();
  const phase = ((((now - fx.t0) / beatLen) % 1) + 1) % 1;
  const pulse = fx.beat * Math.pow(1 - phase, 4); // sharp on the beat, gone by the off-beat
  const flash = fx.flashAt >= 0 ? Math.max(0, 1 - (now - fx.flashAt) / (beatLen * 2)) : 0;
  const hue = (now * 55 * fx.spin) % 360;

  // 1. The frame, hue-drifted and saturated, pushed in a little on each beat.
  g.save();
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.filter = `hue-rotate(${hue.toFixed(0)}deg) saturate(${(1 + 1.8 * a).toFixed(2)}) contrast(${(1 + 0.3 * a).toFixed(2)}) brightness(${(1 + 0.35 * pulse + 0.6 * flash).toFixed(2)})`;
  const zoom = 1 + 0.045 * pulse;
  for (const { el, alpha } of layers) {
    if (!el || !el.videoWidth || alpha <= 0) continue;
    // Fill the frame (crop) rather than letterbox: the trails would turn a letterbox's edges into
    // glowing rectangles.
    const s = Math.max(W / el.videoWidth, H / el.videoHeight) * zoom;
    const w = el.videoWidth * s;
    const h = el.videoHeight * s;
    g.globalAlpha = alpha;
    g.drawImage(el, (W - w) / 2, (H - h) / 2, w, h);
  }
  g.filter = 'none';

  // 2. The rainbow wash, travelling across the frame.
  const ang = now * 0.6 * fx.spin;
  const r = Math.hypot(W, H) / 2;
  const grad = g.createLinearGradient(W / 2 - Math.cos(ang) * r, H / 2 - Math.sin(ang) * r, W / 2 + Math.cos(ang) * r, H / 2 + Math.sin(ang) * r);
  for (let k = 0; k <= 6; k++) grad.addColorStop(k / 6, `hsl(${(hue * 2 + k * 60) % 360}, 100%, 50%)`);
  g.globalCompositeOperation = 'color';
  g.globalAlpha = Math.min(1, 0.85 * a + 0.3 * flash);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // "color" keeps white white (it keeps the light); a light multiply tints the whites too, so a
  // black-and-white cartoon's paper turns pastel instead of staying bare.
  g.globalCompositeOperation = 'multiply';
  g.globalAlpha = 0.4 * a;
  g.fillRect(0, 0, W, H);

  // 3. Kaleidoscope: the left half, mirrored onto the right, then the top onto the bottom.
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  if (fx.mode === 'mirror') {
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

  // 4. Trails: the previous frame, zoomed and turned, over this one where it is lighter. ("lighten",
  // not "screen": screen adds up frame after frame and bleaches the picture white.)
  let prev = fxPrev.get(canvas);
  if (!prev || prev.width !== W || prev.height !== H) {
    prev = document.createElement('canvas');
    prev.width = W;
    prev.height = H;
    fxPrev.set(canvas, prev);
  }
  if (fx.trails > 0) {
    g.save();
    g.globalCompositeOperation = 'lighten';
    g.globalAlpha = Math.min(0.85, fx.trails * (0.55 + 0.45 * a));
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
  g.restore();
}

// ---------- the viewer ----------
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

function setFx(mode, amount) {
  if (mode != null) fx.mode = mode;
  if (amount != null) fx.amount = Math.max(0, Math.min(1, amount));
  if ($('fxMode')) { $('fxMode').value = fx.mode; $('fxAmount').value = fx.amount; }
  state.fx = { mode: fx.mode, amount: fx.amount };
}

function initFx() {
  fxCanvas = document.createElement('canvas');
  fxCanvas.id = 'fxView';
  fxCanvas.hidden = true;
  $('viewer').appendChild(fxCanvas);
  if (state.fx) { fx.mode = state.fx.mode || 'off'; fx.amount = typeof state.fx.amount === 'number' ? state.fx.amount : 0.8; }
  $('fxMode').value = fx.mode;
  $('fxAmount').value = fx.amount;
  $('fxMode').addEventListener('change', (e) => { setFx(e.target.value); save(); });
  $('fxAmount').addEventListener('input', (e) => { setFx(null, Number(e.target.value)); save(); });
  setInterval(fxViewer, 33);
}

// Smoke-test only: a gray frame must come out colored with the effect on, and untouched with it off.
window.__smokeFx = async () => {
  const src = document.createElement('canvas');
  src.width = 64;
  src.height = 36;
  const sg = src.getContext('2d');
  sg.fillStyle = '#808080';
  sg.fillRect(0, 0, 64, 36);
  // paintLayers and fxPaint draw "video-like" layers; give the canvas the fields they read.
  const layer = { el: Object.assign(src, { videoWidth: 64, videoHeight: 36 }), alpha: 1 };
  const out = document.createElement('canvas');
  out.width = 64;
  out.height = 36;
  const og = out.getContext('2d');
  const spread = () => {
    const d = og.getImageData(0, 0, 64, 36).data;
    let m = 0;
    for (let k = 0; k < d.length; k += 4) m = Math.max(m, Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2]));
    return m;
  };
  const was = { mode: fx.mode, amount: fx.amount };
  fx.mode = 'off';
  paintLayers(og, out, [layer]);
  const offSpread = spread();
  fx.mode = 'mirror';
  fx.amount = 0.8;
  paintLayers(og, out, [layer]);
  paintLayers(og, out, [layer]);
  const onSpread = spread();
  fx.mode = was.mode;
  fx.amount = was.amount;
  return { offSpread, onSpread, viewerCanvas: !!document.getElementById('fxView') };
};
