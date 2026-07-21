import { and, asc, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { externalWorkIds, identificationCache, reelSubmissions, users, watchlistEntries, works } from "./db/schema.js";
import type { CatalogMovie, CatalogWork } from "./catalog.js";
import type { NormalizedReel } from "./reels.js";
import { QuotaService } from "./quota.js";

export class WatchlistRepository {
  private readonly quotas: QuotaService;
  constructor(private readonly db: NodePgDatabase, private readonly pipelineVersion = "v1", private readonly cacheTtlDays = 180) { this.quotas = new QuotaService(db); }

  private async userId(clerkUserId: string) {
    const [user] = await this.db.insert(users).values({ clerkUserId }).onConflictDoUpdate({
      target: users.clerkUserId,
      set: { updatedAt: new Date() },
    }).returning({ id: users.id });
    return user.id;
  }

  async addMovie(clerkUserId: string, movie: CatalogMovie) {
    const userId = await this.userId(clerkUserId);
    const [work] = await this.db.insert(works).values({
      type: "movie", title: movie.title, originalTitle: movie.originalTitle,
      releaseYear: movie.releaseYear, synopsis: movie.synopsis, posterUrl: movie.posterUrl, tmdbId: movie.externalId,
    }).onConflictDoUpdate({ target: works.tmdbId, set: {
      title: movie.title, originalTitle: movie.originalTitle, releaseYear: movie.releaseYear,
      synopsis: movie.synopsis, posterUrl: movie.posterUrl,
    }}).returning();
    const [entry] = await this.db.insert(watchlistEntries).values({ userId, workId: work.id })
      .onConflictDoNothing().returning();
    if (entry) return { ...work, entryId: entry.id, status: entry.status };
    const [existing] = await this.db.select().from(watchlistEntries)
      .where(and(eq(watchlistEntries.userId, userId), eq(watchlistEntries.workId, work.id)));
    return { ...work, entryId: existing.id, status: existing.status };
  }

  async addWork(clerkUserId: string, candidate: CatalogWork) {
    const userId = await this.userId(clerkUserId);
    const [known] = await this.db.select({ work: works }).from(externalWorkIds)
      .innerJoin(works, eq(works.id, externalWorkIds.workId))
      .where(and(eq(externalWorkIds.provider, candidate.provider), eq(externalWorkIds.externalId, candidate.externalId)));
    let work = known?.work;
    if (!work) {
      [work] = await this.db.insert(works).values({ type: candidate.type, title: candidate.title, originalTitle: candidate.originalTitle,
        releaseYear: candidate.releaseYear, synopsis: candidate.synopsis, posterUrl: candidate.posterUrl,
        tmdbId: candidate.provider === "tmdb" ? candidate.externalId : null }).returning();
      await this.db.insert(externalWorkIds).values({ workId: work.id, provider: candidate.provider, externalId: candidate.externalId });
    }
    const [entry] = await this.db.insert(watchlistEntries).values({ userId, workId: work.id }).onConflictDoNothing().returning();
    if (entry) return { ...work, externalId: candidate.externalId, provider: candidate.provider, entryId: entry.id, status: entry.status };
    const [existing] = await this.db.select().from(watchlistEntries).where(and(eq(watchlistEntries.userId, userId), eq(watchlistEntries.workId, work.id)));
    return { ...work, externalId: candidate.externalId, provider: candidate.provider, entryId: existing.id, status: existing.status };
  }

  async list(clerkUserId: string, page: { before?: Date; limit?: number } = {}) {
    const userId = await this.userId(clerkUserId);
    const conditions = [eq(watchlistEntries.userId, userId), page.before ? lt(watchlistEntries.createdAt, page.before) : undefined]
      .filter((value) => value !== undefined);
    return this.db.select({
      entryId: watchlistEntries.id, status: watchlistEntries.status, workId: works.id,
      title: works.title, originalTitle: works.originalTitle, releaseYear: works.releaseYear, synopsis: works.synopsis, posterUrl: works.posterUrl, tmdbId: works.tmdbId,
      externalId: externalWorkIds.externalId, provider: externalWorkIds.provider, type: works.type,
      createdAt: watchlistEntries.createdAt,
    }).from(watchlistEntries).innerJoin(works, eq(works.id, watchlistEntries.workId)).leftJoin(externalWorkIds, eq(externalWorkIds.workId, works.id))
      .where(and(...conditions)).orderBy(
        asc(sql`case ${watchlistEntries.status}
          when 'watching' then 0
          when 'want_to_watch' then 1
          when 'watched' then 2
          else 3
        end`),
        desc(watchlistEntries.createdAt),
        desc(watchlistEntries.id),
      ).limit(page.limit ?? 50);
  }

  async createSubmission(clerkUserId: string, reel: NormalizedReel) {
    const userId = await this.userId(clerkUserId);
    const [created] = await this.db.insert(reelSubmissions).values({ userId, ...reel }).onConflictDoNothing().returning();
    if (created) {
      const cached = await this.applyUrlCache(created);
      if (cached.cacheHit) return { ...cached, outcome: "cache_hit" as const, shouldEnqueue: false };
      const admission = await this.quotas.admitSubmission(created.id);
      const outcome = admission.status === "waiting_for_quota" ? "waiting_for_quota" as const : "accepted" as const;
      return { ...created, ...admission, outcome, cacheHit: false, shouldEnqueue: admission.admitted };
    }
    const [existing] = await this.db.select().from(reelSubmissions)
      .where(and(eq(reelSubmissions.userId, userId), eq(reelSubmissions.normalizedUrlHash, reel.normalizedUrlHash)));
    return { ...existing, outcome: "already_exists" as const, cacheHit: existing.status === "identified" || existing.status === "needs_confirmation", shouldEnqueue: false };
  }

  private async applyUrlCache(submission: typeof reelSubmissions.$inferSelect) {
    const [cached] = await this.db.select().from(identificationCache).where(and(
      eq(identificationCache.normalizedUrlHash, submission.normalizedUrlHash),
      eq(identificationCache.pipelineVersion, this.pipelineVersion),
      gt(identificationCache.expiresAt, new Date()),
    ));
    if (!cached || !["identified", "needs_confirmation"].includes(cached.status)) return { ...submission, cacheHit: false };
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.cacheTtlDays * 86_400_000);
    if (cached.status === "identified" && cached.workId) {
      await this.db.insert(watchlistEntries).values({ userId: submission.userId, workId: cached.workId }).onConflictDoNothing();
    }
    const [item] = await this.db.update(reelSubmissions).set({
      status: cached.status, workId: cached.workId, identifiedTitle: cached.identifiedTitle,
      confidence: cached.confidence, candidates: cached.candidates, contentFingerprint: cached.contentFingerprint,
      resolutionSource: "cache_url", updatedAt: now,
    }).where(eq(reelSubmissions.id, submission.id)).returning();
    await this.db.update(identificationCache).set({ lastHitAt: now, expiresAt, updatedAt: now }).where(eq(identificationCache.id, cached.id));
    return { ...item, cacheHit: true };
  }

  async inbox(clerkUserId: string, page: { before?: Date; limit?: number } = {}) {
    const userId = await this.userId(clerkUserId);
    const conditions = [
      eq(reelSubmissions.userId, userId),
      ne(reelSubmissions.status, "identified"),
      page.before ? lt(reelSubmissions.createdAt, page.before) : undefined,
    ]
      .filter((value) => value !== undefined);
    return this.db.select({
      id: reelSubmissions.id, normalizedUrl: reelSubmissions.normalizedUrl, status: reelSubmissions.status,
      identifiedTitle: reelSubmissions.identifiedTitle, confidence: reelSubmissions.confidence,
      failureCode: reelSubmissions.failureCode, candidates: reelSubmissions.candidates,
      resolutionSource: reelSubmissions.resolutionSource, createdAt: reelSubmissions.createdAt,
      updatedAt: reelSubmissions.updatedAt, workId: reelSubmissions.workId,
      workTitle: works.title, workType: works.type, posterUrl: works.posterUrl,
    }).from(reelSubmissions).leftJoin(works, eq(works.id, reelSubmissions.workId))
      .where(and(...conditions)).orderBy(desc(reelSubmissions.createdAt)).limit(page.limit ?? 50);
  }

  private async ownedSubmission(clerkUserId: string, submissionId: string) {
    const userId = await this.userId(clerkUserId);
    const [submission] = await this.db.select().from(reelSubmissions)
      .where(and(eq(reelSubmissions.id, submissionId), eq(reelSubmissions.userId, userId)));
    if (!submission) throw new Error("submission_not_found");
    return submission;
  }

  async confirmSubmission(clerkUserId: string, submissionId: string, candidate: CatalogWork, manual = false) {
    const submission = await this.ownedSubmission(clerkUserId, submissionId);
    if (submission.status === "identified") throw new Error("submission_already_resolved");
    if (["queued", "scraping", "identifying"].includes(submission.status)) throw new Error("submission_busy");
    if (!manual) {
      const allowed = submission.candidates.some((item) => item.provider === candidate.provider && item.externalId === candidate.externalId);
      if (!allowed) throw new Error("candidate_not_allowed");
    }
    const item = await this.addWork(clerkUserId, candidate) as { id: string; title: string; entryId: string; status: "want_to_watch" | "watching" | "watched" };
    await this.db.update(reelSubmissions).set({
      workId: item.id, status: "identified", identifiedTitle: item.title, failureCode: null,
      candidates: [], resolutionSource: manual ? "manual_catalog" : "user_confirmation", updatedAt: new Date(),
    }).where(eq(reelSubmissions.id, submissionId));
    return item;
  }

  async createCustomResolution(clerkUserId: string, submissionId: string, input: { title: string; type: "movie" | "series"; releaseYear?: string | null; synopsis?: string | null }) {
    const submission = await this.ownedSubmission(clerkUserId, submissionId);
    if (submission.status === "identified") throw new Error("submission_already_resolved");
    if (["queued", "scraping", "identifying"].includes(submission.status)) throw new Error("submission_busy");
    const [work] = await this.db.insert(works).values({
      ownerUserId: submission.userId, isCustom: true, title: input.title, type: input.type,
      releaseYear: input.releaseYear ?? null, synopsis: input.synopsis ?? null,
    }).returning();
    const [entry] = await this.db.insert(watchlistEntries).values({ userId: submission.userId, workId: work.id }).returning();
    await this.db.update(reelSubmissions).set({
      workId: work.id, status: "identified", identifiedTitle: work.title, failureCode: null,
      candidates: [], resolutionSource: "manual_custom", updatedAt: new Date(),
    }).where(eq(reelSubmissions.id, submissionId));
    return { ...work, externalId: work.id, provider: "custom", entryId: entry.id, status: entry.status };
  }

  async prepareReprocess(clerkUserId: string, submissionId: string) {
    await this.ownedSubmission(clerkUserId, submissionId);
    return this.quotas.registerRetry(submissionId);
  }

  async submissionDetail(clerkUserId: string, submissionId: string) {
    const submission = await this.ownedSubmission(clerkUserId, submissionId);
    const [work] = submission.workId ? await this.db.select({
      id: works.id, type: works.type, title: works.title, originalTitle: works.originalTitle,
      releaseYear: works.releaseYear, synopsis: works.synopsis, posterUrl: works.posterUrl,
      externalId: externalWorkIds.externalId, provider: externalWorkIds.provider, isCustom: works.isCustom,
    }).from(works).leftJoin(externalWorkIds, eq(externalWorkIds.workId, works.id)).where(eq(works.id, submission.workId)) : [];
    return {
      ...submission,
      work: work ? { ...work, externalId: work.externalId ?? work.id, provider: work.provider ?? "custom" } : null,
    };
  }

  async updateStatus(clerkUserId: string, entryId: string, status: "want_to_watch" | "watching" | "watched") {
    const userId = await this.userId(clerkUserId);
    const [entry] = await this.db.update(watchlistEntries).set({ status, updatedAt: new Date() })
      .where(and(eq(watchlistEntries.id, entryId), eq(watchlistEntries.userId, userId))).returning();
    if (!entry) throw new Error("watchlist_entry_not_found");
    return entry;
  }

  async remove(clerkUserId: string, entryId: string) {
    const userId = await this.userId(clerkUserId);
    const [entry] = await this.db.delete(watchlistEntries)
      .where(and(eq(watchlistEntries.id, entryId), eq(watchlistEntries.userId, userId))).returning({ id: watchlistEntries.id });
    if (!entry) throw new Error("watchlist_entry_not_found");
    return entry;
  }

  async detail(clerkUserId: string, entryId: string) {
    const userId = await this.userId(clerkUserId);
    const [item] = await this.db.select({
      entryId: watchlistEntries.id, status: watchlistEntries.status, workId: works.id, type: works.type,
      title: works.title, originalTitle: works.originalTitle, releaseYear: works.releaseYear,
      synopsis: works.synopsis, posterUrl: works.posterUrl, externalId: externalWorkIds.externalId,
      provider: externalWorkIds.provider, isCustom: works.isCustom,
    }).from(watchlistEntries).innerJoin(works, eq(works.id, watchlistEntries.workId))
      .leftJoin(externalWorkIds, eq(externalWorkIds.workId, works.id))
      .where(and(eq(watchlistEntries.id, entryId), eq(watchlistEntries.userId, userId)));
    if (!item) throw new Error("watchlist_entry_not_found");
    const sources = await this.db.select({
      id: reelSubmissions.id, normalizedUrl: reelSubmissions.normalizedUrl, createdAt: reelSubmissions.createdAt,
      resolutionSource: reelSubmissions.resolutionSource,
    }).from(reelSubmissions).where(and(eq(reelSubmissions.userId, userId), eq(reelSubmissions.workId, item.workId)))
      .orderBy(desc(reelSubmissions.createdAt));
    return { ...item, externalId: item.externalId ?? item.workId, provider: item.provider ?? "custom", sources };
  }
}
