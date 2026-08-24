import {
  CalendarClock,
  ChevronRight,
  Cloud,
  Globe2,
  Radio,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  DesktopCloudCapability,
  DesktopCloudCapabilityId,
  DesktopCloudStatus,
  LocalArtifactVersion,
} from "../contracts";

const ACTIONS: Record<DesktopCloudCapabilityId, {
  title: string;
  detail: string;
  icon: typeof Cloud;
}> = {
  "run-24-7": {
    title: "Run 24/7",
    detail: "Keep this Team working when this Mac is asleep.",
    icon: CalendarClock,
  },
  "cloud-browser": {
    title: "Cloud browser",
    detail: "Use a managed browser without keeping this Mac awake.",
    icon: Globe2,
  },
  "public-trigger": {
    title: "Public trigger",
    detail: "Start this Team from a webhook or remote event.",
    icon: Radio,
  },
  collaboration: {
    title: "Share workspace",
    detail: "Invite teammates to a reviewed cloud copy.",
    icon: Users,
  },
};

function availableActions(kind: LocalArtifactVersion["kind"], hasBrowser: boolean) {
  if (kind !== "agent-team") return ["collaboration"] as DesktopCloudCapabilityId[];
  return [
    "run-24-7",
    ...(hasBrowser ? ["cloud-browser" as const] : []),
    "public-trigger",
    "collaboration",
  ] as DesktopCloudCapabilityId[];
}

function capabilityStatus(
  capability: DesktopCloudCapability | undefined,
  cloudStatus: DesktopCloudStatus | null,
) {
  if (cloudStatus?.status !== "connected") return "Optional sign in";
  if (!capability) return "Check availability";
  if (capability.available) return "Included";
  return `${capability.requiredPlan === "max" ? "Max" : "Pro"} required`;
}

export default function HostedCapabilityMenu({
  artifactKind,
  hasBrowser,
  cloudStatus,
  capabilities,
  onSelect,
}: {
  artifactKind: LocalArtifactVersion["kind"];
  hasBrowser: boolean;
  cloudStatus: DesktopCloudStatus | null;
  capabilities: DesktopCloudCapability[];
  onSelect: (capability: DesktopCloudCapabilityId) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeFromPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeFromPointer);
    window.addEventListener("keydown", closeFromKeyboard);
    return () => {
      window.removeEventListener("pointerdown", closeFromPointer);
      window.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  return (
    <div className="hosted-capability-menu" ref={rootRef}>
      <button
        className="icon-button"
        onClick={() => setOpen((current) => !current)}
        aria-label={open ? "Close Codelit Cloud options" : "Open Codelit Cloud options"}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Codelit Cloud options"
      >
        <Cloud size={18} />
      </button>
      {open && (
        <div className="hosted-capability-popover" role="menu" aria-label="Codelit Cloud options">
          <header>
            <span>Codelit Cloud</span>
            <small>Local work stays here until you review a copy.</small>
          </header>
          {availableActions(artifactKind, hasBrowser).map((id) => {
            const action = ACTIONS[id];
            const capability = capabilities.find((candidate) => candidate.id === id);
            const Icon = action.icon;
            return (
              <button
                key={id}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onSelect(id);
                }}
              >
                <Icon size={16} />
                <span>
                  <strong>{action.title}</strong>
                  <small>{action.detail}</small>
                </span>
                <em>{capabilityStatus(capability, cloudStatus)}</em>
                <ChevronRight size={14} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
