import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";

export interface ConversationEventRecord {
  id: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export interface ContextSnapshot {
  usedTokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  compactionCount: number;
  updatedAt: string | null;
  lastCompactedAt: string | null;
}

@Injectable()
export class ConversationTelemetryService {
  private readonly listeners = new Set<
    (event: ConversationEventRecord) => void
  >();

  constructor(private readonly database: DatabaseService) {}

  append(kind: string, payload: unknown): ConversationEventRecord {
    const createdAt = new Date().toISOString();
    const result = this.database.db
      .prepare(
        "INSERT INTO conversation_events(kind, payload_json, created_at) VALUES (?, ?, ?)",
      )
      .run(kind, JSON.stringify(payload ?? null), createdAt);
    const event = {
      id: Number(result.lastInsertRowid),
      kind,
      payload,
      createdAt,
    };
    for (const listener of this.listeners) listener(event);
    return event;
  }

  list(afterId = 0, limit = 200): ConversationEventRecord[] {
    const safeLimit = Math.max(1, Math.min(500, limit));
    const rows = this.database.db
      .prepare(
        `SELECT id, kind, payload_json, created_at FROM conversation_events
         WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, safeLimit) as Array<{
      id: number;
      kind: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: parseJson(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  subscribe(listener: (event: ConversationEventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  updateContext(payload: unknown): void {
    const record = asRecord(payload);
    const tokenUsage = asRecord(record.tokenUsage);
    const last = asRecord(tokenUsage.last);
    const usedTokens = numberValue(last.totalTokens);
    const contextWindow = numberValue(tokenUsage.modelContextWindow);
    const updatedAt = new Date().toISOString();
    this.database.setSetting(
      "conversation.context",
      JSON.stringify({ usedTokens, contextWindow, updatedAt }),
    );
  }

  noteCompaction(payload: unknown): void {
    const seenAt = Number(
      this.database.getSetting("conversation.compaction_seen_at") ?? "0",
    );
    if (Number.isFinite(seenAt) && Date.now() - seenAt < 2_000) return;
    this.database.setSetting(
      "conversation.compaction_seen_at",
      String(Date.now()),
    );
    const current = Number(
      this.database.getSetting("conversation.compaction_count") ?? "0",
    );
    this.database.setSetting(
      "conversation.compaction_count",
      String(Number.isFinite(current) ? current + 1 : 1),
    );
    this.database.setSetting(
      "conversation.last_compacted_at",
      new Date().toISOString(),
    );
    this.append("conversation.context_compacted", payload);
  }

  context(): ContextSnapshot {
    const stored = parseJson(
      this.database.getSetting("conversation.context") ?? "{}",
    ) as Record<string, unknown>;
    const usedTokens = numberValue(stored.usedTokens);
    const contextWindow = numberValue(stored.contextWindow);
    return {
      usedTokens,
      contextWindow,
      percent:
        usedTokens !== null && contextWindow
          ? Math.min(100, Math.round((usedTokens / contextWindow) * 100))
          : null,
      compactionCount: Number(
        this.database.getSetting("conversation.compaction_count") ?? "0",
      ),
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
      lastCompactedAt:
        this.database.getSetting("conversation.last_compacted_at") ?? null,
    };
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
