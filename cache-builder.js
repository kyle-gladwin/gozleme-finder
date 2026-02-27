/**
 * Gözleme Finder — Cache Builder
 *
 * Queries Claude AI for gözleme spots across all major London areas and
 * writes the results to cache.json. Run this once (or whenever you want
 * to refresh the cache):
 *
 *   node cache-builder.js
 *
 * Requires ANTHROPIC_KEY in your .env file.
 */

require('dotenv').config();

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
if (!ANTHROPIC_KEY) {
  console.error('Error: ANTHROPIC_KEY not set in .env');
  process.exit(1);
}

// London areas to query — broad enough to cover the whole city
const AREAS = [
  'Central London',
  'East London',
  'North London',
  'South London',
  'West London',
  'Northeast London',
  'Southeast London',
  'Southwest London',
  'Northwest London',
  'Hackney and Dalston',
  'Islington and Holloway',
  'Brixton and Peckham',
  'Whitechapel and Bethnal Green',
  'Walthamstow and Leyton',
  'Stoke Newington and Stamford Hill',
  'Shepherd\'s Bush and Hammersmith',
  'Croydon and Sutton',
  'Stratford and Newham',
];

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error('Failed to parse response: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalise(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchArea(area) {
  const prompt = 'You are a helpful local food guide for London. Find real eateries, restaurants, cafes, or market stalls in or near "' + area + '" (London, UK) that are known to serve Gozleme (Turkish stuffed flatbread).'
    + '\n\nUse only plain ASCII characters in all string values. No apostrophes or special unicode.'
    + '\n\nReturn ONLY a valid JSON array, no markdown fences, no explanation. Format:\n[{"name":"...","area":"...","address":"full street address if known","description":"1-2 sentences","tags":["tag1","tag2"]}]'
    + '\n\nUp to 12 results. Only include real places you are confident about.';

  const data = await callClaude(prompt);

  const allText = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const arrayMatch = allText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  const jsonText = arrayMatch[0]
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-');

  try {
    return JSON.parse(jsonText);
  } catch(e) {
    const sanitised = jsonText.replace(/"([^"]*)"/g, (_, inner) =>
      '"' + inner.replace(/[^\x20-\x7E]/g, '') + '"'
    );
    try { return JSON.parse(sanitised); }
    catch(e2) { return []; }
  }
}

async function build() {
  console.log('\nGözleme Finder — Cache Builder');
  console.log('================================');
  console.log('Querying Claude for ' + AREAS.length + ' London areas...\n');

  const allSpots = [];
  const seen = new Set();

  for (let i = 0; i < AREAS.length; i++) {
    const area = AREAS[i];
    process.stdout.write('  [' + (i + 1) + '/' + AREAS.length + '] ' + area + '... ');

    try {
      const spots = await fetchArea(area);
      let added = 0;

      for (const spot of spots) {
        if (!spot.name) continue;
        const norm = normalise(spot.name);

        // Deduplicate by normalised name
        let isDupe = false;
        for (const s of seen) {
          if (s === norm || s.includes(norm) || norm.includes(s)) { isDupe = true; break; }
        }
        if (isDupe) continue;

        seen.add(norm);
        allSpots.push({
          name:        spot.name,
          area:        spot.area || area,
          address:     spot.address || '',
          description: spot.description || '',
          tags:        spot.tags || [],
          lat:         null,
          lng:         null,
          rating:      null,
          reviewCount: null,
          isOpen:      null,
          priceLevel:  null,
          mapsUrl:     null,
          source:      'ai',
          cachedAt:    new Date().toISOString(),
        });
        added++;
      }

      console.log('found ' + spots.length + ', added ' + added + ' new');
    } catch(e) {
      console.log('ERROR: ' + e.message);
    }

    // Pause between requests to avoid rate limits
    if (i < AREAS.length - 1) await sleep(1500);
  }

  const output = {
    builtAt:    new Date().toISOString(),
    totalSpots: allSpots.length,
    spots:      allSpots,
  };

  const outPath = path.join(__dirname, 'cache.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log('\n================================');
  console.log('Done! ' + allSpots.length + ' unique spots saved to cache.json');
  console.log('================================\n');
}

build().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
