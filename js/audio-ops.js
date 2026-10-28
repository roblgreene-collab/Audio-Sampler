// Pure audio-processing functions. A "clip" is a plain object:
//   { sampleRate: number, channels: Float32Array[] }
// Every function returns a new clip and never mutates its input, which keeps
// undo/redo simple and lets these run (and be tested) outside the browser.

export function createClip(sampleRate, channels) {
  return { sampleRate, channels };
}

export function clipLength(clip) {
  return clip.channels[0].length;
}

export function clipDuration(clip) {
  return clipLength(clip) / clip.sampleRate;
}

function clampRange(clip, start = 0, end = clipLength(clip)) {
  const len = clipLength(clip);
  const s = Math.max(0, Math.min(len, Math.round(start)));
  const e = Math.max(s, Math.min(len, Math.round(end)));
  return [s, e];
}

function mapChannels(clip, fn) {
  return createClip(clip.sampleRate, clip.channels.map(fn));
}

export function cloneClip(clip) {
  return mapChannels(clip, (ch) => ch.slice());
}

// --- Chopping -------------------------------------------------------------

export function slice(clip, start, end) {
  const [s, e] = clampRange(clip, start, end);
  return mapChannels(clip, (ch) => ch.slice(s, e));
}

export function concat(clips) {
  const first = clips[0];
  const total = clips.reduce((n, c) => n + clipLength(c), 0);
  const channels = first.channels.map((_, ci) => {
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of clips) {
      out.set(c.channels[Math.min(ci, c.channels.length - 1)], offset);
      offset += clipLength(c);
    }
    return out;
  });
  return createClip(first.sampleRate, channels);
}

// Join two clips with a short linear crossfade so the cut point doesn't click.
function joinWithCrossfade(a, b, fadeLen) {
  const la = clipLength(a);
  const lb = clipLength(b);
  const n = Math.min(fadeLen, la, lb);
  const channels = a.channels.map((chA, ci) => {
    const chB = b.channels[ci];
    const out = new Float32Array(la + lb - n);
    out.set(chA.subarray(0, la - n), 0);
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / (n + 1);
      out[la - n + i] = chA[la - n + i] * (1 - t) + chB[i] * t;
    }
    out.set(chB.subarray(n), la);
    return out;
  });
  return createClip(a.sampleRate, channels);
}

// Remove [start, end) and close the gap.
export function removeRange(clip, start, end) {
  const [s, e] = clampRange(clip, start, end);
  const fade = Math.round(clip.sampleRate * 0.004);
  return joinWithCrossfade(slice(clip, 0, s), slice(clip, e), fade);
}

// Replace [start, end) with another clip (which may have a different length).
export function splice(clip, start, end, replacement) {
  const [s, e] = clampRange(clip, start, end);
  return concat([slice(clip, 0, s), replacement, slice(clip, e)]);
}

// Split into `count` equal slices.
export function chop(clip, count) {
  const len = clipLength(clip);
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = Math.round((i * len) / count);
    const e = Math.round(((i + 1) * len) / count);
    if (e > s) out.push(slice(clip, s, e));
  }
  return out;
}

// Short fade at both ends of a slice to avoid clicks when it's triggered.
export function declick(clip, ms = 3) {
  const n = Math.min(Math.round(clip.sampleRate * ms / 1000), Math.floor(clipLength(clip) / 2));
  return mapChannels(clip, (ch) => {
    const out = ch.slice();
    for (let i = 0; i < n; i++) {
      const g = i / n;
      out[i] *= g;
      out[out.length - 1 - i] *= g;
    }
    return out;
  });
}

// --- Effects (optionally limited to [start, end)) -------------------------

export function reverse(clip, start, end) {
  const [s, e] = clampRange(clip, start, end);
  return mapChannels(clip, (ch) => {
    const out = ch.slice();
    out.subarray(s, e).reverse();
    return out;
  });
}

export function fade(clip, direction, start, end) {
  const [s, e] = clampRange(clip, start, end);
  const n = e - s;
  return mapChannels(clip, (ch) => {
    const out = ch.slice();
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 1;
      out[s + i] *= direction === 'in' ? t : 1 - t;
    }
    return out;
  });
}

export function peak(clip, start, end) {
  const [s, e] = clampRange(clip, start, end);
  let p = 0;
  for (const ch of clip.channels) {
    for (let i = s; i < e; i++) {
      const v = Math.abs(ch[i]);
      if (v > p) p = v;
    }
  }
  return p;
}

export function gain(clip, amount, start, end) {
  const [s, e] = clampRange(clip, start, end);
  return mapChannels(clip, (ch) => {
    const out = ch.slice();
    for (let i = s; i < e; i++) out[i] *= amount;
    return out;
  });
}

// Scale so the loudest sample hits `target` (default ≈ -0.1 dBFS).
export function normalize(clip, start, end, target = 0.989) {
  const p = peak(clip, start, end);
  if (p === 0) return cloneClip(clip);
  return gain(clip, target / p, start, end);
}

// --- Pitch ---------------------------------------------------------------

export function semitonesToRatio(semitones) {
  return Math.pow(2, semitones / 12);
}

// Read through the clip `ratio` times faster using cubic (Hermite)
// interpolation. ratio > 1 → shorter and higher, ratio < 1 → longer and lower.
export function resample(clip, ratio) {
  const len = clipLength(clip);
  const outLen = Math.max(1, Math.floor((len - 1) / ratio) + 1);
  return mapChannels(clip, (ch) => {
    const out = new Float32Array(outLen);
    const last = len - 1;
    for (let i = 0; i < outLen; i++) {
      const x = i * ratio;
      const i1 = Math.floor(x);
      const t = x - i1;
      const y0 = ch[i1 > 0 ? i1 - 1 : 0];
      const y1 = ch[i1 < last ? i1 : last];
      const y2 = ch[i1 + 1 < last ? i1 + 1 : last];
      const y3 = ch[i1 + 2 < last ? i1 + 2 : last];
      const c1 = 0.5 * (y2 - y0);
      const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
      const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
      out[i] = ((c3 * t + c2) * t + c1) * t + y1;
    }
    return out;
  });
}

// Classic sampler / tape-style pitch shift: speed and pitch change together.
export function pitchTape(clip, semitones) {
  return resample(clip, semitonesToRatio(semitones));
}

// WSOLA time stretch: changes length by `factor` without changing pitch.
export function timeStretch(clip, factor) {
  const len = clipLength(clip);
  const N = clip.sampleRate > 32000 ? 2048 : 1024; // frame size (~40ms)
  const Hs = N / 2; // synthesis hop (50% overlap; Hann windows sum to 1)
  const Ha = Hs / factor; // analysis hop
  const tol = N / 8; // how far each frame may shift to line up waveforms
  const L = Hs; // length of the segment compared when lining up
  const outLen = Math.max(1, Math.round(len * factor));

  // Coordinates below are "virtual": input sample x lives at virtual x + Hs.
  // The leading zeros let the first real sample get full window weight.
  const padded = new Float32Array(len + Hs + N * 2 + tol * 2);
  const nch = clip.channels.length;
  for (const ch of clip.channels) {
    for (let i = 0; i < len; i++) padded[Hs + i] += ch[i] / nch;
  }
  const maxPos = len + Hs; // stay inside the padded mono buffer

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  const out = clip.channels.map(() => new Float32Array(outLen + N));
  const frames = Math.ceil((outLen + Hs) / Hs) + 1;
  let prevPos = 0;

  for (let k = 0; k < frames; k++) {
    let pos = Math.round(k * Ha);
    if (k > 0) {
      // Pick the offset whose waveform best continues the previous frame.
      // Coarse search first, then refine around the winner.
      const target = prevPos + Hs;
      const search = (from, to, step, stride) => {
        let best = -Infinity;
        let bestD = 0;
        for (let d = from; d <= to; d += step) {
          const p = pos + d;
          if (p < 0 || p > maxPos) continue;
          let sum = 0;
          for (let i = 0; i < L; i += stride) sum += padded[p + i] * padded[target + i];
          if (sum > best) {
            best = sum;
            bestD = d;
          }
        }
        return bestD;
      };
      const coarse = search(-tol, tol, 8, 8);
      const bestD = search(coarse - 7, coarse + 7, 1, 4);
      pos = Math.max(0, Math.min(maxPos, pos + bestD));
    }
    const outStart = k * Hs - Hs;
    for (let c = 0; c < nch; c++) {
      const src = clip.channels[c];
      const dst = out[c];
      for (let i = 0; i < N; i++) {
        const o = outStart + i;
        const x = pos + i - Hs;
        if (o < 0 || o >= dst.length || x < 0 || x >= len) continue;
        dst[o] += src[x] * win[i];
      }
    }
    prevPos = pos;
  }

  return createClip(clip.sampleRate, out.map((ch) => ch.slice(0, outLen)));
}

function fitLength(clip, length) {
  return mapChannels(clip, (ch) => {
    const out = new Float32Array(length);
    out.set(ch.subarray(0, length));
    return out;
  });
}

// Pitch shift that keeps the original length (stretch, then resample).
export function pitchKeepLength(clip, semitones) {
  if (semitones === 0) return cloneClip(clip);
  const ratio = semitonesToRatio(semitones);
  return fitLength(resample(timeStretch(clip, ratio), ratio), clipLength(clip));
}

// --- Channel helpers -----------------------------------------------------

// Mix down to at most `max` channels (MP3 supports mono or stereo).
export function limitChannels(clip, max = 2) {
  if (clip.channels.length <= max) return clip;
  const len = clipLength(clip);
  const out = Array.from({ length: max }, () => new Float32Array(len));
  clip.channels.forEach((ch, ci) => {
    const dst = out[ci % max];
    for (let i = 0; i < len; i++) dst[i] += ch[i];
  });
  const share = clip.channels.length / max;
  out.forEach((ch) => {
    for (let i = 0; i < len; i++) ch[i] /= share;
  });
  return createClip(clip.sampleRate, out);
}
