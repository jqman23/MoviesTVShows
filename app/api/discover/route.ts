import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getDemoServices } from "../../data/demo";
import type {
  DiscoverResponse,
  GenreKey,
  ServiceId,
  ServiceResult,
  ShowType,
  SortKey,
  Title,
} from "../../types";

const API_BASE = "https://api.movieofthenight.com/v4";
const GROQ_BASE = "https://api.groq.com/openai/v1/chat/completions";
const COUNTRY = "us";
const CACHE_SECONDS = 60 * 60 * 24;
const RERANK_CACHE_SECONDS = 60 * 60 * 24;
const RERANK_MODEL = "llama-3.3-70b-versatile";

const services: Array<{ id: ServiceId; name: string; catalog: string; accent: string }> = [
  { id: "netflix", name: "Netflix", catalog: "netflix.subscription", accent: "#e50914" },
  { id: "hbo", name: "HBO/Max", catalog: "hbo.subscription", accent: "#00a6ff" },
  { id: "peacock", name: "Peacock", catalog: "peacock.subscription", accent: "#ffd23f" },
  { id: "hulu", name: "Hulu", catalog: "hulu.subscription", accent: "#1ce783" },
];

const sortKeys: SortKey[] = [
  "popularity_1week",
  "popularity_1month",
  "popularity_1year",
  "popularity_alltime",
  "rating",
];

const genreKeys: GenreKey[] = [
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const showType = normalizeShowType(searchParams.get("type"));
  const sort = normalizeSort(searchParams.get("sort"));
  const genre = normalizeGenre(searchParams.get("genre"));
  const keyword = normalizeKeyword(searchParams.get("keyword"));
  const preference = normalizePreference(searchParams.get("preference"));
  const apiKey = process.env.STREAMING_AVAILABILITY_API_KEY;
  const demoServices = getDemoServicesWithFallback(showType, sort, genre, keyword);

  if (!apiKey) {
    return cachedJson({
      source: "demo",
      message:
        "Demo data is showing because STREAMING_AVAILABILITY_API_KEY is not set on the server.",
      services: await rerankServices(demoServices, preference),
    });
  }

  const liveResults = await Promise.allSettled(
    services.map((service) =>
      getServiceCandidates(service, showType, sort, genre, keyword, preference, apiKey),
    ),
  );

  let hadFailure = false;
  const resolved = liveResults.map((result, index) => {
    if (result.status === "fulfilled" && result.value.items.length > 0) {
      return result.value;
    }

    hadFailure = true;
    return demoServices[index];
  });

  return cachedJson({
    source: hadFailure ? "mixed" : "live",
    message: hadFailure
      ? "Some live catalog requests were unavailable, so demo titles fill the gaps."
      : "Live Streaming Availability API results for US catalogs.",
    services: await rerankServices(resolved, preference),
  });
}

async function rerankServices(serviceResults: ServiceResult[], preference: string) {
  if (!preference) {
    return serviceResults;
  }

  return Promise.all(serviceResults.map((service) => rerankService(service, preference)));
}

function rerankService(service: ServiceResult, preference: string) {
  return unstable_cache(
    () => rerankServiceUncached(service, preference),
    [
      "rerank",
      service.id,
      slug(preference),
      service.items.map((item) => item.id).join("|").slice(0, 240),
    ],
    {
      revalidate: RERANK_CACHE_SECONDS,
      tags: [`rerank-${service.id}-${slug(preference)}`],
    },
  )();
}

async function rerankServiceUncached(service: ServiceResult, preference: string): Promise<ServiceResult> {
  const locallyRanked = localRerank(service.items, preference);
  const groqKey = process.env.GROQ_API;

  if (!groqKey || locallyRanked.length < 2) {
    return { ...service, items: locallyRanked };
  }

  try {
    const response = await fetch(GROQ_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: RERANK_MODEL,
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a brutally accurate streaming recommendation ranker. Rank titles for the user's exact taste, not for generic popularity. Use semantic fit first, then audience/critic rating, then original streaming popularity. Strongly demote false positives. For psychological thrillers, prefer dread, paranoia, obsession, mind games, mystery, crime, horror, sci-fi unease, cults, conspiracies, investigations, dark tension, or unreliable reality. Comedy, sitcom, workplace comedy, reality, talk show, game show, light documentary, or general drama should rank low unless the title is clearly also a dark thriller. For Reddit/word-of-mouth requests, prefer cult/beloved/high-rating candidates but still require topic fit. Score each title 0-100. Return JSON only: {\"ranked\":[{\"id\":\"...\",\"score\":87,\"reason\":\"2-5 words\"}]}. Include every supplied id exactly once.",
          },
          {
            role: "user",
            content: JSON.stringify({
              request: preference,
              service: service.name,
              titles: locallyRanked.map((item, index) => ({
                id: item.id,
                title: item.title,
                year: item.year,
                rating: item.rating,
                originalRank: index + 1,
                genres: item.genres,
                overview: item.overview,
              })),
            }),
          },
        ],
      }),
      next: {
        revalidate: RERANK_CACHE_SECONDS,
        tags: [`groq-rerank-${service.id}-${slug(preference)}`],
      },
    });

    if (!response.ok) {
      return { ...service, items: locallyRanked };
    }

    const payload = (await response.json()) as GroqResponse;
    const content = payload.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content) as { ranked?: Array<{ id?: string; score?: number; reason?: string }> };
    const ranked = Array.isArray(parsed.ranked) ? parsed.ranked : [];
    const aiScores = new Map(
      ranked
        .filter((entry) => typeof entry.id === "string")
        .map((entry, index) => [
          entry.id as string,
          {
            score: clampScore(entry.score),
            reason: typeof entry.reason === "string" ? entry.reason.slice(0, 48) : "",
            index,
          },
        ]),
    );
    const orderedIds = ranked.flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []));
    const itemMap = new Map(locallyRanked.map((item) => [item.id, item]));
    const ordered = orderedIds.flatMap((id) => {
      const item = itemMap.get(id);
      if (!item) {
        return [];
      }
      itemMap.delete(id);
      return [item];
    });

    return { ...service, items: guardedRerank([...ordered, ...itemMap.values()], preference, aiScores) };
  } catch {
    return { ...service, items: locallyRanked };
  }
}

function localRerank(items: Title[], preference: string) {
  return guardedRerank(items, preference);
}

function guardedRerank(
  items: Title[],
  preference: string,
  aiScores = new Map<string, { score: number; reason: string; index: number }>(),
) {
  const terms = rankTerms(preference);

  return [...items].sort((a, b) => {
    const scoreA = combinedScore(a, terms, items.indexOf(a), aiScores.get(a.id));
    const scoreB = combinedScore(b, terms, items.indexOf(b), aiScores.get(b.id));
    return scoreB - scoreA;
  }).map((item) => addMatchReason(item, preference, aiScores.get(item.id)?.reason));
}

function combinedScore(
  item: Title,
  terms: ReturnType<typeof rankTerms>,
  originalIndex: number,
  aiScore?: { score: number; index: number },
) {
  const local = localScore(item, terms, originalIndex);
  const ai = aiScore ? aiScore.score * 0.42 + Math.max(0, 12 - aiScore.index) * 0.3 : 0;
  return local + ai;
}

function addMatchReason(item: Title, preference: string, aiReason = ""): Title {
  const terms = rankTerms(preference);
  const text = `${item.title} ${item.overview} ${item.genres.join(" ")}`.toLowerCase();
  const reasons: string[] = [];

  if (aiReason) {
    reasons.push(aiReason);
  }

  if (terms.requiresTension) {
    if (/\b(psychological|paranoia|obsession|mind|conspiracy|cult)\b/.test(text)) {
      reasons.push("psych angle");
    } else if (/\b(thriller|suspense|mystery|crime|dark|tense|murder|killer|detective|investigation)\b/.test(text)) {
      reasons.push("tense mystery");
    }
  }

  const genreMatch = item.genres.find((genre) =>
    terms.positive.some((term) => genre.toLowerCase().includes(term)),
  );

  if (genreMatch && reasons.length < 2) {
    reasons.push(genreMatch);
  }

  if ((item.rating ?? 0) >= 7.5 && reasons.length < 2) {
    reasons.push("strong rating");
  }

  if (reasons.length === 0 && item.genres.length > 0) {
    reasons.push(item.genres[0]);
  }

  return {
    ...item,
    matchReason: reasons.slice(0, 2).join(" • "),
  };
}

function localScore(item: Title, terms: ReturnType<typeof rankTerms>, originalIndex: number) {
  const text = `${item.title} ${item.overview} ${item.genres.join(" ")}`.toLowerCase();
  let score = (item.rating ?? 6) * 2 - originalIndex * 0.15;
  let positiveMatches = 0;

  for (const term of terms.positive) {
    if (text.includes(term)) {
      positiveMatches += 1;
      score += 4;
    }
  }

  for (const term of terms.negative) {
    if (text.includes(term)) {
      score -= 5;
    }
  }

  if (terms.requiresTension) {
    const hasTensionSignal =
      positiveMatches > 0 ||
      /\b(thriller|suspense|mystery|crime|horror|psychological|paranoia|obsession|mind|dark|tense|conspiracy|cult|murder|killer|detective|investigation)\b/.test(
        text,
      );
    const hasComedyMismatch =
      /\b(comedy|sitcom|stand-up|workplace|talk show|reality|game show|variety|sketch)\b/.test(text);

    if (!hasTensionSignal) {
      score -= 12;
    }

    if (hasComedyMismatch) {
      score -= hasTensionSignal ? 10 : 18;
    }
  }

  return score;
}

function rankTerms(preference: string) {
  const lower = preference.toLowerCase();
  const positive = new Set<string>();
  const negative = new Set<string>();
  let requiresTension = false;

  if (/\bsci|sci-fi|science fiction|space|alien|future|cyberpunk\b/.test(lower)) {
    ["sci", "space", "alien", "future", "robot", "technology"].forEach((term) => positive.add(term));
  }

  if (/\bpsych|thrill|throller|thriller|suspense|mind.?bend|paranoia|mystery\b/.test(lower)) {
    requiresTension = true;
    ["thriller", "suspense", "mystery", "crime", "dark", "mind", "paranoia", "conspiracy"].forEach((term) =>
      positive.add(term),
    );
    ["comedy", "sitcom", "stand-up", "talk show", "reality", "workplace", "game show", "variety"].forEach((term) =>
      negative.add(term),
    );
  }

  if (/\bhorror|scary|spooky\b/.test(lower)) {
    ["horror", "scary", "supernatural"].forEach((term) => positive.add(term));
  }

  if (/\breddit|cult|beloved|people like|recommend\b/.test(lower)) {
    ["cult", "classic", "acclaimed"].forEach((term) => positive.add(term));
  }

  if (/\bwestern|frontier|cowboy|outlaw|saloon|wild west\b/.test(lower)) {
    ["western", "frontier", "cowboy", "outlaw", "saloon"].forEach((term) => positive.add(term));
  }

  return { positive: [...positive], negative: [...negative], requiresTension };
}

function preferenceKeywords(preference: string) {
  const lower = preference.toLowerCase();
  const keywords = new Set<string>();

  if (/\bwestern|frontier|cowboy|outlaw|saloon|wild west\b/.test(lower)) {
    keywords.add("western");
  }

  if (/\bspace|alien|robot|cyberpunk|future|science fiction|sci-fi\b/.test(lower)) {
    keywords.add("science fiction");
  }

  if (/\bpsych|thrill|throller|thriller|suspense|paranoia|mystery\b/.test(lower)) {
    keywords.add("thriller");
  }

  if (/\bcult|classic|beloved|underrated|hidden gem\b/.test(lower)) {
    keywords.add("classic");
  }

  return [...keywords].slice(0, 2);
}

async function getServiceCandidates(
  service: (typeof services)[number],
  showType: ShowType,
  sort: SortKey,
  genre: GenreKey,
  keyword: string,
  preference: string,
  apiKey: string,
) {
  if (!preference) {
    return getServiceWithFallback(service, showType, sort, genre, keyword, apiKey);
  }

  const pools = candidatePools(sort, genre, keyword, preference);
  const results = await Promise.allSettled(
    pools.map((pool) => getCachedService(service, showType, pool.sort, pool.genre, pool.keyword, apiKey)),
  );
  const base = results.find(
    (result): result is PromiseFulfilledResult<ServiceResult> =>
      result.status === "fulfilled" && result.value.items.length > 0,
  )?.value;

  if (!base) {
    return getServiceWithFallback(service, showType, sort, genre, keyword, apiKey);
  }

  const merged = new Map<string, Title>();

  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }

    for (const item of result.value.items) {
      if (!merged.has(item.id)) {
        merged.set(item.id, item);
      }
    }
  }

  return {
    ...base,
    items: [...merged.values()],
  };
}

function candidatePools(sort: SortKey, genre: GenreKey, keyword: string, preference: string) {
  const pools: Array<{ sort: SortKey; genre: GenreKey; keyword: string }> = [
    { sort, genre, keyword },
    { sort: "rating", genre, keyword: "" },
    { sort: "popularity_alltime", genre: genre === "all" ? "all" : genre, keyword: "" },
  ];

  for (const candidateKeyword of preferenceKeywords(preference)) {
    pools.push({ sort: "popularity_alltime", genre: "all", keyword: candidateKeyword });
  }

  return dedupePools(pools);
}

function dedupePools(pools: Array<{ sort: SortKey; genre: GenreKey; keyword: string }>) {
  const seen = new Set<string>();

  return pools.filter((pool) => {
    const key = `${pool.sort}:${pool.genre}:${pool.keyword}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getDemoServicesWithFallback(
  showType: ShowType,
  sort: SortKey,
  genre: GenreKey,
  keyword: string,
) {
  const exact = getDemoServices(showType, sort, genre, keyword);

  return exact.map((service) => {
    if (service.items.length > 0) {
      return service;
    }

    const withoutKeyword = getDemoServices(showType, sort, genre, "").find(
      (fallback) => fallback.id === service.id,
    );

    if (withoutKeyword && withoutKeyword.items.length > 0) {
      return withoutKeyword;
    }

    return (
      getDemoServices(showType, sort, "all", "").find((fallback) => fallback.id === service.id) ??
      service
    );
  });
}

async function getServiceWithFallback(
  service: (typeof services)[number],
  showType: ShowType,
  sort: SortKey,
  genre: GenreKey,
  keyword: string,
  apiKey: string,
) {
  const attempts: Array<{ genre: GenreKey; keyword: string }> = [
    { genre, keyword },
    { genre, keyword: "" },
    { genre: "all", keyword: "" },
  ];

  for (const attempt of attempts) {
    const result = await getCachedService(
      service,
      showType,
      sort,
      attempt.genre,
      attempt.keyword,
      apiKey,
    );

    if (result.items.length > 0) {
      return result;
    }
  }

  return getCachedService(service, showType, sort, "all", "", apiKey);
}

function getCachedService(
  service: (typeof services)[number],
  showType: ShowType,
  sort: SortKey,
  genre: GenreKey,
  keyword: string,
  apiKey: string,
) {
  return unstable_cache(
    () => fetchService(service, showType, sort, genre, keyword, apiKey),
    [COUNTRY, service.id, showType, sort, genre, keyword || "any-keyword"],
    {
      revalidate: CACHE_SECONDS,
      tags: [`discover-${COUNTRY}-${service.id}-${showType}-${sort}-${genre}-${keyword || "any"}`],
    },
  )();
}

async function fetchService(
  service: (typeof services)[number],
  showType: ShowType,
  sort: SortKey,
  genre: GenreKey,
  keyword: string,
  apiKey: string,
): Promise<ServiceResult> {
  const url = new URL(`${API_BASE}/shows/search/filters`);
  url.searchParams.set("country", COUNTRY);
  url.searchParams.set("catalogs", service.catalog);
  url.searchParams.set("show_type", showType);
  url.searchParams.set("order_by", sort);
  url.searchParams.set("order_direction", "desc");
  url.searchParams.set("output_language", "en");
  if (genre !== "all") {
    url.searchParams.set("genres", genre);
  }
  if (keyword) {
    url.searchParams.set("keyword", keyword);
  }

  const response = await fetch(url, {
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
    next: {
      revalidate: CACHE_SECONDS,
      tags: [`streaming-availability-${COUNTRY}-${service.id}-${showType}-${sort}-${genre}-${keyword || "any"}`],
    },
  });

  if (!response.ok) {
    throw new Error(`Streaming Availability request failed: ${response.status}`);
  }

  const payload = (await response.json()) as { shows?: ApiShow[] };

  return {
    id: service.id,
    name: service.name,
    accent: service.accent,
    items: (payload.shows ?? []).slice(0, 20).map((show) => normalizeTitle(show, service.id)),
  };
}

function normalizeTitle(show: ApiShow, serviceId: ServiceId): Title {
  const streamingOption = show.streamingOptions?.[COUNTRY]?.find(
    (option) => option.service?.id === serviceId,
  );

  return {
    id: String(show.id ?? show.imdbId ?? show.tmdbId ?? show.title),
    title: show.title ?? show.originalTitle ?? "Untitled",
    overview: show.overview ?? "No overview is available for this title yet.",
    year: show.releaseYear ?? show.firstAirYear ?? null,
    rating: typeof show.rating === "number" ? show.rating / 10 : null,
    poster:
      show.imageSet?.verticalPoster?.w360 ??
      show.imageSet?.verticalPoster?.w240 ??
      show.imageSet?.verticalPoster?.w600 ??
      null,
    link: streamingOption?.link ?? null,
    genres: normalizeGenres(show.genres),
  };
}

function normalizeGenres(genres: ApiShow["genres"]) {
  if (!Array.isArray(genres)) {
    return [];
  }

  return genres.slice(0, 3).flatMap((genre) => {
    if (typeof genre === "string") {
      return [genre];
    }

    if (genre && typeof genre === "object" && "name" in genre && typeof genre.name === "string") {
      return [genre.name];
    }

    return [];
  });
}

function normalizeShowType(value: string | null): ShowType {
  return value === "series" ? "series" : "movie";
}

function normalizeSort(value: string | null): SortKey {
  return sortKeys.includes(value as SortKey) ? (value as SortKey) : "popularity_1week";
}

function normalizeGenre(value: string | null): GenreKey {
  return genreKeys.includes(value as GenreKey) ? (value as GenreKey) : "all";
}

function normalizeKeyword(value: string | null) {
  return (value ?? "").trim().slice(0, 80);
}

function normalizePreference(value: string | null) {
  return (value ?? "").trim().slice(0, 160);
}

function clampScore(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 50;
  }

  return Math.max(0, Math.min(100, value));
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
}

type ApiShow = {
  id?: string;
  imdbId?: string;
  tmdbId?: string;
  title?: string;
  originalTitle?: string;
  overview?: string;
  releaseYear?: number;
  firstAirYear?: number;
  rating?: number;
  genres?: Array<string | { name?: string }>;
  imageSet?: {
    verticalPoster?: {
      w240?: string;
      w360?: string;
      w600?: string;
    };
  };
  streamingOptions?: {
    us?: Array<{
      link?: string;
      service?: {
        id?: string;
      };
    }>;
  };
};

type GroqResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

function cachedJson(payload: DiscoverResponse) {
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 2}`,
    },
  });
}
