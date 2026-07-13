import { and, asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dailyQuotaUsage, dailyRetryUsage, quotaSettings, reelSubmissions, userQuotaOverrides } from "./db/schema.js";
import { isRecoverableFailure } from "./failures.js";

export const quotaWindowDate = (now = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(now);

export class QuotaService {
  constructor(private readonly db: NodePgDatabase) {}

  private async limits(userId: string) {
    await this.db.insert(quotaSettings).values({ id: "global" }).onConflictDoNothing();
    const [global] = await this.db.select().from(quotaSettings).where(eq(quotaSettings.id, "global"));
    const [override] = await this.db.select().from(userQuotaOverrides).where(eq(userQuotaOverrides.userId, userId));
    return {
      dailyNovelLimit: override?.dailyNovelLimit ?? global.dailyNovelLimit,
      dailyRetryLimit: override?.dailyRetryLimit ?? global.dailyRetryLimit,
    };
  }

  async admitSubmission(submissionId: string) {
    return this.db.transaction(async (tx) => {
      const [submission] = await tx.select().from(reelSubmissions).where(eq(reelSubmissions.id, submissionId));
      if (!submission) throw new Error("submission_not_found");
      if (!["queued", "waiting_for_quota"].includes(submission.status)) return { admitted: false, status: submission.status, charged: submission.quotaCharged };
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${submission.normalizedUrlHash}))`);
      const [earliest] = await tx.select({ id: reelSubmissions.id }).from(reelSubmissions)
        .where(eq(reelSubmissions.normalizedUrlHash, submission.normalizedUrlHash))
        .orderBy(asc(reelSubmissions.createdAt), asc(reelSubmissions.id)).limit(1);
      if (earliest?.id !== submission.id) {
        await tx.update(reelSubmissions).set({ status: "queued", quotaCharged: false, quotaWindowDate: null, updatedAt: new Date() }).where(eq(reelSubmissions.id, submission.id));
        return { admitted: true, status: "queued" as const, charged: false };
      }
      const windowDate = quotaWindowDate();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${submission.userId}:${windowDate}`}))`);
      await tx.insert(quotaSettings).values({ id: "global" }).onConflictDoNothing();
      const [global] = await tx.select().from(quotaSettings).where(eq(quotaSettings.id, "global"));
      const [override] = await tx.select().from(userQuotaOverrides).where(eq(userQuotaOverrides.userId, submission.userId));
      const limit = override?.dailyNovelLimit ?? global.dailyNovelLimit;
      const [usage] = await tx.select().from(dailyQuotaUsage).where(and(eq(dailyQuotaUsage.userId, submission.userId), eq(dailyQuotaUsage.windowDate, windowDate)));
      if ((usage?.novelCount ?? 0) >= limit) {
        await tx.update(reelSubmissions).set({ status: "waiting_for_quota", quotaCharged: false, quotaWindowDate: null, updatedAt: new Date() }).where(eq(reelSubmissions.id, submission.id));
        return { admitted: false, status: "waiting_for_quota" as const, charged: false, limit, used: usage?.novelCount ?? 0 };
      }
      await tx.insert(dailyQuotaUsage).values({ userId: submission.userId, windowDate, novelCount: 1 }).onConflictDoUpdate({
        target: [dailyQuotaUsage.userId, dailyQuotaUsage.windowDate],
        set: { novelCount: sql`${dailyQuotaUsage.novelCount} + 1`, updatedAt: new Date() },
      });
      await tx.update(reelSubmissions).set({ status: "queued", quotaCharged: true, quotaWindowDate: windowDate, updatedAt: new Date() }).where(eq(reelSubmissions.id, submission.id));
      return { admitted: true, status: "queued" as const, charged: true, limit, used: (usage?.novelCount ?? 0) + 1 };
    });
  }

  async registerRetry(submissionId: string) {
    return this.db.transaction(async (tx) => {
      const [submission] = await tx.select().from(reelSubmissions).where(eq(reelSubmissions.id, submissionId));
      if (!submission) throw new Error("submission_not_found");
      if (submission.status !== "failed") throw new Error("submission_not_retryable");
      if (!isRecoverableFailure(submission.failureCode)) throw new Error("submission_not_retryable");
      const windowDate = quotaWindowDate();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${submission.userId}:${submission.normalizedUrlHash}:${windowDate}:retry`}))`);
      await tx.insert(quotaSettings).values({ id: "global" }).onConflictDoNothing();
      const [global] = await tx.select().from(quotaSettings).where(eq(quotaSettings.id, "global"));
      const [override] = await tx.select().from(userQuotaOverrides).where(eq(userQuotaOverrides.userId, submission.userId));
      const limit = override?.dailyRetryLimit ?? global.dailyRetryLimit;
      const [usage] = await tx.select().from(dailyRetryUsage).where(and(eq(dailyRetryUsage.userId, submission.userId), eq(dailyRetryUsage.normalizedUrlHash, submission.normalizedUrlHash), eq(dailyRetryUsage.windowDate, windowDate)));
      if ((usage?.retryCount ?? 0) >= limit) throw new Error("retry_limit_exceeded");
      await tx.insert(dailyRetryUsage).values({ userId: submission.userId, normalizedUrlHash: submission.normalizedUrlHash, windowDate, retryCount: 1 }).onConflictDoUpdate({
        target: [dailyRetryUsage.userId, dailyRetryUsage.normalizedUrlHash, dailyRetryUsage.windowDate],
        set: { retryCount: sql`${dailyRetryUsage.retryCount} + 1`, updatedAt: new Date() },
      });
      await tx.update(reelSubmissions).set({ status: "queued", failureCode: null, confidence: null, candidates: [], identifiedTitle: null, workId: null, resolutionSource: null, updatedAt: new Date() }).where(eq(reelSubmissions.id, submissionId));
      return { ...submission, status: "queued" as const, failureCode: null, retryCount: (usage?.retryCount ?? 0) + 1, retryLimit: limit };
    });
  }

  async admitWaiting(limit = 100) {
    const waiting = await this.db.select({ id: reelSubmissions.id, normalizedUrlHash: reelSubmissions.normalizedUrlHash }).from(reelSubmissions)
      .where(eq(reelSubmissions.status, "waiting_for_quota")).orderBy(asc(reelSubmissions.createdAt)).limit(limit);
    const admitted: Array<{ id: string; normalizedUrlHash: string }> = [];
    for (const item of waiting) if ((await this.admitSubmission(item.id)).admitted) admitted.push(item);
    return admitted;
  }

  async overview(userId?: string) {
    const [global] = await this.db.select().from(quotaSettings).where(eq(quotaSettings.id, "global"));
    const overrides = userId ? await this.db.select().from(userQuotaOverrides).where(eq(userQuotaOverrides.userId, userId)) : await this.db.select().from(userQuotaOverrides);
    const usage = await this.db.select().from(dailyQuotaUsage).where(eq(dailyQuotaUsage.windowDate, quotaWindowDate()));
    return { global: global ?? { id: "global", dailyNovelLimit: 10, dailyRetryLimit: 3 }, overrides, usage };
  }

  async limitsForUser(userId: string) { return this.limits(userId); }
}

export async function refundTechnicalFailure(db: NodePgDatabase, submissionId: string) {
  await db.transaction(async (tx) => {
    const [submission] = await tx.select().from(reelSubmissions).where(eq(reelSubmissions.id, submissionId));
    if (!submission?.quotaCharged || !submission.quotaWindowDate) return;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${submission.userId}:${submission.quotaWindowDate}`}))`);
    await tx.update(dailyQuotaUsage).set({ novelCount: sql`greatest(0, ${dailyQuotaUsage.novelCount} - 1)`, updatedAt: new Date() })
      .where(and(eq(dailyQuotaUsage.userId, submission.userId), eq(dailyQuotaUsage.windowDate, submission.quotaWindowDate)));
    await tx.update(reelSubmissions).set({ quotaCharged: false, updatedAt: new Date() }).where(eq(reelSubmissions.id, submissionId));
  });
}
