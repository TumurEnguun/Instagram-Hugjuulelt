/**
 * Trend scout. Finds what is trending this week and turns it into hamster ideas.
 *
 *   node src/trends.js     print today's trend options, send nothing
 *
 * Uses Gemini with Google Search grounding, so it reads the live web rather
 * than the model's memory. Instagram's own trending data (Reels audio, Explore)
 * has no API, so this reads what the web says is trending on Instagram and
 * TikTok, which usually lags the real thing by a day or two.
 *
 * The scout only proposes. Enguun picks on Telegram; nothing here posts.
 */
import { GoogleGenAI } from '@google/genai';
import { models, need } from './config.js';
import { readState, readBible, today } from './store.js';

let client;
function ai() {
  if (!client) client = new GoogleGenAI({ apiKey: need('GEMINI_API_KEY') });
  return client;
}

/** Pull the first JSON object out of a model reply that may wrap it in prose or fences. */
function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Trend scout returned no JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Returns { options: [{name, what, hamsterAngle, hashtag}], bestFit, bioIdea }.
 * bestFit is the index the scout would pick unprompted, or null when nothing
 * suits the series today. That is what runs if Enguun does not tap in time.
 */
export async function scoutTrends(state, bible) {
  const recent = state.episodes.slice(-7).map((e) => `${e.n}. ${e.summary}`).join('\n') || '(none)';

  const prompt = `Today is ${today()}. You are the trend scout for an Instagram comic account,
"Teddy & Ichigo": a painted storybook comic about a hamster couple in love. Warm,
dry, observational humour about real relationships. Every post is ONE still image
with no text in it; the caption carries the punchline.

=== CHARACTERS AND STYLE ===
${bible.slice(0, 3000)}

=== RECENT EPISODES ===
${recent}

=== YOUR JOB ===
Use Google Search to find what is trending RIGHT NOW (the last 7 days) that a
cute couple-comic account could ride. Good sources of trends:
- Viral Instagram Reels and TikTok formats, memes and catchphrases
- Seasonal moments and upcoming holidays or observances (check the date)
- Viral internet moments, food trends, wholesome viral stories
- Relationship and couple trends people are posting about

Pick the 5 best for THIS account. For each, invent the hamster angle: how Teddy
and Ichigo would live this trend as a small couple moment in ONE still picture.

NEVER include, no matter how big:
- tragedies, deaths, disasters, war, crime, illness
- politics, elections, politicians, culture-war topics
- anything sexual, drugs, alcohol-centred, gross-out
- trends that only work with words on screen or a specific audio track
- trends built on a specific copyrighted character, celebrity, brand or show
  (the hamsters cannot dress up as or imitate a real person or franchise)
- drama about a specific real person

Reply with ONLY this JSON, no prose before or after:
{
  "options": [
    {
      "name": "short trend name, max 6 words",
      "what": "one sentence: what the trend is and where it is big",
      "hamsterAngle": "one sentence: the Teddy and Ichigo version, as a picture",
      "hashtag": "the real hashtag people use for it, no #, or empty string"
    }
  ],
  "bestFit": 0,
  "bioIdea": "a fresh Instagram bio for the account that nods to the season or a trend, max 120 characters, no emoji spam"
}
bestFit is the index (0-4) of the option you would pick, or null if none of
them genuinely suits a warm hamster love story today.`;

  const res = await ai().models.generateContent({
    model: models.writer,
    contents: prompt,
    config: { tools: [{ googleSearch: {} }], temperature: 0.7 },
  });

  const text = res.text;
  if (!text) throw new Error('Trend scout returned no text.');
  const out = parseJson(text);

  const options = (out.options ?? []).slice(0, 5).map((o) => ({
    name: String(o.name ?? '').trim(),
    what: String(o.what ?? '').trim(),
    hamsterAngle: String(o.hamsterAngle ?? '').trim(),
    hashtag: String(o.hashtag ?? '').replace(/^#/, '').trim(),
  })).filter((o) => o.name);

  if (options.length === 0) throw new Error('Trend scout found no usable trends.');

  const best = Number.isInteger(out.bestFit) && out.bestFit >= 0 && out.bestFit < options.length ? out.bestFit : null;
  return { options, bestFit: best, bioIdea: String(out.bioIdea ?? '').trim() };
}

// CLI: print today's options without touching Telegram or state.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('trends.js')) {
  scoutTrends(readState(), readBible())
    .then((t) => {
      t.options.forEach((o, i) => {
        console.log(`\n${i + 1}. ${o.name}${i === t.bestFit ? '   <- best fit' : ''}`);
        console.log(`   ${o.what}`);
        console.log(`   Hamsters: ${o.hamsterAngle}`);
        if (o.hashtag) console.log(`   #${o.hashtag}`);
      });
      console.log(`\nBio idea: ${t.bioIdea}`);
      if (t.bestFit === null) console.log('\nScout says nothing fits today; the default would be a normal story episode.');
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
