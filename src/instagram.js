/**
 * Official Instagram Graph API publishing, via graph.instagram.com.
 *
 * Two steps, as Meta requires:
 *   1. POST /<IG_ID>/media          create a container from a public image URL
 *   2. POST /<IG_ID>/media_publish  publish that container
 */
import { need } from './config.js';
import { retryFetch } from './net.js';

const GRAPH = 'https://graph.instagram.com/v25.0';

async function graph(pathname, params) {
  const body = new URLSearchParams({ ...params, access_token: need('IG_ACCESS_TOKEN') });
  const res = await retryFetch(`${GRAPH}${pathname}`, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    throw new Error(
      `Instagram API error on ${pathname}: ${e.message ?? res.statusText}` +
        (e.error_user_msg ? ` | ${e.error_user_msg}` : '') +
        (e.code ? ` (code ${e.code})` : '')
    );
  }
  return json;
}

/** Containers are processed asynchronously; wait for FINISHED before publishing. */
async function waitForContainer(containerId, { attempts = 20, delayMs = 3000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const url = `${GRAPH}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(need('IG_ACCESS_TOKEN'))}`;
    const res = await retryFetch(url);
    const json = await res.json().catch(() => ({}));
    const status = json.status_code;

    if (status === 'FINISHED') return;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`Instagram rejected the media container: ${json.status ?? status}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Instagram media container never finished processing.');
}

/**
 * Publish one photo. Returns the new media id.
 * `caption` should already include hashtags.
 */
export async function publishPhoto(imageUrl, caption) {
  const igId = need('IG_USER_ID');

  const container = await graph(`/${igId}/media`, { image_url: imageUrl, caption });
  if (!container.id) throw new Error('Instagram did not return a container id.');

  await waitForContainer(container.id);

  const published = await graph(`/${igId}/media_publish`, { creation_id: container.id });
  if (!published.id) throw new Error('Instagram did not return a published media id.');
  return published.id;
}

/** Sanity check used by the workflows and setup, so failures are legible. */
export async function checkAccount() {
  const igId = need('IG_USER_ID');
  const url = `${GRAPH}/${igId}?fields=id,username&access_token=${encodeURIComponent(need('IG_ACCESS_TOKEN'))}`;
  const res = await retryFetch(url);
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(`Instagram token check failed: ${json.error.message}`);
  return json;
}
