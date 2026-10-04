/**
 * Telegram is the approval channel. No webhook server: we send a photo with
 * inline buttons, then read the answer back later with getUpdates. That keeps
 * the whole system inside GitHub Actions with nothing else to host.
 */
import { need } from './config.js';
import { retryFetch } from './net.js';
import { stashUpdates } from './store.js';

// Telegram REMEMBERS allowed_updates between calls. Asking for callback_query
// alone would make it silently drop every video Enguun sends the bot.
const UPDATE_TYPES = ['callback_query', 'message'];

const api = (method) => `https://api.telegram.org/bot${need('TELEGRAM_BOT_TOKEN')}/${method}`;

async function call(method, body) {
  const res = await retryFetch(api(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`);
  return json.result;
}

export async function sendMessage(text) {
  return call('sendMessage', {
    chat_id: need('TELEGRAM_CHAT_ID'),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/** Send the proposed post: image bytes uploaded directly, plus the four buttons. */
export async function sendProposal(jpegBuffer, episode, episodeNumber, attempt) {
  const caption = [
    `<b>Episode ${episodeNumber}: ${escapeHtml(episode.title)}</b>`,
    '',
    escapeHtml(episode.caption),
    '',
    episode.hashtags.map((h) => `#${h}`).join(' '),
  ].join('\n');

  const form = new FormData();
  form.append('chat_id', need('TELEGRAM_CHAT_ID'));
  form.append('caption', caption.slice(0, 1024));
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([jpegBuffer], { type: 'image/jpeg' }), 'post.jpg');
  // Each button carries which episode and attempt it belongs to. Old proposal
  // messages keep working keyboards forever, so a bare "OK" is ambiguous: a tap
  // on a superseded redraw would approve whatever happens to be pending now,
  // publishing an image that was explicitly rejected. Telegram allows 64 bytes
  // of callback_data, and "REWRITE:9999:99" is well inside that.
  const tag = (action) => `${action}:${episodeNumber}:${attempt}`;

  form.append(
    'reply_markup',
    JSON.stringify({
      inline_keyboard: [
        [
          { text: 'OK, post it', callback_data: tag('OK') },
          { text: 'Redraw', callback_data: tag('AGAIN') },
        ],
        [
          { text: 'New story', callback_data: tag('REWRITE') },
          { text: 'Skip today', callback_data: tag('SKIP') },
        ],
      ],
    })
  );

  const res = await retryFetch(api('sendPhoto'), { method: 'POST', body: form });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram sendPhoto failed: ${json.description}`);
  return json.result;
}

/**
 * Send a Reel proposal: the clip itself, uploaded so it plays inline, plus
 * buttons. "Redraw" re-animates the same painted frame (one more paid clip);
 * "Post as photo" falls back to the still if the animation is not good enough.
 */
export async function sendVideoProposal(mp4Buffer, episode, episodeNumber, attempt) {
  const caption = [
    `🎬 <b>Reel, episode ${episodeNumber}: ${escapeHtml(episode.title)}</b>`,
    '',
    escapeHtml(episode.caption),
    '',
    episode.hashtags.map((h) => `#${h}`).join(' '),
  ].join('\n');
  const tag = (action) => `${action}:${episodeNumber}:${attempt}`;

  const form = new FormData();
  form.append('chat_id', need('TELEGRAM_CHAT_ID'));
  form.append('caption', caption.slice(0, 1024));
  form.append('parse_mode', 'HTML');
  form.append('supports_streaming', 'true');
  form.append('video', new Blob([mp4Buffer], { type: 'video/mp4' }), 'reel.mp4');
  form.append(
    'reply_markup',
    JSON.stringify({
      inline_keyboard: [
        [
          { text: 'OK, post the Reel', callback_data: tag('OK') },
          { text: 'Re-animate', callback_data: tag('AGAIN') },
        ],
        [
          { text: 'Post as photo', callback_data: tag('PHOTO') },
          { text: 'New story', callback_data: tag('REWRITE') },
        ],
        [{ text: 'Skip today', callback_data: tag('SKIP') }],
      ],
    })
  );

  const res = await retryFetch(api('sendVideo'), { method: 'POST', body: form }, { timeoutMs: 120_000 });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram sendVideo failed: ${json.description}`);
  return json.result;
}

/**
 * Send today's trend options as buttons. Tapping one decides what tomorrow's
 * writer builds the episode around; "Just the story" skips trends for the day.
 */
export async function sendTrendOptions(scout, episodeNumber, waitMinutes) {
  const lines = [`<b>Trends for episode ${episodeNumber}</b>. Pick one for the hamsters:`, ''];
  scout.options.forEach((o, i) => {
    const best = i === scout.bestFit ? '  ⭐' : '';
    lines.push(`<b>${i + 1}. ${escapeHtml(o.name)}</b>${best}`);
    lines.push(escapeHtml(o.what));
    lines.push(`<i>Hamsters: ${escapeHtml(o.hamsterAngle)}</i>`);
    lines.push('');
  });
  const fallback = scout.bestFit === null ? 'just the story' : `#${scout.bestFit + 1}`;
  lines.push(`No tap in ${waitMinutes} min and I go with ${fallback}.`);
  if (scout.bioIdea) lines.push('', `Bio idea (paste it in Instagram yourself): ${escapeHtml(scout.bioIdea)}`);

  const numbers = scout.options.map((_, i) => ({ text: String(i + 1), callback_data: `TREND:${episodeNumber}:${i}` }));
  return call('sendMessage', {
    chat_id: need('TELEGRAM_CHAT_ID'),
    text: lines.join('\n').slice(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [numbers, [{ text: 'No trend, just the story', callback_data: `STORY:${episodeNumber}:0` }]],
    },
  });
}

/**
 * Look for a button press newer than `offset`.
 * Returns { action, updateId, callbackId } or null if nothing new.
 * Always takes the LATEST press, so changing your mind works.
 *
 * `longPollSeconds` > 0 asks Telegram to hold the request open until a press
 * arrives or the time runs out, so a tap is seen within about a second
 * instead of at the next fixed poll. Keep it under retryFetch's 30s timeout.
 */
export async function pollDecision(offset = 0, { longPollSeconds = 0 } = {}) {
  const res = await retryFetch(api('getUpdates'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset: offset ? offset + 1 : undefined,
      timeout: longPollSeconds,
      allowed_updates: UPDATE_TYPES,
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram getUpdates failed: ${json.description}`);

  stashUpdates(json.result);
  // Remix buttons are handled by remix.js from the stash, not here.
  const presses = json.result.filter((u) => u.callback_query && !String(u.callback_query.data ?? '').startsWith('RMX'));
  if (presses.length === 0) {
    // Only messages or remix taps, all stashed already. Confirm them so a long
    // poll does not keep returning the same update instantly in a busy loop.
    if (json.result.length) await confirmUpdates(json.result[json.result.length - 1].update_id);
    return null;
  }

  const latest = presses[presses.length - 1];
  const [action, episodeNumber, attempt] = String(latest.callback_query.data).split(':');

  return {
    action,
    // Undefined for presses on messages sent before buttons were tagged.
    // Callers treat that as "cannot verify" rather than as a mismatch.
    episodeNumber: episodeNumber === undefined ? undefined : Number(episodeNumber),
    attempt: attempt === undefined ? undefined : Number(attempt),
    // Trend buttons carry "TREND:<episode>:<option index>".
    trendIndex: action === 'TREND' ? Number(attempt) : undefined,
    updateId: latest.update_id,
    callbackId: latest.callback_query.id,
    // Highest id seen, so we acknowledge everything we just read.
    maxUpdateId: json.result[json.result.length - 1].update_id,
  };
}

/**
 * Does this press belong to the proposal currently awaiting a decision?
 *
 * Guards against a tap on a superseded message. Presses from before buttons
 * carried identity have no episode number; those are allowed through, since
 * rejecting them would strand any proposal still on screen from an older
 * version of the bot.
 */
export function pressMatchesPending(decision, pending) {
  if (decision.episodeNumber === undefined) return true;
  // Trend picks belong to the episode, not to one attempt: tapping a different
  // trend after the proposal arrived means "rewrite it with this one".
  if (decision.action === 'TREND' || decision.action === 'STORY') {
    return decision.episodeNumber === pending.episodeNumber;
  }
  return decision.episodeNumber === pending.episodeNumber && decision.attempt === pending.attempt;
}

/**
 * Clear out any button presses still sitting in the queue and return the
 * highest update id seen.
 *
 * Without this, a leftover press from yesterday would be read as the answer
 * to today's brand new post, which could publish something you never saw.
 */
export async function drainUpdates() {
  const res = await retryFetch(api('getUpdates'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeout: 0, allowed_updates: UPDATE_TYPES }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram getUpdates failed: ${json.description}`);
  if (json.result.length === 0) return 0;
  stashUpdates(json.result);

  const maxId = json.result[json.result.length - 1].update_id;

  // Re-requesting with a higher offset is how Telegram is told these are
  // handled; it drops them from the queue for good.
  await retryFetch(api('getUpdates'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset: maxId + 1, timeout: 0, allowed_updates: UPDATE_TYPES }),
  });
  return maxId;
}

/**
 * Tell Telegram a press is consumed, so it is dropped from the queue for good.
 *
 * This is the authoritative guard against posting twice. Recording the offset
 * in pending.json is not enough on its own, because in CI that file only
 * survives if the commit and push succeed. If a push fails, the next run would
 * otherwise read the same press again and publish a second copy.
 *
 * Deliberately called BEFORE acting on the decision. Losing a press means
 * nothing happens and you tap again; keeping one risks a duplicate post.
 */
export async function confirmUpdates(upToId) {
  await retryFetch(api('getUpdates'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset: upToId + 1, timeout: 0, allowed_updates: UPDATE_TYPES }),
  });
}

/**
 * For remix.js: pull pending updates into the stash. Confirms them only up to
 * (not including) the first approval-button press, so a tap meant for the
 * daily proposal is still there for check.js.
 */
export async function syncUpdates() {
  const res = await retryFetch(api('getUpdates'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeout: 0, allowed_updates: UPDATE_TYPES }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram getUpdates failed: ${json.description}`);
  stashUpdates(json.result);

  let safeUpTo = 0;
  for (const u of json.result) {
    const isProposalPress = u.callback_query && !String(u.callback_query.data ?? '').startsWith('RMX');
    if (isProposalPress) break;
    safeUpTo = u.update_id;
  }
  if (safeUpTo) await confirmUpdates(safeUpTo);
}

/** Download a file the user sent (bots can fetch up to 20 MB). */
export async function downloadFile(fileId) {
  const info = await call('getFile', { file_id: fileId });
  const res = await retryFetch(`https://api.telegram.org/file/bot${need('TELEGRAM_BOT_TOKEN')}/${info.file_path}`, {}, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`Downloading from Telegram failed (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/** Send a photo with arbitrary buttons. */
export async function sendPhotoWithButtons(jpeg, caption, inlineKeyboard) {
  const form = new FormData();
  form.append('chat_id', need('TELEGRAM_CHAT_ID'));
  form.append('caption', caption.slice(0, 1024));
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'frame.jpg');
  form.append('reply_markup', JSON.stringify({ inline_keyboard: inlineKeyboard }));
  const res = await retryFetch(api('sendPhoto'), { method: 'POST', body: form });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram sendPhoto failed: ${json.description}`);
  return json.result;
}

/** Send a video (bytes) with a caption. */
export async function sendVideoFile(mp4, caption, filename = 'reel.mp4') {
  const form = new FormData();
  form.append('chat_id', need('TELEGRAM_CHAT_ID'));
  form.append('caption', caption.slice(0, 1024));
  form.append('parse_mode', 'HTML');
  form.append('supports_streaming', 'true');
  form.append('video', new Blob([mp4], { type: 'video/mp4' }), filename);
  const res = await retryFetch(api('sendVideo'), { method: 'POST', body: form }, { timeoutMs: 120_000 });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram sendVideo failed: ${json.description}`);
  return json.result;
}

/** Stops the spinner on the tapped button and shows a toast. */
export async function ackButton(callbackId, text) {
  try {
    await call('answerCallbackQuery', { callback_query_id: callbackId, text });
  } catch {
    // A callback id older than ~15 minutes expires. Not worth failing the run.
  }
}

/**
 * Wait up to `minutes` for a decision.
 *
 * Long-polls Telegram, so a press is seen almost immediately. A failed poll
 * does not end the wait: retryFetch has already tried four times, and one bad
 * minute at api.telegram.org should not close an hour-long window and leave
 * the next tap sitting in the queue until the cron comes round.
 */
export async function waitForDecision(offset, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    try {
      const decision = await pollDecision(offset, { longPollSeconds: 20 });
      if (decision) return decision;
    } catch (err) {
      console.warn(`poll failed (${err.message}), still waiting`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return null;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
