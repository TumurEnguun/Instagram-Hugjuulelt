/**
 * Checks every credential in .env by actually calling the service.
 *
 *   npm run doctor           check everything, quietly
 *   npm run doctor -- --ping  also send a real test message to Telegram
 *
 * Run it after filling in each key. It never prints a secret, only whether
 * the secret works. If TELEGRAM_CHAT_ID is missing it will find it for you.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { retryFetch } from './net.js';

// Remembers which paid checks have already passed. Local only, never committed.
const CACHE = path.join(ROOT, '.doctor-cache.json');

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch {
    return {};
  }
}

const wasVerified = (name) => readCache()[name] === true;

function markVerified(name) {
  try {
    fs.writeFileSync(CACHE, JSON.stringify({ ...readCache(), [name]: true }, null, 2) + '\n');
  } catch {
    // A read-only checkout just means the check repeats. Not worth failing over.
  }
}

const results = [];

function ok(name, detail) {
  results.push({ name, state: 'ok', detail });
  console.log(`  [ OK ]   ${name}  ${detail}`);
}
function bad(name, detail) {
  results.push({ name, state: 'bad', detail });
  console.log(`  [FAIL]   ${name}  ${detail}`);
}
function skip(name, detail) {
  results.push({ name, state: 'skip', detail });
  console.log(`  [ -- ]   ${name}  ${detail}`);
}

async function checkGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return skip('GEMINI_API_KEY', 'not set yet');

  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: key });
    const res = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: 'Reply with the single word: ready',
    });
    if (!res.text) return bad('GEMINI_API_KEY', 'key works but the model returned nothing');
    ok('GEMINI_API_KEY', 'text generation works');
  } catch (err) {
    const m = err.message || String(err);
    if (/API key not valid|API_KEY_INVALID/i.test(m)) {
      return bad('GEMINI_API_KEY', 'the key is not valid');
    }
    return bad('GEMINI_API_KEY', m.slice(0, 160));
  }
}

async function checkGeminiBilling() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return skip('Gemini billing', 'needs GEMINI_API_KEY first');

  // This check costs real money, so once it has passed we remember that and
  // stop repeating it. --billing forces a fresh check.
  const force = process.argv.includes('--billing');
  if (!force && wasVerified('geminiBilling')) {
    return ok('Gemini billing', 'verified earlier (rerun with --billing to recheck)');
  }

  // Image generation is the thing that actually requires a billed project, and
  // it is the single most common reason this bot fails on day one.
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: key });
    const res = await ai.models.generateContent({
      model: 'gemini-3.1-flash-image',
      contents: 'A plain solid light grey square. Nothing else.',
      config: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '1K' } },
    });
    const parts = res?.candidates?.[0]?.content?.parts ?? [];
    const hasImage = parts.some((p) => p.inlineData?.data);
    if (!hasImage) return bad('Gemini billing', 'no image came back; billing is probably not enabled');
    markVerified('geminiBilling');
    ok('Gemini billing', 'image generation works (this call cost about $0.04)');
  } catch (err) {
    const m = err.message || String(err);
    if (/billing|quota|PERMISSION_DENIED|FAILED_PRECONDITION/i.test(m)) {
      return bad('Gemini billing', 'enable billing on the Google Cloud project behind this key');
    }
    return bad('Gemini billing', m.slice(0, 160));
  }
}

async function checkTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    skip('TELEGRAM_BOT_TOKEN', 'not set yet');
    return skip('TELEGRAM_CHAT_ID', 'needs the bot token first');
  }

  let botName;
  try {
    const res = await retryFetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = await res.json();
    if (!json.ok) return bad('TELEGRAM_BOT_TOKEN', json.description);
    botName = json.result.username;
    ok('TELEGRAM_BOT_TOKEN', `bot is @${botName}`);
  } catch (err) {
    return bad('TELEGRAM_BOT_TOKEN', err.message);
  }

  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!chatId) {
    // Find it for them rather than making them read raw JSON in a browser.
    let json;
    try {
      const res = await retryFetch(`https://api.telegram.org/bot${token}/getUpdates`);
      json = await res.json();
    } catch (err) {
      // A transient network blip here should not abort the whole checkup.
      return bad('TELEGRAM_CHAT_ID', `could not reach Telegram: ${err.message}. Try again.`);
    }
    const chats = new Map();
    for (const u of json.result ?? []) {
      const c = u.message?.chat ?? u.callback_query?.message?.chat;
      if (c) chats.set(c.id, [c.first_name, c.username].filter(Boolean).join(' / ') || 'you');
    }
    if (chats.size === 0) {
      return bad(
        'TELEGRAM_CHAT_ID',
        `not set. Open Telegram, message @${botName} anything, then run this again.`
      );
    }
    console.log('');
    for (const [id, who] of chats) {
      console.log(`           Found a chat: ${who}`);
      console.log(`           Put this in .env  ->  TELEGRAM_CHAT_ID=${id}`);
    }
    console.log('');
    return bad('TELEGRAM_CHAT_ID', 'not set yet, but see the id above');
  }

  // Check the chat quietly by default. Firing a real message on every run
  // turns a routine health check into Telegram spam.
  const ping = process.argv.includes('--ping');

  try {
    const endpoint = ping ? 'sendMessage' : 'getChat';
    const body = ping
      ? { chat_id: chatId, text: 'Setup check: the hamster bot can reach you.' }
      : { chat_id: chatId };

    const res = await retryFetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) return bad('TELEGRAM_CHAT_ID', json.description);

    ok('TELEGRAM_CHAT_ID', ping ? 'test message sent, check your Telegram' : 'chat reachable (no message sent)');
  } catch (err) {
    bad('TELEGRAM_CHAT_ID', err.message);
  }
}

async function checkInstagram() {
  const id = process.env.IG_USER_ID;
  const token = process.env.IG_ACCESS_TOKEN;

  if (!token) return skip('IG_USER_ID / IG_ACCESS_TOKEN', 'not set yet');

  // The token knows which account it belongs to, so there is no need to go
  // hunting for the user ID in Meta's dashboard.
  if (!id) {
    try {
      const url = `https://graph.instagram.com/v25.0/me?fields=id,username&access_token=${encodeURIComponent(token)}`;
      const res = await retryFetch(url);
      const me = await res.json();
      if (me.error) return bad('IG_ACCESS_TOKEN', me.error.message);
      console.log('');
      console.log(`           Token belongs to @${me.username}`);
      console.log(`           Put this in .env  ->  IG_USER_ID=${me.id}`);
      console.log('');
      return bad('IG_USER_ID', 'not set yet, but see the id above');
    } catch (err) {
      return bad('IG_USER_ID', `could not look it up: ${err.message}`);
    }
  }

  try {
    const url = `https://graph.instagram.com/v25.0/${id}?fields=id,username,account_type&access_token=${encodeURIComponent(token)}`;
    const res = await retryFetch(url);
    const json = await res.json();
    if (json.error) return bad('IG_ACCESS_TOKEN', json.error.message);
    ok('IG_ACCESS_TOKEN', `connected to @${json.username}${json.account_type ? ` (${json.account_type})` : ''}`);
  } catch (err) {
    bad('IG_ACCESS_TOKEN', err.message);
  }
}

async function checkFacebook() {
  const { isConfigured, checkPage } = await import('./facebook.js');
  if (!isConfigured()) {
    return skip('Facebook Page', 'not set up, Instagram only (npm run fb-setup)');
  }
  try {
    const page = await checkPage();
    if (page.unverified) {
      ok('Facebook Page', 'token present; read is blocked but publishing should work');
    } else {
      ok('Facebook Page', 'connected to ' + page.name);
    }
  } catch (err) {
    bad('Facebook Page', err.message.slice(0, 140));
  }
}

async function main() {
  console.log('\nChecking your credentials. No secret values are printed.\n');

  await checkGemini();
  await checkGeminiBilling();
  await checkTelegram();
  await checkInstagram();
  await checkFacebook();

  const failed = results.filter((r) => r.state === 'bad').length;
  const pending = results.filter((r) => r.state === 'skip').length;

  console.log('');
  if (failed === 0 && pending === 0) {
    console.log('Everything works. Next: npm run bootstrap\n');
  } else {
    console.log(`${failed} failing, ${pending} not filled in yet. See SETUP.md for each one.\n`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
