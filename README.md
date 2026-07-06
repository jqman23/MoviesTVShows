# MoviesTVShows

A Vercel-ready Next.js app for comparing top movies and TV shows across Netflix, HBO/Max, Peacock, and Hulu in the United States.

## Features

- Four service sections for Netflix, HBO/Max, Peacock, and Hulu.
- Toggle between Movies and TV Shows.
- Choose the discovery time window: past week, past month, past year, or all-time.
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
GROQ_API=your_groq_api_key_here
```

Run the app:

```bash
npm run dev
```

Open `http://localhost:3000`.

The app still runs without keys. Without `STREAMING_AVAILABILITY_API_KEY`, it shows demo data. Without `GROQ_API`, natural-language search falls back to simple local parsing.

## Vercel Setup

1. Import this repository into Vercel.
2. Add an environment variable named `STREAMING_AVAILABILITY_API_KEY`.
3. Add an optional environment variable named `GROQ_API` for natural-language search.
4. Set the values to your API keys.
5. Confirm the framework preset is Next.js. This repo also includes `vercel.json` so Vercel uses `.next` instead of a static `public` output directory.
6. Deploy.

The frontend calls `/api/discover`. That server route reads `process.env.STREAMING_AVAILABILITY_API_KEY` and sends the key only in the server-side request header to `https://api.movieofthenight.com/v4`.

## API Usage and Caching

The API route fetches only the selected content type and caches each upstream request by:

```txt
country + service + type + sort window
```

Responses are cached for six hours with Vercel/CDN `s-maxage` headers and server-side Next.js cache entries. The browser also reuses previously loaded filter combinations during the current session, so switching back to an already loaded view does not call the app API again.

Natural-language search calls Groq only when the user submits the search form. The server caches each interpreted phrase for 24 hours, and the browser also reuses repeated phrases during the same session. The selected time window controls the candidate pool, while rating/quality is always part of the final ranking. The original phrase is also used to build a bounded broader candidate pool per service, then rerank those titles by semantic fit, rating, original time-window rank, and model score. If Groq is unavailable, a local scorer still reranks broad candidates so the app keeps showing results.

## Commands

```bash
npm install
npm run dev
npm run build
```
