import { Check, FileCode2, Plus, RefreshCw, Server, Trash2, X } from "lucide-react";
import { useState } from "react";
import type {
  LocalMcpInspection,
  LocalMcpServer,
  LocalMcpServerDraft,
  LocalMcpTransport,
} from "../contracts";

export interface LocalMcpAction {
  kind: "choosing" | "inspecting" | "saving" | "deleting";
  serverId?: string;
  message?: string;
}

interface LocalMcpSettingsProps {
  servers: LocalMcpServer[];
  action: LocalMcpAction | null;
  onChooseExecutable: () => Promise<string | null>;
  onInspect: (server: LocalMcpServerDraft) => Promise<LocalMcpInspection>;
  onSave: (server: LocalMcpServerDraft, approvedTools: string[]) => Promise<LocalMcpServer>;
  onDelete: (id: string) => Promise<void>;
}

function newDraft(): LocalMcpServerDraft {
  return {
    id: `mcp-${crypto.randomUUID()}`,
    name: "",
    transport: "stdio",
    commandPath: "",
    arguments: [],
    endpoint: "http://127.0.0.1:3000/mcp",
    networkAccess: false,
    projectAccess: false,
  };
}

function draftFromServer(server: LocalMcpServer): LocalMcpServerDraft {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    commandPath: server.config.commandPath || "",
    arguments: server.config.arguments || [],
    endpoint: server.config.endpoint || "http://127.0.0.1:3000/mcp",
    networkAccess: server.config.networkAccess,
    projectAccess: server.config.projectAccess,
  };
}

function inspectionFromServer(server: LocalMcpServer): LocalMcpInspection {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    protocolVersion: server.protocolVersion,
    serverName: server.serverName,
    serverVersion: server.serverVersion,
    fingerprint: server.fingerprint,
    config: server.config,
    tools: server.tools,
    detail: server.detail,
  };
}

export default function LocalMcpSettings({
  servers,
  action,
  onChooseExecutable,
  onInspect,
  onSave,
  onDelete,
}: LocalMcpSettingsProps) {
  const [draft, setDraft] = useState<LocalMcpServerDraft | null>(null);
  const [inspection, setInspection] = useState<LocalMcpInspection | null>(null);
  const [approvedTools, setApprovedTools] = useState<Set<string>>(new Set());

  const editing = Boolean(draft);
  const busy = Boolean(action);

  const updateDraft = (update: Partial<LocalMcpServerDraft>) => {
    setDraft((current) => current ? { ...current, ...update } : current);
    setInspection(null);
    setApprovedTools(new Set());
  };

  const editServer = (server: LocalMcpServer) => {
    setDraft(draftFromServer(server));
    setInspection(inspectionFromServer(server));
    setApprovedTools(new Set(server.tools.filter((tool) => tool.approved).map((tool) => tool.name)));
  };

  const closeEditor = () => {
    if (busy) return;
    setDraft(null);
    setInspection(null);
    setApprovedTools(new Set());
  };

  const inspect = async () => {
    if (!draft) return;
    try {
      const result = await onInspect(draft);
      setInspection(result);
      setApprovedTools(new Set());
    } catch {
      // The app-level alert contains the actionable native error.
    }
  };

  const save = async () => {
    if (!draft || !inspection || approvedTools.size === 0) return;
    try {
      await onSave(draft, Array.from(approvedTools));
      setDraft(null);
      setInspection(null);
      setApprovedTools(new Set());
    } catch {
      // The app-level alert contains the actionable native error.
    }
  };

  const chooseExecutable = async () => {
    try {
      const path = await onChooseExecutable();
      if (path) updateDraft({ commandPath: path });
    } catch {
      // The app-level alert contains the actionable native error.
    }
  };

  const removeServer = async (id: string) => {
    try {
      await onDelete(id);
    } catch {
      // The app-level alert contains the actionable native error.
    }
  };

  const setTransport = (transport: LocalMcpTransport) => {
    updateDraft({ transport });
  };

  const updateArgument = (index: number, value: string) => {
    if (!draft) return;
    updateDraft({
      arguments: draft.arguments.map((argument, candidate) => candidate === index ? value : argument),
    });
  };

  const removeArgument = (index: number) => {
    if (!draft) return;
    updateDraft({ arguments: draft.arguments.filter((_, candidate) => candidate !== index) });
  };

  return (
    <div className="mcp-settings">
      <div className="settings-section-heading">
        <div>
          <h3>Local MCP</h3>
          <p>Approve tools from a server running on this Mac.</p>
        </div>
        {!editing && (
          <button className="provider-test" onClick={() => setDraft(newDraft())} disabled={busy}>
            <Plus size={14} /> Add server
          </button>
        )}
      </div>

      {!editing && (
        <div className="mcp-server-list">
          {servers.length === 0 ? (
            <div className="mcp-empty">
              <Server size={17} />
              <span>No local MCP tools approved yet.</span>
            </div>
          ) : servers.map((server) => (
            <article className="mcp-server-row" key={server.id}>
              <span className="status-dot" data-status={server.status} />
              <div>
                <strong>{server.name}</strong>
                <span>{server.tools.filter((tool) => tool.approved).length} tools · {server.transport}</span>
              </div>
              <button className="provider-test" onClick={() => editServer(server)} disabled={busy}>
                Review
              </button>
              <button
                className="icon-button compact danger-icon"
                onClick={() => void removeServer(server.id)}
                disabled={busy}
                aria-label={`Remove ${server.name}`}
                title={`Remove ${server.name}`}
              >
                <Trash2 size={14} />
              </button>
            </article>
          ))}
        </div>
      )}

      {draft && (
        <div className="mcp-editor">
          <div className="mcp-editor-header">
            <strong>{servers.some((server) => server.id === draft.id) ? "Review local server" : "Add local server"}</strong>
            <button className="icon-button compact" onClick={closeEditor} disabled={busy} aria-label="Close MCP server editor">
              <X size={15} />
            </button>
          </div>

          <label className="mcp-field">
            <span>Name</span>
            <input
              value={draft.name}
              onChange={(event) => updateDraft({ name: event.target.value })}
              placeholder="Issue tracker"
              disabled={busy}
            />
          </label>

          <div className="mcp-field">
            <span>Connection</span>
            <div className="mcp-transport" role="group" aria-label="MCP connection type">
              <button type="button" data-active={draft.transport === "stdio"} onClick={() => setTransport("stdio")} disabled={busy}>
                Executable
              </button>
              <button type="button" data-active={draft.transport === "localhost"} onClick={() => setTransport("localhost")} disabled={busy}>
                Localhost
              </button>
            </div>
          </div>

          {draft.transport === "stdio" ? (
            <>
              <div className="mcp-field">
                <span>Executable</span>
                <div className="mcp-path-row">
                  <input value={draft.commandPath} readOnly placeholder="Choose the server executable" />
                  <button className="provider-test" onClick={() => void chooseExecutable()} disabled={busy}>
                    <FileCode2 size={14} /> Browse
                  </button>
                </div>
              </div>
              {draft.arguments.map((argument, index) => (
                <label className="mcp-field" key={`${index}-${draft.arguments.length}`}>
                  <span>Argument {index + 1}</span>
                  <div className="mcp-path-row">
                    <input
                      value={argument}
                      onChange={(event) => updateArgument(index, event.target.value)}
                      placeholder="One argument"
                      disabled={busy}
                    />
                    <button className="icon-button compact" onClick={() => removeArgument(index)} disabled={busy} aria-label={`Remove argument ${index + 1}`}>
                      <X size={14} />
                    </button>
                  </div>
                </label>
              ))}
              {draft.arguments.length < 16 && (
                <button className="mcp-add-argument" onClick={() => updateDraft({ arguments: [...draft.arguments, ""] })} disabled={busy}>
                  <Plus size={13} /> Add argument
                </button>
              )}
              <label className="mcp-toggle">
                <input
                  type="checkbox"
                  checked={draft.projectAccess}
                  onChange={(event) => updateDraft({ projectAccess: event.target.checked })}
                  disabled={busy}
                />
                <span><strong>Read selected project</strong><small>The server receives read-only access to the chosen folder.</small></span>
              </label>
              <label className="mcp-toggle">
                <input
                  type="checkbox"
                  checked={draft.networkAccess}
                  onChange={(event) => updateDraft({ networkAccess: event.target.checked })}
                  disabled={busy}
                />
                <span><strong>Allow network</strong><small>The isolated server may connect beyond this Mac.</small></span>
              </label>
            </>
          ) : (
            <label className="mcp-field">
              <span>Loopback URL</span>
              <input
                value={draft.endpoint}
                onChange={(event) => updateDraft({ endpoint: event.target.value })}
                placeholder="http://127.0.0.1:3000/mcp"
                spellCheck={false}
                disabled={busy}
              />
            </label>
          )}

          {!inspection ? (
            <button
              className="button primary mcp-primary-action"
              onClick={() => void inspect()}
              disabled={busy || !draft.name.trim() || (draft.transport === "stdio" ? !draft.commandPath : !draft.endpoint)}
            >
              {action?.kind === "inspecting" ? <span className="spinner dark" /> : <RefreshCw size={15} />}
              Inspect tools
            </button>
          ) : (
            <div className="mcp-review">
              <div className="mcp-review-heading">
                <div>
                  <strong>{inspection.serverName}</strong>
                  <span>v{inspection.serverVersion} · {inspection.protocolVersion}</span>
                </div>
                <span>{approvedTools.size}/{inspection.tools.length} approved</span>
              </div>
              <div className="mcp-tool-list">
                {inspection.tools.map((tool) => (
                  <label className="mcp-tool-row" key={tool.name}>
                    <input
                      type="checkbox"
                      checked={approvedTools.has(tool.name)}
                      onChange={(event) => {
                        setApprovedTools((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(tool.name);
                          else next.delete(tool.name);
                          return next;
                        });
                      }}
                      disabled={busy}
                    />
                    <span>
                      <strong>{tool.name}</strong>
                      <small>{tool.description}</small>
                    </span>
                    <em data-effect={tool.effect}>{tool.destructive ? "destructive" : tool.effect}</em>
                  </label>
                ))}
              </div>
              <button
                className="button primary mcp-primary-action"
                onClick={() => void save()}
                disabled={busy || approvedTools.size === 0}
              >
                {action?.kind === "saving" ? <span className="spinner dark" /> : <Check size={15} />}
                Save approved tools
              </button>
            </div>
          )}
          {action?.message && <p className="mcp-action-message" role="status">{action.message}</p>}
        </div>
      )}
    </div>
  );
}
