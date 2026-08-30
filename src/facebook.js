/**
 * Optional cross-posting to a Facebook Page.
 *
 * Entirely optional: with no FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN set, every
 * function here quietly no-ops. Instagram is the primary channel and a Facebook
 * failure must never undo or block a successful Instagram post.
 */
import { optional } from './config.js';
import { retryFetch } from './net.js';

const GRAPH = 'https://graph.facebook.com/v25.0';

export function isConfigured() {
  return Boolean(optional('FB_PAGE_ID') && optional('FB_PAGE_ACCESS_TOKEN'));
}

/**
 * Publish a photo to the Page by URL, reusing the same public image Instagram
 * fetches. Returns the new post id, or null when Facebook is not configured.
 */
export async function publishPhoto(imageUrl, caption) {
  if (!isConfigured()) return null;

  const body = new URLSearchParams({
    url: imageUrl,
    caption,
    access_token: optional('FB_PAGE_ACCESS_TOKEN'),
  });

  const res = await retryFetch(`${GRAPH}/${optional('FB_PAGE_ID')}/photos`, {
    method: 'POST',
    body,
  });
  const json = await res.json().catch(() => ({}));

  if (json.error) {
    const e = json.error;
    throw new Error(
      `Facebook API error: ${e.message}` +
        (e.error_user_msg ? ` | ${e.error_user_msg}` : '') +
        (e.code ? ` (code ${e.code})` : '')
    );
  }
  if (!json.post_id && !json.id) throw new Error('Facebook did not return a post id.');
  return json.post_id ?? json.id;
}

/** Sanity check used by doctor, so a bad Page token is caught before posting. */
export async function checkPage() {
  if (!isConfigured()) return null;
  const url = `${GRAPH}/${optional('FB_PAGE_ID')}?fields=id,name&access_token=${encodeURIComponent(optional('FB_PAGE_ACCESS_TOKEN'))}`;
  const res = await retryFetch(url);
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(json.error.message);
  return json;
}
