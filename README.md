# StreamRank — Top Movies & TV by Service

A static streaming discovery app for comparing top movies and TV shows across Netflix, HBO/Max, Peacock, and Hulu in the United States.

## What it does

- Shows four service lanes: Netflix, HBO/Max, Peacock, and Hulu.
- Switches between top movies and top TV shows.
- Sorts by popularity window: past week, month, year, all time, or rating.
- Uses the Streaming Availability API when an API key is provided.
- Falls back to built-in demo data so the UI still works immediately.

## API setup

The app uses the Streaming Availability API JavaScript client from Movie of the Night. Paste your API key into the app UI. It is stored in `localStorage` only and is not committed to the repo.

For production, do not expose a private API key in browser code. Move API calls behind a serverless function or backend proxy before launching publicly.

## Run locally

Because this is a static app, you can open `index.html` directly or serve the folder locally:

```bash
python3 -m http.server 5173
```

Then open:

```txt
http://localhost:5173
```

## Files

- `index.html` — app structure and CDN client script
- `styles.css` — responsive dark streaming UI
- `app.js` — Streaming Availability API integration, controls, rendering, and demo fallback
