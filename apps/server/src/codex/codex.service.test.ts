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
    error: null,
  };

  let refreshes = 0;
  service.refreshAccountAndModels = async () => {
    refreshes += 1;
  };

  internals.handleNotification({
    method: "account/login/completed",
    params: { success: true },
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
  assert.equal(refreshes, 2);
});
