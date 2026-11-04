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

/** The app mark: a rounded tile with a white arc between two piers. */
function BrandGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128">
      <defs>
        <linearGradient id="og-tile" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={ogPalette.tileLight} />
          <stop offset="1" stopColor={ogPalette.tile} />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="28" fill="url(#og-tile)" />
      <path
        d="M30 76 Q64 18 98 76"
        fill="none"
        stroke="#ffffff"
        strokeWidth={10}
        strokeLinecap="round"
      />
      <circle cx="30" cy="78" r="11" fill="#ffffff" />
      <circle cx="98" cy="78" r="11" fill="#ffffff" />
    </svg>
  );
}

/** The arc of the mark drawn large across the lower right corner, as a quiet background figure. */
function Arc() {
  return (
    <svg
      width={760}
      height={420}
      viewBox="0 0 760 420"
      style={{ position: "absolute", right: -40, bottom: -150 }}
    >
      <path
        d="M60 380 Q380 -100 700 380"
        fill="none"
        stroke={ogPalette.divider}
        strokeWidth={26}
        strokeLinecap="round"
      />
      <circle cx="60" cy="384" r="34" fill={ogPalette.divider} />
      <circle cx="700" cy="384" r="34" fill={ogPalette.divider} />
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
      <Arc />
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
