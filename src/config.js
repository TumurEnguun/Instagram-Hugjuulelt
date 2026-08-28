/**
 * Central config. Reads .env when running locally, plain env vars in CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so we don't need a dependency for it.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

export const paths = {
  characters: path.join(ROOT, 'characters'),
  posts: path.join(ROOT, 'posts'),
  bible: path.join(ROOT, 'bible.md'),
  state: path.join(ROOT, 'story-state.json'),
  pending: path.join(ROOT, 'pending.json'),
};

export const models = {
  // Stable generateContent path. The `interactions` API is still marked
  // experimental by the SDK, which is the wrong bet for a bot that has to
  // run unattended for months.
  writer: 'gemini-3.5-flash-lite',
  artist: 'gemini-3.1-flash-image',
};

export const image = {
  // 4:5 is the tallest ratio Instagram allows in feed, so it takes the most
  // screen space. Fallbacks are tried in order if the model rejects a ratio.
  aspectRatios: ['4:5', '3:4', '1:1'],
  size: '2K',
  jpegQuality: 90,
};

/** Read a required env var, failing loudly rather than at the API call. */
export function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. See .env.example / SETUP.md`);
  return v;
}

export function optional(name, fallback = '') {
  return process.env[name] || fallback;
}
