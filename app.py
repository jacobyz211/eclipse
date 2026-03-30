cat <<EOF > ytm_addon.py
from flask import Flask, request, jsonify
from flask_cors import CORS
import yt_dlp

app = Flask(__name__)
CORS(app)

@app.route('/manifest.json')
def manifest():
    return jsonify({
        "id": "com.cyrus.ytm",
        "name": "Local YTM Bridge",
        "version": "1.0.0",
        "resources": ["search", "stream"],
        "types": ["track"]
    })

@app.route('/search')
def search():
    query = request.args.get('q', '')
    ydl_opts = {'quiet': True, 'default_search': 'ytsearch5', 'format': 'bestaudio/best'}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"ytsearch:{query} topic", download=False)
        tracks = [{"id": e['id'], "title": e.get('title'), "artist": e.get('uploader'), "duration": e.get('duration'), "artworkURL": e.get('thumbnail'), "format": "m4a"} for e in info['entries']]
        return jsonify({"tracks": tracks})

@app.route('/stream/<track_id>')
def stream(track_id):
    ydl_opts = {'quiet': True, 'format': 'bestaudio/best'}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={track_id}", download=False)
        return jsonify({"url": info['url'], "format": "m4a", "quality": "high"})

if __name__ == '__main__':
    import os
    # Render assigns a port dynamically. We MUST use it.
    port = int(os.environ.get("PORT", 10000))
    # '0.0.0.0' allows the app to be 'seen' by Render's network
    app.run(host='0.0.0.0', port=port)
