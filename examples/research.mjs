import { connect } from "../dist/sdk.mjs";

const tasks = [
  { session: "chrome-docs", url: "https://developer.chrome.com/docs/extensions/" },
  { session: "go-docs", url: "https://go.dev/doc/" },
];
const results = await Promise.all(
  tasks.map(async ({ session, url }) => {
    const task = await connect(session);
    await task.navigate(url);
    const page = await task.evaluate("({title:document.title,url:location.href})");
    return { session, ...page };
  }),
);
console.log(JSON.stringify(results));
// Keep task tabs visible for review. Close explicitly when requested:
// await (await connect("chrome-docs")).close();
