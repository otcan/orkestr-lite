import { resolve } from "node:path";

export interface RuntimeConfig {
  host: string;
  port: number;
  home: string;
  codexHome: string;
  workspace: string;
  /** Optional on legacy test fixtures; readRuntimeConfig always supplies it. */
  filesRoot?: string;
  databasePath: string;
  requestedModel: string;
  adminPassword?: string;
  cookieSecure: boolean;
  allowedOrigins: string[];
  codexCommand: string;
  codexVersion: string;
  publicDir: string;
  /** Optional on hand-built test fixtures; readRuntimeConfig always supplies it. */
  deskUrl?: string | null;
  /** Optional on hand-built test fixtures; readRuntimeConfig always supplies it. */
  deskVncUrl?: string | null;
  /** Optional on hand-built test fixtures; readRuntimeConfig always supplies it. */
  deskTokenFile?: string;
  /** Optional on hand-built test fixtures; readRuntimeConfig always supplies it. */
  codexTransport?: "auto" | "local" | "desk";
}

export function readRuntimeConfig(): RuntimeConfig {
  const home = resolve(process.env.ORKESTR_HOME ?? "./.orkestr-data");
  const workspace = resolve(process.env.ORKESTR_WORKSPACE ?? "./workspace");
  const host = process.env.ORKESTR_HOST ?? "127.0.0.1";
  const port = parsePort(process.env.ORKESTR_PORT);
  const adminPassword = process.env.ORKESTR_ADMIN_PASSWORD || undefined;
  if (
    adminPassword &&
    (adminPassword.length < 12 || adminPassword.length > 512)
  ) {
    throw new Error(
      "ORKESTR_ADMIN_PASSWORD must contain between 12 and 512 characters",
    );
  }
  const allowedOrigins = (process.env.ORKESTR_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    host,
    port,
    home,
    codexHome: resolve(process.env.CODEX_HOME ?? `${home}/codex`),
    workspace,
    filesRoot: resolve(process.env.ORKESTR_FILES_ROOT ?? "/"),
    databasePath: resolve(
      process.env.ORKESTR_DATABASE ?? `${home}/orkestr.sqlite`,
    ),
    requestedModel: process.env.ORKESTR_MODEL ?? "gpt-5.6",
    adminPassword,
    cookieSecure: process.env.ORKESTR_COOKIE_SECURE === "true",
    allowedOrigins,
    codexCommand: process.env.ORKESTR_CODEX_COMMAND ?? "codex",
    codexVersion: process.env.ORKESTR_CODEX_VERSION ?? "0.144.5",
    publicDir: resolve(process.env.ORKESTR_PUBLIC_DIR ?? "./dist/web/browser"),
    deskUrl: optionalUrl(process.env.ORKESTR_DESK_URL),
    deskVncUrl: optionalUrl(process.env.ORKESTR_DESK_VNC_URL),
    deskTokenFile: resolve(
      process.env.ORKESTR_DESK_TOKEN_FILE ?? "/run/orkestr-desk-auth/token",
    ),
    codexTransport: codexTransport(process.env.ORKESTR_CODEX_TRANSPORT),
  };
}

function optionalUrl(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  const url = new URL(candidate);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`Unsupported internal URL protocol: ${url.protocol}`);
  }
  return url.toString().replace(/\/$/, "");
}

function codexTransport(value: string | undefined): "auto" | "local" | "desk" {
  const candidate = value?.trim().toLowerCase() || "auto";
  if (candidate === "auto" || candidate === "local" || candidate === "desk") {
    return candidate;
  }
  throw new Error(`Invalid ORKESTR_CODEX_TRANSPORT: ${value}`);
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ORKESTR_PORT: ${value}`);
  }
  return port;
}
