/**
 * Gets a never-expiring Facebook Page access token and writes it into .env.
 *
 *   npm run fb-setup
 *
 * Facebook has three token tiers, and only the last one is any use to a bot:
 *
 *   short-lived user token   what the Graph API Explorer hands you, ~1-2 hours
 *   long-lived user token    requires the App Secret to obtain, 60 days
 *   PAGE token derived from a long-lived user token   never expires
 *
 * A Page token inherits the lifetime of whatever produced it, so deriving one
 * straight from the Explorer's token gives you something that dies the same
 * day. The exchange in the middle is the entire point of this script.
 *
 * Values are read from .env when present (META_APP_ID, META_APP_SECRET,
 * FB_USER_TOKEN) and prompted for otherwise. The resulting Page token is
 * written straight into .env, so there is no line to copy wrongly.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { setEnv } from './config.js';
import { retryFetch } from './net.js';

const GRAPH = 'https://graph.facebook.com/v25.0';

async function graph(pathname, params) {
  const url = new URL(GRAPH + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await retryFetch(url.toString());
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(json.error.message);
  return json;
}

async function main() {
  let appId = process.env.META_APP_ID;
  let appSecret = process.env.META_APP_SECRET;
  let userToken = process.env.FB_USER_TOKEN;

  if (!appId || !appSecret || !userToken) {
    console.log('\n=== Facebook Page token setup ===\n');
    console.log('Get a fresh user token first:');
    console.log('  1. https://developers.facebook.com/tools/explorer');
    console.log('  2. Meta App: Hamster-bot');
    console.log('  3. User or Page: USER TOKEN  (not the Page)');
    console.log('  4. Permissions: pages_show_list, pages_manage_posts,');
    console.log('                  pages_manage_engagement, pages_read_engagement');
    console.log('  5. Generate Access Token, approve, copy it');
    console.log('');
    console.log('It expires in about an hour, so do this right before continuing.\n');

    const rl = readline.createInterface({ input: stdin, output: stdout });
    appId = appId || (await rl.question('Meta App ID: ')).trim();
    appSecret = appSecret || (await rl.question('Meta App Secret: ')).trim();
    userToken = userToken || (await rl.question('The user token: ')).trim();
    rl.close();
  } else {
    console.log('\nUsing META_APP_ID, META_APP_SECRET and FB_USER_TOKEN from .env\n');
  }

  if (!appId || !appSecret || !userToken) throw new Error('All three values are required.');

  console.log('Exchanging for a long-lived user token...');
  const longLived = await graph('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: userToken,
  });
  const days = longLived.expires_in ? Math.round(longLived.expires_in / 86400) : null;
  console.log(`  got one${days ? `, valid ~${days} days` : ''}`);

  console.log('Deriving the Page token from it...');
  const pages = await graph('/me/accounts', {
    fields: 'id,name,access_token',
    access_token: longLived.access_token,
  });
  if (!pages.data?.length) throw new Error('No Pages found. Check pages_show_list was granted.');

  const wanted = process.env.FB_PAGE_ID;
  const page = pages.data.find((p) => p.id === wanted) ?? pages.data[0];
  if (!page.access_token) throw new Error('Facebook returned no Page token.');

  // Confirm it really is non-expiring before claiming so.
  const check = await graph('/debug_token', {
    input_token: page.access_token,
    access_token: `${appId}|${appSecret}`,
  });
  const expiresAt = check.data?.expires_at;
  const permanent = expiresAt === 0 || expiresAt === undefined;

  setEnv('FB_PAGE_ID', page.id);
  setEnv('FB_PAGE_ACCESS_TOKEN', page.access_token);

  console.log('');
  console.log(`Wrote FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN into .env for "${page.name}".`);
  console.log(
    permanent
      ? '  This token does NOT expire.'
      : `  WARNING: it still expires at ${new Date(expiresAt * 1000).toISOString()}. ` +
        'The user token was probably not long-lived. Try again with a fresh one.'
  );
  console.log('');
  console.log('Now update the same two values in GitHub Secrets, then: npm run doctor');

  if (pages.data.length > 1) {
    console.log('\nOther Pages on this account:');
    for (const p of pages.data) if (p.id !== page.id) console.log(`  ${p.id}  ${p.name}`);
  }
}

main().catch((err) => {
  console.error('\nFailed: ' + err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
