// Generates the zh-CN, zh-HK and zh-MO text from the zh-TW source with OpenCC,
// for the extension (extension/locales), the docs pages (docs/content/docs) and
// the docs interface text (docs/messages), and writes the manifest strings in
// extension/_locales. Edit en and zh-TW only.
// Generated files are formatted with the repository oxfmt settings. With
// --check, nothing is written and the command fails if a generated file
// differs from the source.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import OpenCC from "opencc-js";
import { format } from "oxfmt";

const check = process.argv.includes("--check");
const {
  $schema: _schema,
  ignorePatterns: _ignored,
  ...formatOptions
} = JSON.parse(await readFile(".oxfmtrc.json", "utf8"));

// Taiwan phrases become Mainland phrases (twp); Hong Kong and Macau keep the
// Taiwan wording and change only character variants. OpenCC has no Macau
// standard, so zh-MO uses the Hong Kong variants.
const phrases = OpenCC.Converter({ from: "twp", to: "cn" });
const variants = OpenCC.Converter({ from: "tw", to: "hk" });
// Mainland software terms that the OpenCC phrase tables do not produce, and
// Mainland quotation marks. The longest entry matches first, so "预设集"
// (preset) wins over "预设" (default).
const mainland = OpenCC.CustomConverter([
  ["分页", "标签页"],
  ["群组", "分组"],
  ["工作阶段", "会话"],
  ["拷贝", "复制"],
  ["卷动", "滚动"],
  ["截取屏幕截屏", "截图"],
  ["屏幕截屏", "屏幕截图"],
  ["截取", "提取"],
  ["说明文档", "文档"],
  ["设置档", "个人资料"],
  ["终端机", "终端"],
  ["十六进位", "十六进制"],
  ["二进位档", "二进制文件"],
  ["扩充功能", "扩展程序"],
  ["保存库", "仓库"],
  ["范例", "示例"],
  ["送出", "发送"],
  ["透过", "通过"],
  ["回传", "返回"],
  ["预设集", "预设"],
  ["预设", "默认"],
  ["主控台", "控制台"],
  ["协定", "协议"],
  ["参照", "引用"],
  ["工具列", "工具栏"],
  ["导览", "导航"],
  ["程式", "程序"],
  ["记录档", "日志文件"],
  ["讯框", "帧"],
  ["组态档", "配置文件"],
  ["组态", "配置"],
  ["封锁", "拦截"],
  ["作用中", "当前"],
  ["逾时", "超时"],
  ["回送地址", "回环地址"],
  ["回送位址", "回环地址"],
  ["建置", "构建"],
  ["发行版本", "发布版本"],
  ["发行", "发布"],
  ["指令", "命令"],
  ["用户端", "客户端"],
  ["网域", "域名"],
  ["回应", "响应"],
  ["运作", "运行"],
  ["锁定档", "锁文件"],
  ["旧档", "旧文件"],
  ["印出", "输出"],
  ["帐号", "账号"],
  ["收件匣", "收件箱"],
  ["职缺", "职位"],
  ["应征", "应聘"],
  ["於", "于"],
  ["「", "“"],
  ["」", "”"],
  ["『", "‘"],
  ["』", "’"],
]);
const targets = {
  "zh-CN": (text) => mainland(phrases(text)),
  "zh-HK": variants,
  "zh-MO": variants,
};

const stale = [];
async function output(path, text) {
  const { code: content, errors } = await format(path, text, formatOptions);
  if (errors.length > 0)
    throw new Error(`${path}: ${errors.map((error) => error.message).join("; ")}`);
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === content) return;
  if (check) {
    stale.push(path);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  console.log(`wrote ${path}`);
}
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const placeholders = (text) =>
  [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort((a, b) => a.localeCompare(b));

// Extension catalogs: the zh-TW catalog has the keys and placeholders of en.
const locales = "extension/locales";
const en = JSON.parse(await readFile(join(locales, "en.json"), "utf8"));
const zhTW = JSON.parse(await readFile(join(locales, "zh-TW.json"), "utf8"));
for (const key of new Set([...Object.keys(en), ...Object.keys(zhTW)])) {
  if (!(key in en) || !(key in zhTW))
    throw new Error(`${key} must be in both en.json and zh-TW.json`);
  if (placeholders(en[key]).join() !== placeholders(zhTW[key]).join())
    throw new Error(`${key}: zh-TW.json must use the placeholders of en.json`);
}
const catalogs = { en, "zh-TW": zhTW };
for (const [language, convert] of Object.entries(targets)) {
  catalogs[language] = Object.fromEntries(
    Object.entries(zhTW).map(([key, text]) => [key, convert(text)]),
  );
  await output(join(locales, `${language}.json`), json(catalogs[language]));
}
// The manifest name and description, for the locales that Chrome and Firefox
// both accept.
for (const [folder, language] of [
  ["en", "en"],
  ["zh_TW", "zh-TW"],
  ["zh_CN", "zh-CN"],
]) {
  const { extensionName, extensionDescription } = catalogs[language];
  await output(
    join("extension/_locales", folder, "messages.json"),
    json({
      extensionName: { message: extensionName },
      extensionDescription: { message: extensionDescription },
    }),
  );
}

// Docs pages, folder metadata and interface text: page.zh-tw.mdx becomes
// page.zh-cn.mdx and so on.
const notice = (file) =>
  `{/* Generated from ${file} by scripts/i18n.mjs. Edit the zh-TW page instead. */}\n`;
for (const dir of ["docs/content/docs", "docs/messages"]) {
  for (const file of (await readdir(dir, { recursive: true })).sort()) {
    const match = /^(.*)\.zh-tw\.(mdx|json)$/u.exec(file);
    if (!match) continue;
    const [, stem, extension] = match;
    const source = await readFile(join(dir, file), "utf8");
    for (const [language, convert] of Object.entries(targets)) {
      let content = convert(source);
      if (extension === "mdx") {
        // The notice goes right after the frontmatter, where MDX allows comments.
        const end = content.indexOf("\n---\n", 4) + 5;
        content = `${content.slice(0, end)}\n${notice(file.split("/").at(-1))}${content.slice(end)}`;
      }
      await output(join(dir, `${stem}.${language.toLowerCase()}.${extension}`), content);
    }
  }
}

if (stale.length) {
  console.error(`Run pnpm run i18n to update:\n${stale.join("\n")}`);
  process.exit(1);
}
