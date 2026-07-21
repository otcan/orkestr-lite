import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mediaBinaries, run } from "./media-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(
  process.env.ORKESTR_SUBMISSION_MEDIA_DIR ??
    join(root, "assets/submission/v0.2"),
);
const names = [
  "chat.png",
  "desk-report.png",
  "files.png",
  "timers.png",
  "whatsapp.png",
  "report-complete.png",
];
const inputs = names.map((name) => join(directory, name));
await Promise.all(inputs.map((input) => access(input)));
const { ffmpeg } = await mediaBinaries();
const filters = inputs.map(
  (_, index) =>
    `[${index}:v]scale=640:540:force_original_aspect_ratio=decrease,` +
    `pad=640:540:(ow-iw)/2:(oh-ih)/2:color=0x0b1220[t${index}]`,
);
filters.push(
  `[t0][t1][t2][t3][t4][t5]xstack=inputs=6:` +
    `layout=0_0|640_0|1280_0|0_540|640_540|1280_540:fill=0x0b1220[out]`,
);
await run(ffmpeg, [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  ...inputs.flatMap((input) => ["-i", input]),
  "-filter_complex",
  filters.join(";"),
  "-map",
  "[out]",
  "-frames:v",
  "1",
  join(directory, "hero-montage.png"),
]);
process.stdout.write(`Built ${join(directory, "hero-montage.png")}\n`);
