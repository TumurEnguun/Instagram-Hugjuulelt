/**
 * ONE TIME setup: invent the two hamsters, lock their look, write the bible.
 *
 * Everything the daily bot produces is anchored to what comes out of this
 * script, so it is worth taking your time here. Run it locally, not in CI:
 *
 *   npm run bootstrap
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { GoogleGenAI } from '@google/genai';
import { paths, models, need } from './config.js';
import { drawCharacterSheet } from './gemini.js';
import { writeState } from './store.js';

const rl = readline.createInterface({ input: stdin, output: stdout });

async function ask(question, fallback = '') {
  const suffix = fallback ? ' [' + fallback + ']' : '';
  const answer = await rl.question(question + suffix + ' ');
  return answer.trim() || fallback;
}

const BIBLE_SCHEMA = {
  type: 'object',
  properties: {
    seriesTitle: { type: 'string' },
    artStyle: {
      type: 'string',
      description: 'One locked paragraph describing the visual style, palette, lighting and rendering.',
    },
    hamsterA: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        appearance: {
          type: 'string',
          description: 'Fur colour, markings, ear and body shape, signature accessory. Very specific and repeatable.',
        },
        personality: { type: 'string' },
      },
      required: ['name', 'appearance', 'personality'],
    },
    hamsterB: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        appearance: { type: 'string' },
        personality: { type: 'string' },
      },
      required: ['name', 'appearance', 'personality'],
    },
    world: { type: 'string', description: 'Where they live and the recurring settings.' },
    neverDo: { type: 'array', items: { type: 'string' }, description: 'Things that must never appear.' },
  },
  required: ['seriesTitle', 'artStyle', 'hamsterA', 'hamsterB', 'world', 'neverDo'],
};

async function inventBible(brief) {
  const ai = new GoogleGenAI({ apiKey: need('GEMINI_API_KEY') });
  const res = await ai.models.generateContent({
    model: models.writer,
    contents: `Design the series bible for a cute, funny Instagram comic about a hamster couple in love.

User's brief: ${brief || 'Surprise me. Make it warm, funny and very shareable.'}

Requirements:
- The two hamsters must be visually DISTINCT from each other and easy to tell apart at a glance
  (different fur colour, different markings, different silhouette).
- Appearance descriptions must be concrete and repeatable, because an image model will re-read
  them every single day for months. Avoid vague words like "cute" or "nice".
- The art style must be one consistent, appealing look that suits Instagram.
- Give them names that are short and memorable.`,
    config: { responseMimeType: 'application/json', responseSchema: BIBLE_SCHEMA, temperature: 1.0 },
  });
  return JSON.parse(res.text);
}

function renderBible(b) {
  const never = b.neverDo.map((n) => '- ' + n).join('\n');
  return `# Series Bible

**Series:** ${b.seriesTitle}

## Art style (LOCKED - never change this)

${b.artStyle}

## World

${b.world}

## ${b.hamsterA.name}

- **Appearance:** ${b.hamsterA.appearance}
- **Personality:** ${b.hamsterA.personality}

## ${b.hamsterB.name}

- **Appearance:** ${b.hamsterB.appearance}
- **Personality:** ${b.hamsterB.personality}

## Never do

${never}
- No text, letters, numbers, signs, logos or speech bubbles anywhere in the image.
- Never change the art style, fur colours or markings between episodes.
`;
}

async function sheetFor(hamster, artStyle, label) {
  const description = [
    'Name: ' + hamster.name,
    'Appearance: ' + hamster.appearance,
    'Art style: ' + artStyle,
  ].join('\n');

  for (let attempt = 1; ; attempt++) {
    console.log('\nDrawing ' + hamster.name + ' (attempt ' + attempt + ')...');
    const jpeg = await drawCharacterSheet(description);

    fs.mkdirSync(paths.characters, { recursive: true });
    const file = path.join(paths.characters, label + '.jpg');
    fs.writeFileSync(file, jpeg);
    console.log('Saved ' + file + ' - open it and take a look.');

    const keep = await ask('Keep this as the locked look for ' + hamster.name + '? (y/n)', 'y');
    if (keep.toLowerCase().startsWith('y')) return file;
    console.log('Redrawing...');
  }
}

async function main() {
  console.log('\n=== Hamster bootstrap ===');
  console.log('This locks in your two characters. Everything else depends on it.\n');

  const brief = await ask('Describe the vibe you want (or press Enter to let Gemini invent it):');

  let bible;
  for (;;) {
    console.log('\nDesigning the series...');
    bible = await inventBible(brief);
    console.log('\n' + renderBible(bible));
    const ok = await ask('Happy with this? (y/n)', 'y');
    if (ok.toLowerCase().startsWith('y')) break;
  }

  fs.writeFileSync(paths.bible, renderBible(bible));
  console.log('\nWrote ' + paths.bible);

  // Two reference sheets, one per hamster, well inside the 4 character-image limit.
  await sheetFor(bible.hamsterA, bible.artStyle, '01-' + bible.hamsterA.name.toLowerCase());
  await sheetFor(bible.hamsterB, bible.artStyle, '02-' + bible.hamsterB.name.toLowerCase());

  writeState({
    seriesTitle: bible.seriesTitle,
    episodeCount: 0,
    currentArc: 'They have just started dating and are figuring each other out.',
    runningGags: [],
    episodes: [],
  });

  console.log('\nDone. Next: run `npm run propose:dry` a few times to check the hamsters stay consistent.');
  rl.close();
}

main().catch((err) => {
  console.error('\nBootstrap failed:', err.message);
  rl.close();
  process.exit(1);
});
