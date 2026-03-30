require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;
const SC_API = 'https://api-v2.soundcloud.com';

// ─── Auto-fetch SoundCloud client_id ─────────────────────────────────────
let SC_CLIENT_ID = process.env.SC_CLIENT_ID || null;

async function fetchClientId() {
  if (process.env.SC_CLIENT_ID) {
    SC_CLIENT_ID = process.env.SC_CLIENT_ID;
    console.log('✅ Using SC_CLIENT_ID from environment variable.');
    return;
  }
  try {
    console.log('🔍 Auto-fetching SoundCloud client_id...');
    const {  html } = await axios.get('https://soundcloud.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
      timeout: 10000,
    });
    const scriptUrls = [...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9\-]+\.js/g)]
      .map(m => m[0])
      .filter((v, i, a) => a.indexOf(v) === i);

    for (const url of scriptUrls.reverse()) {
      try {
        const {  js } = await axios.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
          timeout: 8000,
        });
        const match = js.match(/client_id[\"']?\s*[:=,]\s*[\"']([a-zA-Z0-9]{32})[\"']/);
        if (match) {
          SC_CLIENT_ID = match[1];
          console.log(`✅ client_id auto-fetched: ${SC_CLIENT_ID}`);
          return;
        }
      } catch {
      }
    }

    console.warn('⚠️ Could not auto-fetch client_id. Set SC_CLIENT_ID manually.');
  } catch (err) {
    console.warn('⚠️ Auto-fetch failed:', err.message);
  }
}

fetchClientId();
setInterval(fetchClientId, 6 * 60 * 60 * 1000);

app.use(cors());
app.use(express.json());

function requireClientId(req, res, next) {
  if (!SC_CLIENT_ID) {
    return res.status(503).json({
      error: 'SoundCloud client_id not ready yet. Try again in a few seconds.'
    });
  }
  next();
}

function formatTrack(item) {
  const t = item.track || item;

  return {
    id: String(t.id),
    title: t.title || 'Unknown Title',
    artist: t.user?.username || 'Unknown Artist',
    album: t.publisher_metadata?.album_title || '',
    duration: Math.round((t.duration || 0) / 1000),
    artworkURL: (t.artwork_url || t.user?.avatar_url || '').replace('-large', '-t500x500'),
    format: 'mp3'
  };
}

async function resolveStreamUrl(transcodingUrl) {
  try {
    const { data } = await axios.get(transcodingUrl, {
      params: { client_id: SC_CLIENT_ID }
    });
    return data.url || null;
  } catch {
    return null;
  }
}

// Manifest
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.eclipse.addon.soundcloud',
    name: 'SoundCloud',
    version: '1.0.0',
    description: 'Search and stream music from SoundCloud.',
    icon: 'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-orange-2xhdpi-a9dce059.png',
    resources: ['search', 'stream'],
    types: ['track', 'artist']
  });
});

// Search
app.get('/search', requireClientId, async (req, res) => {
  const q = (req.query.q || '').trim();

  if (!q) {
    try {
      const [trendRes, topRes] = await Promise.allSettled([
        axios.get(`${SC_API}/charts`, {
          params: {
            kind: 'trending',
            genre: 'soundcloud:genres:all-music',
            client_id: SC_CLIENT_ID,
            limit: 20
          }
        }),
        axios.get(`${SC_API}/charts`, {
          params: {
            kind: 'top',
            genre: 'soundcloud:genres:all-music',
            client_id: SC_CLIENT_ID,
            limit: 20
          }
        })
      ]);

      const trending = trendRes.status === 'fulfilled'
        ? (trendRes.value.data?.collection || []).map(formatTrack)
        : [];

      const top = topRes.status === 'fulfilled'
        ? (topRes.value.data?.collection || []).map(formatTrack)
        : [];

      const seen = new Set();
      const merged = [...trending, ...top].filter(t => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });

      return res.json({ tracks: merged });
    } catch (err) {
      return res.status(500).json({ tracks: [], error: err.message });
    }
  }

  try {
    const { data } = await axios.get(`${SC_API}/search/tracks`, {
      params: {
        q,
        client_id: SC_CLIENT_ID,
        limit: 30
      }
    });

    res.json({
      tracks: (data.collection || []).map(formatTrack)
    });
  } catch (err) {
    console.error('[/search error]', err.message);
    res.status(500).json({ tracks: [], error: err.message });
  }
});

// Stream
app.get('/stream/:id', requireClientId, async (req, res) => {
  const trackId = req.params.id.replace(/^sc:/, '');

  try {
    const { data } = await axios.get(`${SC_API}/tracks/${trackId}`, {
      params: { client_id: SC_CLIENT_ID }
    });

    const transcodings = data.media?.transcodings || [];
    const progressive = transcodings.find(t => t.format?.protocol === 'progressive');
    const hls = transcodings.find(t => t.format?.protocol === 'hls');
    const chosen = progressive || hls;

    if (!chosen) {
      return res.status(404).json({ error: 'No stream available for this track.' });
    }

    const streamUrl = await resolveStreamUrl(chosen.url);

    if (!streamUrl) {
      return res.status(502).json({ error: 'Failed to resolve stream URL.' });
    }

    res.json({
      url: streamUrl,
      format: 'mp3',
      quality: '128kbps'
    });
  } catch (err) {
    console.error('[/stream error]', err.message);
    res.status(500).json({ error: 'Stream resolution failed', details: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    addon: 'Eclipse SoundCloud Addon',
    status: 'running',
    version: '1.0.0',
    client_id_ready: !!SC_CLIENT_ID,
    endpoints: {
      manifest: 'GET /manifest.json',
      search: 'GET /search?q=your+query',
      stream: 'GET /stream/:trackId'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🎵 Eclipse SoundCloud Addon running on port ${PORT}`);
});
