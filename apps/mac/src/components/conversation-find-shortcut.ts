export function listenForConversationFind(target: Window, open: () => void) {
  const onFind = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f" && !event.isComposing) {
      event.preventDefault();
      open();
    }
  };
  target.addEventListener("keydown", onFind);
  return () => target.removeEventListener("keydown", onFind);
}
