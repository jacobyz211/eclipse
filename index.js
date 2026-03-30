require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── SoundCloud Config ─────────────────────────────────────────────────────
// Get your client_id by:
//  1. Open soundcloud.com in Chrome
//  2. DevTools → Network tab → filter by "client_id"
//  3. Copy the value from any request URL
// OR register at https://soundcloud.com/you/apps
const SC_CLIENT_ID = process.env.SC_CLIENT_ID;
const SC_API       = 'https://api-v2.soundcloud.com';

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Guard: require client_id ──────────────────────────────────────────────
function requireClientId(req, res, next) {
  if (!SC_CLIENT_ID) {
    return res.status(500).json({
      error: 'SC_CLIENT_ID environment variable is not set. See README.',
    });
  }
  next();
}

// ─── Helper: format a SoundCloud track into Eclipse track object ───────────
function formatTrack(item) {
  // Charts endpoint wraps each track in { track: {...} }
  const t = item.track || item;
  const artworkHigh = t.artwork_url
    ? t.artwork_url.replace('-large', '-t500x500')
    : (t.user?.avatar_url || '').replace('-large', '-t500x500');

  return {
    id:        String(t.id),
    title:     t.title       || 'Unknown Title',
    artist:    t.user?.username || 'Unknown Artist',
    thumbnail: artworkHigh,
    duration:  Math.round((t.duration || 0) / 1000), // ms → seconds
    source:    'soundcloud',
    permalink: t.permalink_url || '',
    // stream_url is passed so Eclipse can request it
    stream_url: t.media?.transcodings
      ? (t.media.transcodings.find(tr => tr.format?.protocol === 'progressive')?.url || null)
      : `${t.stream_url}?client_id=${SC_CLIENT_ID}`,
    plays:  t.playback_count || 0,
    likes:  t.likes_count    || 0,
    genre:  t.genre          || '',
    tags:   t.tag_list       || '',
  };
}

// ─── Helper: resolve a transcoding stream URL ──────────────────────────────
async function resolveStreamUrl(transcodingUrl) {
  try {
    const { data } = await axios.get(transcodingUrl, {
      params: { client_id: SC_CLIENT_ID },
    });
    return data.url || null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MANIFEST  —  Eclipse reads this to register your addon
// ══════════════════════════════════════════════════════════════════════════════
app.get('/manifest.json', (req, res) => {
  res.json({
    id:          'com.eclipse.addon.soundcloud',
    name:        'SoundCloud',
    version:     '1.0.0',
    description: 'Search and discover music from SoundCloud — trending charts, top picks, and full search.',
    logo:        'https://a-v2.sndcdn.com/assets/images/sc-icons/ios-orange-2xhdpi-a9dce059.png',
    contactEmail: '',
    resources:   ['catalog', 'search', 'stream'],
    types:       ['music'],
    idPrefixes:  ['sc:'],
    catalogs: [
      {
        type:  'music',
        id:    'sc-trending',
        name:  '🔥 Trending on SoundCloud',
        extra: [{ name: 'skip' }],
      },
      {
        type:  'music',
        id:    'sc-top',
        name:  '⭐ Top Tracks',
        extra: [{ name: 'skip' }],
      },
      {
        type:  'music',
        id:    'sc-new',
        name:  '✨ New & Hot',
        extra: [{ name: 'skip' }],
      },
    ],
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  HOME PAGE  —  Returns multiple sections for the Eclipse front page
// ══════════════════════════════════════════════════════════════════════════════
app.get('/home', requireClientId, async (req, res) => {
  try {
    const [trendingRes, topRes, newHotRes] = await Promise.allSettled([
      axios.get(`${SC_API}/charts`, {
        params: {
          kind:       'trending',
          genre:      'soundcloud:genres:all-music',
          client_id:  SC_CLIENT_ID,
          limit:      20,
        },
      }),
      axios.get(`${SC_API}/charts`, {
        params: {
          kind:      'top',
          genre:     'soundcloud:genres:all-music',
          client_id: SC_CLIENT_ID,
          limit:     20,
        },
      }),
      axios.get(`${SC_API}/charts`, {
        params: {
          kind:      'trending',
          genre:     'soundcloud:genres:pop',
          client_id: SC_CLIENT_ID,
          limit:     20,
        },
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

// ══════════════════════════════════════════════════════════════════════════════
//  CATALOG  —  Eclipse-style /catalog/:type/:id.json endpoints
// ══════════════════════════════════════════════════════════════════════════════
const CATALOG_MAP = {
  'sc-trending': { kind: 'trending', genre: 'soundcloud:genres:all-music' },
  'sc-top':      { kind: 'top',      genre: 'soundcloud:genres:all-music' },
  'sc-new':      { kind: 'trending', genre: 'soundcloud:genres:pop' },
};

app.get('/catalog/:type/:id.json', requireClientId, async (req, res) => {
  const { id } = req.params;
  const skip   = parseInt(req.query.skip || '0', 10);
  const config = CATALOG_MAP[id];

  if (!config) {
    return res.status(404).json({ error: `Unknown catalog id: ${id}` });
  }

  try {
    const { data } = await axios.get(`${SC_API}/charts`, {
      params: {
        kind:       config.kind,
        genre:      config.genre,
        client_id:  SC_CLIENT_ID,
        limit:      20,
        offset:     skip,
      },
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

// ══════════════════════════════════════════════════════════════════════════════
//  SEARCH  —  Handles both /search?q= and /search/:type/:query.json
// ══════════════════════════════════════════════════════════════════════════════

// Generic search (query param style)
app.get('/search', requireClientId, async (req, res) => {
  const q = req.query.q || req.query.query || '';
  if (!q.trim()) {
    return res.status(400).json({ error: 'Missing search query. Use ?q=your+query' });
  }
  try {
    const { data } = await axios.get(`${SC_API}/search/tracks`, {
      params: { q, client_id: SC_CLIENT_ID, limit: 30 },
    });
    res.json({ results: (data.collection || []).map(formatTrack) });
  } catch (err) {
    console.error('[/search error]', err.message);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

// Eclipse-style /search/:type/:query.json
app.get('/search/:type/:query.json', requireClientId, async (req, res) => {
  const { query } = req.params;
  const q = decodeURIComponent(query);
  try {
    const { data } = await axios.get(`${SC_API}/search/tracks`, {
      params: { q, client_id: SC_CLIENT_ID, limit: 30 },
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

// ══════════════════════════════════════════════════════════════════════════════
//  STREAM  —  Resolve actual audio stream URL for a track
// ══════════════════════════════════════════════════════════════════════════════
app.get('/stream/:type/:id.json', requireClientId, async (req, res) => {
  const trackId = req.params.id.replace('sc:', '');
  try {
    const { data } = await axios.get(`${SC_API}/tracks/${trackId}`, {
      params: { client_id: SC_CLIENT_ID },
    });

    const transcodings = data.media?.transcodings || [];
    // Prefer progressive (direct mp3), fall back to HLS
    const progressive = transcodings.find(t => t.format?.protocol === 'progressive');
    const hls         = transcodings.find(t => t.format?.protocol === 'hls');
    const chosen      = progressive || hls;

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

// ══════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK  —  Confirm the server is running
// ══════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    addon:   'Eclipse SoundCloud Addon',
    status:  'running',
    version: '1.0.0',
    routes: {
      manifest: '/manifest.json',
      home:     '/home',
      search:   '/search?q=your+query',
      catalog:  '/catalog/music/sc-trending.json',
      stream:   '/stream/music/sc:TRACK_ID.json',
    },
    sc_client_id_set: !!SC_CLIENT_ID,
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Eclipse SoundCloud Addon running on port ${PORT}`);
  console.log(`   SC_CLIENT_ID set: ${!!SC_CLIENT_ID}`);
});
