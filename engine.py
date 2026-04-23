import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp

YOUTUBE_HOSTS = {
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be',
}


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r'[\\/*?:"<>|]', '', str(name))
    cleaned = re.sub(r'[\s\n\r]+', ' ', cleaned).strip()
    return cleaned[:120] or 'YT_Subtitles'


def is_valid_youtube_url(url: str) -> bool:
    try:
        parsed = urlparse(url.strip())
        if parsed.scheme not in ('http', 'https'):
            return False
        host = parsed.netloc.lower()
        if host not in YOUTUBE_HOSTS:
            return False
        if 'youtu.be' in host:
            return bool(parsed.path.strip('/'))
        return parsed.path.startswith(('/watch', '/playlist', '/shorts', '/embed'))
    except Exception:
        return False


def create_safe_directory(raw_name: str) -> Path:
    base_dir = Path.cwd().resolve()
    folder_name = sanitize_filename(raw_name)
    target_dir = (base_dir / folder_name).resolve()
    if base_dir not in target_dir.parents and target_dir != base_dir:
        raise ValueError('Resolved directory is outside of the application folder.')
    target_dir.mkdir(parents=True, exist_ok=True)
    return target_dir


def emit_json(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def progress_hook(data: dict) -> None:
    status = data.get('status')
    if status == 'downloading':
        percent = data.get('_percent_str', '').strip()
        eta = data.get('eta')
        emit_json({
            'event': 'progress',
            'status': 'downloading',
            'percent': percent if percent else '0%',
            'eta': eta if eta is not None else None,
        })
    elif status == 'finished':
        emit_json({
            'event': 'progress',
            'status': 'finished',
            'filename': data.get('filename', ''),
        })


def download_subs(url: str, lang: str) -> str:
    url = url.strip()
    if not url or not is_valid_youtube_url(url):
        raise ValueError('Invalid YouTube URL. Please navigate to a valid video or playlist page.')

    info_options = {
        'quiet': True,
        'extract_flat': True,
        'skip_download': True,
    }

    with yt_dlp.YoutubeDL(info_options) as ydl:
        info = ydl.extract_info(url, download=False)
        raw_name = info.get('playlist_title') or info.get('title') or 'YT_Subtitles'
        target_dir = create_safe_directory(raw_name)

    ydl_opts = {
        'skip_download': True,
        'writesubtitles': True,
        'writeautomaticsub': True,
        'subtitleslangs': [lang],
        'outtmpl': str(target_dir / '%(playlist_index|)s%(playlist_index&_|)s%(title)s.%(ext)s'),
        'postprocessors': [{
            'key': 'FFmpegSubtitlesConvertor',
            'format': 'srt',
        }],
        'quiet': True,
        'no_warnings': True,
        'progress_hooks': [progress_hook],
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    return f"SUCCESS: Subtitles saved in '{target_dir.name}'"


def main() -> int:
    if len(sys.argv) < 3:
        emit_json({
            'event': 'error',
            'status': 'failed',
            'message': 'Missing parameters. Usage: python engine.py <url> <lang>',
        })
        return 1

    target_url = sys.argv[1]
    target_lang = sys.argv[2]

    try:
        message = download_subs(target_url, target_lang)
        emit_json({'event': 'complete', 'status': 'success', 'message': message})
        return 0
    except Exception as exc:
        emit_json({'event': 'error', 'status': 'failed', 'message': str(exc)})
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
