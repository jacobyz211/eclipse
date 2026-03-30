require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── SoundCloud client_id — auto-fetched with infinite retry ──────────────
let SC_CLIENT_ID = process.env.SC_CLIENT_ID || null;
let clientIdReady = false;

const RETRY_DELAYS = [5000, 10000, 15000, 30000, 60000]; // ms between retries

async function fetchClientId(attempt = 0) {
  // If already set via env var, skip fetching
  if (process.env.SC_CLIENT_ID) {
    SC_CLIENT_ID   = process.env.SC_CLIENT_ID;
    clientIdReady  = true;
    console.log(`✅ client_id loaded from environment variable.`);
    return;
  }

  try {
    console.log(`🔍 [Attempt ${attempt + 1}] Fetching SoundCloud client_id...`);

    const { data: html } = await axios.get('https://soundcloud.com', {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    // Collect all JS bundle URLs from the page
    const scriptUrls = [...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9\-]+\.js/g)]
      .map(m => m[0])
      .filter((v, i, a) => a.indexOf(v) === i); // dedupe

    if (!scriptUrls.length) throw new Error('No script bundles found on SoundCloud page');

    // Search each bundle for a client_id — check last few bundles first (more likely to have it)
    for (const url of [...scriptUrls].reverse().slice(0, 8)) {
      try {
        const { data: js } = await axios.get(url, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
          },
        });

        const match = js.match(/client_id\s*[=:,]\s*["']([a-zA-Z0-9]{32})["']/);
        if (match) {
          SC_CLIENT_ID  = match[1];
          clientIdReady = true;
          console.log(`✅ client_id auto-fetched successfully: ${SC_CLIENT_ID}`);
          // Schedule a refresh every 6 hours to stay fresh
          setTimeout(() => fetchClientId(0), 6 * 60 * 60 * 1000);
          return;
        }
      } catch (_) {
        // skip this bundle, try next
      }
    }

    throw new Error('client_id pattern not found in any script bundle');

  } catch (err) {
    const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
    console.warn(`⚠️  [Attempt ${attempt + 1}] Failed to fetch client_id: ${err.message}`);
    console.warn(`🔄 Retrying in ${delay / 1000}s...`);
    setTimeout(() => fetchClientId(attempt + 1), delay);
  }
}

// Start fetching immediately on boot — keeps retrying until it works
fetchClientId();

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Guard: block requests until client_id is ready ───────────────────────
function requireClientId(req, res, next) {
  if (!clientIdReady || !SC_CLIENT_ID) {
    return res.status(503).json({
      error:   'SoundCloud client_id is not ready yet — still fetching. Please retry in a few seconds.',
      ready:   false,
      retrying: true,
    });
  }
  next();
}

// ─── Helper: format a SoundCloud track ────────────────────────────────────
function formatTrack(item) {
  const t = item.track || item;
  const artworkHigh = t.artwork_url
    ? t.artwork_url.replace('-large', '-t500x500')
    : (t.user?.avatar_url || '').replace('-large', '-t500x500');

  return {
    id:         String(t.id),
    title:      t.title            || 'Unknown Title',
    artist:     t.user?.username   || 'Unknown Artist',
    thumbnail:  artworkHigh,
    duration:   Math.round((t.duration || 0) / 1000),
    source:     'soundcloud',
    permalink:  t.permalink_url    || '',
    stream_url: t.media?.transcodings
      ? (t.media.transcodings.find(tr => tr.format?.protocol === 'progressive')?.url || null)
      : (t.stream_url ? `${t.stream_url}?client_id=${SC_CLIENT_ID}` : null),
    plays:  t.playback_count || 0,
    likes:  t.likes_count    || 0,
    genre:  t.genre          || '',
    tags:   t.tag_list       || '',
  };
}

// ─── Helper: resolve transcoding stream URL ───────────────────────────────
async function resolveStreamUrl(transcodingUrl) {
  try {
    const { data } = await axios.get(transcodingUrl, {
      params:  { client_id: SC_CLIENT_ID },
      timeout: 8000,
    });
    return data.url || null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    addon:            'Eclipse SoundCloud Addon',
    status:           clientIdReady ? 'ready' : 'warming_up',
    client_id_ready:  clientIdReady,
    version:          '1.0.0',
    routes: {
      manifest: '/manifest.json',
      home:     '/home',
      search:   '/search?q=your+query',
      catalog:  '/catalog/music/sc-trending.json',
      stream:   '/stream/music/sc:TRACK_ID.json',
    },
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  MANIFEST
// ══════════════════════════════════════════════════════════════════════════
app.get('/manifest.json', (req, res) => {
  res.json({
    id:           'com.eclipse.addon.soundcloud',
    name:         'SoundCloud',
    version:      '1.0.0',
    description:  'Search and discover music from SoundCloud — trending charts, top picks, and full search.',
    logo:         'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-orange-2xhdpi-a9dce059.png',
    contactEmail: '',
    resources:    ['catalog', 'search', 'stream'],
    types:        ['music'],
    idPrefixes:   ['sc:'],
    catalogs: [
      { type: 'music', id: 'sc-trending', name: '🔥 Trending on SoundCloud', extra: [{ name: 'skip' }] },
      { type: 'music', id: 'sc-top',      name: '⭐ Top Tracks',             extra: [{ name: 'skip' }] },
      { type: 'music', id: 'sc-new',      name: '✨ New & Hot',              extra: [{ name: 'skip' }] },
    ],
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  HOME  —  Multiple sections for the Eclipse front page
// ══════════════════════════════════════════════════════════════════════════
app.get('/home', requireClientId, async (req, res) => {
  try {
    const [trendingRes, topRes, newHotRes] = await Promise.allSettled([
      axios.get('https://api-v2.soundcloud.com/charts', {
        params: { kind: 'trending', genre: 'soundcloud:genres:all-music', client_id: SC_CLIENT_ID, limit: 20 },
        timeout: 10000,
      }),
      axios.get('https://api-v2.soundcloud.com/charts', {
        params: { kind: 'top',      genre: 'soundcloud:genres:all-music', client_id: SC_CLIENT_ID, limit: 20 },
        timeout: 10000,
      }),
      axios.get('https://api-v2.soundcloud.com/charts', {
        params: { kind: 'trending', genre: 'soundcloud:genres:pop',       client_id: SC_CLIENT_ID, limit: 20 },
        timeout: 10000,
      }),
    ]);

    const sections = [];

    if (trendingRes.status === 'fulfilled') {
      sections.push({
        id:     'sc-trending',
        title:  '🔥 Trending Now',
        type:   'row',
        tracks: (trendingRes.value.data?.collection || []).map(formatTrack),
      });
    }

    if (topRes.status === 'fulfilled') {
      sections.push({
        id:     'sc-top',
        title:  '⭐ Top Picks',
        type:   'row',
        tracks: (topRes.value.data?.collection || []).map(formatTrack),
      });
    }

    if (newHotRes.status === 'fulfilled') {
      sections.push({
        id:     'sc-new-hot',
        title:  '✨ New & Hot',
        type:   'row',
        tracks: (newHotRes.value.data?.collection || []).map(formatTrack),
      });
    }

    res.json({ sections });
  } catch (err) {
    console.error('[/home error]', err.message);
    res.status(500).json({ error: 'Failed to load home sections', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  CATALOG
// ══════════════════════════════════════════════════════════════════════════
const CATALOG_MAP = {
  'sc-trending': { kind: 'trending', genre: 'soundcloud:genres:all-music' },
  'sc-top':      { kind: 'top',      genre: 'soundcloud:genres:all-music' },
  'sc-new':      { kind: 'trending', genre: 'soundcloud:genres:pop'       },
};

app.get('/catalog/:type/:id.json', requireClientId, async (req, res) => {
  const { id } = req.params;
  const skip   = parseInt(req.query.skip || '0', 10);
  const config = CATALOG_MAP[id];

  if (!config) {
    return res.status(404).json({ error: `Unknown catalog id: ${id}` });
  }

  try {
    const { data } = await axios.get('https://api-v2.soundcloud.com/charts', {
      params:  { kind: config.kind, genre: config.genre, client_id: SC_CLIENT_ID, limit: 20, offset: skip },
      timeout: 10000,
    });

    res.json({
      metas: (data.collection || []).map(item => {
        const t = formatTrack(item);
        return {
          id:          `sc:${t.id}`,
          type:        'music',
          name:        t.title,
          poster:      t.thumbnail,
          background:  t.thumbnail,
          description: `By ${t.artist} · ${t.plays?.toLocaleString()} plays`,
          genres:      t.genre ? [t.genre] : [],
          releaseInfo: '',
        };
      }),
    });
  } catch (err) {
    console.error('[/catalog error]', err.message);
    res.status(500).json({ error: 'Failed to load catalog', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  SEARCH
// ══════════════════════════════════════════════════════════════════════════

// Generic search (?q=)
app.get('/search', requireClientId, async (req, res) => {
  const q = (req.query.q || req.query.query || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'Missing search query. Use ?q=your+query' });
  }
  try {
    const { data } = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
      params:  { q, client_id: SC_CLIENT_ID, limit: 30 },
      timeout: 10000,
    });
    res.json({ results: (data.collection || []).map(formatTrack) });
  } catch (err) {
    console.error('[/search error]', err.message);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

// Eclipse-style /search/:type/:query.json
app.get('/search/:type/:query.json', requireClientId, async (req, res) => {
  const q = decodeURIComponent(req.params.query);
  try {
    const { data } = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
      params:  { q, client_id: SC_CLIENT_ID, limit: 30 },
      timeout: 10000,
    });
    res.json({
      metas: (data.collection || []).map(t => ({
        id:          `sc:${t.id}`,
        type:        'music',
        name:        t.title,
        poster:      (t.artwork_url || '').replace('-large', '-t500x500'),
        background:  (t.artwork_url || '').replace('-large', '-t500x500'),
        description: `By ${t.user?.username} · ${t.playback_count?.toLocaleString()} plays`,
        genres:      t.genre ? [t.genre] : [],
      })),
    });
  } catch (err) {
    console.error('[/search/:type/:query error]', err.message);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  STREAM — Resolve actual audio URL for a track
// ══════════════════════════════════════════════════════════════════════════
app.get('/stream/:type/:id.json', requireClientId, async (req, res) => {
  const trackId = req.params.id.replace('sc:', '');
  try {
    const { data } = await axios.get(`https://api-v2.soundcloud.com/tracks/${trackId}`, {
      params:  { client_id: SC_CLIENT_ID },
      timeout: 10000,
    });

    const transcodings = data.media?.transcodings || [];
    const progressive  = transcodings.find(t => t.format?.protocol === 'progressive');
    const hls          = transcodings.find(t => t.format?.protocol === 'hls');
    const chosen       = progressive || hls;

    if (!chosen) {
      return res.status(404).json({ error: 'No stream available for this track' });
    }

    const streamUrl = await resolveStreamUrl(chosen.url);

    res.json({
      streams: [
        {
          url:   streamUrl,
          title: data.title,
          name:  'SoundCloud',
        },
      ],
    });
  } catch (err) {
    console.error('[/stream error]', err.message);
    res.status(500).json({ error: 'Failed to resolve stream', details: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🎵 Eclipse SoundCloud Addon running on port ${PORT}`);
  console.log(`   Visit http://localhost:${PORT} for status`);
});
