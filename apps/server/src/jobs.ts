/** Background work: periodic Canvas syncs, calendar reconciliation, expiry purges. */
import type { Services } from "./services.js";

export interface Jobs {
  runOnce(): Promise<void>;
  stop(): void;
}

export function startJobs(services: Services, intervalMinutes: number, log: (msg: string) => void): Jobs {
  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      services.store.purgeExpired();
      for (const account of services.store.listAllCanvasAccounts()) {
        if (account.kind === "session") continue;
        const r = await services.syncAccount(account);
        if (r.errors.length) log(`sync ${account.kind} ${new URL(account.baseUrl).host}: ${r.errors.join("; ")}`);
      }
      for (const user of services.store.listUsers()) {
        try {
          const s = await services.reconcileGoogle(user.id);
          if (s.moved || s.deleted) log(`calendar reconcile ${user.id}: ${s.moved} moved, ${s.deleted} deleted`);
        } catch (e) {
          log(`calendar reconcile ${user.id}: ${(e as Error).message}`);
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
