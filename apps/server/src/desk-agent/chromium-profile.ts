import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

const SINGLETON_NAMES = [
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
] as const;

export interface ChromiumProfileRecovery {
  removed: string[];
  reason: "active" | "ambiguous" | "clean" | "stale";
}

export interface ChromiumProfileRecoveryOptions {
  currentHostname?: string;
  profileProcessRunning?: (profile: string) => boolean;
  processAlive?: (pid: number) => boolean;
  socketActive?: (path: string) => boolean;
}

/**
 * Removes Chromium singleton links only when no process owns this profile and
 * both the lock owner and socket prove that the profile belongs to a dead
 * process/container. The profile contents are otherwise left untouched.
 */
export function recoverStaleChromiumProfile(
  profile: string,
  options: ChromiumProfileRecoveryOptions = {},
): ChromiumProfileRecovery {
  const profileProcessRunning =
    options.profileProcessRunning ?? chromiumProfileProcessRunning;
  if (profileProcessRunning(profile)) {
    return { removed: [], reason: "active" };
  }

  const lockPath = resolve(profile, "SingletonLock");
  const socketPath = resolve(profile, "SingletonSocket");
  const lockState = singletonLockState(
    lockPath,
    options.currentHostname ?? hostname(),
    options.processAlive ?? localProcessAlive,
  );
  const socketState = singletonSocketState(
    socketPath,
    options.socketActive ?? unixSocketActive,
  );

  if (lockState === "active") {
    return { removed: [], reason: "active" };
  }
  if (lockState === "ambiguous" || socketState === "ambiguous") {
    return { removed: [], reason: "ambiguous" };
  }
  if (lockState === "missing" && socketState === "missing") {
    const cookie = resolve(profile, "SingletonCookie");
    if (!pathExists(cookie)) return { removed: [], reason: "clean" };
  }

  const removed: string[] = [];
  for (const name of SINGLETON_NAMES) {
    const path = resolve(profile, name);
    if (!pathExists(path)) continue;
    rmSync(path, { force: true });
    removed.push(name);
  }
  return { removed, reason: removed.length ? "stale" : "clean" };
}

export function chromiumProfileProcessRunning(profile: string): boolean {
  const pattern = `chromium.*--user-data-dir=${escapeRegex(profile)}`;
  return (
    spawnSync("pgrep", ["-f", "--", pattern], {
      stdio: "ignore",
      timeout: 2_000,
    }).status === 0
  );
}

function singletonLockState(
  path: string,
  currentHostname: string,
  processAlive: (pid: number) => boolean,
): "active" | "ambiguous" | "missing" | "stale" {
  const target = linkTarget(path);
  if (target === null) return pathExists(path) ? "ambiguous" : "missing";
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match) return "ambiguous";
  const ownerHostname = match[1] as string;
  const ownerPid = Number(match[2]);
  if (ownerHostname !== currentHostname) return "stale";
  return processAlive(ownerPid) ? "active" : "stale";
}

function singletonSocketState(
  path: string,
  socketActive: (path: string) => boolean,
): "ambiguous" | "missing" | "stale" {
  const target = linkTarget(path);
  if (target === null) return pathExists(path) ? "ambiguous" : "missing";
  const targetPath = isAbsolute(target)
    ? target
    : resolve(dirname(path), target);
  if (!existsSync(targetPath)) return "stale";
  return socketActive(targetPath) ? "ambiguous" : "stale";
}

function linkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return readlinkSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function localProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function unixSocketActive(path: string): boolean {
  return (
    spawnSync("nc", ["-zU", path], {
      stdio: "ignore",
      timeout: 2_000,
    }).status === 0
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
