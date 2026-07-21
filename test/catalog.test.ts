import { afterEach, describe, expect, it, vi } from "vitest";
import { AniListCatalog, TmdbCatalog, type CatalogMetadata } from "../src/catalog.js";

afterEach(() => vi.restoreAllMocks());

describe("catalog adapters", () => {
  it("resolves the IMDb id used by Stremio from TMDB", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ imdb_id: "tt0137523" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new TmdbCatalog("token").imdbId({ externalId: "550", type: "movie" })).resolves.toBe("tt0137523");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/movie/550/external_ids");
  });

  it("maps TMDB TV results without treating them as movies", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ results: [{ id: 1399, name: "Game of Thrones", original_name: "Game of Thrones", first_air_date: "2011-04-17", overview: "Sete reinos disputam o poder.", poster_path: "/poster.jpg" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const results = await new TmdbCatalog("token").search("game", "series");
    expect(results[0]).toMatchObject({ provider: "tmdb", externalId: "1399", type: "series", releaseYear: "2011", synopsis: "Sete reinos disputam o poder." });
    expect(String(fetchMock.mock.calls[0][0])).toContain("language=pt-BR");
  });

  it("maps AniList English and native anime titles", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { Page: { media: [{ id: 1, title: { english: "Cowboy Bebop", romaji: "Cowboy Bebop", native: "カウボーイビバップ" }, description: "Bounty hunters", seasonYear: 1998, coverImage: { large: "cover.jpg" } }] } } }), { status: 200 })));
    const results = await new AniListCatalog().search("bebop", "anime");
    expect(results[0]).toMatchObject({ provider: "anilist", externalId: "1", type: "anime", title: "Cowboy Bebop", releaseYear: "1998" });
  });

  it("shares cached metadata while refreshing Brazilian streaming providers", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("watch/providers")) return new Response(JSON.stringify({ results: { BR: {
        link: "https://www.themoviedb.org/movie/550/watch?locale=BR",
        flatrate: [
          { provider_id: 8, provider_name: "Netflix", logo_path: "/netflix.jpg" },
          { provider_id: 999, provider_name: "Unknown Service" },
        ],
        rent: [{ provider_id: 2, provider_name: "Apple TV" }],
        buy: [{ provider_id: 2, provider_name: "Apple TV" }],
        free: [{ provider_id: 307, provider_name: "Plex", logo_path: "/plex.jpg" }],
        ads: [{ provider_id: 73, provider_name: "Tubi", logo_path: "/tubi.jpg" }],
      } } }), { status: 200 });
      return new Response(JSON.stringify({
        vote_average: 8.432,
        overview: "Um homem insatisfeito conhece o misterioso Tyler Durden.",
        genres: [{ name: "Drama" }, { name: "Thriller" }],
        credits: {
          cast: [
            { name: "Edward Norton", character: "Narrator", profile_path: "/edward.jpg", order: 1 },
            { name: "Brad Pitt", character: "Tyler Durden", profile_path: "/brad.jpg", order: 0 },
          ],
          crew: [{ name: "David Fincher", job: "Director", profile_path: "/fincher.jpg" }],
        },
        videos: { results: [
          { key: "unofficial-old", site: "YouTube", type: "Trailer", official: false, published_at: "2025-01-01" },
          { key: "official-trailer", site: "YouTube", type: "Trailer", official: true, published_at: "2024-01-01" },
          { key: "featurette", site: "YouTube", type: "Featurette", official: true },
        ] },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    let cached: CatalogMetadata | null = null;
    const sharedCache = {
      get: async () => cached,
      put: async (_work: unknown, metadata: CatalogMetadata) => { cached = metadata; },
    };
    const work = { provider: "tmdb" as const, externalId: "550", type: "movie" as const, title: "Fight Club & Friends" };
    const result = await new TmdbCatalog("token", sharedCache).streaming(work);
    await new TmdbCatalog("token", sharedCache).streaming(work);

    expect(result.region).toBe("BR");
    expect(result.rating).toBe(8.4);
    expect(result.genres).toEqual(["Drama", "Thriller"]);
    expect(result.actors).toEqual([
      { name: "Brad Pitt", role: "Tyler Durden", profileUrl: "https://image.tmdb.org/t/p/w185/brad.jpg" },
      { name: "Edward Norton", role: "Narrator", profileUrl: "https://image.tmdb.org/t/p/w185/edward.jpg" },
    ]);
    expect(result.directors).toEqual([
      { name: "David Fincher", role: "Direção", profileUrl: "https://image.tmdb.org/t/p/w185/fincher.jpg" },
    ]);
    expect(result.trailerUrl).toBe("https://www.youtube.com/watch?v=official-trailer");
    expect(result.synopsis).toBe("Um homem insatisfeito conhece o misterioso Tyler Durden.");
    expect(result.providers).toEqual([
      { name: "Netflix", logoUrl: "https://image.tmdb.org/t/p/w92/netflix.jpg", url: "https://www.netflix.com/search?q=Fight%20Club%20%26%20Friends", type: "subscription" },
      { name: "Unknown Service", logoUrl: null, url: "https://www.themoviedb.org/movie/550/watch?locale=BR", type: "subscription" },
      { name: "Apple TV", logoUrl: null, url: "https://tv.apple.com/br/search?term=Fight%20Club%20%26%20Friends", type: "rent" },
      { name: "Apple TV", logoUrl: null, url: "https://tv.apple.com/br/search?term=Fight%20Club%20%26%20Friends", type: "buy" },
      { name: "Plex", logoUrl: "https://image.tmdb.org/t/p/w92/plex.jpg", url: "https://www.themoviedb.org/movie/550/watch?locale=BR", type: "free" },
      { name: "Tubi", logoUrl: "https://image.tmdb.org/t/p/w92/tubi.jpg", url: "https://www.themoviedb.org/movie/550/watch?locale=BR", type: "ads" },
    ]);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("append_to_response=credits"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("watch/providers"))).toHaveLength(2);
  });

  it("loads seasons and episodes for TMDB series", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("watch/providers")) {
        return new Response(JSON.stringify({ results: {} }), { status: 200 });
      }
      if (url.includes("/season/1")) {
        return new Response(JSON.stringify({ episodes: [
          {
            episode_number: 2,
            name: "The Kingsroad",
            overview: "The royal party travels north.",
            air_date: "2011-04-24",
            runtime: 55,
          },
          {
            episode_number: 1,
            name: "Winter Is Coming",
            overview: "The story begins.",
            air_date: "2011-04-17",
            runtime: 62,
          },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        vote_average: 8.5,
        overview: "Nove famílias disputam o controle dos Sete Reinos.",
        seasons: [{
          season_number: 1,
          name: "Temporada 1",
          overview: "The first season.",
          air_date: "2011-04-17",
          episode_count: 2,
          poster_path: "/season-1.jpg",
        }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new TmdbCatalog("token").streaming({
      provider: "tmdb",
      externalId: "1399",
      type: "series",
      title: "Game of Thrones",
    });

    expect(result.seasons).toEqual([{
      seasonNumber: 1,
      name: "Temporada 1",
      overview: "The first season.",
      airDate: "2011-04-17",
      episodeCount: 2,
      posterUrl: "https://image.tmdb.org/t/p/w300/season-1.jpg",
      episodes: [
        {
          episodeNumber: 1,
          name: "Winter Is Coming",
          overview: "The story begins.",
          airDate: "2011-04-17",
          runtimeMinutes: 62,
        },
        {
          episodeNumber: 2,
          name: "The Kingsroad",
          overview: "The royal party travels north.",
          airDate: "2011-04-24",
          runtimeMinutes: 55,
        },
      ],
    }]);
  });
});
