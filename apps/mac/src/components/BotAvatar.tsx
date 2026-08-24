import {
  Flame,
  type LucideIcon,
  Mountain,
  Orbit,
  Sparkles,
  Waves,
  WandSparkles,
} from "lucide-react";
import type { BotAvatarPreset, BotAvatarSpec, LocalBotRecord } from "../contracts";

export const BOT_AVATAR_PRESETS: ReadonlyArray<{
  id: BotAvatarPreset;
  label: string;
}> = [
  { id: "spark", label: "Spark" },
  { id: "orbit", label: "Orbit" },
  { id: "mountain", label: "Summit" },
  { id: "ember", label: "Ember" },
  { id: "prism", label: "Prism" },
  { id: "wave", label: "Wave" },
];

const PRESET_ICONS: Record<BotAvatarPreset, LucideIcon> = {
  spark: Sparkles,
  orbit: Orbit,
  mountain: Mountain,
  ember: Flame,
  prism: WandSparkles,
  wave: Waves,
};

const PRESET_IDS = new Set<BotAvatarPreset>(BOT_AVATAR_PRESETS.map(({ id }) => id));

export function defaultBotAvatar(botId: string): BotAvatarSpec {
  let hash = 0;
  for (const character of botId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  const preset = BOT_AVATAR_PRESETS[Math.abs(hash) % BOT_AVATAR_PRESETS.length]?.id || "spark";
  return { kind: "preset", preset };
}

export function normalizeBotAvatar(value: unknown, botId: string): BotAvatarSpec {
  if (!value || typeof value !== "object") return defaultBotAvatar(botId);
  const avatar = value as Partial<BotAvatarSpec>;
  if (avatar.kind === "preset" && typeof avatar.preset === "string" && PRESET_IDS.has(avatar.preset as BotAvatarPreset)) {
    return { kind: "preset", preset: avatar.preset as BotAvatarPreset };
  }
  if (
    avatar.kind === "image"
    && typeof avatar.dataUrl === "string"
    && avatar.dataUrl.startsWith("data:image/png;base64,")
    && avatar.dataUrl.length <= 349_550
  ) {
    return { kind: "image", dataUrl: avatar.dataUrl };
  }
  return defaultBotAvatar(botId);
}

export function avatarForBot(bot: LocalBotRecord): BotAvatarSpec {
  return normalizeBotAvatar(bot.spec.appearance?.avatar, bot.id);
}

export default function BotAvatar({
  avatar,
  size = "medium",
  label,
}: {
  avatar: BotAvatarSpec;
  size?: "small" | "medium" | "large" | "hero";
  label?: string;
}) {
  const className = `bot-avatar bot-avatar-${size} bot-avatar-${avatar.kind === "preset" ? avatar.preset : "image"}`;
  if (avatar.kind === "image") {
    return (
      <span className={className} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
        {/* Local data URLs cannot use Next Image inside the standalone Tauri renderer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={avatar.dataUrl} alt="" draggable={false} />
      </span>
    );
  }
  const Icon = PRESET_ICONS[avatar.preset];
  return (
    <span className={className} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <Icon aria-hidden="true" />
    </span>
  );
}
