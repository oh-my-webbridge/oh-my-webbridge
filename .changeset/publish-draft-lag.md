---
"oh-my-webbridge": patch
---

# Publish a release when GitHub lists its new draft late

The release job waits up to 30 seconds for the release list to show the draft that it just created, before it uploads the assets. The 0.2.0 job had stopped when the list left out the new draft, and published the release on a rerun.

[PR #21](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/21)
