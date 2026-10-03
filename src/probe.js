// Probe: can our Facebook-side tokens read OTHER public business/creator accounts
// via Business Discovery?  (Facebook Login only; the Instagram Login token can't.)
// Usage: node src/probe.js natgeo nike
import './config.js';

const V = 'v25.0';
const FB_PAGE = process.env.FB_PAGE_ID;
const APP = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
const tokens = [
  ['page token  (FB_PAGE_ACCESS_TOKEN)', process.env.FB_PAGE_ACCESS_TOKEN],
  ['user token  (FB_USER_TOKEN)      ', process.env.FB_USER_TOKEN],
].filter(([, t]) => t);
const targets = process.argv.slice(2);
if (!targets.length) { console.log('usage: node src/probe.js handle1 handle2 ...'); process.exit(1); }

const get = async (path, params) => {
  const u = new URL(`https://graph.facebook.com/${V}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return (await fetch(u)).json();
};
const BD = (t) => `business_discovery.username(${t}){username,name,followers_count,media_count,media.limit(3){id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,children{media_url,media_type}}}`;

// ---- diagnostics -------------------------------------------------------
console.log('=== token diagnostics');
for (const [label, tok] of tokens) {
  const d = await get('debug_token', { input_token: tok, access_token: APP });
  if (d.error) { console.log(`  ${label}: debug ERROR ${d.error.message}`); continue; }
  const x = d.data;
  console.log(`  ${label}: type=${x.type} valid=${x.is_valid} expires=${x.expires_at ? new Date(x.expires_at * 1000).toISOString() : 'never'}`);
  console.log(`     scopes: ${(x.scopes || []).join(', ')}`);
  for (const g of x.granular_scopes || []) if (g.target_ids) console.log(`     ${g.scope} -> ${g.target_ids.join(', ')}`);
}
const userTok = process.env.FB_USER_TOKEN;
if (userTok) {
  const acc = await get('me/accounts', { fields: 'id,name,instagram_business_account{id,username},connected_instagram_account{id,username}', access_token: userTok });
  console.log('  pages visible to user token:');
  if (acc.error) console.log(`     ERROR ${acc.error.message}`);
  else for (const p of acc.data ?? []) console.log(`     ${p.id} "${p.name}"  instagram_business_account=${p.instagram_business_account?.username ?? '-'}  connected_instagram_account=${p.connected_instagram_account?.username ?? '-'}`);
}

// ---- business discovery ------------------------------------------------
// Look at EVERY Page the user token can see, not just FB_PAGE_ID: Business Discovery
// works through any Page with a linked IG professional account.
const pagesResp = userTok
  ? await get('me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username},connected_instagram_account{id,username}', access_token: userTok })
  : { data: [] };
const pages = pagesResp.data ?? [];
if (!pages.find(p => p.id === FB_PAGE)) pages.push({ id: FB_PAGE, name: '(FB_PAGE_ID from .env)', access_token: process.env.FB_PAGE_ACCESS_TOKEN });

let anyLinked = false;
for (const p of pages) {
  const tok = p.access_token || process.env.FB_PAGE_ACCESS_TOKEN;
  const page = await get(p.id, { fields: 'name,instagram_business_account{id,username},connected_instagram_account{id,username}', access_token: tok });
  if (page.error) { console.log(`\n=== Page ${p.id}: lookup ERROR ${page.error.code}: ${page.error.message}`); continue; }
  const ig = page.instagram_business_account ?? page.connected_instagram_account;
  console.log(`\n=== Page "${page.name}" (${p.id}) -> linked IG: ${ig ? `${ig.username} (${ig.id})` : 'NONE'}`);
  if (!ig) continue;
  anyLinked = true;
  for (const t of targets) {
    const j = await get(ig.id, { fields: BD(t), access_token: tok });
    if (j.error) { console.log(`  [${t}] ERROR ${j.error.code}: ${j.error.message}`); continue; }
    const b = j.business_discovery;
    console.log(`  [${t}] OK: ${b.name} | followers ${b.followers_count} | ${b.media_count} posts`);
    for (const m of b.media?.data ?? []) {
      console.log(`     - ${m.timestamp} ${m.media_type}/${m.media_product_type} likes=${m.like_count ?? 'hidden'} comments=${m.comments_count} children=${m.children?.data?.length ?? 0} media_url=${m.media_url ? 'yes' : 'no'} thumb=${m.thumbnail_url ? 'yes' : 'no'}`);
      console.log(`       ${(m.caption || '').replace(/\s+/g, ' ').slice(0, 100)}`);
    }
  }
}
if (!anyLinked) console.log('\nNo Page has a linked Instagram account yet. Link one (any Page works), regenerate the Explorer token, then rerun.');
