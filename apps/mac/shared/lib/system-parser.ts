export interface SystemNode {
  id: string;
  label: string;
  type: "frontend" | "backend" | "database" | "queue" | "cache" | "external" | "cdn" | "service";
  description: string;
}

export interface SystemEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  protocol?: string;
  dataFlow: "high" | "medium" | "low";
}

export interface SystemArchitecture {
  title: string;
  description: string;
  nodes: SystemNode[];
  edges: SystemEdge[];
}

const VALID_NODE_TYPES = new Set(["frontend", "backend", "database", "queue", "cache", "external", "cdn", "service"]);

function cleanJsonString(text: string): string {
  let s = text;

  // Strip thinking/reasoning tags from various models
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  s = s.replace(/<output>[\s\S]*?<\/output>/gi, (m) => m.replace(/<\/?output>/gi, ""));

  // Strip markdown prose before/after JSON
  // Try ```json block first
  const jsonBlock = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonBlock) return jsonBlock[1].trim();

  // Try to find the outermost { ... } containing "nodes"
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = s.slice(firstBrace, lastBrace + 1);
    if (candidate.includes('"nodes"') || candidate.includes("'nodes'")) {
      return candidate;
    }
  }

  return s.trim();
}

function fixCommonJsonIssues(text: string): string {
  let s = text;

  // Fix trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, "$1");

  // Fix single quotes used instead of double quotes (rough)
  // Only do this if there are no double quotes at all
  if (!s.includes('"') && s.includes("'")) {
    s = s.replace(/'/g, '"');
  }

  // Remove comments (// style)
  s = s.replace(/\/\/[^\n]*/g, "");

  return s;
}

function inferNodeType(label: string, description: string): SystemNode["type"] {
  const text = `${label} ${description}`.toLowerCase();
  if (text.match(/frontend|client|ui|app|web|react|next|vue|angular|browser/)) return "frontend";
  if (text.match(/database|db|postgres|mysql|mongo|dynamo|supabase|firestore|sql/)) return "database";
  if (text.match(/cache|redis|memcache|elasticache/)) return "cache";
  if (text.match(/queue|kafka|rabbit|sqs|pubsub|event bus|message/)) return "queue";
  if (text.match(/cdn|cloudfront|cloudflare|edge|static/)) return "cdn";
  if (text.match(/external|third.?party|stripe|twilio|sendgrid|api gateway|gateway/)) return "external";
  if (text.match(/api|server|backend|express|fastify|node|django|flask|rest|graphql/)) return "backend";
  return "service";
}

function repairTruncatedJson(text: string): string | null {
  // If JSON was cut off mid-stream, try to close it properly
  let s = text.trim();

  // Remove any trailing incomplete string (cut off in the middle of a value)
  // Find the last complete property by looking for the last complete "key": "value" or "key": number
  const lastCompleteComma = s.lastIndexOf(",");
  const lastCloseBrace = s.lastIndexOf("}");
  const lastCloseBracket = s.lastIndexOf("]");

  // If the text ends mid-string (no closing quote), truncate to last comma
  if (lastCompleteComma > lastCloseBrace && lastCompleteComma > lastCloseBracket) {
    s = s.slice(0, lastCompleteComma);
  }

  // Remove trailing commas
  s = s.replace(/,\s*$/, "");

  // Count unclosed brackets and braces
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escaped = false;

  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") braces++;
    if (ch === "}") braces--;
    if (ch === "[") brackets++;
    if (ch === "]") brackets--;
  }

  // Close unclosed strings
  if (inString) s += '"';

  // Close brackets and braces
  while (brackets > 0) { s += "]"; brackets--; }
  while (braces > 0) { s += "}"; braces--; }

  // Verify it's now valid
  try {
    JSON.parse(s);
    return s;
  } catch {
    return null;
  }
}

export function parseSystemResponse(text: string): SystemArchitecture | null {
  try {
    const cleaned = cleanJsonString(text);
    const fixed = fixCommonJsonIssues(cleaned);

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(fixed);
    } catch {
      // Try to repair truncated JSON (response cut off mid-stream)
      const repaired = repairTruncatedJson(fixed);
      if (repaired) {
        try {
          data = JSON.parse(repaired);
        } catch {
          // Fall through to desperate match
          data = null as unknown as Record<string, unknown>;
        }
      } else {
        data = null as unknown as Record<string, unknown>;
      }

      if (!data) {
        // Last resort: try to extract any JSON-like object
        const desperate = fixed.match(/\{[\s\S]*\}/);
        if (!desperate) {
          return null;
        }
        try {
          const repairedDesperate = repairTruncatedJson(fixCommonJsonIssues(desperate[0]));
          data = JSON.parse(repairedDesperate || fixCommonJsonIssues(desperate[0]));
        } catch {
          return null;
        }
      }
    }

    // Handle nested structures (some models wrap in { "architecture": { ... } })
    if (!data.nodes && (data as Record<string, unknown>).architecture) {
      data = (data as Record<string, Record<string, unknown>>).architecture;
    }
    if (!data.nodes && (data as Record<string, unknown>).system) {
      data = (data as Record<string, Record<string, unknown>>).system;
    }

    if (!data.nodes || !Array.isArray(data.nodes)) {
      return null;
    }

    if (data.nodes.length === 0) {
      return null;
    }

    // Build edges array (handle missing)
    const rawEdges = Array.isArray(data.edges) ? data.edges :
      Array.isArray(data.connections) ? data.connections :
      Array.isArray(data.links) ? data.links : [];

    // Parse nodes with type inference
    const nodes: SystemNode[] = data.nodes.map((n: Record<string, unknown>, i: number) => {
      const label = String(n.label || n.name || n.title || `Node ${i + 1}`);
      const description = String(n.description || n.desc || n.details || "");
      const rawType = String(n.type || n.category || "");
      const type = VALID_NODE_TYPES.has(rawType) ? rawType as SystemNode["type"] : inferNodeType(label, description);

      return {
        id: String(n.id || `node-${i}`),
        label,
        type,
        description,
      };
    });

    const nodeIds = new Set(nodes.map((n) => n.id));

    // Parse edges with flexible field names
    const edges: SystemEdge[] = rawEdges
      .map((e: Record<string, unknown>, i: number) => ({
        id: String(e.id || `edge-${i}`),
        from: String(e.from || e.source || e.src || ""),
        to: String(e.to || e.target || e.dest || e.destination || ""),
        label: String(e.label || e.description || e.name || ""),
        protocol: e.protocol ? String(e.protocol) : undefined,
        dataFlow: (["high", "medium", "low"].includes(String(e.dataFlow || e.flow || ""))
          ? String(e.dataFlow || e.flow) : "medium") as SystemEdge["dataFlow"],
      }))
      .filter((e: SystemEdge) => e.from && e.to && nodeIds.has(e.from) && nodeIds.has(e.to));

    return {
      title: String(data.title || data.name || "System Architecture"),
      description: String(data.description || data.summary || data.overview || ""),
      nodes,
      edges,
    };
  } catch (err) {
    console.error("Failed to parse system response:", err);
    return null;
  }
}
