from flask import Flask, request, jsonify
from flask_cors import CORS
import yt_dlp
import os

app = Flask(__name__)
CORS(app)

# This is the "Home" page so you can see if the server is alive
@app.route('/')
def home():
    return "YouTube Music Addon is LIVE! Go to /manifest.json to see the data."

# This is the file Eclipse Music looks for
@app.route('/manifest.json')
def manifest():
    return jsonify({
        "id": "com.cyrus.ytm",
        "name": "YouTube Music Bridge",
        "version": "1.0.0",
        "resources": ["search", "stream"],
        "types": ["track"]
    })

# This handles the searching
@app.get('/search')
def search():
    query = request.args.get('q', '')
    ydl_opts = {'quiet': True, 'default_search': 'ytsearch5', 'format': 'bestaudio/best'}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"ytsearch:{query} topic", download=False)
        tracks = []
        for e in info.get('entries', []):
            tracks.append({
                "id": e['id'],
                "title": e.get('title'),
                "artist": e.get('uploader'),
                "duration": e.get('duration'),
                "artworkURL": e.get('thumbnail'),
                "format": "m4a"
            })
        return jsonify({"tracks": tracks})

# This resolves the playable link
@app.get('/stream/<track_id>')
def stream(track_id):
    ydl_opts = {'quiet': True, 'format': 'bestaudio/best'}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={track_id}", download=False)
        return jsonify({"url": info['url'], "format": "m4a"})

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 10000))
    app.run(host='0.0.0.0', port=port)
