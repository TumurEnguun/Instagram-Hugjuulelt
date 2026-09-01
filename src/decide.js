/**
 * The approval state machine, shared by propose.js and check.js.
 *
 * Every path here is deliberately fail-closed: if anything is missing or
 * ambiguous, nothing gets posted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { writeEpisode, drawPanel } from './gemini.js';
import { readState, writeState, readBible, readCharacterRefs, writePending, clearPending, recordEpisode } from './store.js';
import { sendProposal, sendMessage, ackButton, drainUpdates, escapeHtml } from './telegram.js';
import { publishPhoto } from './instagram.js';
import * as facebook from './facebook.js';
import { publicUrlFor, waitUntilReachable } from './host.js';

/**
 * Generate a fresh proposal and put it in front of Enguun.
 * `mode` is 'new' (write a new episode) or 'redraw' (keep the story, new art).
 */
export async function propose({ mode = 'new', previous = null } = {}) {
  const state = readState();
  const bible = readBible();
  const refs = readCharacterRefs();

  if (refs.length === 0) {
    throw new Error('No character references in characters/. Run `npm run bootstrap` first.');
  }

  const episodeNumber = state.episodeCount + 1;
  const attempt = (previous?.attempt ?? 0) + 1;

  const episode =
    mode === 'redraw' && previous
      ? previous.episode
      : await writeEpisode(state, bible, { avoidScene: previous?.episode?.scene ?? '' });

  console.log(`Drawing episode ${episodeNumber} (attempt ${attempt}): ${episode.title}`);
  const { jpeg, aspectRatio } = await drawPanel(episode.scene, bible, refs);

  // A new filename every attempt, so the CDN never serves a stale image.
  const filename = `ep-${String(episodeNumber).padStart(4, '0')}-v${attempt}.jpg`;
  fs.mkdirSync(paths.posts, { recursive: true });
  fs.writeFileSync(path.join(paths.posts, filename), jpeg);

  // Clean up the superseded attempt so the repo does not accumulate rejects.
  if (previous?.filename && previous.filename !== filename) {
    fs.rmSync(path.join(paths.posts, previous.filename), { force: true });
  }

  // A redraw continues an existing conversation, so keep its offset. A fresh
  // proposal starts clean, so flush anything stale first.
  const baseline = previous?.lastUpdateId ?? (await drainUpdates());

  const sent = await sendProposal(jpeg, episode, episodeNumber, attempt);

  writePending({
    status: 'awaiting',
    episodeNumber,
    attempt,
    episode,
    filename,
    aspectRatio,
    telegramMessageId: sent.message_id,
    lastUpdateId: baseline,
    createdAt: new Date().toISOString(),
  });

  console.log(`Proposal sent to Telegram: ${filename} (${aspectRatio})`);
  return { episodeNumber, filename };
}


/** Build the final Instagram caption from the episode. */
function buildCaption(episode) {
  const tags = episode.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ');
  return `${episode.caption}\n\n${tags}`.slice(0, 2200);
}

/**
 * Act on a button press.
 * Returns a short string describing what happened, for the workflow log.
 */
export async function applyDecision(action, pending, callbackId = null) {
  const toast = {
    OK: 'Publishing to Instagram...',
    AGAIN: 'Redrawing...',
    REWRITE: 'Writing a new episode...',
    SKIP: 'Skipped.',
  }[action];
  if (callbackId) await ackButton(callbackId, toast ?? 'Working...');

  switch (action) {
    case 'OK': {
      const url = publicUrlFor(pending.filename);
      console.log(`Verifying image is publicly reachable: ${url}`);

      if (!(await waitUntilReachable(url))) {
        await sendMessage(
          `Could not publish episode ${pending.episodeNumber}.\n\n` +
            `The image is not reachable yet at:\n${url}\n\n` +
            `It stays pending, so tap OK again in a few minutes.`
        );
        return 'image-not-reachable';
      }

      const caption = buildCaption(pending.episode);
      const mediaId = await publishPhoto(url, caption);

      // Facebook is a bonus channel. Instagram has already succeeded by this
      // point, so a Facebook failure is reported but never throws: it must not
      // leave the post half-recorded or trigger a retry that double-posts.
      let fbNote = '';
      if (facebook.isConfigured()) {
        try {
          await facebook.publishPhoto(url, caption);
          fbNote = '\nAlso posted to your Facebook Page.';
        } catch (err) {
          console.warn(`Facebook cross-post failed: ${err.message}`);
          fbNote = `\nInstagram worked, but the Facebook cross-post failed:\n<code>${escapeHtml(err.message)}</code>`;
        }
      }

      const state = recordEpisode(readState(), pending.episode, mediaId);
      writeState(state);
      clearPending();

      // Instagram has its own copy now, so drop ours.
      fs.rmSync(path.join(paths.posts, pending.filename), { force: true });

      await sendMessage(
        `Posted. Episode ${pending.episodeNumber}: <b>${escapeHtml(pending.episode.title)}</b> is live on Instagram.${fbNote}`
      );
      return 'published';
    }

    case 'AGAIN':
      await propose({ mode: 'redraw', previous: pending });
      return 'redrawn';

    case 'REWRITE':
      await propose({ mode: 'new', previous: pending });
      return 'rewritten';

    case 'SKIP':
      fs.rmSync(path.join(paths.posts, pending.filename), { force: true });
      clearPending();
      await sendMessage(`Skipped episode ${pending.episodeNumber}. Nothing was posted. Back tomorrow.`);
      return 'skipped';

    default:
      console.warn(`Unknown action "${action}", ignoring.`);
      return 'ignored';
  }
}
