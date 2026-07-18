import { Injectable } from "@nestjs/common";
import type {
  CreateMissionInput,
  MissionEventRecord,
  MissionRecord,
  MissionStatus,
} from "@orkestr/shared";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../database/database.service.js";
import { MissionEventBus } from "./mission-event.bus.js";

interface MissionRow {
  id: string;
  title: string;
  prompt: string;
  source: MissionRecord["source"];
  workspace: string;
  codex_thread_id: string | null;
  codex_turn_id: string | null;
  status: MissionStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  latest_progress_summary: string | null;
  final_response: string | null;
  error: string | null;
  timer_id: string | null;
  requested_model: string | null;
  effective_model: string | null;
  interruption_metadata_json: string | null;
  recovery_metadata_json: string | null;
}

@Injectable()
export class MissionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly bus: MissionEventBus,
  ) {}

  create(
    input: CreateMissionInput,
    workspace: string,
    requestedModel: string,
  ): MissionRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const title = input.title || deriveTitle(input.prompt);
    this.database.db
      .prepare(
        `INSERT INTO missions(
          id, title, prompt, source, workspace, status, created_at, requested_model
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        id,
        title,
        input.prompt,
        input.source,
        workspace,
        createdAt,
        input.model ?? requestedModel,
      );
    const mission = this.require(id);
    this.appendEvent(id, "mission.queued", { source: mission.source });
    return mission;
  }

  list(limit = 100): MissionRecord[] {
    return (
      this.database.db
        .prepare("SELECT * FROM missions ORDER BY created_at DESC LIMIT ?")
        .all(limit) as MissionRow[]
    ).map(mapMission);
  }

  find(id: string): MissionRecord | null {
    const row = this.database.db
      .prepare("SELECT * FROM missions WHERE id = ?")
      .get(id) as MissionRow | undefined;
    return row ? mapMission(row) : null;
  }

  require(id: string): MissionRecord {
    const mission = this.find(id);
    if (!mission) throw new Error(`Mission not found: ${id}`);
    return mission;
  }

  findByThread(threadId: string): MissionRecord | null {
    const row = this.database.db
      .prepare(
        "SELECT * FROM missions WHERE codex_thread_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(threadId) as MissionRow | undefined;
    return row ? mapMission(row) : null;
  }

  nextQueued(): MissionRecord | null {
    const row = this.database.db
      .prepare(
        "SELECT * FROM missions WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
      )
      .get() as MissionRow | undefined;
    return row ? mapMission(row) : null;
  }

  active(): MissionRecord[] {
    return (
      this.database.db
        .prepare(
          "SELECT * FROM missions WHERE status IN ('starting', 'running', 'awaiting_approval') ORDER BY created_at",
        )
        .all() as MissionRow[]
    ).map(mapMission);
  }

  update(
    id: string,
    patch: Partial<{
      status: MissionStatus;
      codexThreadId: string | null;
      codexTurnId: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      latestProgressSummary: string | null;
      finalResponse: string | null;
      error: string | null;
      effectiveModel: string | null;
      interruptionMetadata: unknown | null;
      recoveryMetadata: unknown | null;
    }>,
  ): MissionRecord {
    const columns: Record<string, string> = {
      status: "status",
      codexThreadId: "codex_thread_id",
      codexTurnId: "codex_turn_id",
      startedAt: "started_at",
      finishedAt: "finished_at",
      latestProgressSummary: "latest_progress_summary",
      finalResponse: "final_response",
      error: "error",
      effectiveModel: "effective_model",
      interruptionMetadata: "interruption_metadata_json",
      recoveryMetadata: "recovery_metadata_json",
    };
    const entries = Object.entries(patch);
    if (entries.length === 0) return this.require(id);
    const values = entries.map(([key, value]) => {
      if (key === "interruptionMetadata" || key === "recoveryMetadata") {
        return value === null ? null : JSON.stringify(value);
      }
      return value;
    });
    const set = entries.map(([key]) => `${columns[key]} = ?`).join(", ");
    this.database.db
      .prepare(`UPDATE missions SET ${set} WHERE id = ?`)
      .run(...values, id);
    return this.require(id);
  }

  appendEvent(
    missionId: string,
    kind: string,
    payload: unknown,
  ): MissionEventRecord {
    const createdAt = new Date().toISOString();
    const result = this.database.db
      .prepare(
        "INSERT INTO mission_events(mission_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(missionId, kind, JSON.stringify(payload ?? null), createdAt);
    const event: MissionEventRecord = {
      id: Number(result.lastInsertRowid),
      missionId,
      kind,
      createdAt,
      payload,
    };
    this.bus.publish(event);
    return event;
  }

  events(missionId: string, afterId = 0, limit = 2_000): MissionEventRecord[] {
    const rows = this.database.db
      .prepare(
        `SELECT id, mission_id, kind, payload_json, created_at
         FROM mission_events WHERE mission_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(missionId, afterId, limit) as Array<{
      id: number;
      mission_id: string;
      kind: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      missionId: row.mission_id,
      kind: row.kind,
      createdAt: row.created_at,
      payload: parseJson(row.payload_json),
    }));
  }
}

function mapMission(row: MissionRow): MissionRecord {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    source: row.source,
    workspace: row.workspace,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    latestProgressSummary: row.latest_progress_summary,
    finalResponse: row.final_response,
    error: row.error,
    timerId: row.timer_id,
    requestedModel: row.requested_model,
    effectiveModel: row.effective_model,
    interruptionMetadata: parseJson(row.interruption_metadata_json),
    recoveryMetadata: parseJson(row.recovery_metadata_json),
  };
}

function parseJson(value: string | null): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.split("\n")[0]?.trim() || "Untitled mission";
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}
