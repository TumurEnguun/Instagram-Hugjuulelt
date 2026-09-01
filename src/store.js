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
/** UTC date stamp, e.g. 2026-09-01. Every retry slot falls on one UTC day. */
export const today = () => new Date().toISOString().slice(0, 10);

/**
 * Run something at most once per UTC day, across every retry slot.
 *
 * GitHub drops most scheduled runs, so each job is scheduled several times and
 * needs a claim. Getting the ORDER right matters and had been decided
 * differently in each place that hand-rolled it: the marker must only be
 * written after the work actually succeeded. insights.js previously marked the
 * weekly report as sent before sending it, so one failed Telegram call
 * disabled that week's remaining slots and the report was simply lost.
 *
 * Returns what `fn` returned, or SKIPPED when the day is already claimed.
 */
export const SKIPPED = Symbol('already ran today');

export async function runOncePerDay(key, fn, { force = false } = {}) {
  const day = today();
  if (!force && readState()[key] === day) return SKIPPED;

  const result = await fn();

  // Re-read rather than reusing the earlier snapshot: fn may well have written
  // state of its own, and clobbering it here would undo the work just done.
  writeState({ ...readState(), [key]: day });
  return result;
}

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
