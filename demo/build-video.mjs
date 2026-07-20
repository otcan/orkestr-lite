import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "playwright";
import { mediaBinaries, run } from "./media-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(
  process.env.ORKESTR_SUBMISSION_MEDIA_DIR ??
    join(root, "assets/submission/v0.2"),
);
const narrationValue = process.env.ORKESTR_NARRATION;
assert.ok(
  narrationValue,
  "ORKESTR_NARRATION must point to the owner's recording",
);
const narration = resolve(narrationValue);
await access(narration);

const scenes = [
  ["setup.png", "Local setup · Codex + linked workstation"],
  ["chat.png", "One durable conversation · GPT-5.6 · medium effort · YOLO"],
  ["desk-report.png", "Authentic Desk research · edited jump cut for latency"],
  ["files.png", "Cited Markdown + HTML artifacts in the shared workspace"],
  ["whatsapp.png", "WhatsApp self-chat follow-up + returned document"],
  ["timers.png", "Weekly watch enters the same conversation"],
  [
    "report-complete.png",
    "Real completed result · sources and model provenance",
  ],
];
await Promise.all(scenes.map(([name]) => access(join(directory, name))));
const { ffmpeg, ffprobe } = await mediaBinaries();
const durationResult = await run(ffprobe, [
  "-v",
  "error",
  "-show_entries",
  "format=duration",
  "-of",
  "default=noprint_wrappers=1:nokey=1",
  narration,
]);
const narrationDuration = Number(durationResult.stdout.trim());
assert.ok(Number.isFinite(narrationDuration) && narrationDuration > 5);
assert.ok(
  narrationDuration < 179,
  "Narration must be shorter than 179 seconds",
);
const sceneDuration = narrationDuration / scenes.length;

const temporary = await mkdtemp(join(tmpdir(), "orkestr-video-"));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  for (let index = 0; index < scenes.length; index += 1) {
    const [name, caption] = scenes[index];
    const image = `data:image/png;base64,${(
      await readFile(join(directory, name))
    ).toString("base64")}`;
    await page.setContent(`<!doctype html><style>
      *{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#08111f;color:white;font-family:Inter,Arial,sans-serif}
      img{width:100%;height:100%;object-fit:contain}
      .shade{position:absolute;inset:auto 0 0;height:180px;background:linear-gradient(transparent,rgba(4,9,18,.96))}
      .caption{position:absolute;left:80px;right:80px;bottom:46px;font-size:42px;font-weight:700;letter-spacing:-.02em;text-shadow:0 2px 12px #000}
      .truth{position:absolute;right:80px;top:44px;padding:12px 18px;border-radius:999px;background:rgba(4,9,18,.82);font-size:22px;color:#b9cdf4}
    </style><img src="${image}" alt=""><div class="shade"></div><div class="caption"></div><div class="truth">Authentic capture · visible jump cuts</div>`);
    await page.locator(".caption").evaluate((node, value) => {
      node.textContent = value;
    }, caption);
    await page.screenshot({ path: join(temporary, `${index}.png`) });
  }
} finally {
  await browser.close();
}

try {
  const filter = scenes
    .map(
      (_, index) =>
        `[${index}:v]scale=1920:1080,setsar=1,format=yuv420p[v${index}]`,
    )
    .concat(
      `${scenes.map((_, index) => `[v${index}]`).join("")}concat=n=${scenes.length}:v=1:a=0[video]`,
      `[${scenes.length}:a]loudnorm=I=-16:LRA=11:TP=-1.5[audio]`,
    )
    .join(";");
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (let index = 0; index < scenes.length; index += 1) {
    args.push(
      "-loop",
      "1",
      "-framerate",
      "30",
      "-t",
      sceneDuration.toFixed(3),
      "-i",
      join(temporary, `${index}.png`),
    );
  }
  args.push(
    "-i",
    narration,
    "-filter_complex",
    filter,
    "-map",
    "[video]",
    "-map",
    "[audio]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-shortest",
    join(directory, "demo.mp4"),
  );
  await run(ffmpeg, args);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
process.stdout.write(
  `Built ${join(directory, "demo.mp4")} from ${basename(narration)} (${narrationDuration.toFixed(1)}s)\n`,
);
