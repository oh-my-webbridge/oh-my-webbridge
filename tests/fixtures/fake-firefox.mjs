// Stand-in for FIREFOX_BIN in tests of scripts/firefox-bidi.mjs: prints the
// WebDriver BiDi banner and serves one BiDi session. "slow" answers after
// params.delayMs, "echo" answers with its params, and browser.close exits.
import { WebSocketServer } from "ws";

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
server.on("listening", () => {
  process.stderr.write(`WebDriver BiDi listening on ws://127.0.0.1:${server.address().port}\n`);
});
server.on("connection", (socket) => {
  socket.on("message", (data) => {
    const { id, method, params } = JSON.parse(String(data));
    const reply = (result) => socket.send(JSON.stringify({ id, type: "success", result }));
    if (method === "session.new")
      reply({ sessionId: "fake", capabilities: { browserVersion: "0.0-fake" } });
    else if (method === "slow") setTimeout(() => reply({}), params.delayMs);
    else if (method === "echo") reply(params);
    else if (method === "browser.close") {
      reply({});
      setTimeout(() => process.exit(0), 50);
    } else
      socket.send(JSON.stringify({ id, type: "error", error: "unknown command", message: method }));
  });
});
