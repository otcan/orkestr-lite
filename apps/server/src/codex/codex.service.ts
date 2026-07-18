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
  cliVersion: string | null;
  expectedVersion: string;
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
  private shuttingDown = false;
  private status: CodexStatus;

  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {
    this.status = {
      process: "starting",
      processError: null,
      cliVersion: null,
      expectedVersion: config.codexVersion,
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

  startThread(params: { cwd: string; model: string }): Promise<ThreadResult> {
    return this.requireClient().startThread({
      ...params,
      approvalPolicy: "on-request",
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
  }): Promise<TurnResult> {
    return this.requireClient().startTurn(params);
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
      const { stdout } = await execFileAsync(
        this.config.codexCommand,
        ["--version"],
        {
          timeout: 10_000,
        },
      );
      const cliVersion = stdout.trim().replace(/^codex-cli\s+/, "");
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
      this.client = client;
      this.status.process = "ready";
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

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startClient();
    }, 5_000);
  }

  private handleNotification(notification: CodexNotification): void {
    if (notification.method === "account/login/completed") {
      const success = notification.params.success === true;
      this.status.login.state = success ? "succeeded" : "failed";
      this.status.login.error =
        typeof notification.params.error === "string"
          ? notification.params.error
          : null;
      if (success) void this.refreshAccountAndModels();
    }
    if (notification.method === "account/updated") {
      this.status.authMode = stringOrNull(notification.params.authMode);
      this.status.planType = stringOrNull(notification.params.planType);
      this.status.authenticated = this.status.authMode !== null;
    }
    this.events.emit("notification", notification);
  }

  private applyAccount(result: AccountReadResult): void {
    this.status.authenticated = result.account !== null;
    this.status.authMode = result.account?.type ?? null;
    this.status.accountEmail = result.account?.email ?? null;
    this.status.planType = result.account?.planType ?? null;
  }

  private applyModels(models: CodexModel[]): void {
    this.status.models = models.map(
      ({ id, model, displayName, hidden, isDefault }) => ({
        id,
        model,
        displayName,
        hidden,
        isDefault,
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
