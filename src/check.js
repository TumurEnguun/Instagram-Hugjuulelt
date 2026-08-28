/**
 * Reads the latest Telegram button press and acts on it.
 *
 *   node src/check.js             check once and exit
 *   node src/check.js --wait 10   poll for up to 10 minutes first
 */
import { readPending, writePending } from './store.js';
import { pollDecision, waitForDecision, sendMessage } from './telegram.js';
import { applyDecision } from './decide.js';

const waitIdx = process.argv.indexOf('--wait');
const waitMinutes = waitIdx !== -1 ? Number(process.argv[waitIdx + 1]) : 0;

async function main() {
  const pending = readPending();
  if (pending.status !== 'awaiting') {
    console.log('Nothing is awaiting approval. Done.');
    return;
  }

  const offset = pending.lastUpdateId ?? 0;
  const decision = waitMinutes > 0
    ? await waitForDecision(offset, waitMinutes)
    : await pollDecision(offset);

  if (!decision) {
    console.log(`No decision yet on episode ${pending.episodeNumber}.`);
    return;
  }

  console.log(`Decision: ${decision.action}`);

  // Record the offset before acting, so a crash mid-publish cannot cause the
  // same button press to be replayed on the next run.
  writePending({ ...pending, lastUpdateId: decision.maxUpdateId });

  const result = await applyDecision(decision.action, { ...pending, lastUpdateId: decision.maxUpdateId }, decision.callbackId);
  console.log(`Result: ${result}`);
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
