/**
 * One-off custom Reel from a hand-written spec, for trends the daily writer
 * cannot do on its own (crowds, specific formats, audio-driven trends).
 *
 *   node src/reel-custom.js reels/standing-still.json --frame-only
 *       paint the keyframe only (a few cents) so you can check it first
 *   node src/reel-custom.js reels/standing-still.json --frame posts/custom-...-frame.jpg
 *       animate an approved keyframe (Higgsfield, ~$0.07 per second of video)
 *   node src/reel-custom.js reels/standing-still.json
 *       both in one go
 *
 * If the spec has "sourceVideo" (a local MP4 of the trend), it uses motion
 * transfer instead: the trend clip drives the exact choreography and timing,
 * our keyframe and character sheets decide who is in it. That is how trend
 * remakes match the original beat for beat.
 *
 * The clip is saved to posts/ and sent to Telegram WITHOUT buttons: these are
 * meant to be posted by hand from the Instagram app, because audio trends need
 * the trending sound and the API cannot attach music.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, video } from './config.js';
import { drawPanel } from './gemini.js';
import { readBible, readCharacterRefs } from './store.js';
import * as higgsfield from './higgsfield.js';
import { need } from './config.js';
import { retryFetch } from './net.js';

const args = process.argv.slice(2);
const specPath = args.find((a) => a.endsWith('.json'));
const frameOnly = args.includes('--frame-only');
const frameIdx = args.indexOf('--frame');
const existingFrame = frameIdx !== -1 ? args[frameIdx + 1] : null;

/**
 * The daily prompt locks "exactly two hamsters". Custom specs may have crowds,
 * so this wrapper locks style and character LOOKS instead of the head count.
 */
function customMotionPrompt(spec) {
  return `Animate this hand-painted storybook illustration so the painting itself comes to life.

ACTION:
${spec.motion}

STYLE LOCK: keep exactly the look of the input image: soft gouache and watercolour texture, visible brushwork, gentle paper grain, the same warm light and colours. It stays a moving painting. Not 3D, not glossy, not photoreal.

CHARACTER LOCK: every hamster keeps exactly the look it has in the image: same fur colours and markings, same sizes, same outfits, solid glossy black bead eyes. The number of hamsters never changes: nobody appears, disappears, merges or splits. Four paws each. Faces and bodies keep their shape; nothing morphs or melts. No people, no hands, no text, no logos.

MOTION: hamster-sized movement with soft weight and bounce. The room, floor and lights stay still.

CAMERA: one continuous shot, no cuts, exactly as directed above.`;
}

async function sendToTelegram(mp4, spec) {
  const caption = `🎬 <b>Custom Reel: ${spec.name}</b>\n\nPost this one from the Instagram app and add the trending sound.\n\nCaption idea:\n${spec.caption}\n\n${(spec.hashtags ?? []).map((h) => `#${h}`).join(' ')}`;
  const form = new FormData();
  form.append('chat_id', need('TELEGRAM_CHAT_ID'));
  form.append('caption', caption.slice(0, 1024));
  form.append('parse_mode', 'HTML');
  form.append('supports_streaming', 'true');
  form.append('video', new Blob([mp4], { type: 'video/mp4' }), `${spec.name}.mp4`);
  const res = await retryFetch(`https://api.telegram.org/bot${need('TELEGRAM_BOT_TOKEN')}/sendVideo`, { method: 'POST', body: form }, { timeoutMs: 120_000 });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram sendVideo failed: ${json.description}`);
}

async function main() {
  if (!specPath) throw new Error('Usage: node src/reel-custom.js reels/<spec>.json [--frame-only | --frame <jpg>]');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  fs.mkdirSync(paths.posts, { recursive: true });
  const stamp = Date.now();

  let frame;
  if (existingFrame) {
    frame = fs.readFileSync(existingFrame);
    console.log(`Using keyframe ${existingFrame}`);
  } else {
    console.log('Painting keyframe...');
    ({ jpeg: frame } = await drawPanel(spec.scene, readBible(), readCharacterRefs(), {
      aspectRatios: [video.aspectRatio],
      frameNote: spec.frameNote ?? '',
    }));
    const framePath = path.join(paths.posts, `custom-${spec.name}-${stamp}-frame.jpg`);
    fs.writeFileSync(framePath, frame);
    console.log(`Saved keyframe: ${framePath}`);
    if (frameOnly) {
      console.log(`\nLooks good? Animate it with:\n  node src/reel-custom.js ${specPath} --frame ${path.relative(process.cwd(), framePath)}`);
      return;
    }
  }

  if (!higgsfield.isConfigured()) throw new Error('Set HF_API_KEY_ID and HF_API_KEY_SECRET in .env first.');

  let videoUrl;
  if (spec.sourceVideo) {
    if (!fs.existsSync(spec.sourceVideo)) {
      throw new Error(`Source clip not found: ${spec.sourceVideo}. Save the trend video there (4-30 s MP4) first.`);
    }
    const source = fs.readFileSync(spec.sourceVideo);
    // Keyframe first so it sets the scene and outfits; then the locked sheets
    // so every hamster stays on-model.
    const images = [{ data: frame, mimeType: 'image/jpeg' }, ...readCharacterRefs().map((r) => ({ data: Buffer.from(r.data, 'base64'), mimeType: r.mimeType }))];
    console.log(`Motion transfer from ${spec.sourceVideo} with ${images.length} images (1-10 minutes)...`);
    ({ videoUrl } = await higgsfield.motionTransfer(source, images, spec.transferPrompt ?? customMotionPrompt(spec), { resolution: spec.resolution ?? '1080p' }));
  } else {
  const duration = spec.duration ?? video.duration;
  console.log(`Animating ${duration}s with Higgsfield (about $${(duration * 0.07).toFixed(2)}, 1-5 minutes)...`);
  ({ videoUrl } = await higgsfield.animate(frame, customMotionPrompt(spec), {
    duration,
    sound: spec.sound ?? 'off',
  }));
  }
  const mp4 = await higgsfield.download(videoUrl);
  const out = path.join(paths.posts, `custom-${spec.name}-${stamp}.mp4`);
  fs.writeFileSync(out, mp4);
  console.log(`Saved ${out} (${(mp4.length / 1024 / 1024).toFixed(1)} MB)`);

  try {
    await sendToTelegram(mp4, spec);
    console.log('Sent to Telegram.');
  } catch (err) {
    console.warn(`Could not send to Telegram (${err.message}). The file is saved above.`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
