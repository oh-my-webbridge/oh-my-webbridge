// Orders the prompt suggestions that the popup shows in turn for the active
// tab. Rules read the domain and path, the title and the signals that the popup
// reads from the page.
import type { Language } from "@ext/i18n.ts";
import type { PageSignals } from "@/lib/page-signals";

// Offered on every page, after the suggestions that fit the page.
const everyPage = [
  "summarize",
  "research",
  "form",
  "extract",
  "screenshot",
  "pdf",
  "links",
] as const;
// Offered only when their rule matches. On a tie, the earlier name comes first.
const pageOnly = [
  "selection",
  "review",
  "thread",
  "repo",
  "paper",
  "product",
  "recipe",
  "job",
  "inbox",
  "video",
  "debug",
  "translate",
  "docs",
  "code",
  "images",
] as const;
const ranked = [...pageOnly, ...everyPage];

export type SuggestionName = (typeof ranked)[number];
export type Page = {
  url: string;
  title: string;
  signals: PageSignals | undefined;
  language: Language;
};

// At most this many suggestions are picked for the page.
const maxFits = 5;

type Facts = {
  host: string;
  path: string;
  query: URLSearchParams;
  title: string;
  signals: PageSignals;
  language: Language;
};

// A page that the popup cannot read has no signals.
const unread: PageSignals = {
  lang: "",
  tables: 0,
  fields: 0,
  code: 0,
  videos: 0,
  images: 0,
  articles: 0,
  text: 0,
  selection: 0,
  search: false,
  citation: false,
  types: [],
};

const on = (host: string, ...domains: string[]): boolean =>
  domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
const primary = (tag: string): string => tag.toLowerCase().split(/[-_]/u)[0] ?? "";
const searchEngine = /(^|\.)(google|bing|duckduckgo|baidu|sogou|kagi|yandex)\.[a-z.]+$/u;
const ownerRepo = /^\/[^/]+\/[^/]+\/?$/u;

// Each rule rates how well a suggestion fits: 0 does not fit, a higher number
// fits better.
const rules: Record<SuggestionName, (page: Facts) => number> = {
  selection: ({ signals }) => (signals.selection >= 20 ? 6 : 0),
  review: ({ host, path }) =>
    (on(host, "github.com") && /^\/[^/]+\/[^/]+\/pull\/\d+/u.test(path)) ||
    (on(host, "gitlab.com") && /\/-\/merge_requests\/\d+/u.test(path))
      ? 5
      : 0,
  thread: ({ host, path }) =>
    (on(host, "github.com") && /^\/[^/]+\/[^/]+\/(issues|discussions)\/\d+/u.test(path)) ||
    (on(host, "reddit.com") && path.includes("/comments/")) ||
    (host === "news.ycombinator.com" && path === "/item") ||
    (on(host, "stackoverflow.com", "stackexchange.com", "superuser.com", "serverfault.com") &&
      /^\/questions\/\d+/u.test(path)) ||
    (on(host, "x.com", "twitter.com") && /\/status\/\d+/u.test(path)) ||
    (on(host, "v2ex.com") && path.startsWith("/t/")) ||
    (on(host, "zhihu.com") && path.startsWith("/question/"))
      ? 5
      : 0,
  // A repository front page shows its README in an article.
  repo: ({ host, path, signals }) =>
    on(host, "github.com", "gitlab.com", "codeberg.org") &&
    ownerRepo.test(path) &&
    signals.articles > 0
      ? 4
      : 0,
  paper: ({ host, path, signals }) =>
    (on(host, "arxiv.org") && /^\/(abs|pdf|html)\//u.test(path)) ||
    on(host, "openreview.net") ||
    signals.citation
      ? 5
      : 0,
  product: ({ host, path, signals }) =>
    signals.types.includes("product") ||
    (/(^|\.)amazon\./u.test(host) && /\/(dp|gp\/product)\//u.test(path)) ||
    (on(host, "ebay.com") && path.startsWith("/itm/")) ||
    on(host, "item.taobao.com", "detail.tmall.com", "item.jd.com")
      ? 5
      : 0,
  recipe: ({ signals }) => (signals.types.includes("recipe") ? 5 : 0),
  job: ({ signals }) => (signals.types.includes("jobposting") ? 5 : 0),
  inbox: ({ host }) =>
    on(
      host,
      "mail.google.com",
      "outlook.live.com",
      "outlook.office.com",
      "outlook.office365.com",
      "mail.qq.com",
    )
      ? 5
      : 0,
  video: ({ host, path, signals }) => {
    if (
      (on(host, "youtube.com") && path === "/watch") ||
      on(host, "youtu.be") ||
      (on(host, "bilibili.com") && path.startsWith("/video/")) ||
      (on(host, "vimeo.com") && /^\/\d+/u.test(path))
    )
      return 5;
    return signals.videos > 0 ? 3 : 0;
  },
  // Error pages are short and name the status in the title.
  debug: ({ title, signals }) =>
    signals.text < 3000 && /\b[45]\d\d\b|not found|server error|找不到|不存在/iu.test(title)
      ? 4
      : 0,
  translate: ({ signals, language }) =>
    signals.lang && primary(signals.lang) !== primary(language) ? 4 : 0,
  docs: ({ host, path, title }) =>
    /^(docs|developer|devdocs)\./u.test(host) ||
    host.includes("readthedocs") ||
    /\/(docs?|reference|api)(\/|$)/u.test(path) ||
    /\b(docs|documentation|api reference)\b|說明文件|文档|手冊|手册/iu.test(title)
      ? 3
      : 0,
  code: ({ signals }) => (signals.code >= 2 ? 3 : 0),
  images: ({ signals }) => (signals.images >= 12 ? 2 : 0),
  summarize: ({ signals }) =>
    signals.articles > 0 ||
    signals.text >= 5000 ||
    ["article", "newsarticle", "blogposting"].some((type) => signals.types.includes(type))
      ? 2
      : 0,
  research: ({ host, query, path, signals }) => {
    if (searchEngine.test(host) && ["q", "wd", "query", "text", "p"].some((key) => query.has(key)))
      return 4;
    return signals.search && path.includes("search") ? 2 : 0;
  },
  extract: ({ signals }) => (signals.tables > 0 ? 3 : 0),
  form: ({ signals }) => (signals.fields >= 2 ? 3 : 0),
  screenshot: () => 0,
  pdf: () => 0,
  links: () => 0,
};

// The suggestions that fit the page, best first, then the ones for every page.
export function suggest(page: Page): SuggestionName[] {
  const url = URL.parse(page.url);
  const facts: Facts = {
    host: url?.hostname.replace(/^www\./u, "") ?? "",
    path: url?.pathname ?? "",
    query: url?.searchParams ?? new URLSearchParams(),
    title: page.title,
    signals: page.signals ?? unread,
    language: page.language,
  };
  const fits = ranked
    .map((name, order) => ({ name, order, score: rules[name](facts) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, maxFits)
    .map(({ name }) => name);
  return [...fits, ...everyPage.filter((name) => !fits.includes(name))];
}
