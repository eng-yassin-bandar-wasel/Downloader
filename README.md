# Subly — Subtitle Studio

A premium YouTube subtitle downloader built with **Electron** and **Python (yt-dlp)**.
Originally `yt-sub-downloader` by **eng-yassin-bandar-wasel**, reworked into a
minimalist, glass-dark desktop app.

## Features

- **Glassmorphism / minimalist dark UI** with Inter typography, smooth
  animations, and a configurable accent color.
- **Four workspaces**: Download (embedded YouTube browser), Queue (live
  progress), History (previous downloads), Settings (defaults & appearance).
- **Concurrent downloads** — each job runs as its own Python subprocess, so
  the UI never blocks.
- **Native folder picker** and one-click "open folder" actions.
- **Persistent settings & history** stored as JSON under `app.getPath('userData')`.
- **Hardened engine** — CLI-based Python engine using `argparse`, path
  traversal guards, and newline-delimited JSON events for per-job progress.

## Layout

```
.
├── main.js        # Electron main process + IPC + job manager
├── preload.js     # contextBridge API exposed to the renderer
├── renderer.js    # UI state machine (tabs, settings, queue, history)
├── index.html     # Structured markup, Google Fonts, Lucide-style icons
├── styles.css     # Design system + components
├── engine.py      # yt-dlp wrapper, emits JSON events on stdout
└── requirements.txt
```

## Requirements

- Node 18+
- Python 3.9+ with `yt-dlp` (`pip install -r requirements.txt`)
- `ffmpeg` on `PATH` for subtitle conversion

Override the Python binary with `YT_SUB_PYTHON` (defaults to `python3` on
macOS/Linux and `python` on Windows).

## Run

```bash
npm install
pip install -r requirements.txt
npm start
```

## Engine CLI

```bash
python engine.py --url <YouTube URL> --lang en --output-dir ./out --format srt
```

Events are emitted one JSON object per line on stdout:
`started`, `progress`, `complete`, `error`.
