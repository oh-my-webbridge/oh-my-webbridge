"use client";

import { ImageZoom } from "fumadocs-ui/components/image-zoom";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { isLocale } from "@/lib/i18n";
import { mediaFile, type MediaName } from "@/lib/media";
import { assetPath } from "@/lib/shared";

// Every clip is rendered on the same 1600 x 1160 canvas (scripts/media/compose.mjs),
// so the page reserves its space before the file loads.
const size = { width: 1600, height: 1160 };

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const reducedMotionNow = () => window.matchMedia(REDUCED_MOTION).matches;
/** The server renders the reduced-motion form: poster and controls; the client then decides. */
const reducedMotionOnServer = () => true;

/** An interrupted play (the element left the document, or a pause followed) is normal. */
function playQuietly(video: HTMLVideoElement): void {
  video.play().catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    throw error;
  });
}

/**
 * A recorded demo from `public/media` in the page language: `name.mp4` with its `name.png`
 * poster, or `name.png` alone when `still` is set. Videos are muted and loop; they play while
 * on screen. With reduced motion they do not autoplay and show their controls.
 */
export function Demo({
  name,
  alt,
  still = false,
}: {
  name: MediaName;
  alt: string;
  still?: boolean;
}) {
  const { locale } = useI18n();
  if (locale === undefined || !isLocale(locale)) {
    throw new Error(`<Demo name="${name}"> renders outside a docs language`);
  }
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    reducedMotionNow,
    reducedMotionOnServer,
  );
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (element === null || reducedMotion) return undefined;
    const observer = new IntersectionObserver(
      ([visible]) => {
        if (visible?.isIntersecting === true) playQuietly(element);
        else element.pause();
      },
      { threshold: 0.4 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      element.pause();
    };
  }, [reducedMotion]);

  const file = mediaFile(name, locale);
  const poster = assetPath(`/media/${file}.png`);
  if (still) {
    return <ImageZoom alt={alt} className="omw-media" src={poster} {...size} />;
  }
  return (
    <video
      ref={video}
      aria-label={alt}
      className="omw-media"
      controls={reducedMotion}
      loop
      muted
      playsInline
      poster={poster}
      preload="metadata"
      src={assetPath(`/media/${file}.mp4`)}
      {...size}
    />
  );
}
