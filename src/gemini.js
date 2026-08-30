/**
 * All Gemini calls live here.
 *
 * Two jobs:
 *   writeEpisode()  the next beat of the hamster love story, as structured JSON
 *   drawPanel()     the illustration, anchored to the locked character refs
 *
 * Uses the stable models.generateContent path, not the experimental
 * interactions API, so this keeps working unattended.
 *
 * The prompts below run unchanged every day for months. Vague instructions
 * produce vague output forever, so they are deliberately specific about what
 * makes an episode funny and what makes a panel readable.
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
        'A vivid description of ONE still image. Name the setting, the time of day, what each hamster is physically doing, their facial expressions, and the key props. Describe only what a viewer could see. Never mention panels, text, speech bubbles or captions.',
    },
    caption: {
      type: 'string',
      description:
        'The Instagram caption, which must carry the punchline. One or two short sentences, conversational, dry rather than shouty. At most one emoji, often none.',
    },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exactly 5 hashtags, without the # symbol. See the hashtag rules in the prompt.',
    },
    arcNote: {
      type: 'string',
      description: 'One line, past tense, summarising what happened, for the series log.',
    },
    arcUpdate: {
      type: 'string',
      description: 'Where the relationship stands now. Empty string if unchanged.',
    },
    newRunningGag: {
      type: 'string',
      description: 'A new running gag introduced this episode, or empty string.',
    },
  },
  required: ['title', 'scene', 'caption', 'hashtags', 'arcNote'],
};

/**
 * Rotating situations.
 *
 * These are deliberately UNIVERSAL couple moments rather than abstract story
 * shapes. An earlier version described structure ("Teddy over-engineers
 * something") and produced clever episodes that nobody recognised themselves
 * in. Saves and shares stayed at zero, and those are the signals that reach
 * people who do not already follow the account.
 *
 * A reader should look at the picture and think "that is literally us" before
 * they finish the caption. That reaction is what gets a post sent to someone.
 */
const BEATS = [
  'THE BLANKET. One of them has ended up with almost all of it. Nobody is admitting anything.',
  'WHAT DO YOU WANT TO EAT. Neither will pick. Both have opinions about every suggestion.',
  'FELL ASLEEP MID-THING. One drifted off partway through something they insisted they were enjoying.',
  'THE HUMAN RADIATOR. One is freezing and has decided the other is now a heat source.',
  'ALMOST READY. One has been ready for ages and is waiting, with visible patience, for the other.',
  'I ORDERED MY OWN. One is eating off the other plate anyway, having sworn they were not hungry.',
  'I AM FINE. One is very obviously not fine. The other knows better than to say so directly.',
  'HOLD THIS. One has become a shelf for the other belongings without being consulted.',
  'THE SYSTEM. One has reorganised something the other had a perfectly good system for.',
  'BOUGHT IT KNOWING. One bought a snack fully aware they would be handing over half of it.',
  'SILENT REPAIR. One knocked something over. The other is fixing it without a single word about it.',
  'TRYING TO BE QUIET. One is asleep. The other is failing, loudly, to do something considerately.',
  'THE RIGHT WAY. A tiny disagreement about the correct method for an utterly trivial chore.',
  'JUST SITTING CLOSER. One is quietly having a bad day. The other says nothing and moves nearer.',
  'ONE SCREEN, TWO FACES. Watching or looking at the same small thing together, heads touching.',
  'NOT EVEN TIRED. One has firmly announced they are not tired. They are asleep in the next moment.',
  'THE LONG STORY. One is telling a very detailed story. The other is listening with real affection.',
  'CAUGHT LOOKING. One glances over fondly and is caught doing it. Neither mentions it.',
];

/** Ask the writer model for the next episode, given everything that came before. */
export async function writeEpisode(state, bible, { avoidScene = '' } = {}) {
  const beat = BEATS[state.episodeCount % BEATS.length];

  // Alternate who is the cause and who reacts. BEATS.length is even, so the
  // two rotations would otherwise stay in lockstep and pair each situation
  // with the same driver forever.
  // Weighted towards Teddy on purpose. Ichigo acting first is written into her
  // character, so an even split still produced four Ichigo-driven episodes out
  // of six. Asking for Teddy more often is what actually lands near 50/50.
  const drivers = [
    'ICHIGO is the one doing it. Teddy reacts.',
    'TEDDY is the one doing it. Ichigo reacts.',
    'TEDDY is the one doing it. Ichigo reacts.',
    'BOTH are equally guilty, or it is nobody fault. Play it as a shared moment.',
  ];
  const driver = drivers[state.episodeCount % drivers.length];
  const recent =
    state.episodes.slice(-20).map((e) => `${e.n}. ${e.summary}`).join('\n') ||
    '(none yet, this is the very first episode)';

  const prompt = `You write an ongoing Instagram comic about a hamster couple in love.
It is warm, funny, and quietly observant about what being in a relationship is
actually like. Think Sarah Andersen or a newspaper strip, not a greetings card.

=== SERIES BIBLE (authoritative, never contradict this) ===
${bible}

=== STORY SO FAR ===
Episodes published: ${state.episodeCount}
Where the relationship is: ${state.currentArc || '(just starting out)'}
Running gags: ${state.runningGags.join(', ') || '(none yet)'}

Recent episodes:
${recent}

=== YOUR TASK ===
Write episode ${state.episodeCount + 1}.

THIS EPISODE'S SITUATION:
${beat}

WHO DRIVES IT THIS TIME: ${driver}

Follow both. They exist because left alone this series collapses into one joke:
Ichigo does something and Teddy patiently endures it. Six consecutive test
episodes all opened with "She", which is one-note across a feed and only lets
half the audience recognise themselves. Whoever is named above is the one being
the human here; the other one reacts.

THE ONE TEST THAT MATTERS:
Would someone see this and send it to their partner saying "this is us"?
That reaction is the entire goal. It is what makes a post get shared, which is
what reaches people who do not follow the account yet. A post that is merely
clever gets a polite like and goes nowhere.

So the situation must be one that MANY couples have lived, not a quirky thing
only these two would do. The hamsters are how it is told; the moment itself has
to belong to the reader.

HOW TO BE FUNNY HERE:
- Universal situation, specific detail. Everyone knows the blanket argument.
  Nobody has seen it lost by a hamster who is simply too round to hold an edge.
- Comedy comes from small domestic truths, not big events. Recognition first,
  jokes second. If it is warm and true but barely funny, that is fine.
- Give one of them a want and the other an obstacle. That is the whole engine.
- Land it slightly askew. If the setup points one way, take the small turn.
- Let them be a little flawed. Perfectly sweet characters are boring and
  nobody recognises themselves in them.
- Never explain the joke. The caption lands it and stops.
- Never be mean. The reader should feel fond of both of them, always.

HARD RULES:
- It must continue the story, not reset it. Reference the arc or a running gag
  when it fits naturally, but do not force one in every time.
- Do NOT reuse the situation, setting or joke of any recent episode above.
- The scene must be ONE still image with a single clear focal action, readable
  at a glance on a phone screen.
- Both hamsters visible unless the story genuinely needs only one.
- No text, words, signs, speech bubbles or captions inside the image.
- Vary it: change the time of day, the room, the mood, who drives the scene.
  Some episodes should be quiet and tender rather than a gag.

THE CAPTION:
- It carries the punchline. The image sets up, the caption pays off.
- One or two short sentences. Dry, understated, human.
- VOICE, and this never changes: a wry third-person observer watching them.
  Refer to them as "he", "she", "Teddy", "Ichigo". NEVER write "I", "we", "my"
  or "our". The narrator is not one of the hamsters and never addresses the
  reader.
- No "Swipe up", no "Tag someone who", no engagement bait, no hashtags in it.
- At most one emoji, and usually zero.
- Instagram reads caption text for search, so let the natural wording include
  what the picture actually shows. Never keyword-stuff; the joke comes first.

HASHTAGS, exactly 5:
Instagram's head has said hashtags no longer boost reach, they categorise the
post. So these are for telling the algorithm what this is, not for hunting
audience. Five precise tags beat ten vague ones.
  - 1 series tag: teddyandichigo
  - 2 niche tags a real fan of this genre would follow, for example
    hamstercomic, couplescomic, wholesomecomics, sliceoflifecomic
  - 2 tags describing THIS episode specifically, drawn from what happens in it
Never use enormous generic pools like cute, love, art, illustration, relatable,
funny or instagood. The post will never surface there and the slot is wasted.
${avoidScene ? `\nThe following scene was just rejected. Write something clearly different:\n"${avoidScene}"` : ''}`;

  const res = await ai().models.generateContent({
    model: models.writer,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: EPISODE_SCHEMA,
      temperature: 1.1,
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
  const prompt = `Illustrate this scene as a single finished storybook illustration.

=== ART AND CHARACTER BIBLE (follow exactly) ===
${bible}

=== CHARACTER REFERENCES ===
The attached images define exactly what these two hamsters look like. Reproduce
their fur colour, markings, body shape, ear shape, proportions and any signature
item faithfully. A reader must recognise them instantly as the same characters
they saw yesterday.

=== SCENE ===
${scene}

=== HOW TO PAINT IT ===
- Painterly storybook illustration: visible brushwork, soft gouache and
  watercolour texture, gentle paper grain. Hand-painted, never glossy or plastic.
- Warm, cosy light with a clear source. Lamplight, late afternoon sun, candles.
  Let it pool and fall off into soft shadow.
- One unmistakable focal point. The composition must read instantly as a
  thumbnail on a phone.
- Faces carry the emotion. Expressions should be readable and specific, not a
  default smile.
- Rich but restrained palette. Harmonious, slightly desaturated, warm.
- Environment tells the story through a few well chosen props, not clutter.

=== HARD RULES ===
- No text, letters, numbers, words, signs, logos, speech bubbles or captions
  anywhere in the image.
- No watermarks, borders, frames or panel dividers.
- Full-bleed illustration filling the entire frame.
- Correct anatomy: four limbs each, no extra or fused paws, no melted faces.
- EYES: large round SOLID glossy black bead eyes, exactly like a real hamster's,
  each with a single small white catchlight. No white sclera, no visible iris or
  pupil separation, no human-shaped eyes, no eyebrows, no eyelashes. This is the
  difference between cute and uncanny, so treat it as absolute.
- Do not restyle the characters. The bible and the references win over any
  instinct to make them cuter or glossier.`;

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

/**
 * One-time: generate a character sheet used to lock a hamster's look.
 *
 * Pass `refs` (already approved sheets of the SAME character) to generate extra
 * angles that actually match. Without them the model re-interprets the text
 * description from scratch and you get a sibling, not the same hamster.
 */
export async function drawCharacterSheet(description, { refs = [], layout = '' } = {}) {
  const prompt = `A character reference sheet for one hamster, painted in a warm
storybook illustration style.

${refs.length ? `The attached image or images show this exact character, already approved.
Match them precisely: same fur colour, same markings, same fur length and
texture, same proportions, same face. Do not redesign or restyle anything. You
are drawing the SAME individual from new angles.

` : ''}${description}

${layout}

Painterly gouache and watercolour texture with visible brushwork and soft edges.
Hand-painted storybook feel, not glossy 3D, not vector, not photographic.

- EYES: large round SOLID glossy black bead eyes, exactly like a real hamster's,
  each with a single small white catchlight. No white sclera, no visible iris or
  pupil separation, no human-shaped eyes, no eyebrows, no eyelashes. This is the
  difference between cute and uncanny, so treat it as absolute.

The design must be simple enough to redraw identically hundreds of times, and
distinctive enough to recognise instantly at thumbnail size.

No text, no labels, no numbers, no arrows, no borders, no drop shadows, no
background scenery.`;

  const parts = [
    { text: prompt },
    ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.data } })),
  ];

  const res = await ai().models.generateContent({
    model: models.artist,
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '4:3', imageSize: image.size },
    },
  });
  const raw = extractImage(res);
  return sharp(raw).jpeg({ quality: 95 }).toBuffer();
}
