import { Network, Play, Save } from "lucide-react";
import { useEffect, useState } from "react";
import EnginePicker from "../components/EnginePicker";
import type {
  ArchitecturePayload,
  IntelligenceSelection,
  LocalArtifactVersion,
  ProviderProbe,
} from "../contracts";
import { isRecord } from "../contracts";

interface ArchitectureWorkbenchProps {
  artifact: LocalArtifactVersion;
  providers: ProviderProbe[];
  engine: IntelligenceSelection | null;
  saving: boolean;
  running: boolean;
  onEngineChange: (selection: IntelligenceSelection) => void;
  onRun: (task: string) => Promise<void>;
  onSave: (title: string, payload: ArchitecturePayload) => Promise<void>;
}

function readArchitecture(value: unknown): ArchitecturePayload {
  const payload = isRecord(value) ? value : {};
  return {
    summary: typeof payload.summary === "string" ? payload.summary : "",
    components: Array.isArray(payload.components)
      ? payload.components.flatMap((component) => {
          if (!isRecord(component) || typeof component.id !== "string" || typeof component.name !== "string") {
            return [];
          }
          return [{
            id: component.id,
            name: component.name,
            detail: typeof component.detail === "string" ? component.detail : "",
          }];
        })
      : [],
  };
}

export default function ArchitectureWorkbench({
  artifact,
  providers,
  engine,
  saving,
  running,
  onEngineChange,
  onRun,
  onSave,
}: ArchitectureWorkbenchProps) {
  const [title, setTitle] = useState(artifact.title);
  const [architecture, setArchitecture] = useState(() => readArchitecture(artifact.payload));

  useEffect(() => {
    setTitle(artifact.title);
    setArchitecture(readArchitecture(artifact.payload));
  }, [artifact]);

  const updateComponent = (id: string, updates: Partial<ArchitecturePayload["components"][number]>) => {
    setArchitecture((current) => ({
      ...current,
      components: current.components.map((component) =>
        component.id === id ? { ...component, ...updates } : component,
      ),
    }));
  };

  return (
    <section className="workbench" aria-labelledby="architecture-title">
      <header className="workbench-header">
        <div className="workbench-heading">
          <span className="workbench-icon architecture"><Network size={18} /></span>
          <div>
            <span className="eyebrow">Architecture</span>
            <input
              id="architecture-title"
              className="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Architecture title"
            />
          </div>
        </div>
        <div className="workbench-actions">
          <EnginePicker providers={providers} value={engine} onChange={onEngineChange} compact />
          <button className="button secondary" onClick={() => void onSave(title, architecture)} disabled={saving || running}>
            {saving ? <span className="spinner" /> : <Save size={16} />}
            Save
          </button>
          <button
            className="button primary"
            onClick={() => void onRun(`Review this architecture and return its strongest next actions: ${JSON.stringify(architecture)}`)}
            disabled={saving || running || !engine}
          >
            {running ? <span className="spinner dark" /> : <Play size={16} fill="currentColor" />}
            Run
          </button>
        </div>
      </header>
      <label className="field-label" htmlFor="architecture-summary">System boundary</label>
      <textarea
        id="architecture-summary"
        className="goal-input"
        rows={2}
        value={architecture.summary}
        onChange={(event) => setArchitecture({ ...architecture, summary: event.target.value })}
      />
      <div className="architecture-flow" aria-label="Architecture flow">
        {architecture.components.map((component, index) => (
          <div className="architecture-stage" key={component.id}>
            <article className="architecture-node">
              <input
                value={component.name}
                onChange={(event) => updateComponent(component.id, { name: event.target.value })}
                aria-label={`Name for component ${index + 1}`}
              />
              <textarea
                rows={3}
                value={component.detail}
                onChange={(event) => updateComponent(component.id, { detail: event.target.value })}
                aria-label={`Details for ${component.name}`}
              />
            </article>
            {index < architecture.components.length - 1 && (
              <span className="architecture-connector" aria-hidden="true">→</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
