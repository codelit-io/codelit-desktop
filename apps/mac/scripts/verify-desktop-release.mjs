import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReleaseDirectory } from "./desktop-release-provenance.mjs";
import { repositoryRoot } from "./release-support.mjs";

function parseArguments(arguments_) {
  const directory = arguments_[0];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: verify-desktop-release <directory> (--initial-release | --previous-manifest <path>)");
  const initialRelease = arguments_.includes("--initial-release");
  const previousIndex = arguments_.indexOf("--previous-manifest");
  const previousManifestPath = previousIndex >= 0 ? arguments_[previousIndex + 1] : undefined;
  const expectedLength = 1 + (initialRelease ? 1 : 0) + (previousManifestPath ? 2 : 0);
  if (arguments_.length !== expectedLength || initialRelease === Boolean(previousManifestPath)) {
    throw new Error("Choose exactly one of --initial-release or --previous-manifest <path>.");
  }
  return {
    directory: resolve(repositoryRoot, directory),
    initialRelease,
    previousManifestPath: previousManifestPath ? resolve(repositoryRoot, previousManifestPath) : undefined,
  };
}

export function verifyDesktopRelease(arguments_, environment = process.env) {
  const options = parseArguments(arguments_);
  const rustPath = `/opt/homebrew/opt/rustup/bin:${environment.PATH || ""}`;
  return verifyReleaseDirectory(options.directory, {
    previousManifestPath: options.previousManifestPath,
    initialRelease: options.initialRelease,
    environment: {
      ...environment,
      PATH: rustPath,
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = verifyDesktopRelease(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
