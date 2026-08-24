import {
  ArrowLeft,
  ArrowRight,
  Download,
  ExternalLink,
  Cloud,
  Globe2,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserBounds,
  BrowserNavigationPreview,
  LocalBrowserEvent,
  LocalBrowserSession,
} from "../contracts";
import {
  armLocalBrowserDownload,
  closeLocalBrowser,
  isNativeRuntime,
  listenForLocalBrowserEvents,
  localBrowserHistory,
  navigateLocalBrowser,
  openLocalBrowser,
  previewLocalBrowserNavigation,
  resizeLocalBrowser,
  setLocalBrowserVisibility,
  updateLocalBrowserDomains,
} from "../runtime";

interface LocalBrowserPanelProps {
  sessionId: string;
  projectId: string;
  initialUrl: string;
  allowedDomains: string[];
  obscured: boolean;
  disabled: boolean;
  onRequestCloudBrowser: () => void;
  mode?: "workbench" | "bot-read" | "bot-action" | "teach" | "replay";
  onSessionChange?: (session: LocalBrowserSession | null) => void;
  onOpenError?: (message: string) => void;
}

function measuredBounds(element: HTMLElement): BrowserBounds | null {
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, Math.floor(rect.left));
  const right = Math.min(window.innerWidth, Math.floor(rect.right));
  const width = right - left;
  const height = Math.floor(rect.height);
  if (width < 240
    || height < 160
    || rect.right <= 0
    || rect.left >= window.innerWidth
    || rect.bottom <= 58
    || rect.top >= window.innerHeight) return null;
  const top = Math.max(58, Math.floor(rect.top));
  const bottom = Math.min(window.innerHeight, Math.floor(rect.bottom));
  if (bottom - top < 160) return null;
  return {
    x: left,
    y: top,
    width,
    height: bottom - top,
  };
}

function cleanDomains(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)));
}

function sameSession(left: LocalBrowserSession | null, right: LocalBrowserSession) {
  return Boolean(left
    && left.sessionId === right.sessionId
    && left.projectId === right.projectId
    && left.status === right.status
    && left.visible === right.visible
    && left.currentUrl === right.currentUrl
    && left.downloadArmed === right.downloadArmed
    && left.allowedDomains.length === right.allowedDomains.length
    && left.allowedDomains.every((domain, index) => domain === right.allowedDomains[index])
    && left.events.length === right.events.length
    && left.events.every((event, index) => {
      const candidate = right.events[index];
      return event.sessionId === candidate?.sessionId
        && event.eventType === candidate.eventType
        && event.message === candidate.message
        && event.url === candidate.url
        && event.createdAt === candidate.createdAt;
    }));
}

export default function LocalBrowserPanel({
  sessionId,
  projectId,
  initialUrl,
  allowedDomains,
  obscured,
  disabled,
  onRequestCloudBrowser,
  mode = "workbench",
  onSessionChange,
  onOpenError,
}: LocalBrowserPanelProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<LocalBrowserSession | null>(null);
  const [session, setSession] = useState<LocalBrowserSession | null>(null);
  const [address, setAddress] = useState(initialUrl);
  const [pendingNavigation, setPendingNavigation] = useState<BrowserNavigationPreview | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const native = isNativeRuntime();
  const openingConfig = useRef({ url: initialUrl, domains: cleanDomains(allowedDomains) });
  if (!sessionRef.current && !working) {
    openingConfig.current = { url: initialUrl, domains: cleanDomains(allowedDomains) };
  }

  const commitSession = useCallback((next: LocalBrowserSession) => {
    sessionRef.current = next;
    setSession((current) => sameSession(current, next) ? current : next);
  }, []);

  useEffect(() => {
    sessionRef.current = session;
    onSessionChange?.(session);
  }, [onSessionChange, session]);

  const syncBounds = useCallback(async () => {
    const element = viewportRef.current;
    if (!native || !element || !sessionRef.current) return;
    const bounds = measuredBounds(element);
    try {
      if (!bounds || collapsed || obscured) {
        const next = await setLocalBrowserVisibility(sessionId, false);
        commitSession(next);
        return;
      }
      await resizeLocalBrowser(sessionId, bounds);
      const next = await setLocalBrowserVisibility(sessionId, true);
      commitSession(next);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }, [collapsed, commitSession, native, obscured, sessionId]);

  useEffect(() => {
    if (!native || collapsed) return;
    const element = viewportRef.current;
    if (!element) return;
    const scrollContainer = element.closest(".content-scroll, .bots-thread-scroll, .bots-browser-activities");
    let disposed = false;
    let opening = false;
    let opened = false;
    let failed = false;
    let visibilityFrame = 0;
    setMessage("Waiting for the browser viewport to be visible.");
    const openWhenVisible = () => {
      if (disposed || opening || opened || failed) return;
      const bounds = measuredBounds(element);
      if (!bounds) return;
      opening = true;
      setWorking(true);
      setMessage("Opening the approved page inside Codelit.");
      const configuration = openingConfig.current;
      void openLocalBrowser({
        sessionId,
        projectId,
        url: configuration.url,
        allowedDomains: configuration.domains,
        bounds,
      }).then((next) => {
        if (disposed) {
          void closeLocalBrowser(sessionId);
          return;
        }
        opened = true;
        commitSession(next);
        setAddress(next.currentUrl || configuration.url);
      }).catch((reason) => {
        failed = true;
        if (!disposed) {
          const detail = reason instanceof Error ? reason.message : String(reason);
          setMessage(detail);
          onOpenError?.(detail);
        }
      }).finally(() => {
        opening = false;
        if (!disposed) setWorking(false);
      });
    };
    const probeVisibility = () => {
      openWhenVisible();
      if (!disposed && !opened && !failed) {
        visibilityFrame = window.requestAnimationFrame(probeVisibility);
      }
    };
    const observer = new ResizeObserver(openWhenVisible);
    observer.observe(element);
    if (scrollContainer) observer.observe(scrollContainer);
    window.addEventListener("resize", openWhenVisible);
    scrollContainer?.addEventListener("scroll", openWhenVisible, { passive: true });
    visibilityFrame = window.requestAnimationFrame(probeVisibility);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(visibilityFrame);
      observer.disconnect();
      window.removeEventListener("resize", openWhenVisible);
      scrollContainer?.removeEventListener("scroll", openWhenVisible);
      sessionRef.current = null;
      void closeLocalBrowser(sessionId);
    };
  }, [collapsed, commitSession, native, onOpenError, projectId, sessionId]);

  useEffect(() => {
    if (!native) return;
    let unlisten = () => {};
    void listenForLocalBrowserEvents((event: LocalBrowserEvent) => {
      if (event.sessionId !== sessionId) return;
      if (event.url && ["opened", "navigation-started", "navigation-finished"].includes(event.eventType)) {
        setAddress(event.url);
      }
      setMessage(event.message);
      if (event.eventType === "navigation-finished") {
        void setLocalBrowserVisibility(sessionId, !obscured)
          .then(commitSession)
          .catch((reason) => {
            const detail = reason instanceof Error ? reason.message : String(reason);
            setMessage(detail);
            onOpenError?.(detail);
          });
      }
    }).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, [commitSession, native, obscured, onOpenError, sessionId]);

  useEffect(() => {
    if (!native || !session) return;
    const viewport = viewportRef.current;
    const scrollContainer = viewport?.closest(".content-scroll, .bots-thread-scroll, .bots-browser-activities");
    const observer = viewport ? new ResizeObserver(() => { void syncBounds(); }) : null;
    if (viewport) observer?.observe(viewport);
    if (scrollContainer) observer?.observe(scrollContainer);
    const sync = () => { void syncBounds(); };
    window.addEventListener("resize", sync);
    scrollContainer?.addEventListener("scroll", sync, { passive: true });
    void syncBounds();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", sync);
      scrollContainer?.removeEventListener("scroll", sync);
    };
  }, [native, session, syncBounds]);

  const go = async () => {
    if (!session || working || disabled) return;
    setWorking(true);
    setMessage(null);
    try {
      const preview = await previewLocalBrowserNavigation(sessionId, address);
      if (!preview.allowed) {
        setPendingNavigation(preview);
        return;
      }
      setPendingNavigation(null);
      commitSession(await navigateLocalBrowser(sessionId, preview.url));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const allowPendingDomain = async () => {
    if (!session || !pendingNavigation || disabled) return;
    setWorking(true);
    try {
      const domains = cleanDomains([...session.allowedDomains, pendingNavigation.host]);
      await updateLocalBrowserDomains(sessionId, domains);
      commitSession(await navigateLocalBrowser(sessionId, pendingNavigation.url));
      setPendingNavigation(null);
      setMessage(`${pendingNavigation.host} is allowed for this Project browser.`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const history = async (direction: "back" | "forward" | "reload") => {
    if (!session || disabled) return;
    setWorking(true);
    try {
      commitSession(await localBrowserHistory(sessionId, direction));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const armDownload = async () => {
    if (!session || disabled) return;
    try {
      commitSession(await armLocalBrowserDownload(sessionId));
      setMessage("One download is approved. It will be quarantined locally and limited to 25 MB.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (collapsed) {
    return (
      <aside className="local-browser-panel collapsed" aria-label="Project browser">
        <button
          className="button secondary"
          onClick={() => setCollapsed(false)}
          disabled={disabled}
        >
          <PanelRightOpen size={15} /> Open browser
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="local-browser-panel"
      data-mode={mode}
      aria-label={mode === "bot-read"
        ? "Bot browser"
        : mode === "bot-action"
          ? "Bot action browser"
        : mode === "teach"
          ? "Teaching browser"
          : mode === "replay"
            ? "Skill browser"
            : "Project browser"}
    >
      <header className="local-browser-heading">
        <span><Globe2 size={15} /> {mode === "bot-read"
          ? "Reading approved website"
          : mode === "bot-action"
            ? "Running approved browser action"
          : mode === "teach"
            ? "Demonstrate inside this browser"
            : mode === "replay"
              ? "Running inside Codelit"
            : "Project browser"}</span>
        {mode === "workbench" && (
          <button
            className="icon-button compact"
            onClick={() => {
              sessionRef.current = null;
              setSession(null);
              setCollapsed(true);
            }}
            disabled={disabled}
            aria-label="Collapse Project browser"
            title="Collapse browser"
          >
            <PanelRightClose size={15} />
          </button>
        )}
      </header>
      {mode === "workbench" && <div className="local-browser-toolbar">
        <button className="icon-button compact" onClick={() => void history("back")} disabled={!session || disabled} aria-label="Go back" title="Back"><ArrowLeft size={14} /></button>
        <button className="icon-button compact" onClick={() => void history("forward")} disabled={!session || disabled} aria-label="Go forward" title="Forward"><ArrowRight size={14} /></button>
        <button className="icon-button compact" onClick={() => void history("reload")} disabled={!session || disabled} aria-label="Reload page" title="Reload"><RotateCw size={14} /></button>
        <form onSubmit={(event) => { event.preventDefault(); void go(); }}>
          <Globe2 size={13} />
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={!session || disabled}
            aria-label="Browser address"
            spellCheck={false}
          />
        </form>
        <button className="icon-button compact" onClick={() => void go()} disabled={!session || disabled || working} aria-label="Open address" title="Open address"><ExternalLink size={14} /></button>
        <button className="icon-button compact" onClick={() => void armDownload()} disabled={!session || disabled} aria-label="Allow one quarantined download" title="Allow one download"><Download size={14} /></button>
      </div>}
      {pendingNavigation && (
        <div className="browser-domain-review" role="alert">
          <ShieldCheck size={15} />
          <span><strong>Allow {pendingNavigation.host}?</strong>{pendingNavigation.reason}</span>
          <button className="button secondary compact" onClick={() => setPendingNavigation(null)}>Cancel</button>
          <button className="button primary compact" onClick={() => void allowPendingDomain()}>Allow</button>
        </div>
      )}
      <div className="local-browser-viewport" ref={viewportRef} data-ready={Boolean(session)}>
        {!native && <span>Open this Team in Codelit for Mac to use its isolated browser.</span>}
        {native && (working || !session) && <span>{working ? "Opening approved page..." : "Browser is ready to open"}</span>}
      </div>
      <footer>
        <span className="status-dot" data-status={session ? "ready" : "attention"} />
        <span>{message || "Only approved domains open here. Popups and unapproved downloads are blocked."}</span>
        {session?.downloadArmed && <strong>1 download armed</strong>}
        {mode === "workbench" && (
          <button
            className="browser-cloud-action"
            onClick={onRequestCloudBrowser}
            disabled={disabled}
            title="Use a managed browser when this Mac is offline"
          >
            <Cloud size={12} /> Cloud browser
          </button>
        )}
      </footer>
    </aside>
  );
}
