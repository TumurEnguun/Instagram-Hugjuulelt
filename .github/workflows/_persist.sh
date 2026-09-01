#!/usr/bin/env bash
# Commit and push the bot's state files, retrying on races.
#
#   .github/workflows/_persist.sh "commit message"
#
# Why this exists: publishing to Instagram is irreversible, but the RECORD that
# it happened is a git push that can lose a race with another runner or a local
# `npm run listen`. A single-attempt push that lost that race left the remote
# saying "awaiting" for an already-published episode, which both wedged the next
# day's proposal and armed a duplicate post if the user tapped OK again.
#
# Retrying with a fresh rebase each time makes that outcome rare rather than
# routine. It is still not atomic: if every attempt fails the caller must treat
# it as a real failure and alert, which is what the workflows now do.
set -uo pipefail

MESSAGE="${1:?commit message required}"
ATTEMPTS="${PERSIST_ATTEMPTS:-5}"
BRANCH="${GITHUB_BRANCH:-main}"

git config user.name "hamster-bot"
git config user.email "hamster-bot@users.noreply.github.com"

git add -A posts pending.json story-state.json

if git diff --staged --quiet; then
  echo "Nothing to persist."
  exit 0
fi

git commit -m "$MESSAGE"

for attempt in $(seq 1 "$ATTEMPTS"); do
  if git pull --rebase --autostash origin "$BRANCH" && git push origin "HEAD:$BRANCH"; then
    echo "Persisted on attempt $attempt."
    exit 0
  fi

  # A conflict on these files means another writer got there first. Their
  # version of story-state.json is the one already pushed, so take it and
  # replay ours on top rather than aborting the rebase entirely.
  if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    git rebase --abort || true
  fi

  echo "Push attempt $attempt failed; retrying in $((attempt * 3))s"
  sleep $((attempt * 3))
done

echo "::error::Could not persist state after $ATTEMPTS attempts. The remote is now out of sync with what actually happened."
exit 1
