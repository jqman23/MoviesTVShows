"use client";

import { type CSSProperties, type FormEvent, useEffect, useMemo, useState } from "react";
import type { DiscoverResponse, GenreKey, SearchIntent, ShowType, SortKey } from "./types";

const responseCache = new Map<string, DiscoverResponse>();
const intentCache = new Map<string, SearchIntent>();
const pageSize = 8;

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: "popularity_1week", label: "Past week" },
  { value: "popularity_1month", label: "Past month" },
  { value: "popularity_1year", label: "Past year" },
  { value: "popularity_alltime", label: "All time" },
  { value: "rating", label: "Rating" },
];

const genreOptions: Array<{ value: GenreKey; label: string }> = [
  { value: "all", label: "All genres" },
  { value: "action", label: "Action" },
  { value: "animation", label: "Animation" },
  { value: "comedy", label: "Comedy" },
  { value: "documentary", label: "Documentary" },
  { value: "drama", label: "Drama" },
  { value: "horror", label: "Horror" },
  { value: "romance", label: "Romance" },
  { value: "scifi", label: "Sci-Fi" },
  { value: "thriller", label: "Thriller" },
];

const rottenTomatoesLinks = {
  netflix: "https://www.rottentomatoes.com/browse/movies_at_home/affiliates:netflix~sort:popular",
  hbo: "https://www.rottentomatoes.com/browse/movies_at_home/affiliates:max~sort:popular",
  peacock: "https://www.rottentomatoes.com/browse/movies_at_home/affiliates:peacock~sort:popular",
  hulu: "https://www.rottentomatoes.com/browse/movies_at_home/affiliates:hulu~sort:popular",
};

export default function Home() {
  const [showType, setShowType] = useState<ShowType>("movie");
  const [sort, setSort] = useState<SortKey>("popularity_1week");
  const [genre, setGenre] = useState<GenreKey>("all");
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [preference, setPreference] = useState("");
  const [servicePages, setServicePages] = useState<Record<string, number>>({});
  const [isInterpreting, setIsInterpreting] = useState(false);
  const [data, setData] = useState<DiscoverResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedServices, setCollapsedServices] = useState<Set<string>>(
    () => new Set(["netflix", "hbo", "peacock", "hulu"]),
  );

  const query = useMemo(() => {
    const params = new URLSearchParams({ type: showType, sort, genre });
    if (keyword) {
      params.set("keyword", keyword);
    }
    if (preference) {
      params.set("preference", preference);
    }

    return params.toString();
  }, [genre, keyword, preference, showType, sort]);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      const cached = responseCache.get(query);
      if (cached) {
        setData(cached);
        setError(null);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/discover?${query}`);
        const payload = (await response.json()) as DiscoverResponse;

        if (!response.ok) {
          throw new Error(payload.message || "Unable to load titles.");
        }

        if (isMounted) {
          responseCache.set(query, payload);
          setData(payload);
        }
      } catch {
        if (isMounted) {
          setError("The catalog could not refresh. Showing the last available view.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    load();

    return () => {
      isMounted = false;
    };
  }, [query]);

  function toggleService(serviceId: string) {
    setCollapsedServices((current) => {
      const next = new Set(current);

      if (next.has(serviceId)) {
        next.delete(serviceId);
      } else {
        next.add(serviceId);
      }

      return next;
    });
  }

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const phrase = keywordInput.trim();

    resetPages();

    if (!phrase) {
      setKeyword("");
      setPreference("");
      setGenre("all");
      return;
    }

    const cacheKey = phrase.toLowerCase();
    const cachedIntent = intentCache.get(cacheKey);

    if (cachedIntent) {
      applyIntent(cachedIntent, phrase);
      return;
    }

    setIsInterpreting(true);

    try {
      const response = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: phrase }),
      });
      const intent = (await response.json()) as SearchIntent;

      if (response.ok) {
        intentCache.set(cacheKey, intent);
        applyIntent(intent, phrase);
      } else {
        setKeyword(phrase);
        setPreference(phrase);
      }
    } catch {
      setKeyword(phrase);
      setPreference(phrase);
    } finally {
      setIsInterpreting(false);
    }
  }

  function applyIntent(intent: SearchIntent, phrase: string) {
    resetPages();
    if (intent.showType) {
      setShowType(intent.showType);
    }
    if (intent.sort) {
      setSort(intent.sort);
    }
    setGenre(intent.genre);
    setKeyword(intent.keyword);
    setPreference(phrase);
  }

  function resetPages() {
    setServicePages({});
  }

  function setServicePage(serviceId: string, page: number) {
    setServicePages((current) => ({
      ...current,
      [serviceId]: page,
    }));
  }

  const shouldShowStatus = Boolean(error || (data && data.source !== "live"));

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">MoviesTVShows</p>
          <h1 id="page-title">Find what to watch</h1>
          <p className="lede">
            Browse top US movies and TV shows by service, genre, rating, and popularity.
          </p>
        </div>

        <div className="hero-panel" aria-label="Current filters">
          <span>United States catalogs</span>
          <strong>{showType === "movie" ? "Movies" : "TV Shows"}</strong>
          <span>{sortOptions.find((option) => option.value === sort)?.label}</span>
        </div>
      </section>

      <section className="toolbar" aria-label="Discovery controls">
        <div className="segmented" aria-label="Title type">
          <button
            className={showType === "movie" ? "active" : ""}
            onClick={() => {
              resetPages();
              setPreference("");
              setShowType("movie");
            }}
            type="button"
          >
            Movies
          </button>
          <button
            className={showType === "series" ? "active" : ""}
            onClick={() => {
              resetPages();
              setPreference("");
              setShowType("series");
            }}
            type="button"
          >
            TV Shows
          </button>
        </div>

        <div className="filters">
          <label className="select-label">
            Sort
            <select
              value={sort}
              onChange={(event) => {
                resetPages();
                setPreference("");
                setSort(event.target.value as SortKey);
              }}
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="select-label">
            Genre
            <select
              value={genre}
              onChange={(event) => {
                resetPages();
                setPreference("");
                setGenre(event.target.value as GenreKey);
              }}
            >
              {genreOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <form className="search" onSubmit={submitSearch}>
          <label htmlFor="keyword">Search</label>
          <input
            id="keyword"
            onChange={(event) => setKeywordInput(event.target.value)}
            placeholder="Describe what you want"
            type="search"
            value={keywordInput}
          />
          <button disabled={isInterpreting} type="submit">
            {isInterpreting ? "..." : "Go"}
          </button>
        </form>

        {(isLoading && data) || isInterpreting ? (
          <div className="loading-strip" role="status">
            Updating picks...
          </div>
        ) : null}
      </section>

      {isLoading && !data ? <SkeletonGrid /> : null}

      <section className="service-grid" aria-label="Streaming service results">
        {data?.services.map((service) => {
          const isCollapsed = collapsedServices.has(service.id);
          const panelId = `${service.id}-titles`;
          const maxServicePage = Math.max(0, Math.ceil(service.items.length / pageSize) - 1);
          const servicePage = Math.min(servicePages[service.id] ?? 0, maxServicePage);
          const pageStart = servicePage * pageSize;
          const pageEnd = pageStart + pageSize;
          const visibleItems = service.items.slice(pageStart, pageEnd);

          return (
            <article
              className={`service ${isCollapsed ? "collapsed" : ""} ${isLoading ? "is-refreshing" : ""}`}
              key={service.id}
              style={{ "--accent": service.accent } as CSSProperties}
            >
            <button
              aria-controls={panelId}
              aria-expanded={!isCollapsed}
              className="service-header"
              onClick={() => toggleService(service.id)}
              type="button"
            >
              <div>
                <p>Top {showType === "movie" ? "movies" : "TV shows"}</p>
                <h2>{service.name}</h2>
              </div>
              <span className="count">{service.items.length}</span>
              <span className="chevron" aria-hidden="true" />
            </button>

            <div className="titles" id={panelId}>
              <a
                className="rt-link"
                href={rottenTomatoesLinks[service.id]}
                rel="noreferrer"
                target="_blank"
              >
                Rotten Tomatoes browse list
              </a>
              {visibleItems.length === 0 ? (
                <p className="empty">Open a broader page of picks.</p>
              ) : null}
              {visibleItems.map((item, index) => (
                <article className="title" key={item.id}>
                  <div className="poster">
                    {item.poster ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.poster} alt="" loading="lazy" />
                    ) : (
                      <span>{item.title.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="title-copy">
                    <div className="rank">#{pageStart + index + 1}</div>
                    <div className="title-row">
                      <h3>{item.title}</h3>
                      {item.rating ? <span>{item.rating.toFixed(1)}</span> : null}
                    </div>
                    <p className="meta">
                      {item.year ?? "Year N/A"}
                      {item.genres.length ? ` | ${item.genres.join(", ")}` : ""}
                    </p>
                    {item.matchReason ? <p className="match-reason">{item.matchReason}</p> : null}
                    <p className="overview">{item.overview}</p>
                    {item.link ? (
                      <a href={item.link} target="_blank" rel="noreferrer">
                        Watch details
                      </a>
                    ) : null}
                  </div>
                </article>
              ))}
              {service.items.length > pageSize ? (
                <div className="page-controls" aria-label={`${service.name} result pages`}>
                  <button
                    disabled={servicePage === 0}
                    onClick={() => setServicePage(service.id, Math.max(0, servicePage - 1))}
                    type="button"
                  >
                    Previous 8
                  </button>
                  <span>
                    {pageStart + 1}-{Math.min(pageEnd, service.items.length)}
                  </span>
                  <button
                    disabled={servicePage >= maxServicePage}
                    onClick={() =>
                      setServicePage(service.id, Math.min(maxServicePage, servicePage + 1))
                    }
                    type="button"
                  >
                    Next 8
                  </button>
                </div>
              ) : null}
            </div>
          </article>
          );
        })}
      </section>

      {shouldShowStatus ? (
        <div className={`notice ${data?.source ?? "demo"}`} role="status" aria-live="polite">
          {error ? <span>{error}</span> : data?.message}
        </div>
      ) : null}
    </main>
  );
}

function SkeletonGrid() {
  return (
    <section className="service-grid" aria-label="Loading results">
      {[0, 1, 2, 3].map((service) => (
        <article className="service skeleton" key={service}>
          <div className="service-header">
            <div>
              <p />
              <h2 />
            </div>
            <span />
          </div>
          <div className="titles">
            {[0, 1, 2].map((item) => (
              <div className="title" key={item}>
                <div className="poster" />
                <div className="title-copy">
                  <h3 />
                  <p />
                  <p />
                </div>
              </div>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}
