import * as db from "../../db.ts";
import {
  exportVideo,
  libraryCacheKey,
  localVideo,
  pinVideo,
  prepareVideo,
  videoFilename,
  type VideoExportItem,
} from "../../video_export.ts";
import { json } from "../http.ts";
import { connection } from "../state.ts";

function itemData(item: {
  fullname: string;
  title: string;
  url: string;
  metadata: string;
}): VideoExportItem {
  return {
    fullname: item.fullname,
    title: item.title,
    url: item.url,
    metadata: item.metadata,
  };
}

function videoHeaders(title: string, bytes: number) {
  return {
    "Content-Type": "video/mp4",
    "Content-Length": String(bytes),
    "Content-Disposition": `attachment; filename="${videoFilename(title)}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function pinnedFileResponse(path: string, headers: Record<string, string>): Response {
  const release = pinVideo(path);
  let released = false;

  const finish = () => {
    if (released) return;
    released = true;
    release();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const reader = Bun.file(path).stream().getReader();

        for (;;) {
          const { done, value } = await reader.read();

          if (done) break;

          if (value) controller.enqueue(value);
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        finish();
      }
    },
    cancel() {
      finish();
    },
  });

  return new Response(stream, { headers });
}

export async function handleVideoExport(request: Request, fullname: string): Promise<Response> {
  const database = connection();
  const row = db.getItem(database, fullname);

  if (!row) return json({ error: "not_found", message: "That item does not exist." }, 404);
  const item = itemData(row);
  const deps = { libraryKey: libraryCacheKey(database) };

  if (request.method === "HEAD") {
    const local = localVideo(item, deps);

    if (!local) return new Response(null, { status: 404 });

    return new Response(null, { headers: videoHeaders(row.title, local.bytes) });
  }

  const result = await exportVideo(item, deps);

  if (!result.ok) return json({ error: result.error, message: result.message }, result.status);

  return pinnedFileResponse(result.path, videoHeaders(row.title, result.bytes));
}

export async function handleVideoPrepare(fullname: string): Promise<Response> {
  const database = connection();
  const row = db.getItem(database, fullname);

  if (!row)
    return json({ ready: false, error: "not_found", message: "That item does not exist." }, 404);
  const filename = videoFilename(row.title);
  const result = await prepareVideo(itemData(row), { libraryKey: libraryCacheKey(database) });

  if (result.ready)
    return json({
      ready: true,
      size_bytes: result.bytes,
      filename,
      cached: result.cached,
    });

  if ("pending" in result) return json({ ready: false, pending: true });

  return json({ ready: false, error: result.error, message: result.message }, result.status);
}
