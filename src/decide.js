/**
 * The approval state machine, shared by propose.js and check.js.
 *
 * Every path here is deliberately fail-closed: if anything is missing or
 * ambiguous, nothing gets posted.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { paths, video, image } from './config.js';
import { writeEpisode, drawPanel, buildMotionPrompt } from './gemini.js';
import * as higgsfield from './higgsfield.js';
import { readState, writeState, readBible, readCharacterRefs, writePending, clearPending, recordEpisode, readTrends, writeTrends, today } from './store.js';
import { sendProposal, sendVideoProposal, sendMessage, ackButton, drainUpdates, escapeHtml } from './telegram.js';
import { publishPhoto, publishReel } from './instagram.js';
import * as facebook from './facebook.js';
import { publicUrlFor, waitUntilReachable } from './host.js';

/** Whole days between two YYYY-MM-DD stamps. */
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * Is today a Reel day? Every `video.everyNDays` days counted from the last Reel
 * that actually went live, so a skipped or photo-instead day rolls forward.
 */
export function isReelDay(state) {
  if (!higgsfield.isConfigured()) return false;
  if (!state.lastVideoOn) return true;
  return daysBetween(state.lastVideoOn, today()) >= video.everyNDays;
}

export const FRAME_NOTE = `This painting is the FIRST FRAME of a 5-second animation, shown full screen on a vertical phone.
- Tall vertical composition. Both hamsters fully in frame, in the middle band of the picture, with clear space around them to move.
- Keep the top 15% and bottom 20% free of anything important; Instagram overlays its interface there.
- Freeze the moment just BEFORE the action: a clear, stable setup pose. No motion blur, no mid-air poses.
- Clean, readable silhouettes with a little separation between the two hamsters and from the props, so an animator can move them without them merging.`;

/** Crop a 9:16 keyframe to 4:5 for the photo fallback (Instagram feed photos max out at 4:5). */
async function cropForFeed(jpeg) {
  const meta = await sharp(jpeg).metadata();
  const height = Math.min(meta.height, Math.round((meta.width * 5) / 4));
  const top = Math.max(0, Math.round((meta.height - height) / 2));
  return sharp(jpeg).extract({ left: 0, top, width: meta.width, height }).jpeg({ quality: image.jpegQuality }).toBuffer();
}

const IDLE_MOTION =
  '0-5s: they stay in their poses and simply breathe; whiskers twitch, ears flick once, one hamster glances at the other and back. Camera locked off. Sound: quiet room tone.';

/**
 * Generate a fresh proposal and put it in front of Enguun.
 * `mode` is 'new' (write a new episode), 'redraw' (keep the story, new art), or
 * 'reanimate' (Reels only: keep the story and the painted frame, new animation).
 * `trend` is a trend option to build the episode around. Leave it undefined to
 * keep whatever the previous attempt used; pass null for no trend.
 * `reel` forces a Reel or a photo; undefined keeps the previous attempt's kind,
 * or asks isReelDay() for a brand new episode.
 */
export async function propose({ mode = 'new', previous = null, trend, reel } = {}) {
  const state = readState();
  const bible = readBible();
  const refs = readCharacterRefs();

  if (refs.length === 0) {
    throw new Error('No character references in characters/. Run `npm run bootstrap` first.');
  }

  const episodeNumber = state.episodeCount + 1;
  const attempt = (previous?.attempt ?? 0) + 1;
  const activeTrend = trend !== undefined ? trend : previous?.trend ?? null;
  const wantReel = reel !== undefined ? reel : previous ? previous.kind === 'video' : isReelDay(state);
  const isReel = wantReel && higgsfield.isConfigured();

  const episode =
    (mode === 'redraw' || mode === 'reanimate') && previous
      ? previous.episode
      : await writeEpisode(state, bible, {
          // Only avoid the old scene when it was rejected under the same trend;
          // switching trend already guarantees something different.
          avoidScene: trend === undefined ? previous?.episode?.scene ?? '' : '',
          trend: activeTrend,
          reel: isReel,
        });

  const stem = `ep-${String(episodeNumber).padStart(4, '0')}-v${attempt}`;
  fs.mkdirSync(paths.posts, { recursive: true });

  // A redraw continues an existing conversation, so keep its offset. A fresh
  // proposal starts clean, so flush anything stale first.
  const baseline = previous?.lastUpdateId ?? (await drainUpdates());

  const cleanupPrevious = (keep = []) => {
    for (const f of [previous?.filename, previous?.frameFilename]) {
      if (f && !keep.includes(f)) fs.rmSync(path.join(paths.posts, f), { force: true });
    }
  };

  // ---------- Reel ----------
  if (isReel) {
    let frame, filename, frameFilename;
    if (mode === 'reanimate' && previous?.frameFilename) {
      frameFilename = previous.frameFilename;
      filename = previous.filename;
      frame = fs.readFileSync(path.join(paths.posts, frameFilename));
    } else {
      console.log(`Painting Reel keyframe for episode ${episodeNumber} (attempt ${attempt}): ${episode.title}`);
      ({ jpeg: frame } = await drawPanel(episode.scene, bible, refs, { aspectRatios: [video.aspectRatio], frameNote: FRAME_NOTE }));
      frameFilename = `${stem}-frame.jpg`;
      filename = `${stem}.jpg`;
      fs.writeFileSync(path.join(paths.posts, frameFilename), frame);
      // The 4:5 crop is the "Post as photo" fallback and is what Instagram
      // fetches if that button is used, so it is committed like any photo.
      fs.writeFileSync(path.join(paths.posts, filename), await cropForFeed(frame));
      cleanupPrevious([filename, frameFilename]);
    }

    try {
      console.log('Animating with Higgsfield...');
      const { videoUrl, requestId } = await higgsfield.animate(frame, buildMotionPrompt(episode.motion?.trim() || IDLE_MOTION));
      const mp4 = await higgsfield.download(videoUrl);
      const sent = await sendVideoProposal(mp4, episode, episodeNumber, attempt);

      writePending({
        status: 'awaiting',
        kind: 'video',
        episodeNumber,
        attempt,
        episode,
        trend: activeTrend,
        filename,
        frameFilename,
        aspectRatio: video.aspectRatio,
        videoUrl,
        videoRequestId: requestId,
        telegramMessageId: sent.message_id,
        lastUpdateId: baseline,
        createdAt: new Date().toISOString(),
      });
      console.log(`Reel proposal sent to Telegram: ${videoUrl}`);
      return { episodeNumber, filename };
    } catch (err) {
      // A failed animation must not cost the day. Offer the painted frame as a
      // normal photo post instead; Higgsfield does not bill failed jobs.
      console.warn(`Reel failed (${err.message}). Falling back to a photo.`);
      await sendMessage(`The Reel did not work today, so here is the photo version instead.\n<code>${escapeHtml(err.message)}</code>`);
      const photo = fs.readFileSync(path.join(paths.posts, filename));
      fs.rmSync(path.join(paths.posts, frameFilename), { force: true });
      const sent = await sendProposal(photo, episode, episodeNumber, attempt);
      writePending({
        status: 'awaiting',
        kind: 'photo',
        episodeNumber,
        attempt,
        episode,
        trend: activeTrend,
        filename,
        aspectRatio: '4:5',
        telegramMessageId: sent.message_id,
        lastUpdateId: baseline,
        createdAt: new Date().toISOString(),
      });
      return { episodeNumber, filename };
    }
  }

  // ---------- Photo ----------
  console.log(`Drawing episode ${episodeNumber} (attempt ${attempt}): ${episode.title}`);
  const { jpeg, aspectRatio } = await drawPanel(episode.scene, bible, refs);

  // A new filename every attempt, so the CDN never serves a stale image.
  const filename = `${stem}.jpg`;
  fs.writeFileSync(path.join(paths.posts, filename), jpeg);
  cleanupPrevious([filename]);

  const sent = await sendProposal(jpeg, episode, episodeNumber, attempt);

  writePending({
    status: 'awaiting',
    kind: 'photo',
    episodeNumber,
    attempt,
    episode,
    trend: activeTrend,
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

/** Publish an approved Reel. Mirrors the photo OK path. */
async function publishReelPost(pending) {
  const caption = buildCaption(pending.episode);
  const mediaId = await publishReel(pending.videoUrl, caption);

  let fbNote = '';
  if (facebook.isConfigured()) {
    try {
      await facebook.publishVideo(pending.videoUrl, caption);
      fbNote = '\nAlso posted to your Facebook Page.';
    } catch (err) {
      console.warn(`Facebook video cross-post failed: ${err.message}`);
      fbNote = `\nInstagram worked, but the Facebook cross-post failed:\n<code>${escapeHtml(err.message)}</code>`;
    }
  }

  const state = recordEpisode(readState(), pending.episode, mediaId);
  state.lastVideoOn = today();
  writeState(state);
  clearPending();
  for (const f of [pending.filename, pending.frameFilename]) {
    if (f) fs.rmSync(path.join(paths.posts, f), { force: true });
  }

  await sendMessage(
    `Posted. Episode ${pending.episodeNumber}: <b>${escapeHtml(pending.episode.title)}</b> is live as a Reel.${fbNote}`
  );
  return 'published';
}

/**
 * Act on a button press.
 * Returns a short string describing what happened, for the workflow log.
 */
export async function applyDecision(action, pending, callbackId = null, decision = {}) {
  const toast = {
    OK: 'Publishing to Instagram...',
    AGAIN: 'Redrawing...',
    REWRITE: 'Writing a new episode...',
    SKIP: 'Skipped.',
    PHOTO: 'Posting the still as a photo...',
    TREND: 'Rewriting with that trend...',
    STORY: 'Rewriting without a trend...',
  }[action];
  if (callbackId) await ackButton(callbackId, toast ?? 'Working...');

  if (action === 'OK' && pending.kind === 'video') return publishReelPost(pending);

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
      if (pending.kind === 'video') {
        // Every re-animation is another paid clip.
        if (pending.attempt >= video.maxAttempts) {
          await sendMessage(
            `That is ${pending.attempt} animations for this episode already, which is the limit. ` +
              `Post it, post as photo, write a new story, or skip.`
          );
          return 'ignored';
        }
        await propose({ mode: 'reanimate', previous: pending });
        return 'redrawn';
      }
      await propose({ mode: 'redraw', previous: pending });
      return 'redrawn';

    // Reel not good enough: publish the 4:5 crop of the painted frame instead.
    case 'PHOTO':
      if (pending.kind !== 'video') return 'ignored';
      fs.rmSync(path.join(paths.posts, pending.frameFilename ?? ''), { force: true });
      return applyDecision('OK', { ...pending, kind: 'photo' });

    case 'REWRITE':
      await propose({ mode: 'new', previous: pending });
      return 'rewritten';

    // A trend tapped after the proposal already arrived: same episode number,
    // rewritten around the newly picked trend (or none, for STORY).
    case 'TREND': {
      const trends = readTrends();
      const picked = trends.options?.[decision.trendIndex];
      if (!picked) {
        await sendMessage('That trend list is out of date. Nothing changed.');
        return 'ignored';
      }
      writeTrends({ ...trends, picked: decision.trendIndex, pickedBy: 'you' });
      await propose({ mode: 'new', previous: pending, trend: picked });
      return 'rewritten';
    }

    case 'STORY':
      writeTrends({ ...readTrends(), picked: null, pickedBy: 'you' });
      await propose({ mode: 'new', previous: pending, trend: null });
      return 'rewritten';

    case 'SKIP':
      fs.rmSync(path.join(paths.posts, pending.filename), { force: true });
      if (pending.frameFilename) fs.rmSync(path.join(paths.posts, pending.frameFilename), { force: true });
      clearPending();
      await sendMessage(`Skipped episode ${pending.episodeNumber}. Nothing was posted. Back tomorrow.`);
      return 'skipped';

    default:
      console.warn(`Unknown action "${action}", ignoring.`);
      return 'ignored';
  }
}
