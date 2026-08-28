/**
 * All Gemini calls live here.
 *
 * Two jobs:
 *   writeEpisode()  the next beat of the hamster love story, as structured JSON
 *   drawPanel()     the illustration, anchored to the locked character refs
 *
 * Uses the stable models.generateContent path, not the experimental
 * interactions API, so this keeps working unattended.
 */
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { models, image, need } from './config.js';

let client;
function ai() {
  if (!client) client = new GoogleGenAI({ apiKey: need('GEMINI_API_KEY') });
  return client;
}

const EPISODE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short episode title, max 6 words.' },
    scene: {
      type: 'string',
      description:
        'A vivid single-image visual description of this episode. Describe only what is VISIBLE: setting, what each hamster is doing, expressions, props, lighting, time of day. Do not mention panels, text, speech bubbles or captions.',
    },
    caption: {
      type: 'string',
      description: 'Instagram caption. Cute and funny, 1-3 short sentences. May use a few emoji.',
    },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: '8-12 relevant hashtags, without the # symbol.',
    },
    arcNote: {
      type: 'string',
      description: 'One line, past tense, summarising what happened, for the series log.',
    },
    arcUpdate: {
      type: 'string',
      description: 'Where the relationship arc stands now. Empty string if unchanged.',
    },
    newRunningGag: {
      type: 'string',
      description: 'A new running gag introduced this episode, or empty string.',
    },
  },
  required: ['title', 'scene', 'caption', 'hashtags', 'arcNote'],
};

/** Ask the writer model for the next episode, given everything that came before. */
export async function writeEpisode(state, bible, { avoidScene = '' } = {}) {
  const recent = state.episodes.slice(-15).map((e) => `${e.n}. ${e.summary}`).join('\n') || '(none yet, this is episode 1)';

  const prompt = `You write an ongoing, wholesome, funny Instagram comic series about a hamster couple.

=== SERIES BIBLE (authoritative, never contradict this) ===
${bible}

=== STORY SO FAR ===
Episodes published: ${state.episodeCount}
Current arc: ${state.currentArc || '(just starting out)'}
Running gags: ${state.runningGags.join(', ') || '(none yet)'}

Recent episodes:
${recent}

=== YOUR TASK ===
Write episode ${state.episodeCount + 1}.

Rules:
- It must feel like a continuation, not a reset. Reference the arc or a running gag when it fits naturally.
- Do NOT repeat the situation or joke of any recent episode.
- Keep it cute and genuinely funny. Small domestic stakes, warm ending.
- The "scene" field must be describable in ONE still image.
- Never describe text, words, signs, speech bubbles or captions inside the image.
- Both hamsters should be visible unless the story genuinely calls for one.
${avoidScene ? `\n- The following scene was just rejected. Write something clearly different:\n"${avoidScene}"` : ''}`;

  const res = await ai().models.generateContent({
    model: models.writer,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: EPISODE_SCHEMA,
      temperature: 1.0,
    },
  });

  const text = res.text;
  if (!text) throw new Error('Writer model returned no text. Response was blocked or empty.');
  return JSON.parse(text);
}

/** Pull the first inline image out of a generateContent response. */
function extractImage(res) {
  const parts = res?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.data) return Buffer.from(part.inlineData.data, 'base64');
  }
  const finish = res?.candidates?.[0]?.finishReason;
  const blocked = res?.promptFeedback?.blockReason;
  throw new Error(
    `No image in response (finishReason=${finish ?? 'none'}${blocked ? `, blocked=${blocked}` : ''}).`
  );
}

/**
 * Draw one panel.
 *
 * The character reference images are the whole trick: passing the same locked
 * refs on every call is what keeps the hamsters looking like the same two
 * hamsters instead of a new pair each day.
 *
 * Returns a JPEG buffer, because Instagram accepts nothing else.
 */
export async function drawPanel(scene, bible, refs) {
  const prompt = `Illustrate this scene as a single finished image.

=== ART AND CHARACTER BIBLE (follow exactly) ===
${bible}

=== CHARACTER REFERENCES ===
The attached images define exactly what these two hamsters look like. Reproduce their
fur colour, markings, body shape, ear shape and proportions faithfully. They must be
instantly recognisable as the same characters.

=== SCENE ===
${scene}

=== HARD RULES ===
- No text, letters, numbers, words, signs, logos, speech bubbles or captions anywhere.
- No watermarks or borders.
- Full-bleed illustration that fills the entire frame.
- Keep the art style identical to the bible and the references.`;

  const parts = [
    { text: prompt },
    ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.data } })),
  ];

  let lastErr;
  for (const aspectRatio of image.aspectRatios) {
    try {
      const res = await ai().models.generateContent({
        model: models.artist,
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio, imageSize: image.size },
        },
      });
      const raw = extractImage(res);
      const jpeg = await sharp(raw).jpeg({ quality: image.jpegQuality }).toBuffer();
      return { jpeg, aspectRatio };
    } catch (err) {
      lastErr = err;
      // Only fall through to the next ratio if this one was the problem.
      if (!/aspect|ratio|INVALID_ARGUMENT/i.test(err.message)) throw err;
      console.warn(`Aspect ratio ${aspectRatio} rejected, trying next.`);
    }
  }
  throw lastErr;
}

/** One-time: generate a character sheet used to lock a hamster's look. */
export async function drawCharacterSheet(description) {
  const prompt = `A character reference sheet for a cartoon hamster.

${description}

Show the SAME hamster three times on a plain neutral light grey background:
front view, three-quarter view, and side view, standing, full body, evenly lit.
Consistent proportions and markings across all three.
No text, no labels, no numbers, no borders, no shadows on the background.`;

  const res = await ai().models.generateContent({
    model: models.artist,
    contents: prompt,
    config: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '4:3', imageSize: image.size },
    },
  });
  const raw = extractImage(res);
  return sharp(raw).jpeg({ quality: 95 }).toBuffer();
}
