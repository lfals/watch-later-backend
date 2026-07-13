import type { SubmissionQueue } from "./queue.js";
import { QuotaService } from "./quota.js";
import { logError, logEvent } from "./logger.js";

export function startQuotaReconciler(quotas: QuotaService, queue: SubmissionQueue, intervalMs = 60_000) {
  let running = false;
  const reconcile = async () => {
    if (running) return;
    running = true;
    try {
      const admitted = await quotas.admitWaiting();
      for (const item of admitted) await queue.enqueue(item.id, item.normalizedUrlHash);
      if (admitted.length) logEvent("quota.waiting_admitted", { count: admitted.length });
    } catch (error) {
      logError("quota.reconcile_failed", error);
    } finally {
      running = false;
    }
  };
  void reconcile();
  const timer = setInterval(() => void reconcile(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), reconcile };
}
