import type {
  WhatsAppClient,
  WhatsAppClientFactory,
} from "./whatsapp.types.js";

export const createWhatsAppClient: WhatsAppClientFactory = async (options) => {
  const whatsapp = await import("whatsapp-web.js");
  const loaded = whatsapp as unknown as {
    Client?: new (options: unknown) => WhatsAppClient;
    LocalAuth?: new (options: unknown) => unknown;
    MessageMedia?: { fromFilePath(path: string): WhatsAppDocumentMedia };
    default?: {
      Client?: new (options: unknown) => WhatsAppClient;
      LocalAuth?: new (options: unknown) => unknown;
      MessageMedia?: { fromFilePath(path: string): WhatsAppDocumentMedia };
    };
  };
  const Client = loaded.Client ?? loaded.default?.Client;
  const LocalAuth = loaded.LocalAuth ?? loaded.default?.LocalAuth;
  const MessageMedia = loaded.MessageMedia ?? loaded.default?.MessageMedia;
  if (!Client || !LocalAuth || !MessageMedia) {
    throw new Error("WhatsApp Web client failed to load");
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: options.clientId,
      dataPath: options.dataPath,
    }),
    puppeteer: {
      headless: true,
      ...(options.executablePath
        ? { executablePath: options.executablePath }
        : {}),
      args: [
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    },
  });
  const originalGetChats = client.getChats?.bind(client);
  const browserClient = client as WhatsAppClient & {
    pupPage?: {
      evaluate<T, A = undefined>(
        pageFunction: (argument: A) => T | Promise<T>,
        argument?: A,
      ): Promise<T>;
    };
  };
  if (originalGetChats) {
    client.getChats = async () => {
      try {
        return await originalGetChats();
      } catch {
        const page = browserClient.pupPage;
        if (!page) throw new Error("WhatsApp browser page is not ready");
        const chatSummaries = await page.evaluate(() => {
          const scope = globalThis as unknown as {
            require(name: string): {
              Chat: {
                getModelsArray(): Array<{
                  id?: { _serialized?: string };
                  groupMetadata?: unknown;
                  t?: number;
                  formattedTitle?: string;
                  name?: string;
                  contact?: {
                    name?: string;
                    pushname?: string;
                    formattedName?: string;
                  };
                }>;
              };
            };
          };
          return scope
            .require("WAWebCollections")
            .Chat.getModelsArray()
            .filter((chat) => !chat.groupMetadata)
            .map((chat) => ({
              id: chat.id?._serialized || "",
              name:
                chat.formattedTitle ||
                chat.name ||
                chat.contact?.name ||
                chat.contact?.pushname ||
                chat.contact?.formattedName ||
                "",
              timestamp: Number(chat.t || 0),
            }))
            .filter((chat) => Boolean(chat.id))
            .sort((left, right) => right.timestamp - left.timestamp)
            .slice(0, 100);
        });
        return chatSummaries.map((summary) => ({
          id: summary.id,
          isGroup: false,
          name: summary.name,
          timestamp: summary.timestamp,
          fetchMessages: async ({ limit }) =>
            page.evaluate(
              async ({ chatId, messageLimit }) => {
                const scope = globalThis as unknown as {
                  WWebJS: {
                    getChat(
                      id: string,
                      options: { getAsModel: boolean },
                    ): Promise<{
                      msgs: {
                        getModelsArray(): Array<Record<string, unknown>>;
                      };
                    }>;
                  };
                  require(name: string): {
                    loadEarlierMsgs?(options: {
                      chat: unknown;
                    }): Promise<Array<Record<string, unknown>>>;
                  };
                };
                const serialized = (value: unknown): string => {
                  if (typeof value === "string") return value;
                  if (!value || typeof value !== "object") return "";
                  const record = value as Record<string, unknown>;
                  return String(record._serialized || record.id || "");
                };
                const chat = await scope.WWebJS.getChat(chatId, {
                  getAsModel: false,
                });
                let messages = chat.msgs
                  .getModelsArray()
                  .filter((message) => !message.isNotification);
                while (messages.length < messageLimit) {
                  try {
                    const loader = scope.require("WAWebChatLoadMessages");
                    if (!loader.loadEarlierMsgs) break;
                    const loaded = await loader.loadEarlierMsgs({ chat });
                    if (!loaded?.length) break;
                    messages = [
                      ...loaded.filter((message) => !message.isNotification),
                      ...messages,
                    ];
                  } catch {
                    break;
                  }
                }
                return messages
                  .sort((left, right) =>
                    Number(left.t || 0) > Number(right.t || 0) ? 1 : -1,
                  )
                  .slice(-messageLimit)
                  .map((message) => {
                    const id = message.id as
                      | Record<string, unknown>
                      | undefined;
                    return {
                      id: serialized(message.id),
                      fromMe: Boolean(id?.fromMe),
                      from: serialized(message.from),
                      to: serialized(message.to),
                      body: String(message.body || ""),
                      isStatus: Boolean(message.isStatus),
                      timestamp: Number(message.t || 0),
                      type: String(message.type || ""),
                      hasMedia: Boolean(
                        message.isMedia ||
                          message.mediaData ||
                          message.filehash,
                      ),
                    };
                  });
              },
              { chatId: summary.id, messageLimit: limit },
            ),
        }));
      }
    };
  }
  client.sendFile = (chatId, path, caption) => {
    const media = MessageMedia.fromFilePath(path);
    media.mimetype = whatsAppDocumentMime(media.mimetype);
    return client.sendMessage(
      chatId,
      media as never,
      {
        sendMediaAsDocument: true,
        caption,
        waitUntilMsgSent: true,
      } as never,
    );
  };
  return client;
};

interface WhatsAppDocumentMedia {
  mimetype?: string | null;
}

export function whatsAppDocumentMime(mime: string | null | undefined): string {
  const normalized = String(mime || "")
    .trim()
    .toLowerCase();
  return normalized === "text/markdown" || !normalized
    ? "application/octet-stream"
    : normalized;
}
