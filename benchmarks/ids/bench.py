import hashlib
import json
import os
import random
import string
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path

import httpx
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
import tiktoken
import time_machine
from adjustText import adjust_text
from bson import ObjectId
from cuid2 import Cuid
from cuid2.utils import create_fingerprint
from ksuid import Ksuid
from matplotlib.figure import Figure
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle
from nanoid import resources as nanoid_resources
from nanoid.method import method as nanoid_method
from sonyflake import Sonyflake
from tokenizers import Tokenizer
from ulid import PureRandomPolicy, ULIDGenerator
from ulid import constants as ulid_constants

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
ARTIFACTS = ROOT / "artifacts"
os.environ["TIKTOKEN_CACHE_DIR"] = str(CACHE / "tiktoken")

# Every format draws from its own random.Random(f"{SEED}/<name>").
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

UNIX_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
# 100 ns intervals from the UUID epoch 1582-10-15 to the Unix epoch.
UUID_EPOCH_OFFSET = 0x01B21DD213814000
# The sonyflake package requires a start time; 2014-09-01 is the default of
# sony/sonyflake v1. compose() takes the machine ID of each call.
SONYFLAKE = Sonyflake(start_time=datetime(2014, 9, 1, tzinfo=UTC), machine_id=0)
CUID2_FINGERPRINT = "omw-token-bench"

B36 = string.digits + string.ascii_lowercase
B62 = string.digits + string.ascii_uppercase + string.ascii_lowercase


def to_base(n: int, alphabet: str) -> str:
    digits = ""
    while True:
        n, digit = divmod(n, len(alphabet))
        digits = alphabet[digit] + digits
        if n == 0:
            return digits


def utc(ms: int) -> datetime:
    return UNIX_EPOCH + timedelta(milliseconds=ms)


def sample_ms(rng: random.Random) -> int:
    return rng.randrange(SAMPLE_START_MS, SAMPLE_END_MS)


def snowflake(rng: random.Random, start_ms: int, end_ms: int) -> int:
    elapsed = rng.randrange(start_ms, end_ms) - EPOCH_MS
    worker = rng.randrange(1 << WORKER_BITS)
    sequence = rng.randrange(16)
    return (
        (elapsed << (WORKER_BITS + SEQUENCE_BITS))
        | (worker << SEQUENCE_BITS)
        | sequence
    )


def sonyflake(rng: random.Random, start_ms: int, end_ms: int) -> int:
    return SONYFLAKE.compose(
        dt=utc(rng.randrange(start_ms, end_ms)),
        sequence=rng.randrange(16),
        machine_id=rng.randrange(1 << 16),
    )


def uuid1_id(rng: random.Random) -> str:
    timestamp = UUID_EPOCH_OFFSET + rng.randrange(
        SAMPLE_START_MS * 10_000, SAMPLE_END_MS * 10_000
    )
    clock_seq = rng.getrandbits(14)
    node = rng.getrandbits(48) | (1 << 40)  # random node: multicast bit set
    fields = (
        timestamp & 0xFFFF_FFFF,
        (timestamp >> 32) & 0xFFFF,
        (timestamp >> 48) & 0x0FFF,
        (clock_seq >> 8) & 0x3F,
        clock_seq & 0xFF,
        node,
    )
    return str(uuid.UUID(fields=fields, version=1))


def uuid7_id(rng: random.Random) -> str:
    return str(uuid.UUID(int=(sample_ms(rng) << 80) | rng.getrandbits(80), version=7))


def nanoid_id(rng: random.Random) -> str:
    return nanoid_method(
        rng.randbytes, nanoid_resources.alphabet, nanoid_resources.size
    )


def ulid_id(rng: random.Random) -> str:
    generator = ULIDGenerator(
        randomness=lambda _ms: rng.randbytes(ulid_constants.RANDOMNESS_LEN),
        policy=PureRandomPolicy(),
    )
    return str(generator.generate(sample_ms(rng)))


def cuid2_id(rng: random.Random) -> str:
    # Cuid.generate() hashes time.time_ns(); time-machine sets that clock.
    generator = Cuid(
        random_generator=partial(random.Random, rng.getrandbits(64)),
        fingerprint=partial(create_fingerprint, fingerprint_data=CUID2_FINGERPRINT),
    )
    with time_machine.travel(utc(sample_ms(rng)), tick=False):
        return generator.generate()


def ksuid_id(rng: random.Random) -> str:
    return str(
        Ksuid(
            datetime=utc(sample_ms(rng)),
            payload=rng.randbytes(Ksuid.PAYLOAD_LENGTH_IN_BYTES),
        )
    )


def objectid_id(rng: random.Random) -> str:
    # 4-byte Unix seconds, then the 5-byte process value and 3-byte counter.
    seconds = sample_ms(rng) // 1000
    return str(ObjectId(seconds.to_bytes(4, "big") + rng.randbytes(8)))


ID_FORMATS: dict[str, Callable[[random.Random], str]] = {
    "uuid4": lambda rng: str(uuid.UUID(int=rng.getrandbits(128), version=4)),
    "uuid1": uuid1_id,
    "uuid7": uuid7_id,
    "hex128": lambda rng: f"{rng.getrandbits(128):032x}",
    "nanoid": nanoid_id,
    "ulid": ulid_id,
    "cuid2": cuid2_id,
    "ksuid": ksuid_id,
    "objectid": objectid_id,
    "sonyflake": lambda rng: str(sonyflake(rng, SAMPLE_START_MS, SAMPLE_END_MS)),
}
SNOWFLAKE_FORMATS: dict[str, Callable[[int], str]] = {
    "sf-dec": str,
    "sf-hex": lambda n: f"{n:x}",
    "sf-b36": lambda n: to_base(n, B36),
    "sf-b62": lambda n: to_base(n, B62),
}
FORMATS = [*ID_FORMATS, *SNOWFLAKE_FORMATS]
AGE_FORMATS = [*SNOWFLAKE_FORMATS, "sonyflake"]
EMPHASIS = ["hex128", "sf-b36"]

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
PLOT_LABELS = {
    **{name: LABELS[name].replace(" (", "\n(") for name in TIKTOKEN_ENCODINGS},
    **{name: "\n".join(LABELS[name].rsplit("-", 1)) for name in HF_TOKENIZERS},
}
FORMAT_LABELS = {fmt: fmt for fmt in FORMATS} | {
    "hex128": "hex128 (omw 0.1.1)",
    "sf-b36": "sf-b36 (chosen)",
}
PALETTE = (
    {fmt: "#9e9e9e" for fmt in FORMATS}
    | {"hex128": "#c62828", "sonyflake": "#8e24aa"}
    | dict(zip(SNOWFLAKE_FORMATS, sns.color_palette("crest", 4).as_hex(), strict=True))
)

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


def id_samples() -> dict[str, list[str]]:
    samples = {}
    for fmt, make in ID_FORMATS.items():
        rng = random.Random(f"{SEED}/{fmt}")
        samples[fmt] = [make(rng) for _ in range(N)]
    rng = random.Random(f"{SEED}/snowflake")
    snowflakes = [snowflake(rng, SAMPLE_START_MS, SAMPLE_END_MS) for _ in range(N)]
    for fmt, encode in SNOWFLAKE_FORMATS.items():
        samples[fmt] = [encode(n) for n in snowflakes]
    return samples


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


def measure_age(counts: dict[str, Count]) -> pd.DataFrame:
    snowflake_rng = random.Random(f"{SEED}/age/snowflake")
    sonyflake_rng = random.Random(f"{SEED}/age/sonyflake")
    records = []
    for years in AGES:
        start = EPOCH_MS + round(years * YEAR_MS)
        for _ in range(N):
            n = snowflake(snowflake_rng, start, start + DAY_MS)
            records += [
                {"years": years, "format": fmt, "id": encode(n)}
                for fmt, encode in SNOWFLAKE_FORMATS.items()
            ]
            records.append(
                {
                    "years": years,
                    "format": "sonyflake",
                    "id": str(sonyflake(sonyflake_rng, start, start + DAY_MS)),
                }
            )
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
    pivot = pivot.loc[FORMATS, TOKENIZERS]
    return pivot.assign(mean=pivot.mean(axis=1)).sort_values("mean", kind="stable")


def mean_chars(summary: pd.DataFrame) -> pd.Series:
    return summary.groupby("format").mean_id_chars.first().loc[FORMATS]


def report(summary: pd.DataFrame) -> str:
    snapshot = table(summary, "snapshot", "mean_tokens")
    id_tokens = table(summary, "snapshot", "mean_id_tokens")
    snapshot.loc["no generation (@e.)"] = (snapshot - id_tokens).iloc[0]
    sections = [
        (
            "Mean characters per ID",
            mean_chars(summary).sort_values(kind="stable").to_frame("chars"),
        ),
        (
            "Snapshot: mean tokens per line over @e.",
            table(summary, "snapshot", "id_tokens_per_ref"),
        ),
        (f"Snapshot ({REFS['snapshot']} lines): mean tokens", snapshot),
        ("Bare ID: mean tokens", table(summary, "id", "mean_tokens")),
        ("Daemon reply: mean tokens", table(summary, "reply", "mean_tokens")),
    ]
    return "\n\n".join(
        f"### {title}\n\n{frame.rename(columns=LABELS).to_markdown(floatfmt='.2f')}"
        for title, frame in sections
    )


def heatmap(summary: pd.DataFrame, context: str, value: str, title: str) -> Figure:
    data = table(summary, context, value)
    fig, ax = plt.subplots(figsize=(11, 7.2))
    sns.heatmap(
        data.rename(index=FORMAT_LABELS, columns=PLOT_LABELS),
        annot=True,
        fmt=".2f",
        cmap="YlOrRd",
        linewidths=0.5,
        linecolor="white",
        annot_kws={"fontsize": 9},
        cbar_kws={"label": "Tokens", "shrink": 0.8},
        ax=ax,
    )
    ax.axvline(len(TOKENIZERS), color="white", linewidth=4)
    for row, fmt in enumerate(data.index):
        if fmt in EMPHASIS:
            ax.add_patch(
                Rectangle(
                    (0, row),
                    data.shape[1],
                    1,
                    fill=False,
                    edgecolor="black",
                    linewidth=2.5,
                    clip_on=False,
                )
            )
    emphasized = {FORMAT_LABELS[fmt] for fmt in EMPHASIS}
    for label in ax.get_yticklabels():
        if label.get_text() in emphasized:
            label.set_fontweight("bold")
    ax.tick_params(axis="x", labelrotation=0, labelsize=9)
    ax.tick_params(axis="y", labelrotation=0)
    ax.set(title=title, xlabel=None, ylabel=None)
    return fig


def length_chart(summary: pd.DataFrame) -> Figure:
    data = pd.DataFrame(
        {
            "chars": mean_chars(summary),
            "tokens": table(summary, "snapshot", "id_tokens_per_ref")["mean"],
        }
    ).loc[FORMATS]
    fig, ax = plt.subplots(figsize=(10, 6.5))
    sns.scatterplot(
        data=data.reset_index(),
        x="chars",
        y="tokens",
        hue="format",
        palette=PALETTE,
        s=70,
        legend=False,
        ax=ax,
    )
    ax.set(
        title="Characters vs. tokens per ID (snapshot refs, mean of 7 tokenizers)",
        xlabel="Mean characters per ID",
        ylabel="Mean tokens per snapshot line over '@e.'",
        xlim=(0, data.chars.max() * 1.1),
        ylim=(0, data.tokens.max() * 1.15),
    )
    # Formats with the same point share one label.
    points = data.reset_index().groupby(["chars", "tokens"], sort=False)["format"]
    texts = [
        ax.text(
            chars,
            tokens,
            " / ".join(FORMAT_LABELS[fmt] for fmt in fmts),
            fontsize=9,
            fontweight="bold" if set(fmts) & set(EMPHASIS) else "normal",
        )
        for (chars, tokens), fmts in points
    ]
    adjust_text(
        texts,
        x=data.chars.to_numpy(),
        y=data.tokens.to_numpy(),
        ax=ax,
        arrowprops={"arrowstyle": "-", "color": "0.5", "linewidth": 0.6},
    )
    return fig


def age_chart(age: pd.DataFrame, hex128: pd.Series) -> Figure:
    grid = sns.relplot(
        data=age.assign(tokenizer=age.tokenizer.map(LABELS)),
        kind="line",
        x="years",
        y="mean_tokens",
        hue="format",
        hue_order=AGE_FORMATS,
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
        for fmt in AGE_FORMATS
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
        f"Mean tokens per bare ID by ID age ({N} IDs per point)", y=1.1
    )
    return grid.figure


def save(fig: Figure, path: Path, dpi: int) -> None:
    fig.savefig(path, dpi=dpi, bbox_inches="tight")
    plt.close(fig)


def main() -> None:
    sns.set_theme(style="whitegrid")
    ARTIFACTS.mkdir(exist_ok=True)
    counts = {name: tiktoken_count(name) for name in TIKTOKEN_ENCODINGS} | {
        repo: hf_count(repo) for repo in HF_TOKENIZERS
    }
    for name, count in counts.items():
        if count([""]) != [0]:
            raise ValueError(f"{name} returns tokens for empty input")

    tokens = measure(id_samples(), counts)
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
    age = measure_age(counts)
    age.to_csv(ARTIFACTS / "age.csv", index=False, float_format="%.3f")
    markdown = report(summary)
    (ARTIFACTS / "summary.md").write_text(markdown + "\n")
    print(markdown)

    save(
        heatmap(summary, "id", "mean_tokens", f"Mean tokens per bare ID (mean of {N})"),
        ARTIFACTS / "ids-bare.png",
        165,
    )
    save(
        heatmap(
            summary,
            "snapshot",
            "id_tokens_per_ref",
            f"Snapshot ref cost: tokens per line over '@e.' "
            f"({REFS['snapshot']}-line snapshot, mean of {N})",
        ),
        ARTIFACTS / "ids-snapshot.png",
        165,
    )
    save(length_chart(summary), ARTIFACTS / "ids-length.png", 190)
    hex128 = summary.query("context == 'id' and format == 'hex128'").set_index(
        "tokenizer"
    )
    save(age_chart(age, hex128.mean_tokens), ARTIFACTS / "ids-age.png", 120)


if __name__ == "__main__":
    main()
