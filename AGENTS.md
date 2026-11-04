# Working on oh-my-webbridge

Keep the runtime a small local Go daemon and an MV3 worker. Browser behavior belongs to an owned task tab, never an unrelated user tab. Bound queues and buffers, expose fallback states and do not replay browser side effects after an uncertain outcome.

Every change to what users install or run includes a `.changeset/*.md` fragment in the same PR. Tests and internal docs can omit one unless they affect published artifacts. Follow `.changeset/README.md`; use user-facing headings and add the PR link after the PR exists. Release notes come from fragments, not commit messages.

Run `pnpm run check`, `pnpm run format:check`, `pnpm test`, `go test -race ./...`, `go vet ./...`, and `pnpm run release:check`. Browser changes additionally run the real Chrome suite in CI. Retain failed or unavailable benchmark cases and distinguish interface timing from engine or agent quality.

Use Conventional Commits and explain behavior, evidence and remaining gaps in PR bodies. Keep already-pushed commit history; add follow-up commits when review or checks find an issue.
