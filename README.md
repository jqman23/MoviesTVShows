# MoviesTVShows

A Vercel-ready Next.js app for comparing top movies and TV shows across Netflix, HBO/Max, Peacock, and Hulu in the United States.

## Features

- Four service sections for Netflix, HBO/Max, Peacock, and Hulu.
- Toggle between Movies and TV Shows.
- Sort by past week, past month, past year, all-time popularity, or rating.
- Uses US Streaming Availability API catalogs only.
- Calls the Streaming Availability API from a server API route so the key is never exposed to browser code.
- Caches live responses by country, service, content type, and sort window for six hours to protect low API quotas.
- Shows polished demo data with a clear message when the API key is missing or a live request fails.
- Includes loading and error states.

## Local Setup

Install dependencies:

```bash
npm install
```

Create `.env.local`:

```bash
STREAMING_AVAILABILITY_API_KEY=your_api_key_here
```

Run the app:

```bash
npm run dev
```

Open `http://localhost:3000`.

The app still runs without an API key and will show demo data.

## Vercel Setup

1. Import this repository into Vercel.
2. Add an environment variable named `STREAMING_AVAILABILITY_API_KEY`.
3. Set the value to your Streaming Availability API key.
4. Confirm the framework preset is Next.js. This repo also includes `vercel.json` so Vercel uses `.next` instead of a static `public` output directory.
5. Deploy.

The frontend calls `/api/discover`. That server route reads `process.env.STREAMING_AVAILABILITY_API_KEY` and sends the key only in the server-side request header to `https://api.movieofthenight.com/v4`.

## API Usage and Caching

The API route fetches only the selected content type and caches each upstream request by:

```txt
country + service + type + sort window
```

Responses are cached for six hours with Vercel/CDN `s-maxage` headers and server-side Next.js cache entries. The browser also reuses previously loaded filter combinations during the current session, so switching back to an already loaded view does not call the app API again.

## Commands

```bash
npm install
npm run dev
npm run build
```
