import * as ops from './audio-ops.js';
import { encodeWav, encodeMp3 } from './encoders.js';

const $ = (id) => document.getElementById(id);
const MAX_PADS = 16;
const UNDO_BYTES = 300 * 1024 * 1024; // keep undo history from eating phone memory

const state = {
  clip: null,
  name: 'sample',
  sel: null, // { start, end } in samples
  view: null, // { start, end } visible range in samples
  undo: [],
  redo: [],
  pads: [], // { clip }
  selectedPad: -1,
  loop: false,
};

// --- Audio context & playback ---------------------------------------------

let actx = null;
function audio() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

const bufferCache = new WeakMap();
function toAudioBuffer(clip) {
  let buf = bufferCache.get(clip);
  if (!buf) {
    buf = audio().createBuffer(clip.channels.length, ops.clipLength(clip), clip.sampleRate);
    clip.channels.forEach((ch, i) => buf.getChannelData(i).set(ch));
    bufferCache.set(clip, buf);
  }
  return buf;
}

// The one "main" voice (editor playback or pitch preview). Pads play separately.
let playing = null;

function startVoice(clip, { offset = 0, duration, loop = false, rate = 1, kind = 'main' } = {}) {
  stopPlayback();
  const c = audio();
  const src = c.createBufferSource();
  src.buffer = toAudioBuffer(clip);
  src.playbackRate.value = rate;
  src.connect(c.destination);
  const dur = duration ?? clip.channels[0].length / clip.sampleRate - offset;
  if (loop) {
    src.loop = true;
    src.loopStart = offset;
    src.loopEnd = offset + dur;
    src.start(0, offset);
  } else {
    src.start(0, offset, dur);
  }
  src.onended = () => {
    if (playing && playing.source === src) {
      playing = null;
      updatePlayButton();
      draw();
    }
  };
  playing = { source: src, kind, t0: c.currentTime, offset, dur, loop };
  updatePlayButton();
  if (kind === 'main') requestAnimationFrame(animate);
}

function stopPlayback() {
  if (!playing) return;
  const p = playing;
  playing = null;
  try { p.source.stop(); } catch { /* already stopped */ }
  updatePlayButton();
  draw();
}

function playEditor() {
  if (playing) return stopPlayback();
  const [s, e] = range();
  const sr = state.clip.sampleRate;
  startVoice(state.clip, { offset: s / sr, duration: (e - s) / sr, loop: state.loop });
}

function playheadSample() {
  if (!playing || playing.kind !== 'main') return null;
  let t = actx.currentTime - playing.t0;
  if (playing.loop) t %= playing.dur;
  else if (t > playing.dur) return null;
  return (playing.offset + t) * state.clip.sampleRate;
}

function animate() {
  if (!playing || playing.kind !== 'main') return;
  draw();
  requestAnimationFrame(animate);
}

function updatePlayButton() {
  $('play').textContent = playing && playing.kind === 'main' ? '■ Stop' : '▶ Play';
  $('pitch-preview').textContent = playing && playing.kind === 'preview' ? '■ Stop' : '▶ Preview';
}

// --- Helpers ----------------------------------------------------------------

function range() {
  const len = ops.clipLength(state.clip);
  return state.sel ? [state.sel.start, state.sel.end] : [0, len];
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function clipBytes(clip) {
  return clip.channels.length * ops.clipLength(clip) * 4;
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function setBusyText(text) { $('busy-text').textContent = text; }

// Show a spinner, let it paint, then run something that may block for a bit.
async function busy(text, fn) {
  setBusyText(text);
  $('busy').hidden = false;
  await nextPaint();
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(`Something went wrong: ${err.message || err}`);
  } finally {
    $('busy').hidden = true;
  }
}

// --- Editing & undo ---------------------------------------------------------

function applyClip(clip, sel) {
  stopPlayback();
  const lengthChanged = !state.clip || ops.clipLength(state.clip) !== ops.clipLength(clip);
  state.clip = clip;
  state.sel = sel && sel.end > sel.start ? sel : null;
  if (lengthChanged || !state.view) state.view = { start: 0, end: ops.clipLength(clip) };
  waveCache = null;
  $('file-duration').textContent = fmtTime(ops.clipDuration(clip));
  refresh();
}

function trimUndo() {
  let total = clipBytes(state.clip);
  for (let i = state.undo.length - 1; i >= 0; i--) {
    total += clipBytes(state.undo[i].clip);
    if (total > UNDO_BYTES && i < state.undo.length - 1) {
      state.undo.splice(0, i + 1);
      break;
    }
  }
}

function commit(clip, sel = null) {
  state.undo.push({ clip: state.clip, sel: state.sel });
  state.redo = [];
  applyClip(clip, sel);
  trimUndo();
}

function undo() {
  const prev = state.undo.pop();
  if (!prev) return;
  state.redo.push({ clip: state.clip, sel: state.sel });
  applyClip(prev.clip, prev.sel);
}

function redo() {
  const next = state.redo.pop();
  if (!next) return;
  state.undo.push({ clip: state.clip, sel: state.sel });
  applyClip(next.clip, next.sel);
}

// Run an effect over the selection (or everything) and keep the selection.
function effect(fn) {
  if (!state.clip) return;
  const [s, e] = range();
  commit(fn(state.clip, s, e), state.sel);
}

// --- Loading ----------------------------------------------------------------

function decode(data) {
  const c = audio();
  return new Promise((resolve, reject) => {
    // Older Safari only supports the callback form.
    const p = c.decodeAudioData(data, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

async function loadFile(file) {
  await busy('Loading…', async () => {
    let buf;
    try {
      buf = await decode(await file.arrayBuffer());
    } catch {
      toast('Couldn’t read that file. Try an MP3, M4A or WAV.');
      return;
    }
    const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
    state.name = file.name.replace(/\.[^.]+$/, '') || 'sample';
    state.undo = [];
    state.redo = [];
    state.view = null;
    state.clip = null;
    applyClip(ops.createClip(buf.sampleRate, channels), null);
    $('file-name').textContent = file.name;
    $('export-name').value = `${state.name}-edit`;
    $('export-result').hidden = true;
    $('empty').hidden = true;
    $('editor').hidden = false;
    resizeCanvas();
  });
}

// --- Waveform ---------------------------------------------------------------

const canvas = $('wave');
const g = canvas.getContext('2d');
let waveCache = null;
const css = getComputedStyle(document.documentElement);
const colors = {
  wave: css.getPropertyValue('--wave').trim(),
  sel: css.getPropertyValue('--sel').trim(),
  accent: css.getPropertyValue('--accent').trim(),
  mid: css.getPropertyValue('--panel-2').trim(),
};

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  if (!r.width) return;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  waveCache = null;
  draw();
}

function renderWave() {
  const W = canvas.width;
  const H = canvas.height;
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const o = off.getContext('2d');
  const { start, end } = state.view;
  const span = end - start;
  const chs = state.clip.channels;
  const mid = H / 2;
  const amp = H / 2 - 4;

  o.fillStyle = colors.mid;
  o.fillRect(0, Math.floor(mid), W, 1);
  o.fillStyle = colors.wave;
  for (let x = 0; x < W; x++) {
    const a = start + Math.floor((x * span) / W);
    const b = Math.max(a + 1, start + Math.floor(((x + 1) * span) / W));
    let lo = 1;
    let hi = -1;
    for (const ch of chs) {
      for (let i = a; i < b && i < ch.length; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (hi < lo) continue;
    const y1 = mid - hi * amp;
    const y2 = mid - lo * amp;
    o.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  return off;
}

function sampleToX(s) {
  const { start, end } = state.view;
  return ((s - start) / (end - start)) * canvas.width;
}

function xToSample(clientX) {
  const r = canvas.getBoundingClientRect();
  const { start, end } = state.view;
  const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  return Math.round(start + frac * (end - start));
}

function draw() {
  if (!state.clip || !canvas.width) return;
  if (!waveCache) waveCache = renderWave();
  const W = canvas.width;
  const H = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  g.clearRect(0, 0, W, H);
  g.drawImage(waveCache, 0, 0);

  if (state.sel) {
    const x1 = sampleToX(state.sel.start);
    const x2 = sampleToX(state.sel.end);
    g.fillStyle = colors.sel;
    g.fillRect(x1, 0, x2 - x1, H);
    g.fillStyle = colors.accent;
    g.fillRect(x1 - dpr, 0, 2 * dpr, H);
    g.fillRect(x2 - dpr, 0, 2 * dpr, H);
    // grab tabs so the edges are easy to find with a thumb
    g.fillRect(x1 - 6 * dpr, 0, 12 * dpr, 10 * dpr);
    g.fillRect(x2 - 6 * dpr, H - 10 * dpr, 12 * dpr, 10 * dpr);
  }

  const ph = playheadSample();
  if (ph != null) {
    g.fillStyle = '#ffffff';
    g.fillRect(sampleToX(ph) - dpr / 2, 0, dpr, H);
  }
}

let drag = null;

canvas.addEventListener('pointerdown', (e) => {
  if (!state.clip) return;
  canvas.setPointerCapture(e.pointerId);
  const s = xToSample(e.clientX);
  const r = canvas.getBoundingClientRect();
  const pxPerSample = r.width / (state.view.end - state.view.start);
  const dist = (v) => Math.abs(v - s) * pxPerSample;
  const grab = 24;
  if (state.sel && dist(state.sel.start) < grab && dist(state.sel.start) <= dist(state.sel.end)) {
    drag = { anchor: state.sel.end, x0: e.clientX, moved: true };
  } else if (state.sel && dist(state.sel.end) < grab) {
    drag = { anchor: state.sel.start, x0: e.clientX, moved: true };
  } else {
    drag = { anchor: s, x0: e.clientX, moved: false };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x0) > 6) drag.moved = true;
  if (!drag.moved) return;
  const s = xToSample(e.clientX);
  state.sel = { start: Math.min(drag.anchor, s), end: Math.max(drag.anchor, s) };
  updateSelInfo();
  draw();
});

function endDrag() {
  if (!drag) return;
  if (!drag.moved || (state.sel && state.sel.end - state.sel.start < 2)) state.sel = null;
  drag = null;
  refresh();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function zoomToSelection() {
  if (!state.clip) return;
  const len = ops.clipLength(state.clip);
  const { start, end } = state.view;
  let a;
  let b;
  if (state.sel) {
    const pad = Math.round((state.sel.end - state.sel.start) * 0.1);
    a = state.sel.start - pad;
    b = state.sel.end + pad;
  } else {
    const c = (start + end) / 2;
    const half = (end - start) / 4;
    a = c - half;
    b = c + half;
  }
  const minSpan = Math.round(state.clip.sampleRate * 0.01);
  if (b - a < minSpan) {
    const c = (a + b) / 2;
    a = c - minSpan / 2;
    b = c + minSpan / 2;
  }
  state.view = { start: Math.max(0, Math.round(a)), end: Math.min(len, Math.round(b)) };
  waveCache = null;
  draw();
}

function zoomOut() {
  if (!state.clip) return;
  state.view = { start: 0, end: ops.clipLength(state.clip) };
  waveCache = null;
  draw();
}

// --- UI state ---------------------------------------------------------------

function updateSelInfo() {
  const el = $('sel-info');
  if (!state.sel) {
    el.textContent = 'Drag on the waveform to select. Tap to clear.';
    return;
  }
  const sr = state.clip.sampleRate;
  const a = state.sel.start / sr;
  const b = state.sel.end / sr;
  el.textContent = `Selection ${fmtTime(a)} – ${fmtTime(b)} · ${(b - a).toFixed(2)} s`;
}

function updateButtons() {
  const hasSel = !!state.sel;
  document.querySelectorAll('[data-needs-sel]').forEach((b) => { b.disabled = !hasSel; });
  $('undo').disabled = !state.undo.length;
  $('redo').disabled = !state.redo.length;
  const hasPad = state.selectedPad >= 0 && !!state.pads[state.selectedPad];
  $('pad-open').disabled = !hasPad;
  $('pad-export').disabled = !hasPad;
  $('pad-delete').disabled = !hasPad;
  $('bitrate-field').hidden = $('export-format').value !== 'mp3';
  $('zoom-in').textContent = hasSel ? 'Zoom to sel' : 'Zoom in';
}

function refresh() {
  updateSelInfo();
  updateButtons();
  renderPads();
  draw();
}

// --- Pads -------------------------------------------------------------------

function renderPads() {
  const el = $('pads');
  el.textContent = '';
  for (let i = 0; i < MAX_PADS; i++) {
    const pad = state.pads[i];
    const b = document.createElement('button');
    b.className = 'pad';
    b.dataset.index = i;
    if (pad) {
      b.classList.add('filled');
      if (i === state.selectedPad) b.classList.add('selected');
      b.innerHTML = `<span class="num">${i + 1}</span><span class="len">${ops.clipDuration(pad.clip).toFixed(2)}s</span>`;
      b.setAttribute('aria-label', `Pad ${i + 1}`);
    } else {
      b.classList.add('empty');
      b.innerHTML = `<span class="num">${i + 1}</span>`;
      b.disabled = true;
    }
    el.appendChild(b);
  }
}

function triggerPad(i) {
  const pad = state.pads[i];
  if (!pad) return;
  const c = audio();
  const src = c.createBufferSource();
  src.buffer = toAudioBuffer(pad.clip);
  src.connect(c.destination);
  src.start();
  if (state.selectedPad !== i) {
    state.selectedPad = i;
    renderPads();
    updateButtons();
  }
  const btn = $('pads').children[i];
  btn.classList.add('hit');
  setTimeout(() => btn.classList.remove('hit'), 120);
}

// pointerdown instead of click so pads fire instantly, like a real sampler
$('pads').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.pad');
  if (!b || b.disabled) return;
  e.preventDefault();
  triggerPad(Number(b.dataset.index));
});
$('pads').addEventListener('click', (e) => {
  // keyboard activation only (pointer taps were handled above)
  const b = e.target.closest('.pad');
  if (b && e.detail === 0) triggerPad(Number(b.dataset.index));
});

function addPads(clips) {
  const room = MAX_PADS - state.pads.length;
  if (room <= 0) return toast('All 16 pads are full. Remove one first.');
  state.pads.push(...clips.slice(0, room).map((clip) => ({ clip })));
  state.selectedPad = state.pads.length - 1;
  if (clips.length > room) toast(`Only ${room} pad(s) were free.`);
  refresh();
}

// --- Export -----------------------------------------------------------------

let exportUrl = null;

function safeName(name) {
  return (name || 'sample').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'sample';
}

async function exportClip(clip, name) {
  const format = $('export-format').value;
  const kbps = Number($('export-bitrate').value);
  await busy('Encoding…', async () => {
    const blob = format === 'wav'
      ? encodeWav(clip)
      : await encodeMp3(clip, kbps, (p) => setBusyText(`Encoding MP3… ${Math.round(p * 100)}%`));
    const fileName = `${safeName(name)}.${format}`;
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(blob);
    const link = $('export-download');
    link.href = exportUrl;
    link.download = fileName;
    $('export-label').textContent = `${fileName} · ${(blob.size / 1024 / 1024).toFixed(2)} MB`;

    const share = $('export-share');
    const file = new File([blob], fileName, { type: blob.type });
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    share.hidden = !canShare;
    share.onclick = () => navigator.share({ files: [file], title: fileName }).catch(() => {});

    $('export-result').hidden = false;
    $('export-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// --- Pitch ------------------------------------------------------------------

function pitchSemis() { return Number($('pitch').value); }
function pitchMode() { return document.querySelector('input[name="pitch-mode"]:checked').value; }

function setPitch(v) {
  const clamped = Math.max(-24, Math.min(24, v));
  $('pitch').value = clamped;
  $('pitch-value').textContent = `${clamped > 0 ? '+' : ''}${clamped} st`;
}

function processPitch(clip) {
  const semis = pitchSemis();
  return pitchMode() === 'tape' ? ops.pitchTape(clip, semis) : ops.pitchKeepLength(clip, semis);
}

async function previewPitch() {
  if (playing && playing.kind === 'preview') return stopPlayback();
  const [s, e] = range();
  const region = ops.slice(state.clip, s, e);
  if (pitchMode() === 'tape') {
    // speeding up playback is exactly what tape mode does, so no processing needed
    startVoice(region, { rate: ops.semitonesToRatio(pitchSemis()), kind: 'preview' });
  } else {
    const processed = await busy('Shifting pitch…', () => processPitch(region));
    if (processed) startVoice(processed, { kind: 'preview' });
  }
}

async function applyPitch() {
  if (pitchSemis() === 0) return toast('Move the pitch slider first.');
  const [s, e] = range();
  const hadSel = !!state.sel;
  await busy('Shifting pitch…', () => {
    const processed = processPitch(ops.slice(state.clip, s, e));
    if (hadSel) {
      commit(ops.splice(state.clip, s, e, processed), { start: s, end: s + ops.clipLength(processed) });
    } else {
      commit(processed, null);
    }
    setPitch(0);
  });
}

// --- Wiring -----------------------------------------------------------------

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) loadFile(file);
});

$('play').addEventListener('click', playEditor);
$('loop').addEventListener('click', () => {
  state.loop = !state.loop;
  $('loop').setAttribute('aria-pressed', String(state.loop));
  if (playing && playing.kind === 'main') {
    stopPlayback();
    playEditor();
  }
});
$('zoom-in').addEventListener('click', zoomToSelection);
$('zoom-out').addEventListener('click', zoomOut);
$('select-all').addEventListener('click', () => {
  state.sel = { start: 0, end: ops.clipLength(state.clip) };
  refresh();
});
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);

$('crop').addEventListener('click', () => {
  const [s, e] = range();
  commit(ops.declick(ops.slice(state.clip, s, e)), null);
});
$('delete').addEventListener('click', () => {
  const [s, e] = range();
  if (s === 0 && e === ops.clipLength(state.clip)) return toast('That would delete everything.');
  commit(ops.removeRange(state.clip, s, e), null);
});
$('to-pad').addEventListener('click', () => {
  const [s, e] = range();
  addPads([ops.declick(ops.slice(state.clip, s, e))]);
});
$('chop').addEventListener('click', () => {
  const n = Number($('chop-count').value);
  if (state.pads.length && !confirm('Replace the current pads with the new slices?')) return;
  const [s, e] = range();
  state.pads = [];
  addPads(ops.chop(ops.slice(state.clip, s, e), n).map((c) => ops.declick(c)));
  state.selectedPad = 0;
  refresh();
});

$('reverse').addEventListener('click', () => effect(ops.reverse));
$('normalize').addEventListener('click', () => effect(ops.normalize));
$('fade-in').addEventListener('click', () => effect((c, s, e) => ops.fade(c, 'in', s, e)));
$('fade-out').addEventListener('click', () => effect((c, s, e) => ops.fade(c, 'out', s, e)));

$('pitch').addEventListener('input', () => setPitch(pitchSemis()));
$('pitch-down').addEventListener('click', () => setPitch(pitchSemis() - 1));
$('pitch-up').addEventListener('click', () => setPitch(pitchSemis() + 1));
$('pitch-oct-down').addEventListener('click', () => setPitch(pitchSemis() - 12));
$('pitch-oct-up').addEventListener('click', () => setPitch(pitchSemis() + 12));
$('pitch-reset').addEventListener('click', () => setPitch(0));
$('pitch-preview').addEventListener('click', previewPitch);
$('pitch-apply').addEventListener('click', applyPitch);

$('pad-open').addEventListener('click', () => {
  const pad = state.pads[state.selectedPad];
  if (pad) commit(pad.clip, null);
});
$('pad-export').addEventListener('click', () => {
  const pad = state.pads[state.selectedPad];
  if (pad) exportClip(pad.clip, `${state.name}-pad${state.selectedPad + 1}`);
});
$('pad-delete').addEventListener('click', () => {
  state.pads.splice(state.selectedPad, 1);
  state.selectedPad = Math.min(state.selectedPad, state.pads.length - 1);
  refresh();
});

$('export-format').addEventListener('change', updateButtons);
$('export').addEventListener('click', () => {
  const scope = document.querySelector('input[name="export-scope"]:checked').value;
  if (scope === 'sel' && !state.sel) return toast('Select part of the waveform first, or export the whole file.');
  const clip = scope === 'sel' ? ops.slice(state.clip, state.sel.start, state.sel.end) : state.clip;
  exportClip(clip, $('export-name').value);
});

window.addEventListener('resize', resizeCanvas);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
