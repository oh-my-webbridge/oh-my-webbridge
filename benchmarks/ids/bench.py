import hashlib
import json
import os
import random
import string
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
import tiktoken
from matplotlib.lines import Line2D
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
ARTIFACTS = ROOT / "artifacts"
os.environ["TIKTOKEN_CACHE_DIR"] = str(CACHE / "tiktoken")

SEED = 20260101
N = 1000

# Snowflake layout of internal/bridge/id.go: 41-bit milliseconds since the
# epoch, 10-bit worker, 12-bit sequence.
EPOCH_MS = 1767225600000  # 2026-01-01T00:00:00Z
WORKER_BITS = 10
SEQUENCE_BITS = 12
DAY_MS = 86_400_000
YEAR_MS = 31_557_600_000  # 365.25 days
SAMPLE_START_MS = int(datetime(2026, 11, 1, tzinfo=UTC).timestamp() * 1000)
SAMPLE_END_MS = int(datetime(2027, 11, 1, tzinfo=UTC).timestamp() * 1000)
AGES = [quarter / 4 for quarter in range(41)]

B36 = string.digits + string.ascii_lowercase
B62 = string.digits + string.ascii_uppercase + string.ascii_lowercase


def to_base(n: int, alphabet: str) -> str:
    digits = ""
    while True:
        n, digit = divmod(n, len(alphabet))
        digits = alphabet[digit] + digits
        if n == 0:
            return digits


SNOWFLAKE_FORMATS: dict[str, Callable[[int], str]] = {
    "sf-dec": str,
    "sf-hex": lambda n: f"{n:x}",
    "sf-b36": lambda n: to_base(n, B36),
    "sf-b62": lambda n: to_base(n, B62),
}
FORMATS = ["uuid4", "hex128", *SNOWFLAKE_FORMATS]

# The tree asserted by the generic snapshot test in tests/firefox-page.test.mjs
# ("snapshot derives roles, names, values and states in Chrome's line
# format"). The test builds the Password value from a variable; "hunter2"
# stands in for it. Every line holds one "@eG." ref.
SNAPSHOT_LINES = [
    '@eG.0 RootWebArea "Snapshot fixture"',
    "  @eG.1 banner",
    '    @eG.2 navigation "Primary"',
    '      @eG.3 link "Home"',
    '        @eG.4 StaticText "Home"',
    '      @eG.5 StaticText "No link"',
    "  @eG.6 main",
    '    @eG.7 heading "Main heading"',
    '      @eG.8 StaticText "Main heading"',
    '    @eG.9 region "Sub heading"',
    '      @eG.10 heading "Sub heading"',
    '        @eG.11 StaticText "Sub heading"',
    "      @eG.12 paragraph",
    '        @eG.13 StaticText "Plain"',
    "        @eG.14 strong",
    '          @eG.15 StaticText "bold"',
    '        @eG.16 StaticText "text."',
    '    @eG.17 form "Login"',
    '      @eG.18 StaticText "User name"',
    '      @eG.19 textbox "User name" value="avery" [required=true]',
    '      @eG.20 StaticText "Password"',
    '      @eG.21 textbox "Password" value="hunter2" [required=false]',
    '      @eG.22 textbox "Email address" [required=false]',
    '      @eG.23 spinbutton "Count" value=3 [required=false]',
    '      @eG.24 checkbox "Remember" [checked=true]',
    '      @eG.25 StaticText "Remember"',
    '      @eG.26 radio "Radio A" [checked=false]',
    '      @eG.27 radio "Radio B" [checked=true]',
    '      @eG.28 combobox "Choice" value="Beta" [required=false expanded=false]',
    '        @eG.29 option "Alpha" [selected=false]',
    '        @eG.30 option "Beta" [selected=true]',
    '      @eG.31 textbox "Notes" value="note text" [required=false]',
    '      @eG.32 button "Sign in"',
    '      @eG.33 button "Menu" [expanded=false]',
    '        @eG.34 StaticText "Menu"',
    '      @eG.35 button "Disabled" [disabled=true]',
    '        @eG.36 StaticText "Disabled"',
    '      @eG.37 button "Sub heading avery"',
    '        @eG.38 StaticText "Labelled"',
    '    @eG.39 image "Logo image"',
    "    @eG.40 list",
    "      @eG.41 listitem",
    '        @eG.42 StaticText "First item"',
    "    @eG.43 tablist",
    '      @eG.44 tab "Tab one" [selected=true]',
    '        @eG.45 StaticText "Tab one"',
    '    @eG.46 checkbox "Tri" [checked=mixed]',
    '    @eG.47 StaticText "Shown child"',
    '    @eG.48 generic value="Editable"',
    '      @eG.49 StaticText "Editable"',
    "    @eG.50 group",
    '      @eG.51 DisclosureTriangle "More" [expanded=false]',
    '        @eG.52 StaticText "More"',
    "    @eG.53 generic",
    '      @eG.54 button "Shadow button"',
    '        @eG.55 StaticText "Shadow button"',
    '    @eG.56 Iframe "Inner frame"',
    "  @eG.57 contentinfo",
    '    @eG.58 StaticText "Footer text"',
]
SNAPSHOT = "\n".join(SNAPSHOT_LINES)

# Each context renders one ID; rendering "" gives the same text without it.
CONTEXTS: dict[str, Callable[[str], str]] = {
    "id": lambda id_: id_,
    "reply": lambda id_: json.dumps(
        {"id": id_, "result": {"ok": True}}, separators=(",", ":")
    ),
    "snapshot": lambda id_: SNAPSHOT.replace("@eG.", f"@e{id_}."),
}
REFS = {"id": 1, "reply": 1, "snapshot": SNAPSHOT.count("@eG.")}

TIKTOKEN_ENCODINGS = ["o200k_base", "cl100k_base"]
HUB = "https://huggingface.co/{repo}/resolve/{revision}/tokenizer.json"
# Files that tiktokenizer.vercel.app downloaded from the Hub for its own UI;
# used for the gated repositories, which need a Hub login.
PROXY = "https://tiktokenizer.vercel.app/hf/{repo}/tokenizer.json"
# repo: (URL template, Hub revision of the file, SHA-256 of tokenizer.json)
HF_TOKENIZERS = {
    "google/gemma-7b": (
        PROXY,
        "main",
        "c15eb04bc5ad609fb26533e8525302c5640a945e5f67f65b7c849900acda7d99",
    ),
    "meta-llama/Meta-Llama-3-8B": (
        PROXY,
        "refs/pr/35",
        "c05a3c2174e9edd5be19dc5a0748c42a9037bec2811ce062728bfd71f8702d78",
    ),
    "Qwen/Qwen2.5-72B": (
        HUB,
        "efba10c8e54e91e0d9570ab5f7b51a958474d4cb",
        "c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539",
    ),
    "deepseek-ai/DeepSeek-R1": (
        HUB,
        "56d4cbbb4d29f4355bab4b9a39ccb717a14ad5ad",
        "ecb6f9fc369894346f0511f4074ca75cee5cd5f3b06d02f1ba35fcd39f8e121d",
    ),
    "codellama/CodeLlama-7b-hf": (
        HUB,
        "6c284d1468fe6c413cf56183e69b194dcfa27fe6",
        "dcb4337ba92f948b322e080f8b59a2a21cfe65dc2aa7ecf7df080ae8aa63c157",
    ),
}
TOKENIZERS = [*TIKTOKEN_ENCODINGS, *HF_TOKENIZERS]
LABELS = {
    "o200k_base": "o200k_base (GPT-4o)",
    "cl100k_base": "cl100k_base (GPT-4)",
    "google/gemma-7b": "gemma-7b",
    "meta-llama/Meta-Llama-3-8B": "Llama-3-8B",
    "Qwen/Qwen2.5-72B": "Qwen2.5-72B",
    "deepseek-ai/DeepSeek-R1": "DeepSeek-R1",
    "codellama/CodeLlama-7b-hf": "CodeLlama-7b",
}
PLOT_LABELS = {name: label.replace(" (", "\n(") for name, label in LABELS.items()}
FORMAT_LABELS = {fmt: fmt for fmt in FORMATS} | {
    "hex128": "hex128 (omw 0.1.1)",
    "sf-b36": "sf-b36 (chosen)",
}
PALETTE = {
    "uuid4": "#9e9e9e",
    "hex128": "#c62828",
    **dict(zip(SNOWFLAKE_FORMATS, sns.color_palette("crest", 4).as_hex(), strict=True)),
}
FORMAT_PALETTE = {FORMAT_LABELS[fmt]: color for fmt, color in PALETTE.items()}

type Count = Callable[[list[str]], list[int]]


def tiktoken_count(name: str) -> Count:
    encoding = tiktoken.get_encoding(name)
    return lambda texts: [len(ids) for ids in encoding.encode_ordinary_batch(texts)]


def hf_count(repo: str) -> Count:
    template, revision, sha256 = HF_TOKENIZERS[repo]
    url = template.format(repo=repo, revision=revision)
    path = CACHE / "hf" / repo / "tokenizer.json"
    if path.exists():
        content = path.read_bytes()
    else:
        response = httpx.get(url, follow_redirects=True, timeout=120)
        response.raise_for_status()
        content = response.content
    digest = hashlib.sha256(content).hexdigest()
    if digest != sha256:
        raise ValueError(f"{url} has SHA-256 {digest}, expected {sha256}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    tokenizer = Tokenizer.from_buffer(content)
    return lambda texts: [
        len(encoding.ids)
        for encoding in tokenizer.encode_batch(texts, add_special_tokens=False)
    ]


def snowflake(rng: random.Random, start_ms: int, end_ms: int) -> int:
    elapsed = rng.randrange(start_ms, end_ms) - EPOCH_MS
    worker = rng.randrange(1 << WORKER_BITS)
    sequence = rng.randrange(16)
    return (
        (elapsed << (WORKER_BITS + SEQUENCE_BITS))
        | (worker << SEQUENCE_BITS)
        | sequence
    )


def id_samples(rng: random.Random) -> dict[str, list[str]]:
    snowflakes = [snowflake(rng, SAMPLE_START_MS, SAMPLE_END_MS) for _ in range(N)]
    return {
        "uuid4": [
            str(uuid.UUID(int=rng.getrandbits(128), version=4)) for _ in range(N)
        ],
        "hex128": [f"{rng.getrandbits(128):032x}" for _ in range(N)],
        **{
            fmt: [encode(n) for n in snowflakes]
            for fmt, encode in SNOWFLAKE_FORMATS.items()
        },
    }


def measure(samples: dict[str, list[str]], counts: dict[str, Count]) -> pd.DataFrame:
    frames = []
    for context, render in CONTEXTS.items():
        for fmt, ids in samples.items():
            texts = [render(id_) for id_ in ids]
            for name, count in counts.items():
                baseline = count([render("")])[0]
                tokens = count(texts)
                frames.append(
                    pd.DataFrame(
                        {
                            "tokenizer": name,
                            "format": fmt,
                            "context": context,
                            "sample": range(len(ids)),
                            "id": ids,
                            "id_chars": [len(id_) for id_ in ids],
                            "tokens": tokens,
                            "id_tokens": [n - baseline for n in tokens],
                        }
                    )
                )
    frame = pd.concat(frames, ignore_index=True)
    frame["id_tokens_per_ref"] = frame.id_tokens / frame.context.map(REFS)
    return frame


def measure_age(rng: random.Random, counts: dict[str, Count]) -> pd.DataFrame:
    records = []
    for years in AGES:
        start = EPOCH_MS + round(years * YEAR_MS)
        for _ in range(N):
            n = snowflake(rng, start, start + DAY_MS)
            records += [
                {"years": years, "format": fmt, "id": encode(n)}
                for fmt, encode in SNOWFLAKE_FORMATS.items()
            ]
    ids = pd.DataFrame(records)
    frame = pd.concat(
        [
            ids.assign(tokenizer=name, tokens=count(ids.id.tolist()))
            for name, count in counts.items()
        ],
        ignore_index=True,
    )
    return (
        frame.assign(id_chars=frame.id.str.len())
        .groupby(["years", "format", "tokenizer"], sort=False)[["tokens", "id_chars"]]
        .mean()
        .add_prefix("mean_")
        .reset_index()
    )


def table(summary: pd.DataFrame, context: str, value: str) -> pd.DataFrame:
    rows = summary[summary.context == context]
    pivot = rows.pivot(index="format", columns="tokenizer", values=value)
    pivot = pivot.loc[FORMATS, TOKENIZERS].rename(columns=LABELS)
    return pivot.assign(mean=pivot.mean(axis=1))


def report(summary: pd.DataFrame) -> str:
    snapshot = table(summary, "snapshot", "mean_tokens")
    id_tokens = table(summary, "snapshot", "mean_id_tokens")
    snapshot.loc["no generation (@e.)"] = (snapshot - id_tokens).iloc[0]
    chars = summary.groupby("format", sort=False).mean_id_chars.first()
    sections = [
        ("Mean characters per ID", chars.to_frame("chars").loc[FORMATS]),
        ("Bare ID: mean tokens", table(summary, "id", "mean_tokens")),
        ("Daemon reply: mean tokens", table(summary, "reply", "mean_tokens")),
        (f"Snapshot ({REFS['snapshot']} lines): mean tokens", snapshot),
        (
            "Snapshot: mean tokens per line over @e.",
            table(summary, "snapshot", "id_tokens_per_ref"),
        ),
    ]
    return "\n\n".join(
        f"### {title}\n\n{frame.to_markdown(floatfmt='.2f')}"
        for title, frame in sections
    )


def bar_chart(
    summary: pd.DataFrame,
    context: str,
    value: str,
    title: str,
    ylabel: str,
    label_format: str,
    path: Path,
) -> None:
    data = summary[summary.context == context].assign(
        tokenizer=lambda f: f.tokenizer.map(PLOT_LABELS),
        format=lambda f: f.format.map(FORMAT_LABELS),
    )
    fig, ax = plt.subplots(figsize=(11, 5))
    sns.barplot(
        data=data,
        x="tokenizer",
        y=value,
        hue="format",
        order=[PLOT_LABELS[name] for name in TOKENIZERS],
        hue_order=[FORMAT_LABELS[fmt] for fmt in FORMATS],
        palette=FORMAT_PALETTE,
        errorbar=None,
        ax=ax,
    )
    for container in ax.containers:
        ax.bar_label(container, fmt=label_format, fontsize=6.5, rotation=90, padding=2)
    ax.margins(y=0.14)
    ax.set(title=title, xlabel=None, ylabel=ylabel)
    sns.move_legend(
        ax,
        "upper center",
        bbox_to_anchor=(0.5, -0.12),
        ncols=len(FORMATS),
        title=None,
        frameon=False,
    )
    fig.savefig(path, dpi=175, bbox_inches="tight")
    plt.close(fig)


def age_chart(age: pd.DataFrame, hex128: pd.Series, path: Path) -> None:
    grid = sns.relplot(
        data=age.assign(tokenizer=age.tokenizer.map(LABELS)),
        kind="line",
        x="years",
        y="mean_tokens",
        hue="format",
        hue_order=list(SNOWFLAKE_FORMATS),
        palette=PALETTE,
        col="tokenizer",
        col_order=[LABELS[name] for name in TOKENIZERS],
        col_wrap=4,
        height=2.6,
        aspect=1.3,
        linewidth=1.8,
        legend=False,
    )
    for name in TOKENIZERS:
        grid.axes_dict[LABELS[name]].axhline(
            hex128[name], color=PALETTE["hex128"], linestyle="--", linewidth=1.4
        )
    grid.set_titles("{col_name}")
    grid.set_axis_labels("Years since 2026-01-01", "Tokens per bare ID")
    handles = [
        Line2D([], [], color=PALETTE[fmt], linewidth=1.8, label=FORMAT_LABELS[fmt])
        for fmt in SNOWFLAKE_FORMATS
    ] + [
        Line2D(
            [],
            [],
            color=PALETTE["hex128"],
            linestyle="--",
            linewidth=1.4,
            label=FORMAT_LABELS["hex128"],
        )
    ]
    grid.figure.legend(
        handles=handles,
        loc="lower center",
        bbox_to_anchor=(0.5, 1.0),
        ncols=len(handles),
        frameon=False,
    )
    grid.figure.suptitle(
        f"Mean tokens per bare Snowflake ID by ID age ({N} IDs per point)", y=1.1
    )
    grid.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(grid.figure)


def main() -> None:
    sns.set_theme(style="whitegrid")
    ARTIFACTS.mkdir(exist_ok=True)
    counts = {name: tiktoken_count(name) for name in TIKTOKEN_ENCODINGS} | {
        repo: hf_count(repo) for repo in HF_TOKENIZERS
    }
    for name, count in counts.items():
        if count([""]) != [0]:
            raise ValueError(f"{name} returns tokens for empty input")

    rng = random.Random(SEED)
    tokens = measure(id_samples(rng), counts)
    tokens.to_csv(ARTIFACTS / "tokens.csv", index=False)
    summary = (
        tokens.groupby(["context", "format", "tokenizer"], sort=False)[
            ["tokens", "id_tokens", "id_tokens_per_ref", "id_chars"]
        ]
        .mean()
        .add_prefix("mean_")
        .reset_index()
        .rename(columns={"mean_id_tokens_per_ref": "id_tokens_per_ref"})
    )
    summary.to_csv(ARTIFACTS / "summary.csv", index=False, float_format="%.3f")
    age = measure_age(rng, counts)
    age.to_csv(ARTIFACTS / "age.csv", index=False, float_format="%.3f")
    markdown = report(summary)
    (ARTIFACTS / "summary.md").write_text(markdown + "\n")
    print(markdown)

    bar_chart(
        summary,
        "id",
        "mean_tokens",
        f"Tokens per bare ID (mean of {N} IDs)",
        "Tokens",
        "{:.1f}",
        ARTIFACTS / "ids-bare.png",
    )
    bar_chart(
        summary,
        "snapshot",
        "id_tokens_per_ref",
        f"Snapshot ref cost: tokens per line over '@e.' "
        f"({REFS['snapshot']}-line snapshot, mean of {N})",
        "Tokens per line",
        "{:.2f}",
        ARTIFACTS / "ids-snapshot.png",
    )
    hex128 = summary.query("context == 'id' and format == 'hex128'").set_index(
        "tokenizer"
    )
    age_chart(age, hex128.mean_tokens, ARTIFACTS / "ids-age.png")


if __name__ == "__main__":
    main()
