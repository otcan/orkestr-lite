import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import {
  CodexAppServerClient,
  type AccountReadResult,
  type CodexModel,
  type CodexNotification,
  type CodexServerRequest,
  type DeviceCodeLoginResult,
  type RequestId,
  type ThreadResult,
  type TurnResult,
} from "@orkestr/codex-client";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";

const execFileAsync = promisify(execFile);

interface CodexServiceEvents {
  notification: [notification: CodexNotification];
  serverRequest: [request: CodexServerRequest];
  ready: [];
  exit: [details: CodexExitDetails];
}

export interface CodexExitDetails {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface CodexStatus {
  process: "starting" | "ready" | "error";
  processError: string | null;
  retryAt: string | null;
  retryAttempt: number;
  lastConnectedAt: string | null;
  lastMessageAt: string | null;
  cliVersion: string | null;
  expectedVersion: string;
  transport: "local" | "desk";
  authenticated: boolean;
  authMode: string | null;
  accountEmail: string | null;
  planType: string | null;
  requestedModel: string;
  selectedModel: string | null;
  modelReady: boolean;
  models: Array<{
    id: string;
    model: string;
    displayName: string;
    hidden: boolean;
    isDefault: boolean;
    defaultReasoningEffort: string | null;
    supportedReasoningEfforts: Array<{
      reasoningEffort: string;
      description: string;
    }>;
  }>;
  login: {
    state: "idle" | "waiting" | "succeeded" | "failed";
    loginId: string | null;
    verificationUrl: string | null;
    userCode: string | null;
    error: string | null;
  };
}

@Injectable()
export class CodexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CodexService.name);
  private readonly events = new EventEmitter<CodexServiceEvents>();
  private client: CodexAppServerClient | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private shuttingDown = false;
  private deskSelected = false;
  private status: CodexStatus;

  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {
    this.status = {
      process: "starting",
      processError: null,
      retryAt: null,
      retryAttempt: 0,
      lastConnectedAt: null,
      lastMessageAt: null,
      cliVersion: null,
      expectedVersion: config.codexVersion,
      transport: "local",
      authenticated: false,
      authMode: null,
      accountEmail: null,
      planType: null,
      requestedModel: config.requestedModel,
      selectedModel: null,
      modelReady: false,
      models: [],
      login: {
        state: "idle",
        loginId: null,
        verificationUrl: null,
        userCode: null,
        error: null,
      },
    };
  }

  async onModuleInit(): Promise<void> {
    await this.startClient();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    await this.client?.stop();
  }

  snapshot(): CodexStatus {
    return structuredClone(this.status);
  }

  onNotification(
    listener: (notification: CodexNotification) => void,
  ): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  onServerRequest(listener: (request: CodexServerRequest) => void): () => void {
    this.events.on("serverRequest", listener);
    return () => this.events.off("serverRequest", listener);
  }

  onReady(listener: () => void): () => void {
    this.events.on("ready", listener);
    return () => this.events.off("ready", listener);
  }

  onExit(listener: (details: CodexExitDetails) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  async startDeviceLogin(): Promise<DeviceCodeLoginResult> {
    const client = this.requireClient();
    const result = await client.loginDeviceCode();
    this.status.login = {
      state: "waiting",
      loginId: result.loginId,
      verificationUrl: result.verificationUrl,
      userCode: result.userCode,
      error: null,
    };
    return result;
  }

  async loginApiKey(apiKey: string): Promise<void> {
    const client = this.requireClient();
    this.status.login = {
      state: "waiting",
      loginId: null,
      verificationUrl: null,
      userCode: null,
      error: null,
    };
    await client.loginApiKey(apiKey);
    await this.refreshAccountAndModels();
  }

  async refreshAccountAndModels(): Promise<void> {
    const client = this.requireClient();
    const account = await client.accountRead();
    this.applyAccount(account);
    if (!this.status.authenticated) {
      this.status.models = [];
      this.status.selectedModel = null;
      this.status.modelReady = false;
      return;
    }
    const models = await client.listModels();
    this.applyModels(models);
  }

  selectedModel(): string {
    if (!this.status.selectedModel) {
      throw new Error(
        "No eligible GPT-5.6 model is available for the authenticated account",
      );
    }
    return this.status.selectedModel;
  }

  startThread(params: {
    cwd: string;
    model: string;
    developerInstructions?: string;
  }): Promise<ThreadResult> {
    return this.requireClient().startThread({
      ...params,
      approvalPolicy: "never",
    });
  }

  resumeThread(threadId: string): Promise<ThreadResult> {
    return this.requireClient().resumeThread(threadId);
  }

  startTurn(params: {
    threadId: string;
    prompt: string;
    cwd: string;
    model: string;
    effort?: string;
    clientUserMessageId?: string;
    outputSchema?: unknown;
    additionalWritableRoots?: string[];
  }): Promise<TurnResult> {
    return this.requireClient().startTurn(params);
  }

  compactThread(threadId: string): Promise<Record<string, never>> {
    return this.requireClient().compactThread(threadId);
  }

  interruptTurn(
    threadId: string,
    turnId: string,
  ): Promise<Record<string, never>> {
    return this.requireClient().interruptTurn(threadId, turnId);
  }

  answerServerRequest(requestId: RequestId, result: unknown): void {
    this.requireClient().respond(requestId, result);
  }

  private async startClient(): Promise<void> {
    this.status.process = "starting";
    this.status.processError = null;
    try {
      const desk = await this.resolveDeskTransport();
      let cliVersion: string;
      if (desk) {
        cliVersion = desk.version;
        this.status.transport = "desk";
      } else {
        const { stdout } = await execFileAsync(
          this.config.codexCommand,
          ["--version"],
          { timeout: 10_000 },
        );
        cliVersion = stdout.trim().replace(/^codex-cli\s+/, "");
        this.status.transport = "local";
      }
      this.status.cliVersion = cliVersion;
      if (cliVersion !== this.config.codexVersion) {
        throw new Error(
          `Codex CLI version mismatch: expected ${this.config.codexVersion}, found ${cliVersion}`,
        );
      }

      const client = new CodexAppServerClient({
        command: this.config.codexCommand,
        cwd: this.config.workspace,
        codexHome: this.config.codexHome,
        expectedVersion: this.config.codexVersion,
        requestTimeoutMs: 45_000,
        remoteUrl: desk?.url,
        remoteToken: desk?.token,
      });
      client.on("notification", (notification) =>
        this.handleNotification(notification),
      );
      client.on("serverRequest", (request) =>
        this.events.emit("serverRequest", request),
      );
      client.on("stderr", (line) => this.logger.debug(line));
      client.on("exit", (code, signal) => {
        if (this.client === client) this.client = null;
        this.status.process = "error";
        this.status.processError = `Codex app-server exited (${code ?? signal ?? "unknown"})`;
        if (!this.shuttingDown) {
          this.events.emit("exit", { code, signal });
          this.scheduleRestart();
        }
      });
      await client.start();
      if (desk) this.deskSelected = true;
      this.client = client;
      this.status.process = "ready";
      this.status.retryAt = null;
      this.status.retryAttempt = 0;
      this.restartAttempt = 0;
      this.status.lastConnectedAt = new Date().toISOString();
      await this.refreshAccountAndModels();
      this.logger.log(`Codex app-server ${cliVersion} ready`);
      this.events.emit("ready");
    } catch (error) {
      this.status.process = "error";
      this.status.processError = errorMessage(error);
      this.logger.error(this.status.processError);
      if (!this.shuttingDown) this.scheduleRestart();
    }
  }

  private async resolveDeskTransport(): Promise<{
    url: string;
    token: string;
    version: string;
  } | null> {
    if (this.config.codexTransport === "local") return null;
    if (!this.config.deskUrl) {
      if (this.config.codexTransport === "desk") {
        throw new Error("Desk Codex transport is required but not configured");
      }
      return null;
    }
    try {
      const [response, token] = await Promise.all([
        fetch(`${this.config.deskUrl}/health`, {
          signal: AbortSignal.timeout(5_000),
        }),
        readFile(
          this.config.deskTokenFile ?? "/run/orkestr-desk-auth/token",
          "utf8",
        ),
      ]);
      if (!response.ok)
        throw new Error(`Desk health returned ${response.status}`);
      const health = (await response.json()) as { codexVersion?: unknown };
      const version =
        typeof health.codexVersion === "string"
          ? health.codexVersion.replace(/^codex-cli\s+/, "")
          : this.config.codexVersion;
      const websocketBase = this.config.deskUrl
        .replace(/^http:/, "ws:")
        .replace(/^https:/, "wss:");
      return {
        url: `${websocketBase}/codex`,
        token: token.trim(),
        version,
      };
    } catch (error) {
      if (this.config.codexTransport === "desk" || this.deskSelected) {
        throw new Error(
          `Desk Codex transport is unavailable: ${errorMessage(error)}`,
        );
      }
      return null;
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    this.restartAttempt += 1;
    const maximum = Math.min(
      5 * 60_000,
      5_000 * 2 ** Math.min(this.restartAttempt - 1, 6),
    );
    const delay = Math.max(
      1_000,
      Math.round(maximum * (0.5 + Math.random() * 0.5)),
    );
    this.status.retryAttempt = this.restartAttempt;
    this.status.retryAt = new Date(Date.now() + delay).toISOString();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startClient();
    }, delay);
  }

  private handleNotification(notification: CodexNotification): void {
    this.status.lastMessageAt = new Date().toISOString();
    if (notification.method === "account/login/completed") {
      const success = notification.params.success === true;
      this.status.login = {
        state: success ? "succeeded" : "failed",
        loginId: success ? null : this.status.login.loginId,
        verificationUrl: success ? null : this.status.login.verificationUrl,
        userCode: success ? null : this.status.login.userCode,
        error:
          typeof notification.params.error === "string"
            ? notification.params.error
            : null,
      };
      if (success) this.requestAuthenticationRefresh();
    }
    if (notification.method === "account/updated") {
      this.status.authMode = stringOrNull(notification.params.authMode);
      this.status.planType = stringOrNull(notification.params.planType);
      this.status.authenticated = this.status.authMode !== null;
      if (this.status.authenticated) {
        this.status.login = {
          state: "succeeded",
          loginId: null,
          verificationUrl: null,
          userCode: null,
          error: null,
        };
        this.requestAuthenticationRefresh();
      }
    }
    this.events.emit("notification", notification);
  }

  private requestAuthenticationRefresh(): void {
    void this.refreshAccountAndModels().catch((error) => {
      this.status.login.error = errorMessage(error);
      this.logger.warn(
        `Could not refresh the authenticated Codex account: ${this.status.login.error}`,
      );
    });
  }

  private applyAccount(result: AccountReadResult): void {
    this.status.authenticated = result.account !== null;
    this.status.authMode = result.account?.type ?? null;
    this.status.accountEmail = result.account?.email ?? null;
    this.status.planType = result.account?.planType ?? null;
  }

  private applyModels(models: CodexModel[]): void {
    this.status.models = models.map(
      ({
        id,
        model,
        displayName,
        hidden,
        isDefault,
        defaultReasoningEffort,
        supportedReasoningEfforts,
      }) => ({
        id,
        model,
        displayName,
        hidden,
        isDefault,
        defaultReasoningEffort: defaultReasoningEffort ?? null,
        supportedReasoningEfforts: supportedReasoningEfforts ?? [],
      }),
    );
    const requested = this.config.requestedModel.toLowerCase();
    const exact = models.find(
      (model) =>
        model.id.toLowerCase() === requested ||
        model.model.toLowerCase() === requested,
    );
    const family = models.find(
      (model) =>
        requested === "gpt-5.6" &&
        (model.id.toLowerCase().startsWith("gpt-5.6") ||
          model.model.toLowerCase().startsWith("gpt-5.6")),
    );
    const selected = exact ?? family ?? null;
    this.status.selectedModel = selected?.model ?? selected?.id ?? null;
    this.status.modelReady = selected !== null;
  }

  private requireClient(): CodexAppServerClient {
    if (!this.client || this.status.process !== "ready") {
      throw new Error(
        this.status.processError ?? "Codex app-server is not ready",
      );
    }
    return this.client;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
