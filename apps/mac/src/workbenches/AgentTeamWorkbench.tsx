import { Check, CircleStop, Globe2, Plus, Play, Save, ShieldCheck, Terminal, Trash2, Users, Wrench } from "lucide-react";
import { useEffect, useState, type ChangeEvent } from "react";
import type { LiveRunApprovalDecision } from "@/lib/agent-live-run";
import EnginePicker from "../components/EnginePicker";
import LocalBrowserPanel from "../components/LocalBrowserPanel";
import { localBrowserSessionId, type LocalAgentApprovalRequest } from "../local-agent-team-runtime";
import type {
  AgentTeamPayload,
  IntelligenceSelection,
  LocalArtifactVersion,
  LocalMcpServer,
  ProviderProbe,
  ProviderRunEvent,
} from "../contracts";
import { isRecord, localMcpToolReference, parseLocalMcpToolReference } from "../contracts";

interface AgentTeamWorkbenchProps {
  artifact: LocalArtifactVersion;
  providers: ProviderProbe[];
  mcpServers: LocalMcpServer[];
  engine: IntelligenceSelection | null;
  busy: "idle" | "saving" | "running";
  onSave: (title: string, payload: AgentTeamPayload) => Promise<void>;
  onEngineChange: (selection: IntelligenceSelection) => void;
  runStatus: "idle" | "running" | "awaiting-approval" | "completed" | "halted";
  activeStep: number | null;
  runEvents: ProviderRunEvent[];
  approval: LocalAgentApprovalRequest | null;
  recoverableRun: {
    runId: string;
    updatedAt: string;
    awaitingApproval: boolean;
  } | null;
  onRun: (title: string, team: AgentTeamPayload, engine: IntelligenceSelection | null) => Promise<void>;
  onResume: () => Promise<void>;
  onCancel: () => Promise<void>;
  onApprovalDecision: (decision: LiveRunApprovalDecision) => void;
  browserObscured: boolean;
  onRequestCloudBrowser: () => void;
}

const EMPTY_TEAM: AgentTeamPayload = {
  goal: "Define what this local team should accomplish.",
  agents: [],
  handoffs: [],
};

const BROWSER_READ_TOOL = "Browser read";
const BROWSER_ACT_TOOL = "Browser act";

function isBrowserTool(tool: string) {
  return tool === BROWSER_READ_TOOL || tool === BROWSER_ACT_TOOL;
}

function defaultBrowserInputs(tool: string): Record<string, unknown> {
  return {
    url: "https://codelit.io",
    objective: tool === BROWSER_ACT_TOOL
      ? "Complete one approved browser action and verify the visible result."
      : "Inspect the page for evidence relevant to the Team outcome.",
    allowedDomains: ["codelit.io"],
    ...(tool === BROWSER_ACT_TOOL ? {
      action: "click",
      target: "text:Continue",
      value: "",
    } : {}),
  };
}

function browserDomains(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function browserText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function hostForUrl(value: string) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "codelit.io";
  }
}

type McpSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  maxLength?: number;
  maxItems?: number;
  items?: McpSchema;
  properties?: Record<string, McpSchema>;
  required?: string[];
};

const MCP_FIELD_ACRONYMS = new Set(["api", "html", "http", "https", "id", "json", "mcp", "sql", "uri", "url", "xml"]);
const MCP_FIELD_NAMES: Record<string, string> = {
  github: "GitHub",
  jira: "Jira",
  slack: "Slack",
};

export function formatMcpFieldLabel(name: string) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((word, index) => {
    const normalized = word.toLowerCase();
    if (MCP_FIELD_ACRONYMS.has(normalized)) return normalized.toUpperCase();
    if (MCP_FIELD_NAMES[normalized]) return MCP_FIELD_NAMES[normalized];
    return index === 0
      ? normalized.replace(/^./, (letter) => letter.toUpperCase())
      : normalized;
  }).join(" ");
}

export function orderedMcpSchemaFields(schema: McpSchema) {
  const required = new Set(schema.required || []);
  return Object.entries(schema.properties || {}).sort(([left], [right]) => (
    Number(required.has(right)) - Number(required.has(left))
  ));
}

function readToolInputs(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([tool, inputs]) => (
    (parseLocalMcpToolReference(tool) || isBrowserTool(tool)) && isRecord(inputs)
      ? [[tool, inputs]]
      : []
  )));
}

function readTeam(value: unknown): AgentTeamPayload {
  if (!isRecord(value) || !Array.isArray(value.agents)) return EMPTY_TEAM;
  return {
    goal: typeof value.goal === "string" ? value.goal : EMPTY_TEAM.goal,
    agents: value.agents.flatMap((agent) => {
      if (!isRecord(agent) || typeof agent.id !== "string" || typeof agent.name !== "string") {
        return [];
      }
      return [{
        id: agent.id,
        name: agent.name,
        role: typeof agent.role === "string" ? agent.role : "",
        provider: typeof agent.provider === "string" ? agent.provider : "codex",
        model: typeof agent.model === "string" ? agent.model : "default",
        tools: Array.isArray(agent.tools)
          ? agent.tools.filter((tool): tool is string => typeof tool === "string")
          : [],
        toolInputs: readToolInputs(agent.toolInputs),
      }];
    }),
    handoffs: Array.isArray(value.handoffs)
      ? value.handoffs.flatMap((handoff) => {
          if (!isRecord(handoff)
            || typeof handoff.from !== "string"
            || typeof handoff.to !== "string"
            || typeof handoff.label !== "string") return [];
          return [{ from: handoff.from, to: handoff.to, label: handoff.label }];
        })
      : [],
  };
}

function schemaFor(value: unknown): McpSchema {
  return isRecord(value) ? value as McpSchema : { type: "object", properties: {} };
}

function isHandoffField(name: string) {
  return /^(input|text|message|prompt|query|task|content|request|instructions?)$/i.test(name);
}

function defaultSchemaValue(schema: McpSchema, name = ""): unknown {
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case "string": return isHandoffField(name) ? "{{handoff}}" : "";
    case "number":
    case "integer": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": {
      const required = new Set(schema.required || []);
      return Object.fromEntries(Object.entries(schema.properties || {}).flatMap(([key, child]) => (
        required.has(key) ? [[key, defaultSchemaValue(child, key)]] : []
      )));
    }
    default: return "";
  }
}

function defaultToolInputs(schema: McpSchema) {
  const value = defaultSchemaValue(schema);
  return isRecord(value) ? value : {};
}

function mcpToolForReference(reference: string, servers: LocalMcpServer[]) {
  const parsed = parseLocalMcpToolReference(reference);
  if (!parsed) return null;
  const server = servers.find((candidate) => candidate.id === parsed.serverId);
  const tool = server?.tools.find((candidate) => (
    candidate.approved && candidate.name === parsed.toolName
  ));
  return server && tool ? { server, tool } : null;
}

function displayToolName(reference: string, servers: LocalMcpServer[]) {
  const resolved = mcpToolForReference(reference, servers);
  return resolved ? `${resolved.server.name} / ${resolved.tool.name}` : reference;
}

function McpSchemaField({
  schema,
  value,
  name,
  required,
  path,
  disabled,
  onChange,
}: {
  schema: McpSchema;
  value: unknown;
  name: string;
  required: boolean;
  path: string;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = formatMcpFieldLabel(name);
  const description = typeof schema.description === "string" ? schema.description : "";
  if (schema.type === "object") {
    const current = isRecord(value) ? value : {};
    const requiredFields = new Set(schema.required || []);
    return (
      <fieldset className="mcp-input-group">
        <legend>{label}{required ? " *" : ""}</legend>
        {description && <small>{description}</small>}
        {orderedMcpSchemaFields(schema).map(([childName, childSchema]) => (
          <McpSchemaField
            key={childName}
            schema={childSchema}
            value={current[childName]}
            name={childName}
            required={requiredFields.has(childName)}
            path={`${path}-${childName}`}
            disabled={disabled}
            onChange={(next) => onChange({ ...current, [childName]: next })}
          />
        ))}
      </fieldset>
    );
  }
  if (schema.type === "array") {
    const values = Array.isArray(value) ? value : [];
    const itemSchema = schema.items || { type: "string" };
    const limit = Math.min(schema.maxItems || 20, 20);
    return (
      <fieldset className="mcp-input-group">
        <legend>{label}{required ? " *" : ""}</legend>
        {description && <small>{description}</small>}
        {values.map((item, index) => (
          <div className="mcp-array-item" key={`${path}-${index}`}>
            <McpSchemaField
              schema={itemSchema}
              value={item}
              name={`Item ${index + 1}`}
              required
              path={`${path}-${index}`}
              disabled={disabled}
              onChange={(next) => onChange(values.map((candidate, candidateIndex) => (
                candidateIndex === index ? next : candidate
              )))}
            />
            <button
              className="icon-button compact"
              onClick={() => onChange(values.filter((_, candidateIndex) => candidateIndex !== index))}
              disabled={disabled}
              aria-label={`Remove ${label} item ${index + 1}`}
              title="Remove item"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {values.length < limit && (
          <button
            className="mcp-add-argument"
            onClick={() => onChange([...values, defaultSchemaValue(itemSchema)])}
            disabled={disabled}
          >
            <Plus size={13} /> Add item
          </button>
        )}
      </fieldset>
    );
  }
  if (schema.enum?.length) {
    const selected = Math.max(0, schema.enum.findIndex((candidate) => (
      JSON.stringify(candidate) === JSON.stringify(value)
    )));
    return (
      <label className="mcp-node-field" htmlFor={path}>
        <span>{label}{required ? " *" : ""}</span>
        <select
          id={path}
          value={selected}
          onChange={(event) => onChange(schema.enum?.[Number(event.target.value)])}
          disabled={disabled}
        >
          {schema.enum.map((choice, index) => (
            <option value={index} key={JSON.stringify(choice)}>{String(choice)}</option>
          ))}
        </select>
        {description && <small>{description}</small>}
      </label>
    );
  }
  if (schema.type === "boolean") {
    return (
      <label className="mcp-node-toggle" htmlFor={path}>
        <input
          id={path}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
        />
        <span><strong>{label}{required ? " *" : ""}</strong>{description && <small>{description}</small>}</span>
      </label>
    );
  }
  if (schema.type === "number" || schema.type === "integer") {
    return (
      <label className="mcp-node-field" htmlFor={path}>
        <span>{label}{required ? " *" : ""}</span>
        <input
          id={path}
          type="number"
          step={schema.type === "integer" ? 1 : "any"}
          value={typeof value === "number" ? value : ""}
          placeholder={required ? "Required" : "Optional"}
          onChange={(event) => onChange(event.target.value === ""
            ? undefined
            : schema.type === "integer"
              ? Math.trunc(Number(event.target.value))
              : Number(event.target.value))}
          disabled={disabled}
        />
        {description && <small>{description}</small>}
      </label>
    );
  }
  const usesHandoff = value === "{{handoff}}";
  const inputValue = typeof value === "string" && !usesHandoff ? value : "";
  const shared = {
    id: path,
    value: inputValue,
    placeholder: usesHandoff ? "Previous teammate result" : description || `Enter ${label.toLowerCase()}`,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
    disabled,
    maxLength: schema.maxLength || 8_000,
  };
  return (
    <label className="mcp-node-field" htmlFor={path}>
      <span>{label}{required ? " *" : ""}{usesHandoff && <em>Uses previous result</em>}</span>
      {(schema.maxLength || 0) > 240 ? <textarea {...shared} rows={2} /> : <input {...shared} />}
      {description && <small>{description}</small>}
    </label>
  );
}

export default function AgentTeamWorkbench({
  artifact,
  providers,
  mcpServers,
  engine,
  busy,
  onSave,
  onEngineChange,
  onRun,
  runStatus,
  activeStep,
  runEvents,
  approval,
  recoverableRun,
  onCancel,
  onResume,
  onApprovalDecision,
  browserObscured,
  onRequestCloudBrowser,
}: AgentTeamWorkbenchProps) {
  const [title, setTitle] = useState(artifact.title);
  const [team, setTeam] = useState<AgentTeamPayload>(() => readTeam(artifact.payload));

  useEffect(() => {
    setTitle(artifact.title);
    setTeam(readTeam(artifact.payload));
  }, [artifact]);

  const updateAgent = (id: string, updates: Partial<AgentTeamPayload["agents"][number]>) => {
    setTeam((current) => ({
      ...current,
      agents: current.agents.map((agent) => agent.id === id ? { ...agent, ...updates } : agent),
    }));
  };

  const removeAgent = (id: string) => {
    setTeam((current) => {
      const index = current.agents.findIndex((agent) => agent.id === id);
      if (index < 0) return current;
      const previous = current.agents[index - 1];
      const next = current.agents[index + 1];
      const outgoing = current.handoffs.find((handoff) => handoff.from === id && handoff.to === next?.id);
      const handoffs = current.handoffs.filter((handoff) => handoff.from !== id && handoff.to !== id);
      if (previous && next) {
        handoffs.push({ from: previous.id, to: next.id, label: outgoing?.label || "Next" });
      }
      return {
        ...current,
        agents: current.agents.filter((agent) => agent.id !== id),
        handoffs,
      };
    });
  };

  const approvedMcpTools = mcpServers.flatMap((server) => server.enabled
    ? server.tools.filter((tool) => tool.approved).map((tool) => ({
        server,
        tool,
        reference: localMcpToolReference(server.id, tool.name),
      }))
    : []);

  const addMcpTool = (agentId: string, reference: string) => {
    const resolved = mcpToolForReference(reference, mcpServers);
    if (!resolved) return;
    setTeam((current) => ({
      ...current,
      agents: current.agents.map((agent) => agent.id === agentId ? {
        ...agent,
        tools: agent.tools.includes(reference) ? agent.tools : [...agent.tools, reference],
        toolInputs: {
          ...(agent.toolInputs || {}),
          [reference]: defaultToolInputs(schemaFor(resolved.tool.inputSchema)),
        },
      } : agent),
    }));
  };

  const removeMcpTool = (agentId: string, reference: string) => {
    setTeam((current) => ({
      ...current,
      agents: current.agents.map((agent) => {
        if (agent.id !== agentId) return agent;
        const nextInputs = { ...(agent.toolInputs || {}) };
        delete nextInputs[reference];
        return {
          ...agent,
          tools: agent.tools.filter((tool) => tool !== reference),
          toolInputs: nextInputs,
        };
      }),
    }));
  };

  const updateMcpInputs = (
    agentId: string,
    reference: string,
    inputs: Record<string, unknown>,
  ) => {
    setTeam((current) => ({
      ...current,
      agents: current.agents.map((agent) => agent.id === agentId ? {
        ...agent,
        toolInputs: { ...(agent.toolInputs || {}), [reference]: inputs },
      } : agent),
    }));
  };

  const addBrowserTeammate = (tool: string) => {
    if (!isBrowserTool(tool)) return;
    const id = `browser-${crypto.randomUUID()}`;
    setTeam((current) => {
      const previous = current.agents.at(-1);
      const fallback = current.agents[0];
      return {
        ...current,
        agents: [...current.agents, {
          id,
          name: tool === BROWSER_ACT_TOOL ? "Browser Operator" : "Website Investigator",
          role: tool === BROWSER_ACT_TOOL
            ? "Performs one exact approved action in the Project browser and reports visible proof."
            : "Inspects one approved website and returns bounded visible evidence.",
          provider: engine?.provider || fallback?.provider || "codex",
          model: engine?.model || fallback?.model || "default",
          tools: [tool],
          toolInputs: { [tool]: defaultBrowserInputs(tool) },
        }],
        handoffs: previous
          ? [...current.handoffs, { from: previous.id, to: id, label: "Browser task" }]
          : current.handoffs,
      };
    });
  };

  const browserAgent = team.agents.find((agent) => agent.tools.some(isBrowserTool));
  const browserReference = browserAgent?.tools.find(isBrowserTool);
  const browserInputs = browserReference ? browserAgent?.toolInputs?.[browserReference] || {} : {};
  const browserUrl = browserText(browserInputs.url, "https://codelit.io");
  const configuredDomains = browserDomains(browserInputs.allowedDomains);
  const browserAllowedDomains = configuredDomains.length
    ? configuredDomains
    : [hostForUrl(browserUrl)];

  return (
    <section
      className="workbench agent-workbench"
      data-browser={Boolean(browserAgent)}
      aria-labelledby="agent-team-title"
    >
      <header className="workbench-header">
        <div className="workbench-heading">
          <span className="workbench-icon agent"><Users size={18} /></span>
          <div>
            <span className="eyebrow">Agent Team</span>
            <input
              id="agent-team-title"
              className="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Agent Team title"
              disabled={busy !== "idle"}
            />
          </div>
        </div>
        <div className="workbench-actions">
          <EnginePicker providers={providers} value={engine} onChange={onEngineChange} compact disabled={busy !== "idle"} />
          <button className="button secondary" onClick={() => void onSave(title, team)} disabled={busy !== "idle"}>
            {busy === "saving" ? <span className="spinner" /> : <Save size={16} />}
            Save
          </button>
          <button className="button primary" onClick={() => void onRun(title, team, engine)} disabled={busy !== "idle" || !engine}>
            {busy === "running" ? <span className="spinner dark" /> : <Play size={16} fill="currentColor" />}
            Run team
          </button>
        </div>
      </header>

      <label className="field-label" htmlFor="team-goal">Team outcome</label>
      <textarea
        id="team-goal"
        className="goal-input"
        rows={2}
        value={team.goal}
        onChange={(event) => setTeam((current) => ({ ...current, goal: event.target.value }))}
        disabled={busy !== "idle"}
      />

      <div className={browserAgent ? "agent-workspace-grid" : undefined}>
        <div className="agent-flow-column">
          <div className="flow" aria-label="Agent Team flow">
        {team.agents.map((agent, index) => {
          const handoff = team.handoffs.find((candidate) => candidate.from === agent.id);
          const mcpReferences = agent.tools.filter((tool) => parseLocalMcpToolReference(tool));
          const browserReferences = agent.tools.filter(isBrowserTool);
          const builtInTools = agent.tools.filter((tool) => (
            !parseLocalMcpToolReference(tool) && !isBrowserTool(tool)
          ));
          const availableMcpTools = approvedMcpTools.filter(({ reference }) => (
            !agent.tools.includes(reference)
          ));
          return (
            <div className="flow-stage" key={agent.id}>
              <article className="agent-node" data-run-state={activeStep === index ? "active" : undefined}>
                <div className="node-number" aria-hidden="true">{index + 1}</div>
                <div className="node-body">
                  <div className="node-title-row">
                    <input
                      className="node-title-input"
                      value={agent.name}
                      onChange={(event) => updateAgent(agent.id, { name: event.target.value })}
                      aria-label={`Name for teammate ${index + 1}`}
                      disabled={busy !== "idle"}
                    />
                    <button
                      className="icon-button compact"
                      onClick={() => removeAgent(agent.id)}
                      disabled={busy !== "idle"}
                      aria-label={`Remove ${agent.name}`}
                      title="Remove teammate"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <textarea
                    className="node-role-input"
                    rows={2}
                    value={agent.role}
                    onChange={(event) => updateAgent(agent.id, { role: event.target.value })}
                    aria-label={`Role for ${agent.name}`}
                    disabled={busy !== "idle"}
                  />
                  <div className="node-metadata">
                    <EnginePicker
                      providers={providers}
                      value={{
                        provider: agent.provider as ProviderProbe["id"],
                        model: agent.model,
                      }}
                      onChange={(selection) => {
                        updateAgent(agent.id, {
                          provider: selection.provider,
                          model: selection.model,
                        });
                      }}
                      label={`Intelligence for ${agent.name}`}
                      compact
                      disabled={busy !== "idle"}
                    />
                    <span className="tool-summary">
                      <Check size={14} /> {browserReferences.join(" · ")
                        || builtInTools.join(" · ")
                        || (mcpReferences.length ? "Local MCP" : "No tools")}
                    </span>
                  </div>
                  {browserReferences.map((reference) => {
                    const inputs = agent.toolInputs?.[reference] || defaultBrowserInputs(reference);
                    const action = browserText(inputs.action, "click");
                    return (
                      <section className="mcp-node-tool browser-node-tool" key={reference}>
                        <header>
                          <span><Globe2 size={14} /> {reference === BROWSER_ACT_TOOL ? "Act in browser" : "Inspect website"}</span>
                          <em data-effect={reference === BROWSER_ACT_TOOL ? "write" : "read"}>
                            {reference === BROWSER_ACT_TOOL ? "approval" : "read only"}
                          </em>
                          <button
                            className="icon-button compact"
                            onClick={() => removeMcpTool(agent.id, reference)}
                            disabled={busy !== "idle"}
                            aria-label={`Remove ${reference}`}
                            title="Remove browser module"
                          ><Trash2 size={13} /></button>
                        </header>
                        <label className="mcp-node-field" htmlFor={`${agent.id}-${reference}-url`}>
                          <span>Website URL *</span>
                          <input
                            id={`${agent.id}-${reference}-url`}
                            type="url"
                            value={browserText(inputs.url)}
                            placeholder="https://example.com"
                            onChange={(event) => updateMcpInputs(agent.id, reference, {
                              ...inputs,
                              url: event.target.value,
                            })}
                            disabled={busy !== "idle"}
                          />
                          <small>HTTPS only. Localhost is allowed for local development.</small>
                        </label>
                        <label className="mcp-node-field" htmlFor={`${agent.id}-${reference}-objective`}>
                          <span>What should this teammate do? *</span>
                          <textarea
                            id={`${agent.id}-${reference}-objective`}
                            rows={2}
                            value={browserText(inputs.objective)}
                            onChange={(event) => updateMcpInputs(agent.id, reference, {
                              ...inputs,
                              objective: event.target.value,
                            })}
                            disabled={busy !== "idle"}
                          />
                        </label>
                        <label className="mcp-node-field" htmlFor={`${agent.id}-${reference}-domains`}>
                          <span>Approved domains *</span>
                          <input
                            id={`${agent.id}-${reference}-domains`}
                            className="browser-domains-input"
                            value={browserDomains(inputs.allowedDomains).join(", ")}
                            placeholder="example.com, *.example.com"
                            onChange={(event) => updateMcpInputs(agent.id, reference, {
                              ...inputs,
                              allowedDomains: browserDomains(event.target.value),
                            })}
                            disabled={busy !== "idle"}
                          />
                          <small>Redirects, popups, and navigation outside this list are blocked.</small>
                        </label>
                        {reference === BROWSER_ACT_TOOL && (
                          <>
                            <label className="mcp-node-field" htmlFor={`${agent.id}-${reference}-action`}>
                              <span>Approved action *</span>
                              <select
                                id={`${agent.id}-${reference}-action`}
                                value={action}
                                onChange={(event) => updateMcpInputs(agent.id, reference, {
                                  ...inputs,
                                  action: event.target.value,
                                })}
                                disabled={busy !== "idle"}
                              >
                                <option value="click">Click</option>
                                <option value="type">Type</option>
                              </select>
                            </label>
                            <label className="mcp-node-field" htmlFor={`${agent.id}-${reference}-target`}>
                              <span>Visible target *</span>
                              <input
                                id={`${agent.id}-${reference}-target`}
                                value={browserText(inputs.target)}
                                placeholder="text:Save changes"
                                onChange={(event) => updateMcpInputs(agent.id, reference, {
                                  ...inputs,
                                  target: event.target.value,
                                })}
                                disabled={busy !== "idle"}
                              />
                              <small>Use text:Visible label or one bounded CSS selector.</small>
                            </label>
                            {action === "type" && (
                              <label className="mcp-node-field" htmlFor={`${agent.id}-${reference}-value`}>
                                <span>Text to enter *</span>
                                <textarea
                                  id={`${agent.id}-${reference}-value`}
                                  rows={2}
                                  value={browserText(inputs.value)}
                                  placeholder="Use {{handoff}} for the previous teammate result"
                                  onChange={(event) => updateMcpInputs(agent.id, reference, {
                                    ...inputs,
                                    value: event.target.value,
                                  })}
                                  disabled={busy !== "idle"}
                                />
                              </label>
                            )}
                          </>
                        )}
                      </section>
                    );
                  })}
                  {mcpReferences.length > 0 && (
                    <div className="mcp-node-tools">
                      {mcpReferences.map((reference) => {
                        const resolved = mcpToolForReference(reference, mcpServers);
                        if (!resolved) {
                          return (
                            <section className="mcp-node-tool unavailable" key={reference}>
                              <header>
                                <span><Wrench size={14} /> Local tool unavailable</span>
                                <button
                                  className="icon-button compact"
                                  onClick={() => removeMcpTool(agent.id, reference)}
                                  disabled={busy !== "idle"}
                                  aria-label="Remove unavailable local tool"
                                  title="Remove tool"
                                ><Trash2 size={13} /></button>
                              </header>
                              <small>Review this server in Settings or remove it from the teammate.</small>
                            </section>
                          );
                        }
                        const schema = schemaFor(resolved.tool.inputSchema);
                        const inputs = agent.toolInputs?.[reference] || {};
                        const required = new Set(schema.required || []);
                        return (
                          <section className="mcp-node-tool" key={reference}>
                            <header>
                              <span><Wrench size={14} /> {resolved.server.name} / {resolved.tool.name}</span>
                              <em data-effect={resolved.tool.effect}>
                                {resolved.tool.destructive ? "destructive" : resolved.tool.effect}
                              </em>
                              <button
                                className="icon-button compact"
                                onClick={() => removeMcpTool(agent.id, reference)}
                                disabled={busy !== "idle"}
                                aria-label={`Remove ${displayToolName(reference, mcpServers)}`}
                                title="Remove tool"
                              ><Trash2 size={13} /></button>
                            </header>
                            {resolved.tool.description && <p>{resolved.tool.description}</p>}
                            {Object.entries(schema.properties || {}).length === 0 ? (
                              <small>No setup is required for this call.</small>
                            ) : orderedMcpSchemaFields(schema).map(([name, fieldSchema]) => (
                              <McpSchemaField
                                key={name}
                                schema={fieldSchema}
                                value={inputs[name]}
                                name={name}
                                required={required.has(name)}
                                path={`${agent.id}-${resolved.server.id}-${resolved.tool.name}-${name}`}
                                disabled={busy !== "idle"}
                                onChange={(next) => updateMcpInputs(agent.id, reference, {
                                  ...inputs,
                                  [name]: next,
                                })}
                              />
                            ))}
                          </section>
                        );
                      })}
                    </div>
                  )}
                  {approvedMcpTools.length > 0 && (
                    <label className="mcp-node-add">
                      <Wrench size={14} />
                      <select
                        value=""
                        onChange={(event) => addMcpTool(agent.id, event.target.value)}
                        disabled={busy !== "idle" || availableMcpTools.length === 0}
                        aria-label={`Add a local tool to ${agent.name}`}
                      >
                        <option value="">{availableMcpTools.length ? "Add local tool" : "All local tools added"}</option>
                        {availableMcpTools.map(({ server, tool, reference }) => (
                          <option value={reference} key={reference}>{server.name} / {tool.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </article>
              {index < team.agents.length - 1 && (
                <div className="handoff" aria-label={handoff?.label || "Next teammate"}>
                  <span>{handoff?.label || "Next"}</span>
                </div>
              )}
            </div>
          );
        })}
          </div>

          <div className="add-browser-teammate">
            <label className="mcp-node-add">
              <Globe2 size={14} />
              <select
                value=""
                onChange={(event) => addBrowserTeammate(event.target.value)}
                disabled={busy !== "idle"}
                aria-label="Add a browser teammate"
              >
                <option value="">Add browser teammate</option>
                <option value={BROWSER_READ_TOOL}>Inspect a website</option>
                <option value={BROWSER_ACT_TOOL}>Act in a browser</option>
              </select>
            </label>
          </div>

          {(runStatus !== "idle" || recoverableRun) && (
        <section className="local-run-panel" aria-label="Local Agent Team activity" aria-live="polite">
          <header>
            <span><Terminal size={15} /> Local activity</span>
            <div>
              <span className="local-run-state" data-status={runStatus}>
                {runStatus === "awaiting-approval" ? "Review needed" : runStatus}
              </span>
              {(runStatus === "running" || runStatus === "awaiting-approval") && (
                <button className="icon-button compact" onClick={() => void onCancel()} aria-label="Stop local run" title="Stop local run">
                  <CircleStop size={15} />
                </button>
              )}
            </div>
          </header>

          {recoverableRun && busy === "idle" && runStatus === "halted" && (
            <div className="local-resume">
              <div>
                <strong>{recoverableRun.awaitingApproval ? "Review is waiting" : "Saved run can continue"}</strong>
                <span>
                  {recoverableRun.awaitingApproval
                    ? "Resume to review the exact paused step."
                    : "Continue from the latest encrypted checkpoint."}
                </span>
              </div>
              <button className="button primary" onClick={() => void onResume()}>
                <Play size={15} fill="currentColor" /> Resume
              </button>
            </div>
          )}

          {approval && (
            <div className="local-approval">
              <ShieldCheck size={18} />
              <div>
                <strong>Review {approval.title}</strong>
                <span>{approval.actor} is ready to use {approval.tools.join(", ") || "a local action"}.</span>
                {approval.preparationError && <span className="approval-error">{approval.preparationError}</span>}
              </div>
              <div className="local-approval-actions">
                <button className="button secondary" onClick={() => onApprovalDecision("hold")}>Hold</button>
                <button className="button primary" onClick={() => onApprovalDecision("approve")} disabled={!approval.canApprove}>Approve</button>
              </div>
              {approval.preview.length > 0 && (
                <pre className="local-approval-preview">{approval.preview.join("\n\n")}</pre>
              )}
            </div>
          )}

          <div className="local-run-log">
            {runEvents.slice(-10).map((event) => (
              <div key={`${event.sequence}-${event.createdAt}`} data-type={event.eventType}>
                <span>{event.eventType === "message" ? "›" : "•"}</span>
                <p>{event.message}</p>
              </div>
            ))}
          </div>
        </section>
          )}
        </div>
        {browserAgent && browserReference && (
          <LocalBrowserPanel
            sessionId={localBrowserSessionId(artifact.artifactId)}
            projectId={artifact.projectId}
            initialUrl={browserUrl}
            allowedDomains={browserAllowedDomains}
            obscured={browserObscured}
            disabled={busy !== "idle"}
            onRequestCloudBrowser={onRequestCloudBrowser}
          />
        )}
      </div>
    </section>
  );
}
