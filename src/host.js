/**
 * Instagram downloads the image from a public URL, so the JPEG has to be
 * reachable on the open internet at publish time.
 *
 * Default strategy: the repo itself. The file is committed by the workflow and
 * served by raw.githubusercontent.com, which costs nothing and needs no extra
 * account. It is deleted again once Instagram has fetched it.
 *
 * To keep the repo private instead, replace publicUrlFor() with a Cloudinary or
 * S3 upload. Nothing else in the codebase needs to change.
 */
import { need, optional } from './config.js';

/**
 * Accept whatever form of the repo the user pasted. Copying the clone URL out
 * of GitHub is the obvious thing to do, and it silently produces a nonsense
 * raw URL that Instagram rejects with an unrelated-sounding error.
 */
export function normalizeRepo(value) {
  const repo = String(value)
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(
      `GITHUB_REPOSITORY should look like "owner/repo", got "${value}". ` +
        `Use TumurEnguun/Instagram-Hugjuulelt, not the full clone URL.`
    );
  }
  return repo;
}

export function publicUrlFor(filename) {
  const repo = normalizeRepo(need('GITHUB_REPOSITORY'));
  const branch = optional('GITHUB_BRANCH', 'main');
  return `https://raw.githubusercontent.com/${repo}/${branch}/posts/${filename}`;
}

/**
 * Instagram fails opaquely if it cannot fetch the image, so confirm the URL is
 * actually live first. GitHub's CDN can lag a few seconds behind a push.
 */
export async function waitUntilReachable(url, { attempts = 10, delayMs = 3000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return true;
    } catch {
      // network hiccup, fall through to retry
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
