#!/bin/sh
# Models GitHub's rule for pushes made with the Actions GITHUB_TOKEN, which has
# no workflows permission: every commit the push introduces (not reachable
# from any existing ref) must leave .github/workflows/ unchanged relative to
# its first parent, or relative to an empty tree for a root commit. The rule
# concerns whether the new commits themselves modify workflow files; it does
# not compare the old and new branch heads. Only pushes made with
# FAKE_GITHUB_TOKEN=1 are checked; maintainer pushes pass.
[ "$FAKE_GITHUB_TOKEN" = 1 ] || exit 0
zero=0000000000000000000000000000000000000000
empty=$(git hash-object -t tree /dev/null)
status=0
while read -r old new ref; do
  [ "$new" = "$zero" ] && continue
  for commit in $(git rev-list "$new" --not --all); do
    parent=$(git rev-parse --verify --quiet "$commit^1") || parent=$empty
    changed=$(git diff --name-only "$parent" "$commit" -- .github/workflows)
    if [ -n "$changed" ]; then
      echo "refusing to allow a GitHub App to create or update workflow $(echo $changed) without workflows permission ($ref)" >&2
      status=1
    fi
  done
done
exit $status
