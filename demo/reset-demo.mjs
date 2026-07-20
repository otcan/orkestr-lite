import { access, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const workspace = resolve(
  process.argv[2] ?? process.env.ORKESTR_DEMO_WORKSPACE ?? "/workspace",
);
const sentinel = join(workspace, ".orkestr-demo-disposable");
const expected = "orkestr-lite-demo-v0.2";

await access(sentinel).catch(() => {
  throw new Error(
    `Refusing to reset ${workspace}: create ${sentinel} containing ${expected} only for a disposable demo workspace`,
  );
});
const value = (await readFile(sentinel, "utf8")).trim();
if (value !== expected) {
  throw new Error(`Refusing to reset ${workspace}: demo sentinel is invalid`);
}

for (const target of [
  join(workspace, "reports/agent-runtime-landscape.md"),
  join(workspace, "reports/agent-runtime-landscape.html"),
  join(workspace, ".orkestr/demo-evidence-v0.2.json"),
]) {
  await rm(target, { force: true });
}
process.stdout.write(`Removed v0.2 demo artifacts from ${workspace}\n`);
