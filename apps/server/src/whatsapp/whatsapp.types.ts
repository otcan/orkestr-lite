export type WhatsAppState =
  | "idle"
  | "starting"
  | "qr_needed"
  | "authenticated"
  | "ready"
  | "disconnected"
  | "error";

export interface WhatsAppSnapshot {
  state: WhatsAppState;
  enabled: boolean;
  authenticated: boolean;
  ready: boolean;
  qrAvailable: boolean;
  qrUpdatedAt: string | null;
  qrVersion: string | null;
  accountLabel: string | null;
  accountName: string | null;
  accountNumber: string | null;
  error: string | null;
  retryAt: string | null;
  retryAttempt: number;
  lastConnectedAt: string | null;
  lastMessageAt: string | null;
  queueDepth: number;
  outboxDepth: number;
}

export interface WhatsAppMessageView {
  messageId: string;
  direction: "inbound" | "outbound";
  turnId: string | null;
  source: string | null;
  bodyPreview: string;
  status: string;
  createdAt: string;
}

export interface WhatsAppMessageId {
  _serialized?: string;
  remote?: string;
}

export interface WhatsAppMessage {
  id?: WhatsAppMessageId | string;
  fromMe?: boolean;
  from?: string;
  to?: string;
  body?: string;
  isStatus?: boolean;
  timestamp?: number;
  type?: string;
  deviceType?: string;
  hasMedia?: boolean;
  downloadMedia?: () => Promise<WhatsAppMedia | undefined>;
  getChat?: () => Promise<WhatsAppChat>;
}

export interface WhatsAppChat {
  id?: WhatsAppMessageId | string;
  isGroup?: boolean;
  name?: string;
  timestamp?: number;
  fetchMessages?: (options: { limit: number }) => Promise<WhatsAppMessage[]>;
}

export interface WhatsAppMedia {
  mimetype: string;
  data: string;
  filename?: string | null;
  filesize?: number | null;
}

export interface WhatsAppClient {
  info?: {
    wid?: { _serialized?: string; user?: string } | string;
    pushname?: string;
  };
  on(event: string, listener: (...args: any[]) => void): this;
  initialize(): Promise<void> | void;
  getContactLidAndPhone?: (
    userIds: string[],
  ) => Promise<Array<{ lid?: string; pn?: string }>>;
  getChats?: () => Promise<WhatsAppChat[]>;
  getChatById?: (chatId: string) => Promise<WhatsAppChat | undefined>;
  sendMessage(
    chatId: string,
    content: unknown,
    options?: unknown,
  ): Promise<{ id?: WhatsAppMessageId | string } | undefined>;
  sendFile?(
    chatId: string,
    path: string,
    caption?: string,
  ): Promise<{ id?: WhatsAppMessageId | string } | undefined>;
  logout(): Promise<void> | void;
  destroy(): Promise<void> | void;
}

export interface WhatsAppClientOptions {
  dataPath: string;
  clientId: string;
  executablePath?: string;
}

export type WhatsAppClientFactory = (
  options: WhatsAppClientOptions,
) => Promise<WhatsAppClient>;

export const WHATSAPP_CLIENT_FACTORY = Symbol("WHATSAPP_CLIENT_FACTORY");
