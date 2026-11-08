---
"oh-my-webbridge": patch
---

# Find the user guide in every language from `llms.txt`

The `llms.txt` and `llms-full.txt` of each language are at `/md/<language code>/`, next to the Markdown copies of its pages; `/<language code>/llms.txt` and `/<language code>/llms-full.txt` are gone. `/llms.txt` lists the English pages. Every `llms.txt` starts with the site description and a `<tips>` block in English that links the index of each language and explains that a page keeps its path in every language. The agent skill links `/md/en/llms-full.txt`.

The Chinese pages call the site 使用手冊 (使用手册 in Simplified Chinese).

[PR #16](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/16)
