/**
 * Gets a never-expiring Facebook Page access token.
 *
 *   npm run fb-setup
 *
 * Facebook makes this needlessly awkward. The Graph API Explorer hands you a
 * USER token that dies in an hour or two, and a Page token derived from it dies
 * with it. The trick is to exchange the short-lived user token for a long-lived
 * one first: Page tokens derived from a long-lived user token do not expire at
 * all, which is exactly what an unattended bot needs.
 *
 * This script does that exchange and prints what to paste into .env.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import './config.js';
import { retryFetch } from './net.js';

const GRAPH = 'https://graph.facebook.com/v25.0';
const rl = readline.createInterface({ input: stdin, output: stdout });

async function graph(pathname, params) {
  const url = new URL(GRAPH + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await retryFetch(url.toString());
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(json.error.message);
  return json;
}

async function main() {
  console.log('\n=== Facebook Page token setup ===\n');
  console.log('First, get a short-lived user token:');
  console.log('  1. Open https://developers.facebook.com/tools/explorer');
  console.log('  2. Pick your app (Hamster-bot) in the top right');
  console.log('  3. Click "Add a Permission" and tick:');
  console.log('       pages_show_list');
  console.log('       pages_manage_posts');
  console.log('       pages_manage_engagement');
  console.log('');
  console.log('     Tick ONLY those three. pages_read_engagement and');
  console.log('     pages_read_user_content are not available to this kind of app');
  console.log('     and cause an Invalid Scopes error.');
  console.log('  4. Click "Generate Access Token" and approve');
  console.log('  5. Copy the token it shows\n');

  const appId = (await rl.question('Your Meta App ID: ')).trim();
  const appSecret = (await rl.question('Your Meta App Secret: ')).trim();
  const shortToken = (await rl.question('The token you just copied: ')).trim();

  if (!appId || !appSecret || !shortToken) {
    throw new Error('All three values are required.');
  }

  console.log('\nExchanging for a long-lived token...');
  const longLived = await graph('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortToken,
  });
  console.log('  done');

  console.log('Fetching your Pages...');
  const pages = await graph('/me/accounts', { access_token: longLived.access_token });

  if (!pages.data?.length) {
    throw new Error('No Pages found on this account. Check you granted pages_show_list.');
  }

  console.log('\n=== Paste these into .env ===\n');
  for (const page of pages.data) {
    console.log(`# ${page.name}`);
    console.log(`FB_PAGE_ID=${page.id}`);
    console.log(`FB_PAGE_ACCESS_TOKEN=${page.access_token}`);
    console.log('');
  }

  if (pages.data.length > 1) {
    console.log('More than one Page listed. Use the pair for the Page you want to post to.\n');
  }
  console.log('This Page token does not expire, so unlike the Instagram one it');
  console.log('never needs refreshing. Then run: npm run doctor\n');

  rl.close();
}

main().catch((err) => {
  console.error('\nFailed: ' + err.message);
  if (process.env.DEBUG) console.error(err.stack);
  rl.close();
  process.exit(1);
});
