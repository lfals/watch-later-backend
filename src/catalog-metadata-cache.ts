import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { CatalogMetadata, CatalogMetadataCache, CatalogWork } from "./catalog.js";
import { catalogMetadataCache } from "./db/schema.js";

type CacheKey = Pick<CatalogWork, "provider" | "externalId" | "type">;

export class DrizzleCatalogMetadataCache implements CatalogMetadataCache {
  constructor(private readonly db: NodePgDatabase) {}

  async get(work: CacheKey): Promise<CatalogMetadata | null> {
    const [cached] = await this.db.select({
      actors: catalogMetadataCache.actors,
      directors: catalogMetadataCache.directors,
      rating: catalogMetadataCache.rating,
      genres: catalogMetadataCache.genres,
      trailerUrl: catalogMetadataCache.trailerUrl,
      seasons: catalogMetadataCache.seasons,
      synopsis: catalogMetadataCache.synopsis,
    }).from(catalogMetadataCache).where(and(
      eq(catalogMetadataCache.provider, work.provider),
      eq(catalogMetadataCache.externalId, work.externalId),
      eq(catalogMetadataCache.type, work.type),
      eq(catalogMetadataCache.metadataVersion, 5),
    ));
    if (!cached) return null;
    const normalizePeople = (people: unknown[]) => people.map((person) => typeof person === "string"
      ? { name: person, role: null, profileUrl: null }
      : person as CatalogMetadata["actors"][number]);
    return {
      ...cached,
      actors: normalizePeople(cached.actors),
      directors: normalizePeople(cached.directors),
    };
  }

  async put(work: CacheKey, metadata: CatalogMetadata): Promise<void> {
    await this.db.insert(catalogMetadataCache).values({ ...work, ...metadata, metadataVersion: 5 }).onConflictDoUpdate({
      target: [catalogMetadataCache.provider, catalogMetadataCache.externalId, catalogMetadataCache.type],
      set: { ...metadata, metadataVersion: 5, updatedAt: new Date() },
    });
  }
}
