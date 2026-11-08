# ID token benchmark

`bench.py` counts the LLM tokens taken by oh-my-webbridge IDs: the 128-bit hex IDs and four text encodings of a 64-bit Snowflake ID.

## Method

The Snowflake layout matches `internal/bridge/id.go`: bit 63 is 0, bits 62–22 hold the milliseconds since 2026-01-01T00:00:00Z, bits 21–12 the worker and bits 11–0 the sequence.

| Format   | Text                                                                     |
| -------- | ------------------------------------------------------------------------ |
| `uuid4`  | 36-character UUID version 4                                              |
| `hex128` | 32 lowercase hex digits of a random 128-bit value (the IDs of omw 0.1.1) |
| `sf-dec` | Snowflake in decimal                                                     |
| `sf-hex` | Snowflake in lowercase hex without padding                               |
| `sf-b36` | Snowflake in base36 (`0-9a-z`)                                           |
| `sf-b62` | Snowflake in base62 (`0-9A-Za-z`)                                        |

Each format has 1000 IDs drawn from `random.Random(20260101)`. Snowflake timestamps are uniform over [2026-11-01, 2027-11-01) UTC, workers over 0–1023 and sequences over 0–15; the four Snowflake formats encode the same 1000 integers.

Contexts:

- `id`: the ID alone.
- `reply`: `{"id":"<id>","result":{"ok":true}}`.
- `snapshot`: the 59-line tree asserted by the generic snapshot test in `tests/firefox-page.test.mjs`, with every `@eG.` replaced by `@e<id>.` and one ID per snapshot. The Password value is `"hunter2"`. The per-line cost is (snapshot tokens − tokens of the same tree with `@e.`) / 59.

The age scan takes 1000 Snowflake IDs for every quarter year from 0 to 10 years after the epoch (365.25-day years), with timestamps uniform over the following day, and counts the bare IDs.

| Tokenizer                    | Source                  | Revision                                   |
| ---------------------------- | ----------------------- | ------------------------------------------ |
| `o200k_base` (GPT-4o)        | tiktoken                |                                            |
| `cl100k_base` (GPT-4)        | tiktoken                |                                            |
| `google/gemma-7b`            | tiktokenizer deployment | Hub `main`, same SHA-256 as the LFS object |
| `meta-llama/Meta-Llama-3-8B` | tiktokenizer deployment | Hub `refs/pr/35`, same git blob            |
| `Qwen/Qwen2.5-72B`           | Hugging Face Hub        | `efba10c8e54e91e0d9570ab5f7b51a958474d4cb` |
| `deepseek-ai/DeepSeek-R1`    | Hugging Face Hub        | `56d4cbbb4d29f4355bab4b9a39ccb717a14ad5ad` |
| `codellama/CodeLlama-7b-hf`  | Hugging Face Hub        | `6c284d1468fe6c413cf56183e69b194dcfa27fe6` |

The gemma-7b and Llama-3-8B repositories are gated on the Hub, so their files come from the [tiktokenizer](https://github.com/dqbd/tiktokenizer) deployment at `https://tiktokenizer.vercel.app/hf/<repo>/tokenizer.json`, which serves the Hub files it downloaded for its own UI. `bench.py` pins the SHA-256 of every `tokenizer.json` and stops when a download differs. Hugging Face tokenizers encode with `add_special_tokens=False`. The CodeLlama normalizer prepends `▁` to every input, so its bare-ID counts include that token where it does not merge with the first character (`sf-dec`: 19 tokens bare, 18 per snapshot line).

## Run

```sh
uv run bench.py
```

The first run downloads the tokenizer files into `.cache/`. A run takes about 30 s and 1.5 GB of memory on a 12-core x86_64 Linux host. Output in `artifacts/`:

- `tokens.csv`: one row per tokenizer, format, context and sample.
- `summary.csv`: means per context, format and tokenizer; `summary.md` holds the tables below.
- `age.csv`: means of the age scan.
- `ids-bare.png`, `ids-snapshot.png`, `ids-age.png`.

## Results

### Mean characters per ID

| format | chars |
| :----- | ----: |
| uuid4  | 36.00 |
| hex128 | 32.00 |
| sf-dec | 18.00 |
| sf-hex | 15.00 |
| sf-b36 | 11.84 |
| sf-b62 | 10.00 |

### Snapshot: mean tokens per line over `@e.`

| format | o200k_base (GPT-4o) | cl100k_base (GPT-4) | gemma-7b | Llama-3-8B | Qwen2.5-72B | DeepSeek-R1 | CodeLlama-7b |  mean |
| :----- | ------------------: | ------------------: | -------: | ---------: | ----------: | ----------: | -----------: | ----: |
| uuid4  |               22.44 |               22.49 |    32.41 |      22.48 |       31.56 |       22.66 |        32.84 | 26.70 |
| hex128 |               18.22 |               18.16 |    27.89 |      18.16 |       28.02 |       18.46 |        28.45 | 22.48 |
| sf-dec |                6.00 |                6.00 |    18.00 |       6.00 |       18.00 |        6.00 |        18.00 | 11.14 |
| sf-hex |                8.36 |                8.35 |    13.75 |       8.34 |       13.80 |        8.44 |        13.93 | 10.71 |
| sf-b36 |                7.64 |                7.77 |     8.46 |       7.76 |        8.75 |        7.75 |         9.17 |  8.19 |
| sf-b62 |                6.88 |                7.29 |     6.76 |       7.27 |        7.52 |        7.10 |         8.24 |  7.29 |

### Snapshot (59 lines): mean tokens

| format              | o200k_base (GPT-4o) | cl100k_base (GPT-4) | gemma-7b | Llama-3-8B | Qwen2.5-72B | DeepSeek-R1 | CodeLlama-7b |    mean |
| :------------------ | ------------------: | ------------------: | -------: | ---------: | ----------: | ----------: | -----------: | ------: |
| uuid4               |             1978.02 |             1980.67 |  2681.49 |    1980.14 |     2565.16 |     2002.06 |      2748.68 | 2276.60 |
| hex128              |             1729.04 |             1725.50 |  2414.22 |    1725.26 |     2356.12 |     1754.08 |      2489.37 | 2027.66 |
| sf-dec              |             1008.00 |             1008.00 |  1831.00 |    1008.00 |     1765.00 |     1019.00 |      1873.00 | 1358.86 |
| sf-hex              |             1147.30 |             1146.36 |  1580.25 |    1146.30 |     1517.14 |     1162.90 |      1632.87 | 1333.30 |
| sf-b36              |             1104.76 |             1112.49 |  1267.96 |    1111.60 |     1219.01 |     1122.49 |      1352.09 | 1184.34 |
| sf-b62              |             1059.92 |             1083.93 |  1167.72 |    1083.11 |     1146.68 |     1083.84 |      1297.16 | 1131.77 |
| no generation (@e.) |              654.00 |              654.00 |   769.00 |     654.00 |      703.00 |      665.00 |       811.00 |  701.43 |

### Bare ID: mean tokens

| format | o200k_base (GPT-4o) | cl100k_base (GPT-4) | gemma-7b | Llama-3-8B | Qwen2.5-72B | DeepSeek-R1 | CodeLlama-7b |  mean |
| :----- | ------------------: | ------------------: | -------: | ---------: | ----------: | ----------: | -----------: | ----: |
| uuid4  |               22.75 |               22.79 |    32.74 |      22.79 |       31.87 |       22.97 |        33.79 | 27.10 |
| hex128 |               18.54 |               18.48 |    28.22 |      18.47 |       28.33 |       18.76 |        29.40 | 22.89 |
| sf-dec |                6.00 |                6.00 |    18.00 |       6.00 |       18.00 |        6.00 |        19.00 | 11.29 |
| sf-hex |                8.36 |                8.35 |    13.75 |       8.34 |       13.80 |        8.44 |        14.93 | 10.85 |
| sf-b36 |                7.74 |                7.88 |     8.56 |       7.87 |        8.86 |        7.86 |        10.14 |  8.42 |
| sf-b62 |                6.88 |                7.29 |     6.76 |       7.27 |        7.52 |        7.10 |         8.43 |  7.32 |

### Daemon reply: mean tokens

| format | o200k_base (GPT-4o) | cl100k_base (GPT-4) | gemma-7b | Llama-3-8B | Qwen2.5-72B | DeepSeek-R1 | CodeLlama-7b |  mean |
| :----- | ------------------: | ------------------: | -------: | ---------: | ----------: | ----------: | -----------: | ----: |
| uuid4  |               32.76 |               32.79 |    42.74 |      32.79 |       41.87 |       32.97 |        43.13 | 37.01 |
| hex128 |               28.54 |               28.48 |    38.22 |      28.47 |       38.33 |       28.76 |        38.73 | 32.79 |
| sf-dec |               16.00 |               16.00 |    28.00 |      16.00 |       28.00 |       16.00 |        28.00 | 21.14 |
| sf-hex |               18.36 |               18.34 |    23.75 |      18.34 |       23.80 |       18.44 |        23.93 | 20.71 |
| sf-b36 |               17.74 |               17.88 |    18.56 |      17.87 |       18.86 |       17.86 |        19.29 | 18.30 |
| sf-b62 |               16.88 |               17.29 |    16.76 |      17.27 |       17.52 |       17.10 |        18.24 | 17.29 |

## Findings

Averaged over the seven tokenizers, a snapshot ref costs 22.48 tokens per line with `hex128` and 11.14 (`sf-dec`), 10.71 (`sf-hex`), 8.19 (`sf-b36`) or 7.29 (`sf-b62`) with a Snowflake ID. `sf-dec` takes 6 tokens with o200k_base, cl100k_base, Llama-3 and DeepSeek-R1, which group up to three digits per token, and 18 with gemma-7b, Qwen2.5 and CodeLlama, which encode every digit separately. In the age scan, `sf-dec` reaches 19 digits between 7.5 and 7.75 years after the epoch and `sf-b62` 11 characters between 6.25 and 6.5 years; `sf-b36` stays at 12 characters through year 10. The daemon and the extension use `sf-b36`. `sf-b62` takes 0.90 fewer tokens per line, but two IDs that differ only in letter case map to the same artifact file name on a case-insensitive file system.
