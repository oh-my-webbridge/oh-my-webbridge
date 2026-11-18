import { expired, fail, fault, type Args, type Budget, type Fault } from "./protocol.js";
import { closedTab, leaveTab, ownerSession, persist, type Session } from "./state.js";

export async function releaseTabs(
  session: Session,
  args: Args,
  budget: Budget,
  releasePage: (id: number, check: () => void) => Promise<void>,
  closedId: (error: Error) => number | undefined,
) {
  const { keep = [], close = [] } = args;
  if (![keep, close].every(Array.isArray)) fail("invalid_args", "keep and close must be arrays");
  const ids = [...keep, ...close];
  if (
    !ids.length ||
    ids.length > 32 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    fail("invalid_args", "select 1–32 distinct tab IDs across keep and close");
  if (close.some((id) => session.borrowed.includes(id)))
    fail("borrowed_tab", "borrowed tabs can only be kept and released");
  const closed: number[] = [];
  const kept: number[] = [];
  const released: number[] = [];
  const skipped: number[] = [];
  const failed: (Fault & { tabId: number })[] = [];
  for (const id of ids) {
    budget.check();
    if (!session.tabs.includes(id) && !session.borrowed.includes(id)) {
      skipped.push(id);
      continue;
    }
    const wasCurrent = session.current === id;
    // close_session can cancel this command and release the same tab while
    // the browser is answering. Check before operating on it again.
    const check = (): void => {
      budget.check();
      const currentOwner = ownerSession(id);
      if (!currentOwner) closedTab(id);
      if (currentOwner !== session) expired(`tab ${id} changed sessions`);
    };
    try {
      if (keep.includes(id)) {
        const tab = await chrome.tabs.get(id);
        check();
        if (
          session.tabs.includes(id) &&
          session.group !== undefined &&
          tab.groupId === session.group
        ) {
          await chrome.tabs.ungroup(id);
          check();
        }
        await releasePage(id, check);
        check();
        kept.push(id);
      } else {
        await chrome.tabs.remove(id);
        closed.push(id);
      }
    } catch (error) {
      budget.check();
      const failure = fault(error as Error);
      if (failure.code === "outcome_unknown") throw error;
      if (closedId(error as Error) === id || failure.code === "tab_missing") closed.push(id);
      else {
        failed.push({ tabId: id, ...failure });
        continue;
      }
    }
    leaveTab(session, id, wasCurrent);
    session.tabs = session.tabs.filter((tab) => tab !== id);
    session.borrowed = session.borrowed.filter((tab) => tab !== id);
    if (!session.tabs.length) session.group = undefined;
    await persist();
    released.push(id);
  }
  return { success: !failed.length, closed, kept, released, skipped, failed };
}
