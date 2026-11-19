# Sonora — Local Music Player

Sonora is a lightweight, dependency-free music player that runs entirely in the browser. Load audio files from your computer and get a playlist, metadata-aware track info, procedural cover art, and a reactive audio visualizer — no server and no build step required.

## Features

- **Local playback** — add files with the **ADD MUSIC** button or by dragging and dropping them anywhere onto the window.
- **Playlist** — select tracks, remove them, and see track numbers and durations. The first added track starts playing automatically.
- **Playback controls** — play/pause, previous/next, click-to-seek on the timeline, volume slider, mute, shuffle, and repeat.
- **Keyboard shortcuts**
  - `Space` — play/pause
  - `←` / `→` — seek back/forward 5 seconds
  - `↑` / `↓` — adjust volume by 5%
- **Metadata reading** — parses ID3v2 tags (MP3) and iTunes `ilst` atoms (M4A/MP4) directly from the files for title, artist, album, genre, and embedded cover art. Falls back to filenames when tags are missing.
- **Generated cover art** — tracks without embedded artwork get a deterministic, color-themed canvas cover.
- **Audio visualizer** — a full-screen canvas animation with a rotating frequency spectrum, waveform, rings, and particles driven by the Web Audio API.
- **Responsive layout** — adapts from a two-column desktop view to a stacked mobile view.

## Supported formats

The file picker and drag-and-drop handler accept audio files, including MP3, M4A, AAC, OGG, FLAC, WAV, and others. Actual playback depends on the formats supported by your browser; the interface advertises **MP3 · M4A · AAC · OGG**.

## Getting started

Open `index.html` directly in a modern browser:

```sh
xdg-open index.html   # Linux
open index.html       # macOS
```

Alternatively, serve the directory locally:

```sh
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

No installation, package manager, or build command is needed. The Google Fonts used for typography are loaded from a CDN; the app falls back to system fonts when offline.

## Privacy

Your audio files stay on your device. They are read locally with `File.arrayBuffer()` and played through object URLs — nothing is uploaded. The only external requests are for the Google Fonts stylesheets.

## Project structure

| File | Purpose |
| --- | --- |
| `index.html` | Page structure and UI markup |
| `style.css` | Layout, theme, and responsive styling |
| `app.js` | Playback, metadata parsing, playlist, cover art, and visualizer logic |
| `opencode.json` | Local OpenCode editor/model configuration (not part of the app) |

## Notes

- A modern browser with Canvas and Web Audio API support is recommended. If `AudioContext` is unavailable or a media-element source cannot be created, playback still works through the native `<audio>` element, but the visualizer will not react to the audio.
- For automated testing, append `?debug=1` to the URL to expose a `window.__sonora` object with access to the player state and core functions.
