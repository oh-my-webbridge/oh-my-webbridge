---
"oh-my-webbridge": minor
---

# Suggest prompts for the active tab in the popup

The popup holds one prompt that you can edit and copy, in place of four example tabs. It shows suggestions for the active tab in turn, a new one every six seconds: up to five that fit the page come first, then the ones for any page, out of 22. The popup picks them from the address and title of the tab and, on pages that the extension can access, from the page language, structured data, selected text and the number of tables, form fields, code blocks, videos, images and articles. These values stay in the popup. Each new suggestion fades in while two small stars flare at the corners of the prompt. The pointer or the focus on the prompt holds the current suggestion, and an edit keeps your text.

The Chrome extension asks for the `activeTab` and `scripting` permissions to read the page when you open the popup; the Firefox extension asks for `activeTab`.

[PR #18](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/18)
