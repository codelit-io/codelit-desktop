import { useEffect, useRef, type KeyboardEvent } from "react";

const FOCUSABLE = "button,[href],input,select,textarea,summary,[tabindex]";

function focusableElements(dialog: HTMLElement | null) {
  return [...(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) || [])].filter((element) => {
    if (element.tabIndex < 0 || element.matches(":disabled") || element.closest("[inert], [hidden]")) return false;
    let ancestor = element.parentElement;
    while (ancestor) {
      if (ancestor.matches("details:not([open])") && !ancestor.querySelector(":scope > summary")?.contains(element)) return false;
      ancestor = ancestor.parentElement;
    }
    const { visibility } = window.getComputedStyle(element);
    return visibility !== "hidden" && visibility !== "collapse" && element.getClientRects().length > 0;
  });
}

function focusDialog(dialog: HTMLElement | null) {
  if (!dialog) return;
  if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
  dialog.focus();
}

export function useModalFocus(open: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const elements = focusableElements(dialogRef.current);
      const initial = elements.find((element) => element.hasAttribute("data-autofocus")) || elements[0];
      if (initial) initial.focus();
      else focusDialog(dialogRef.current);
      if (initial instanceof HTMLInputElement || initial instanceof HTMLTextAreaElement) initial.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const elements = focusableElements(dialogRef.current);
    if (!elements.length) {
      event.preventDefault();
      focusDialog(dialogRef.current);
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    const activeIsFocusable = elements.includes(document.activeElement as HTMLElement);
    if (event.shiftKey && (document.activeElement === first || !activeIsFocusable)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !activeIsFocusable)) {
      event.preventDefault();
      first.focus();
    }
  };

  return { dialogRef, onKeyDown };
}
