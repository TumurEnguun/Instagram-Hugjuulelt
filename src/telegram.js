/**
 * Telegram is the approval channel. No webhook server: we send a photo with
 * inline buttons, then read the answer back later with getUpdates. That keeps
 * the whole system inside GitHub Actions with nothing else to host.
 */
import { need } from './config.js';
import { retryFetch } from './net.js';

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
 * Look for a button press newer than `offset`.
 * Returns { action, updateId, callbackId } or null if nothing new.
 * Always takes the LATEST press, so changing your mind works.
 */
export async function pollDecision(offset = 0) {
  const res = await retryFetch(api('getUpdates'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset: offset ? offset + 1 : undefined,
      timeout: 0,
      allowed_updates: ['callback_query'],
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram getUpdates failed: ${json.description}`);

  const presses = json.result.filter((u) => u.callback_query);
  if (presses.length === 0) return null;

  const latest = presses[presses.length - 1];
  const [action, episodeNumber, attempt] = String(latest.callback_query.data).split(':');

  return {
    action,
    // Undefined for presses on messages sent before buttons were tagged.
    // Callers treat that as "cannot verify" rather than as a mismatch.
    episodeNumber: episodeNumber === undefined ? undefined : Number(episodeNumber),
    attempt: attempt === undefined ? undefined : Number(attempt),
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
    body: JSON.stringify({ timeout: 0, allowed_updates: ['callback_query'] }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram getUpdates failed: ${json.description}`);
  if (json.result.length === 0) return 0;

  const maxId = json.result[json.result.length - 1].update_id;

  // Re-requesting with a higher offset is how Telegram is told these are
  // handled; it drops them from the queue for good.
  await retryFetch(api('getUpdates'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset: maxId + 1, timeout: 0 }),
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
    body: JSON.stringify({ offset: upToId + 1, timeout: 0 }),
  });
}

/** Stops the spinner on the tapped button and shows a toast. */
export async function ackButton(callbackId, text) {
  try {
    await call('answerCallbackQuery', { callback_query_id: callbackId, text });
  } catch {
    // A callback id older than ~15 minutes expires. Not worth failing the run.
  }
}

/** Wait up to `minutes` for a decision, checking every few seconds. */
export async function waitForDecision(offset, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    const decision = await pollDecision(offset);
    if (decision) return decision;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
