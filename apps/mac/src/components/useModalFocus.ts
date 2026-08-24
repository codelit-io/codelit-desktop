import { useEffect, useRef, type KeyboardEvent } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useModalFocus(open: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const initial = dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")
        || dialogRef.current?.querySelector<HTMLElement>("input, textarea, button");
      initial?.focus();
      if (initial instanceof HTMLInputElement || initial instanceof HTMLTextAreaElement) initial.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      restoreRef.current?.focus();
      restoreRef.current = null;
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) || [])]
      .filter((element) => element.offsetParent !== null);
    if (!elements.length) {
      event.preventDefault();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return { dialogRef, onKeyDown };
}
