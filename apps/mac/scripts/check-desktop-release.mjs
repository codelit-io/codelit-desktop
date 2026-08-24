import { inspectReleaseReadiness, parseReleaseArguments } from "./release-support.mjs";

const options = parseReleaseArguments(process.argv.slice(2));
const report = inspectReleaseReadiness(options);

if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`Codelit for Mac ${report.version} (${report.target})\n`);
  for (const channel of report.reports) {
    process.stdout.write(`\n${channel.channel}: ${channel.ready ? "ready" : "blocked"} (${channel.mode})\n`);
    for (const issue of channel.missing) process.stdout.write(`- ${issue}\n`);
  }
}

if (!report.ready) process.exitCode = 1;
