from flask import Flask, request, jsonify
from flask_cors import CORS
import yt_dlp
import os

app = Flask(__name__)
CORS(app)

@app.route('/')
def home():
    return "SoundCloud Bridge is LIVE! Use /manifest.json in Eclipse."

@app.route('/manifest.json')
def manifest():
    return jsonify({
        "id": "com.cyrus.sc",
        "name": "SoundCloud Bridge",
        "version": "1.0.0",
        "resources": ["search", "stream"],
        "types": ["track"]
    })

@app.get('/search')
def search():
    query = request.args.get('q', '')
    # We use 'scsearch' instead of 'ytsearch'
    ydl_opts = {'quiet': True, 'default_search': 'scsearch5'}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"scsearch:{query}", download=False)
        tracks = []
        for e in info.get('entries', []):
            tracks.append({
                "id": e.get('url'), # SoundCloud uses the full URL as ID
                "title": e.get('title'),
                "artist": e.get('uploader', 'SoundCloud Artist'),
                "duration": e.get('duration'),
                "artworkURL": e.get('thumbnail'),
                "format": "mp3"
            })
        return jsonify({"tracks": tracks})

@app.get('/stream')
def stream():
    track_url = request.args.get('id')
    ydl_opts = {'quiet': True, 'format': 'bestaudio/best'}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(track_url, download=False)
        return jsonify({"url": info['url'], "format": "mp3"})

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 10000))
    app.run(host='0.0.0.0', port=port)
