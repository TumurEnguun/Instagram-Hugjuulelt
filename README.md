# Hamster Daily

An autonomous Instagram bot that tells an ongoing love story about a hamster
couple. Every morning it writes the next episode, draws it with Gemini, and
sends it to Telegram for approval. It posts only after you tap **OK**.

No approval means no post. Silence is treated as no.

New here? Start with [SETUP.md](SETUP.md).

---

## How a day goes

```
09:00  propose.yml
       reads story-state.json  ->  writes episode N  ->  draws it
       commits the JPEG        ->  Telegram sends it to you with 4 buttons
       waits 10 minutes for a fast answer

every 30 min until 21:45  check.yml
       OK       publish to Instagram, log the episode, delete the JPEG
       Redraw   same story, new art
       New story  throw the episode away, write a different one
       Skip     nothing goes out today

1st of the month  refresh-token.yml
       renews the 60 day Instagram token
```

## Keeping the hamsters consistent

This is the part that makes or breaks the account, and it rests on three files.

**`characters/`** holds the locked reference sheets. Every image request sends
these along, which is what stops the model inventing new hamsters each day. The
model accepts up to 4 character references and we use 2, one per hamster.

**`bible.md`** is the art and character bible. Fur colours, markings,
personalities, the locked art style, and a list of things that must never
appear. It goes into every prompt word for word.

**`story-state.json`** is the series memory: every past episode in one line,
the current relationship arc, and the running gags. The writer reads it so
episode 47 builds on 46 instead of starting over.

Treat `characters/` and the art style section of `bible.md` as frozen. Changing
them mid-series is what makes a feed look inconsistent.

## Commands

```bash
npm run doctor         # check every credential, without sending anything
npm run bootstrap      # one time: design and lock the two hamsters
npm run propose:dry    # generate locally, save to posts/, send nothing
npm run propose        # generate and ask on Telegram
npm run check          # act on the latest button press
npm run refresh-token  # renew the Instagram token
```

`DEBUG=1` on any of them prints full stack traces.

## Layout

| Path | What it does |
|---|---|
| `src/gemini.js` | writes the episode, draws the panel, holds the prompts |
| `src/decide.js` | the approval state machine, shared by propose and check |
| `src/telegram.js` | sends the proposal, reads button presses |
| `src/instagram.js` | container plus publish against the Graph API |
| `src/host.js` | turns a filename into the public URL Instagram fetches |
| `src/store.js` | reads and writes the series state |
| `bible.md` | the locked art and character bible |
| `story-state.json` | episode log, arc, running gags |
| `pending.json` | the post currently waiting on you |

## Cost

About **$4 a month**: $0.101 per 2K image, one a day, plus a handful of
redraws. The caption text costs fractions of a cent. GitHub Actions, Telegram
and the Instagram API are free.

To halve it, set `image.size` to `'1K'` in `src/config.js`.

## When something breaks

**Nothing arrived on Telegram.** Check the Actions run log. If it never ran,
GitHub disables scheduled workflows on repos with no activity for 60 days;
push any commit to wake it up.

**"The image is not reachable yet".** The commit had not landed on the CDN when
you tapped OK. The post stays pending, so just tap OK again in a few minutes.

**Instagram rejects the post.** Almost always the token, or Page Publishing
Authorization not being finished. Run `npm run refresh-token` and confirm the
Page is authorized.

**The hamsters look wrong.** Regenerate the reference sheets from the best
recent panel and relock them, rather than editing the art style text.

**Two runs collided.** They cannot. Both workflows share a `concurrency` group,
so a run waits for the previous one instead of overlapping.
