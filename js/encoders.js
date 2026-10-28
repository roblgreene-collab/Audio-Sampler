import { clipLength, limitChannels, resample } from './audio-ops.js';

const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

function floatToInt16(ch) {
  const out = new Int16Array(ch.length);
  for (let i = 0; i < ch.length; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// 16-bit PCM WAV.
export function encodeWav(clip) {
  const nch = clip.channels.length;
  const len = clipLength(clip);
  const dataSize = len * nch * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));

  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, nch, true);
  v.setUint32(24, clip.sampleRate, true);
  v.setUint32(28, clip.sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);

  const pcm = clip.channels.map(floatToInt16);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      v.setInt16(off, pcm[c][i], true);
      off += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

let lamePromise = null;

// lamejs is ~150KB, so only load it the first time someone exports an MP3.
function loadLame() {
  if (globalThis.lamejs) return Promise.resolve(globalThis.lamejs);
  if (!lamePromise) {
    lamePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../vendor/lame.min.js', import.meta.url).href;
      s.onload = () => resolve(globalThis.lamejs);
      s.onerror = () => {
        lamePromise = null;
        reject(new Error('Could not load the MP3 encoder'));
      };
      document.head.appendChild(s);
    });
  }
  return lamePromise;
}

// MP3 via lamejs. Encodes in chunks and yields so the progress UI can update.
export async function encodeMp3(clip, kbps = 192, onProgress = () => {}) {
  const lame = await loadLame();
  let src = limitChannels(clip, 2);
  if (!MP3_RATES.includes(src.sampleRate)) {
    src = { ...resample(src, src.sampleRate / 48000), sampleRate: 48000 };
  }
  const nch = src.channels.length;
  const pcm = src.channels.map(floatToInt16);
  const len = clipLength(src);
  const encoder = new lame.Mp3Encoder(nch, src.sampleRate, kbps);
  const parts = [];
  const block = 1152 * 64;

  for (let i = 0; i < len; i += block) {
    const l = pcm[0].subarray(i, i + block);
    const r = nch > 1 ? pcm[1].subarray(i, i + block) : undefined;
    const chunk = nch > 1 ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (chunk.length) parts.push(new Uint8Array(chunk));
    onProgress(Math.min(1, (i + block) / len));
    await new Promise((res) => setTimeout(res, 0));
  }
  const end = encoder.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}
