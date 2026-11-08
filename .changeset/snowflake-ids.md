---
"oh-my-webbridge": patch
---

# Shorter IDs in replies and snapshots

The daemon and the extension issue 64-bit [Snowflake IDs](https://en.wikipedia.org/wiki/Snowflake_ID) in lowercase base 36, such as `uvwoyqsusjk`, in place of 32 hexadecimal characters: the `id` of each `/command` reply, the generation in snapshot references (`@e<generation>.<index>`), the names of screenshots and PDFs saved without a `path`, and the stream handle of `save_as_pdf`. Across the seven tokenizers in `benchmarks/ids`, a snapshot reference costs 8.1 tokens per line instead of 22.5. Clients that check IDs against 32 hexadecimal characters need to accept the new form.

[PR #17](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/17)
