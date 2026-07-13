import { afterEach, describe, expect, it, vi } from "vitest";
import { AniListCatalog, TmdbCatalog } from "../src/catalog.js";

afterEach(() => vi.restoreAllMocks());

describe("catalog adapters", () => {
  it("maps TMDB TV results without treating them as movies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{ id: 1399, name: "Game of Thrones", original_name: "Game of Thrones", first_air_date: "2011-04-17", overview: "Seven kingdoms", poster_path: "/poster.jpg" }] }), { status: 200 })));
    const results = await new TmdbCatalog("token").search("game", "series");
    expect(results[0]).toMatchObject({ provider: "tmdb", externalId: "1399", type: "series", releaseYear: "2011" });
  });

  it("maps AniList English and native anime titles", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { Page: { media: [{ id: 1, title: { english: "Cowboy Bebop", romaji: "Cowboy Bebop", native: "カウボーイビバップ" }, description: "Bounty hunters", seasonYear: 1998, coverImage: { large: "cover.jpg" } }] } } }), { status: 200 })));
    const results = await new AniListCatalog().search("bebop", "anime");
    expect(results[0]).toMatchObject({ provider: "anilist", externalId: "1", type: "anime", title: "Cowboy Bebop", releaseYear: "1998" });
  });

  it("returns only mapped Brazilian subscription providers with safe title links", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: { BR: {
      flatrate: [
        { provider_id: 8, provider_name: "Netflix", logo_path: "/netflix.jpg" },
        { provider_id: 999, provider_name: "Unknown Service" },
      ],
      rent: [{ provider_id: 2, provider_name: "Apple TV" }],
    } } }), { status: 200 })));
    const result = await new TmdbCatalog("token").streaming({ provider: "tmdb", externalId: "550", type: "movie", title: "Fight Club & Friends" });
    expect(result.region).toBe("BR");
    expect(result.providers).toEqual([{ name: "Netflix", logoUrl: "https://image.tmdb.org/t/p/w92/netflix.jpg", url: "https://www.netflix.com/search?q=Fight%20Club%20%26%20Friends" }]);
  });
});
