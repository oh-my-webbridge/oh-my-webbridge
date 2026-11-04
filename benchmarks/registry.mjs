export const registry = [
  { name: "oh-my-webbridge", interface: "HTTP + MV3", version: "workspace", automatic: true },
  { name: "playwright", interface: "Node library / CDP", version: "1.64.1", automatic: true },
  { name: "puppeteer", interface: "Node library / CDP", version: "25.16.0", automatic: true },
  { name: "agent-browser", interface: "native CLI / CDP", version: "0.40.0", automatic: true },
  {
    name: "playwright-mcp",
    interface: "MCP stdio / CDP",
    version: "package-lock",
    automatic: true,
  },
  {
    name: "chrome-devtools-mcp",
    interface: "MCP stdio / CDP",
    version: "package-lock",
    automatic: true,
  },
  {
    name: "pi-chrome-use",
    interface: "Pi execution core / CDP (no model)",
    version: "1.1.1",
    automatic: true,
  },
  {
    name: "selenium",
    interface: "WebDriver / attached Chrome",
    version: "4.52.0",
    automatic: true,
  },
  {
    name: "open-browser-use",
    interface: "released MCP + native host / CDP backend",
    version: "0.1.12",
    automatic: true,
  },
  {
    name: "chrome-headless-new",
    interface: "Chrome CLI --headless=new + raw CDP",
    version: "current stable CFT",
    automatic: true,
  },
  {
    name: "codex-chrome-extension",
    interface: "official ChatGPT Chrome extension from Codex",
    version: "client-managed",
    automatic: false,
    reason:
      "Requires a signed-in supported OpenAI client and interactive browser permissions. No documented standalone benchmark endpoint. Manual end-to-end runs must include client/model and approval time.",
    source: "https://learn.chatgpt.com/docs/chrome-extension",
  },
];
