import { Queue } from "bullmq";
import { logError, logEvent } from "./logger.js";

export interface SubmissionQueue { enqueue(submissionId: string, deduplicationKey?: string): Promise<void>; close?(): Promise<void> }

export class BullSubmissionQueue implements SubmissionQueue {
  private readonly queue: Queue;
  constructor(redisUrl: string) {
    const url = new URL(redisUrl);
    this.queue = new Queue("identify-reel", { connection: { host: url.hostname, port: Number(url.port || 6379), password: url.password || undefined } });
  }
  async enqueue(submissionId: string, deduplicationKey = submissionId) {
    const startedAt = performance.now();
    logEvent("queue.enqueue_started", { queue: "identify-reel", submissionId });
    try {
      const existing = await this.queue.getJob(deduplicationKey);
      const existingState = existing ? await existing.getState() : null;
      if (existing && existingState && ["active", "waiting", "delayed", "prioritized"].includes(existingState)) {
        logEvent("submission.job_deduplicated", { submissionId, jobId: existing.id ?? null, jobState: existingState, durationMs: Math.round(performance.now() - startedAt) });
        return;
      }
      if (existing && existingState && ["completed", "failed"].includes(existingState)) {
        await existing.remove();
        logEvent("submission.requeued", { submissionId, previousState: existingState });
      }
      const job = await this.queue.add("identify", { submissionId }, { jobId: deduplicationKey, attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 100, removeOnFail: 500 });
      logEvent("submission.enqueued", { submissionId, jobId: job.id ?? null, durationMs: Math.round(performance.now() - startedAt) });
    } catch (error) {
      logError("queue.enqueue_failed", error, { queue: "identify-reel", submissionId, durationMs: Math.round(performance.now() - startedAt) });
      throw error;
    }
  }
  async close() { await this.queue.close(); }
}
