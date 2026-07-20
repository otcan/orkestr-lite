import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recoverStaleChromiumProfile } from "./chromium-profile.js";

test("removes only stale Chromium singleton links from an older container", () => {
  const directory = mkdtempSync(join(tmpdir(), "orkestr-chromium-profile-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  symlinkSync("old-container-1989", join(profile, "SingletonLock"));
  symlinkSync(
    join(directory, "missing", "SingletonSocket"),
    join(profile, "SingletonSocket"),
  );
  symlinkSync("cookie", join(profile, "SingletonCookie"));

  try {
    const result = recoverStaleChromiumProfile(profile, {
      currentHostname: "current-container",
      profileProcessRunning: () => false,
      processAlive: () => false,
    });
    assert.deepEqual(result, {
      removed: ["SingletonCookie", "SingletonLock", "SingletonSocket"],
      reason: "stale",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves singleton links while the profile or lock owner is active", () => {
  const directory = mkdtempSync(join(tmpdir(), "orkestr-chromium-profile-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  symlinkSync("current-container-42", join(profile, "SingletonLock"));
  symlinkSync("missing-socket", join(profile, "SingletonSocket"));

  try {
    assert.equal(
      recoverStaleChromiumProfile(profile, {
        currentHostname: "current-container",
        profileProcessRunning: () => true,
      }).reason,
      "active",
    );
    assert.equal(
      readlinkSync(join(profile, "SingletonLock")),
      "current-container-42",
    );

    assert.equal(
      recoverStaleChromiumProfile(profile, {
        currentHostname: "current-container",
        profileProcessRunning: () => false,
        processAlive: () => true,
      }).reason,
      "active",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not remove ambiguous regular singleton files", () => {
  const directory = mkdtempSync(join(tmpdir(), "orkestr-chromium-profile-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, "SingletonLock"), "unknown lock format");

  try {
    const result = recoverStaleChromiumProfile(profile, {
      profileProcessRunning: () => false,
    });
    assert.deepEqual(result, { removed: [], reason: "ambiguous" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("removes a dead current-container lock when its socket has no listener", () => {
  const directory = mkdtempSync(join(tmpdir(), "orkestr-chromium-profile-"));
  const profile = join(directory, "profile");
  const socket = join(directory, "orphaned-socket");
  mkdirSync(profile);
  writeFileSync(socket, "orphaned");
  symlinkSync("current-container-42", join(profile, "SingletonLock"));
  symlinkSync(socket, join(profile, "SingletonSocket"));

  try {
    const result = recoverStaleChromiumProfile(profile, {
      currentHostname: "current-container",
      profileProcessRunning: () => false,
      processAlive: () => false,
      socketActive: () => false,
    });
    assert.deepEqual(result, {
      removed: ["SingletonLock", "SingletonSocket"],
      reason: "stale",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
