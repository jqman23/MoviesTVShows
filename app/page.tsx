"use client";

import { useEffect, useMemo, useState } from "react";
import type { DiscoverResponse, ShowType, SortKey } from "./types";

const responseCache = new Map<string, DiscoverResponse>();

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: "popularity_1week", label: "Past week" },
  { value: "popularity_1month", label: "Past month" },
  { value: "popularity_1year", label: "Past year" },
  { value: "popularity_alltime", label: "All time" },
  { value: "rating", label: "Rating" },
];

export default function Home() {
  const [showType, setShowType] = useState<ShowType>("movie");
  const [sort, setSort] = useState<SortKey>("popularity_1week");
  const [data, setData] = useState<DiscoverResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ type: showType, sort });
    return params.toString();
  }, [showType, sort]);

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

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">MoviesTVShows</p>
          <h1 id="page-title">Top US streaming picks by service</h1>
          <p className="lede">
            Compare leading movies and TV shows on Netflix, HBO/Max, Peacock, and Hulu with
            live Streaming Availability data when the server API key is configured.
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
            onClick={() => setShowType("movie")}
            type="button"
          >
            Movies
          </button>
          <button
            className={showType === "series" ? "active" : ""}
            onClick={() => setShowType("series")}
            type="button"
          >
            TV Shows
          </button>
        </div>

        <label className="select-label">
          Sort
          <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <div className={`notice ${data?.source ?? "demo"}`} role="status" aria-live="polite">
        {isLoading ? "Loading catalog results..." : data?.message}
        {error ? <span>{error}</span> : null}
      </div>

      {isLoading && !data ? <SkeletonGrid /> : null}

      <section className="service-grid" aria-label="Streaming service results">
        {data?.services.map((service) => (
          <article className="service" key={service.id} style={{ "--accent": service.accent } as React.CSSProperties}>
            <div className="service-header">
              <div>
                <p>Top {showType === "movie" ? "movies" : "TV shows"}</p>
                <h2>{service.name}</h2>
              </div>
              <span>{service.items.length}</span>
            </div>

            <div className="titles">
              {service.items.map((item, index) => (
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
                    <div className="rank">#{index + 1}</div>
                    <h3>{item.title}</h3>
                    <p className="meta">
                      {item.year ?? "Year N/A"}
                      {item.rating ? ` | ${item.rating.toFixed(1)} rating` : ""}
                    </p>
                    <p className="overview">{item.overview}</p>
                    {item.link ? (
                      <a href={item.link} target="_blank" rel="noreferrer">
                        Watch details
                      </a>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </article>
        ))}
      </section>
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
