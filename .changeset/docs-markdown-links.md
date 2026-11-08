---
"oh-my-webbridge": patch
---

# Point agents at the Markdown copies of the documentation

`llms.txt` lists each documentation page by its Markdown copy at `/md/<language>/<page>/content.md`. Links between pages inside the Markdown copies and `llms-full.txt` lead to Markdown copies too, so an agent that follows them reads Markdown. The prompts that a page sends to an AI chat name its Markdown copy, and each page links it with `rel="alternate" type="text/markdown"` and links the `llms.txt` of its language with `rel="describedby"`.

[PR #14](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/14)
