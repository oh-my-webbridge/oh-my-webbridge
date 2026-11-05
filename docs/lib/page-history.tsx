import type { TOCItemType } from "fumadocs-core/toc";
import type { HistoryCommit } from "fumadocs-page-history";
import { createHistoryReader } from "fumadocs-page-history/git";
import { GitChangelogLabel } from "fumadocs-page-history/ui";
import { repository, repositoryUrl } from "./shared";

/** Anchors of the two sections, shared by `GitChangelog` and the table of contents. */
export const PAGE_HISTORY_IDS = {
  contributors: "git-contributors",
  history: "git-history",
} as const;

/** The static export renders every page in one build; one reader reads the repository once. */
const history = createHistoryReader({ repository: { url: repositoryUrl } });

/**
 * Commits of a page source file, read from Git at build time; the build needs the full history.
 * A page without commits yet returns an empty list and shows its last update time instead.
 */
export async function readPageHistory(path: string): Promise<HistoryCommit[]> {
  return history.read(`${repository.contentDir}/${path}`);
}

/** "Contributors" and "Page history" at the end of the table of contents, in the site language. */
export const pageHistoryToc: TOCItemType[] = [
  {
    title: <GitChangelogLabel section="contributors" />,
    url: `#${PAGE_HISTORY_IDS.contributors}`,
    depth: 2,
  },
  {
    title: <GitChangelogLabel section="history" />,
    url: `#${PAGE_HISTORY_IDS.history}`,
    depth: 2,
  },
];
