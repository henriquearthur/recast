import type { Clock } from "./clock";

/**
 * Runs `run` with a signal that is aborted when `ms` pass on `clock`, and rejects with `message` at that moment even if
 * `run` ignores the signal. Used for calls to outside services that may never answer.
 */
export async function withTimeout<T>(clock: Clock, ms: number, message: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = clock.sleep(ms).then(() => {
    controller.abort();
    throw new Error(message);
  });
  timeout.catch(() => {});
  return Promise.race([run(controller.signal), timeout]);
}
