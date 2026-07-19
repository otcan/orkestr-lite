#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.144.5\n");
  process.exit(0);
}

const input = readline.createInterface({ input: process.stdin });
const threads = new Map();
let sequence = 0;
let turnCount = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: "orkestr-test-fixture" } });
      break;
    case "account/read":
      send({
        id: message.id,
        result: {
          account: {
            type: "chatgpt",
            email: "judge@example.test",
            planType: "test",
          },
          requiresOpenaiAuth: true,
        },
      });
      break;
    case "model/list":
      send({
        id: message.id,
        result: {
          data: [
            {
              id: "gpt-5.6",
              model: "gpt-5.6",
              displayName: "GPT-5.6 Test Fixture",
              hidden: false,
              isDefault: true,
            },
          ],
        },
      });
      break;
    case "thread/start": {
      const threadId = `thr_fixture_${++sequence}`;
      const threadModel =
        process.env.ORKESTR_FAKE_CODEX_THREAD_MODEL ?? message.params.model;
      threads.set(threadId, {
        cwd: message.params.cwd,
        model: threadModel,
      });
      send({
        id: message.id,
        result: { thread: { id: threadId, model: threadModel } },
      });
      break;
    }
    case "thread/resume":
      send({
        id: message.id,
        result: { thread: { id: message.params.threadId } },
      });
      break;
    case "turn/start": {
      turnCount += 1;
      const thread = threads.get(message.params.threadId) ?? {
        cwd: message.params.cwd,
      };
      const turnId = `turn_fixture_${++sequence}`;
      const rerouteModel = process.env.ORKESTR_FAKE_CODEX_REROUTE_MODEL;
      const rerouteTurn = Number(
        process.env.ORKESTR_FAKE_CODEX_REROUTE_ON_TURN ?? "1",
      );
      if (rerouteModel && turnCount === rerouteTurn) {
        send({
          method: "model/rerouted",
          params: {
            threadId: message.params.threadId,
            turnId,
            fromModel: thread.model,
            toModel: rerouteModel,
          },
        });
      }
      send({
        id: message.id,
        result: { turn: { id: turnId, status: "inProgress", items: [] } },
      });
      const crashMarker = process.env.ORKESTR_FAKE_CODEX_CRASH_ONCE_MARKER;
      if (crashMarker && !existsSync(crashMarker)) {
        writeFileSync(crashMarker, "crashed\n", { mode: 0o600 });
        setTimeout(() => process.exit(42), 25);
        break;
      }
      setTimeout(
        () => completeFixtureTurn(message.params.threadId, turnId, thread.cwd),
        15,
      );
      break;
    }
    case "turn/interrupt":
      send({ id: message.id, result: {} });
      send({
        method: "turn/completed",
        params: {
          threadId: message.params.threadId,
          turn: {
            id: message.params.turnId,
            status: "interrupted",
            items: [],
            error: null,
          },
        },
      });
      break;
    default:
      send({
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});

function completeFixtureTurn(threadId, turnId, cwd) {
  send({
    method: "turn/started",
    params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } },
  });
  send({
    method: "turn/plan/updated",
    params: {
      threadId,
      turnId,
      plan: [
        { step: "Run the failing test", status: "completed" },
        { step: "Apply the smallest fix", status: "inProgress" },
      ],
    },
  });

  const sourcePath = `${cwd}/src/clamp.js`;
  const before = readFileSync(sourcePath, "utf8");
  const after = before.replace(
    "Math.max(maximum, Math.min(minimum, value))",
    "Math.max(minimum, Math.min(maximum, value))",
  );
  writeFileSync(sourcePath, after);

  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: "command_fixture",
        command: "npm test",
        cwd,
        status: "completed",
        aggregatedOutput: "3 tests passed",
        exitCode: 0,
      },
    },
  });
  send({
    method: "turn/diff/updated",
    params: {
      threadId,
      turnId,
      diff: "- return Math.max(maximum, Math.min(minimum, value));\n+ return Math.max(minimum, Math.min(maximum, value));",
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: "message_fixture",
        text: "Corrected the reversed clamp bounds and verified all three tests pass.",
        phase: "final_answer",
      },
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: turnId, status: "completed", items: [], error: null },
    },
  });
}
