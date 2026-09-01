/**
 * Reads the latest Telegram button press and acts on it.
 *
 *   node src/check.js             check once and exit
 *   node src/check.js --wait 10   poll for up to 10 minutes first
 */
import { readPending, writePending } from './store.js';
import { pollDecision, waitForDecision, sendMessage, confirmUpdates, ackButton, pressMatchesPending } from './telegram.js';
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
    return;
  }

  // Mirror it locally too, so a run that never reaches Telegram still knows.
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
