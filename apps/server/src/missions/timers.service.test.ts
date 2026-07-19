import assert from "node:assert/strict";
import test from "node:test";
import { cronHourlyNext } from "./timers.service.js";

test("hourly schedules run at the selected minute every hour", () => {
  const next = cronHourlyNext(25, "UTC", new Date("2026-07-19T12:17:00.000Z"));
  assert.equal(next?.toISOString(), "2026-07-19T12:25:00.000Z");

  const following = cronHourlyNext(
    25,
    "UTC",
    new Date("2026-07-19T12:25:01.000Z"),
  );
  assert.equal(following?.toISOString(), "2026-07-19T13:25:00.000Z");
});
