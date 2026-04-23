import yt_dlp
import sys
import os
import re

# دالة لتنظيف اسم المجلد من الرموز الممنوعة في ويندوز
def clean_filename(name):
    return re.sub(r'[\\/*?:"<>|]', "", str(name)).strip()

def download_subs(url, lang):
    # الخطوة 1: استخراج اسم الفيديو أو قائمة التشغيل
    ydl_opts_info = {'quiet': True, 'extract_flat': True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
            info = ydl.extract_info(url, download=False)
            # اختيار اسم قائمة التشغيل إن وجد، وإلا اسم الفيديو
            raw_name = info.get('playlist_title') or info.get('title') or 'YT_Subtitles'
            folder_name = clean_filename(raw_name)
    except:
        folder_name = 'YT_Subtitles'

    # الخطوة 2: إنشاء المجلد إذا لم يكن موجوداً
    if not os.path.exists(folder_name):
        os.makedirs(folder_name)

    # الخطوة 3: التحميل داخل المجلد الجديد
    ydl_opts = {
        'skip_download': True,
        'writesubtitles': True,
        'writeautomaticsub': True,
        'subtitleslangs': [lang], 
        # وضع الملفات داخل المجلد مع ترقيمها إذا كانت قائمة
        'outtmpl': f'{folder_name}/%(playlist_index|)s%(playlist_index&_|)s%(title)s.%(ext)s',
        'postprocessors': [{
            'key': 'FFmpegSubtitlesConvertor',
            'format': 'srt',
        }],
        'quiet': True,
        'no_warnings': True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
            return f"SUCCESS: Saved in folder '{folder_name}'"
    except Exception as e:
        return f"ERROR: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) > 2:
        target_url = sys.argv[1]
        target_lang = sys.argv[2]
        print(download_subs(target_url, target_lang))
    else:
        print("ERROR: Missing parameters.")