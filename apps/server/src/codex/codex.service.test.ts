import assert from "node:assert/strict";
import test from "node:test";
import type { CodexNotification } from "@orkestr/codex-client";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { CodexService } from "./codex.service.js";

const config: RuntimeConfig = {
  host: "127.0.0.1",
  port: 3000,
  home: "/tmp/orkestr-test",
  codexHome: "/tmp/orkestr-test/codex",
  workspace: "/tmp/orkestr-test/workspace",
  filesRoot: "/",
  databasePath: "/tmp/orkestr-test/orkestr.sqlite",
  requestedModel: "gpt-5.6",
  cookieSecure: false,
  allowedOrigins: [],
  codexCommand: "codex",
  codexVersion: "0.144.5",
  publicDir: "/tmp/orkestr-test/public",
};

test("clears device auth state and refreshes models after account updates", async () => {
  const service = new CodexService(config);
  const internals = service as unknown as {
    status: {
      login: {
        state: "waiting";
        loginId: string;
        verificationUrl: string;
        userCode: string;
        expiresAt: string;
        error: null;
      };
    };
    handleNotification(notification: CodexNotification): void;
  };
  internals.status.login = {
    state: "waiting",
    loginId: "login-1",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    expiresAt: "2026-07-21T12:15:00.000Z",
    error: null,
  };

  let refreshes = 0;
  service.refreshAccountAndModels = async () => {
    refreshes += 1;
  };

  internals.handleNotification({
    method: "account/login/completed",
    params: { loginId: "login-1", success: true },
  });
  internals.handleNotification({
    method: "account/updated",
    params: { authMode: "chatgpt", planType: "pro" },
  });
  await Promise.resolve();

  const status = service.snapshot();
  assert.equal(status.authenticated, true);
  assert.equal(status.authMode, "chatgpt");
  assert.equal(status.login.state, "succeeded");
  assert.equal(status.login.loginId, null);
  assert.equal(status.login.verificationUrl, null);
  assert.equal(status.login.userCode, null);
  assert.equal(status.login.expiresAt, null);
  assert.equal(refreshes, 2);
});

test("ignores completion notifications from superseded device codes", () => {
  const service = new CodexService(config);
  const internals = service as unknown as {
    status: {
      login: {
        state: "waiting" | "failed";
        loginId: string;
        verificationUrl: string;
        userCode: string;
        expiresAt: string;
        error: string | null;
      };
    };
    handleNotification(notification: CodexNotification): void;
  };
  internals.status.login = {
    state: "waiting",
    loginId: "login-new",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "NEWC-ODE12",
    expiresAt: "2026-07-21T12:15:00.000Z",
    error: null,
  };

  internals.handleNotification({
    method: "account/login/completed",
    params: {
      loginId: "login-old",
      success: false,
      error: "Login was not completed",
    },
  });

  const status = service.snapshot();
  assert.equal(status.login.state, "waiting");
  assert.equal(status.login.loginId, "login-new");
  assert.equal(status.login.userCode, "NEWC-ODE12");
  assert.equal(status.login.error, null);
});

test("publishes an expiry and rotates a device code before it expires", async () => {
  const service = new CodexService(config);
  let attempts = 0;
  const internals = service as unknown as {
    client: {
      loginDeviceCode(): Promise<{
        type: "chatgptDeviceCode";
        loginId: string;
        verificationUrl: string;
        userCode: string;
      }>;
    };
    status: { process: "ready" };
    deviceLoginRefreshTimer: NodeJS.Timeout | null;
    clearDeviceLoginRefresh(): void;
    rotateDeviceLogin(loginId: string): Promise<void>;
  };
  internals.client = {
    loginDeviceCode: async () => {
      attempts += 1;
      return {
        type: "chatgptDeviceCode",
        loginId: `login-${attempts}`,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: attempts === 1 ? "ABCD-EFGH1" : "IJKL-MNOP9",
      };
    },
  };
  internals.status.process = "ready";

  const before = Date.now();
  await service.startDeviceLogin();
  const status = service.snapshot();
  const expiresAt = Date.parse(status.login.expiresAt ?? "");

  assert.equal(status.login.state, "waiting");
  assert.equal(status.login.loginId, "login-1");
  assert.ok(expiresAt >= before + 15 * 60_000);
  assert.ok(expiresAt <= Date.now() + 15 * 60_000);
  assert.notEqual(internals.deviceLoginRefreshTimer, null);

  await internals.rotateDeviceLogin("login-1");
  const rotated = service.snapshot();
  assert.equal(rotated.login.loginId, "login-2");
  assert.equal(rotated.login.userCode, "IJKL-MNOP9");
  assert.equal(attempts, 2);
  internals.clearDeviceLoginRefresh();
});
