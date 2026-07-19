import { z } from "zod";

export const missionStatuses = [
  "queued",
  "starting",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
] as const;

export const missionSources = ["web", "whatsapp", "timer", "demo"] as const;

export type MissionStatus = (typeof missionStatuses)[number];
export type MissionSource = (typeof missionSources)[number];

export const createMissionSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(32_000),
  source: z.enum(missionSources).default("web"),
  model: z.string().trim().min(1).max(120).optional(),
  reasoningEffort: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
});

export type CreateMissionInput = z.infer<typeof createMissionSchema>;

export const apiKeyLoginSchema = z.object({
  apiKey: z.string().trim().min(16).max(512),
});

export const loginSchema = z.object({
  password: z.string().min(1).max(512),
});

export const approvalDecisionSchema = z.object({
  requestId: z.union([z.string(), z.number()]),
  decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
});

export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export interface MissionRecord {
  id: string;
  title: string;
  prompt: string;
  source: MissionSource;
  workspace: string;
  codexThreadId: string | null;
  codexTurnId: string | null;
  status: MissionStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  latestProgressSummary: string | null;
  finalResponse: string | null;
  error: string | null;
  timerId: string | null;
  requestedModel: string | null;
  requestedReasoningEffort: string | null;
  effectiveModel: string | null;
  interruptionMetadata: unknown | null;
  recoveryMetadata: unknown | null;
  enqueueSequence: number | null;
  ingressKey: string | null;
}

export interface MissionEventRecord {
  id: number;
  missionId: string;
  kind: string;
  createdAt: string;
  payload: unknown;
}

export interface ModelSummary {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
}
