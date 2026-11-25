import type { ProductModule } from "./module.js";
import { dispatchPendingWorkflow } from "./workflow-engine.js";
import { dispatchPendingDecision } from "./workflow-decision.js";
import { dispatchPendingReconciliation } from "./workflow-reconcile.js";

/** Poll durable intents without overlapping ticks. A failure leaves the intent pending. */
export function createDispatchScheduler(module: ProductModule, options: {
  intervalMs?: number; batchSize?: number; dispatch?: (module: ProductModule) => Promise<boolean>;
  onError?: (error: unknown) => void;
} = {}) {
  const interval = options.intervalMs ?? 5000, batchSize = options.batchSize ?? 10;
  if (!Number.isInteger(interval) || interval < 100 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("Invalid workflow scheduler settings.");
  }
  const dispatch = options.dispatch ?? (async module => await dispatchPendingDecision(module) || await dispatchPendingReconciliation(module) || await dispatchPendingWorkflow(module));
  let running: Promise<number> | undefined, timer: ReturnType<typeof setTimeout> | undefined, stopped = true;
  function tick(): Promise<number> {
    if (running) return running;
    running = (async () => {
      let count = 0;
      while (count < batchSize && await dispatch(module)) count++;
      return count;
    })().finally(() => { running = undefined; });
    return running;
  }
  function schedule(delay: number) {
    timer = setTimeout(async () => {
      timer = undefined;
      try { await tick(); } catch (error) {
        try { options.onError?.(error); } catch { /* Logging must not stop later retries. */ }
      }
      if (!stopped) schedule(interval);
    }, delay);
    timer.unref?.();
  }
  return {
    tick,
    start() { if (stopped) { stopped = false; schedule(0); } },
    async stop() { stopped = true; if (timer) clearTimeout(timer); timer = undefined; await running?.catch(() => {}); },
  };
}
