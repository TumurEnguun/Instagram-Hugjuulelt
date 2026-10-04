/**
 * Remix inbox: send the bot a trend video, get the Teddy & Ichigo version back.
 *
 *   node src/remix.js            one pass (what the 15-minute check workflow runs)
 *   node src/remix.js --watch    keep going, for when you are at your PC
 *
 * Flow per video:
 *   1. You send a trend clip (the video file, not a link) to the bot, with an
 *      optional note like "Teddy main, Ichigos crowd".
 *   2. Gemini watches it and labels it: the trend, the beats, who plays what,
 *      anything off-brand to swap (cigarette -> sunflower seed).
 *   3. A 9:16 keyframe is painted with the locked character sheets and sent to
 *      you: Make it / Repaint / Cancel. Nothing paid happens before you tap.
 *   4. "Make it": Higgsfield motion transfer copies the clip's exact movement
 *      onto the hamsters. The MP4 comes back on Telegram for you to post from
 *      the Instagram app with the trend's sound.
 *
 * Nothing here posts to Instagram on its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { paths, models, video, need } from './config.js';
import { drawPanel } from './gemini.js';
import { readBible, readCharacterRefs, readRemix, writeRemix } from './store.js';
import * as higgsfield from './higgsfield.js';
import {
  syncUpdates, downloadFile, sendPhotoWithButtons, sendVideoFile, sendMessage, ackButton, escapeHtml,
} from './telegram.js';

const MAX_FRAME_ATTEMPTS = 4;
const TELEGRAM_BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

let client;
const ai = () => (client ??= new GoogleGenAI({ apiKey: need('GEMINI_API_KEY') }));

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    fitsBrand: { type: 'boolean', description: 'false if the clip is sexual, violent, hateful, about a tragedy or politics, or cannot work with cute hamsters' },
    reasonIfNot: { type: 'string' },
    trendName: { type: 'string', description: 'The trend name if recognisable, else a short descriptive name' },
    song: { type: 'string', description: 'The song if you can identify it from audio or on-screen text, else empty' },
    beats: { type: 'string', description: 'What happens, second by second, in under 80 words' },
    casting: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          original: { type: 'string', description: 'who or what in the source clip' },
          becomes: { type: 'string', description: 'Teddy, Ichigo, or "identical Ichigos" for a crowd' },
        },
        required: ['original', 'becomes'],
      },
    },
    swaps: { type: 'array', items: { type: 'string' }, description: 'Off-brand things replaced, e.g. "cigarette -> sunflower seed"' },
    keyframeScene: { type: 'string', description: 'The FIRST frame of the hamster version, as a painting description' },
    transferPrompt: { type: 'string', description: 'Instructions for the motion-transfer model' },
    caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
  },
  required: ['fitsBrand', 'trendName', 'beats', 'casting', 'keyframeScene', 'transferPrompt', 'caption', 'hashtags'],
};

/** Gemini watches the clip and writes the whole remix plan. */
async function analyze(mp4, note) {
  const prompt = `You plan "hamster remixes" of trending short videos for the Instagram comic "Teddy & Ichigo".
Watch the attached clip closely, including its audio and any on-screen text.

=== THE CHARACTERS AND WORLD ===
${readBible()}

=== OWNER'S NOTE (follow it if present) ===
${note || '(none)'}

=== CASTING RULES (unless the note says otherwise) ===
- The main performer, the one the joke is about, becomes TEDDY.
- A crowd, background dancers or a group become IDENTICAL ICHIGOS, all in the same outfit if the source has matching outfits.
- A clip with exactly two people becomes Teddy and Ichigo, matching their personalities.
- Keep the source's formation, positions, camera angle and timing. The point is that anyone who knows the trend recognises it instantly.

=== SWAP ANYTHING OFF-BRAND ===
Cigarettes, vapes, alcohol, drugs -> a sunflower seed, a tiny cup of tea, a berry.
Weapons -> a harmless prop. Logos, brands, celebrities -> generic versions.
List every swap in "swaps".

=== WRITE ===
- keyframeScene: the first frame of the hamster version as a still painting: where each hamster stands (matching the source's first frame), outfits, props, setting (their cosy attic world, adapted to the trend's vibe), lighting. Vertical phone framing.
- transferPrompt: tell a motion-transfer model, which receives the source clip plus our keyframe and character sheets, exactly who becomes whom ("the person in the centre who stops dancing becomes Teddy..."), every swap, and that it must copy the source's movement, timing, formation and camera exactly. 120-250 words.
- caption: one dry, warm line in the account's voice (third person, about "Teddy" and "Ichigo", never "I" or "we"). No hashtags in it.
- hashtags: exactly 5, no #: teddyandichigo, 2 niche comic tags, 2 for this trend.
If the clip cannot be done tastefully with cute hamsters, set fitsBrand false and explain why.`;

  const res = await ai().models.generateContent({
    model: models.writer,
    contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'video/mp4', data: mp4.toString('base64') } }] }],
    config: { responseMimeType: 'application/json', responseSchema: ANALYSIS_SCHEMA, temperature: 0.6 },
  });
  if (!res.text) throw new Error('Gemini returned nothing for the clip.');
  return JSON.parse(res.text);
}

const FRAME_NOTE = `This painting is the FIRST FRAME of a trend remix video, shown full screen on a vertical phone.
- Match the composition of the trend's first frame: same positions, formation and camera angle, recast with the hamsters.
- Every hamster fully visible, with a little space between them so each can move without merging.
- Keep the top 15% and bottom 20% free of anything important; Instagram overlays its interface there.
- Calm, clear starting poses. No motion blur.
- Teddy looks exactly like the Teddy reference, every Ichigo exactly like the Ichigo reference.`;

const STYLE_LOCK = `

STYLE LOCK (always): every frame is a hand-painted storybook illustration: soft gouache and watercolour texture, visible brushwork, warm light, exactly the look of the keyframe image. Not 3D, not photoreal. Every hamster keeps the look in the reference images: same fur colours and markings, same sizes, solid glossy black bead eyes, four paws, outfits unchanged. Nobody morphs, melts, merges, splits, appears or disappears. No humans, no text, no logos, no cigarettes or smoke.`;

const save = (r) => writeRemix(r);
const findJob = (r, id) => r.jobs.find((j) => j.id === id);
const framePath = (job) => path.join(paths.remixDir, `${job.id}-v${job.attempt}.jpg`);

function frameCaption(job) {
  const a = job.analysis;
  const cast = (a.casting ?? []).map((c) => `• ${escapeHtml(c.original)} → <b>${escapeHtml(c.becomes)}</b>`).join('\n');
  const swaps = (a.swaps ?? []).length ? `\nSwaps: ${escapeHtml(a.swaps.join(', '))}` : '';
  return [
    `🐹 <b>Remix: ${escapeHtml(a.trendName)}</b>${a.song ? ` (${escapeHtml(a.song)})` : ''}`,
    '',
    escapeHtml(a.beats),
    '',
    cast + swaps,
    '',
    'This is the first frame. Make the video?',
  ].join('\n');
}

const buttons = (job) => [
  [{ text: '🎬 Make it', callback_data: `RMXGO:${job.id}:${job.attempt}` }],
  [
    { text: '🎨 Repaint frame', callback_data: `RMXPAINT:${job.id}:${job.attempt}` },
    { text: '✖ Cancel', callback_data: `RMXX:${job.id}:${job.attempt}` },
  ],
];

async function paintFrame(job) {
  job.attempt += 1;
  const { jpeg } = await drawPanel(job.analysis.keyframeScene, readBible(), readCharacterRefs(), {
    aspectRatios: [video.aspectRatio],
    frameNote: FRAME_NOTE,
  });
  fs.mkdirSync(paths.remixDir, { recursive: true });
  // Our own art, committed so a later run (after you tap Make it) can use it.
  fs.writeFileSync(framePath(job), jpeg);
  await sendPhotoWithButtons(jpeg, frameCaption(job), buttons(job));
  job.status = 'frame_sent';
}

/** New video: download, analyse, paint, ask. */
async function prepare(r, job) {
  if (job.fileSize > TELEGRAM_BOT_DOWNLOAD_LIMIT) {
    job.status = 'failed';
    save(r);
    await sendMessage('That video is over 20 MB, which is the most a bot can download. Trim it to the trend part (4-30 s) and send it again.');
    return;
  }
  await sendMessage('Got the video. Watching it and painting the hamster version, give me a few minutes...');
  const mp4 = await downloadFile(job.fileId);
  job.analysis = await analyze(mp4, job.note);
  if (!job.analysis.fitsBrand) {
    job.status = 'skipped';
    save(r);
    await sendMessage(`I'll pass on this one: ${escapeHtml(job.analysis.reasonIfNot || 'it does not fit the hamsters.')}`);
    return;
  }
  await paintFrame(job);
  save(r);
}

/** "Make it": motion transfer, resumable if a run dies mid-wait. */
async function animateJob(r, job) {
  let result;
  if (job.requestId) {
    console.log(`Resuming Higgsfield job ${job.requestId}`);
    result = await higgsfield.waitForJob({ request_id: job.requestId });
  } else {
    await sendMessage(`Making the ${escapeHtml(job.analysis.trendName)} video. This takes a few minutes...`);
    const source = await downloadFile(job.fileId);
    const frame = fs.readFileSync(framePath(job));
    const images = [
      { data: frame, mimeType: 'image/jpeg' },
      ...readCharacterRefs().map((c) => ({ data: Buffer.from(c.data, 'base64'), mimeType: c.mimeType })),
    ];
    result = await higgsfield.motionTransfer(source, images, job.analysis.transferPrompt + STYLE_LOCK, {
      onSubmitted: (id) => {
        job.requestId = id;
        save(r);
      },
    });
  }

  const mp4 = await higgsfield.download(result.videoUrl);
  const a = job.analysis;
  await sendVideoFile(
    mp4,
    `🎬 <b>${escapeHtml(a.trendName)}</b>, hamster version\n\nPost it from the Instagram app${a.song ? ` with <b>${escapeHtml(a.song)}</b>` : ' with the trend sound'}.\n\nCaption idea:\n${escapeHtml(a.caption)}\n\n${a.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')}`,
    `${job.id}.mp4`
  );
  job.status = 'done';
  job.videoUrl = result.videoUrl;
  for (let v = 1; v <= job.attempt; v++) fs.rmSync(path.join(paths.remixDir, `${job.id}-v${v}.jpg`), { force: true });
  save(r);
}

async function handlePress(r, p) {
  const [action, id, attemptStr] = p.data.split(':');
  const job = findJob(r, id);
  if (!job || job.attempt !== Number(attemptStr) || job.status !== 'frame_sent') {
    await ackButton(p.callbackId, 'That button is out of date.');
    return;
  }
  if (action === 'RMXX') {
    job.status = 'cancelled';
    save(r);
    await ackButton(p.callbackId, 'Cancelled.');
    return;
  }
  if (action === 'RMXPAINT') {
    if (job.attempt >= MAX_FRAME_ATTEMPTS) {
      await ackButton(p.callbackId, 'Repaint limit reached. Make it or cancel.');
      return;
    }
    await ackButton(p.callbackId, 'Repainting...');
    await paintFrame(job);
    save(r);
    return;
  }
  if (action === 'RMXGO') {
    if (!higgsfield.isConfigured()) {
      await sendMessage('Higgsfield is not set up (HF_API_KEY_ID / HF_API_KEY_SECRET).');
      return;
    }
    await ackButton(p.callbackId, 'Making the video...');
    job.status = 'animating';
    save(r);
    await animateJob(r, job);
  }
}

async function pass() {
  await syncUpdates();
  const r = readRemix();

  if (r.notices.includes('link')) {
    r.notices = [];
    save(r);
    await sendMessage('I can only use the video file, not a link. Save the Reel (Share → Download, or screen-record it), then send me the video itself.');
  }

  // Button taps first, oldest first. Each is removed once handled, even on
  // failure, so one bad tap cannot jam the queue forever.
  while (r.presses.length) {
    const p = r.presses.shift();
    save(r);
    try {
      await handlePress(r, p);
    } catch (err) {
      console.error(err.message);
      const job = findJob(r, p.data.split(':')[1]);
      if (job && job.status === 'animating') {
        job.status = 'frame_sent';
        delete job.requestId;
        save(r);
      }
      await sendMessage(`The remix hit a problem, nothing was charged for a failed job. You can tap Make it again.\n<code>${escapeHtml(err.message)}</code>`);
    }
  }

  for (const job of r.jobs) {
    try {
      if (job.status === 'new') await prepare(r, job);
      else if (job.status === 'animating' && job.requestId) await animateJob(r, job);
    } catch (err) {
      console.error(err.message);
      job.status = job.status === 'animating' ? 'frame_sent' : 'failed';
      save(r);
      await sendMessage(`Could not finish that remix.\n<code>${escapeHtml(err.message)}</code>`);
    }
  }

  // Keep the file small: drop finished jobs older than a week.
  const weekAgo = Date.now() - 7 * 86_400_000;
  r.jobs = r.jobs.filter((j) => !['done', 'cancelled', 'skipped', 'failed'].includes(j.status) || Date.parse(j.receivedAt) > weekAgo);
  save(r);
}

async function main() {
  const watch = process.argv.includes('--watch');
  do {
    await pass();
    if (watch) await new Promise((res) => setTimeout(res, 15_000));
  } while (watch);
}

main().catch(async (err) => {
  console.error(err.message);
  try {
    await sendMessage(`Remix run failed.\n<code>${escapeHtml(err.message)}</code>`);
  } catch {}
  process.exit(1);
});
