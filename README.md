# Gözleme Finder

A web app for finding gözleme (Turkish stuffed flatbread) spots in London. Combines live Google Places search, review-based discovery, AI-curated suggestions, and a manually maintained list.

## Features

- **Live search** — queries Google Places for gözleme near any London location
- **Review filtering** — scans nearby restaurants for customer reviews mentioning gözleme
- **AI cache** — pre-built list of spots discovered by Claude AI across London
- **Curated spots** — hand-verified locations maintained by the creator
- **Interactive map** — Google Maps with pins, info windows, and distance sorting
- **Admin panel** — toggle spot visibility without editing files directly

## Tech Stack

- **Backend:** Node.js + Express, proxies Google Places, Geocoding, and Anthropic APIs
- **Frontend:** Vanilla JS, HTML/CSS, Google Maps JavaScript API
- **AI:** Anthropic Claude API (cache building + live fallback)

## Setup

**1. Install dependencies**
```bash
npm install
```

**2. Configure environment variables**

Create a `.env` file in the project root:
```env
GOOGLE_PLACES_KEY=your_google_api_key
ANTHROPIC_KEY=your_anthropic_api_key
GOOGLE_MAPS_KEY=your_google_maps_key   # optional, falls back to GOOGLE_PLACES_KEY
PORT=3000                               # optional, defaults to 3000
```

Your Google API key needs the following APIs enabled:
- Places API (New)
- Geocoding API
- Maps JavaScript API

**3. Start the server**
```bash
npm start        # production
npm run dev      # development with hot reload
```

The app will be available at `http://localhost:3000`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Status of all configured API keys |
| POST | `/api/places` | Google Places text search proxy |
| POST | `/api/places-by-review` | Search restaurants filtered by gözleme reviews |
| POST | `/api/geocode` | Address → coordinates |
| POST | `/api/geocode-reverse` | Coordinates → readable location |
| GET | `/api/cached-spots` | AI-discovered spots from cache |
| POST | `/api/claude` | Anthropic Claude API proxy |
| GET | `/api/curated` | Manually curated spots |
| GET | `/admin` | Admin panel |

## Data Tools

Two CLI scripts for rebuilding the data cache:

```bash
node cache-builder.js      # queries Claude AI for spots across 18 London areas
node postcode-builder.js   # searches ~360 London postcodes via Google Places
```

## Project Structure

```
├── server.js           # Express server and API proxy
├── index.html          # Main frontend
├── admin.html          # Admin panel
├── cache.json          # AI-discovered spots cache
├── curated.json        # Manually curated spots
├── cache-builder.js    # CLI tool to rebuild AI cache
├── postcode-builder.js # CLI tool to search by postcode
└── .env                # API keys (not committed)
```

---

Built by Kyle Gladwin with Claude Code.
