import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";

export const MAX_CHAT_ATTACHMENTS = 5;
export const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface BrowserUpload {
  buffer: Buffer;
  mimetype?: string;
  originalname?: string;
  size?: number;
}

export interface AttachmentView {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  direction: "inbound" | "outbound";
  createdAt: string;
}

interface AttachmentRow {
  id: string;
  message_id: string | null;
  turn_id: string | null;
  direction: "inbound" | "outbound";
  original_name: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  created_at: string;
}

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  async saveBrowserUploads(files: BrowserUpload[]): Promise<AttachmentView[]> {
    if (!files.length)
      throw new BadRequestException("Select at least one file");
    if (files.length > MAX_CHAT_ATTACHMENTS) {
      throw new BadRequestException(
        `Attach up to ${MAX_CHAT_ATTACHMENTS} files at a time`,
      );
    }

    const saved: AttachmentView[] = [];
    for (const file of files) {
      const buffer = file.buffer;
      if (!Buffer.isBuffer(buffer)) {
        throw new BadRequestException("Uploaded file data is invalid");
      }
      if (buffer.length > MAX_CHAT_ATTACHMENT_BYTES) {
        throw new PayloadTooLargeException(
          "Attachment exceeds the 25 MB limit",
        );
      }
      if (typeof file.size === "number" && file.size !== buffer.length) {
        throw new BadRequestException("Uploaded file size does not match");
      }

      const id = randomUUID();
      const date = new Date().toISOString().slice(0, 10);
      const directory = join(
        this.config.home,
        "attachments/browser/incoming",
        date,
        id,
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const originalName = safeFilename(file.originalname || "attachment.bin");
      const storagePath = join(directory, originalName);
      const temporary = `${storagePath}.${randomUUID()}.part`;
      await writeFile(temporary, buffer, { mode: 0o600 });
      await rename(temporary, storagePath);

      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
      try {
        this.database.db
          .prepare(
            `INSERT INTO attachments(
              id, message_id, direction, original_name, storage_path, mime_type,
              size_bytes, sha256, status, pinned, expires_at, created_at, updated_at
            ) VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, 'available', 0, ?, ?, ?)`,
          )
          .run(
            id,
            `browser:${id}`,
            originalName,
            storagePath,
            safeMime(file.mimetype),
            buffer.length,
            createHash("sha256").update(buffer).digest("hex"),
            expiresAt,
            now,
            now,
          );
      } catch (error) {
        await rm(storagePath, { force: true }).catch(() => undefined);
        throw error;
      }
      saved.push({
        id,
        name: originalName,
        mimeType: safeMime(file.mimetype),
        sizeBytes: buffer.length,
        direction: "inbound",
        createdAt: now,
      });
    }
    return saved;
  }

  assertClaimableBrowserUploads(
    attachmentIds: string[],
    existingTurnId: string | null,
  ): void {
    const ids = uniqueIds(attachmentIds);
    if (ids.length > MAX_CHAT_ATTACHMENTS) {
      throw new BadRequestException(
        `Attach up to ${MAX_CHAT_ATTACHMENTS} files per message`,
      );
    }
    for (const id of ids) {
      const row = this.database.db
        .prepare(
          `SELECT id, message_id, turn_id, status FROM attachments WHERE id = ?`,
        )
        .get(id) as
        | {
            id: string;
            message_id: string | null;
            turn_id: string | null;
            status: string;
          }
        | undefined;
      const browserUpload = row?.message_id?.startsWith("browser:");
      const claimable =
        !row?.turn_id || (existingTurnId && row.turn_id === existingTurnId);
      if (!row || row.status !== "available" || !browserUpload || !claimable) {
        throw new BadRequestException(
          "One or more attachments are unavailable",
        );
      }
    }
  }

  claimBrowserUploads(turnId: string, attachmentIds: string[]): void {
    const ids = uniqueIds(attachmentIds);
    const now = new Date().toISOString();
    this.database.db.transaction(() => {
      for (const id of ids) {
        const result = this.database.db
          .prepare(
            `UPDATE attachments SET turn_id = ?, updated_at = ?
             WHERE id = ? AND status = 'available'
               AND message_id LIKE 'browser:%'
               AND (turn_id IS NULL OR turn_id = ?)`,
          )
          .run(turnId, now, id, turnId);
        if (result.changes !== 1) {
          throw new BadRequestException(
            "One or more attachments could not be attached",
          );
        }
      }
    })();
  }

  listForTurn(turnId: string): AttachmentView[] {
    const rows = this.database.db
      .prepare(
        `SELECT id, message_id, turn_id, direction, original_name, storage_path,
                mime_type, size_bytes, status, created_at
         FROM attachments
         WHERE turn_id = ? AND status = 'available'
         ORDER BY created_at, id`,
      )
      .all(turnId) as AttachmentRow[];
    return rows.map(view);
  }

  promptForTurn(turnId: string): string {
    const rows = this.database.db
      .prepare(
        `SELECT original_name, storage_path, mime_type, size_bytes
         FROM attachments
         WHERE turn_id = ? AND direction = 'inbound' AND status = 'available'
         ORDER BY created_at, id`,
      )
      .all(turnId) as Array<{
      original_name: string;
      storage_path: string;
      mime_type: string;
      size_bytes: number;
    }>;
    if (!rows.length) return "";
    return [
      "Attached files are available at these read-only local paths:",
      ...rows.map(
        (row) =>
          `- ${row.original_name} (${row.mime_type}, ${row.size_bytes} bytes): ${row.storage_path}`,
      ),
      "Inspect only the files needed for the user's request. Never execute received files.",
    ].join("\n");
  }

  async prepareBrowserOutputDirectory(turnId: string): Promise<string> {
    const directory = join(
      this.config.home,
      "attachments/browser/outgoing",
      turnId,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  async registerBrowserOutputs(
    turnId: string,
    requestedPaths: string[],
  ): Promise<AttachmentView[]> {
    const paths = [...new Set(requestedPaths)].slice(0, MAX_CHAT_ATTACHMENTS);
    if (!paths.length) return [];
    const outputDirectory = await this.prepareBrowserOutputDirectory(turnId);
    const root = await realpath(outputDirectory);
    const registered: AttachmentView[] = [];

    for (const requestedPath of paths) {
      if (!isAbsolute(requestedPath)) {
        throw new BadRequestException(
          "Returned attachment path must be absolute",
        );
      }
      const requestedMetadata = await lstat(requestedPath);
      if (requestedMetadata.isSymbolicLink()) {
        throw new BadRequestException(
          "Returned attachment cannot be a symlink",
        );
      }
      const target = await realpath(requestedPath);
      if (!isWithin(root, target)) {
        throw new BadRequestException(
          "Returned attachment is outside the browser output directory",
        );
      }
      const details = await stat(target);
      if (!details.isFile()) {
        throw new BadRequestException(
          "Returned attachment is not a regular file",
        );
      }
      if (details.size > MAX_CHAT_ATTACHMENT_BYTES) {
        throw new PayloadTooLargeException(
          "Returned attachment exceeds the 25 MB limit",
        );
      }
      const buffer = await readFile(target);
      const existing = this.database.db
        .prepare("SELECT id FROM attachments WHERE storage_path = ?")
        .get(target) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
      if (existing) {
        this.database.db
          .prepare(
            `UPDATE attachments SET turn_id = ?, direction = 'outbound',
              original_name = ?, mime_type = ?, size_bytes = ?, sha256 = ?,
              status = 'available', pinned = 0, expires_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            turnId,
            basename(target),
            mimeForPath(target),
            details.size,
            createHash("sha256").update(buffer).digest("hex"),
            expiresAt,
            now,
            id,
          );
      } else {
        this.database.db
          .prepare(
            `INSERT INTO attachments(
              id, turn_id, direction, original_name, storage_path, mime_type,
              size_bytes, sha256, status, pinned, expires_at, created_at, updated_at
            ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, 'available', 0, ?, ?, ?)`,
          )
          .run(
            id,
            turnId,
            basename(target),
            target,
            mimeForPath(target),
            details.size,
            createHash("sha256").update(buffer).digest("hex"),
            expiresAt,
            now,
            now,
          );
      }
      registered.push({
        id,
        name: basename(target),
        mimeType: mimeForPath(target),
        sizeBytes: details.size,
        direction: "outbound",
        createdAt: now,
      });
    }
    return registered;
  }

  async download(
    id: string,
  ): Promise<{ absolute: string; name: string; mimeType: string }> {
    const row = this.database.db
      .prepare(
        `SELECT id, message_id, turn_id, direction, original_name, storage_path,
                mime_type, size_bytes, status, created_at
         FROM attachments WHERE id = ?`,
      )
      .get(id) as AttachmentRow | undefined;
    if (!row || row.status !== "available") {
      throw new NotFoundException("Attachment not found");
    }

    await mkdir(join(this.config.home, "attachments"), {
      recursive: true,
      mode: 0o700,
    });
    const [target, attachmentRoot, workspace] = await Promise.all([
      realpath(row.storage_path).catch(() => null),
      realpath(join(this.config.home, "attachments")),
      realpath(this.config.workspace),
    ]);
    if (
      !target ||
      (!isWithin(attachmentRoot, target) && !isWithin(workspace, target))
    ) {
      throw new NotFoundException("Attachment file is unavailable");
    }
    const details = await stat(target);
    if (!details.isFile()) {
      throw new NotFoundException("Attachment file is unavailable");
    }
    if (details.size > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException("Attachment exceeds the 25 MB limit");
    }
    return {
      absolute: target,
      name: safeFilename(row.original_name),
      mimeType: row.mime_type,
    };
  }
}

function view(row: AttachmentRow): AttachmentView {
  return {
    id: row.id,
    name: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    direction: row.direction,
    createdAt: row.created_at,
  };
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function safeFilename(value: string): string {
  const leaf = basename(value.replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ ()\-]/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return leaf && leaf !== "." && leaf !== ".." ? leaf : "attachment.bin";
}

function safeMime(value: string | undefined): string {
  const candidate = String(value || "")
    .trim()
    .slice(0, 255);
  return /^[\w.+-]+\/[\w.+-]+$/.test(candidate)
    ? candidate
    : "application/octet-stream";
}

function mimeForPath(path: string): string {
  const extension = path.toLowerCase().split(".").at(-1);
  const known: Record<string, string> = {
    csv: "text/csv",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    txt: "text/plain",
    webp: "image/webp",
    zip: "application/zip",
  };
  return known[extension || ""] ?? "application/octet-stream";
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
