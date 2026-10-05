import { createHash } from "node:crypto";
import * as z from "zod";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import * as config from "./config";

const mimeSchema = z.enum([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

const mimeExtensions = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
} satisfies Record<z.infer<typeof mimeSchema>, string>;

const extensionSchema = z.enum([".jpg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov", ".bin"]);

const extensionMimes = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".bin": "application/octet-stream",
} satisfies Record<z.infer<typeof extensionSchema>, string>;

const extensions = extensionSchema.options;

const validBlobId = /^[0-9a-f]{64}(\.(jpg|png|gif|webp|mp4|webm|mov|bin))?$/;

export function mediaDir(): string {
  return join(dirname(resolve(config.dbPath())), "media");
}

export function extFor(mime = "", url = ""): string {
  const normalized = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const parsedMime = mimeSchema.safeParse(normalized);
  const extension = parsedMime.success ? mimeExtensions[parsedMime.data] : undefined;

  if (extension) return extension;
  const lower = url.toLowerCase();

  for (const ext of [".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov"]) {
    if (lower.includes(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  }

  return ".bin";
}

export function mimeFor(blobId: string): string {
  const extension = extensionSchema.safeParse(extname(blobId).toLowerCase());

  return extension.success ? extensionMimes[extension.data] : "application/octet-stream";
}

export function store(
  data: Uint8Array,
  opts: { mime?: string; url?: string; baseDir?: string } = {},
): string {
  const blobId = `${createHash("sha256").update(data).digest("hex")}${extFor(opts.mime, opts.url)}`;
  const dir = opts.baseDir ?? mediaDir();
  mkdirSync(dir, { recursive: true });
  const destination = join(dir, blobId);

  if (!existsSync(destination)) {
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;

    try {
      writeFileSync(temporary, data, { flag: "wx" });
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, { force: true });

      if (!existsSync(destination)) throw error;
    }
  }

  return blobId;
}

export async function storePath(
  path: string,
  opts: { mime?: string; url?: string; baseDir?: string; chunkSize?: number } = {},
): Promise<string> {
  const hash = createHash("sha256");
  const input = createReadStream(path, { highWaterMark: opts.chunkSize ?? 1024 * 1024 });

  for await (const chunk of input) hash.update(chunk);
  const blobId = `${hash.digest("hex")}${extFor(opts.mime, opts.url || path)}`;
  const dir = opts.baseDir ?? mediaDir();
  mkdirSync(dir, { recursive: true });
  const destination = join(dir, blobId);

  if (existsSync(destination)) return blobId;
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;

  try {
    await Bun.write(temporary, Bun.file(path));

    try {
      renameSync(temporary, destination);
    } catch (error) {
      if (!existsSync(destination)) throw error;
      rmSync(temporary, { force: true });
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }

  return blobId;
}

export function isValidId(blobId: string): boolean {
  return blobId.length > 0 && validBlobId.test(blobId);
}

export function pathFor(blobId: string, opts: { baseDir?: string } = {}): string | null {
  if (!isValidId(blobId)) return null;
  const dir = opts.baseDir ?? mediaDir();

  if (blobId.includes(".")) {
    const path = join(dir, blobId);

    return existsSync(path) ? path : null;
  }

  for (const ext of extensions) {
    const path = join(dir, `${blobId}${ext}`);

    if (existsSync(path)) return path;
  }

  return null;
}
