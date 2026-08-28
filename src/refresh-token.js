/**
 * Instagram long-lived tokens expire after 60 days. A bot that does not
 * refresh them dies quietly about two months in, which is the single most
 * common failure mode for something like this.
 *
 * Run monthly. Writes the new token straight back into GitHub Secrets when a
 * PAT is available, and always reports to Telegram either way.
 */
import { need, optional } from './config.js';
import { sendMessage } from './telegram.js';

async function refresh() {
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', need('IG_ACCESS_TOKEN'));

  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(json.error.message);
  if (!json.access_token) throw new Error('No access_token in refresh response.');
  return json;
}

/** Store the token back into GitHub Secrets using the repo public key. */
async function updateSecret(token) {
  const pat = optional('GH_PAT');
  const repo = optional('GITHUB_REPOSITORY');
  if (!pat || !repo) return false;

  const headers = {
    Authorization: 'Bearer ' + pat,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const keyRes = await fetch('https://api.github.com/repos/' + repo + '/actions/secrets/public-key', { headers });
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

  const putRes = await fetch('https://api.github.com/repos/' + repo + '/actions/secrets/IG_ACCESS_TOKEN', {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value: encrypted, key_id }),
  });
  if (!putRes.ok) {
    throw new Error('Could not update secret: ' + putRes.status + ' ' + putRes.statusText);
  }
  return true;
}

async function main() {
  const { access_token, expires_in } = await refresh();
  const days = Math.round((expires_in ?? 0) / 86400);

  let stored = false;
  try {
    stored = await updateSecret(access_token);
  } catch (err) {
    await sendMessage(
      'Instagram token refreshed, but saving it failed.\n\n<code>' + err.message + '</code>\n\n' +
        'Update the IG_ACCESS_TOKEN secret by hand:\n<code>' + access_token + '</code>'
    );
    return;
  }

  if (stored) {
    console.log('Token refreshed and stored. Valid for about ' + days + ' days.');
    await sendMessage('Instagram token refreshed automatically. Good for about ' + days + ' more days.');
  } else {
    await sendMessage(
      'Instagram token refreshed, valid about ' + days + ' days, but no GH_PAT is set so I could not store it.\n\n' +
        'Paste this into the IG_ACCESS_TOKEN secret:\n<code>' + access_token + '</code>'
    );
  }
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
