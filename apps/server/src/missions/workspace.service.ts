import {
  BadRequestException,
  Inject,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import { execFile } from "node:child_process";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";

const execFileAsync = promisify(execFile);
const IGNORED = new Set([".git", "node_modules", ".orkestr-data", "dist"]);
const MAX_TREE_ENTRIES = 1_000;
const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_000;
const VIRTUAL_FILESYSTEMS = new Set(["dev", "proc", "run", "sys"]);

export const MAX_BOX_UPLOAD_FILES = 5;
export const MAX_BOX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface BoxUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface WorkspaceNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: WorkspaceNode[];
}

@Injectable()
export class WorkspaceService {
  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  async files(): Promise<string[]> {
    const nodes = await this.tree();
    return flattenFiles(nodes).slice(0, 500);
  }

  async tree(): Promise<WorkspaceNode[]> {
    const root = await realpath(this.config.workspace);
    const count = { value: 0 };
    return this.walk(root, root, count);
  }

  async preview(path: string): Promise<{
    path: string;
    content: string;
    size: number;
    language: string;
  }> {
    const absolute = await this.safeFile(path);
    const details = await stat(absolute);
    if (details.size > MAX_PREVIEW_BYTES) {
      throw new PayloadTooLargeException("File is too large to preview");
    }
    const buffer = await readFile(absolute);
    if (buffer.subarray(0, 8_192).includes(0)) {
      throw new BadRequestException("Binary files cannot be previewed");
    }
    return {
      path,
      content: buffer.toString("utf8"),
      size: details.size,
      language: languageFor(path),
    };
  }

  async download(path: string): Promise<{ absolute: string; name: string }> {
    const absolute = await this.safeFile(path);
    const details = await stat(absolute);
    if (details.size > MAX_DOWNLOAD_BYTES) {
      throw new PayloadTooLargeException("File is too large to download");
    }
    return { absolute, name: basename(absolute) };
  }

  async boxDirectory(requestedPath = "/"): Promise<{
    path: string;
    parent: string | null;
    data: WorkspaceNode[];
  }> {
    const root = await realpath(this.config.filesRoot ?? "/");
    const directory = await this.safeBoxPath(requestedPath, "directory");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new BadRequestException("Directory cannot be read");
    }
    entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory())
        return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    const data: WorkspaceNode[] = [];
    for (const entry of entries.slice(0, MAX_DIRECTORY_ENTRIES)) {
      if (directory === "/" && VIRTUAL_FILESYSTEMS.has(entry.name)) continue;
      const visiblePath = join(directory, entry.name);
      try {
        const target = await realpath(visiblePath);
        if (!isWithin(root, target)) continue;
        const metadata = await stat(target);
        if (metadata.isDirectory()) {
          data.push({ name: entry.name, path: visiblePath, type: "directory" });
        } else if (metadata.isFile()) {
          data.push({
            name: entry.name,
            path: visiblePath,
            type: "file",
            size: metadata.size,
          });
        }
      } catch {
        // Socket-like, inaccessible, and broken-link entries are not useful here.
      }
    }
    return {
      path: directory,
      parent: directory === root ? null : resolve(directory, ".."),
      data,
    };
  }

  async boxPreview(path: string): Promise<{
    path: string;
    content: string;
    size: number;
    language: string;
  }> {
    const absolute = await this.safeBoxPath(path, "file");
    const details = await stat(absolute);
    if (details.size > MAX_PREVIEW_BYTES) {
      throw new PayloadTooLargeException("File is too large to preview");
    }
    const buffer = await readFile(absolute);
    if (buffer.subarray(0, 8_192).includes(0)) {
      throw new BadRequestException("Binary files cannot be previewed");
    }
    return {
      path: absolute,
      content: buffer.toString("utf8"),
      size: details.size,
      language: languageFor(absolute),
    };
  }

  async boxDownload(path: string): Promise<{ absolute: string; name: string }> {
    const absolute = await this.safeBoxPath(path, "file");
    const details = await stat(absolute);
    if (details.size > MAX_DOWNLOAD_BYTES) {
      throw new PayloadTooLargeException("File is too large to download");
    }
    return { absolute, name: basename(absolute) };
  }

  async boxUpload(
    requestedDirectory: string,
    files: BoxUpload[],
  ): Promise<WorkspaceNode[]> {
    if (!files.length)
      throw new BadRequestException("Choose at least one file");
    if (files.length > MAX_BOX_UPLOAD_FILES) {
      throw new BadRequestException(
        `Upload up to ${MAX_BOX_UPLOAD_FILES} files at once`,
      );
    }
    const directory = await this.safeBoxPath(requestedDirectory, "directory");
    const uploaded: WorkspaceNode[] = [];
    for (const file of files) {
      if (
        !Buffer.isBuffer(file.buffer) ||
        file.size !== file.buffer.byteLength
      ) {
        throw new BadRequestException("Uploaded file is incomplete");
      }
      if (file.size > MAX_BOX_UPLOAD_BYTES) {
        throw new PayloadTooLargeException(
          "Uploaded file exceeds the 25 MB limit",
        );
      }
      const originalName = safeUploadName(file.originalname);
      const destination = await this.writeUniqueFile(
        directory,
        originalName,
        file.buffer,
      );
      uploaded.push({
        name: basename(destination),
        path: destination,
        type: "file",
        size: file.size,
      });
    }
    return uploaded;
  }

  async changes(): Promise<{ status: string; diff: string }> {
    const [status, diff] = await Promise.all([
      this.git(["status", "--short"]),
      this.git(["diff", "--no-ext-diff", "--"]),
    ]);
    return { status, diff };
  }

  private async walk(
    root: string,
    directory: string,
    count: { value: number },
  ): Promise<WorkspaceNode[]> {
    if (count.value >= MAX_TREE_ENTRIES) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory())
        return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    const output: WorkspaceNode[] = [];
    for (const entry of entries) {
      if (IGNORED.has(entry.name) || count.value >= MAX_TREE_ENTRIES) continue;
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        try {
          const target = await realpath(absolute);
          if (!isWithin(root, target)) continue;
        } catch {
          continue;
        }
      }
      count.value += 1;
      const path = relative(root, absolute);
      if (entry.isDirectory()) {
        output.push({
          name: entry.name,
          path,
          type: "directory",
          children: await this.walk(root, absolute, count),
        });
      } else if (entry.isFile()) {
        output.push({
          name: entry.name,
          path,
          type: "file",
          size: metadata.size,
        });
      }
    }
    return output;
  }

  private async safeFile(requestedPath: string): Promise<string> {
    const value = String(requestedPath || "").trim();
    if (
      !value ||
      isAbsolute(value) ||
      value.split(/[\\/]+/).some((part) => part === "..")
    ) {
      throw new BadRequestException("Workspace path is not valid");
    }
    const root = await realpath(this.config.workspace);
    const candidate = resolve(root, value);
    let target: string;
    try {
      target = await realpath(candidate);
    } catch {
      throw new BadRequestException("Workspace file does not exist");
    }
    if (!isWithin(root, target)) {
      throw new BadRequestException("Workspace path escapes the workspace");
    }
    if (!(await stat(target)).isFile()) {
      throw new BadRequestException("Workspace path is not a file");
    }
    return target;
  }

  private async safeBoxPath(
    requestedPath: string,
    expected: "file" | "directory",
  ): Promise<string> {
    const root = await realpath(this.config.filesRoot ?? "/");
    const value = String(requestedPath || root).trim();
    const candidate = isAbsolute(value) ? value : resolve(root, value);
    let target: string;
    try {
      target = await realpath(candidate);
    } catch {
      throw new BadRequestException("Box path does not exist");
    }
    if (!isWithin(root, target)) {
      throw new BadRequestException("Box path escapes the configured root");
    }
    if (
      root === "/" &&
      [...VIRTUAL_FILESYSTEMS].some(
        (name) => target === `/${name}` || target.startsWith(`/${name}/`),
      )
    ) {
      throw new BadRequestException("Virtual system files are not browsable");
    }
    const details = await stat(target);
    if (expected === "file" ? !details.isFile() : !details.isDirectory()) {
      throw new BadRequestException(`Box path is not a ${expected}`);
    }
    return target;
  }

  private async writeUniqueFile(
    directory: string,
    requestedName: string,
    contents: Buffer,
  ): Promise<string> {
    const extension = extname(requestedName);
    const stem = basename(requestedName, extension);
    for (let index = 0; index < 1_000; index += 1) {
      const name =
        index === 0 ? requestedName : `${stem} (${index})${extension}`;
      const candidate = join(directory, name);
      try {
        const handle = await open(candidate, "wx", 0o600);
        try {
          await handle.writeFile(contents);
        } finally {
          await handle.close();
        }
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw new BadRequestException("Directory is not writable");
      }
    }
    throw new BadRequestException("Could not choose a unique upload name");
  }

  private async git(args: string[]): Promise<string> {
    try {
      const result = await execFileAsync(
        "git",
        ["-C", this.config.workspace, ...args],
        { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
      );
      return result.stdout.trim();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

function isWithin(root: string, target: string): boolean {
  return (
    target === root ||
    (root === sep ? target.startsWith(sep) : target.startsWith(`${root}${sep}`))
  );
}

function flattenFiles(nodes: WorkspaceNode[]): string[] {
  return nodes.flatMap((node) =>
    node.type === "file" ? [node.path] : flattenFiles(node.children ?? []),
  );
}

function languageFor(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();
  const aliases: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
    css: "css",
    html: "html",
  };
  return aliases[extension] ?? (extension || "text");
}

function safeUploadName(value: string): string {
  const leaf = basename(String(value || "upload.bin"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 180);
  if (!leaf || leaf === "." || leaf === "..") return "upload.bin";
  return leaf;
}
