import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { externalWorkIds, stremioConnections, users, watchlistEntries, works } from "./db/schema.js";
import { logEvent, logWarn } from "./logger.js";

export type StremioWatchStatus = "want_to_watch" | "watching" | "watched";
export type StremioContentType = "movie" | "series";

export type StremioMeta = {
  id: string;
  type: StremioContentType;
  name: string;
  poster?: string;
  releaseInfo?: string;
  description?: string;
};

export type StremioAction = {
  entryId: string;
  imdbId: string;
  title: string;
  status: StremioWatchStatus;
};

export interface StremioIntegration {
  connect(clerkUserId: string, publicBaseUrl: string): Promise<{ installUrl: string; connectedAt: string }>;
  status(clerkUserId: string): Promise<{ connected: boolean; connectedAt: string | null }>;
  disconnect(clerkUserId: string): Promise<boolean>;
  isAuthorized(token: string): Promise<boolean>;
  catalog(token: string, type: StremioContentType, status: StremioWatchStatus, skip?: number): Promise<StremioMeta[] | null>;
  action(token: string, imdbId: string): Promise<StremioAction | null>;
  markWatched(token: string, imdbId: string): Promise<StremioAction | null>;
}

type ImdbIdResolver = (work: { externalId: string; type: StremioContentType }) => Promise<string | null>;

const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");

const normalizePublicBaseUrl = (value: string) => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid_public_base_url");
  return url.origin;
};

export class DrizzleStremioIntegration implements StremioIntegration {
  constructor(
    private readonly db: NodePgDatabase,
    private readonly resolveImdbId: ImdbIdResolver,
  ) {}

  private async userByClerkId(clerkUserId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
    return user ?? null;
  }

  private async userByToken(token: string) {
    const [connection] = await this.db.select({ userId: stremioConnections.userId })
      .from(stremioConnections)
      .where(eq(stremioConnections.tokenHash, tokenDigest(token)));
    return connection?.userId ?? null;
  }

  async connect(clerkUserId: string, publicBaseUrl: string) {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const user = await this.db.transaction(async (tx) => {
      await tx.insert(users).values({ clerkUserId }).onConflictDoNothing({ target: users.clerkUserId });
      const [current] = await tx.select().from(users).where(eq(users.clerkUserId, clerkUserId));
      if (!current) throw new Error("user_not_found");
      await tx.insert(stremioConnections).values({ userId: current.id, tokenHash: tokenDigest(token), createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: stremioConnections.userId, set: { tokenHash: tokenDigest(token), createdAt: now, updatedAt: now } });
      return current;
    });
    logEvent("stremio.connection_created", { userId: user.id });
    return {
      installUrl: `${normalizePublicBaseUrl(publicBaseUrl)}/stremio/${token}/manifest.json`,
      connectedAt: now.toISOString(),
    };
  }

  async status(clerkUserId: string) {
    const user = await this.userByClerkId(clerkUserId);
    if (!user) return { connected: false, connectedAt: null };
    const [connection] = await this.db.select({ createdAt: stremioConnections.createdAt })
      .from(stremioConnections).where(eq(stremioConnections.userId, user.id));
    return { connected: Boolean(connection), connectedAt: connection?.createdAt.toISOString() ?? null };
  }

  async disconnect(clerkUserId: string) {
    const user = await this.userByClerkId(clerkUserId);
    if (!user) return false;
    const removed = await this.db.delete(stremioConnections).where(eq(stremioConnections.userId, user.id)).returning({ id: stremioConnections.id });
    if (removed.length) logEvent("stremio.connection_revoked", { userId: user.id });
    return removed.length > 0;
  }

  async isAuthorized(token: string) {
    return Boolean(await this.userByToken(token));
  }

  async catalog(token: string, type: StremioContentType, status: StremioWatchStatus, skip = 0): Promise<StremioMeta[] | null> {
    const userId = await this.userByToken(token);
    if (!userId) return null;
    const entries = await this.db.select({
      entryId: watchlistEntries.id,
      workId: works.id,
      title: works.title,
      releaseYear: works.releaseYear,
      synopsis: works.synopsis,
      posterUrl: works.posterUrl,
      tmdbId: works.tmdbId,
    }).from(watchlistEntries)
      .innerJoin(works, eq(works.id, watchlistEntries.workId))
      .where(and(eq(watchlistEntries.userId, userId), eq(watchlistEntries.status, status), eq(works.type, type)))
      .orderBy(desc(watchlistEntries.createdAt))
      .limit(100)
      .offset(skip);
    if (!entries.length) return [];

    const ids = await this.db.select({ workId: externalWorkIds.workId, provider: externalWorkIds.provider, externalId: externalWorkIds.externalId })
      .from(externalWorkIds).where(inArray(externalWorkIds.workId, entries.map((entry) => entry.workId)));
    const byWork = new Map<string, Map<string, string>>();
    for (const id of ids) {
      const workIds = byWork.get(id.workId) ?? new Map<string, string>();
      workIds.set(id.provider, id.externalId);
      byWork.set(id.workId, workIds);
    }

    const metas: Array<StremioMeta | null> = [];
    for (let offset = 0; offset < entries.length; offset += 8) {
      const resolved = await Promise.all(entries.slice(offset, offset + 8).map(async (entry): Promise<StremioMeta | null> => {
        const knownIds = byWork.get(entry.workId);
        let imdbId = knownIds?.get("imdb") ?? null;
        const tmdbId = knownIds?.get("tmdb") ?? entry.tmdbId;
        if (!imdbId && tmdbId) {
          try {
            imdbId = await this.resolveImdbId({ externalId: tmdbId, type });
            if (imdbId) {
              await this.db.insert(externalWorkIds).values({ workId: entry.workId, provider: "imdb", externalId: imdbId }).onConflictDoNothing();
            }
          } catch (error) {
            logWarn("stremio.imdb_resolution_failed", { workId: entry.workId, errorType: error instanceof Error ? error.name : "unknown" });
          }
        }
        if (!imdbId) return null;
        return {
          id: imdbId,
          type,
          name: entry.title,
          ...(entry.posterUrl ? { poster: entry.posterUrl } : {}),
          ...(entry.releaseYear ? { releaseInfo: entry.releaseYear } : {}),
          ...(entry.synopsis ? { description: entry.synopsis } : {}),
        };
      }));
      metas.push(...resolved);
    }
    return metas.filter((meta): meta is StremioMeta => meta !== null);
  }

  async action(token: string, imdbId: string): Promise<StremioAction | null> {
    const userId = await this.userByToken(token);
    if (!userId) return null;
    const [item] = await this.db.select({
      entryId: watchlistEntries.id,
      imdbId: externalWorkIds.externalId,
      title: works.title,
      status: watchlistEntries.status,
    }).from(watchlistEntries)
      .innerJoin(works, eq(works.id, watchlistEntries.workId))
      .innerJoin(externalWorkIds, eq(externalWorkIds.workId, works.id))
      .where(and(
        eq(watchlistEntries.userId, userId),
        eq(externalWorkIds.provider, "imdb"),
        eq(externalWorkIds.externalId, imdbId),
        inArray(works.type, ["movie", "series"]),
      ));
    return item ?? null;
  }

  async markWatched(token: string, imdbId: string): Promise<StremioAction | null> {
    const item = await this.action(token, imdbId);
    if (!item) return null;
    if (item.status !== "watched") {
      await this.db.update(watchlistEntries).set({ status: "watched", updatedAt: new Date() })
        .where(eq(watchlistEntries.id, item.entryId));
      logEvent("stremio.watchlist_marked_watched", { entryId: item.entryId });
    }
    return { ...item, status: "watched" };
  }
}

export const stremioManifest = {
  id: "app.watchlater.catalog",
  version: "1.1.0",
  name: "Watchlater",
  description: "Filmes e séries identificados pelo Watchlater, disponíveis no Stremio.",
  resources: [
    "catalog",
    { name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] },
  ],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "watchlater-want-to-watch", name: "Watchlater — Filmes — Quero assistir", extra: [{ name: "skip" }] },
    { type: "movie", id: "watchlater-watching", name: "Watchlater — Filmes — Assistindo", extra: [{ name: "skip" }] },
    { type: "movie", id: "watchlater-watched", name: "Watchlater — Filmes — Vistos", extra: [{ name: "skip" }] },
    { type: "series", id: "watchlater-series-want-to-watch", name: "Watchlater — Séries — Quero assistir", extra: [{ name: "skip" }] },
    { type: "series", id: "watchlater-series-watching", name: "Watchlater — Séries — Assistindo", extra: [{ name: "skip" }] },
    { type: "series", id: "watchlater-series-watched", name: "Watchlater — Séries — Vistas", extra: [{ name: "skip" }] },
  ],
};

export const stremioCatalogSelection = (catalogId: string): { type: StremioContentType; status: StremioWatchStatus } | null => ({
  "watchlater-want-to-watch": { type: "movie", status: "want_to_watch" },
  "watchlater-watching": { type: "movie", status: "watching" },
  "watchlater-watched": { type: "movie", status: "watched" },
  "watchlater-series-want-to-watch": { type: "series", status: "want_to_watch" },
  "watchlater-series-watching": { type: "series", status: "watching" },
  "watchlater-series-watched": { type: "series", status: "watched" },
} as const)[catalogId] ?? null;

export const parseStremioSkip = (extra?: string) => {
  if (!extra) return 0;
  const params = new URLSearchParams(extra);
  const value = Number(params.get("skip") ?? "0");
  return Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : 0;
};
