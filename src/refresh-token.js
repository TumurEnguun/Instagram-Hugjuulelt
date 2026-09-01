/**
 * Instagram long-lived tokens expire after 60 days. A bot that does not
 * refresh them dies quietly about two months in, which is the single most
 * common failure mode for something like this.
 *
 * Run monthly in CI, or any time locally with `npm run refresh-token`.
 *
 * SECURITY RULE, learned the embarrassing way: the token itself is NEVER sent
 * over Telegram. Bot messages sit on Telegram's servers in plaintext, and a
 * credential does not belong there. Instead:
 *
 *   CI with GH_PAT       refresh and store into GitHub Secrets automatically
 *   CI without GH_PAT    do not refresh at all; message says to run it locally
 *   locally              refresh and write the new token into .env, then tell
 *                        Enguun to update the GitHub secret and run verify
 */
import { need, optional, setEnv } from './config.js';
import { retryFetch } from './net.js';
import { sendMessage } from './telegram.js';

const inCI = process.env.GITHUB_ACTIONS === 'true';

async function refresh() {
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', need('IG_ACCESS_TOKEN'));

  const res = await retryFetch(url.toString());
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(json.error.message);
  if (!json.access_token) throw new Error('No access_token in refresh response.');
  return json;
}

/** Store the token back into GitHub Secrets using the repo public key. */
async function updateSecret(token) {
  const pat = need('GH_PAT');
  const repo = need('GITHUB_REPOSITORY');

  const headers = {
    Authorization: 'Bearer ' + pat,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const keyRes = await retryFetch('https://api.github.com/repos/' + repo + '/actions/secrets/public-key', { headers });
  if (!keyRes.ok) {
    throw new Error('Could not fetch repo public key: ' + keyRes.status + ' ' + keyRes.statusText);
  }
  const { key, key_id } = await keyRes.json();

  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(token),
    sodium.from_base64(key, sodium.base64_variants.ORIGINAL)
  );
  const encrypted = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);

  const putRes = await retryFetch('https://api.github.com/repos/' + repo + '/actions/secrets/IG_ACCESS_TOKEN', {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value: encrypted, key_id }),
  });
  if (!putRes.ok) {
    throw new Error('Could not update secret: ' + putRes.status + ' ' + putRes.statusText);
  }
}

// Storing the token locally uses the shared setEnv from config.js. This used to
// be a private copy that demanded an exact `^IG_ACCESS_TOKEN=` line and threw
// when it did not find one, AFTER Instagram had already minted a replacement.
// The new token then existed only in a local variable and was lost, while the
// alert claimed the refresh had failed. Instagram will not issue another for 24
// hours, so that cost a day. setEnv upserts and never throws.

async function main() {
  // In CI without a PAT there is nowhere safe to put a new token, so do not
  // create one. The old token stays valid until its own expiry; the useful
  // action is a nudge to refresh locally, where .env can hold the result.
  if (inCI && !optional('GH_PAT')) {
    console.log('No GH_PAT in CI; skipping refresh and asking for a local run instead.');
    await sendMessage(
      'Monthly Instagram token check: no GH_PAT is set, so the token cannot be ' +
        'refreshed automatically.\n\nRun <code>npm run refresh-token</code> on your PC ' +
        'this week, then update the IG_ACCESS_TOKEN GitHub secret and run the ' +
        'Verify secrets workflow. No tokens are ever sent through this chat.'
    );
    return;
  }

  const { access_token, expires_in } = await refresh();
  const days = Math.round((expires_in ?? 0) / 86400);

  if (inCI) {
    await updateSecret(access_token);
    console.log('Token refreshed and stored in GitHub Secrets. Valid ~' + days + ' days.');
    await sendMessage('Instagram token refreshed automatically. Good for about ' + days + ' more days.');
    return;
  }

  setEnv('IG_ACCESS_TOKEN', access_token);
  console.log('Token refreshed and written into .env. Valid ~' + days + ' days.');
  console.log('');
  console.log('Now: copy IG_ACCESS_TOKEN from .env into the GitHub secret of the same');
  console.log('name, then run the Verify secrets workflow in the Actions tab.');
}

main().catch(async (err) => {
  console.error(err.message);
  if (process.env.DEBUG) console.error(err.stack);
  try {
    await sendMessage(
      'Instagram token refresh FAILED.\n\n<code>' + err.message + '</code>\n\n' +
        'The bot will stop posting once the token expires.'
    );
  } catch {
    // Telegram itself may be down; the workflow log still has the error.
  }
  process.exit(1);
});
