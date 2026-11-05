/**
 * The dark palette of the link preview images from design.md. The image renderer reads no CSS
 * variables, so the colors are literals that match the dark rail colors of packages/brand/theme.css.
 */
export const ogPalette = {
  background: "#15181d",
  backgroundDeep: "#0b0d11",
  foreground: "#ffffff",
  muted: "#9aa1ac",
  divider: "rgba(255, 255, 255, 0.12)",
  figure: "rgba(255, 255, 255, 0.05)",
  tile: "#101318",
  signal: "#ffb020",
} as const;
