# Setup

One-time setup. Budget about an hour. Do the steps in order, because each one
gives you a value the next one needs.

At the end you will have six values to paste into GitHub Secrets.

---

## 1. Gemini API key

1. Go to <https://aistudio.google.com/apikey> and create an API key.
2. **Enable billing on the project.** Image generation has no free tier, so the
   key will not work without it.

Save it as `GEMINI_API_KEY`.

Expect roughly $4 a month at one 2K image per day plus a few redraws.

---

## 2. Turn the Instagram account into a professional account

In the Instagram mobile app, on the hamster account:

1. Settings and privacy > Account type and tools > Switch to professional account.
2. Choose **Creator** or **Business**. Either works.
3. When it offers to connect a Facebook Page, connect one. Create a new Page if
   you do not have one.

A Facebook Page is not optional. Meta's publishing API refuses to work without
one, even for the Instagram-login flow.

---

## 3. Page Publishing Authorization

In Meta Business Suite for that Page, complete **Page Publishing Authorization**.
It is an identity check, and publishing through the API stays blocked until it
passes. It can take a day or two to be approved, so start it early.

---

## 4. Create the Meta app

1. Go to <https://developers.facebook.com/apps> and create an app.
2. Pick the business type when asked.
3. Add the **Instagram** product to the app.
4. Choose **API setup with Instagram business login**.
5. Add these permissions:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
6. Connect the hamster Instagram account when prompted.
7. Generate a token.

From that screen, copy:

- the **Instagram user ID** into `IG_USER_ID`
- the **access token** into `IG_ACCESS_TOKEN`

Also grab, from Settings > Basic:

- **App ID** into `META_APP_ID`
- **App secret** into `META_APP_SECRET`

Meta redesigns this dashboard often, so the labels may sit in slightly different
places than described. The four values above are what you are hunting for.

### About the token

The token you get lasts 60 days. `refresh-token.yml` runs monthly and renews it
automatically, so you should never have to touch it again. If that job ever
fails it messages you on Telegram rather than dying quietly.

---

## 5. Telegram bot

1. Message [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a name and a username. It gives you a token: that is `TELEGRAM_BOT_TOKEN`.
3. **Send your new bot any message.** A bot cannot start a conversation with
   you, so this step is required or nothing will ever reach you.
4. Get your chat ID by opening this URL in a browser, with your token in place:

   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`

   Find `"chat":{"id":123456789` in the response. That number is
   `TELEGRAM_CHAT_ID`.

---

## 6. GitHub repo

Create a repo and push this folder to it.

**Make it public.** Instagram downloads the image from a public URL, and a
public repo gives you that free through `raw.githubusercontent.com` with no
image host to sign up for. Public repos also get unlimited free Actions
minutes. Your secrets stay encrypted either way, and each JPEG is deleted from
the repo as soon as Instagram has fetched it.

If you would rather keep the repo private, replace `publicUrlFor()` in
`src/host.js` with a Cloudinary upload. Nothing else changes.

### Secrets

In the repo: Settings > Secrets and variables > Actions > New repository secret.

| Secret | From |
|---|---|
| `GEMINI_API_KEY` | step 1 |
| `IG_USER_ID` | step 4 |
| `IG_ACCESS_TOKEN` | step 4 |
| `META_APP_ID` | step 4 |
| `META_APP_SECRET` | step 4 |
| `TELEGRAM_BOT_TOKEN` | step 5 |
| `TELEGRAM_CHAT_ID` | step 5 |
| `GH_PAT` | optional, see below |

`GH_PAT` is a fine-grained personal access token with **read and write access to
Secrets** on this repo. It lets the monthly job store the refreshed Instagram
token by itself. Skip it if you prefer, and the job will just Telegram you the
new token to paste in every couple of months.

### Allow the workflows to push

Settings > Actions > General > Workflow permissions > **Read and write
permissions**. The bot commits the generated image and the story state, so it
needs this.

---

## 7. Create the hamsters

Locally, copy `.env.example` to `.env`, fill it in, then:

```bash
npm install
npm run bootstrap
```

It designs the pair, shows you the bible, and draws a reference sheet for each
hamster. Say no until you love them. What you approve here is locked in and
every future post is anchored to it, so it is worth being fussy.

Then check consistency:

```bash
npm run propose:dry
```

Run that three or four times and open the JPEGs in `posts/`. If it looks like
the same two hamsters each time, you are ready. If they drift, redo
`npm run bootstrap` with more specific markings and colours.

Commit `bible.md`, `characters/` and `story-state.json`, then push.

---

## 8. First real run

In the Actions tab, run **Propose daily post** manually. You should get a
Telegram message within a minute or two. Tap a button and watch the run finish.

After that it runs itself at 09:00 Ulaanbaatar time every day.
