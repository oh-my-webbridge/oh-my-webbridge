import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [logPath, ...assignments] = process.argv.slice(2);
const scenarios = new Map();
for (const spec of assignments) {
  const [run, scenario] = spec.split("=");
  if (
    !/^[a-z0-9-]+$/.test(run) ||
    scenarios.has(run) ||
    !["archive", "loading", "receipt", "unknown"].includes(scenario)
  ) {
    throw Error("Assign a unique session to each scenario: session=scenario");
  }
  scenarios.set(run, scenario);
}
if (!logPath || !scenarios.size) throw Error("Supply a new log path and session=scenario pairs");
writeFileSync(logPath, "", { flag: "wx" });
const writes = new Map();
const secret = randomBytes(32);
const server = createServer((req, res) => {
  const match = /^\/([a-z0-9-]+)\/([a-z-]*)$/.exec(req.url);
  const run = match?.[1];
  const page = match?.[2];
  const scenario = scenarios.get(run);
  if (!scenario) return res.writeHead(404).end();
  const digest = createHmac("sha256", secret).update(run).digest();
  const reference = digest.toString("hex", 0, 5).toUpperCase();
  const amount = (200 + digest.readUInt16BE(5) / 100).toFixed(2);
  const log = (event, extra = {}) =>
    appendFileSync(
      logPath,
      JSON.stringify({ run, scenario, event, at: Date.now(), ...extra }) + "\n",
    );
  const html = (body) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(
      `<!doctype html><html lang="en"><title>North Quay billing</title><main>${body}</main></html>`,
    );
  };
  const detail = () => {
    log("evidence", { reference, amount });
    html(
      `<h1>North Quay Press · April</h1><p>Posted · current revision</p><p>Reference: ${reference}</p><p>Outstanding: USD ${amount}</p>`,
    );
  };
  const order = scenario === "receipt" || scenario === "unknown";
  if (order && page === "submit" && req.method === "POST") {
    const count = (writes.get(run) ?? 0) + 1;
    writes.set(run, count);
    log("write", { count });
    res.writeHead(303, { Location: "confirmation" }).end();
    return;
  }
  if (req.method !== "GET") return res.writeHead(405).end();
  if (scenario === "archive" && page === "") {
    log("fault");
    return html(
      '<h1>North Quay Press · April</h1><p>Superseded · revision 1</p><p>Reference: AP-1408</p><p>Outstanding: USD 185.40</p><a href="register">Billing register</a>',
    );
  }
  if (scenario === "archive" && page === "register") {
    log("register");
    return html(
      '<h1>Billing register</h1><ul><li>March · Posted <a href="march">Details</a></li><li>April · Posted <a href="posted">Details</a></li></ul>',
    );
  }
  if (scenario === "archive" && page === "march") {
    log("wrong-month");
    return html(
      '<h1>North Quay Press · March</h1><p>Reference: MA-407</p><p>Outstanding: USD 768.30</p><a href="register">Billing register</a>',
    );
  }
  if (scenario === "loading" && page === "") {
    log("fault");
    return html(
      '<h1>North Quay Press · April</h1><p>Preliminary · Loading posted balance…</p><p>Reference: AP-1408</p><p>Outstanding: USD 185.40</p><script>setTimeout(() => location.replace("posted"), 4500)</script>',
    );
  }
  if (!order && page === "posted") return detail();
  if (order && page === "") {
    log("start");
    return html(
      '<h1>Statement copy for April</h1><form method="post" action="submit"><button>Request copy</button></form><a href="history">Request history</a>',
    );
  }
  if (order && page === "confirmation" && writes.has(run)) {
    log("fault");
    return html(
      '<h1>Confirmation unavailable</h1><p>The confirmation service could not return a receipt.</p><form method="post" action="submit"><button>Try again</button></form><a href="history">Request history</a>',
    );
  }
  if (order && page === "history") {
    if (!writes.has(run))
      return html('<h1>Request history</h1><p>No recent entries</p><a href="./">Request form</a>');
    if (scenario === "unknown") {
      log("unavailable");
      return html("<h1>Request history unavailable</h1><p>The statement register is offline.</p>");
    }
    log("evidence", { reference });
    return html(
      `<h1>Request history</h1><p>April statement copy · Received · Receipt ${reference}</p>`,
    );
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
