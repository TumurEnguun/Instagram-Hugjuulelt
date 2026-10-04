/**
 * Higgsfield image-to-video: turns the day's painted still into a short Reel.
 *
 * Flow, per Higgsfield's docs:
 *   1. POST /files/generate-upload-url, PUT the JPEG there   -> public_url
 *   2. POST /<model>  { image_url, prompt, duration, ... }    -> request_id
 *   3. GET  /requests/<id>/status until "completed"           -> video.url
 *
 * Starting from our own still is what keeps Teddy and Ichigo on-model. Text-to-
 * video would invent new hamsters every time.
 *
 * Credentials: HF_API_KEY_ID and HF_API_KEY_SECRET. Without them, Reels are
 * simply switched off and every day is a photo post, exactly as before.
 */
import crypto from 'node:crypto';
import { optional, video } from './config.js';
import { retryFetch } from './net.js';

const BASE = 'https://api.higgsfield.ai';

export function isConfigured() {
  return Boolean(optional('HF_API_KEY_ID') && optional('HF_API_KEY_SECRET'));
}

const authHeader = () => `Key ${optional('HF_API_KEY_ID')}:${optional('HF_API_KEY_SECRET')}`;

async function api(pathname, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { Authorization: authHeader() };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await retryFetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.detail ?? json.message ?? json.error ?? res.statusText;
    throw new Error(`Higgsfield ${method} ${pathname} failed (${res.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return json;
}

/** Upload a JPEG and return a public URL valid for about an hour. */
export const uploadImage = (jpeg) => uploadFile(jpeg, 'image/jpeg');

/** Upload any supported file (JPEG/PNG/WebP/GIF/MP4/WAV) and return its public URL. */
export async function uploadFile(buffer, contentType) {
  const slot = await api('/files/generate-upload-url', { method: 'POST', body: { content_type: contentType } });
  if (!slot.upload_url || !slot.public_url) throw new Error('Higgsfield returned no upload URL.');

  // Never send our API credentials to the storage URL, only its own headers.
  const res = await retryFetch(slot.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, ...(slot.upload_headers ?? {}) },
    body: buffer,
  }, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`Uploading the file to Higgsfield failed (${res.status}).`);
  return slot.public_url;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Animate a still. Returns { videoUrl, requestId }.
 * Polls for up to `timeoutMinutes`; Kling usually takes 1-4 minutes.
 * Failed generations are not charged by Higgsfield, so a throw costs nothing.
 */
export async function animate(jpeg, prompt, { timeoutMinutes = 15, duration = video.duration, sound = video.sound, aspectRatio = video.aspectRatio } = {}) {
  const imageUrl = await uploadImage(jpeg);

  const job = await api(`/${video.model}`, {
    method: 'POST',
    // Same key on a retried POST means Higgsfield will not bill a second clip.
    idempotencyKey: crypto.randomUUID(),
    body: {
      prompt,
      image_url: imageUrl,
      duration,
      aspect_ratio: aspectRatio,
      sound,
      cfg_scale: video.cfgScale,
    },
  });
  return waitForJob(job, timeoutMinutes);
}

/**
 * Motion transfer (Genjutsu): copy the movement of a source clip onto our
 * characters. This is how trend remakes are made: the trend video drives the
 * choreography, our images decide who is in it. Output length matches the
 * source clip (4-30 s). Images: up to 8, keyframe first, then character refs.
 */
export async function motionTransfer(sourceMp4, images, prompt, { resolution = '1080p', timeoutMinutes = 20, onSubmitted } = {}) {
  const videoUrl = await uploadFile(sourceMp4, 'video/mp4');
  const imageUrls = [];
  for (const img of images.slice(0, 8)) imageUrls.push(await uploadFile(img.data, img.mimeType));

  const job = await api('/higgsfield/genjutsu/motion-transfer/v1.0', {
    method: 'POST',
    idempotencyKey: crypto.randomUUID(),
    body: { video_url: videoUrl, image_urls: imageUrls, prompt, resolution },
  });
  // Lets the caller save the request id, so a run that dies mid-wait resumes
  // the same paid job instead of paying for a second one.
  if (onSubmitted) await onSubmitted(job.request_id);
  return waitForJob(job, timeoutMinutes);
}

export async function waitForJob(job, timeoutMinutes = 20) {
  const requestId = job.request_id;
  if (!requestId) throw new Error('Higgsfield did not return a request id.');
  console.log(`Higgsfield job ${requestId} queued.`);

  const deadline = Date.now() + timeoutMinutes * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(10_000);
    let s;
    try {
      s = await api(`/requests/${requestId}/status`);
    } catch (err) {
      console.warn(`  status check failed (${err.message}), still waiting`);
      continue;
    }
    if (s.status !== last) console.log(`  Higgsfield: ${s.status}`);
    last = s.status;

    if (s.status === 'completed') {
      const url = s.video?.url;
      if (!url) throw new Error('Higgsfield finished but returned no video URL.');
      return { videoUrl: url, requestId };
    }
    if (['failed', 'nsfw', 'canceled', 'cancelled', 'error'].includes(s.status)) {
      throw new Error(`Higgsfield generation ${s.status}${s.error ? `: ${s.error}` : ''}.`);
    }
  }
  throw new Error(`Higgsfield did not finish within ${timeoutMinutes} minutes (job ${requestId}).`);
}

/** Download the finished clip, for the Telegram preview and dry runs. */
export async function download(videoUrl) {
  const res = await retryFetch(videoUrl, {}, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`Downloading the video failed (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}
