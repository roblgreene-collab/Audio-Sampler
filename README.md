# Pocket Sampler

A phone-friendly audio sampler that runs in your browser. Load an MP3 (or M4A/WAV —
e.g. iPhone Voice Memos) from your phone, chop it up, reverse it, pitch it, and export
the result. It installs to your home screen like an app and works offline. Everything
happens on the phone — no audio is uploaded anywhere.

## Features

- **Load** MP3, M4A, WAV, AAC, OGG from your phone's files
- **Waveform editor** — drag to select, drag the orange edges to adjust, tap to clear,
  zoom to the selection for precise edits
- **Chop** — keep selection (crop), delete selection, send selection to a pad,
  or chop the selection/whole file into 2/4/8/16 equal slices
- **Pads** — 16 tap-to-play pads; open any pad in the editor or export it on its own
- **Reverse**, **normalize**, **fade in/out** (selection or whole file)
- **Pitch** ±24 semitones, two modes:
  - *Tape* — classic sampler style; speed changes with pitch
  - *Keep length* — pitch changes, timing stays the same (time-stretch)
- **Preview** pitch before applying, **undo/redo**, looped playback
- **Export** as MP3 (128/192/320 kbps) or WAV, whole file or selection only.
  On phones that support it, “Share…” sends the file straight to Files, Drive,
  messages, etc.

## Putting it on your phone

The app is static files, so any HTTPS host works. The easiest option is GitHub Pages:

1. Merge this branch into `main` (or pick this branch in the next step).
2. On GitHub, open the repo **Settings → Pages**, set *Source* to
   “Deploy from a branch”, choose the branch and `/ (root)`, and save.
3. After a minute it's live at `https://<your-username>.github.io/Audio-Sampler/`.
4. Open that link on your phone:
   - **iPhone (Safari):** Share button → **Add to Home Screen**
   - **Android (Chrome):** ⋮ menu → **Install app** / **Add to Home screen**

## Running locally

```sh
npm start        # serves on http://localhost:8000
npm test         # runs the audio-processing tests (Node 18+)
```

## Notes

- Very long recordings use a lot of memory once decoded (about 23 MB per stereo
  minute); files up to ~15–20 minutes are comfortable on most phones.
- “Keep length” pitch takes a few seconds on long files; tape mode is near-instant.
- Exported files use your phone's audio sample rate (usually 44.1 or 48 kHz).

## Project layout

```
index.html            app UI
css/style.css         styles
js/app.js             UI, playback, waveform, pads, export
js/audio-ops.js       pure audio processing (chop, reverse, pitch, fades…)
js/encoders.js        WAV and MP3 encoding
vendor/lame.min.js    lamejs MP3 encoder (LGPL, see vendor/lamejs-LICENSE)
sw.js                 offline cache (bump VERSION when files change)
tests/                Node tests for the audio processing
```
