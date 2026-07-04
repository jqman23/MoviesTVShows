export type ShowType = "movie" | "series";

export type SortKey =
  | "popularity_1week"
  | "popularity_1month"
  | "popularity_1year"
  | "popularity_alltime"
  | "rating";

export type GenreKey =
  | "all"
  | "action"
  | "animation"
  | "comedy"
  | "documentary"
  | "drama"
  | "horror"
  | "romance"
  | "scifi"
  | "thriller";

export type ServiceId = "netflix" | "hbo" | "peacock" | "hulu";

export type Title = {
  id: string;
  title: string;
  overview: string;
  year: number | null;
  rating: number | null;
  poster: string | null;
  link: string | null;
  genres: string[];
  matchReason?: string;
};

export type ServiceResult = {
  id: ServiceId;
  name: string;
  accent: string;
  items: Title[];
};

export type DiscoverResponse = {
  source: "live" | "demo" | "mixed";
  message: string;
  services: ServiceResult[];
};

export type SearchIntent = {
  showType: ShowType | null;
  sort: SortKey | null;
  genre: GenreKey;
  keyword: string;
};
