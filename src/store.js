/**
 * Reads and writes the two pieces of persistent state:
 *   story-state.json  the ongoing series (episode log, arc, running gags)
 *   pending.json      the single post currently awaiting Enguun's approval
 */
import fs from 'node:fs';
import { paths } from './config.js';

const EMPTY_STATE = {
  seriesTitle: '',
  episodeCount: 0,
  currentArc: '',
  runningGags: [],
  // One line per past episode. Keeps continuity without unbounded growth.
  episodes: [],
};

const EMPTY_PENDING = { status: 'none' };

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return structuredClone(fallback);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is corrupt and cannot be parsed: ${err.message}`);
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export const readState = () => readJson(paths.state, EMPTY_STATE);
export const writeState = (s) => writeJson(paths.state, s);
export const readPending = () => readJson(paths.pending, EMPTY_PENDING);
export const writePending = (p) => writeJson(paths.pending, p);
export const clearPending = () => writeJson(paths.pending, EMPTY_PENDING);

export function readBible() {
  if (!fs.existsSync(paths.bible)) {
    throw new Error('bible.md not found. Run `npm run bootstrap` first to create the hamsters.');
  }
  return fs.readFileSync(paths.bible, 'utf8');
}

/**
 * Load the locked character reference images as base64, ready for Gemini.
 *
 * gemini-3-pro-image accepts at most 5 character reference images. Keep the set
 * BALANCED: feeding three sheets of one hamster and one of the other biases
 * every generation toward whoever is over-represented. Extra sheets live in
 * characters/extra/ and are ignored here.
 */
export function readCharacterRefs() {
  if (!fs.existsSync(paths.characters)) return [];
  const files = fs.readdirSync(paths.characters)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort();

  return files.slice(0, 5).map((f) => ({
    name: f,
    mimeType: /\.png$/i.test(f) ? 'image/png' : 'image/jpeg',
    data: fs.readFileSync(`${paths.characters}/${f}`).toString('base64'),
  }));
}

/**
 * Append a published episode to the series log and bump the counter.
 * Only called after Instagram confirms the post, so the log never drifts
 * ahead of what is actually on the feed.
 */
export function recordEpisode(state, episode, permalinkId) {
  state.episodeCount += 1;
  state.episodes.push({
    n: state.episodeCount,
    title: episode.title,
    summary: episode.arcNote,
    postedAt: new Date().toISOString(),
    igMediaId: permalinkId,
  });
  if (episode.newRunningGag && !state.runningGags.includes(episode.newRunningGag)) {
    state.runningGags.push(episode.newRunningGag);
  }
  if (episode.arcUpdate) state.currentArc = episode.arcUpdate;
  return state;
}
