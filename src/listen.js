/**
 * Live listener. Watches Telegram continuously and acts on button presses
 * within a couple of seconds, instead of waiting for the next scheduled check.
 *
 *   npm run listen
 *
 * Use this while you are actively iterating on a post. The scheduled workflow
 * only polls every 30 minutes, which is fine when it is running unattended but
 * makes the buttons feel broken when you are sitting there watching.
 *
 * Ctrl+C to stop.
 */
import { execFileSync } from 'node:child_process';
import { readPending, writePending } from './store.js';
import { pollDecision, confirmUpdates, sendMessage, ackButton, pressMatchesPending } from './telegram.js';
import { applyDecision } from './decide.js';

const POLL_MS = 3000;

const argOr = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? Number(process.argv[i + 1]) : fallback;
};
const minutes = argOr('--minutes', 30);
const noPush = process.argv.includes('--no-push');

/**
 * Instagram fetches the image from the repo, so a freshly drawn panel has to be
 * pushed before an approval can succeed. The scheduled workflow does this in a
 * separate step; running locally there is nothing else to do it.
 */
function persist(label) {
  if (noPush) return;
  try {
    execFileSync('git', ['add', '-A', 'posts', 'pending.json', 'story-state.json'], { stdio: 'pipe' });
    const staged = execFileSync('git', ['diff', '--staged', '--name-only'], { encoding: 'utf8' }).trim();
    if (!staged) return;
    execFileSync('git', ['commit', '-m', label], { stdio: 'pipe' });

    // Rebase before pushing: the cloud check workflow writes the same files,
    // and without this a concurrent cloud push makes the local push a
    // non-fast-forward that used to be warned about and then ignored.
    execFileSync('git', ['pull', '--rebase', '--autostash', 'origin', 'HEAD'], { stdio: 'pipe' });
    execFileSync('git', ['push', '--quiet', 'origin', 'HEAD'], { stdio: 'pipe' });
    console.log(`   pushed (${label})`);
  } catch (err) {
    console.warn('   COULD NOT PUSH: ' + (err.stderr?.toString().trim() || err.message));
    console.warn('   Run: git pull --rebase && git push');
    console.warn('   Until you do, the cloud still thinks this episode is awaiting a decision.');
  }
}

async function main() {
  const deadline = Date.now() + minutes * 60_000;
  console.log(`Listening for button presses. Ctrl+C to stop. (up to ${minutes} min)\n`);

  let idle = 0;
  let pushedOnce = false;

  while (Date.now() < deadline) {
    const pending = readPending();

    if (pending.status !== 'awaiting') {
      console.log('\nNothing is awaiting approval. Done.');
      return;
    }

    // A locally generated proposal has never been pushed, so its image is not
    // on raw.githubusercontent.com and the very first OK would fail the
    // reachability check. Push once up front rather than after the fact.
    if (!pushedOnce) {
      pushedOnce = true;
      persist(`Propose episode ${pending.episodeNumber} (attempt ${pending.attempt})`);
    }

    const decision = await pollDecision(pending.lastUpdateId ?? 0).catch((err) => {
      console.warn('   poll failed (' + err.message + '), retrying');
      return null;
    });

    if (!decision) {
      // Keep the waiting state visible without scrolling the terminal.
      process.stdout.write(`\r   waiting on episode ${pending.episodeNumber}... ${++idle * (POLL_MS / 1000)}s`);
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    idle = 0;
    console.log(`\n\n-> ${decision.action}`);

    // Consume it on Telegram's side first, so one press can never act twice.
    await confirmUpdates(decision.maxUpdateId);
    writePending({ ...pending, lastUpdateId: decision.maxUpdateId });

    // Same guard as check.js: a tap on a superseded message must not act on
    // whatever is pending now.
    if (!pressMatchesPending(decision, pending)) {
      console.log(
        `   ignoring a press for episode ${decision.episodeNumber} attempt ${decision.attempt}` +
          ` (pending is ${pending.episodeNumber}/${pending.attempt})`
      );
      await ackButton(decision.callbackId, 'That is an older version. Use the newest message.');
      continue;
    }

    const result = await applyDecision(
      decision.action,
      { ...pending, lastUpdateId: decision.maxUpdateId },
      decision.callbackId
    );
    console.log(`   ${result}`);

    // Persist on EVERY outcome. Publishing and skipping are the two terminal
    // state changes, and they used to return without committing anything: the
    // remote kept saying "awaiting" for an already-published episode, so the
    // next morning's run sent a reminder instead of a new post, every day.
    persist(`${result} episode ${pending.episodeNumber}`);

    if (result === 'redrawn' || result === 'rewritten') {
      console.log('   new version sent, still listening\n');
    } else {
      console.log('\nDone.');
      return;
    }
  }

  console.log('\n\nStopped listening. The scheduled workflow will pick up any later press.');
}

main().catch(async (err) => {
  console.error('\n' + err.message);
  if (process.env.DEBUG) console.error(err.stack);
  try {
    await sendMessage(`The listener hit an error.\n\n<code>${err.message}</code>`);
  } catch {
    // Telegram may itself be the problem.
  }
  process.exit(1);
});
