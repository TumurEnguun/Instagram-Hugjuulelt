/**
 * Telegram is the approval channel. No webhook server: we send a photo with
 * inline buttons, then read the answer back later with getUpdates. That keeps
 * the whole system inside GitHub Actions with nothing else to host.
 */
import { need } from './config.js';

const api = (method) => `https://api.telegram.org/bot${need('TELEGRAM_BOT_TOKEN')}/${method}`;

async function call(method, body) {
  const res = await fetch(api(method), {
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
export async function sendProposal(jpegBuffer, episode, episodeNumber) {
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
  form.append(
    'reply_markup',
    JSON.stringify({
      inline_keyboard: [
        [
          { text: 'OK, post it', callback_data: 'OK' },
          { text: 'Redraw', callback_data: 'AGAIN' },
        ],
        [
          { text: 'New story', callback_data: 'REWRITE' },
          { text: 'Skip today', callback_data: 'SKIP' },
        ],
      ],
    })
  );

  const res = await fetch(api('sendPhoto'), { method: 'POST', body: form });
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
  const res = await fetch(api('getUpdates'), {
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
  return {
    action: latest.callback_query.data,
    updateId: latest.update_id,
    callbackId: latest.callback_query.id,
    // Highest id seen, so we acknowledge everything we just read.
    maxUpdateId: json.result[json.result.length - 1].update_id,
  };
}

/**
 * Clear out any button presses still sitting in the queue and return the
 * highest update id seen.
 *
 * Without this, a leftover press from yesterday would be read as the answer
 * to today's brand new post, which could publish something you never saw.
 */
export async function drainUpdates() {
  const res = await fetch(api('getUpdates'), {
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
  await fetch(api('getUpdates'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset: maxId + 1, timeout: 0 }),
  });
  return maxId;
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

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
