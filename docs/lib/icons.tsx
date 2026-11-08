import {
  BookOpen,
  Code,
  Globe,
  Layers,
  Lock,
  MousePointerClick,
  Network,
  Plug,
  Rocket,
  ShieldBan,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * Icons that frontmatter and meta.json may name with `icon:`. Only the listed lucide icons enter
 * the bundle; an unknown name fails the build.
 */
export const iconComponents = {
  BookOpen,
  Code,
  Globe,
  Layers,
  Lock,
  MousePointerClick,
  Network,
  Plug,
  Rocket,
  ShieldBan,
  Terminal,
  Wrench,
  Zap,
};

type IconName = keyof typeof iconComponents;

function isIconName(name: string): name is IconName {
  return Object.hasOwn(iconComponents, name);
}

export function resolveIcon(name: string | undefined): ReactNode {
  if (name === undefined) return undefined;
  if (!isIconName(name)) throw new Error(`Unknown icon "${name}"; add it to docs/lib/icons.tsx.`);
  const Icon = iconComponents[name];
  return <Icon />;
}
