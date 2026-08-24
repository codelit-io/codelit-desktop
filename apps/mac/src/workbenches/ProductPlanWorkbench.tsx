import { ListChecks, Play, Save } from "lucide-react";
import { useEffect, useState } from "react";
import EnginePicker from "../components/EnginePicker";
import type {
  IntelligenceSelection,
  LocalArtifactVersion,
  ProductPlanPayload,
  ProviderProbe,
} from "../contracts";
import { isRecord } from "../contracts";

interface ProductPlanWorkbenchProps {
  artifact: LocalArtifactVersion;
  providers: ProviderProbe[];
  engine: IntelligenceSelection | null;
  saving: boolean;
  running: boolean;
  onEngineChange: (selection: IntelligenceSelection) => void;
  onRun: (task: string) => Promise<void>;
  onSave: (title: string, payload: ProductPlanPayload) => Promise<void>;
}

function readPlan(value: unknown): ProductPlanPayload {
  const payload = isRecord(value) ? value : {};
  return {
    problem: typeof payload.problem === "string" ? payload.problem : "",
    audience: typeof payload.audience === "string" ? payload.audience : "",
    outcomes: Array.isArray(payload.outcomes)
      ? payload.outcomes.filter((item): item is string => typeof item === "string")
      : [],
    milestones: Array.isArray(payload.milestones)
      ? payload.milestones.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export default function ProductPlanWorkbench({
  artifact,
  providers,
  engine,
  saving,
  running,
  onEngineChange,
  onRun,
  onSave,
}: ProductPlanWorkbenchProps) {
  const [title, setTitle] = useState(artifact.title);
  const [plan, setPlan] = useState(() => readPlan(artifact.payload));

  useEffect(() => {
    setTitle(artifact.title);
    setPlan(readPlan(artifact.payload));
  }, [artifact]);

  return (
    <section className="workbench" aria-labelledby="product-title">
      <header className="workbench-header">
        <div className="workbench-heading">
          <span className="workbench-icon product"><ListChecks size={18} /></span>
          <div>
            <span className="eyebrow">Product Plan</span>
            <input
              id="product-title"
              className="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Product Plan title"
            />
          </div>
        </div>
        <div className="workbench-actions">
          <EnginePicker providers={providers} value={engine} onChange={onEngineChange} compact />
          <button className="button secondary" onClick={() => void onSave(title, plan)} disabled={saving || running}>
            {saving ? <span className="spinner" /> : <Save size={16} />}
            Save
          </button>
          <button
            className="button primary"
            onClick={() => void onRun(`Review this product plan and return its strongest next actions: ${JSON.stringify(plan)}`)}
            disabled={saving || running || !engine}
          >
            {running ? <span className="spinner dark" /> : <Play size={16} fill="currentColor" />}
            Run
          </button>
        </div>
      </header>
      <div className="editor-grid two-column">
        <label className="editor-field wide">
          <span>Problem to solve</span>
          <textarea rows={3} value={plan.problem} onChange={(event) => setPlan({ ...plan, problem: event.target.value })} />
        </label>
        <label className="editor-field wide">
          <span>Who it is for</span>
          <input value={plan.audience} onChange={(event) => setPlan({ ...plan, audience: event.target.value })} />
        </label>
        <label className="editor-field">
          <span>Outcomes</span>
          <textarea
            rows={6}
            value={plan.outcomes.join("\n")}
            onChange={(event) => setPlan({
              ...plan,
              outcomes: event.target.value.split("\n").filter(Boolean),
            })}
          />
        </label>
        <label className="editor-field">
          <span>Milestones</span>
          <textarea
            rows={6}
            value={plan.milestones.join("\n")}
            onChange={(event) => setPlan({
              ...plan,
              milestones: event.target.value.split("\n").filter(Boolean),
            })}
          />
        </label>
      </div>
    </section>
  );
}
