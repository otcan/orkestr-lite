import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = new Set(process.argv.slice(2));
const allowedOptions = new Set(["--all-stopped", "--dry-run"]);
const unknownOptions = [...options].filter(
  (option) => !allowedOptions.has(option),
);

if (unknownOptions.length > 0) {
  throw new Error(`Unknown option(s): ${unknownOptions.join(", ")}`);
}

const allStopped = options.has("--all-stopped");
const dryRun = options.has("--dry-run");
const containers = await listContainers();
const stopped = containers.filter((container) =>
  ["created", "exited", "dead"].includes(container.State),
);
const candidates = allStopped
  ? stopped
  : stopped.filter(isOrkestrEphemeralContainer);

if (candidates.length === 0) {
  console.log(
    allStopped
      ? "No stopped Docker containers found."
      : "No stopped Orkestr smoke containers found.",
  );
  process.exitCode = 0;
} else {
  console.log(
    `${dryRun ? "Would remove" : "Removing"} ${candidates.length} stopped container(s):`,
  );
  for (const container of candidates) {
    console.log(`- ${container.Names} (${container.ID}, ${container.State})`);
  }

  if (!dryRun) {
    await docker(["rm", ...candidates.map((container) => container.ID)]);
    console.log(
      "Cleanup complete. Named volumes, images, and running containers were preserved.",
    );
  }
}

async function listContainers() {
  const result = await docker(["ps", "--all", "--format", "{{json .}}"]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function isOrkestrEphemeralContainer(container) {
  const name = String(container.Names ?? "");
  const labels = String(container.Labels ?? "");
  return (
    name.startsWith("orkestr-lite-smoke-") ||
    name.startsWith("orkestr-pair-") ||
    labels.includes("dev.orkestr-lite.ephemeral=true") ||
    labels.includes("com.docker.compose.project=orkestr-pair-")
  );
}

async function docker(args) {
  return execFileAsync("docker", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}
