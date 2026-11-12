---
"oh-my-webbridge": patch
---

# Submit releases to addons.mozilla.org with the environment credentials

- The release workflow passes `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` to the stores workflow, so the addons.mozilla.org job of a release reads them from the `addons-mozilla-org` environment. A release without them fails before it calls the store.
- A manual run of the stores workflow with a release tag, `gh workflow run stores.yml --ref main -f tag=v0.2.1`, submits that published GitHub Release from its tagged commit to the Chrome Web Store and addons.mozilla.org. Without a tag the run reads the status of each store.
