# ID token benchmark

`bench.py` counts the LLM tokens taken by 14 ID formats: the 128-bit hex IDs of omw 0.1.1, four text encodings of a 64-bit Snowflake ID, UUID versions 1, 4 and 7, Nano ID, ULID, CUID2, KSUID, MongoDB ObjectId and Sonyflake.

## Method

The Snowflake layout matches `internal/bridge/id.go`: bit 63 is 0, bits 62–22 hold the milliseconds since 2026-01-01T00:00:00Z, bits 21–12 the worker and bits 11–0 the sequence.

| Format      | Text                                                                                                                                            | Generated with                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `uuid4`     | 36-character UUID version 4: 122 random bits                                                                                                    | `uuid.UUID(int=..., version=4)`                                                                |
| `uuid1`     | 36-character UUID version 1: 60-bit time in 100 ns units since 1582-10-15, 14-bit clock sequence, 48-bit random node with the multicast bit set | `uuid.UUID(fields=..., version=1)`                                                             |
| `uuid7`     | 36-character UUID version 7: 48-bit Unix milliseconds, 74 random bits                                                                           | `uuid.UUID(int=..., version=7)`                                                                |
| `hex128`    | 32 lowercase hex digits of a random 128-bit value (the IDs of omw 0.1.1)                                                                        | f-string                                                                                       |
| `nanoid`    | 21 characters from `A-Za-z0-9_-`                                                                                                                | nanoid 2.0.0: `nanoid.method.method(randbytes, alphabet, 21)`                                  |
| `ulid`      | 26 uppercase Crockford base32 characters: 48-bit Unix milliseconds, 80 random bits                                                              | python-ulid 4.1.0: `ULIDGenerator(randomness, PureRandomPolicy()).generate(ms)`                |
| `cuid2`     | 24 lowercase base36 characters: a letter, then a SHA3-512 hash of time, entropy, counter and fingerprint                                        | cuid2 2.3.0: `Cuid(random_generator, fingerprint).generate()`, clock set by time-machine 3.6.0 |
| `ksuid`     | 27 base62 characters: 32-bit seconds since 2014-05-13T16:53:20Z, 128 random bits                                                                | svix-ksuid 0.7.0: `Ksuid(datetime, payload)`                                                   |
| `objectid`  | 24 lowercase hex digits: 32-bit Unix seconds, 5-byte process value, 3-byte counter                                                              | pymongo 4.19.0: `bson.ObjectId(bytes)`                                                         |
| `sonyflake` | Decimal: 39-bit time in 10 ms units since 2014-09-01T00:00:00Z, 8-bit sequence, 16-bit machine ID                                               | sonyflake 2.0.3: `Sonyflake.compose(dt, sequence, machine_id)`                                 |
| `sf-dec`    | Snowflake in decimal                                                                                                                            | `str`                                                                                          |
| `sf-hex`    | Snowflake in lowercase hex without padding                                                                                                      | f-string                                                                                       |
| `sf-b36`    | Snowflake in base36 (`0-9a-z`)                                                                                                                  | `to_base` in `bench.py`                                                                        |
| `sf-b62`    | Snowflake in base62 (`0-9A-Za-z`)                                                                                                               | `to_base` in `bench.py`                                                                        |

Each format has 1000 IDs drawn from its own `random.Random(f"20260101/<format>")`; the four Snowflake formats share one stream and encode the same 1000 integers. Timestamps are uniform over [2026-11-01, 2027-11-01) UTC. Snowflake workers are uniform over 0–1023 and sequences over 0–15. Sonyflake uses start time 2014-09-01T00:00:00Z (the sony/sonyflake v1 default; the sonyflake package requires a start time), sequences 0–15 and machine IDs 0–65535.

The random parts come from the seeded stream: through the library's randomness parameter for nanoid, python-ulid and cuid2, and as constructor input for the UUIDs, KSUID payloads and ObjectId bytes. `Cuid.generate()` hashes `time.time_ns()` and has no time parameter, so `bench.py` sets the clock to the sampled timestamp with `time_machine.travel(..., tick=False)`; its fingerprint data is `omw-token-bench`.

Contexts:

- `id`: the ID alone.
- `reply`: `{"id":"<id>","result":{"ok":true}}`.
- `snapshot`: the 59-line tree asserted by the generic snapshot test in `tests/firefox-page.test.mjs`, with every `@eG.` replaced by `@e<id>.` and one ID per snapshot. The Password value is `"hunter2"`. The per-line cost is (snapshot tokens − tokens of the same tree with `@e.`) / 59.

The age scan takes 1000 IDs for every quarter year from 0 to 10 years after 2026-01-01 (365.25-day years), with timestamps uniform over the following day, and counts the bare Snowflake encodings and `sonyflake`.

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

The first run downloads the tokenizer files into `.cache/`. A run takes about 50 s and 1.7 GB of memory on a 12-core x86_64 Linux host. Output in `artifacts/`:

- `tokens.csv`: one row per tokenizer, format, context and sample.
- `summary.csv`: means per context, format and tokenizer; `summary.md` holds the tables below.
- `age.csv`: means of the age scan.
- `ids-snapshot.png`, `ids-bare.png`: heatmaps of the snapshot per-line cost and the bare-ID tokens, rows sorted by the mean over the seven tokenizers.
- `ids-length.png`: mean characters against mean snapshot per-line cost for every format.
- `ids-age.png`: the age scan.

## Results

Rows are sorted by the mean over the seven tokenizers.

### Mean characters per ID

| format    | chars |
| :-------- | ----: |
| sf-b62    | 10.00 |
| sf-b36    | 11.82 |
| sf-hex    | 15.00 |
| sonyflake | 18.00 |
| sf-dec    | 18.00 |
| nanoid    | 21.00 |
| cuid2     | 24.00 |
| objectid  | 24.00 |
| ulid      | 26.00 |
| ksuid     | 27.00 |
| hex128    | 32.00 |
| uuid4     | 36.00 |
| uuid1     | 36.00 |
| uuid7     | 36.00 |

### Snapshot: mean tokens per line over `@e.`

| format    | o200k_base (GPT-4o) | cl100k_base (GPT-4) | gemma-7b | Llama-3-8B | Qwen2.5-72B | DeepSeek-R1 | CodeLlama-7b |  mean |
| :-------- | ------------------: | ------------------: | -------: | ---------: | ----------: | ----------: | -----------: | ----: |
| sf-b62    |                6.91 |                7.29 |     6.78 |       7.28 |        7.52 |        7.12 |         8.26 |  7.31 |
| sf-b36    |                7.56 |                7.72 |     8.34 |       7.69 |        8.66 |        7.69 |         9.12 |  8.11 |
| sf-hex    |                8.37 |                8.35 |    13.79 |       8.35 |       13.81 |        8.44 |        13.92 | 10.72 |
| sonyflake |                6.00 |                6.00 |    18.00 |       6.00 |       18.00 |        6.00 |        18.00 | 11.14 |
| sf-dec    |                6.00 |                6.00 |    18.00 |       6.00 |       18.00 |        6.00 |        18.00 | 11.14 |
| nanoid    |               14.04 |               14.75 |    14.11 |      14.71 |       15.25 |       14.44 |        17.08 | 14.91 |
| cuid2     |               14.59 |               14.91 |    15.78 |      14.87 |       16.50 |       14.95 |        17.45 | 15.58 |
| objectid  |               14.51 |               14.46 |    21.14 |      14.46 |       21.23 |       14.66 |        21.53 | 17.43 |
| ulid      |               16.95 |               17.26 |    19.23 |      17.22 |       20.22 |       17.13 |        22.35 | 18.62 |
| ksuid     |               18.84 |               19.87 |    18.43 |      19.84 |       20.47 |       19.36 |        22.25 | 19.87 |
| hex128    |               18.17 |               18.13 |    27.99 |      18.12 |       28.12 |       18.41 |        28.53 | 22.50 |
| uuid4     |               22.49 |               22.51 |    32.36 |      22.51 |       31.48 |       22.73 |        32.83 | 26.70 |
| uuid1     |               22.78 |               22.79 |    32.64 |      22.79 |       31.72 |       22.98 |        33.03 | 26.96 |
| uuid7     |               22.99 |               23.02 |    33.16 |      23.02 |       32.23 |       23.20 |        33.49 | 27.30 |

### Snapshot (59 lines): mean tokens

| format              | o200k_base (GPT-4o) | cl100k_base (GPT-4) | gemma-7b | Llama-3-8B | Qwen2.5-72B | DeepSeek-R1 | CodeLlama-7b |    mean |
| :------------------ | ------------------: | ------------------: | -------: | ---------: | ----------: | ----------: | -----------: | ------: |
| sf-b62              |             1061.87 |             1084.05 |  1168.78 |    1083.64 |     1146.74 |     1085.26 |      1298.05 | 1132.63 |
| sf-b36              |             1100.16 |             1109.24 |  1261.12 |    1107.89 |     1214.06 |     1118.77 |      1348.90 | 1180.02 |
| sf-hex              |             1148.07 |             1146.89 |  1582.43 |    1146.89 |     1517.67 |     1162.66 |      1632.52 | 1333.87 |
| sonyflake           |             1008.00 |             1008.00 |  1831.00 |    1008.00 |     1765.00 |     1019.00 |      1873.00 | 1358.86 |
| sf-dec              |             1008.00 |             1008.00 |  1831.00 |    1008.00 |     1765.00 |     1019.00 |      1873.00 | 1358.86 |
| nanoid              |             1482.18 |             1524.01 |  1601.37 |    1522.18 |     1602.99 |     1516.78 |      1818.84 | 1581.19 |
| cuid2               |             1514.52 |             1533.75 |  1699.90 |    1531.33 |     1676.68 |     1546.76 |      1840.61 | 1620.51 |
| objectid            |             1510.03 |             1507.38 |  2016.20 |    1507.02 |     1955.75 |     1529.82 |      2081.51 | 1729.67 |
| ulid                |             1654.29 |             1672.34 |  1903.81 |    1669.86 |     1896.04 |     1675.55 |      2129.47 | 1800.19 |
| ksuid               |             1765.56 |             1826.57 |  1856.55 |    1824.32 |     1910.73 |     1807.48 |      2123.87 | 1873.58 |
| hex128              |             1725.91 |             1723.61 |  2420.41 |    1723.26 |     2362.32 |     1751.31 |      2494.51 | 2028.76 |
| uuid4               |             1980.79 |             1982.15 |  2678.18 |    1981.91 |     2560.56 |     2006.25 |      2747.68 | 2276.79 |
| uuid1               |             1997.84 |             1998.85 |  2694.52 |    1998.67 |     2574.30 |     2020.64 |      2760.01 | 2292.12 |
| uuid7               |             2010.65 |             2012.36 |  2725.44 |    2012.24 |     2604.28 |     2034.10 |      2787.20 | 2312.32 |
| no generation (@e.) |              654.00 |              654.00 |   769.00 |     654.00 |      703.00 |      665.00 |       811.00 |  701.43 |

### Bare ID: mean tokens

| format    | o200k_base (GPT-4o) | cl100k_base (GPT-4) | gemma-7b | Llama-3-8B | Qwen2.5-72B | DeepSeek-R1 | CodeLlama-7b |  mean |
| :-------- | ------------------: | ------------------: | -------: | ---------: | ----------: | ----------: | -----------: | ----: |
| sf-b62    |                6.91 |                7.29 |     6.78 |       7.28 |        7.52 |        7.12 |         8.47 |  7.34 |
| sf-b36    |                7.68 |                7.84 |     8.45 |       7.82 |        8.79 |        7.81 |        10.09 |  8.35 |
| sf-hex    |                8.37 |                8.35 |    13.79 |       8.35 |       13.81 |        8.44 |        14.92 | 10.86 |
| sonyflake |                6.00 |                6.00 |    18.00 |       6.00 |       18.00 |        6.00 |        19.00 | 11.29 |
| sf-dec    |                6.00 |                6.00 |    18.00 |       6.00 |       18.00 |        6.00 |        19.00 | 11.29 |
| nanoid    |               14.39 |               15.10 |    14.47 |      15.07 |       15.61 |       14.80 |        17.64 | 15.29 |
| cuid2     |               15.23 |               15.56 |    16.43 |      15.53 |       17.16 |       15.58 |        18.25 | 16.25 |
| objectid  |               14.51 |               14.46 |    21.14 |      14.46 |       21.23 |       14.66 |        22.53 | 17.57 |
| ulid      |               16.95 |               17.26 |    19.23 |      17.22 |       20.22 |       17.13 |        23.35 | 18.77 |
| ksuid     |               18.84 |               19.87 |    18.43 |      19.84 |       20.47 |       19.36 |        23.25 | 20.01 |
| hex128    |               18.45 |               18.40 |    28.28 |      18.40 |       28.39 |       18.69 |        29.49 | 22.87 |
| uuid4     |               22.81 |               22.83 |    32.70 |      22.83 |       31.80 |       23.05 |        33.78 | 27.11 |
| uuid1     |               23.06 |               23.08 |    32.94 |      23.07 |       32.00 |       23.26 |        33.99 | 27.34 |
| uuid7     |               22.99 |               23.02 |    33.16 |      23.02 |       32.23 |       23.20 |        34.49 | 27.45 |

### Daemon reply: mean tokens

| format    | o200k_base (GPT-4o) | cl100k_base (GPT-4) | gemma-7b | Llama-3-8B | Qwen2.5-72B | DeepSeek-R1 | CodeLlama-7b |  mean |
| :-------- | ------------------: | ------------------: | -------: | ---------: | ----------: | ----------: | -----------: | ----: |
| sf-b62    |               16.91 |               17.29 |    16.78 |      17.28 |       17.52 |       17.12 |        18.25 | 17.31 |
| sf-b36    |               17.68 |               17.84 |    18.45 |      17.82 |       18.79 |       17.81 |        19.25 | 18.23 |
| sf-hex    |               18.37 |               18.35 |    23.79 |      18.35 |       23.81 |       18.43 |        23.92 | 20.72 |
| sonyflake |               16.00 |               16.00 |    28.00 |      16.00 |       28.00 |       16.00 |        28.00 | 21.14 |
| sf-dec    |               16.00 |               16.00 |    28.00 |      16.00 |       28.00 |       16.00 |        28.00 | 21.14 |
| nanoid    |               24.41 |               25.12 |    24.47 |      25.09 |       25.63 |       24.82 |        27.44 | 25.28 |
| cuid2     |               25.23 |               25.57 |    26.43 |      25.53 |       27.16 |       25.58 |        28.12 | 26.23 |
| objectid  |               24.51 |               24.46 |    31.14 |      24.46 |       31.23 |       24.66 |        31.53 | 27.43 |
| ulid      |               26.95 |               27.26 |    29.23 |      27.22 |       30.22 |       27.13 |        32.35 | 28.62 |
| ksuid     |               28.84 |               29.87 |    28.43 |      29.84 |       30.47 |       29.36 |        32.25 | 29.87 |
| hex128    |               28.45 |               28.40 |    38.28 |      28.40 |       38.39 |       28.69 |        38.80 | 32.77 |
| uuid4     |               32.81 |               32.83 |    42.70 |      32.83 |       41.80 |       33.05 |        43.13 | 37.02 |
| uuid1     |               33.06 |               33.08 |    42.94 |      33.08 |       42.00 |       33.26 |        43.30 | 37.25 |
| uuid7     |               32.99 |               33.02 |    43.16 |      33.02 |       42.23 |       33.20 |        43.49 | 37.30 |

## Findings

Averaged over the seven tokenizers, the snapshot per-line cost ranks `sf-b62` 7.31, `sf-b36` 8.11, `sf-hex` 10.72, `sonyflake` and `sf-dec` 11.14, `nanoid` 14.91, `cuid2` 15.58, `objectid` 17.43, `ulid` 18.62, `ksuid` 19.87, `hex128` 22.50, `uuid4` 26.70, `uuid1` 26.96 and `uuid7` 27.30. With `sf-b36`, the 59-line snapshot takes 1180.02 tokens against 2028.76 with `hex128`.

The decimal formats `sf-dec` and `sonyflake` take 6 tokens per line with o200k_base, cl100k_base, Llama-3 and DeepSeek-R1, which group up to three digits per token, and 18 with gemma-7b, Qwen2.5 and CodeLlama, which encode every digit separately. The hex formats cost more with gemma-7b, Qwen2.5 and CodeLlama as well: `hex128` 27.99–28.53 tokens per line against 18.12–18.41, `objectid` 21.14–21.53 against 14.46–14.66. CodeLlama has the highest per-line count of the seven tokenizers for every format; for the decimal formats it ties with gemma-7b and Qwen2.5. Character count alone does not set the token count: `objectid` and `cuid2` both have 24 characters and cost 17.43 and 15.58 tokens per line, and with o200k_base the 18-digit `sf-dec` takes 6.00 tokens against 6.91 for the 10-character `sf-b62`.

In the age scan, `sf-dec` and `sonyflake` reach 19 digits between 7.5 and 7.75 years after 2026-01-01 and `sf-b62` 11 characters between 6.25 and 6.5 years; `sf-b36` reaches 12 characters between 0.75 and 1 year and stays at 12 through year 10. The daemon and the extension use `sf-b36`. `sf-b62` takes 0.80 fewer tokens per line, but two IDs that differ only in letter case map to the same artifact file name on a case-insensitive file system.
