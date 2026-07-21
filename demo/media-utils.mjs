import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function findBinary(name, explicit) {
  const candidates = [
    explicit,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    name,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    try {
      await execFileAsync(candidate, ["-version"], { maxBuffer: 1_000_000 });
      return candidate;
    } catch {}
  }
  throw new Error(`${name} is required; set ORKESTR_${name.toUpperCase()}`);
}

export async function mediaBinaries() {
  const ffmpeg = await findBinary("ffmpeg", process.env.ORKESTR_FFMPEG);
  const siblingProbe = ffmpeg.includes("/")
    ? join(dirname(ffmpeg), "ffprobe")
    : undefined;
  const ffprobe = await findBinary(
    "ffprobe",
    process.env.ORKESTR_FFPROBE ?? siblingProbe,
  );
  return { ffmpeg, ffprobe };
}

export async function run(binary, args, options = {}) {
  try {
    return await execFileAsync(binary, args, {
      maxBuffer: 20_000_000,
      ...options,
    });
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    throw new Error(`${binary} failed${stderr ? `:\n${stderr}` : ""}`, {
      cause: error,
    });
  }
}
