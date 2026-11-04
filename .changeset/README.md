# Describe the result

Add one Markdown fragment for each user-visible change. Versioning and release notes come from these files, not commit messages.

```markdown
---
"oh-my-webbridge": patch
---

# Reconnect immediately after pairing

Changing the token while startup is reading settings starts a fresh connection, without waiting for the periodic alarm. ([#2](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/2))
```

Use `patch` for fixes, `minor` for capabilities, and `major` for breaking behavior. Describe the before/after result, add the PR link after opening it, and retain migration or scope limits where relevant.

Write the body in GitHub Flavored Markdown. Release notes place fragments one after another, so close every block a fragment opens and limit raw HTML to `<!-- comments -->`; HTML meant as text belongs in inline code or a code block. Link reference definitions and footnote labels apply to the whole notes, so write links inline as `[text](url)` and put notes in the text. `pnpm run release:check` reports other HTML, an unclosed block, a definition or a footnote with the fragment's file and line.

`pnpm run release:plan` previews the version. `pnpm run release:version` consumes fragments, synchronizes package/lock/daemon/extension versions and renders the changelog and release notes. Do not edit generated release sections by hand.
