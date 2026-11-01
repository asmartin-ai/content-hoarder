/**
 * Server-side media decisions for cards: hero media, small thumbnails, the
 * "cost" pill and number/domain formatting. Typed port of the decision logic in
 * src/static/core/media.js (thumb, _galleryThumb, _usableThumb, imageUrl,
 * mediaType, localUrl). Pure: never touches the network or the database.
 */

import * as z from "zod";
import type { Item } from "../../models.ts";
import { isRemovedText } from "../../static/core/util.js";

export type CardMedia = {
  kind: "image" | "gallery" | "video" | "youtube" | "link";
  src: string;
  fallback?: string;
  badge?: string;
};

// Connector facts that live in the metadata catchall (not in MetadataSchema's known keys).
const ExtraMetaSchema = z.object({
  media_url: z.string().optional().catch(undefined),
  media_urls: z.array(z.string()).optional().catch(undefined),
  og_image: z.string().optional().catch(undefined),
  archived_media: z.record(z.string(), z.string()).optional().catch(undefined),
  descendants: z.number().optional().catch(undefined),
});

export type ExtraMeta = z.infer<typeof ExtraMetaSchema>;

/** Parse the catchall metadata keys the card needs; `{}` when the blob is odd. */
export function extraMeta(item: Item): ExtraMeta {
  const parsed = ExtraMetaSchema.safeParse(item.metadata);

  return parsed.success ? parsed.data : {};
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i;

const VIDEO_EXT = /\.(mp4|webm|mov)(\?|#|$)/i;

const THUMB_SENTINEL = /^(self|default|nsfw|spoiler|image)$/i;

const YT_ID = /(?:v=|youtu\.be\/|\/shorts\/)([\w-]{6,})/;

/** Only http(s) or root-relative URLs are allowed (blocks javascript:/data:). */
function safeUrl(url: string | undefined): string {
  const value = (url ?? "").trim();

  return /^(https?:\/\/|\/)/i.test(value) ? value : "";
}

function directImg(url: string | undefined): boolean {
  return IMG_EXT.test(url ?? "") || /i\.redd\.it\//i.test(url ?? "");
}

function usableThumb(url: string | undefined): string {
  const value = (url ?? "").trim();

  return value && !THUMB_SENTINEL.test(value) ? safeUrl(value) : "";
}

function galleryThumb(item: Item): string {
  const md = item.metadata;
  const preview = safeUrl(md.gallery_preview?.[0]);

  if (preview) return preview;

  return safeUrl(md.gallery?.[0]);
}

/** `/media/<blob>` for an archived copy of `url`: exact key, else the lone archived value. */
function archivedUrl(item: Item, url: string): string {
  const archived = extraMeta(item).archived_media;

  if (!archived) return "";
  const exact = archived[url];

  if (exact) return `/media/${exact}`;
  const values = Object.values(archived);

  return values.length === 1 && values[0] ? `/media/${values[0]}` : "";
}

function imageUrl(item: Item): string {
  const md = item.metadata;
  const extra = extraMeta(item);

  if (directImg(item.url)) return safeUrl(item.url);

  if (directImg(extra.media_url)) return safeUrl(extra.media_url);
  const first = (extra.media_urls ?? []).find((url) => directImg(url));

  if (first) return safeUrl(first);

  return md.media_type === "image" ? safeUrl(extra.media_url) : "";
}

function youtubeId(item: Item): string {
  const match = YT_ID.exec(item.url);

  if (match?.[1]) return match[1];

  return item.source === "youtube" && /^[\w-]{11}$/.test(item.source_id) ? item.source_id : "";
}

type MediaEvidence = "video" | "gallery" | "image" | "youtube" | "text" | "link";

/** Content evidence, ported from media.js mediaType (comments classified by their metadata). */
function mediaEvidence(item: Item): MediaEvidence {
  const md = item.metadata;
  const extra = extraMeta(item);
  const mediaUrl = extra.media_url ?? "";

  if (item.source === "youtube") return "youtube";

  if (mediaUrl.includes("v.redd.it") || VIDEO_EXT.test(mediaUrl)) return "video";

  if ((extra.media_urls ?? []).some((url) => VIDEO_EXT.test(url))) return "video";

  if ((md.gallery?.length ?? 0) > 0 || md.media_type === "gallery") return "gallery";

  if (directImg(mediaUrl) || (extra.media_urls ?? []).some((url) => directImg(url))) return "image";
  const url = item.url.toLowerCase();

  if (
    /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/.test(url) ||
    url.includes("i.redd.it") ||
    url.includes("i.imgur.com")
  )
    return "image";

  if (url.includes("/gallery/") || url.includes("imgur.com/a/")) return "gallery";

  if (
    /\.(mp4|webm|mov)(\?|$)/.test(url) ||
    url.includes("v.redd.it") ||
    url.includes("gfycat.com") ||
    url.includes("redgifs.com")
  )
    return "video";

  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";

  if (!url || url.includes("reddit.com/r/") || url.includes("/comments/")) return "text";

  return "link";
}

/** `m:ss`, or `h:mm:ss` from an hour up. */
function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");

  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function durationOf(item: Item): number {
  const duration = item.metadata.duration;

  return duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function withFallback(item: Item, media: CardMedia): CardMedia {
  if (media.fallback) return media;
  const fallback = archivedUrl(item, media.src);

  return fallback && fallback !== media.src ? { ...media, fallback } : media;
}

/** The card's hero media, or null when nothing usable exists. */
export function cardMedia(item: Item): CardMedia | null {
  const md = item.metadata;
  const evidence = mediaEvidence(item);
  const duration = durationOf(item);

  if (evidence === "youtube") {
    const id = youtubeId(item);
    const thumb = usableThumb(md.thumbnail);

    const src = id
      ? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`
      : thumb.replace(/\/[a-z0-9]+default\.jpg(\?.*)?$/i, "/maxresdefault.jpg");

    if (!src) return null;
    const archived = archivedUrl(item, src);

    const fallback =
      archived ||
      (/i\.ytimg\.com/.test(src) ? src.replace("/maxresdefault.jpg", "/hqdefault.jpg") : "");

    const media: CardMedia = { kind: "youtube", src };

    if (fallback && fallback !== src) media.fallback = fallback;

    if (duration) media.badge = `▶ ${clock(duration)}`;

    return media;
  }

  if (evidence === "video") {
    const poster = usableThumb(md.thumbnail) || galleryThumb(item);

    if (!poster) return null;

    return withFallback(item, {
      kind: "video",
      src: poster,
      badge: duration ? `▶ ${clock(duration)}` : "▶ clip",
    });
  }

  if (evidence === "gallery") {
    const src = galleryThumb(item) || usableThumb(md.thumbnail);

    if (!src) return null;
    const count = md.gallery?.length || md.gallery_preview?.length || 0;

    const media: CardMedia = { kind: "gallery", src };

    if (count > 0) media.badge = `1 / ${count}`;

    return withFallback(item, media);
  }

  if (evidence === "image") {
    const src = imageUrl(item) || usableThumb(md.thumbnail);

    return src ? withFallback(item, { kind: "image", src }) : null;
  }

  if (evidence === "link") {
    const src =
      usableThumb(md.thumbnail) ||
      (item.source === "hackernews" ? safeUrl(extraMeta(item).og_image) : "");

    if (!src) return null;
    const domain = domainOf(item.url);

    const media: CardMedia = { kind: "link", src };

    if (domain) media.badge = domain;

    return withFallback(item, media);
  }

  // Text posts: a real (non-sentinel) thumbnail is still worth showing.
  const thumb = usableThumb(md.thumbnail);

  return thumb ? withFallback(item, { kind: "image", src: thumb }) : null;
}

/** Best small preview URL (list density, like media.js `thumb`), or "". */
export function thumbFor(item: Item): string {
  const md = item.metadata;
  let thumb = usableThumb(md.thumbnail);

  if (!thumb && item.source === "hackernews") thumb = safeUrl(extraMeta(item).og_image);

  if (!thumb) thumb = galleryThumb(item);

  if (!thumb) {
    if (/\.(png|jpe?g|gif|webp)$/i.test(item.url)) return safeUrl(item.url);
    const id = youtubeId(item);

    thumb = id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : imageUrl(item);
  }

  if (/i\.ytimg\.com/.test(thumb))
    thumb = thumb.replace(/\/[a-z0-9]+default\.jpg(\?.*)?$/i, "/mqdefault.jpg");

  return thumb;
}

const WORDS_PER_MINUTE = 230;

const MIN_READ_WORDS = 40;

/** A calm effort estimate: "12 min video" | "3 min read" | "a glance" | "clip" | "". */
export function costLabel(item: Item): string {
  const evidence = mediaEvidence(item);
  const duration = durationOf(item);

  if (evidence === "youtube" && duration) {
    if (duration < 60) return `${Math.round(duration)} s clip`;

    return `${Math.max(1, Math.round(duration / 60))} min video`;
  }

  const body = item.body.trim();

  if (body && !isRemovedText(body)) {
    const words = body.split(/\s+/).length;

    if (words >= MIN_READ_WORDS)
      return `${Math.max(1, Math.round(words / WORDS_PER_MINUTE))} min read`;
  }

  if (evidence === "image" || evidence === "gallery") return "a glance";

  if (evidence === "video" && item.source === "reddit") return "clip";

  return "";
}

/** Compact count: 950 → "950", 4200 → "4.2k", 12345 → "12k", 1_200_000 → "1.2M". */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);

  const scaled = (value: number, unit: string): string => {
    const shown = value < 10 ? (Math.floor(value * 10) / 10).toFixed(1) : String(Math.floor(value));

    return shown.replace(/\.0$/, "") + unit;
  };

  if (abs < 1000) return sign + String(Math.round(abs));

  if (abs < 1_000_000) return sign + scaled(abs / 1000, "k");

  if (abs < 1_000_000_000) return sign + scaled(abs / 1_000_000, "M");

  return sign + scaled(abs / 1_000_000_000, "B");
}

/** Hostname without `www.`; "" for non-http(s) or unparsable URLs. */
export function domainOf(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";

    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}
