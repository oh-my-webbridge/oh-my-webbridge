import { createHash } from "node:crypto";
export function verifyReleaseAssets(assets, manifest, expectedNames) {
  const names = assets.map((a) => a.name).sort((a, b) => a.localeCompare(b));
  if (new Set(names).size !== names.length || assets.some((a) => a.state !== "uploaded"))
    throw Error("release asset set is incomplete");
  const sums = [];
  for (const line of manifest.trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  ([a-zA-Z0-9._-]+)$/u);
    if (!match || match[2] === "SHA256SUMS" || sums.some(([, name]) => name === match[2]))
      throw Error("invalid release checksum manifest");
    const [, hash, name] = match;
    if (assets.find((a) => a.name === name)?.digest !== `sha256:${hash}`)
      throw Error(`uploaded digest mismatch: ${name}`);
    sums.push([hash, name]);
  }
  const listed = [...sums.map(([, name]) => name), "SHA256SUMS"].sort((a, b) => a.localeCompare(b));
  if (
    JSON.stringify(listed) !== JSON.stringify(names) ||
    (expectedNames &&
      JSON.stringify([...expectedNames].sort((a, b) => a.localeCompare(b))) !==
        JSON.stringify(names))
  )
    throw Error("release asset set differs from checksum manifest");
  if (
    assets.find((a) => a.name === "SHA256SUMS")?.digest !==
    `sha256:${createHash("sha256").update(manifest).digest("hex")}`
  )
    throw Error("checksum manifest digest mismatch");
  return sums.length;
}
