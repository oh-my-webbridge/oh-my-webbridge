import { ogPalette } from "./palette";

export interface OgPage {
  title: string;
  description: string | undefined;
  section: string | undefined;
  byline: string;
  host: string;
}

export const ogSize = { width: 1200, height: 630 };

const clamp = (lines: number) =>
  ({
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    lineClamp: lines,
  }) as const;

// Shapes of packages/brand/icons/mark.svg: a tile, a terminal window with a prompt, and the pointer
// keyed out of the window. Holes are painted in the tile color.
const tile =
  "M44 0H84C113.04 0 128 14.96 128 44V84C128 113.04 113.04 128 84 128H44C14.96 128 0 113.04 0 84V44C0 14.96 14.96 0 44 0Z";
const terminal =
  "M40 16H72C87.84 16 96 24.16 96 40V68C96 83.84 87.84 92 72 92H40C24.16 92 16 83.84 16 68V40C16 24.16 24.16 16 40 16Z";
const pointer =
  "M68.69 64.77L99.88 77.69A5 5 0 0 1 99.61 87.03L91.42 89.89A2.5 2.5 0 0 0 89.89 91.42L87.03 99.61A5 5 0 0 1 77.69 99.88L64.77 68.69A3 3 0 0 1 68.69 64.77Z";

/** The app mark: a terminal window with a prompt and an amber pointer on a dark tile. */
function BrandGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128">
      <path d={tile} fill={ogPalette.tile} stroke={ogPalette.divider} strokeWidth={2} />
      <g transform="matrix(.686 0 0 .686 24.212 24.898)">
        <path d={terminal} fill="#ffffff" />
        <path
          d="M33 37L40 44L33 51"
          fill="none"
          stroke={ogPalette.tile}
          strokeWidth={6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="49" y="48" width="12" height="6" rx="3" fill={ogPalette.tile} />
        <path
          d={pointer}
          fill="none"
          stroke={ogPalette.tile}
          strokeWidth={14}
          strokeLinejoin="round"
        />
        <path d={pointer} fill={ogPalette.signal} />
      </g>
    </svg>
  );
}

/** The pointer of the mark drawn large across the lower right corner, as a quiet background figure. */
function Figure() {
  return (
    <svg
      width={340}
      height={340}
      viewBox="63 63 38 38"
      style={{ position: "absolute", right: -20, bottom: -110 }}
    >
      <path d={pointer} fill={ogPalette.figure} />
    </svg>
  );
}

export function OgImage(page: OgPage) {
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        backgroundImage: `linear-gradient(160deg, ${ogPalette.background}, ${ogPalette.backgroundDeep})`,
        color: ogPalette.foreground,
      }}
    >
      <Figure />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "56px 64px 0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <BrandGlyph size={44} />
          <span style={{ fontSize: 30, fontWeight: 700 }}>oh-my-webbridge</span>
          <span style={{ fontSize: 24, color: ogPalette.muted }}>{page.byline}</span>
        </div>
        <span style={{ fontSize: 22, color: ogPalette.muted }}>{page.host}</span>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          flexGrow: 1,
          gap: 20,
          padding: "0 64px 64px",
          maxWidth: 1000,
        }}
      >
        {page.section && (
          <span style={{ fontSize: 24, lineHeight: 1.4, color: ogPalette.muted }}>
            {page.section}
          </span>
        )}
        <span
          style={{
            ...clamp(2),
            fontSize: 68,
            lineHeight: 1.12,
            fontWeight: 700,
            textWrap: "balance",
          }}
        >
          {page.title}
        </span>
        {page.description && (
          <span
            style={{
              ...clamp(2),
              fontSize: 30,
              lineHeight: 1.5,
              color: ogPalette.muted,
              textWrap: "pretty",
            }}
          >
            {page.description}
          </span>
        )}
      </div>
    </div>
  );
}
