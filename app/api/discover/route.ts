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
const COUNTRY = "us";
const CACHE_SECONDS = 60 * 60 * 6;

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
  const apiKey = process.env.STREAMING_AVAILABILITY_API_KEY;
  const demoServices = getDemoServices(showType, sort, genre, keyword);

  if (!apiKey) {
    return cachedJson({
      source: "demo",
      message:
        "Demo data is showing because STREAMING_AVAILABILITY_API_KEY is not set on the server.",
      services: demoServices,
    });
  }

  const liveResults = await Promise.allSettled(
    services.map((service) => getCachedService(service, showType, sort, genre, keyword, apiKey)),
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
    services: resolved,
  });
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
    genres: Array.isArray(show.genres) ? show.genres.slice(0, 3).map(String) : [],
  };
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
  genres?: string[];
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

function cachedJson(payload: DiscoverResponse) {
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 2}`,
    },
  });
}
