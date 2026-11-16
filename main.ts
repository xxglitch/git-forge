// main.ts — the trial lifecycle for the git-forge entry.
//
// This process is the bridge between the trial harness and the forge
// server in app.ts. Its whole job is four steps:
//   1. read the env's address from MAKEFUN_ENV_URL (no address, no trial);
//   2. start the forge on a kernel-chosen port, never 8080;
//   3. tell the env which port that was, retrying while the env wakes up;
//   4. wait until the env reports the trial is over, then leave quietly.
//
// Nothing here keeps state of its own: every request goes to the env or
// comes from the server, and every wait is a plain sleep, so a run can
// be repeated and behave the same way each time.

import { createApp } from './app.ts';

// The env's origin, without a trailing slash so paths join cleanly.
const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set; there is no env to join\n');
  process.exit(1);
}

/** Longest a single request to the env may run before it is dropped. */
const HTTP_TIMEOUT_MS = 30_000;
/** First pause between retries, and the ceiling it grows to. */
const BACKOFF_START_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `tries` failed attempts: doubling from 250 ms, capped at 2 s. */
function backoff(tries: number): number {
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_START_MS * 2 ** tries);
}

/**
 * Tell the env which port the forge is listening on. The env accepts the
 * first announcement; a 409 means somebody else already won that race,
 * which is fine — this process just carries on waiting. A 400 or 405
 * means the request itself is wrong, so there is no point retrying and
 * the process fails. Anything else (no answer, a timeout, an odd
 * status) is treated as "the env is not ready yet" and retried.
 */
async function announce(port: number): Promise<void> {
  let tries = 0;
  for (;;) {
    let res: Response | null = null;
    try {
      res = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      // The env is not answering: fall through and try again below.
    }
    if (res !== null) {
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`env refused the registration (HTTP ${res.status})`);
      }
    }
    await pause(backoff(tries));
    tries += 1;
  }
}

/** Ask the env, over and over, whether the trial is finished. */
async function awaitDone(): Promise<void> {
  let tries = 0;
  for (;;) {
    try {
      const res = await fetch(`${envBase}/done`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // No usable answer yet; the trial is still running, so ask again.
    }
    await pause(backoff(tries));
    tries += 1;
  }
}

/** Start the forge, announce it, and wait for the env to finish. */
async function boot(): Promise<void> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('server did not bind a TCP port'));
        return;
      }
      resolve(addr.port);
    });
  });
  process.stdout.write(`[forge] listening on port ${port}\n`);

  await announce(port);
  process.stdout.write('[forge] registered with the env\n');

  await awaitDone();
  server.close();
  process.stdout.write('[forge] trial done; exiting\n');
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
