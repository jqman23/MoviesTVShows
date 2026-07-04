import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import type { GenreKey, SearchIntent, ShowType, SortKey } from "../../types";

const GROQ_BASE = "https://api.groq.com/openai/v1/chat/completions";
const CACHE_SECONDS = 60 * 60 * 24;
const INTENT_CACHE_VERSION = "intent-v2";

const genres: GenreKey[] = [
  "all",
  "action",
  "animation",
  "comedy",
  "documentary",
  "drama",
  "horror",
  "romance",
  "scifi",
  "thriller",
];

const sorts: SortKey[] = [
  "popularity_1week",
  "popularity_1month",
  "popularity_1year",
  "popularity_alltime",
  "rating",
];

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { query?: string };
  const query = (body.query ?? "").trim().slice(0, 160);

  if (!query) {
    return cachedJson({
      showType: null,
      sort: null,
      genre: "all",
      keyword: "",
    });
  }

  const intent = await getCachedIntent(query);
  return cachedJson(intent);
}

function getCachedIntent(query: string) {
  return unstable_cache(() => getIntent(query), [INTENT_CACHE_VERSION, query.toLowerCase()], {
    revalidate: CACHE_SECONDS,
    tags: [`search-intent-${slug(query)}`],
  })();
}

async function getIntent(query: string): Promise<SearchIntent> {
  const groqKey = process.env.GROQ_API;

  if (!groqKey) {
    return fallbackIntent(query);
  }

  try {
    const response = await fetch(GROQ_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_tokens: 140,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Map a streaming search request to JSON only. Allowed showType: movie, series, null. Allowed genre: all, action, animation, comedy, documentary, drama, horror, romance, scifi, thriller. Allowed sort: popularity_1week, popularity_1month, popularity_1year, popularity_alltime, rating, null. Prefer broad filters so the app always shows results. Use rating for best/highly rated/critically acclaimed/people recommend it. Use popularity_alltime for cult favorite, Reddit favorite, people online like it, beloved, classic, or word-of-mouth requests. Use popularity_1week for trending/new/popular right now. If multiple genres are requested, choose the strongest concrete genre; for sci-fi plus psychological thriller, choose scifi unless thriller is clearly primary. Leave keyword empty unless the user is directly asking for a specific title/person/franchise. If the phrase says 'like X' or 'similar to X', treat X as a reference for taste, not a keyword filter. Do not put Reddit, generic moods, plot vibes, adjectives, runtimes, references, or broad requests in keyword.",
          },
          {
            role: "user",
            content: `Return {"showType":..., "genre":..., "sort":..., "keyword":...} for: ${query}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      return fallbackIntent(query);
    }

    const payload = (await response.json()) as GroqResponse;
    const content = payload.choices?.[0]?.message?.content ?? "";
    return normalizeIntent(JSON.parse(content) as Partial<SearchIntent>, query);
  } catch {
    return fallbackIntent(query);
  }
}

function fallbackIntent(query: string): SearchIntent {
  const lower = query.toLowerCase();
  const showType: ShowType | null = /\b(tv|show|shows|series|season|episode)\b/.test(lower)
    ? "series"
    : /\b(movie|movies|film|films)\b/.test(lower)
      ? "movie"
      : null;

  const genre =
    matchGenre(lower, "sci-fi", "scifi") ??
    matchGenre(lower, "science fiction", "scifi") ??
    matchGenre(lower, "psychological thriller", "thriller") ??
    genres.find((candidate) => candidate !== "all" && lower.includes(candidate)) ??
    (/\bfunny|laugh|sitcom\b/.test(lower) ? "comedy" : null) ??
    (/\bscary|spooky\b/.test(lower) ? "horror" : null) ??
    (/\blove|date night\b/.test(lower) ? "romance" : null) ??
    "all";

  const sort: SortKey | null = /\breddit|word of mouth|word-of-mouth|cult|beloved|people like|people recommend|online like\b/.test(
    lower,
  )
    ? "popularity_alltime"
    : /\bbest|highest|rated|critically|score|recommend|recommended\b/.test(lower)
    ? "rating"
    : /\bclassic|all time|all-time\b/.test(lower)
      ? "popularity_alltime"
      : /\bnew|trending|popular|tonight|right now\b/.test(lower)
        ? "popularity_1week"
        : null;

  const keyword = lower
    .replace(/\b(movie|movies|film|films|tv|show|shows|series|season|episode)\b/g, "")
    .replace(/\b(best|highest|rated|critically|score|new|trending|popular|tonight|right now)\b/g, "")
    .replace(/\b(reddit|word of mouth|word-of-mouth|cult|beloved|people like|people recommend|online like|recommend|recommended)\b/g, "")
    .replace(/\b(action|animation|comedy|documentary|drama|horror|romance|thriller|psychological thriller|scifi|sci-fi|science fiction)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return { showType, genre, sort, keyword: keepSpecificKeyword(keyword) };
}

function normalizeIntent(intent: Partial<SearchIntent>, originalQuery: string): SearchIntent {
  const showType = intent.showType === "movie" || intent.showType === "series" ? intent.showType : null;
  const genre = genres.includes(intent.genre as GenreKey) ? (intent.genre as GenreKey) : "all";
  const sort = sorts.includes(intent.sort as SortKey) ? (intent.sort as SortKey) : null;
  const keyword =
    typeof intent.keyword === "string"
      ? keepSpecificKeyword(intent.keyword.trim().slice(0, 80))
      : fallbackIntent(originalQuery).keyword;

  return { showType, genre, sort, keyword };
}

function keepSpecificKeyword(keyword: string) {
  const lower = keyword.toLowerCase();

  if (!keyword || keyword.length < 3) {
    return "";
  }

  if (
    /\b(vibe|vibes|mood|something|anything|about|with|for|like|similar|similar to|fun|good|great|short|long|easy|smart|dark|light|cozy|intense|violent|family|kids|adult|date|night|mindless|interesting|underrated|popular|reddit|people|recommend)\b/.test(
      lower,
    )
  ) {
    return "";
  }

  return keyword;
}

function matchGenre(input: string, phrase: string, genre: GenreKey) {
  return input.includes(phrase) ? genre : null;
}

function cachedJson(payload: SearchIntent) {
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 7}`,
    },
  });
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
}

type GroqResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};
