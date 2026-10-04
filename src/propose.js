/**
 * Daily entry point. Generates the next episode and asks for approval.
 *
 *   node src/propose.js            generate + send to Telegram
 *   node src/propose.js --dry-run  generate + save locally, touch nothing else
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { propose } from './decide.js';
import { writeEpisode, drawPanel, buildMotionPrompt } from './gemini.js';
import * as higgsfield from './higgsfield.js';
import { video } from './config.js';
import { readState, readBible, readCharacterRefs, readPending, runOncePerDay, SKIPPED, readTrends, writeTrends, today } from './store.js';
import { sendMessage, sendTrendOptions, drainUpdates, waitForDecision, confirmUpdates, ackButton, escapeHtml } from './telegram.js';
import { scoutTrends } from './trends.js';

/** How long to wait for a trend tap before auto-picking. */
const TREND_WAIT_MINUTES = Number(process.env.TREND_WAIT_MINUTES ?? 30);

/**
 * Scout today's trends, send them as buttons, and wait for Enguun's pick.
 *
 * Returns the trend object to build the episode around, or null for a normal
 * story episode. Never throws: a broken scout must not cost the day's post, it
 * just means a story episode like before trends existed.
 *
 * If an earlier cron slot already sent today's options (and died before
 * proposing), they are reused instead of sending a second list.
 */
async function pickTrend() {
  const episodeNumber = readState().episodeCount + 1;
  let t = readTrends();

  try {
    if (t.date !== today() || t.episodeNumber !== episodeNumber || !t.options?.length) {
      const scout = await scoutTrends(readState(), readBible());
      // Flush stale presses (yesterday's buttons) so they cannot count as today's pick.
      const baseline = await drainUpdates();
      const msg = await sendTrendOptions(scout, episodeNumber, TREND_WAIT_MINUTES);
      t = { date: today(), episodeNumber, ...scout, messageId: msg.message_id, lastUpdateId: baseline, picked: undefined };
      writeTrends(t);
    } else if (t.picked !== undefined) {
      // Already decided in an earlier slot.
      return t.picked === null ? null : t.options[t.picked];
    }
  } catch (err) {
    console.warn(`Trend scout failed (${err.message}). Going with a normal story episode.`);
    return null;
  }

  // Wait for a TREND/STORY tap on today's list. Anything else is a stale tap
  // on an old message: consume it and keep waiting.
  const deadline = Date.now() + TREND_WAIT_MINUTES * 60_000;
  let offset = t.lastUpdateId ?? 0;
  while (Date.now() < deadline) {
    const minutesLeft = (deadline - Date.now()) / 60_000;
    const d = await waitForDecision(offset, minutesLeft);
    if (!d) break;
    await confirmUpdates(d.maxUpdateId);
    offset = d.maxUpdateId;

    const forToday = d.episodeNumber === episodeNumber && (d.action === 'TREND' || d.action === 'STORY');
    if (!forToday) {
      await ackButton(d.callbackId, 'That is an old button. Pick from today\'s trend list.');
      continue;
    }

    const picked = d.action === 'TREND' ? d.trendIndex : null;
    const trend = picked === null ? null : t.options[picked] ?? null;
    await ackButton(d.callbackId, trend ? `Going with: ${trend.name}` : 'Just the story today.');
    writeTrends({ ...t, picked: trend ? picked : null, pickedBy: 'you', lastUpdateId: offset });
    return trend;
  }

  // No tap in time: the scout's own pick, which may be "nothing fits today".
  const auto = t.bestFit ?? null;
  writeTrends({ ...t, picked: auto, pickedBy: 'auto', lastUpdateId: offset });
  const trend = auto === null ? null : t.options[auto];
  await sendMessage(
    trend
      ? `No pick, so I went with <b>${escapeHtml(trend.name)}</b>. Tap another number on the list any time to rewrite.`
      : 'No pick and nothing fit today, so it is a normal story episode. Tap a number on the list to rewrite with a trend.'
  );
  return trend;
}

const dryRun = process.argv.includes('--dry-run');

async function dry() {
  const state = readState();
  const bible = readBible();
  const refs = readCharacterRefs();
  if (refs.length === 0) throw new Error('No character references. Run `npm run bootstrap` first.');

  // --trend: scout trends and build the dry-run episode around the best fit.
  let trend = null;
  if (process.argv.includes('--trend')) {
    const scout = await scoutTrends(state, bible);
    trend = scout.bestFit === null ? null : scout.options[scout.bestFit];
    console.log(`Trend: ${trend ? trend.name : '(none fits today)'}`);
  }

  // --video: make a Reel the way a video day would (costs about $0.35).
  const reel = process.argv.includes('--video');
  if (reel && !higgsfield.isConfigured()) throw new Error('--video needs HF_API_KEY_ID and HF_API_KEY_SECRET in .env.');

  const episode = await writeEpisode(state, bible, { trend, reel });
  console.log('\n--- EPISODE ---');
  console.log('Title:  ', episode.title);
  console.log('Scene:  ', episode.scene);
  if (reel) console.log('Motion: ', episode.motion);
  console.log('Caption:', episode.caption);
  console.log('Tags:   ', episode.hashtags.map((h) => `#${h}`).join(' '));

  fs.mkdirSync(paths.posts, { recursive: true });
  const stamp = Date.now();

  if (reel) {
    const { FRAME_NOTE } = await import('./decide.js');
    const { jpeg } = await drawPanel(episode.scene, bible, refs, { aspectRatios: [video.aspectRatio], frameNote: FRAME_NOTE });
    const framePath = path.join(paths.posts, `dryrun-${stamp}-frame.jpg`);
    fs.writeFileSync(framePath, jpeg);
    console.log(`\nSaved keyframe ${framePath}`);
    console.log('Animating with Higgsfield (1-4 minutes)...');
    const { videoUrl } = await higgsfield.animate(jpeg, buildMotionPrompt(episode.motion || 'They breathe and glance at each other. Camera locked off.'));
    const mp4 = await higgsfield.download(videoUrl);
    const out = path.join(paths.posts, `dryrun-${stamp}.mp4`);
    fs.writeFileSync(out, mp4);
    console.log(`Saved ${out} (${(mp4.length / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    const { jpeg, aspectRatio } = await drawPanel(episode.scene, bible, refs);
    const out = path.join(paths.posts, `dryrun-${stamp}.jpg`);
    fs.writeFileSync(out, jpeg);
    console.log(`\nSaved ${out} (${aspectRatio}, ${(jpeg.length / 1024).toFixed(0)} KB)`);
  }
  console.log('Nothing was sent to Telegram and nothing was posted.');
}

async function main() {
  if (dryRun) return dry();

  // Every message below goes through runOncePerDay for the same reason the
  // proposal itself does: propose runs from four cron slots, and without a
  // per-day claim each slot sends its own copy. That is not theoretical, it
  // shipped: two identical "still waiting on you" reminders arrived 30 minutes
  // apart because the early-return branches sat above the guard.

  // Not set up yet is a normal state, not a failure. Say so plainly and exit
  // green, rather than waking someone to a red workflow and a stack trace.
  if (!fs.existsSync(paths.bible) || readCharacterRefs().length === 0) {
    console.log('No characters yet. Nothing to post.');
    await runOncePerDay('lastSetupNagOn', () =>
      sendMessage(
        'Morning. No post today: the characters have not been created yet.\n\n' +
          'Run <code>npm run bootstrap</code> when you are ready, and I will start posting the day after.'
      )
    );
    return;
  }

  const pending = readPending();
  if (pending.status === 'awaiting') {
    console.log(`Episode ${pending.episodeNumber} is still awaiting a decision. Not generating another.`);
    await runOncePerDay('lastReminderOn', () =>
      sendMessage(
        `Reminder: episode ${pending.episodeNumber} is still waiting on you. ` +
          `Tap a button on the post above, or it will not go out.`
      )
    );
    return;
  }

  // The claim is written only after the proposal is actually sent, so a slot
  // that dies mid-generation leaves the next slot free to try again.
  const result = await runOncePerDay('lastProposedOn', async () => {
    const trend = await pickTrend();
    return propose({ mode: 'new', trend });
  });
  if (result === SKIPPED) console.log('Already proposed today. Nothing to do.');
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
