"""Subtitle download engine.

A thin, well-structured wrapper around ``yt_dlp`` that emits newline-delimited
JSON events on stdout so the Electron main process can track progress for an
arbitrary number of concurrent jobs.

Usage::

    python engine.py --url <url> --lang <lang> [--output-dir <dir>] \
                     [--job-id <id>] [--format srt|vtt]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import yt_dlp


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

YOUTUBE_HOSTS: frozenset[str] = frozenset({
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
})

ALLOWED_PATH_PREFIXES: tuple[str, ...] = ("/watch", "/playlist", "/shorts", "/embed")

INVALID_FILENAME_CHARS = re.compile(r'[\\/*?:"<>|]')
COLLAPSE_WHITESPACE = re.compile(r"[\s\n\r]+")
DEFAULT_FOLDER = "YT_Subtitles"
MAX_FOLDER_NAME_LEN = 120


# ---------------------------------------------------------------------------
# IO helpers
# ---------------------------------------------------------------------------

def emit(event: str, job_id: str | None = None, **fields: Any) -> None:
    """Emit a newline-delimited JSON event to stdout."""
    payload: dict[str, Any] = {"event": event}
    if job_id is not None:
        payload["jobId"] = job_id
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False), flush=True)


# ---------------------------------------------------------------------------
# Validation & path helpers
# ---------------------------------------------------------------------------

def sanitize_filename(name: str) -> str:
    cleaned = INVALID_FILENAME_CHARS.sub("", str(name))
    cleaned = COLLAPSE_WHITESPACE.sub(" ", cleaned).strip()
    return cleaned[:MAX_FOLDER_NAME_LEN] or DEFAULT_FOLDER


def is_valid_youtube_url(url: str) -> bool:
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = parsed.netloc.lower()
    if host not in YOUTUBE_HOSTS:
        return False
    if host == "youtu.be":
        return bool(parsed.path.strip("/"))
    return parsed.path.startswith(ALLOWED_PATH_PREFIXES)


def resolve_output_directory(raw_name: str, base: Path) -> Path:
    base = base.resolve()
    base.mkdir(parents=True, exist_ok=True)
    folder = sanitize_filename(raw_name)
    target = (base / folder).resolve()
    # Guard against path traversal via crafted titles.
    try:
        target.relative_to(base)
    except ValueError as exc:
        raise ValueError("Resolved directory escaped the output folder.") from exc
    target.mkdir(parents=True, exist_ok=True)
    return target


# ---------------------------------------------------------------------------
# Download core
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Job:
    url: str
    lang: str
    output_dir: Path
    subtitle_format: str
    job_id: str | None


def _build_progress_hook(job: Job):
    def hook(data: dict[str, Any]) -> None:
        status = data.get("status")
        if status == "downloading":
            percent = (data.get("_percent_str") or "").strip() or "0%"
            emit(
                "progress",
                job_id=job.job_id,
                status="downloading",
                percent=percent,
                eta=data.get("eta"),
                speed=data.get("_speed_str"),
                filename=data.get("filename"),
            )
        elif status == "finished":
            emit(
                "progress",
                job_id=job.job_id,
                status="finished",
                filename=data.get("filename", ""),
            )

    return hook


def _extract_title(url: str) -> str:
    probe_opts = {
        "quiet": True,
        "extract_flat": True,
        "skip_download": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(probe_opts) as probe:
        info = probe.extract_info(url, download=False)
    return info.get("playlist_title") or info.get("title") or DEFAULT_FOLDER


def _download_options(job: Job, target_dir: Path) -> dict[str, Any]:
    outtmpl = str(
        target_dir
        / "%(playlist_index|)s%(playlist_index&_|)s%(title)s.%(ext)s"
    )
    return {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": [job.lang],
        "outtmpl": outtmpl,
        "postprocessors": [
            {"key": "FFmpegSubtitlesConvertor", "format": job.subtitle_format}
        ],
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [_build_progress_hook(job)],
        # yt_dlp can fetch playlist fragments concurrently when available.
        "concurrent_fragment_downloads": 4,
    }


def run_job(job: Job) -> str:
    if not is_valid_youtube_url(job.url):
        raise ValueError(
            "Invalid YouTube URL. Open a video, playlist, Shorts, or embed link."
        )

    title = _extract_title(job.url)
    target_dir = resolve_output_directory(title, job.output_dir)

    emit(
        "started",
        job_id=job.job_id,
        title=title,
        directory=str(target_dir),
        url=job.url,
        lang=job.lang,
    )

    with yt_dlp.YoutubeDL(_download_options(job, target_dir)) as ydl:
        ydl.download([job.url])

    return f"Saved subtitles to '{target_dir.name}'"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_args(argv: list[str]) -> Job:
    parser = argparse.ArgumentParser(
        description="Download YouTube subtitles as SRT/VTT."
    )
    parser.add_argument("--url", required=True, help="YouTube video/playlist URL.")
    parser.add_argument("--lang", required=True, help="Subtitle language code.")
    parser.add_argument(
        "--output-dir",
        default=str(Path.cwd()),
        help="Base directory for the generated subtitle folder.",
    )
    parser.add_argument(
        "--format",
        dest="subtitle_format",
        default="srt",
        choices=("srt", "vtt"),
        help="Subtitle container format.",
    )
    parser.add_argument("--job-id", dest="job_id", default=None)

    # Backwards-compatibility: allow positional `url lang` invocations.
    if argv and not argv[0].startswith("--") and len(argv) >= 2:
        argv = ["--url", argv[0], "--lang", argv[1], *argv[2:]]

    ns = parser.parse_args(argv)
    return Job(
        url=ns.url,
        lang=ns.lang,
        output_dir=Path(ns.output_dir).expanduser(),
        subtitle_format=ns.subtitle_format,
        job_id=ns.job_id,
    )


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    try:
        job = _parse_args(argv)
    except SystemExit:
        emit("error", status="failed", message="Invalid command-line arguments.")
        return 2

    try:
        message = run_job(job)
    except Exception as exc:  # pragma: no cover - surfaced to UI.
        emit("error", job_id=job.job_id, status="failed", message=str(exc))
        return 1

    emit("complete", job_id=job.job_id, status="success", message=message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
