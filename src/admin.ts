import { and, count, desc, eq, gte, ilike, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { adminAuditLogs, dailyQuotaUsage, identificationCache, operationalLogs, quotaSettings, reelSubmissions, submissionArtifacts, userQuotaOverrides, users, works } from "./db/schema.js";
import { quotaWindowDate } from "./quota.js";
import type { LogRecord } from "./logger.js";
import type { ArtifactStorage } from "./artifact-storage.js";

export type AdminLogQuery = {
  level?: "info" | "error"; event?: string; submissionId?: string; before?: Date; limit: number;
};

export class AdminStore {
  constructor(
    private readonly db: NodePgDatabase,
    private readonly bootstrapAdmins: Set<string>,
    private readonly artifactStorage?: ArtifactStorage,
  ) {}

  async role(clerkUserId: string) {
    if (this.bootstrapAdmins.has(clerkUserId)) {
      const [user] = await this.db.insert(users).values({ clerkUserId, role: "admin" })
        .onConflictDoUpdate({ target: users.clerkUserId, set: { role: "admin", updatedAt: new Date() } })
        .returning({ role: users.role });
      return user.role;
    }
    await this.db.insert(users).values({ clerkUserId }).onConflictDoNothing({ target: users.clerkUserId });
    const [user] = await this.db.select({ role: users.role }).from(users).where(eq(users.clerkUserId, clerkUserId));
    return user?.role ?? "user";
  }

  async logs(query: AdminLogQuery) {
    const conditions = [
      query.level ? eq(operationalLogs.level, query.level) : undefined,
      query.event ? ilike(operationalLogs.event, `%${query.event}%`) : undefined,
      query.submissionId ? eq(operationalLogs.submissionId, query.submissionId) : undefined,
      query.before ? lt(operationalLogs.createdAt, query.before) : undefined,
    ].filter((value) => value !== undefined);
    return this.db.select().from(operationalLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(operationalLogs.createdAt)).limit(query.limit);
  }

  async submissions(status?: "queued" | "waiting_for_quota" | "scraping" | "identifying" | "needs_confirmation" | "identified" | "failed") {
    return this.db.select({
      id: reelSubmissions.id, status: reelSubmissions.status,
      identifiedTitle: reelSubmissions.identifiedTitle, confidence: reelSubmissions.confidence,
      failureCode: reelSubmissions.failureCode, createdAt: reelSubmissions.createdAt,
      updatedAt: reelSubmissions.updatedAt, workTitle: works.title, workType: works.type,
    }).from(reelSubmissions).leftJoin(works, eq(reelSubmissions.workId, works.id))
      .where(status ? eq(reelSubmissions.status, status) : undefined)
      .orderBy(desc(reelSubmissions.createdAt)).limit(200);
  }

  async submission(id: string) {
    const [item] = await this.db.select({
      id: reelSubmissions.id, status: reelSubmissions.status, identifiedTitle: reelSubmissions.identifiedTitle,
      confidence: reelSubmissions.confidence, failureCode: reelSubmissions.failureCode, candidates: reelSubmissions.candidates,
      resolutionSource: reelSubmissions.resolutionSource, contentFingerprint: reelSubmissions.contentFingerprint,
      evidenceSummary: reelSubmissions.evidenceSummary, createdAt: reelSubmissions.createdAt, updatedAt: reelSubmissions.updatedAt,
      workTitle: works.title, workType: works.type,
    }).from(reelSubmissions).leftJoin(works, eq(reelSubmissions.workId, works.id)).where(eq(reelSubmissions.id, id));
    if (!item) throw new Error("submission_not_found");
    const timeline = await this.db.select().from(operationalLogs).where(eq(operationalLogs.submissionId, id)).orderBy(operationalLogs.createdAt);
    const artifacts = await this.db.select({ id: submissionArtifacts.id, kind: submissionArtifacts.kind, mimeType: submissionArtifacts.mimeType, sizeBytes: submissionArtifacts.sizeBytes, expiresAt: submissionArtifacts.expiresAt })
      .from(submissionArtifacts).where(and(eq(submissionArtifacts.submissionId, id), gte(submissionArtifacts.expiresAt, new Date()))).orderBy(submissionArtifacts.createdAt);
    return { ...item, timeline, artifacts: artifacts.map((artifact) => ({ ...artifact, sizeBytes: Number(artifact.sizeBytes) })) };
  }

  async artifact(id: string) {
    const [artifact] = await this.db.select().from(submissionArtifacts).where(and(eq(submissionArtifacts.id, id), gte(submissionArtifacts.expiresAt, new Date())));
    if (!artifact) throw new Error("artifact_not_found");
    if (artifact.objectKey) {
      if (!this.artifactStorage) throw new Error("artifact_storage_unavailable");
      return { ...artifact, data: await this.artifactStorage.get(artifact.objectKey) };
    }
    if (!artifact.dataBase64) throw new Error("artifact_data_missing");
    return { ...artifact, data: Buffer.from(artifact.dataBase64, "base64") };
  }

  async health() {
    const since = new Date(Date.now() - 86_400_000);
    const byStatus = await this.db.select({ status: reelSubmissions.status, total: count() }).from(reelSubmissions).groupBy(reelSubmissions.status);
    const [events] = await this.db.select({ total: count(), errors: sql<number>`count(*) filter (where ${operationalLogs.level} = 'error')`, lastEventAt: sql<Date | null>`max(${operationalLogs.createdAt})` })
      .from(operationalLogs).where(gte(operationalLogs.createdAt, since));
    return { windowHours: 24, submissions: Object.fromEntries(byStatus.map((row) => [row.status, Number(row.total)])), events: { ...events, total: Number(events.total), errors: Number(events.errors) } };
  }

  async audits() { return this.db.select().from(adminAuditLogs).orderBy(desc(adminAuditLogs.createdAt)).limit(100); }

  async audit(actorClerkUserId: string, input: { action: string; targetType: string; targetId: string; reason: string }) {
    const [record] = await this.db.insert(adminAuditLogs).values({ actorClerkUserId, ...input }).returning();
    return record;
  }

  async prepareReprocess(submissionId: string) {
    const [item] = await this.db.update(reelSubmissions).set({ status: "queued", failureCode: null, candidates: [], updatedAt: new Date() })
      .where(eq(reelSubmissions.id, submissionId)).returning({ id: reelSubmissions.id });
    if (!item) throw new Error("submission_not_found");
    return item;
  }

  async cache() {
    return this.db.select({
      id: identificationCache.id, normalizedUrlHash: identificationCache.normalizedUrlHash,
      pipelineVersion: identificationCache.pipelineVersion, status: identificationCache.status,
      identifiedTitle: identificationCache.identifiedTitle, confidence: identificationCache.confidence,
      contentFingerprint: identificationCache.contentFingerprint, expiresAt: identificationCache.expiresAt,
      lastHitAt: identificationCache.lastHitAt, createdAt: identificationCache.createdAt,
      updatedAt: identificationCache.updatedAt, workTitle: works.title, workType: works.type,
    }).from(identificationCache).leftJoin(works, eq(identificationCache.workId, works.id))
      .orderBy(desc(identificationCache.updatedAt)).limit(200);
  }

  async invalidateCache(id: string) {
    const [item] = await this.db.delete(identificationCache).where(eq(identificationCache.id, id)).returning({ id: identificationCache.id });
    if (!item) throw new Error("cache_entry_not_found");
    return item;
  }

  async quotas() {
    await this.db.insert(quotaSettings).values({ id: "global" }).onConflictDoNothing();
    const [global] = await this.db.select().from(quotaSettings).where(eq(quotaSettings.id, "global"));
    const overrides = await this.db.select({
      userId: users.id, clerkUserId: users.clerkUserId, dailyNovelLimit: userQuotaOverrides.dailyNovelLimit,
      dailyRetryLimit: userQuotaOverrides.dailyRetryLimit, updatedAt: userQuotaOverrides.updatedAt,
    }).from(userQuotaOverrides).innerJoin(users, eq(users.id, userQuotaOverrides.userId));
    const usage = await this.db.select({ userId: users.id, clerkUserId: users.clerkUserId, novelCount: dailyQuotaUsage.novelCount })
      .from(dailyQuotaUsage).innerJoin(users, eq(users.id, dailyQuotaUsage.userId)).where(eq(dailyQuotaUsage.windowDate, quotaWindowDate()));
    return { global, overrides, usage, windowDate: quotaWindowDate() };
  }

  async updateGlobalQuotas(input: { dailyNovelLimit: number; dailyRetryLimit: number }) {
    const [item] = await this.db.insert(quotaSettings).values({ id: "global", ...input }).onConflictDoUpdate({
      target: quotaSettings.id, set: { ...input, updatedAt: new Date() },
    }).returning();
    return item;
  }

  async updateUserQuotas(clerkUserId: string, input: { dailyNovelLimit: number | null; dailyRetryLimit: number | null }) {
    const [user] = await this.db.insert(users).values({ clerkUserId }).onConflictDoUpdate({ target: users.clerkUserId, set: { updatedAt: new Date() } }).returning({ id: users.id, clerkUserId: users.clerkUserId });
    const [item] = await this.db.insert(userQuotaOverrides).values({ userId: user.id, ...input }).onConflictDoUpdate({
      target: userQuotaOverrides.userId, set: { ...input, updatedAt: new Date() },
    }).returning();
    return { ...item, clerkUserId: user.clerkUserId };
  }
}

export const databaseLogSink = (db: NodePgDatabase) => async (record: LogRecord) => {
  const fields = Object.fromEntries(Object.entries(record.fields).filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined));
  const submissionId = typeof fields.submissionId === "string" && /^[0-9a-f-]{36}$/i.test(fields.submissionId) ? fields.submissionId : null;
  await db.insert(operationalLogs).values({
    level: record.level, service: record.service, event: record.event, submissionId, fields, createdAt: record.timestamp,
  });
};
