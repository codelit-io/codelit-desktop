import type { ProductBoard, ProductCard, ProductFlow } from "../stores/product-board-store";
import type { ProductSpec } from "./product-specs";

const VALID_TYPES = new Set(["feature", "user-story", "screen", "milestone", "requirement"]);
const VALID_PRIORITIES = new Set(["must-have", "should-have", "nice-to-have"]);

export function parseProductBoard(raw: string): ProductBoard | null {
  // Extract JSON from response
  let jsonStr = raw;
  const jsonBlock = raw.match(/```json\s*\n?([\s\S]*?)```/);
  if (jsonBlock) jsonStr = jsonBlock[1].trim();
  else {
    const rawJson = raw.match(/\{[\s\S]*"cards"[\s\S]*\}/);
    if (rawJson) jsonStr = rawJson[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);

    if (!parsed.title || !parsed.cards || !Array.isArray(parsed.cards)) {
      return null;
    }

    const cards: ProductCard[] = parsed.cards
      .filter((c: Record<string, unknown>) => c.id && c.title && c.type)
      .map((c: Record<string, unknown>) => ({
        id: String(c.id),
        type: VALID_TYPES.has(String(c.type)) ? String(c.type) as ProductCard["type"] : "feature",
        title: String(c.title),
        description: String(c.description || ""),
        priority: VALID_PRIORITIES.has(String(c.priority)) ? String(c.priority) as ProductCard["priority"] : "should-have",
        status: "idea" as const,
      }));

    const flows: ProductFlow[] = (parsed.flows || [])
      .filter((f: Record<string, unknown>) => f.id && f.from && f.to)
      .map((f: Record<string, unknown>) => ({
        id: String(f.id),
        from: String(f.from),
        to: String(f.to),
        label: String(f.label || ""),
      }));

    return {
      title: String(parsed.title),
      description: String(parsed.description || ""),
      targetAudience: String(parsed.targetAudience || ""),
      cards,
      flows,
    };
  } catch {
    return null;
  }
}

/** Convert an existing ProductSpec into a ProductBoard */
export function specToBoard(spec: ProductSpec): ProductBoard {
  const cards: ProductCard[] = [];

  // Features → feature cards
  spec.features.slice(0, 8).forEach((f, i) => {
    cards.push({
      id: `feature-${i}`,
      type: "feature",
      title: f.length > 60 ? f.slice(0, 57) + "..." : f,
      description: f,
      priority: i < 3 ? "must-have" : i < 6 ? "should-have" : "nice-to-have",
      status: "idea",
    });
  });

  // User stories → user-story cards
  spec.userStories.slice(0, 4).forEach((s, i) => {
    cards.push({
      id: `story-${i}`,
      type: "user-story",
      title: s.length > 60 ? s.slice(0, 57) + "..." : s,
      description: s,
      priority: i < 2 ? "must-have" : "should-have",
      status: "idea",
    });
  });

  // Milestones
  if (spec.milestones) {
    spec.milestones.slice(0, 3).forEach((m, i) => {
      cards.push({
        id: `milestone-${i}`,
        type: "milestone",
        title: `${m.phase}: ${m.title}`,
        description: m.features?.join(", ") || "",
        priority: "must-have",
        status: "idea",
      });
    });
  }

  // Non-functional → requirement cards
  if (spec.nonFunctional) {
    spec.nonFunctional.slice(0, 2).forEach((nf, i) => {
      cards.push({
        id: `req-${i}`,
        type: "requirement",
        title: nf.category,
        description: `${nf.requirement}. Target: ${nf.target}`,
        priority: "must-have",
        status: "idea",
      });
    });
  }

  return {
    title: spec.name,
    description: spec.description,
    targetAudience: spec.category,
    cards,
    flows: [],
  };
}
