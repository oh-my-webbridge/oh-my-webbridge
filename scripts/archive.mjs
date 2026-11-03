import { execFile } from "node:child_process";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function packTarZst(archive, directory, entries) {
  const destination = resolve(archive);
  // Use ordinary tar on both GNU and BSD systems; zstd owns compression.
  // Staging on the destination filesystem keeps the final rename atomic.
  const work = await mkdtemp(join(dirname(destination), ".omw-archive-"));
  try {
    const tar = join(work, "archive.tar");
    const compressed = join(work, "archive.tar.zst");
    await exec("tar", ["-cf", tar, "-C", resolve(directory), "--", ...entries]);
    await exec("zstd", ["-3", "-T1", "--quiet", "--force", "-o", compressed, "--", tar]);
    await rename(compressed, destination);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function withTarZst(archive, inspect) {
  const work = await mkdtemp(join(tmpdir(), "omw-archive-"));
  try {
    const tar = join(work, "archive.tar");
    await exec("zstd", ["--decompress", "--quiet", "--force", "-o", tar, "--", resolve(archive)]);
    return await inspect(tar);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
