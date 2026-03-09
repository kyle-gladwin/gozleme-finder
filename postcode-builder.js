/**
 * Gözleme Finder — Postcode Cache Builder
 *
 * Searches Google Places for "Gozleme near [postcode]" for every London
 * postcode district (sectors 1AA–9AA + 0AA = 10 per district), deduplicates
 * by place_id, and merges results into cache.json.
 *
 * Usage: node postcode-builder.js
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || process.env.GOOGLE_MAPS_KEY || '';

if (!GOOGLE_PLACES_KEY) {
  console.error('Error: GOOGLE_PLACES_KEY not set in .env');
  process.exit(1);
}

// ── London postcode districts ────────────────────────────────────────────────

const DISTRICTS = [];
const ranges = [
  ['E',  1, 18],
  ['EC', 1,  4],
  ['N',  1, 22],
  ['NW', 1, 11],
  ['SE', 1, 28],
  ['SW', 1, 20],
  ['W',  1, 14],
  ['WC', 1,  2],
];
for (const [area, lo, hi] of ranges) {
  for (let i = lo; i <= hi; i++) DISTRICTS.push(area + i);
}

// 10 sectors per district: 1AA, 2AA, … 9AA, 0AA
const SECTORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

const POSTCODES = [];
for (const district of DISTRICTS) {
  for (const sector of SECTORS) {
    POSTCODES.push(`${district} ${sector}AA`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalise(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractArea(address) {
  if (!address) return '';
  const parts = address.split(',').map(s => s.trim());
  for (let i = parts.length - 3; i >= 0; i--) {
    const p = parts[i];
    if (p && !/^[A-Z]{1,2}\d/.test(p) && p !== 'London' && p !== 'UK' && p !== 'United Kingdom') {
      return p;
    }
  }
  return '';
}

// ── Google Places Text Search ─────────────────────────────────────────────────

async function searchPostcode(postcode) {
  const { default: fetch } = await import('node-fetch');

  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Goog-Api-Key':   GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.rating',
        'places.userRatingCount',
        'places.currentOpeningHours',
        'places.priceLevel',
        'places.googleMapsUri',
        'places.location',
      ].join(','),
    },
    body: JSON.stringify({
      textQuery:      `Gozleme near ${postcode}`,
      maxResultCount: 20,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err.error && err.error.message) || response.statusText);
  }

  const data = await response.json();
  return data.places || [];
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\nGözleme Finder — Postcode Cache Builder');
  console.log('========================================');
  console.log(`${DISTRICTS.length} districts × 10 sectors = ${POSTCODES.length} postcodes\n`);

  const seenIds   = new Set();
  const seenNames = new Set();
  const found     = [];
  let   apiErrors = 0;
  let   total     = 0;

  for (let i = 0; i < POSTCODES.length; i++) {
    const postcode = POSTCODES[i];
    const pct = Math.round(((i + 1) / POSTCODES.length) * 100);
    process.stdout.write(`\r  [${String(i + 1).padStart(4)}/${POSTCODES.length}] ${postcode.padEnd(9)} ${pct}%  (+${found.length} spots so far)  `);

    try {
      const places = await searchPostcode(postcode);
      total += places.length;
      let added = 0;

      for (const p of places) {
        const id   = p.id || '';
        const name = (p.displayName && p.displayName.text) ? p.displayName.text.trim() : '';
        if (!name) continue;

        if (id && seenIds.has(id)) continue;
        const norm = normalise(name);
        if (seenNames.has(norm))   continue;

        if (id) seenIds.add(id);
        seenNames.add(norm);

        found.push({
          name,
          area:        extractArea(p.formattedAddress || ''),
          address:     p.formattedAddress || '',
          description: '',
          tags:        ['turkish', 'gozleme'],
          lat:         (p.location && p.location.latitude)  != null ? p.location.latitude  : null,
          lng:         (p.location && p.location.longitude) != null ? p.location.longitude : null,
          rating:      p.rating || null,
          reviewCount: p.userRatingCount || null,
          isOpen:      (p.currentOpeningHours && p.currentOpeningHours.openNow != null) ? p.currentOpeningHours.openNow : null,
          priceLevel:  p.priceLevel || null,
          mapsUrl:     p.googleMapsUri || null,
          placeId:     id || null,
          source:      'places',
          cachedAt:    new Date().toISOString(),
        });
        added++;
      }

      if (added > 0) process.stdout.write(`\r  [${String(i + 1).padStart(4)}/${POSTCODES.length}] ${postcode.padEnd(9)} +${added} new spots\n`);

    } catch (e) {
      apiErrors++;
      process.stdout.write(`\r  [${String(i + 1).padStart(4)}/${POSTCODES.length}] ${postcode.padEnd(9)} ERROR: ${e.message}\n`);
      if (apiErrors >= 15) {
        console.error('\nToo many API errors — stopping early.');
        break;
      }
    }

    // ~4 req/sec to stay well within quota
    if (i < POSTCODES.length - 1) await sleep(250);
  }

  process.stdout.write('\n');

  // ── Merge into cache.json ─────────────────────────────────────────────────

  const cachePath = path.join(__dirname, 'cache.json');
  let existing = { spots: [], builtAt: null };
  try {
    existing = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch (e) { /* start fresh if no cache */ }

  const existingIds   = new Set((existing.spots || []).map(s => s.placeId).filter(Boolean));
  const existingNames = new Set((existing.spots || []).map(s => normalise(s.name)));

  const toAdd = found.filter(s => {
    if (s.placeId && existingIds.has(s.placeId)) return false;
    if (existingNames.has(normalise(s.name)))    return false;
    return true;
  });

  const merged = [...(existing.spots || []), ...toAdd];

  fs.writeFileSync(cachePath, JSON.stringify({
    builtAt:    new Date().toISOString(),
    totalSpots: merged.length,
    spots:      merged,
  }, null, 2), 'utf8');

  const withCoords = merged.filter(s => s.lat != null).length;

  console.log('========================================');
  console.log(`Scanned  ${total} raw API results across ${POSTCODES.length} postcodes`);
  console.log(`Found    ${found.length} unique spots from this run`);
  console.log(`Added    ${toAdd.length} new to cache (${found.length - toAdd.length} already existed)`);
  console.log(`Cache    ${merged.length} total spots  (${withCoords} with coordinates)`);
  console.log('Saved  → cache.json');
  console.log('========================================\n');
}

run().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
