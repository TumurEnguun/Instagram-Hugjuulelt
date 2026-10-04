/**
 * Reads and writes the two pieces of persistent state:
 *   story-state.json  the ongoing series (episode log, arc, running gags)
 *   pending.json      the single post currently awaiting Enguun's approval
 *   trends.json       today's trend options and the one picked
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

// Today's trend options and which one was picked. See trends.js and propose.js.
export const readTrends = () => readJson(paths.trends, { date: '' });
export const writeTrends = (t) => writeJson(paths.trends, t);

// Remix inbox: trend videos Enguun sends the bot, and the buttons on them.
const EMPTY_REMIX = { seenUpdateId: 0, jobs: [], presses: [], notices: [] };
export const readRemix = () => ({ ...structuredClone(EMPTY_REMIX), ...readJson(paths.remix, EMPTY_REMIX) });
export const writeRemix = (r) => writeJson(paths.remix, r);

/**
 * Save anything remix-related out of a batch of Telegram updates BEFORE the
 * caller confirms them. Every reader of the queue calls this, because
 * confirming an update deletes it for good: without this, a video sent while a
 * proposal was pending would be thrown away by the next drain.
 *
 * Only messages from Enguun's own chat count. Deduplicated by update_id.
 */
export function stashUpdates(results) {
  if (!results?.length) return;
  const chatId = String(process.env.TELEGRAM_CHAT_ID ?? '');
  const r = readRemix();
  let changed = false;

  for (const u of results) {
    if (u.update_id <= r.seenUpdateId) continue;
    r.seenUpdateId = u.update_id;
    changed = true;

    const m = u.message;
    if (m && String(m.chat?.id) === chatId) {
      const vid = m.video ?? (m.document && /^video\//.test(m.document.mime_type ?? '') ? m.document : null);
      if (vid) {
        r.jobs.push({
          id: `rx${u.update_id}`,
          fileId: vid.file_id,
          fileSize: vid.file_size ?? 0,
          note: m.caption ?? '',
          status: 'new',
          attempt: 0,
          receivedAt: new Date().toISOString(),
        });
      } else if (typeof m.text === 'string') {
        if (/instagram\.com\/(reel|p)\/|tiktok\.com\//i.test(m.text)) {
          r.notices.push('link');
        } else {
          // A text right after a video is treated as casting notes for it.
          const last = [...r.jobs].reverse().find((j) => j.status === 'new');
          if (last) last.note = [last.note, m.text].filter(Boolean).join(' ');
        }
      }
    }

    const cb = u.callback_query;
    if (cb && String(cb.data ?? '').startsWith('RMX')) {
      r.presses.push({ data: cb.data, callbackId: cb.id, updateId: u.update_id });
    }
  }
  if (changed) writeRemix(r);
}

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
