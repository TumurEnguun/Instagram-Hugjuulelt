/**
 * Daily entry point. Generates the next episode and asks for approval.
 *
 *   node src/propose.js            generate + send to Telegram
 *   node src/propose.js --dry-run  generate + save locally, touch nothing else
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { propose, today } from './decide.js';
import { writeEpisode, drawPanel } from './gemini.js';
import { readState, readBible, readCharacterRefs, readPending } from './store.js';
import { sendMessage } from './telegram.js';

const dryRun = process.argv.includes('--dry-run');

async function dry() {
  const state = readState();
  const bible = readBible();
  const refs = readCharacterRefs();
  if (refs.length === 0) throw new Error('No character references. Run `npm run bootstrap` first.');

  const episode = await writeEpisode(state, bible);
  console.log('\n--- EPISODE ---');
  console.log('Title:  ', episode.title);
  console.log('Scene:  ', episode.scene);
  console.log('Caption:', episode.caption);
  console.log('Tags:   ', episode.hashtags.map((h) => `#${h}`).join(' '));

  const { jpeg, aspectRatio } = await drawPanel(episode.scene, bible, refs);
  fs.mkdirSync(paths.posts, { recursive: true });
  const out = path.join(paths.posts, `dryrun-${Date.now()}.jpg`);
  fs.writeFileSync(out, jpeg);
  console.log(`\nSaved ${out} (${aspectRatio}, ${(jpeg.length / 1024).toFixed(0)} KB)`);
  console.log('Nothing was sent to Telegram and nothing was posted.');
}

async function main() {
  if (dryRun) return dry();

  // Not set up yet is a normal state, not a failure. Say so plainly and exit
  // green, rather than waking someone to a red workflow and a stack trace.
  if (!fs.existsSync(paths.bible) || readCharacterRefs().length === 0) {
    console.log('No characters yet. Nothing to post.');
    await sendMessage(
      'Morning. No post today: the characters have not been created yet.\n\n' +
        'Run <code>npm run bootstrap</code> when you are ready, and I will start posting the day after.'
    );
    return;
  }

  // propose runs from several cron slots because GitHub drops most scheduled
  // runs. Whichever one actually fires does the work; the rest stop here.
  const state = readState();
  if (state.lastProposedOn === today()) {
    console.log(`Already proposed today (${state.lastProposedOn}). Nothing to do.`);
    return;
  }

  const pending = readPending();
  if (pending.status === 'awaiting') {
    console.log(`Episode ${pending.episodeNumber} is still awaiting a decision. Not generating another.`);
    await sendMessage(
      `Reminder: episode ${pending.episodeNumber} is still waiting on you. ` +
        `Tap a button on the post above, or it will not go out.`
    );
    return;
  }

  await propose({ mode: 'new' });
}

main().catch(async (err) => {
  console.error(err.message);
  if (process.env.DEBUG) console.error(err.stack);
  if (!dryRun) {
    try {
      await sendMessage(`Today's post failed to generate.\n\n<code>${err.message}</code>`);
    } catch {
      // Telegram itself may be the thing that is broken.
    }
  }
  process.exit(1);
});
