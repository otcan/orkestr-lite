import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const demoDirectory = resolve(
  fileURLToPath(new URL("./workspace", import.meta.url)),
);
const targetDirectory = resolve(
  process.argv[2] ?? new URL("../workspace", import.meta.url).pathname,
);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

if (
  targetDirectory === repositoryRoot ||
  !targetDirectory.startsWith(`${repositoryRoot}/`)
) {
  throw new Error(
    `Refusing to reset a directory outside this repository: ${targetDirectory}`,
  );
}

await mkdir(targetDirectory, { recursive: true });
for (const entry of await readdir(targetDirectory)) {
  await rm(resolve(targetDirectory, entry), { recursive: true, force: true });
}
await cp(demoDirectory, targetDirectory, { recursive: true });
process.stdout.write(`Demo workspace reset at ${targetDirectory}\n`);
