---
"oh-my-webbridge": minor
---

# Read the installed action reference offline

The agent kit and `omw install-skill` include the matching CLI, SDK, browser, and error references. Run `omw install-skill --refresh DIRECTORY` after upgrading to refresh the bundled pages and keep your other files. Refresh checks for path conflicts before replacing files and restores the previous files if a replacement fails. ([#50](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/50))
