import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getDemoServices } from "../../data/demo";
import { serviceIds } from "../../types";
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
const PROFILE_CACHE_SECONDS = 60 * 60 * 24 * 7;
const SMART_MODEL = "openai/gpt-oss-120b";
const DISCOVER_CACHE_VERSION = "discover-v12";
const RERANK_CACHE_VERSION = "rerank-v15";
const PROFILE_CACHE_VERSION = "profile-v3";

const services: Array<{ id: ServiceId; name: string; catalog: string; accent: string }> = [
  { id: "netflix", name: "Netflix", catalog: "netflix.subscription", accent: "#e50914" },
  { id: "hbo", name: "HBO/Max", catalog: "hbo.subscription", accent: "#00a6ff" },
  { id: "peacock", name: "Peacock", catalog: "peacock.subscription", accent: "#ffd23f" },
  { id: "hulu", name: "Hulu", catalog: "hulu.subscription", accent: "#1ce783" },
];

type TasteProfile = {
  summary: string;
  referenceTitles: string[];
  targetTitles: string[];
  keywords: string[];
  mustHave: string[];
  niceToHave: string[];
  avoid: string[];
  discoveryMode: boolean;
};

const sortKeys: SortKey[] = [
  "popularity_1week",
  "popularity_1month",
  "popularity_1year",
  "popularity_alltime",
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
  const selectedServices = normalizeServices(searchParams.get("services"));
  const activeServices = services.filter((service) => selectedServices.includes(service.id));
  const apiKey = process.env.STREAMING_AVAILABILITY_API_KEY;
  const demoServices = getDemoServicesWithFallback(showType, sort, genre, keyword).filter((service) =>
    selectedServices.includes(service.id),
  );
  const profile = await getTasteProfile(preference, activeServices);

  if (!apiKey) {
    return cachedJson({
      source: "demo",
      message:
        "Demo data is showing because STREAMING_AVAILABILITY_API_KEY is not set on the server.",
      services: await rerankServices(demoServices, preference, sort, profile),
    });
  }

  const liveResults = await Promise.allSettled(
    activeServices.map((service) =>
      getServiceCandidates(service, showType, sort, genre, keyword, preference, profile, apiKey),
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
    services: await rerankServices(resolved, preference, sort, profile),
  });
}

async function rerankServices(
  serviceResults: ServiceResult[],
  preference: string,
  sort: SortKey,
  profile: TasteProfile,
) {
  if (!preference) {
    return serviceResults;
  }

  return Promise.all(serviceResults.map((service) => rerankService(service, preference, sort, profile)));
}

function rerankService(service: ServiceResult, preference: string, sort: SortKey, profile: TasteProfile) {
  return unstable_cache(
    () => rerankServiceUncached(service, preference, sort, profile),
    [
      RERANK_CACHE_VERSION,
      service.id,
      slug(preference),
      sort,
      slug(profile.summary),
      profile.keywords.join("|"),
      profile.targetTitles.join("|").slice(0, 240),
      service.items.map((item) => item.id).join("|").slice(0, 240),
    ],
    {
      revalidate: RERANK_CACHE_SECONDS,
      tags: [`rerank-${service.id}-${slug(preference)}`],
    },
  )();
}

async function rerankServiceUncached(
  service: ServiceResult,
  preference: string,
  sort: SortKey,
  profile: TasteProfile,
): Promise<ServiceResult> {
  const locallyRanked = localRerank(service.items, preference, sort, profile);
  const groqKey = process.env.GROQ_API;
  const references = profile.referenceTitles;
  const discoveryMode = profile.discoveryMode;

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
        model: SMART_MODEL,
        temperature: 0,
        max_tokens: 1800,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a brutally accurate streaming recommendation ranker. Rank titles for the user's exact taste, not for generic popularity. Use semantic fit first, then audience/critic rating, then original streaming popularity. Strongly demote false positives. If referenceTitles are supplied, treat them as taste anchors and infer shared themes, tone, structure, pacing, and audience appeal; do not require literal title-word matches, and score the reference titles themselves very low because the user wants recommendations. If discoveryMode is true, prefer less obvious high-fit titles over the most mainstream default when quality and fit are competitive. If the user asks about a subject such as dogs, chefs, lawyers, vampires, football, cowboys, etc., titles must actually be about or prominently include that subject; generic high-rated shows should rank low. For psychological thrillers, prefer dread, paranoia, obsession, mind games, mystery, crime, horror, sci-fi unease, cults, conspiracies, investigations, dark tension, or unreliable reality. Comedy, sitcom, workplace comedy, reality, talk show, game show, light documentary, or general drama should rank low unless the title is clearly also a dark thriller. For western/frontier/cowboy/outlaw requests, strongly prefer titles with western/frontier/cowboy/outlaw/saloon/ranch/frontier-town/old-west signals; generic acclaimed dramas or fantasy should rank low. For Reddit/word-of-mouth/cult/classic requests, prefer cult/beloved/high-rating candidates but still require topic fit. Score each title 0-100. Return JSON only: {\"ranked\":[{\"id\":\"...\",\"score\":87,\"reason\":\"2-4 specific words\"}]}. Include every supplied id exactly once. Reasons must be short positive evidence like 'criminal antihero', 'cult paranoia', or 'dark investigation'. Never write failure labels such as 'reference title', 'already ranked', 'no crime', 'no thriller', 'some elements', 'dominant', 'less relevant', 'does not match', or 'no match'.",
          },
          {
            role: "user",
            content: JSON.stringify({
              request: preference,
              tasteProfile: profile,
              referenceTitles: references,
              discoveryMode,
              service: service.name,
              titles: locallyRanked.slice(0, 60).map((item, index) => ({
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
            reason: typeof entry.reason === "string" ? cleanAiReason(entry.reason) : "",
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

    return { ...service, items: guardedRerank([...ordered, ...itemMap.values()], preference, sort, profile, aiScores) };
  } catch {
    return { ...service, items: locallyRanked };
  }
}

function localRerank(items: Title[], preference: string, sort: SortKey, profile: TasteProfile) {
  return guardedRerank(items, preference, sort, profile);
}

function guardedRerank(
  items: Title[],
  preference: string,
  sort: SortKey,
  profile: TasteProfile,
  aiScores = new Map<string, { score: number; reason: string; index: number }>(),
) {
  const terms = rankTerms(preference, profile);

  const ranked = [...items].sort((a, b) => {
    const scoreA = combinedScore(a, terms, items.indexOf(a), sort, aiScores.get(a.id));
    const scoreB = combinedScore(b, terms, items.indexOf(b), sort, aiScores.get(b.id));
    return scoreB - scoreA;
  });
  const withoutReferences =
    terms.referenceTitles.length > 0
      ? ranked.filter((item) => !isReferenceTitle(item.title, terms.referenceTitles))
      : ranked;

  const curated = withoutReferences.map((item) =>
    addMatchReason(item, preference, profile, aiScores.get(item.id)?.reason),
  );

  return terms.discoveryMode ? curated.slice(0, 24) : curated;
}

function combinedScore(
  item: Title,
  terms: ReturnType<typeof rankTerms>,
  originalIndex: number,
  sort: SortKey,
  aiScore?: { score: number; reason: string; index: number },
) {
  const local = localScore(item, terms, originalIndex, sort);
  const aiWeight = terms.referenceTitles.length > 0 || terms.discoveryMode ? 0.56 : 0.38;
  const aiPenalty = aiScore?.reason && isNegativeReason(aiScore.reason) ? 34 : 0;
  const ai = aiScore ? aiScore.score * aiWeight + Math.max(0, 12 - aiScore.index) * 0.35 - aiPenalty : 0;
  return local + ai;
}

function addMatchReason(item: Title, preference: string, profile: TasteProfile, aiReason = ""): Title {
  const terms = rankTerms(preference, profile);
  const text = `${item.title} ${item.overview} ${item.genres.join(" ")}`.toLowerCase();
  const reasons: string[] = [];

  if (aiReason && !isNegativeReason(aiReason)) {
    reasons.push(aiReason);
  }

  const subjectMatch = terms.requiredSubjects.find((subject) => subject.matches.some((term) => text.includes(term)));

  if (subjectMatch && reasons.length < 2) {
    reasons.push(subjectMatch.reason);
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

  const profileReason = [...terms.mustHave, ...terms.niceToHave].find((term) => text.includes(term));

  if (profileReason && reasons.length < 2) {
    reasons.push(profileReason);
  }

  if ((item.rating ?? 0) >= 7.5 && reasons.length < 2 && (!terms.discoveryMode || hasTasteSignal(text))) {
    reasons.push("strong rating");
  }

  if (reasons.length === 0 && item.genres.length > 0 && !terms.discoveryMode) {
    reasons.push(item.genres[0]);
  }

  return {
    ...item,
    matchReason: reasons.slice(0, 2).join(" • "),
  };
}

function localScore(
  item: Title,
  terms: ReturnType<typeof rankTerms>,
  originalIndex: number,
  sort: SortKey,
) {
  const text = `${item.title} ${item.overview} ${item.genres.join(" ")}`.toLowerCase();
  let score = (item.rating ?? 6) * 5 - originalIndex * windowRankWeight(sort, terms);
  let positiveMatches = 0;

  if (isReferenceTitle(item.title, terms.referenceTitles)) {
    score -= 55;
  }

  if (isReferenceTitle(item.title, terms.targetTitles)) {
    score += 95;
  }

  for (const term of terms.positive) {
    if (text.includes(term)) {
      positiveMatches += 1;
      score += 4;
    }
  }

  for (const term of terms.mustHave) {
    if (text.includes(term)) {
      positiveMatches += 2;
      score += 11;
    }
  }

  for (const term of terms.niceToHave) {
    if (text.includes(term)) {
      positiveMatches += 1;
      score += 6;
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

  if (terms.requiresWestern) {
    const hasWesternSignal =
      positiveMatches > 0 ||
      /\b(western|frontier|cowboy|outlaw|saloon|ranch|gunslinger|old west|wild west|frontier town|lawman|sheriff)\b/.test(
        text,
      );
    const hasMismatch =
      /\b(fantasy|dragon|sitcom|workplace|office|modern family|talk show|reality|game show|superhero)\b/.test(
        text,
      );

    if (!hasWesternSignal) {
      score -= 24;
    }

    if (hasMismatch) {
      score -= 12;
    }
  }

  for (const subject of terms.requiredSubjects) {
    const hasSubject = subject.matches.some((term) => text.includes(term));

    if (hasSubject) {
      score += 20;
    } else {
      score -= 36;
    }
  }

  if (terms.discoveryMode) {
    if (/\b(cult|underrated|hidden|offbeat|unsettling|slow burn|limited series|miniseries|international|foreign|docuseries|documentary)\b/.test(text)) {
      score += 7;
    }

    if (hasGenericTasteMismatch(text, terms.preferenceText)) {
      score -= 34;
    }

    if (isLowSignalTrueCrimeDoc(item, text, terms.preferenceText)) {
      score -= 28;
    }

    if (isProceduralMismatch(text, terms.preferenceText)) {
      score -= 22;
    }

    if (terms.mustHave.length > 0 && !terms.mustHave.some((term) => text.includes(term))) {
      score -= 14;
    }

    if (originalIndex < 4 && (item.rating ?? 0) < 8) {
      score -= 4;
    }
  }

  return score;
}

function cleanAiReason(reason: string) {
  return reason
    .replace(/[.!?].*$/, "")
    .replace(/\b(with a high|with high|and high|rating|critic|audience|genres?|themes?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 34);
}

function isNegativeReason(reason: string) {
  return /\b(no match|no dogs?|not about|none|less relevant|lower relevance|doesn'?t match|do not match|don't match|but less|while highly rated|reference title|already ranked|no [a-z]+ element|no [a-z]+ elements|some [a-z]+ element|some [a-z]+ elements|[a-z]+ dominant)\b/i.test(
    reason,
  );
}

function isReferenceTitle(title: string, references: string[]) {
  const normalizedTitle = normalizeComparableTitle(title);

  return references.some((reference) => normalizeComparableTitle(reference) === normalizedTitle);
}

function subjectScore(item: Title, preference: string) {
  const terms = rankTerms(preference);

  if (terms.requiredSubjects.length === 0) {
    return true;
  }

  const text = `${item.title} ${item.overview} ${item.genres.join(" ")}`.toLowerCase();
  return terms.requiredSubjects.some((subject) => subject.matches.some((term) => text.includes(term)));
}

function rankTerms(preference: string, profile = fallbackTasteProfile(preference)) {
  const lower = preference.toLowerCase();
  const positive = new Set<string>();
  const negative = new Set<string>();
  const requiredSubjects: Array<{ reason: string; matches: string[] }> = [];
  const references = profile.referenceTitles.length > 0 ? profile.referenceTitles : referenceTitles(preference);
  const discoveryMode = profile.discoveryMode || wantsDiscovery(preference);
  let requiresTension = false;
  let requiresWestern = false;

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

  if (/\breddit|cult|beloved|people like|recommend|underrated|hidden gem|less mainstream|not mainstream|overlooked\b/.test(
    lower,
  )) {
    ["cult", "classic", "acclaimed", "underrated"].forEach((term) => positive.add(term));
  }

  if (/\bwestern|frontier|cowboy|outlaw|saloon|wild west\b/.test(lower)) {
    requiresWestern = true;
    ["western", "frontier", "cowboy", "outlaw", "saloon"].forEach((term) => positive.add(term));
  }

  for (const subject of subjectTerms(lower)) {
    requiredSubjects.push(subject);
    subject.matches.forEach((term) => positive.add(term));
  }

  profile.keywords.forEach((term) => positive.add(term.toLowerCase()));
  profile.avoid.forEach((term) => negative.add(term.toLowerCase()));

  return {
    positive: [...positive],
    negative: [...negative],
    mustHave: profile.mustHave.map((term) => term.toLowerCase()),
    niceToHave: profile.niceToHave.map((term) => term.toLowerCase()),
    requiresTension,
    requiresWestern,
    requiredSubjects,
    referenceTitles: references,
    targetTitles: profile.targetTitles,
    discoveryMode,
    preferenceText: lower,
  };
}

function getTasteProfile(preference: string, activeServices = services): Promise<TasteProfile> {
  if (!preference) {
    return Promise.resolve(fallbackTasteProfile(""));
  }

  const serviceKey = activeServices.map((service) => service.id).join(",");

  return unstable_cache(
    () => getTasteProfileUncached(preference, activeServices),
    [PROFILE_CACHE_VERSION, slug(preference), serviceKey],
    {
      revalidate: PROFILE_CACHE_SECONDS,
      tags: [`profile-${slug(preference)}-${serviceKey}`],
    },
  )();
}

async function getTasteProfileUncached(preference: string, activeServices = services): Promise<TasteProfile> {
  const groqKey = process.env.GROQ_API;

  if (!groqKey) {
    return fallbackTasteProfile(preference);
  }

  try {
    const response = await fetch(GROQ_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SMART_MODEL,
        temperature: 0,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Convert a natural language streaming request into a taste profile for a streaming recommendation engine. Think like a high-intelligence film/TV recommender first: produce the same kind of answer you would give a person who asks for the best 20 on specific platforms, then produce signals the app can verify against streaming catalogs. Infer from reference titles using general cultural knowledge. Return JSON only: {\"summary\":\"...\",\"referenceTitles\":[...],\"targetTitles\":[...],\"keywords\":[...],\"mustHave\":[...],\"niceToHave\":[...],\"avoid\":[...],\"discoveryMode\":true}. targetTitles are the 15-24 best real titles for the request and selectedPlatforms, ordered best-first; avoid referenceTitles. Prefer titles likely available on selectedPlatforms in the United States when you know that. keywords are short Streaming Availability search terms, max 8. mustHave/niceToHave/avoid are lowercase evidence terms likely to appear in title, genres, or overview. For 'like X' prompts, include inferred themes, tone, genre, subject matter, and adjacent discovery terms. Avoid generic words like good, best, popular, rating, show, series. Avoid over-broad categories like only crime if the prompt implies psychology, cult dynamics, antiheroes, paranoia, tech unease, or prestige drama. Avoid flooding with generic true-crime documentaries unless the user explicitly asks for true crime.",
          },
          {
            role: "user",
            content: JSON.stringify({
              request: preference,
              selectedPlatforms: activeServices.map((service) => service.name),
              country: "United States",
            }),
          },
        ],
      }),
      next: {
        revalidate: PROFILE_CACHE_SECONDS,
        tags: [`groq-profile-${slug(preference)}`],
      },
    });

    if (!response.ok) {
      return fallbackTasteProfile(preference);
    }

    const payload = (await response.json()) as GroqResponse;
    const content = payload.choices?.[0]?.message?.content ?? "";
    return normalizeTasteProfile(JSON.parse(content) as Partial<TasteProfile>, preference);
  } catch {
    return fallbackTasteProfile(preference);
  }
}

function normalizeTasteProfile(profile: Partial<TasteProfile>, preference: string): TasteProfile {
  const fallback = fallbackTasteProfile(preference);

  return {
    summary: cleanListText(profile.summary).slice(0, 120) || fallback.summary,
    referenceTitles: cleanList(profile.referenceTitles, 5, 50, fallback.referenceTitles),
    targetTitles: cleanList(profile.targetTitles, 20, 70, fallback.targetTitles),
    keywords: cleanList(profile.keywords, 8, 32, fallback.keywords),
    mustHave: cleanList(profile.mustHave, 10, 32, fallback.mustHave),
    niceToHave: cleanList(profile.niceToHave, 12, 32, fallback.niceToHave),
    avoid: cleanList(profile.avoid, 10, 32, fallback.avoid),
    discoveryMode: typeof profile.discoveryMode === "boolean" ? profile.discoveryMode : fallback.discoveryMode,
  };
}

function fallbackTasteProfile(preference: string): TasteProfile {
  const lower = preference.toLowerCase();
  const references = referenceTitles(preference);
  const keywords = new Set(preferenceKeywords(preference));
  const mustHave = new Set<string>();
  const niceToHave = new Set<string>();
  const avoid = new Set<string>();

  if (references.length > 0 || wantsDiscovery(preference)) {
    ["crime", "thriller", "mystery", "conspiracy"].forEach((term) => keywords.add(term));
    ["crime", "mystery"].forEach((term) => mustHave.add(term));
    ["dark", "conspiracy", "psychological", "cult", "drug", "cartel", "technology", "surveillance"].forEach((term) =>
      niceToHave.add(term),
    );
    ["romance", "sitcom", "medical", "workplace comedy", "fantasy adventure"].forEach((term) => avoid.add(term));
  }

  if (/\bdocuseries|documentary|cult|commune|sect|true crime\b/.test(lower)) {
    ["documentary", "cult", "true crime"].forEach((term) => keywords.add(term));
    ["cult", "documentary"].forEach((term) => niceToHave.add(term));
  }

  if (/\bai|android|robot|technology|tech|surveillance|cassandra\b/.test(lower)) {
    ["science fiction", "technology", "thriller"].forEach((term) => keywords.add(term));
    ["technology", "surveillance", "android", "science fiction"].forEach((term) => niceToHave.add(term));
  }

  return {
    summary: references.length > 0 ? `Similar to ${references.join(", ")}` : preference.slice(0, 120),
    referenceTitles: references,
    targetTitles: [],
    keywords: [...keywords].slice(0, 8),
    mustHave: [...mustHave].slice(0, 10),
    niceToHave: [...niceToHave].slice(0, 12),
    avoid: [...avoid].slice(0, 10),
    discoveryMode: wantsDiscovery(preference) || references.length > 0,
  };
}

function cleanList(value: unknown, limit: number, maxLength: number, fallback: string[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const cleaned = value.flatMap((item) => {
    if (typeof item !== "string") {
      return [];
    }

    const text = cleanListText(item).slice(0, maxLength);
    return text.length >= 2 ? [text.toLowerCase()] : [];
  });

  return [...new Set(cleaned)].slice(0, limit);
}

function cleanListText(value: unknown) {
  return typeof value === "string"
    ? value
        .replace(/["'`]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

function hasGenericTasteMismatch(text: string, lowerPreference: string) {
  const hasDarkSignal = hasTasteSignal(text);

  if (hasDarkSignal) {
    return false;
  }

  const requestedLightLane =
    /\b(comedy|funny|sitcom|romance|romantic|medical|doctor|hospital|fantasy|dragon|period|historical|adventure|family)\b/.test(
      lowerPreference,
    );

  if (requestedLightLane) {
    return false;
  }

  return /\b(comedy|sitcom|romance|romantic|medical|hospital|doctor|fantasy|dragon|period drama|family drama|workplace|adventure|historical adventure)\b/.test(
    text,
  );
}

function hasTasteSignal(text: string) {
  return /\b(crime|criminal|thriller|mystery|murder|killer|detective|investigation|conspiracy|cult|dark|drug|cartel|mob|gang|psychological|paranoia|horror|science fiction|sci-fi|sci fi|ai|robot|android|dystopian|serial killer|antihero|anti-hero|unsettling|mind game|obsession|surveillance|commune|sect)\b/.test(
    text,
  );
}

function isLowSignalTrueCrimeDoc(item: Title, text: string, lowerPreference: string) {
  const explicitlyWantsDoc = /\b(documentary|docuseries|true crime|real case|real story)\b/.test(lowerPreference);
  const isDoc = /\b(documentary|docuseries|true-crime|true crime|interviews|testimony|investigates)\b/.test(text);
  const isGenericCase = /\b(murder case|missing person|serial killer|homicide|detectives revisit|crime documentary|docuseries)\b/.test(
    text,
  );

  return isDoc && isGenericCase && !explicitlyWantsDoc && (item.rating ?? 0) < 7.4;
}

function isProceduralMismatch(text: string, lowerPreference: string) {
  const explicitlyWantsProcedural = /\b(procedural|case of the week|police show|law and order|detective show)\b/.test(
    lowerPreference,
  );

  if (explicitlyWantsProcedural) {
    return false;
  }

  return /\b(law & order|law and order|chicago p\.?d|chicago med|chicago fire|ncis|csi|special victims unit|team of detectives|case of the week)\b/.test(
    text,
  );
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

  if (/\bcrime|criminal|cartel|drug|kingpin|antihero|anti-hero|murder|killer|detective|investigation\b/.test(
    lower,
  )) {
    keywords.add("crime");
  }

  if (/\bdocuseries|documentary|true crime|cult leader|commune|sect\b/.test(lower)) {
    keywords.add("documentary");
  }

  if (/\bai|android|technology|tech|surveillance|robot|algorithm\b/.test(lower)) {
    keywords.add("science fiction");
  }

  for (const subject of subjectTerms(lower)) {
    keywords.add(subject.keyword);
  }

  return [...keywords].slice(0, 2);
}

function referenceTitles(preference: string) {
  const matches = [
    ...preference.matchAll(
      /\b(?:like|similar to|in the vein of|reminds me of|if i like|if i liked)\s+([^.!?]{3,120})/gi,
    ),
  ];
  const titles = new Set<string>();

  for (const match of matches) {
    const phrase = (match[1] ?? "")
      .replace(/\b(?:recommend|recs?|suggest|show me|give me|find me|movies?|films?|tv|shows?|series|you think|i would|i'd|id|like|love|enjoy|please)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    for (const part of phrase.split(/\s*(?:,|;|\/|\band\b|\bor\b)\s*/i)) {
      const cleaned = part
        .replace(/\b(?:on|from|with|that|are|is|was|were|but|not|more|less|good|great|best|top)\b/gi, " ")
        .replace(/["'`]/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (cleaned.length >= 3 && cleaned.length <= 50) {
        titles.add(cleaned.toLowerCase());
      }
    }
  }

  return [...titles].slice(0, 5);
}

function normalizeComparableTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wantsDiscovery(preference: string) {
  return /\b(recommend|you think i'd like|you think id like|surprise me|hidden gems?|underrated|overlooked|less mainstream|not mainstream|cult|deep cut|deep cuts|under the radar|not obvious|less obvious)\b/i.test(
    preference,
  );
}

function subjectTerms(lowerPreference: string) {
  const terms: Array<{ keyword: string; reason: string; matches: string[] }> = [];
  const explicit = extractExplicitSubject(lowerPreference);

  if (explicit) {
    terms.push(subjectFromPhrase(explicit));
  }

  if (/\bdogs?|canine|pupp(y|ies)\b/.test(lowerPreference)) {
    terms.push({
      keyword: "dog",
      reason: "dog focus",
      matches: ["dog", "dogs", "canine", "puppy", "puppies"],
    });
  }

  return dedupeSubjects(terms);
}

function extractExplicitSubject(lowerPreference: string) {
  const match = lowerPreference.match(/\b(?:about|featuring|with|centered on|focused on)\s+([a-z0-9 -]{3,40})/);

  if (!match?.[1]) {
    return "";
  }

  return match[1]
    .replace(/\b(tv|shows?|series|movies?|films?|that|are|is|and|or|but|like|similar|good|best|top)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function subjectFromPhrase(phrase: string) {
  const keyword = singularize(phrase.split(" ")[0] ?? phrase);

  return {
    keyword,
    reason: `${keyword} focus`,
    matches: [keyword, `${keyword}s`],
  };
}

function dedupeSubjects(subjects: Array<{ keyword: string; reason: string; matches: string[] }>) {
  const seen = new Set<string>();

  return subjects.filter((subject) => {
    if (!subject.keyword || seen.has(subject.keyword)) {
      return false;
    }
    seen.add(subject.keyword);
    return true;
  });
}

function singularize(value: string) {
  return value.endsWith("s") && value.length > 3 ? value.slice(0, -1) : value;
}

async function getServiceCandidates(
  service: (typeof services)[number],
  showType: ShowType,
  sort: SortKey,
  genre: GenreKey,
  keyword: string,
  preference: string,
  profile: TasteProfile,
  apiKey: string,
) {
  if (!preference) {
    return getServiceWithFallback(service, showType, sort, genre, keyword, apiKey);
  }

  const pools = candidatePools(sort, genre, keyword, preference, profile);
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

  const mergedItems = [...merged.values()];
  const subjectMatches = mergedItems.filter((item) => subjectScore(item, preference));

  return {
    ...base,
    items: subjectMatches.length > 0 ? subjectMatches : mergedItems,
  };
}

function candidatePools(
  sort: SortKey,
  genre: GenreKey,
  keyword: string,
  preference: string,
  profile: TasteProfile,
) {
  const pools: Array<{ sort: SortKey; genre: GenreKey; keyword: string }> = [
    { sort, genre, keyword },
    { sort, genre, keyword: "" },
  ];
  const references = profile.referenceTitles.length > 0 ? profile.referenceTitles : referenceTitles(preference);

  if (references.length > 0 || profile.discoveryMode || wantsDiscovery(preference)) {
    pools.push({ sort: "popularity_alltime", genre, keyword: "" });
  }

  const candidateKeywords = [...profile.keywords, ...preferenceKeywords(preference)];

  for (const targetTitle of profile.targetTitles.slice(0, 16)) {
    pools.push({ sort: "popularity_alltime", genre: "all", keyword: targetTitle });
  }

  for (const candidateKeyword of [...new Set(candidateKeywords)].slice(0, 4)) {
    pools.push({ sort, genre: "all", keyword: candidateKeyword });
    if (references.length > 0 || profile.discoveryMode) {
      pools.push({ sort: "popularity_alltime", genre: "all", keyword: candidateKeyword });
    }
  }

  return dedupePools(pools).slice(0, 18);
}

function windowRankWeight(sort: SortKey, terms: ReturnType<typeof rankTerms>) {
  if (terms.referenceTitles.length > 0 || terms.discoveryMode) {
    return sort === "popularity_alltime" ? 0.45 : 0.7;
  }

  if (sort === "popularity_1week") {
    return 3.4;
  }

  if (sort === "popularity_1month") {
    return 2.8;
  }

  if (sort === "popularity_1year") {
    return 2.2;
  }

  return 1.6;
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
    [DISCOVER_CACHE_VERSION, COUNTRY, service.id, showType, sort, genre, keyword || "any-keyword"],
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
    items: (payload.shows ?? []).slice(0, 40).map((show) => normalizeTitle(show, service.id)),
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

function normalizeServices(value: string | null): ServiceId[] {
  const selected = (value ?? "")
    .split(",")
    .filter((service): service is ServiceId => serviceIds.includes(service as ServiceId));

  return selected.length > 0 ? selected : [...serviceIds];
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
  return NextResponse.json(sanitizeDiscoverResponse(payload), {
    headers: {
      "Cache-Control": `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 2}`,
    },
  });
}

function sanitizeDiscoverResponse(payload: DiscoverResponse): DiscoverResponse {
  return {
    ...payload,
    services: payload.services.map((service) => ({
      ...service,
      items: service.items.map((item) => ({
        ...item,
        genres: normalizeGenres(item.genres),
        matchReason: typeof item.matchReason === "string" ? item.matchReason : "",
      })),
    })),
  };
}
