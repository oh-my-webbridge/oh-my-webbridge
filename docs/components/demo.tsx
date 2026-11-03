import { assetPath } from "@/lib/shared";

// Every clip is rendered on the same 1600 x 1160 canvas (scripts/media/compose.mjs),
// so the page reserves its space before the file loads.
const size = { width: 1600, height: 1160 };

/**
 * A recorded demo from `public/media`: `name.mp4` with its `name.png` poster, or
 * `name.png` alone when `still` is set. Videos are muted and loop inline.
 */
export function Demo({ name, alt, still = false }: { name: string; alt: string; still?: boolean }) {
  const poster = assetPath(`/media/${name}.png`);
  if (still) return <img alt={alt} className="omw-media" src={poster} {...size} />;
  return (
    <video
      aria-label={alt}
      autoPlay
      className="omw-media"
      loop
      muted
      playsInline
      poster={poster}
      preload="metadata"
      src={assetPath(`/media/${name}.mp4`)}
      {...size}
    />
  );
}
