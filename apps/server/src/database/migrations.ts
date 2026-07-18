export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('web', 'whatsapp', 'timer', 'demo')),
        workspace TEXT NOT NULL,
        codex_thread_id TEXT,
        codex_turn_id TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'starting', 'running', 'awaiting_approval',
          'completed', 'failed', 'interrupted', 'cancelled'
        )),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        latest_progress_summary TEXT,
        final_response TEXT,
        error TEXT,
        timer_id TEXT,
        requested_model TEXT,
        effective_model TEXT,
        interruption_metadata_json TEXT,
        recovery_metadata_json TEXT
      );

      CREATE INDEX missions_status_created_idx ON missions(status, created_at);
      CREATE INDEX missions_thread_idx ON missions(codex_thread_id);

      CREATE TABLE mission_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX mission_events_mission_id_idx ON mission_events(mission_id, id);

      CREATE TABLE timers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_kind TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        timezone TEXT NOT NULL,
        next_run_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_mission_id TEXT REFERENCES missions(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE whatsapp_outbound_messages (
        message_id TEXT PRIMARY KEY,
        mission_id TEXT REFERENCES missions(id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE terminal_sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
    `,
  },
];
