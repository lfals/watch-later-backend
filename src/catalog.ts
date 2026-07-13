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
export type StreamingProvider = { name: string; logoUrl: string | null; url: string };
export type StreamingAvailability = { region: "BR"; checkedAt: string; providers: StreamingProvider[] };

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
  constructor(private readonly token: string) {}
  async searchMovies(query: string) { return this.search(query, "movie"); }
  async search(query: string, type: WorkKind): Promise<CatalogWork[]> {
    if (type === "anime") return [];
    const endpoint = type === "movie" ? "movie" : "tv";
    const url = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
    url.searchParams.set("query", query); url.searchParams.set("language", "en-US"); url.searchParams.set("include_adult", "true");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
    const body = await response.json() as { results: Array<Record<string, unknown>> };
    return body.results.slice(0, 20).map((item) => ({
      provider: "tmdb", externalId: String(item.id), type,
      title: String(item.title ?? item.name), originalTitle: item.original_title || item.original_name ? String(item.original_title ?? item.original_name) : null,
      releaseYear: typeof (item.release_date ?? item.first_air_date) === "string" ? String(item.release_date ?? item.first_air_date).slice(0, 4) || null : null,
      synopsis: item.overview ? String(item.overview) : null,
      posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
    }));
  }

  async streaming(work: Pick<CatalogWork, "provider" | "externalId" | "type" | "title">): Promise<StreamingAvailability> {
    if (work.provider !== "tmdb" || work.type === "anime") return { region: "BR", checkedAt: new Date().toISOString(), providers: [] };
    const endpoint = work.type === "movie" ? "movie" : "tv";
    const response = await fetch(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(work.externalId)}/watch/providers`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
    const body = await response.json() as { results?: { BR?: { flatrate?: Array<{ provider_id: number; provider_name: string; logo_path?: string }> } } };
    const seen = new Set<number>();
    const providers = (body.results?.BR?.flatrate ?? []).flatMap((item) => {
      const url = streamingSearchUrl(item.provider_name, work.title);
      if (!url || seen.has(item.provider_id)) return [];
      seen.add(item.provider_id);
      return [{ name: item.provider_name, logoUrl: item.logo_path ? `https://image.tmdb.org/t/p/w92${item.logo_path}` : null, url }];
    });
    return { region: "BR", checkedAt: new Date().toISOString(), providers };
  }
}

export class AniListCatalog implements Catalog {
  async searchMovies() { return []; }
  async streaming(): Promise<StreamingAvailability> { return { region: "BR", checkedAt: new Date().toISOString(), providers: [] }; }
  async search(query: string, type: WorkKind): Promise<CatalogWork[]> {
    if (type !== "anime") return [];
    const graphql = `query ($search: String!) { Page(perPage: 20) { media(search: $search, type: ANIME) { id title { english romaji native } description(asHtml: false) seasonYear coverImage { large } } } }`;
    const response = await fetch("https://graphql.anilist.co", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query: graphql, variables: { search: query } }) });
    if (!response.ok) throw new Error(`AniList request failed: ${response.status}`);
    const body = await response.json() as { data: { Page: { media: Array<{ id: number; title: { english?: string; romaji?: string; native?: string }; description?: string; seasonYear?: number; coverImage?: { large?: string } }> } } };
    return body.data.Page.media.map((item) => ({ provider: "anilist", externalId: String(item.id), type: "anime",
      title: item.title.english ?? item.title.romaji ?? item.title.native ?? "Untitled", originalTitle: item.title.native ?? item.title.romaji ?? null,
      releaseYear: item.seasonYear?.toString() ?? null, synopsis: item.description ?? null, posterUrl: item.coverImage?.large ?? null }));
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
