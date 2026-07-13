import { Queue } from "bullmq";
import { logEvent } from "./logger.js";

export interface SubmissionQueue { enqueue(submissionId: string, deduplicationKey?: string): Promise<void> }

export class BullSubmissionQueue implements SubmissionQueue {
  private readonly queue: Queue;
  constructor(redisUrl: string) {
    const url = new URL(redisUrl);
    this.queue = new Queue("identify-reel", { connection: { host: url.hostname, port: Number(url.port || 6379), password: url.password || undefined } });
  }
  async enqueue(submissionId: string, deduplicationKey = submissionId) {
    const existing = await this.queue.getJob(deduplicationKey);
    if (existing && ["active", "waiting", "delayed", "prioritized"].includes(await existing.getState())) {
      logEvent("submission.job_deduplicated", { submissionId, jobId: existing.id ?? null });
      return;
    }
    if (existing && ["completed", "failed"].includes(await existing.getState())) {
      await existing.remove();
      logEvent("submission.requeued", { submissionId });
    }
    const job = await this.queue.add("identify", { submissionId }, { jobId: deduplicationKey, attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 100, removeOnFail: 500 });
    logEvent("submission.enqueued", { submissionId, jobId: job.id ?? null });
  }
}
