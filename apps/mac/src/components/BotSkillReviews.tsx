import { Check, PackageOpen, ShieldCheck, X } from "lucide-react";
import type { BotSkill, BotSkillField } from "../contracts";

interface BotSkillReviewsProps {
  skills: BotSkill[];
  workingId: string | null;
  onReview: (skill: BotSkill, decision: "approve" | "discard") => void;
}

function fieldSummary(field: BotSkillField) {
  return [
    field.label,
    field.type,
    field.required ? "required" : "optional",
    ...(field.options?.length ? [field.options.join(" / ")] : []),
  ].join(" · ");
}

export default function BotSkillReviews({ skills, workingId, onReview }: BotSkillReviewsProps) {
  return (
    <section className="bot-skill-reviews" aria-label="Imported skills waiting for review">
      <header>
        <PackageOpen size={15} aria-hidden="true" />
        <span>Skill package review</span>
      </header>
      {skills.map((skill) => {
        const busy = workingId === skill.id;
        return (
          <article key={skill.id} className="bot-skill-review-card">
            <div className="bot-skill-review-copy">
              <strong>{skill.name}</strong>
              <p>{skill.description}</p>
            </div>
            <div className="bot-skill-review-facts" aria-label={`${skill.name} package contract`}>
              <span>{skill.inputSchema.length} {skill.inputSchema.length === 1 ? "input" : "inputs"}</span>
              <span>{skill.effects.length} {skill.effects.length === 1 ? "effect" : "effects"}</span>
              <span>{skill.checks.length} {skill.checks.length === 1 ? "check" : "checks"}</span>
            </div>
            <dl className="bot-skill-review-contract">
              <div>
                <dt>Instructions</dt>
                <dd>{skill.instructions}</dd>
              </div>
              <div>
                <dt>Inputs</dt>
                <dd>{skill.inputSchema.length
                  ? skill.inputSchema.map(fieldSummary).join(", ")
                  : "None"}</dd>
              </div>
              <div>
                <dt>Outputs</dt>
                <dd>{skill.outputSchema.length
                  ? skill.outputSchema.map(fieldSummary).join(", ")
                  : "None"}</dd>
              </div>
              <div>
                <dt>Checks</dt>
                <dd>{skill.checks.length ? skill.checks.map((check) => check.label).join(", ") : "None"}</dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>{skill.requiredPermissions.length ? skill.requiredPermissions.join(", ") : "No additional access"}</dd>
              </div>
            </dl>
            {skill.effects.length > 0 && (
              <ul className="bot-skill-review-effects">
                {skill.effects.map((effect) => (
                  <li key={effect.id}>
                    <ShieldCheck size={13} aria-hidden="true" />
                    <span>{effect.label}</span>
                    <small>{effect.kind} · {effect.target} · {effect.risk}</small>
                  </li>
                ))}
              </ul>
            )}
            <div className="bot-skill-review-actions">
              <button
                type="button"
                className="bot-secondary-action"
                disabled={Boolean(workingId)}
                onClick={() => onReview(skill, "discard")}
              >
                <X size={14} aria-hidden="true" /> Discard
              </button>
              <button
                type="button"
                className="bot-primary-action"
                disabled={Boolean(workingId)}
                onClick={() => onReview(skill, "approve")}
              >
                <Check size={14} aria-hidden="true" /> {busy ? "Approving..." : "Approve skill"}
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}
