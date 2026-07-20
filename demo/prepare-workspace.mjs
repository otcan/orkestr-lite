import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const requested = process.argv[2] ?? process.env.ORKESTR_DEMO_WORKSPACE;
assert.ok(
  requested,
  "Set ORKESTR_DEMO_WORKSPACE to an absolute disposable host directory",
);
assert.ok(isAbsolute(requested), "ORKESTR_DEMO_WORKSPACE must be absolute");

const workspace = resolve(requested);
assert.notEqual(workspace, "/", "Refusing to use the filesystem root");
assert.notEqual(workspace, "/workspace", "Use a host path, not /workspace");
assert.ok(
  workspace.includes("orkestr") && workspace.includes("demo"),
  "The disposable path must contain both 'orkestr' and 'demo'",
);

await mkdir(workspace, { recursive: true, mode: 0o700 });
const canonical = await realpath(workspace);
assert.notEqual(
  canonical,
  "/",
  "Refusing a path resolving to the filesystem root",
);
await mkdir(join(canonical, ".orkestr"), { recursive: true, mode: 0o700 });
await writeFile(
  join(canonical, ".orkestr-demo-disposable"),
  "orkestr-lite-demo-v0.2\n",
  { mode: 0o600 },
);
process.stdout.write(
  `${JSON.stringify({ prepared: true, workspace, canonical }, null, 2)}\n`,
);
