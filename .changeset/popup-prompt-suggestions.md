---
"oh-my-webbridge": minor
---

# Suggest prompts for the active tab in the popup

The popup holds a prompt that you can edit and copy, in place of four example tabs. The buttons under the prompt fill in one of 22 suggestions. Up to five suggestions that fit the active tab come first, marked with a star. The popup picks them from the address and title of the tab and, on pages that the extension can access, from the page language, structured data, selected text and the number of tables, form fields, code blocks, videos, images and articles. These values stay in the popup. Choosing a suggestion fades the prompt in while two small stars flare at its corners.

The Chrome extension asks for the `activeTab` and `scripting` permissions to read the page when you open the popup; the Firefox extension asks for `activeTab`.
