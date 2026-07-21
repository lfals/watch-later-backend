export type WorkKind = "movie" | "series" | "anime";
export type CatalogProvider = "tmdb" | "anilist";
export type CatalogWork = {
  provider: CatalogProvider;
  externalId: string;
  type: WorkKind;
  title: string;
  originalTitle: string | null;
  releaseYear: string | null;
  synopsis: string | null;
  posterUrl: string | null;
};
export type CatalogMovie = Omit<CatalogWork, "provider" | "type"> & { provider?: CatalogProvider; type?: WorkKind };
export type StreamingOfferType = "subscription" | "rent" | "buy" | "free" | "ads";
export type StreamingProvider = { name: string; logoUrl: string | null; url: string | null; type: StreamingOfferType };
export type CatalogPerson = { name: string; role: string | null; profileUrl: string | null };
export type CatalogEpisode = {
  episodeNumber: number;
  name: string;
  overview: string | null;
  airDate: string | null;
  runtimeMinutes: number | null;
};
export type CatalogSeason = {
  seasonNumber: number;
  name: string;
  overview: string | null;
  airDate: string | null;
  episodeCount: number;
  posterUrl: string | null;
  episodes: CatalogEpisode[];
};
export type CatalogMetadata = {
  actors: CatalogPerson[];
  directors: CatalogPerson[];
  rating: number | null;
  genres: string[];
  trailerUrl: string | null;
  seasons: CatalogSeason[];
  synopsis: string | null;
};
export interface CatalogMetadataCache {
  get(work: Pick<CatalogWork, "provider" | "externalId" | "type">): Promise<CatalogMetadata | null>;
  put(work: Pick<CatalogWork, "provider" | "externalId" | "type">, metadata: CatalogMetadata): Promise<void>;
}
export type StreamingAvailability = {
  region: "BR";
  checkedAt: string;
  providers: StreamingProvider[];
  actors?: CatalogPerson[];
  directors?: CatalogPerson[];
  rating?: number | null;
  genres?: string[];
  trailerUrl?: string | null;
  seasons?: CatalogSeason[];
  synopsis?: string | null;
};

export interface Catalog {
  search(query: string, type: WorkKind): Promise<CatalogWork[]>;
  searchMovies(query: string): Promise<CatalogWork[]>;
  streaming(work: Pick<CatalogWork, "provider" | "externalId" | "type" | "title">): Promise<StreamingAvailability>;
}

const streamingSearchUrl = (providerName: string, title: string): string | null => {
  const query = encodeURIComponent(title);
  const normalized = providerName.toLocaleLowerCase("en-US");
  if (normalized.includes("netflix")) return `https://www.netflix.com/search?q=${query}`;
  if (normalized.includes("amazon") || normalized.includes("prime video")) return `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${query}`;
  if (normalized.includes("disney")) return `https://www.disneyplus.com/search?q=${query}`;
  if (normalized === "max" || normalized.includes("hbo max")) return `https://www.max.com/search?q=${query}`;
  if (normalized.includes("globoplay")) return `https://globoplay.globo.com/busca/?q=${query}`;
  if (normalized.includes("apple tv")) return `https://tv.apple.com/br/search?term=${query}`;
  if (normalized.includes("paramount")) return `https://www.paramountplus.com/br/search/?q=${query}`;
  if (normalized.includes("crunchyroll")) return `https://www.crunchyroll.com/search?q=${query}`;
  if (normalized.includes("mubi")) return `https://mubi.com/pt/br/search/films?query=${query}`;
  return null;
};

export class TmdbCatalog implements Catalog {
  constructor(private readonly token: string, private readonly metadataCache?: CatalogMetadataCache) {}
  async searchMovies(query: string) { return this.search(query, "movie"); }
  async imdbId(work: Pick<CatalogWork, "externalId" | "type">): Promise<string | null> {
    if (work.type === "anime") return null;
    const endpoint = work.type === "movie" ? "movie" : "tv";
    const response = await fetch(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(work.externalId)}/external_ids`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
    const body = await response.json() as { imdb_id?: string | null };
    return typeof body.imdb_id === "string" && /^tt\d+$/.test(body.imdb_id) ? body.imdb_id : null;
  }
  async search(query: string, type: WorkKind): Promise<CatalogWork[]> {
    if (type === "anime") return [];
    const startedAt = performance.now();
    logEvent("catalog.search_started", { provider: "tmdb", workType: type, queryLength: query.length });
    const endpoint = type === "movie" ? "movie" : "tv";
    const url = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
    url.searchParams.set("query", query); url.searchParams.set("language", "pt-BR"); url.searchParams.set("include_adult", "true");
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
      if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
      const body = await response.json() as { results: Array<Record<string, unknown>> };
      const results: CatalogWork[] = body.results.slice(0, 20).map((item) => ({
      provider: "tmdb", externalId: String(item.id), type,
      title: String(item.title ?? item.name), originalTitle: item.original_title || item.original_name ? String(item.original_title ?? item.original_name) : null,
      releaseYear: typeof (item.release_date ?? item.first_air_date) === "string" ? String(item.release_date ?? item.first_air_date).slice(0, 4) || null : null,
      synopsis: item.overview ? String(item.overview) : null,
      posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
      }));
      logEvent("catalog.search_completed", { provider: "tmdb", workType: type, resultCount: results.length, status: response.status, durationMs: Math.round(performance.now() - startedAt) });
      return results;
    } catch (error) {
      logError("catalog.search_failed", error, { provider: "tmdb", workType: type, durationMs: Math.round(performance.now() - startedAt) });
      throw error;
    }
  }

  async streaming(work: Pick<CatalogWork, "provider" | "externalId" | "type" | "title">): Promise<StreamingAvailability> {
    if (work.provider !== "tmdb" || work.type === "anime") return {
      region: "BR", checkedAt: new Date().toISOString(), providers: [], actors: [], directors: [], rating: null, genres: [], trailerUrl: null, seasons: [], synopsis: null,
    };
    const startedAt = performance.now();
    logEvent("catalog.streaming_started", { provider: "tmdb", workType: work.type });
    const endpoint = work.type === "movie" ? "movie" : "tv";
    try {
      const headers = { Authorization: `Bearer ${this.token}` };
      const baseUrl = `https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(work.externalId)}`;
      const cachedMetadata = await this.metadataCache?.get(work) ?? null;
      logEvent(cachedMetadata ? "catalog.metadata_cache_hit" : "catalog.metadata_cache_miss", {
        provider: "tmdb", workType: work.type,
      });
      const metadataRequest = cachedMetadata
        ? Promise.resolve(cachedMetadata)
        : this.fetchMetadata(baseUrl, headers, work.type).then(async (metadata) => {
          await this.metadataCache?.put(work, metadata);
          return metadata;
        });
      const [metadata, providersResponse] = await Promise.all([
        metadataRequest,
        fetch(`${baseUrl}/watch/providers`, { headers }),
      ]);
      if (!providersResponse.ok) throw new Error(`TMDB request failed: ${providersResponse.status}`);
      type TmdbProvider = { provider_id: number; provider_name: string; logo_path?: string };
      const body = await providersResponse.json() as { results?: { BR?: {
        link?: string;
        flatrate?: TmdbProvider[];
        rent?: TmdbProvider[];
        buy?: TmdbProvider[];
        free?: TmdbProvider[];
        ads?: TmdbProvider[];
      } } };
      const availability = body.results?.BR;
      const fallbackUrl = (() => {
        try {
          const url = new URL(availability?.link ?? "");
          return url.protocol === "https:" ? url.toString() : null;
        } catch {
          return null;
        }
      })();
      const groups: Array<[StreamingOfferType, TmdbProvider[]]> = [
        ["subscription", availability?.flatrate ?? []],
        ["rent", availability?.rent ?? []],
        ["buy", availability?.buy ?? []],
        ["free", availability?.free ?? []],
        ["ads", availability?.ads ?? []],
      ];
      const seen = new Set<string>();
      const providers = groups.flatMap(([type, items]) => items.flatMap((item) => {
        const key = `${type}:${item.provider_id}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{
          name: item.provider_name,
          logoUrl: item.logo_path ? `https://image.tmdb.org/t/p/w92${item.logo_path}` : null,
          url: streamingSearchUrl(item.provider_name, work.title) ?? fallbackUrl,
          type,
        }];
      }));
      logEvent("catalog.streaming_completed", { provider: "tmdb", workType: work.type, resultCount: providers.length, status: providersResponse.status, durationMs: Math.round(performance.now() - startedAt) });
      return { region: "BR", checkedAt: new Date().toISOString(), providers, ...metadata };
    } catch (error) {
      logError("catalog.streaming_failed", error, { provider: "tmdb", workType: work.type, durationMs: Math.round(performance.now() - startedAt) });
      throw error;
    }
  }

  private async fetchMetadata(
    baseUrl: string,
    headers: { Authorization: string },
    workType: WorkKind,
  ): Promise<CatalogMetadata> {
    const response = await fetch(`${baseUrl}?language=pt-BR&append_to_response=credits%2Cvideos&include_video_language=pt-BR%2Cpt%2Cen%2Cnull`, { headers });
    if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
    const metadata = await response.json() as {
      vote_average?: number;
      genres?: Array<{ name: string }>;
      credits?: {
        cast?: Array<{ name: string; character?: string; profile_path?: string; order?: number }>;
        crew?: Array<{ name: string; job?: string; profile_path?: string }>;
      };
      videos?: { results?: Array<{
        key?: string;
        site?: string;
        type?: string;
        official?: boolean;
        published_at?: string;
      }> };
      seasons?: Array<{
        season_number?: number;
        name?: string;
        overview?: string;
        air_date?: string;
        episode_count?: number;
        poster_path?: string;
      }>;
      overview?: string;
    };
    const trailer = (metadata.videos?.results ?? [])
      .filter((video) => video.site === "YouTube" && video.type === "Trailer" && /^[A-Za-z0-9_-]+$/.test(video.key ?? ""))
      .toSorted((left, right) => {
        if (left.official !== right.official) return left.official ? -1 : 1;
        return (right.published_at ?? "").localeCompare(left.published_at ?? "");
      })[0];
    const seasonSummaries = (metadata.seasons ?? [])
      .filter((season) => typeof season.season_number === "number")
      .toSorted((left, right) => left.season_number! - right.season_number!);
    const seasons: CatalogSeason[] = workType === "series"
      ? await Promise.all(seasonSummaries.map(async (season) => {
        const seasonNumber = season.season_number!;
        const seasonResponse = await fetch(
          `${baseUrl}/season/${seasonNumber}?language=pt-BR`,
          { headers },
        );
        if (!seasonResponse.ok) throw new Error(`TMDB request failed: ${seasonResponse.status}`);
        const seasonDetails = await seasonResponse.json() as {
          episodes?: Array<{
            episode_number?: number;
            name?: string;
            overview?: string;
            air_date?: string;
            runtime?: number;
          }>;
        };
        const episodes = (seasonDetails.episodes ?? [])
          .filter((episode) => typeof episode.episode_number === "number")
          .toSorted((left, right) => left.episode_number! - right.episode_number!)
          .map((episode) => ({
            episodeNumber: episode.episode_number!,
            name: episode.name?.trim() || `Episódio ${episode.episode_number}`,
            overview: episode.overview?.trim() || null,
            airDate: episode.air_date?.trim() || null,
            runtimeMinutes: typeof episode.runtime === "number" && episode.runtime > 0
              ? episode.runtime
              : null,
          }));
        return {
          seasonNumber,
          name: season.name?.trim() || (seasonNumber === 0 ? "Especiais" : `Temporada ${seasonNumber}`),
          overview: season.overview?.trim() || null,
          airDate: season.air_date?.trim() || null,
          episodeCount: episodes.length || season.episode_count || 0,
          posterUrl: season.poster_path ? `https://image.tmdb.org/t/p/w300${season.poster_path}` : null,
          episodes,
        };
      }))
      : [];
    return {
      actors: (metadata.credits?.cast ?? [])
        .toSorted((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER))
        .slice(0, 10)
        .map((actor) => ({
          name: actor.name,
          role: actor.character?.trim() || null,
          profileUrl: actor.profile_path ? `https://image.tmdb.org/t/p/w185${actor.profile_path}` : null,
        })),
      directors: (metadata.credits?.crew ?? [])
        .filter((person) => person.job === "Director")
        .map((director) => ({
          name: director.name,
          role: "Direção",
          profileUrl: director.profile_path ? `https://image.tmdb.org/t/p/w185${director.profile_path}` : null,
        })),
      rating: typeof metadata.vote_average === "number" && metadata.vote_average > 0
        ? Math.round(metadata.vote_average * 10) / 10
        : null,
      genres: (metadata.genres ?? []).map((genre) => genre.name),
      trailerUrl: trailer?.key ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
      seasons,
      synopsis: metadata.overview?.trim() || null,
    };
  }
}

export class AniListCatalog implements Catalog {
  async searchMovies() { return []; }
  async streaming(): Promise<StreamingAvailability> {
    return { region: "BR", checkedAt: new Date().toISOString(), providers: [], actors: [], directors: [], rating: null, genres: [], trailerUrl: null, seasons: [], synopsis: null };
  }
  async search(query: string, type: WorkKind): Promise<CatalogWork[]> {
    if (type !== "anime") return [];
    const startedAt = performance.now();
    logEvent("catalog.search_started", { provider: "anilist", workType: type, queryLength: query.length });
    const graphql = `query ($search: String!) { Page(perPage: 20) { media(search: $search, type: ANIME) { id title { english romaji native } description(asHtml: false) seasonYear coverImage { large } } } }`;
    try {
      const response = await fetch("https://graphql.anilist.co", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query: graphql, variables: { search: query } }) });
      if (!response.ok) throw new Error(`AniList request failed: ${response.status}`);
      const body = await response.json() as { data: { Page: { media: Array<{ id: number; title: { english?: string; romaji?: string; native?: string }; description?: string; seasonYear?: number; coverImage?: { large?: string } }> } } };
      const results: CatalogWork[] = body.data.Page.media.map((item) => ({ provider: "anilist", externalId: String(item.id), type: "anime",
        title: item.title.english ?? item.title.romaji ?? item.title.native ?? "Untitled", originalTitle: item.title.native ?? item.title.romaji ?? null,
        releaseYear: item.seasonYear?.toString() ?? null, synopsis: item.description ?? null, posterUrl: item.coverImage?.large ?? null }));
      logEvent("catalog.search_completed", { provider: "anilist", workType: type, resultCount: results.length, status: response.status, durationMs: Math.round(performance.now() - startedAt) });
      return results;
    } catch (error) {
      logError("catalog.search_failed", error, { provider: "anilist", workType: type, durationMs: Math.round(performance.now() - startedAt) });
      throw error;
    }
  }
}

export class CompositeCatalog implements Catalog {
  constructor(private readonly tmdb: Catalog, private readonly anilist: Catalog) {}
  searchMovies(query: string) { return this.tmdb.search(query, "movie"); }
  search(query: string, type: WorkKind) { return type === "anime" ? this.anilist.search(query, type) : this.tmdb.search(query, type); }
  streaming(work: Pick<CatalogWork, "provider" | "externalId" | "type" | "title">) {
    return work.provider === "tmdb" ? this.tmdb.streaming(work) : this.anilist.streaming(work);
  }
}
import { logError, logEvent } from "./logger.js";
