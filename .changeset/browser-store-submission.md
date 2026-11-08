---
"oh-my-webbridge": patch
---

# Submit each release to the Chrome Web Store and addons.mozilla.org

Each release has `omw-<version>-chrome-mv3.zip`, the package for the Chrome Web Store, next to the unsigned Firefox add-on. After the GitHub Release is published, the release workflow submits the Chrome package to the Chrome Web Store and the add-on with its source code to addons.mozilla.org. Each store publishes the version after its review.

[PR #19](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/19)
