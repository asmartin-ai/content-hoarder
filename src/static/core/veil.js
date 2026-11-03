export const NSFW_TAGS = ["nsfw_erotic", "nsfw_other", "nsfw_talk"];

const BLURRED = /[?&]blur=\d/i;

const REDDIT_PREVIEW = /^https?:\/\/preview\.redd\.it\/([^?#]+)/i;

const STATIC_IMAGE = /\.(?:jpe?g|png|webp)$/i;

const REDDIT_ORIGINAL = /^https?:\/\/i\.redd\.it\//i;

const HTTP = /^https?:\/\//i;

export const isBlurredUrl = (url) => BLURRED.test(String(url || ""));

const metadataOf = (item) => (item && item.metadata) || {};

export const isNsfw = (item) => {
  const md = metadataOf(item);

  if (md.over_18 === true || md.over_18 === 1) return true;

  const tags = Array.isArray(md.tags) ? md.tags : [];

  return tags.some((tag) => NSFW_TAGS.includes(tag));
};

export const isSpoiler = (item) => Boolean(metadataOf(item).spoiler);

export const isVeiled = (item) => isNsfw(item) || isSpoiler(item);

export const veilLabel = (item, detailed) => {
  if (isNsfw(item)) return detailed ? "NSFW · tap to reveal" : "NSFW";

  if (isSpoiler(item)) return detailed ? "Spoiler · tap to reveal" : "Spoiler";

  return "";
};

const sourceImage = (item) => {
  const md = metadataOf(item);
  const candidates = [item && item.url, md.media_url];

  if (Array.isArray(md.gallery)) candidates.push(...md.gallery);

  return (
    candidates
      .map((url) => String(url || "").trim())
      .find(
        (url) =>
          HTTP.test(url) &&
          !BLURRED.test(url) &&
          (STATIC_IMAGE.test(url.split("?")[0]) || REDDIT_ORIGINAL.test(url)),
      ) || ""
  );
};

const isStaticImagePost = (item) => {
  const md = metadataOf(item);

  return md.media_type === "image" && !(Array.isArray(md.gallery) && md.gallery.length);
};

export const gallerySlides = (full, previews) => {
  const originals = Array.isArray(full) ? full : [];
  const sized = Array.isArray(previews) ? previews : [];

  if (sized.length !== originals.length) return originals;

  return sized.map((url, index) => (isBlurredUrl(url) ? originals[index] : url));
};

export const sharpImage = (item, url) => {
  const value = String(url || "").trim();

  if (!BLURRED.test(value)) return value;

  const original = sourceImage(item);

  if (original) return original;
  const match = REDDIT_PREVIEW.exec(value);
  const file = match && match[1] ? match[1] : "";

  if (file && isStaticImagePost(item) && STATIC_IMAGE.test(file))
    return "https://i.redd.it/" + file;

  return value;
};
