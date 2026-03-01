/**
 * Gözleme Finder — Express Proxy Server
 *
 * Proxies Google Places + Geocoding APIs to avoid CORS.
 * Serves Maps JS API key securely to the frontend.
 * Also serves the static HTML frontend.
 *
 * Usage:
 *   1. npm install
 *   2. Copy .env.example to .env and fill in your keys
 *   3. node server.js
 *   4. Open http://localhost:3000
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// One key can cover Places API (New), Maps JavaScript API, and Geocoding API
// if all three are enabled in Google Cloud Console for that key.
const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || '';
const GOOGLE_MAPS_KEY   = process.env.GOOGLE_MAPS_KEY   || GOOGLE_PLACES_KEY;
const ANTHROPIC_KEY     = process.env.ANTHROPIC_KEY     || '';

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
// Force HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, 'https://' + req.host + req.url);
  }
  next();
});
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname)));

// Root → frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    googlePlacesKeySet: !!GOOGLE_PLACES_KEY,
    googleMapsKeySet:   !!GOOGLE_MAPS_KEY,
    anthropicKeySet:    !!ANTHROPIC_KEY,
  });
});

// ── Expose Maps JS key to the browser ────────────────────────────────────────
// The key is sent at runtime rather than baked into the HTML source.
app.get('/api/maps-key', (req, res) => {
  if (!GOOGLE_MAPS_KEY) {
    return res.status(404).json({ error: 'GOOGLE_MAPS_KEY not configured in .env' });
  }
  res.json({ key: GOOGLE_MAPS_KEY });
});

// ── Google Places proxy ───────────────────────────────────────────────────────
// POST /api/places
// Body: { textQuery, latitude?, longitude?, radius?, maxResults? }
app.post('/api/places', async (req, res) => {
  const apiKey = GOOGLE_PLACES_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'GOOGLE_PLACES_KEY not set in .env' });
  }

  const {
    textQuery,
    latitude   = 51.5200,
    longitude  = -0.0700,
    radius     = 15000,
    maxResults = 20,
  } = req.body;

  if (!textQuery) return res.status(400).json({ error: 'textQuery is required' });

  // Convert radius (metres) to degree offsets
  // At lat 51°: 1° lat ≈ 111km, 1° lng ≈ 69km
  const radiusKm  = parseFloat(radius) / 1000;
  const latDelta  = radiusKm / 111;
  const lngDelta  = radiusKm / 69;

  console.log('Places search:', textQuery, '| centre:', latitude, longitude, '| radius:', radiusKm + 'km', '| box:', [latitude - latDelta, longitude - lngDelta, latitude + latDelta, longitude + lngDelta].map(n => n.toFixed(4)).join(', '));

  const body = {
    textQuery,
    locationRestriction: {
      rectangle: {
        low:  { latitude: latitude - latDelta, longitude: longitude - lngDelta },
        high: { latitude: latitude + latDelta, longitude: longitude + lngDelta },
      },
    },
    maxResultCount: Math.min(parseInt(maxResults, 10) || 20, 20),
  };

  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   apiKey,
        'X-Goog-FieldMask': [
          'places.displayName',
          'places.formattedAddress',
          'places.shortFormattedAddress',
          'places.rating',
          'places.userRatingCount',
          'places.currentOpeningHours',
          'places.priceLevel',
          'places.googleMapsUri',
          'places.location',          // ← lat/lng for map pins
        ].join(','),
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    if (!response.ok) {
      const msg = data.error?.message || response.statusText;
      return res.status(response.status).json({ error: 'Google Places error: ' + msg });
    }
    res.json(data);
  } catch (err) {
    console.error('Places proxy error:', err);
    res.status(502).json({ error: 'Proxy request failed: ' + err.message });
  }
});

// ── Google Places review-based search (searchNearby) ─────────────────────────
// POST /api/places-by-review
// Uses searchNearby to fetch ALL restaurants within a radius, regardless of
// category, then filters server-side to those whose reviews mention gözleme.
// This catches places like Sultan Kitchen that Google doesn't categorise as
// Turkish but whose customers mention gözleme in reviews.
app.post('/api/places-by-review', async (req, res) => {
  const apiKey = GOOGLE_PLACES_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'GOOGLE_PLACES_KEY not set in .env' });
  }

  const {
    latitude  = 51.5200,
    longitude = -0.0700,
    radius    = 3000,   // tighter radius — searchNearby returns all restaurants so keep focused
  } = req.body;

  const GOZLEME_TERMS = ['gozleme', 'gözleme', 'gozlemé', 'gozlemi', 'gözlemi'];

  function mentionsGozleme(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return GOZLEME_TERMS.some(t => lower.includes(t));
  }

  try {
    const fetch = (await import('node-fetch')).default;

    // searchNearby returns all places of given types within a circle —
    // no keyword filter, so every restaurant in the area is included
    const body = {
      includedTypes: ['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'meal_delivery'],
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: { latitude, longitude },
          radius: parseFloat(radius),
        },
      },
    };

    const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   apiKey,
        'X-Goog-FieldMask': [
          'places.displayName',
          'places.formattedAddress',
          'places.shortFormattedAddress',
          'places.rating',
          'places.userRatingCount',
          'places.currentOpeningHours',
          'places.priceLevel',
          'places.googleMapsUri',
          'places.location',
          'places.reviews',
        ].join(','),
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    if (!response.ok) {
      const msg = data.error?.message || response.statusText;
      return res.status(response.status).json({ error: 'searchNearby error: ' + msg });
    }

    // Filter to only places with a review mentioning gözleme
    const filtered = [];
    const seen = new Set();

    for (const place of (data.places || [])) {
      const key = (place.displayName?.text || '') + '|' + (place.formattedAddress || '');
      if (seen.has(key)) continue;
      seen.add(key);

      const reviews = place.reviews || [];
      const matchingReview = reviews.find(r =>
        mentionsGozleme(r.text?.text || r.originalText?.text || '')
      );
      if (!matchingReview) continue;

      filtered.push({
        ...place,
        matchedReview: matchingReview.text?.text || matchingReview.originalText?.text || '',
      });
    }

    res.json({ places: filtered });
  } catch (err) {
    console.error('Places-by-review proxy error:', err);
    res.status(502).json({ error: 'Proxy request failed: ' + err.message });
  }
});
// ── Cached AI spots ──────────────────────────────────────────────────────────
// GET /api/cached-spots
// Serves pre-built AI results from cache.json, filtering out hidden spots.
// Returns empty array if cache doesn't exist yet.
app.get('/api/cached-spots', (req, res) => {
  const filePath = path.join(__dirname, 'cache.json');
  try {
    const raw  = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const visible = (data.spots || []).filter(s => !s.hidden);
    res.json({ spots: visible, builtAt: data.builtAt || null });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ spots: [], builtAt: null });
    console.error('Cache error:', err);
    res.status(500).json({ error: 'Failed to load cache: ' + err.message });
  }
});

// ── Admin — list all cached spots (including hidden) ─────────────────────────
// GET /api/admin/spots
app.get('/api/admin/spots', (req, res) => {
  const filePath = path.join(__dirname, 'cache.json');
  try {
    const raw  = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    res.json({ spots: data.spots || [], builtAt: data.builtAt || null, totalSpots: data.totalSpots || 0 });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ spots: [], builtAt: null, totalSpots: 0 });
    res.status(500).json({ error: 'Failed to load cache: ' + err.message });
  }
});

// ── Admin — toggle hidden status of a spot ───────────────────────────────────
// POST /api/admin/toggle
// Body: { index: number }  (index into cache.json spots array)
app.post('/api/admin/toggle', (req, res) => {
  const filePath = path.join(__dirname, 'cache.json');
  const { index } = req.body;

  if (typeof index !== 'number') {
    return res.status(400).json({ error: 'index is required' });
  }

  try {
    const raw  = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);

    if (!data.spots || index < 0 || index >= data.spots.length) {
      return res.status(404).json({ error: 'Spot not found at index ' + index });
    }

    data.spots[index].hidden = !data.spots[index].hidden;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

    res.json({ index, hidden: data.spots[index].hidden, name: data.spots[index].name });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'cache.json not found — run cache-builder.js first' });
    console.error('Admin toggle error:', err);
    res.status(500).json({ error: 'Failed to update cache: ' + err.message });
  }
});

// ── Admin UI ──────────────────────────────────────────────────────────────────
// GET /admin — serves the admin interface
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ── Curated spots ────────────────────────────────────────────────────────────
// GET /api/curated
// Returns manually curated gözleme spots from curated.json.
// Edit curated.json to add or remove spots — no server restart needed.
app.get('/api/curated', (req, res) => {
  const filePath = path.join(__dirname, 'curated.json');
  try {
    const raw  = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    res.json({ spots: data });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.json({ spots: [] }); // file doesn't exist yet — return empty
    }
    console.error('Curated spots error:', err);
    res.status(500).json({ error: 'Failed to load curated spots: ' + err.message });
  }
});

// ── Geocoding proxy ───────────────────────────────────────────────────────────
// POST /api/geocode
// Body: { address: string }
// Returns: { lat, lng } or error
app.post('/api/geocode', async (req, res) => {
  const apiKey = GOOGLE_MAPS_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'GOOGLE_MAPS_KEY not set in .env' });
  }

  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'address is required' });

  try {
    const fetch = (await import('node-fetch')).default;
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?address='
      + encodeURIComponent(address)
      + '&key=' + apiKey;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' || !data.results.length) {
      console.warn('Geocode: no result for "' + address + '" (status: ' + data.status + ')');
      return res.json({ lat: null, lng: null });
    }

    const loc = data.results[0].geometry.location;
    res.json({ lat: loc.lat, lng: loc.lng });
  } catch (err) {
    console.error('Geocode proxy error:', err);
    res.status(502).json({ error: 'Geocode request failed: ' + err.message });
  }
});


// ── Reverse geocoding proxy ───────────────────────────────────────────────────
// POST /api/geocode-reverse
// Body: { lat, lng }
// Returns: { label } — a human-readable location name (neighbourhood / postcode)
app.post('/api/geocode-reverse', async (req, res) => {
  const apiKey = GOOGLE_MAPS_KEY;
  if (!apiKey) return res.status(400).json({ error: 'GOOGLE_MAPS_KEY not set' });

  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng are required' });

  try {
    const fetch = (await import('node-fetch')).default;
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?latlng='
      + lat + ',' + lng + '&key=' + apiKey;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' || !data.results.length) {
      return res.json({ label: null });
    }

    // Prefer a postcode or neighbourhood component over the full address
    const result = data.results[0];
    const components = result.address_components || [];

    const postal   = components.find(c => c.types.includes('postal_code'));
    const neighbourhood = components.find(c =>
      c.types.includes('neighborhood') || c.types.includes('sublocality_level_1')
    );
    const locality = components.find(c => c.types.includes('locality'));

    const label = (postal && postal.short_name)
      || (neighbourhood && neighbourhood.long_name)
      || (locality && locality.long_name)
      || result.formatted_address;

    res.json({ label });
  } catch (err) {
    console.error('Reverse geocode error:', err);
    res.status(502).json({ error: 'Reverse geocode failed: ' + err.message });
  }
});

// ── Anthropic Claude proxy ────────────────────────────────────────────────────
// POST /api/claude
// Body: standard Anthropic messages API payload (minus the api key)
app.post('/api/claude', async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(400).json({ error: 'ANTHROPIC_KEY not set in .env' });
  }

  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Claude proxy error:', err);
    res.status(502).json({ error: 'Claude proxy failed: ' + err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  Gozleme Finder proxy running');
  console.log('  http://localhost:' + PORT);
  console.log('');
  console.log('  Google Places key : ' + (GOOGLE_PLACES_KEY ? 'SET ✓' : 'NOT SET'));
  console.log('  Google Maps key   : ' + (GOOGLE_MAPS_KEY   ? 'SET ✓' : 'NOT SET'));
  console.log('  Anthropic key     : ' + (ANTHROPIC_KEY     ? 'SET ✓' : 'NOT SET'));
  console.log('');
});
