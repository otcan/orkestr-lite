export type RequestId = string | number;

export interface RpcRequest {
  method: string;
  id: RequestId;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string;
    description: string;
  }>;
}

export interface AccountReadResult {
  account: null | {
    type: string;
    email?: string | null;
    planType?: string | null;
  };
  requiresOpenaiAuth: boolean;
}

export interface DeviceCodeLoginResult {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface ThreadResult {
  thread: {
    id: string;
    model?: string;
    status?: unknown;
  };
}

export interface TurnResult {
  turn: {
    id: string;
    status: string;
    items?: unknown[];
    error?: unknown;
  };
}

export interface CodexClientOptions {
  command?: string;
  args?: string[];
  cwd: string;
  codexHome: string;
  requestTimeoutMs?: number;
  expectedVersion?: string;
  remoteUrl?: string;
  remoteToken?: string;
}

export interface CodexServerRequest {
  method: string;
  id: RequestId;
  params: Record<string, unknown>;
}

export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}
