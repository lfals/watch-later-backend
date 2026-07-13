import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { WatchlistRepository } from "../src/repository.js";
import { dailyQuotaUsage, dailyRetryUsage, identificationCache, quotaSettings, reelSubmissions, userQuotaOverrides, users, watchlistEntries, works } from "../src/db/schema.js";
import { DrizzlePipelineStore } from "../src/pipeline-store.js";
import { normalizeInstagramReel } from "../src/reels.js";
import { AdminStore } from "../src/admin.js";
import { QuotaService } from "../src/quota.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("WatchlistRepository with PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  const repository = new WatchlistRepository(db);
  const movie = {
    externalId: "integration-550",
    title: "Fight Club",
    originalTitle: "Fight Club",
    releaseYear: "1999",
    synopsis: "Integration fixture",
    posterUrl: null,
  };

  beforeEach(async () => {
    await db.delete(identificationCache);
    await db.delete(watchlistEntries);
    await db.delete(reelSubmissions);
    await db.delete(dailyRetryUsage);
    await db.delete(dailyQuotaUsage);
    await db.delete(userQuotaOverrides);
    await db.delete(quotaSettings);
    await db.delete(works);
    await db.delete(users);
  });

  it("enforces the default daily quota and keeps cached submissions free", async () => {
    const concurrent = await Promise.all(Array.from({ length: 11 }, (_, index) =>
      repository.createSubmission("quota_default", normalizeInstagramReel(`https://www.instagram.com/reel/QUOTA${index}/`))));
    expect(concurrent.filter((item) => item.status === "queued")).toHaveLength(10);
    expect(concurrent.filter((item) => item.status === "waiting_for_quota")).toHaveLength(1);
    expect(concurrent.filter((item) => "charged" in item && item.charged === true)).toHaveLength(10);

    const cachedReel = normalizeInstagramReel("https://www.instagram.com/reel/FREECACHE/");
    await db.insert(identificationCache).values({ normalizedUrlHash: cachedReel.normalizedUrlHash, pipelineVersion: "v1", status: "needs_confirmation", expiresAt: new Date(Date.now() + 60_000) });
    const cached = await repository.createSubmission("quota_default", cachedReel);
    expect(cached).toMatchObject({ cacheHit: true, status: "needs_confirmation", shouldEnqueue: false });
    const [usage] = await db.select().from(dailyQuotaUsage);
    expect(usage.novelCount).toBe(10);
  });

  it("supports per-user overrides and admits waiting work when capacity changes", async () => {
    await new AdminStore(db, new Set()).updateGlobalQuotas({ dailyNovelLimit: 1, dailyRetryLimit: 3 });
    await new AdminStore(db, new Set()).updateUserQuotas("quota_override", { dailyNovelLimit: 2, dailyRetryLimit: null });
    await repository.createSubmission("quota_override", normalizeInstagramReel("https://www.instagram.com/reel/OVERRIDE1/"));
    await repository.createSubmission("quota_override", normalizeInstagramReel("https://www.instagram.com/reel/OVERRIDE2/"));
    const waiting = await repository.createSubmission("quota_override", normalizeInstagramReel("https://www.instagram.com/reel/OVERRIDE3/"));
    expect(waiting.status).toBe("waiting_for_quota");
    await new AdminStore(db, new Set()).updateUserQuotas("quota_override", { dailyNovelLimit: 3, dailyRetryLimit: null });
    expect(await new QuotaService(db).admitWaiting()).toContainEqual({ id: waiting.id, normalizedUrlHash: waiting.normalizedUrlHash });
  });

  it("refunds technical failures and bounds free user retries per URL", async () => {
    const submission = await repository.createSubmission("quota_retry", normalizeInstagramReel("https://www.instagram.com/reel/RETRYQUOTA/"));
    const store = new DrizzlePipelineStore(db);
    await store.setStatus(submission.id, "failed", { failureCode: "scrape_rate_limited" });
    expect((await db.select().from(dailyQuotaUsage))[0].novelCount).toBe(0);
    for (let retry = 1; retry <= 3; retry += 1) {
      const item = await repository.prepareReprocess("quota_retry", submission.id);
      expect(item.retryCount).toBe(retry);
      await db.update(reelSubmissions).set({ status: "failed", failureCode: "scrape_rate_limited" }).where(eq(reelSubmissions.id, submission.id));
    }
    await expect(repository.prepareReprocess("quota_retry", submission.id)).rejects.toThrow("retry_limit_exceeded");
    expect((await db.select().from(dailyRetryUsage))[0].retryCount).toBe(3);
  });

  it("reuses an anonymous URL cache across users without reprocessing", async () => {
    const reel = normalizeInstagramReel("https://www.instagram.com/reel/CACHE123/");
    const first = await repository.createSubmission("cache_user_1", reel);
    const joinedWhileProcessing = await repository.createSubmission("cache_user_2", reel);
    expect(joinedWhileProcessing.cacheHit).toBe(false);
    const store = new DrizzlePipelineStore(db);
    await store.setContentFingerprint(first.id, "a".repeat(64));
    await store.addToWatchlist(first.id, { provider: "tmdb", externalId: "cache-550", type: "movie", title: "Fight Club", originalTitle: "Fight Club", releaseYear: "1999", synopsis: null, posterUrl: null });
    await store.setStatus(first.id, "identified", { title: "Fight Club", confidence: 0.95, corroborated: true });

    expect(await repository.list("cache_user_2")).toHaveLength(1);
    const second = await repository.createSubmission("cache_user_3", reel);
    expect(second).toMatchObject({ cacheHit: true, status: "identified", resolutionSource: "cache_url" });
    expect(await repository.list("cache_user_3")).toHaveLength(1);
    expect((await db.select().from(identificationCache))).toHaveLength(1);
  });

  it("reuses an exact media fingerprint for a different Reel URL", async () => {
    const store = new DrizzlePipelineStore(db);
    const source = await repository.createSubmission("fingerprint_user_1", normalizeInstagramReel("https://www.instagram.com/reel/FPA/"));
    await store.setContentFingerprint(source.id, "b".repeat(64));
    await store.addToWatchlist(source.id, { provider: "tmdb", externalId: "fingerprint-550", type: "movie", title: "Fight Club", originalTitle: null, releaseYear: "1999", synopsis: null, posterUrl: null });
    await store.setStatus(source.id, "identified", { title: "Fight Club", confidence: 0.96, corroborated: true });

    const repost = await repository.createSubmission("fingerprint_user_2", normalizeInstagramReel("https://www.instagram.com/reel/FPB/"));
    expect(await store.reuseCachedFingerprint(repost.id, "b".repeat(64))).toBe(true);
    expect((await repository.submissionDetail("fingerprint_user_2", repost.id))).toMatchObject({ status: "identified", resolutionSource: "cache_fingerprint" });
    expect(await store.reuseCachedFingerprint(repost.id, "c".repeat(64))).toBe(false);
  });

  it("misses expired entries and entries from another pipeline version", async () => {
    const reel = normalizeInstagramReel("https://www.instagram.com/reel/STALE123/");
    await db.insert(identificationCache).values({ normalizedUrlHash: reel.normalizedUrlHash, pipelineVersion: "old", status: "needs_confirmation", expiresAt: new Date(Date.now() + 60_000) });
    const versionMiss = await repository.createSubmission("stale_user_1", reel);
    expect(versionMiss.cacheHit).toBe(false);
    await db.update(identificationCache).set({ pipelineVersion: "v1", expiresAt: new Date(Date.now() - 1_000) });
    const expiryMiss = await repository.createSubmission("stale_user_2", reel);
    expect(expiryMiss.cacheHit).toBe(false);
  });

  it("lets an administrator inspect and invalidate a cache entry", async () => {
    const [cached] = await db.insert(identificationCache).values({ normalizedUrlHash: "admin-cache", pipelineVersion: "v1", status: "needs_confirmation", expiresAt: new Date(Date.now() + 60_000) }).returning();
    const admin = new AdminStore(db, new Set(["admin_user"]));
    expect(await admin.cache()).toHaveLength(1);
    expect(await admin.invalidateCache(cached.id)).toEqual({ id: cached.id });
    expect(await admin.cache()).toHaveLength(0);
  });

  afterAll(async () => pool.end());

  it("persists one entry when the same movie is added twice", async () => {
    await repository.addMovie("user_integration", movie);
    await repository.addMovie("user_integration", movie);

    const entries = await repository.list("user_integration");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ title: "Fight Club", status: "want_to_watch" });
  });

  it("adds a confidently identified Reel work to the user's watchlist", async () => {
    const submission = await repository.createSubmission(
      "user_integration",
      normalizeInstagramReel("https://www.instagram.com/reel/AUTO123/"),
    );
    await new DrizzlePipelineStore(db).addToWatchlist(submission.id, {
      provider: "tmdb",
      externalId: "integration-auto-550",
      type: "movie",
      title: "Fight Club",
      originalTitle: "Fight Club",
      releaseYear: "1999",
      synopsis: "Integration fixture",
      posterUrl: null,
    });

    const entries = await repository.list("user_integration");
    expect(entries).toHaveLength(1);
    const [linkedSubmission] = await db.select({ workId: reelSubmissions.workId }).from(reelSubmissions);
    expect(linkedSubmission.workId).not.toBeNull();
  });

  it("completes confirmation, progress, source history, and removal", async () => {
    const submission = await repository.createSubmission(
      "user_flow",
      normalizeInstagramReel("https://www.instagram.com/reel/FLOW123/"),
    );
    const candidate = {
      provider: "tmdb" as const, externalId: "flow-550", type: "movie" as const,
      title: "Fight Club", originalTitle: "Fight Club", releaseYear: "1999",
      synopsis: "Flow fixture", posterUrl: null,
    };
    await db.update(reelSubmissions).set({ status: "needs_confirmation", candidates: [candidate] });
    const confirmed = await repository.confirmSubmission("user_flow", submission.id, candidate) as { entryId: string };
    await repository.updateStatus("user_flow", confirmed.entryId, "watched");

    const detail = await repository.detail("user_flow", confirmed.entryId);
    expect(detail.status).toBe("watched");
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0].resolutionSource).toBe("user_confirmation");
    const inbox = await repository.inbox("user_flow");
    expect(inbox).toHaveLength(0);

    await repository.remove("user_flow", confirmed.entryId);
    expect(await repository.list("user_flow")).toHaveLength(0);
  });

  it("supports custom manual resolution and safe reprocessing", async () => {
    const customSubmission = await repository.createSubmission(
      "user_custom",
      normalizeInstagramReel("https://www.instagram.com/reel/CUSTOM123/"),
    );
    await db.update(reelSubmissions).set({ status: "failed", failureCode: "low_confidence" });
    const custom = await repository.createCustomResolution("user_custom", customSubmission.id, {
      title: "Unknown Indie Film", type: "movie", releaseYear: "2025",
    });
    expect(custom).toMatchObject({ provider: "custom", title: "Unknown Indie Film" });

    const retrySubmission = await repository.createSubmission(
      "user_custom",
      normalizeInstagramReel("https://www.instagram.com/reel/RETRY123/"),
    );
    await db.update(reelSubmissions).set({ status: "failed", failureCode: "scrape_rate_limited" })
      .where(eq(reelSubmissions.id, retrySubmission.id));
    const retried = await repository.prepareReprocess("user_custom", retrySubmission.id);
    expect(retried).toMatchObject({ status: "queued", failureCode: null, candidates: [] });
  });
});
