// Package docs embeds the English Markdown references from this release.
package docs

import "embed"

//go:embed firefox.mdx presets.mdx sessions.mdx reference/actions.mdx reference/cdp.mdx reference/cli.mdx reference/sdk.mdx
var References embed.FS
