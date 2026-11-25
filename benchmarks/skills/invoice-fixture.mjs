import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

const [visits] = process.argv.slice(2);
if (!visits) throw Error("Supply a new private visit log path");
const key = randomBytes(32);
const vendors = ["Elm Bindery", "North Quay Press", "North Quay Press"];
const months = ["April", "March", "April"];
const server = createServer((req, res) => {
  const match = /^\/([a-z0-9-]+)\/(?:invoice\/([0-2]))?$/u.exec(req.url);
  if (req.method !== "GET" || !match) {
    res.writeHead(404).end();
    return;
  }
  const [, run, index] = match;
  const digest = createHmac("sha256", key).update(`${run}/${index}`).digest();
  const reference = digest.toString("hex", 0, 5).toUpperCase();
  const outstanding = (100 + digest.readUInt16BE(5) / 100).toFixed(2);
  const rows = vendors.map(
    (vendor, i) => `<li>${vendor} · ${months[i]} <a href="invoice/${i}">View invoice</a></li>`,
  );
  const body =
    index === undefined
      ? `<h1>Invoices</h1><ul>${rows.join("")}</ul>`
      : `<h1>${vendors[index]} · ${months[index]}</h1><p>Reference: ${reference}</p><p>Outstanding: USD ${outstanding}</p>`;
  appendFileSync(
    visits,
    JSON.stringify({
      run,
      index: index ?? null,
      at: Date.now(),
      ...(index === "2" ? { reference, outstanding } : {}),
    }) + "\n",
  );
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(
    `<!doctype html><html lang="en"><title>Invoice register</title><main>${body}</main></html>`,
  );
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
