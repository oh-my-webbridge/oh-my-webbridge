import type { Locale } from "./i18n";

/**
 * Recordings in `public/media` (`scripts/media/record.mjs`). Every scene exists with the English
 * interface as `<name>.mp4` and `<name>.png`. Scenes that show extension text, including the
 * action labels of the activity layer, also exist with the Traditional and Simplified Chinese
 * interface as `<name>.zh-tw.*` and `<name>.zh-cn.*`.
 */
export const media = {
  "activity-form": { translated: true },
  "activity-read": { translated: true },
  popup: { translated: true },
  presets: { translated: false },
  "presets-none": { translated: false },
  settings: { translated: true },
  setup: { translated: true },
} as const satisfies Record<string, { translated: boolean }>;

export type MediaName = keyof typeof media;

/** The interface language of the recordings for a docs language. */
const recordingLanguage = {
  en: undefined,
  "zh-tw": "zh-tw",
  "zh-hk": "zh-tw",
  "zh-mo": "zh-tw",
  "zh-cn": "zh-cn",
} as const satisfies Record<Locale, string | undefined>;

/** The file name without extension for a scene shown on a page in `locale`. */
export function mediaFile(name: MediaName, locale: Locale): string {
  const language = recordingLanguage[locale];
  return media[name].translated && language !== undefined ? `${name}.${language}` : name;
}
