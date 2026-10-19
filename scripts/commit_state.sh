#!/usr/bin/env bash
# Commit and push generated monitoring state under data/.
#
# Usage: scripts/commit_state.sh "<commit message>" <base-sha>
#
# <base-sha> is the main commit this job checked out. If main advanced while the
# job ran, the push is retried after rebasing onto the new main, but ONLY when
# none of the newer commits touched data/. Code/docs pushes never conflict with
# generated state, so replaying the data-only commit on top of them is safe.
# If another run committed data/ in the meantime, the generated snapshot would be
# inconsistent with it, so the script refuses rather than merging state.
#
# Writes committed=true|false to $GITHUB_OUTPUT when that variable is set.
set -euo pipefail

message="${1:?commit message required}"
base_sha="${2:?base commit SHA required}"

# The checkout does not persist credentials (the scan runs third-party parsers
# on untrusted documents). Authenticate only the git commands that need it.
git_remote() {
  if [ -n "${GH_TOKEN:-}" ]; then
    local auth
    auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
    git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" "$@"
  else
    git "$@"
  fi
}

emit() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "committed=$1" >> "$GITHUB_OUTPUT"
  fi
}

git add data
if git diff --cached --quiet; then
  echo "No monitoring data changes to commit."
  emit false
  exit 0
fi
git commit -q -m "$message"

for attempt in 1 2 3 4 5; do
  git_remote fetch -q origin main
  if git merge-base --is-ancestor origin/main HEAD; then
    if git_remote push -q origin HEAD:main; then
      echo "Pushed state commit (attempt $attempt)."
      emit true
      exit 0
    fi
    echo "Push raced with another update of main; retrying."
  else
    changed_data="$(git diff --name-only "$base_sha" origin/main -- data)"
    if [ -n "$changed_data" ]; then
      echo "Another run committed monitoring state while this job ran; refusing to rebase a generated state snapshot."
      echo "$changed_data" | head -20
      emit false
      exit 1
    fi
    echo "main advanced with code-only commits; rebasing the data-only state commit."
    git rebase -q --onto origin/main "$base_sha" HEAD
    base_sha="$(git rev-parse origin/main)"
  fi
  sleep $((attempt * 2))
done

echo "Monitoring state could not be published after 5 attempts. No conflict resolution was attempted."
emit false
exit 1
