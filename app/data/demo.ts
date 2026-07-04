import type { GenreKey, ServiceResult, ShowType, SortKey } from "../types";

const movieData: ServiceResult[] = [
  {
    id: "netflix",
    name: "Netflix",
    accent: "#e50914",
    items: [
      title("nx-m-1", "The Electric State", 2025, 6.3, "A retro-future road trip pairs a runaway teen with a lost robot and a guarded drifter.", ["action", "scifi"]),
      title("nx-m-2", "Rebel Ridge", 2024, 6.8, "A former Marine uncovers corruption after a small-town traffic stop turns personal.", ["action", "thriller"]),
      title("nx-m-3", "Hit Man", 2024, 6.9, "A mild professor moonlighting for police finds the role getting dangerously real.", ["comedy", "romance"]),
      title("nx-m-4", "Glass Onion", 2022, 7.1, "Detective Benoit Blanc peels apart a tech billionaire's island mystery.", ["comedy", "drama"]),
    ],
  },
  {
    id: "hbo",
    name: "HBO/Max",
    accent: "#00a6ff",
    items: [
      title("mx-m-1", "Dune: Part Two", 2024, 8.5, "Paul Atreides joins the Fremen while vengeance and prophecy collide on Arrakis.", ["action", "scifi"]),
      title("mx-m-2", "Barbie", 2023, 6.8, "A perfect doll leaves her polished world for a sharp, human-scale reality check.", ["comedy", "romance"]),
      title("mx-m-3", "Civil War", 2024, 7.0, "Journalists cross a fractured America to document a nation in free fall.", ["action", "drama"]),
      title("mx-m-4", "The Batman", 2022, 7.8, "A young Bruce Wayne follows riddles through Gotham's rot and revenge.", ["action", "thriller"]),
    ],
  },
  {
    id: "peacock",
    name: "Peacock",
    accent: "#ffd23f",
    items: [
      title("pk-m-1", "Oppenheimer", 2023, 8.3, "A brilliant physicist builds the atomic bomb and faces the weight of history.", ["drama", "documentary"]),
      title("pk-m-2", "The Fall Guy", 2024, 6.9, "A stunt performer is pulled into a missing-person mystery on a chaotic film set.", ["action", "comedy"]),
      title("pk-m-3", "Twisters", 2024, 6.5, "Storm chasers race across Oklahoma as a new tornado outbreak escalates.", ["action", "thriller"]),
      title("pk-m-4", "Nope", 2022, 6.8, "Hollywood horse wranglers notice something impossible watching from the sky.", ["horror", "scifi"]),
    ],
  },
  {
    id: "hulu",
    name: "Hulu",
    accent: "#1ce783",
    items: [
      title("hu-m-1", "Poor Things", 2023, 7.8, "A revived woman tears through Victorian society with fierce curiosity.", ["comedy", "drama"]),
      title("hu-m-2", "Prey", 2022, 7.1, "A Comanche hunter faces an alien predator in the northern plains.", ["action", "horror"]),
      title("hu-m-3", "The Banshees of Inisherin", 2022, 7.7, "A broken friendship turns a remote island into a stage for grief and pride.", ["comedy", "drama"]),
      title("hu-m-4", "Rye Lane", 2023, 7.2, "Two freshly heartbroken Londoners turn a bad day into a bright detour.", ["comedy", "romance"]),
    ],
  },
];

const seriesData: ServiceResult[] = [
  {
    id: "netflix",
    name: "Netflix",
    accent: "#e50914",
    items: [
      title("nx-s-1", "Stranger Things", 2016, 8.6, "Friends in Hawkins confront secret experiments and a hostile alternate world.", ["horror", "scifi"]),
      title("nx-s-2", "The Diplomat", 2023, 8.0, "A career diplomat navigates crisis, marriage, and power in London.", ["drama", "thriller"]),
      title("nx-s-3", "Wednesday", 2022, 8.0, "Wednesday Addams investigates murders and family secrets at Nevermore Academy.", ["comedy", "horror"]),
      title("nx-s-4", "Black Mirror", 2011, 8.7, "Anthology stories track technology's sharp edges and human consequences.", ["drama", "scifi"]),
    ],
  },
  {
    id: "hbo",
    name: "HBO/Max",
    accent: "#00a6ff",
    items: [
      title("mx-s-1", "The Last of Us", 2023, 8.7, "A smuggler escorts a teenager across a changed America after a fungal collapse.", ["action", "drama"]),
      title("mx-s-2", "House of the Dragon", 2022, 8.3, "House Targaryen fractures as succession politics turn combustible.", ["action", "drama"]),
      title("mx-s-3", "Hacks", 2021, 8.2, "A Vegas comedy legend and a young writer sharpen each other.", ["comedy", "drama"]),
      title("mx-s-4", "Succession", 2018, 8.8, "A media dynasty fights for control while family loyalty curdles.", ["drama"]),
    ],
  },
  {
    id: "peacock",
    name: "Peacock",
    accent: "#ffd23f",
    items: [
      title("pk-s-1", "Poker Face", 2023, 7.8, "A human lie detector solves strange crimes while staying on the move.", ["comedy", "drama"]),
      title("pk-s-2", "The Traitors", 2023, 7.7, "Reality contestants hunt secret saboteurs inside a castle competition.", ["thriller"]),
      title("pk-s-3", "The Office", 2005, 9.0, "A documentary crew follows everyday chaos at a Pennsylvania paper company.", ["comedy", "documentary"]),
      title("pk-s-4", "Bel-Air", 2022, 6.4, "A dramatic reimagining follows Will's move from West Philadelphia to Los Angeles.", ["drama"]),
    ],
  },
  {
    id: "hulu",
    name: "Hulu",
    accent: "#1ce783",
    items: [
      title("hu-s-1", "Shogun", 2024, 8.6, "A shipwrecked navigator enters a dangerous power struggle in feudal Japan.", ["action", "drama"]),
      title("hu-s-2", "The Bear", 2022, 8.5, "A chef returns home to run a sandwich shop and rebuild a team.", ["comedy", "drama"]),
      title("hu-s-3", "Only Murders in the Building", 2021, 8.1, "True-crime fans investigate deaths inside their Upper West Side building.", ["comedy", "drama"]),
      title("hu-s-4", "Abbott Elementary", 2021, 8.2, "Dedicated teachers keep a Philadelphia public school moving with heart and humor.", ["comedy"]),
    ],
  },
];

export function getDemoServices(
  showType: ShowType,
  sort: SortKey,
  genre: GenreKey,
  keyword = "",
): ServiceResult[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  const data = showType === "movie" ? movieData : seriesData;
  return data.map((service) => ({
    ...service,
    items: expandDemoItems(service.items)
      .filter((item) => genre === "all" || item.genres.includes(genre))
      .filter(
        (item) =>
          !normalizedKeyword ||
          item.title.toLowerCase().includes(normalizedKeyword) ||
          item.overview.toLowerCase().includes(normalizedKeyword),
      )
      .sort((a, b) => {
        if (sort === "rating") {
          return (b.rating ?? 0) - (a.rating ?? 0);
        }

        return a.id.localeCompare(b.id);
      }),
  }));
}

function title(
  id: string,
  name: string,
  year: number,
  rating: number,
  overview: string,
  genres: GenreKey[],
) {
  return {
    id,
    title: name,
    year,
    rating,
    overview,
    poster: null,
    link: null,
    genres,
  };
}

function expandDemoItems(items: ServiceResult["items"]) {
  return Array.from({ length: 16 }, (_, index) => {
    const item = items[index % items.length];
    const page = Math.floor(index / items.length);

    if (page === 0) {
      return item;
    }

    return {
      ...item,
      id: `${item.id}-demo-${page}`,
      title: `${item.title} ${page + 1}`,
      rating: item.rating ? Math.max(5, item.rating - page * 0.2) : item.rating,
    };
  });
}
