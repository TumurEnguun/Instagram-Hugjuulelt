/**
 * Reads the latest Telegram button press and acts on it.
 *
 *   node src/check.js             check once and exit
 *   node src/check.js --wait 60   keep listening for up to 60 minutes
 *
 * In --wait mode a redraw or rewrite does NOT end the run. It used to: the
 * first tap inside the window was handled within seconds, the new version
 * arrived, and then the OK on it sat in Telegram's queue until the next cron
 * slot fired, which could be half an hour or more. That is what made the
 * buttons feel broken. Now the run stays on the line until the episode is
 * actually published or skipped, or the time runs out.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { readPending, writePending } from './store.js';
import { pollDecision, waitForDecision, sendMessage, confirmUpdates, ackButton, pressMatchesPending } from './telegram.js';
import { applyDecision } from './decide.js';

const waitIdx = process.argv.indexOf('--wait');
const waitMinutes = waitIdx !== -1 ? Number(process.argv[waitIdx + 1]) : 0;

/** Outcomes after which nothing is awaiting a decision any more. */
const TERMINAL = new Set(['published', 'skipped']);

/**
 * Push state mid-run. CI only.
 *
 * A redraw writes a new JPEG that Instagram fetches from the repo, so it has
 * to be pushed BEFORE the next OK can succeed. The workflow's own persist step
 * only runs when the job ends, and the wait loop keeps the job alive, so a
 * redraw followed by an OK in the same window would otherwise always fail
 * with "image not reachable". Locally there is nothing to do here: `npm run
 * listen` handles its own pushes.
 */
function persistInCI(label) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const script = path.join(ROOT, '.github', 'workflows', '_persist.sh');
  if (!fs.existsSync(script)) return;
  try {
    execFileSync('bash', [script, label], { stdio: 'inherit' });
  } catch (err) {
    // Fail-closed: an unpushed image just means the next OK reports "not
    // reachable" and stays pending. The workflow's final persist step retries.
    console.warn(`Could not push mid-run (${err.message}). The next OK may need a retry.`);
  }
}

/**
 * Handle one button press for the pending proposal.
 * Returns the outcome string, or null when nothing arrived in time.
 */
async function handleOne(pending, minutes) {
  const offset = pending.lastUpdateId ?? 0;
  const decision = minutes > 0 ? await waitForDecision(offset, minutes) : await pollDecision(offset);

  if (!decision) {
    console.log(`No decision yet on episode ${pending.episodeNumber}.`);
    return null;
  }

  console.log(`Decision: ${decision.action}`);

  // Consume the press on Telegram's side FIRST. This is what actually
  // guarantees one post per approval: local state can be lost if a CI push
  // fails, but a confirmed update is gone from the queue for good.
  await confirmUpdates(decision.maxUpdateId);

  // A tap on a superseded proposal must not act on the current one. Buttons
  // on old messages keep working forever, so without this a tap on the v2
  // message would publish v3, an image that was explicitly rejected.
  if (!pressMatchesPending(decision, pending)) {
    console.log(
      `Ignoring a press for episode ${decision.episodeNumber} attempt ${decision.attempt}; ` +
        `pending is episode ${pending.episodeNumber} attempt ${pending.attempt}.`
    );
    await ackButton(decision.callbackId, 'That is an older version. Use the newest message.');
    await sendMessage(
      `Ignored a tap on an older proposal (episode ${decision.episodeNumber}, attempt ${decision.attempt}).\n\n` +
        `Scroll to the newest message and use those buttons instead.`
    );
    writePending({ ...pending, lastUpdateId: decision.maxUpdateId });
    return 'ignored';
  }

  // Mirror it locally too, so a run that never reaches Telegram still knows.
  writePending({ ...pending, lastUpdateId: decision.maxUpdateId });

  const result = await applyDecision(decision.action, { ...pending, lastUpdateId: decision.maxUpdateId }, decision.callbackId);
  console.log(`Result: ${result}`);
  return result;
}

async function main() {
  const deadline = Date.now() + waitMinutes * 60_000;

  for (;;) {
    // Re-read every time round: a redraw replaces pending.json.
    const pending = readPending();
    if (pending.status !== 'awaiting') {
      console.log('Nothing is awaiting approval. Done.');
      return;
    }

    const remaining = Math.max(0, (deadline - Date.now()) / 60_000);
    const result = await handleOne(pending, remaining);

    // One-shot mode acts on a single press and leaves; the cron will be back.
    if (waitMinutes === 0 || result === null || TERMINAL.has(result)) return;

    // Still awaiting: a redraw, a rewrite, an unreachable image, or a tap on
    // an old message. Push whatever changed so an OK can succeed, then keep
    // listening for the next tap.
    if (result === 'redrawn' || result === 'rewritten') {
      persistInCI(`${result} episode ${pending.episodeNumber}`);
    }

    if (Date.now() >= deadline) {
      console.log('Time is up. The scheduled check will pick up any later press.');
      return;
    }
    console.log('Still listening.');
  }
}

main().catch(async (err) => {
  console.error(err.message);
  if (process.env.DEBUG) console.error(err.stack);
  try {
    await sendMessage(`Something went wrong handling your answer.\n\n<code>${err.message}</code>`);
  } catch {
    // ignore
  }
  process.exit(1);
});
