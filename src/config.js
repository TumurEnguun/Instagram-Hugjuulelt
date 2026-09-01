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
  // Comedy is hard, and text costs fractions of a cent, so this is the one
  // place where paying for a stronger model is obviously worth it.
  writer: 'gemini-3.7-flash',
  // Pro handles character consistency and composition noticeably better, for
  // about three cents more per post. Worth it for the one image people see.
  artist: 'gemini-3-pro-image',
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

/**
 * Write a key into .env, replacing the existing line or appending a new one.
 *
 * Upsert, never throw. refresh-token.js used to demand an exact
 * `^IG_ACCESS_TOKEN=` line and threw when it did not find one, AFTER Instagram
 * had already minted a replacement token. The new token existed only in a local
 * variable and was lost, while the alert claimed the refresh had failed. Since
 * Instagram will not issue another for 24 hours, that mistake cost a day.
 *
 * The pattern is deliberately looser than an exact match, mirroring the loader
 * above, which tolerates whitespace around the name and the equals sign.
 */
export function setEnv(name, value) {
  const file = path.join(ROOT, '.env');
  let env = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const line = `${name}=${value}`;
  const existing = new RegExp(`^\\s*${name}\\s*=.*$`, 'm');

  env = existing.test(env) ? env.replace(existing, line) : env.trimEnd() + '\n' + line + '\n';
  fs.writeFileSync(file, env);
  process.env[name] = value;
}
