/**
 * Gözleme Finder — Express Proxy Server
 *
 * Sits between the browser and Google Places API to work around CORS restrictions.
 * Also serves the static HTML frontend.
 *
 * Usage:
 *   1. npm install
 *   2. Set your Google Places API key:
 *        export GOOGLE_PLACES_KEY="AIza..."
 *      Or create a .env file with:
 *        GOOGLE_PLACES_KEY=AIza...
 *   3. node server.js
 *   4. Open http://localhost:3000
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || '';

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());              // allow browser requests from any origin
app.use(express.json());      // parse JSON request bodies

// Serve the frontend HTML from the same directory
app.use(express.static(path.join(__dirname)));

// Explicitly serve the HTML at the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'gozleme-finder.html'));
});

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    googleKeySet: !!GOOGLE_PLACES_KEY,
  });
});

// ── Google Places proxy ─────────────────────────────────────────────────────
//
// POST /api/places
// Body: { textQuery: string, latitude?: number, longitude?: number, radius?: number }
//
app.post('/api/places', async (req, res) => {
  // Use key from env (preferred) or fall back to key sent by client
  const apiKey = GOOGLE_PLACES_KEY || req.headers['x-google-key'] || '';

  if (!apiKey) {
    return res.status(400).json({
      error: 'No Google Places API key configured. Set GOOGLE_PLACES_KEY in your .env file or pass it via the X-Google-Key header.'
    });
  }

  const {
    textQuery,
    latitude  = 51.5200,   // Northeast London default
    longitude = -0.0700,
    radius    = 15000,
    maxResults = 20,
  } = req.body;

  if (!textQuery) {
    return res.status(400).json({ error: 'textQuery is required' });
  }

  const placesBody = {
    textQuery,
    locationBias: {
      circle: {
        center: { latitude, longitude },
        radius: parseFloat(radius),
      },
    },
    maxResultCount: Math.min(parseInt(maxResults, 10) || 20, 20),
  };

  try {
    // Dynamic import of node-fetch (works for both CommonJS and ESM setups)
    const fetch = (await import('node-fetch')).default;

    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   apiKey,
        'X-Goog-FieldMask': [
          'places.displayName',
          'places.formattedAddress',
          'places.rating',
          'places.userRatingCount',
          'places.currentOpeningHours',
          'places.priceLevel',
          'places.googleMapsUri',
          'places.shortFormattedAddress',
        ].join(','),
      },
      body: JSON.stringify(placesBody),
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = (data.error && data.error.message) ? data.error.message : response.statusText;
      return res.status(response.status).json({ error: 'Google Places error: ' + msg });
    }

    // Forward the response straight to the browser
    res.json(data);

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({ error: 'Proxy request failed: ' + err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  Gozleme Finder proxy running');
  console.log('  http://localhost:' + PORT);
  console.log('');
  console.log('  Google Places key: ' + (GOOGLE_PLACES_KEY ? 'SET ✓' : 'NOT SET — add GOOGLE_PLACES_KEY to .env'));
  console.log('');
});
