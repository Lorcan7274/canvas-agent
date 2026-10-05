/** Background work: periodic Canvas syncs, calendar reconciliation, expiry purges. */
import type { CanvasAccount } from "@canvas-agent/core";
import type { Services } from "./services.js";
import { googleErrorMessage } from "./google/calendar.js";

export interface Jobs {
  runOnce(): Promise<void>;
  stop(): void;
}

export interface JobOptions {
  /** Accounts synced at the same time, so one slow Canvas cannot hold up everyone. Default 3. */
  concurrency?: number;
  /** Per account; the sync and its requests are cancelled after this. Default 2 minutes. */
  accountDeadlineMs?: number;
}

const MAX_BACKOFF_MINUTES = 24 * 60;

/**
 * Whether an account is due: always after a success; after n consecutive
 * failures, once interval × 2^(n-1) has passed since the last attempt, capped at a day.
 */
export function isSyncDue(account: Pick<CanvasAccount, "failures" | "lastSyncAt">, intervalMinutes: number, nowMs = Date.now()): boolean {
  if (!account.failures || !account.lastSyncAt) return true;
  const waitMinutes = Math.min(Math.max(1, intervalMinutes) * 2 ** (account.failures - 1), MAX_BACKOFF_MINUTES);
  // A minute of slack so a timer that fires a little early does not skip a whole interval.
  return nowMs - Date.parse(account.lastSyncAt) >= (waitMinutes - 1) * 60_000;
}

async function eachLimit<T>(items: T[], limit: number, f: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await f(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}

export function startJobs(services: Services, intervalMinutes: number, log: (msg: string) => void, opts: JobOptions = {}): Jobs {
  const concurrency = opts.concurrency ?? 3;
  const deadlineMs = opts.accountDeadlineMs ?? 120_000;
  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      services.store.purgeExpired();
      const now = Date.now();
      const due = services.store.listAllCanvasAccounts().filter((a) => a.kind !== "session" && isSyncDue(a, intervalMinutes, now));
      await eachLimit(due, concurrency, async (account) => {
        const r = await services.syncAccount(account, { deadlineMs });
        // Errors are generic by construction (status codes at most); never tokens, feed URLs or bodies.
        if (r.errors.length) log(`sync ${account.kind} ${new URL(account.baseUrl).host}: ${r.errors.join("; ")}`);
      });
      for (const user of services.store.listUsers()) {
        try {
          const s = await services.reconcileGoogle(user.id);
          if (s.moved || s.deleted) log(`calendar reconcile ${user.id}: ${s.moved} moved, ${s.deleted} deleted`);
        } catch (e) {
          log(`calendar reconcile ${user.id}: ${googleErrorMessage(e)}`);
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void runOnce().catch((e) => log(`jobs: ${(e as Error).message}`)), Math.max(1, intervalMinutes) * 60_000);
  timer.unref();
  return { runOnce, stop: () => clearInterval(timer) };
}
