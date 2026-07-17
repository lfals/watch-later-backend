import { and, eq, gt, lt } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { externalWorkIds, identificationCache, reelSubmissions, submissionArtifacts, watchlistEntries, works } from "./db/schema.js";
import type { Identification, PipelineStore, ReelArtifact, ReelMedia } from "./pipeline.js";
import type { CatalogWork } from "./catalog.js";
import { refundTechnicalFailure } from "./quota.js";
import type { ArtifactStorage } from "./artifact-storage.js";

export class DrizzlePipelineStore implements PipelineStore {
  constructor(
    private readonly db: NodePgDatabase,
    private readonly pipelineVersion = "v1",
    private readonly cacheTtlDays = 180,
    private readonly artifactStorage?: ArtifactStorage,
    private readonly artifactRetentionDays = 7,
  ) {}
  private async submission(id: string) {
    const [item] = await this.db.select().from(reelSubmissions).where(eq(reelSubmissions.id, id));
    if (!item) throw new Error("submission_not_found");
    return item;
  }
  async getUrl(id: string) {
    const [item] = await this.db.select({ url: reelSubmissions.normalizedUrl }).from(reelSubmissions).where(eq(reelSubmissions.id, id));
    if (!item) throw new Error("submission_not_found");
    return item.url;
  }
  async setStatus(id: string, status: "scraping" | "identifying" | "needs_confirmation" | "identified" | "failed", result: Partial<Identification> & { failureCode?: string } = {}) {
    const source = await this.submission(id);
    const now = new Date();
    await this.db.update(reelSubmissions).set({
      status, identifiedTitle: result.title, confidence: result.confidence?.toString(), failureCode: result.failureCode,
      ...(status === "identified" && source.workId ? { workId: source.workId, resolutionSource: "automatic" } : {}), updatedAt: now,
    }).where(eq(reelSubmissions.normalizedUrlHash, source.normalizedUrlHash));
    if (status === "identified" && source.workId) {
      const matches = await this.db.select({ userId: reelSubmissions.userId }).from(reelSubmissions).where(eq(reelSubmissions.normalizedUrlHash, source.normalizedUrlHash));
      for (const match of matches) await this.db.insert(watchlistEntries).values({ userId: match.userId, workId: source.workId }).onConflictDoNothing();
    }
    if (["identified", "needs_confirmation"].includes(status)) {
      const [current] = await this.db.select().from(reelSubmissions).where(eq(reelSubmissions.id, id));
      await this.db.insert(identificationCache).values({
        normalizedUrlHash: source.normalizedUrlHash, pipelineVersion: this.pipelineVersion, status,
        workId: current.workId, identifiedTitle: result.title ?? current.identifiedTitle,
        confidence: result.confidence?.toString() ?? current.confidence, candidates: current.candidates,
        contentFingerprint: current.contentFingerprint,
        expiresAt: new Date(now.getTime() + this.cacheTtlDays * 86_400_000), updatedAt: now,
      }).onConflictDoUpdate({ target: [identificationCache.normalizedUrlHash, identificationCache.pipelineVersion], set: {
        status, workId: current.workId, identifiedTitle: result.title ?? current.identifiedTitle,
        confidence: result.confidence?.toString() ?? current.confidence, candidates: current.candidates,
        contentFingerprint: current.contentFingerprint,
        expiresAt: new Date(now.getTime() + this.cacheTtlDays * 86_400_000), updatedAt: now,
      }});
    }
    if (status === "failed" && result.failureCode && !["low_confidence", "catalog_no_match"].includes(result.failureCode)) {
      const matches = await this.db.select({ id: reelSubmissions.id }).from(reelSubmissions).where(eq(reelSubmissions.normalizedUrlHash, source.normalizedUrlHash));
      for (const match of matches) await refundTechnicalFailure(this.db, match.id);
    }
  }

  async setCandidates(id: string, candidates: CatalogWork[]) {
    const source = await this.submission(id);
    await this.db.update(reelSubmissions).set({ candidates, updatedAt: new Date() }).where(eq(reelSubmissions.normalizedUrlHash, source.normalizedUrlHash));
  }

  async setContentFingerprint(id: string, fingerprint: string) {
    const source = await this.submission(id);
    await this.db.update(reelSubmissions).set({ contentFingerprint: fingerprint, updatedAt: new Date() })
      .where(eq(reelSubmissions.normalizedUrlHash, source.normalizedUrlHash));
  }

  async setEvidenceSummary(id: string, summary: Record<string, unknown>) {
    const source = await this.submission(id);
    await this.db.update(reelSubmissions).set({ evidenceSummary: { ...source.evidenceSummary, ...summary }, updatedAt: new Date() })
      .where(eq(reelSubmissions.normalizedUrlHash, source.normalizedUrlHash));
  }

  async saveEvidenceArtifacts(id: string, artifacts: Array<ReelArtifact | (ReelMedia & { kind: "video" })>) {
    const now = new Date();
    const stale = await this.db.select({ objectKey: submissionArtifacts.objectKey }).from(submissionArtifacts)
      .where(lt(submissionArtifacts.expiresAt, now));
    const replaced = await this.db.select({ objectKey: submissionArtifacts.objectKey }).from(submissionArtifacts)
      .where(eq(submissionArtifacts.submissionId, id));
    await this.artifactStorage?.delete([...stale, ...replaced].flatMap((item) => item.objectKey ? [item.objectKey] : []));
    await this.db.delete(submissionArtifacts).where(lt(submissionArtifacts.expiresAt, new Date()));
    await this.db.delete(submissionArtifacts).where(eq(submissionArtifacts.submissionId, id));
    if (!artifacts.length) return;
    const expiresAt = new Date(Date.now() + this.artifactRetentionDays * 86_400_000);
    const uploadedKeys: string[] = [];
    try {
      await this.db.insert(submissionArtifacts).values(await Promise.all(artifacts.map(async (artifact) => {
        const objectKey = this.artifactStorage ? `submissions/${id}/${randomUUID()}` : null;
        if (objectKey) {
          await this.artifactStorage!.put(objectKey, artifact.path, artifact.mimeType);
          uploadedKeys.push(objectKey);
        }
        return {
          submissionId: id, kind: artifact.kind, mimeType: artifact.mimeType, sizeBytes: String(artifact.sizeBytes),
          dataBase64: objectKey ? null : (await readFile(artifact.path)).toString("base64"), objectKey, expiresAt,
        };
      })));
    } catch (error) {
      await this.artifactStorage?.delete(uploadedKeys).catch(() => undefined);
      throw error;
    }
  }

  async reuseCachedFingerprint(id: string, fingerprint: string) {
    const [cached] = await this.db.select().from(identificationCache).where(and(
      eq(identificationCache.contentFingerprint, fingerprint), eq(identificationCache.pipelineVersion, this.pipelineVersion),
      eq(identificationCache.status, "identified"), gt(identificationCache.expiresAt, new Date()),
    )).limit(1);
    if (!cached?.workId) return false;
    const source = await this.submission(id);
    const matches = await this.db.select().from(reelSubmissions).where(eq(reelSubmissions.normalizedUrlHash, source.normalizedUrlHash));
    for (const submission of matches) await this.db.insert(watchlistEntries).values({ userId: submission.userId, workId: cached.workId }).onConflictDoNothing();
    const now = new Date();
    await this.db.update(reelSubmissions).set({ status: "identified", workId: cached.workId, identifiedTitle: cached.identifiedTitle,
      confidence: cached.confidence, candidates: [], contentFingerprint: fingerprint, resolutionSource: "cache_fingerprint", updatedAt: now,
    }).where(eq(reelSubmissions.normalizedUrlHash, source.normalizedUrlHash));
    await this.db.update(identificationCache).set({ lastHitAt: now, expiresAt: new Date(now.getTime() + this.cacheTtlDays * 86_400_000), updatedAt: now }).where(eq(identificationCache.id, cached.id));
    await refundTechnicalFailure(this.db, id);
    await this.db.insert(identificationCache).values({ normalizedUrlHash: source.normalizedUrlHash, pipelineVersion: this.pipelineVersion,
      status: "identified", workId: cached.workId, identifiedTitle: cached.identifiedTitle, confidence: cached.confidence,
      candidates: [], contentFingerprint: fingerprint, expiresAt: new Date(now.getTime() + this.cacheTtlDays * 86_400_000), lastHitAt: now,
    }).onConflictDoUpdate({ target: [identificationCache.normalizedUrlHash, identificationCache.pipelineVersion], set: {
      status: "identified", workId: cached.workId, identifiedTitle: cached.identifiedTitle, confidence: cached.confidence,
      candidates: [], contentFingerprint: fingerprint, expiresAt: new Date(now.getTime() + this.cacheTtlDays * 86_400_000), lastHitAt: now, updatedAt: now,
    }});
    return true;
  }

  async addToWatchlist(id: string, candidate: CatalogWork) {
    await this.db.transaction(async (tx) => {
      const [submission] = await tx.select().from(reelSubmissions).where(eq(reelSubmissions.id, id));
      if (!submission) throw new Error("submission_not_found");

      const [known] = await tx.select({ work: works }).from(externalWorkIds)
        .innerJoin(works, eq(works.id, externalWorkIds.workId))
        .where(and(eq(externalWorkIds.provider, candidate.provider), eq(externalWorkIds.externalId, candidate.externalId)));
      let work = known?.work;
      if (!work) {
        [work] = await tx.insert(works).values({
          type: candidate.type, title: candidate.title, originalTitle: candidate.originalTitle,
          releaseYear: candidate.releaseYear, synopsis: candidate.synopsis, posterUrl: candidate.posterUrl,
          tmdbId: candidate.provider === "tmdb" ? candidate.externalId : null,
        }).returning();
        await tx.insert(externalWorkIds).values({ workId: work.id, provider: candidate.provider, externalId: candidate.externalId });
      }
      const matches = await tx.select({ userId: reelSubmissions.userId }).from(reelSubmissions).where(eq(reelSubmissions.normalizedUrlHash, submission.normalizedUrlHash));
      for (const match of matches) await tx.insert(watchlistEntries).values({ userId: match.userId, workId: work.id }).onConflictDoNothing();
      await tx.update(reelSubmissions).set({ workId: work.id, resolutionSource: "automatic", updatedAt: new Date() }).where(eq(reelSubmissions.normalizedUrlHash, submission.normalizedUrlHash));
    });
  }
}
