# Setup

One-time setup. Budget about an hour. Do the steps in order, because each one
gives you a value the next one needs.

At the end you will have five values to paste into GitHub Secrets.

After filling in each one, run `npm run doctor`. It calls the real service and
tells you whether that key actually works, without ever printing a secret.

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

That is the whole step.

### You do not need a Facebook Page

This trips a lot of people up, including the earlier version of this guide.

There are two ways to reach the Instagram API, and only one of them needs a Page:

| Login method | Facebook Page needed? |
|---|---|
| **Instagram API with Instagram Login** (what this bot uses) | **No** |
| Instagram API with Facebook Login | Yes |

Meta's own overview describes the Instagram Login route as serving accounts
"with a presence on Instagram only". So if Instagram refuses to connect a Page,
or you cannot find Page Publishing Authorization anywhere, ignore both and carry
on. Neither applies here.

---

## 3. Create the Meta app

1. Go to <https://developers.facebook.com/apps> and create an app.
2. Pick the business type when asked.
3. Add the **Instagram** product to the app.
4. Choose **API setup with Instagram business login**.
5. Add these permissions:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
6. Connect the hamster Instagram account when prompted.
7. Generate a token.

Copy the **access token** into `IG_ACCESS_TOKEN`. It is long, starts with
`IGAA`, and the box usually shows only part of it, so use the copy button.

You do not need to find the user ID by hand. Save the token, run
`npm run doctor`, and it asks Instagram which account the token belongs to and
prints the `IG_USER_ID` to paste.


Meta redesigns this dashboard often, so the labels may sit in slightly different
places than described. The access token is the one thing you are hunting for.

You do **not** need the App ID or App secret. Refreshing the token only requires
the token itself.

### If you hit "Insufficient Developer Role"

An unpublished app only lets Instagram accounts that hold a role on it log in.
Go to **App roles > Roles > Instagram Testers**, add the account, then accept the
invite at <https://www.instagram.com/accounts/manage_access/> under **Tester
invites**. The status has to stop saying Pending before the token screen works.

If you normally sign into Instagram through Facebook, you will also need to give
the account its own password first, via
<https://www.instagram.com/accounts/password/reset/>. Facebook login keeps
working afterwards.

### About the token

The token you get lasts 60 days. `refresh-token.yml` runs monthly and renews it
automatically, so you should never have to touch it again. If that job ever
fails it messages you on Telegram rather than dying quietly.

---

## 4. Telegram bot

1. Message [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a name and a username. It gives you a token: that is `TELEGRAM_BOT_TOKEN`.
3. **Send your new bot any message.** A bot cannot start a conversation with
   you, so this step is required or nothing will ever reach you.
4. Put the token in `.env`, then run `npm run doctor`. It looks up your chat ID
   and prints exactly what to paste.

The chat ID is a **number**, like `8278399317`. It is not the bot username.
That catches most people out.

---

## 5. GitHub repo

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
| `IG_USER_ID` | step 3 |
| `IG_ACCESS_TOKEN` | step 3 |
| `TELEGRAM_BOT_TOKEN` | step 4 |
| `TELEGRAM_CHAT_ID` | step 4 |
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

## 6. Create the hamsters

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

## 7. First real run

In the Actions tab, run **Propose daily post** manually. You should get a
Telegram message within a minute or two. Tap a button and watch the run finish.

After that it runs itself at 09:00 Ulaanbaatar time every day.
