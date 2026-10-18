import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;

export interface WorkerSupervisor {
  stop(): Promise<void>;
}

export function startWorkerSupervisor(log: { info(data: object, message: string): void; error(data: object, message: string): void }): WorkerSupervisor {
  const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
  let child: ChildProcess | null = null;
  let stopped = false;
  let restartTimes: number[] = [];
  let timer: NodeJS.Timeout | null = null;

  const spawnWorker = (): void => {
    if (stopped) return;
    child = fork(workerPath, [], { stdio: "inherit", env: process.env });
    log.info({ pid: child.pid ?? 0 }, "import worker started");
    child.once("exit", (code, signal) => {
      child = null;
      if (stopped) return;
      const now = Date.now();
      restartTimes = restartTimes.filter((time) => now - time < RESTART_WINDOW_MS);
      if (restartTimes.length >= MAX_RESTARTS) {
        log.error({ code, signal }, "import worker restart limit reached");
        return;
      }
      restartTimes.push(now);
      const delay = Math.min(4_000, 250 * 2 ** (restartTimes.length - 1));
      timer = setTimeout(spawnWorker, delay);
      log.error({ code, signal, delay }, "import worker exited; scheduling restart");
    });
  };
  spawnWorker();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (!child) return;
      const current = child;
      await new Promise<void>((resolve) => {
        current.once("exit", () => resolve());
        current.kill("SIGTERM");
      });
    }
  };
}
