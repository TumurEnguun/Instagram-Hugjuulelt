/**
 * Reads Instagram and Facebook performance and reports what is working.
 *
 *   npm run insights            print a report
 *   npm run insights -- --send  also send it to Telegram
 *
 * The point is not vanity numbers. It is answering two questions the guesswork
 * cannot: which episodes actually landed, and when the audience is online.
 * Real data from this account beats any blog's averages.
 *
 * Only metrics confirmed to work against this app's permissions are requested;
 * Meta retires insight metric names regularly and an invalid one fails the
 * whole call rather than being skipped.
 */
import './config.js';
import { retryFetch } from './net.js';
import { sendMessage } from './telegram.js';
import { readState, writeState } from './store.js';

const IG = 'https://graph.instagram.com/v25.0';
const FB = 'https://graph.facebook.com/v25.0';

const igToken = () => encodeURIComponent(process.env.IG_ACCESS_TOKEN ?? '');
const fbToken = () => encodeURIComponent(process.env.FB_PAGE_ACCESS_TOKEN ?? '');

async function get(url) {
  const res = await retryFetch(url);
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(json.error.message);
  return json;
}

/** Per-post metrics, so we can rank episodes by what actually performed. */
async function instagramPosts(limit = 20) {
  const id = process.env.IG_USER_ID;
  const list = await get(
    `${IG}/${id}/media?fields=id,caption,timestamp,permalink,media_type&limit=${limit}&access_token=${igToken()}`
  );

  const posts = [];
  for (const m of list.data ?? []) {
    let stats = {};
    try {
      const ins = await get(
        `${IG}/${m.id}/insights?metric=reach,likes,saved,shares,comments&access_token=${igToken()}`
      );
      for (const row of ins.data ?? []) stats[row.name] = row.values?.[0]?.value ?? 0;
    } catch {
      // Very fresh posts have no insights yet. Not an error worth failing on.
    }
    posts.push({
      title: (m.caption ?? '').split('\n')[0].slice(0, 60),
      permalink: m.permalink,
      timestamp: m.timestamp,
      ...stats,
    });
  }
  return posts;
}

/**
 * Saves and shares are the strongest signals to non-followers, so rank on those
 * rather than likes. A post people save is one the algorithm will spread.
 */
const score = (p) => (p.saved ?? 0) * 3 + (p.shares ?? 0) * 3 + (p.comments ?? 0) * 2 + (p.likes ?? 0);

function line(p) {
  const bits = [
    `reach ${p.reach ?? '-'}`,
    `likes ${p.likes ?? '-'}`,
    `saves ${p.saved ?? '-'}`,
    `shares ${p.shares ?? '-'}`,
    `comments ${p.comments ?? '-'}`,
  ];
  return `  ${p.timestamp.slice(0, 10)}  ${bits.join('  ')}\n     ${p.title}`;
}

async function main() {
  const out = [];
  const say = (s = '') => { console.log(s); out.push(s); };

  // --- Instagram ---
  const id = process.env.IG_USER_ID;
  const prof = await get(
    `${IG}/${id}?fields=username,followers_count,media_count&access_token=${igToken()}`
  );

  say(`INSTAGRAM  @${prof.username}`);
  say(`  followers ${prof.followers_count}   posts ${prof.media_count}`);
  say('');

  const posts = await instagramPosts();
  if (posts.length) {
    const ranked = [...posts].sort((a, b) => score(b) - score(a));
    say('Best performing (ranked by saves and shares, not likes):');
    for (const p of ranked.slice(0, 5)) say(line(p));
    say('');

    const totals = posts.reduce(
      (a, p) => ({
        reach: a.reach + (p.reach ?? 0),
        likes: a.likes + (p.likes ?? 0),
        saved: a.saved + (p.saved ?? 0),
        shares: a.shares + (p.shares ?? 0),
      }),
      { reach: 0, likes: 0, saved: 0, shares: 0 }
    );
    say(`Across ${posts.length} post(s): reach ${totals.reach}, likes ${totals.likes}, saves ${totals.saved}, shares ${totals.shares}`);
    if (totals.reach > 0) {
      say(`  engagement rate ${(((totals.likes + totals.saved + totals.shares) / totals.reach) * 100).toFixed(1)}% of reach`);
    }
  } else {
    say('No posts yet.');
  }

  // --- Facebook ---
  say('');
  if (process.env.FB_PAGE_ID && process.env.FB_PAGE_ACCESS_TOKEN) {
    try {
      const page = await get(
        `${FB}/${process.env.FB_PAGE_ID}?fields=name,followers_count&access_token=${fbToken()}`
      );
      say(`FACEBOOK  ${page.name}`);
      say(`  followers ${page.followers_count ?? 0}`);

      // Only metric names verified against this app; Meta retires them often
      // and one bad name fails the entire request.
      const ins = await get(
        `${FB}/${process.env.FB_PAGE_ID}/insights?metric=page_post_engagements,page_views_total,page_daily_follows&period=week&access_token=${fbToken()}`
      );
      for (const row of ins.data ?? []) {
        const v = row.values?.[row.values.length - 1]?.value ?? 0;
        say(`  ${row.name.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      }
    } catch (err) {
      say(`FACEBOOK  could not read insights: ${err.message.slice(0, 100)}`);
    }
  }

  if (process.argv.includes('--send')) {
    // The weekly job runs from several slots because GitHub drops most
    // scheduled runs. Whichever fires first sends; the rest stop here.
    const day = new Date().toISOString().slice(0, 10);
    const state = readState();
    if (state.lastReportOn === day && !process.argv.includes('--force')) {
      console.log('Report already sent today. Skipping.');
      return;
    }
    writeState({ ...state, lastReportOn: day });

    await sendMessage(`<b>Insights</b>\n\n<pre>${out.join('\n').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`);
    console.log('\nSent to Telegram.');
  }
}

main().catch((err) => {
  console.error('\n' + err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
