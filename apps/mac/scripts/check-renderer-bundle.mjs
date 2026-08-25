import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const desktopRendererBundleBudget = {
  entryBytes: 500_000,
  initialGzipBytes: 150_000,
  largestDeferredGzipBytes: 55_000,
  // Typed native actions stay deferred; keep startup fixed while bounding the optional harness surface.
  totalGzipBytes: 218_000,
};

const requiredDeferredChunks = [
  "BotMarkdown-",
  "ProviderCenter-",
  "LocalBrowserPanel-",
  "BotBrowserTeachingActivity-",
  "BotBrowserSkillRunActivity-",
];

function assetRecord(distDirectory, reference) {
  const relative = reference.replace(/^\//, "");
  const path = resolve(distDirectory, relative);
  if (!existsSync(path)) throw new Error(`Desktop renderer asset is missing: ${relative}`);
  const body = readFileSync(path);
  return { name: basename(path), bytes: body.length, gzipBytes: gzipSync(body).length };
}

export function inspectDesktopRendererBundle(distDirectory) {
  const htmlPath = resolve(distDirectory, "index.html");
  if (!existsSync(htmlPath)) throw new Error("Build the desktop renderer before checking its bundle budget.");
  const html = readFileSync(htmlPath, "utf8");
  const entryReference = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  if (!entryReference) throw new Error("Desktop renderer index.html has no JavaScript entry.");
  const preloadReferences = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g)]
    .map((match) => match[1]);
  const initialReferences = [...new Set([entryReference, ...preloadReferences])];
  const initial = initialReferences.map((reference) => assetRecord(distDirectory, reference));
  const all = readdirSync(resolve(distDirectory, "assets"))
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => assetRecord(distDirectory, `/assets/${name}`));
  const initialNames = new Set(initial.map((asset) => asset.name));
  const deferred = all.filter((asset) => !initialNames.has(asset.name));
  const entry = initial.find((asset) => asset.name === basename(entryReference));
  if (!entry) throw new Error("Desktop renderer entry could not be measured.");
  return {
    entry,
    initial,
    deferred,
    initialGzipBytes: initial.reduce((total, asset) => total + asset.gzipBytes, 0),
    totalGzipBytes: all.reduce((total, asset) => total + asset.gzipBytes, 0),
    largestDeferredGzipBytes: Math.max(0, ...deferred.map((asset) => asset.gzipBytes)),
  };
}

export function desktopRendererBundleIssues(report, budget = desktopRendererBundleBudget) {
  const issues = [];
  if (report.entry.bytes > budget.entryBytes) {
    issues.push(`Entry is ${report.entry.bytes} bytes; budget is ${budget.entryBytes}.`);
  }
  if (report.initialGzipBytes > budget.initialGzipBytes) {
    issues.push(`Initial JavaScript is ${report.initialGzipBytes} bytes gzip; budget is ${budget.initialGzipBytes}.`);
  }
  if (report.largestDeferredGzipBytes > budget.largestDeferredGzipBytes) {
    issues.push(`Largest deferred chunk is ${report.largestDeferredGzipBytes} bytes gzip; budget is ${budget.largestDeferredGzipBytes}.`);
  }
  if (report.totalGzipBytes > budget.totalGzipBytes) {
    issues.push(`Total JavaScript is ${report.totalGzipBytes} bytes gzip; budget is ${budget.totalGzipBytes}.`);
  }
  for (const prefix of requiredDeferredChunks) {
    if (!report.deferred.some((asset) => asset.name.startsWith(prefix))) {
      issues.push(`${prefix.slice(0, -1)} must remain deferred from startup.`);
    }
  }
  return issues;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const distDirectory = resolve(dirname(scriptPath), "../dist");
  const report = inspectDesktopRendererBundle(distDirectory);
  const issues = desktopRendererBundleIssues(report);
  if (issues.length) {
    for (const issue of issues) process.stderr.write(`- ${issue}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ status: "passed", budget: desktopRendererBundleBudget, ...report }, null, 2)}\n`);
  }
}
