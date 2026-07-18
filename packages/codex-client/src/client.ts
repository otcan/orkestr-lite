import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import {
  type AccountReadResult,
  type CodexClientOptions,
  type CodexModel,
  type CodexNotification,
  type CodexServerRequest,
  type DeviceCodeLoginResult,
  type RequestId,
  type RpcMessage,
  type RpcResponse,
  type ThreadResult,
  type TurnResult,
} from "./protocol.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexClientEvents {
  notification: [notification: CodexNotification];
  serverRequest: [request: CodexServerRequest];
  stderr: [line: string];
  exit: [code: number | null, signal: NodeJS.Signals | null];
}

export class CodexAppServerClient extends EventEmitter<CodexClientEvents> {
  private process: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private started = false;
  private stopping = false;

  constructor(private readonly options: CodexClientOptions) {
    super();
  }

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.isRunning && this.started) return;

    this.stopping = false;
    const command = this.options.command ?? "codex";
    const args = this.options.args ?? ["app-server", "--listen", "stdio://"];
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        CODEX_HOME: this.options.codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    const stdout = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    const stderr = createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });

    stdout.on("line", (line) => this.handleLine(line));
    stderr.on("line", (line) => this.emit("stderr", redactSecrets(line)));
    child.on("error", (error) => this.rejectAll(error));
    child.on("exit", (code, signal) => {
      this.started = false;
      this.process = null;
      this.rejectAll(
        new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`),
      );
      if (!this.stopping) this.emit("exit", code, signal);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "orkestr_lite",
        title: "Orkestr Lite",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.process;
    if (!child) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.process) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    const id = ++this.requestId;
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ method, id, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  accountRead(): Promise<AccountReadResult> {
    return this.request("account/read", { refreshToken: false });
  }

  loginDeviceCode(): Promise<DeviceCodeLoginResult> {
    return this.request("account/login/start", { type: "chatgptDeviceCode" });
  }

  loginApiKey(apiKey: string): Promise<{ type: "apiKey" }> {
    return this.request("account/login/start", { type: "apiKey", apiKey });
  }

  async listModels(): Promise<CodexModel[]> {
    const result = await this.request<{ data: CodexModel[] }>("model/list", {
      limit: 100,
      includeHidden: false,
    });
    return result.data;
  }

  startThread(params: {
    cwd: string;
    model: string;
    approvalPolicy?: "untrusted" | "on-request" | "never";
  }): Promise<ThreadResult> {
    return this.request("thread/start", {
      cwd: params.cwd,
      model: params.model,
      approvalPolicy: params.approvalPolicy ?? "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ephemeral: false,
      serviceName: "orkestr-lite",
    });
  }

  resumeThread(threadId: string): Promise<ThreadResult> {
    return this.request("thread/resume", { threadId });
  }

  startTurn(params: {
    threadId: string;
    prompt: string;
    cwd: string;
    model: string;
  }): Promise<TurnResult> {
    return this.request("turn/start", {
      threadId: params.threadId,
      input: [{ type: "text", text: params.prompt }],
      cwd: params.cwd,
      model: params.model,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [params.cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  }

  interruptTurn(
    threadId: string,
    turnId: string,
  ): Promise<Record<string, never>> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.emit(
        "stderr",
        `Ignored non-JSON app-server output: ${redactSecrets(line)}`,
      );
      return;
    }

    if ("id" in message && !("method" in message)) {
      this.handleResponse(message as RpcResponse);
      return;
    }

    if ("method" in message && "id" in message) {
      this.emit("serverRequest", {
        method: message.method,
        id: message.id,
        params: asRecord(message.params),
      });
      return;
    }

    if ("method" in message) {
      this.emit("notification", {
        method: message.method,
        params: asRecord(message.params),
      });
    }
  }

  private handleResponse(message: RpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(`${message.error.message} (${message.error.code})`),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private write(message: unknown): void {
    if (!this.process?.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}
