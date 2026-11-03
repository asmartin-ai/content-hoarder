import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const WIDTH = 640;

const HEIGHT = 360;

const FPS = 24;

const HOST = "127.0.0.1";

const PORT = 8790;

const MEDIA_DIR = resolve(import.meta.dir, "..", "docs", "demo", "media");

type Colour = [red: number, green: number, blue: number];

type Still = { file: string; seed: number };

type Clip = { file: string; poster: string; seed: number; frames: number };

const STILLS: Still[] = [
  { file: "reddit-image-01.jpg", seed: 1301 },
  { file: "reddit-image-02.jpg", seed: 1302 },
  { file: "reddit-image-03.jpg", seed: 1303 },
  { file: "reddit-image-04.jpg", seed: 1304 },
  { file: "reddit-image-05.jpg", seed: 1305 },
  { file: "youtube-01.jpg", seed: 2301 },
  { file: "youtube-02.jpg", seed: 2302 },
  { file: "youtube-03.jpg", seed: 2303 },
  { file: "youtube-04.jpg", seed: 2304 },
  { file: "youtube-05.jpg", seed: 2305 },
  { file: "youtube-06.jpg", seed: 2306 },
  { file: "youtube-07.jpg", seed: 2307 },
  { file: "youtube-08.jpg", seed: 2308 },
];

const CLIPS: Clip[] = [
  { file: "reddit-video-01.mp4", poster: "reddit-video-01-poster.jpg", seed: 3301, frames: 96 },
  { file: "reddit-video-02.mp4", poster: "reddit-video-02-poster.jpg", seed: 3302, frames: 72 },
];

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const hueColour = (hue: number, saturation: number, lightness: number): Colour => {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = ((((hue % 360) + 360) % 360) / 60) % 6;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const offset = lightness - chroma / 2;

  const [red, green, blue] =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];

  return [
    Math.round((red + offset) * 255),
    Math.round((green + offset) * 255),
    Math.round((blue + offset) * 255),
  ];
};

const byte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

type Motif = {
  x: number;
  y: number;
  radius: number;
  drift: number;
  phase: number;
  fill: Colour;
  opacity: number;
  ring: boolean;
};

const motifList = (rng: () => number, baseHue: number): Motif[] =>
  Array.from({ length: 4 + Math.floor(rng() * 3) }, () => ({
    x: WIDTH * (0.12 + rng() * 0.76),
    y: HEIGHT * (0.12 + rng() * 0.76),
    radius: 40 + rng() * 150,
    drift: 10 + rng() * 26,
    phase: rng() * Math.PI * 2,
    fill: hueColour(baseHue + rng() * 130, 0.55 + rng() * 0.3, 0.42 + rng() * 0.34),
    opacity: 0.16 + rng() * 0.42,
    ring: rng() > 0.55,
  }));

const render = (seed: number, phase: number): Uint8Array => {
  const rng = mulberry32(seed);
  const baseHue = rng() * 360;
  const top = hueColour(baseHue, 0.42, 0.12);
  const bottom = hueColour(baseHue + 60 + rng() * 120, 0.58, 0.56);
  const motifs = motifList(rng, baseHue);
  const angle = phase * Math.PI * 2;
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const mix = ((y / HEIGHT) * 0.68 + (x / WIDTH) * 0.32) ** 1.15;
      const nx = (x - WIDTH / 2) / (WIDTH / 2);
      const ny = (y - HEIGHT / 2) / (HEIGHT / 2);
      const vignette = 1 - 0.3 * Math.min(1, (nx * nx + ny * ny) / 2);
      let red = (top[0] + (bottom[0] - top[0]) * mix) * vignette;
      let green = (top[1] + (bottom[1] - top[1]) * mix) * vignette;
      let blue = (top[2] + (bottom[2] - top[2]) * mix) * vignette;

      for (const motif of motifs) {
        const centreX = motif.x + Math.sin(angle + motif.phase) * motif.drift;
        const centreY = motif.y + Math.cos(angle + motif.phase) * motif.drift;
        const dx = x - centreX;
        const dy = y - centreY;
        const distance = Math.sqrt(dx * dx + dy * dy) / motif.radius;

        const edge = motif.ring
          ? Math.max(0, 1 - Math.abs(distance - 0.72) / 0.16)
          : Math.max(0, 1 - distance);

        if (edge <= 0) continue;
        const alpha = Math.min(1, edge * edge) * motif.opacity;

        red += (motif.fill[0] - red) * alpha;
        green += (motif.fill[1] - green) * alpha;
        blue += (motif.fill[2] - blue) * alpha;
      }

      const grain =
        (((Math.imul(x + seed, 374761393) ^ Math.imul(y + 668265263, 1103515245)) >>> 0) % 200) /
          100 -
        1;

      const index = (y * WIDTH + x) * 3;
      pixels[index] = byte(red + grain * 3);
      pixels[index + 1] = byte(green + grain * 3);
      pixels[index + 2] = byte(blue + grain * 3);
    }
  }

  return pixels;
};

const crcTable = new Uint32Array(256);

for (let index = 0; index < 256; index += 1) {
  let value = index;

  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

const crc32 = (bytes: Uint8Array): number => {
  let value = 0xffffffff;

  for (const item of bytes) value = crcTable[(value ^ item) & 0xff]! ^ (value >>> 8);

  return (value ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  const label = new TextEncoder().encode(type);
  view.setUint32(0, data.length);
  out.set(label, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

  return out;
};

const encodePng = (pixels: Uint8Array): Uint8Array => {
  const stride = WIDTH * 3 + 1;
  const raw = new Uint8Array(stride * HEIGHT);

  for (let y = 0; y < HEIGHT; y += 1) {
    raw[y * stride] = 0;
    raw.set(pixels.subarray(y * WIDTH * 3, (y + 1) * WIDTH * 3), y * stride + 1);
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, WIDTH);
  view.setUint32(4, HEIGHT);
  header[8] = 8;
  header[9] = 2;

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }

  return png;
};

const ffmpeg = (args: string[]): void => {
  const result = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0)
    throw new Error(`ffmpeg failed: ${result.stderr.toString().trim() || result.exitCode}`);
};

const writeStill = (directory: string, still: Still): void => {
  const frame = join(directory, `${still.file}.png`);
  writeFileSync(frame, encodePng(render(still.seed, 0.31)));
  ffmpeg([
    "-i",
    frame,
    "-frames:v",
    "1",
    "-pix_fmt",
    "yuvj420p",
    "-q:v",
    "4",
    join(MEDIA_DIR, still.file),
  ]);
};

const writeClip = (directory: string, clip: Clip): void => {
  const framesDir = join(directory, clip.file);
  mkdirSync(framesDir);

  for (let index = 0; index < clip.frames; index += 1) {
    const frame = join(framesDir, `frame-${String(index).padStart(3, "0")}.png`);
    writeFileSync(frame, encodePng(render(clip.seed, index / clip.frames)));
  }

  const poster = join(directory, `${clip.poster}.png`);
  writeFileSync(poster, encodePng(render(clip.seed, 0)));
  ffmpeg([
    "-i",
    poster,
    "-frames:v",
    "1",
    "-pix_fmt",
    "yuvj420p",
    "-q:v",
    "4",
    join(MEDIA_DIR, clip.poster),
  ]);

  ffmpeg([
    "-framerate",
    String(FPS),
    "-i",
    join(framesDir, "frame-%03d.png"),
    "-frames:v",
    String(clip.frames),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "32",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    join(MEDIA_DIR, clip.file),
  ]);
};

const totalBytes = (): number =>
  [...STILLS.map((still) => still.file), ...CLIPS.flatMap((clip) => [clip.file, clip.poster])]
    .map((file) => statSync(join(MEDIA_DIR, file)).size)
    .reduce((sum, size) => sum + size, 0);

const generate = (): void => {
  if (!Bun.which("ffmpeg")) throw new Error("ffmpeg is required to build the demo media");
  mkdirSync(MEDIA_DIR, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "content-hoarder-demo-media-"));

  try {
    for (const still of STILLS) writeStill(scratch, still);

    for (const clip of CLIPS) writeClip(scratch, clip);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(
    `Wrote ${STILLS.length} stills and ${CLIPS.length} clips to docs/demo/media (${Math.round(totalBytes() / 1024)} KiB)`,
  );
};

const serve = (): void => {
  Bun.serve({
    hostname: HOST,
    port: PORT,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const target = resolve(MEDIA_DIR, path.replace(/^\/+/, ""));

      if (!target.startsWith(`${MEDIA_DIR}/`) && target !== MEDIA_DIR)
        return new Response("Not found", { status: 404 });
      const file = Bun.file(target);

      if (!(await file.exists())) return new Response("Not found", { status: 404 });

      return new Response(file, { headers: { "cache-control": "no-store" } });
    },
  });
  console.log(`Demo media: http://${HOST}:${PORT}/ serving docs/demo/media`);
};

if (process.argv.includes("--serve")) serve();
else generate();
