/**
 * Network calls with retries.
 *
 * Measured on Enguun's connection, roughly one request in five to
 * api.telegram.org fails outright. A single dropped request should never cost
 * a day's post, so every call to Telegram and Instagram goes through here.
 *
 * Retries cover transport failures and 5xx / 429 responses. A 4xx is a real
 * answer from the server (bad token, bad request) and is returned as-is,
 * because repeating it would just fail the same way.
 */

const DEFAULTS = { attempts: 4, baseDelayMs: 1000, timeoutMs: 30_000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function retryFetch(url, options = {}, config = {}) {
  const { attempts, baseDelayMs, timeoutMs } = { ...DEFAULTS, ...config };
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });

      // Worth another go: the server is busy or rate limiting us.
      if ((res.status >= 500 || res.status === 429) && attempt < attempts) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
    }

    // Exponential backoff: 1s, 2s, 4s.
    const delay = baseDelayMs * 2 ** (attempt - 1);
    console.warn(`  network attempt ${attempt}/${attempts} failed (${lastErr.message}), retrying in ${delay}ms`);
    await sleep(delay);
  }

  throw new Error(`Request to ${new URL(url).host} failed after ${attempts} attempts: ${lastErr?.message}`);
}
