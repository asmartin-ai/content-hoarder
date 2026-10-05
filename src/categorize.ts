import { z } from "zod";
import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import * as config from "./config.ts";
import { setAutoTags, setCategory, withTransaction } from "./db.ts";
import { parseMetadata, type Metadata, type RawItem } from "./models.ts";

export const PROCESSING_TAGS = ["listenable", "watch", "wotagei"] as const;

export const LISTENABLE_MIN_SECONDS = 1800;

export const WATCH_MAX_SECONDS = 300;

export const VALID_CATEGORIES = ["listenable", "watch", "wotagei", "unknown"] as const;

const WOTAGEI =
  /ヲタ芸|オタ芸|ﾜｵﾀ|wotagei|\bwota\b|\botagei\b|打ち師|サイリウムダンス|ペンライトダンス|\bcyalume\b/i;

const LISTENABLE_CHANNEL =
  /isaac arthur|perun|lemmino|\blo-?fi\b|\s-\stopic|\bpodcast|\baudiobook|full album|soundtrack/i;

const NsfwRulesSchema = z
  .object({
    talk_subs: z.array(z.string()).optional(),
    erotic_subs: z.array(z.string()).optional(),
    sfw_exclude: z.array(z.string()).optional(),
    erotic_keywords: z.array(z.string()).optional(),
  })
  .catch({});

// The nsfw rule file is re-read per item, but a rule set holds a handful of
// keywords: compile each keyword's case-insensitive matcher once and reuse it.
const _KEYWORD_PATTERNS = new Map<string, RegExp>();

const DurationSecondsSchema = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^[-+]?\d+$/)
      .transform(Number),
  ])
  .nullable()
  .catch(null);

export function categorize(
  title: string,
  channel: string,
  duration: number | string | null,
): (typeof VALID_CATEGORIES)[number] {
  if (WOTAGEI.test(title || "")) return "wotagei";

  if (LISTENABLE_CHANNEL.test(channel || "")) return "listenable";
  const parsedDuration = DurationSecondsSchema.parse(duration) ?? 0;
  const seconds = Number.isFinite(parsedDuration) ? Math.trunc(parsedDuration) : 0;

  if (seconds >= LISTENABLE_MIN_SECONDS) return "listenable";

  if (seconds > 0 && seconds <= WATCH_MAX_SECONDS) return "watch";

  return "unknown";
}

export function categorizeItem(item: {
  title: string;
  metadata: Metadata | string;
}): (typeof VALID_CATEGORIES)[number] {
  const metadata = parseMetadata(item.metadata);

  return categorize(item.title, String(metadata.channel ?? ""), metadata.duration ?? null);
}

export interface CategorizeSourceResult {
  selected: number;
  by_category: Record<string, number>;
}

export function categorizeSource(
  db: Database,
  source = "youtube",
  opts: { limit?: number; retry?: boolean } = {},
): CategorizeSourceResult {
  const where = ["source=?"];
  const params: (string | number)[] = [source];

  if (!opts.retry) where.push("json_extract(metadata,'$.category') IS NULL");
  const limit = opts.limit ? " LIMIT ?" : "";

  if (opts.limit) params.push(Math.trunc(opts.limit));

  const rows = db
    .query<RawItem, (string | number)[]>(
      `SELECT * FROM items WHERE ${where.join(" AND ")} ORDER BY last_seen_utc DESC${limit}`,
    )
    .all(...params);

  const byCategory: Record<string, number> = Object.fromEntries(
    VALID_CATEGORIES.map((category) => [category, 0]),
  );

  withTransaction(db, () => {
    for (const item of rows) {
      const category = categorizeItem(item);
      byCategory[category] = (byCategory[category] ?? 0) + 1;
      setCategory(db, item.fullname, category);
    }
  });

  return { selected: rows.length, by_category: byCategory };
}

export const REDDIT_TAGS = [
  "nsfw_erotic",
  "nsfw_talk",
  "nsfw_other",
  "vtubers",
  "coding",
  "japan",
  "anime",
  "memes",
  "minecraft",
  "defense",
  "science",
  "tips",
  "esports",
  "gaming",
  "investing",
  "ephemeral",
  "ai_ml",
  "web_dev",
  "self_hosted",
  "linux",
  "startups",
  "crypto",
  "productivity",
] as const;

export const FILTER_TAGS = [...REDDIT_TAGS, ...PROCESSING_TAGS] as const;

export const TAG_GROUPS = [
  ["Tech & AI", ["ai_ml", "web_dev", "self_hosted", "linux"]],
  ["Business", ["startups", "crypto", "investing"]],
  ["Gaming", ["gaming", "esports", "minecraft"]],
  ["Anime & Otaku", ["anime", "vtubers", "wotagei"]],
  ["Educational", ["science", "coding", "tips", "productivity"]],
  ["Watchlist", ["watch", "listenable"]],
  ["Memes & Trivial", ["memes", "ephemeral"]],
  ["World & Culture", ["defense", "japan"]],
  ["NSFW", ["nsfw_erotic", "nsfw_talk", "nsfw_other"]],
] as const;

export const RESURFACE_TAGS = ["tips", "coding", "science", "japan"] as const;

export const RESURFACE_SUBREDDITS = [
  "adhd",
  "adhdwomen",
  "askhistorians",
  "personalfinance",
  "philosophy",
  "history",
] as const;

export function tagGroups(): Array<{ label: string; tags: string[] }> {
  return TAG_GROUPS.map(([label, tags]) => ({ label, tags: [...tags] }));
}

const SUBREDDIT_DATA = {
  hololive: "vtubers",
  okbuddyhololive: "vtubers memes",
  nijisanji: "vtubers",
  virtualyoutubers: "vtubers",
  vtubers: "vtubers",
  anime: "anime",
  animemes: "anime memes",
  anime_irl: "anime memes",
  wholesomeanimemes: "anime memes",
  goodanimemes: "anime memes",
  manga: "anime",
  awwnime: "anime",
  okbuddybaka: "anime memes",
  oregairusnafu: "anime",
  characterarcs: "anime memes",
  animewallpaper: "anime",
  minecraft: "minecraft",
  feedthebeast: "minecraft",
  feedthememes: "minecraft memes",
  technicalminecraft: "minecraft",
  mcpe: "minecraft",
  admincraft: "minecraft",
  programming: "coding",
  learnprogramming: "coding",
  programmerhumor: "coding memes",
  webdev: "coding",
  javascript: "coding",
  python: "coding",
  rust: "coding",
  cpp: "coding",
  golang: "coding",
  compsci: "coding",
  cscareerquestions: "coding",
  experienceddevs: "coding",
  engineeringstudents: "coding",
  noncredibledefense: "defense memes",
  noncrediblediplomacy: "defense memes",
  lesscredibledefence: "defense",
  credibledefense: "defense",
  warcollege: "defense",
  combatfootage: "defense",
  militaryporn: "defense",
  tankporn: "defense",
  aviation: "defense",
  warthunder: "defense",
  japan: "japan",
  japanlife: "japan",
  japantravel: "japan",
  learnjapanese: "japan",
  japanpics: "japan",
  space: "science",
  spaceporn: "science",
  askscience: "science",
  science: "science",
  nasa: "science",
  astrophotography: "science",
  physics: "science",
  futurology: "science",
  lifeprotips: "tips",
  youshouldknow: "tips",
  coolguides: "tips",
  explainlikeimfive: "tips",
  todayilearned: "tips",
  diy: "tips",
  howto: "tips",
  internetisbeautiful: "tips",
  dataisbeautiful: "tips",
  memes: "memes",
  dankmemes: "memes",
  greentext: "memes",
  meirl: "memes",
  me_irl: "memes",
  wholesomememes: "memes",
  wholesomegreentext: "memes",
  "4chan": "memes",
  tumblr: "memes",
  adviceanimals: "memes",
  comedyheaven: "memes",
  terriblefacebookmemes: "memes",
  adhdmeme: "memes",
  trashtaste: "anime",
  bocchitherock: "anime",
  sonobisquedoll: "anime",
  shingekinokyojin: "anime",
  killlakill: "anime",
  evangelionmemes: "anime memes",
  okbuddyumamusume: "anime memes",
  okbuddytracen: "anime memes",
  vtubercirclejerk: "vtubers memes",
  raspberry_pi: "coding",
  arduino: "coding",
  warplaneporn: "defense",
  acecombat: "defense",
  ukraine: "defense",
  ukrainewarvideoreport: "defense",
  ukrainianconflict: "defense",
  technology: "science",
  localllama: "ai_ml",
  claudeai: "ai_ml",
  openai: "ai_ml",
  chatgpt: "ai_ml",
  artificial: "ai_ml",
  singularity: "ai_ml",
  stablediffusion: "ai_ml",
  ollama: "ai_ml",
  mistralai: "ai_ml",
  lifehacks: "tips",
  socialskills: "tips",
  outoftheloop: "tips",
  japanesepeopletwitter: "japan memes",
  historymemes: "memes",
  polandball: "memes",
  "2meirl4meirl": "memes",
  starterpacks: "memes",
  shitposting: "memes",
  holup: "memes",
  bikinibottomtwitter: "memes",
  whitepeopletwitter: "memes",
  blackpeopletwitter: "memes",
  curatedtumblr: "memes",
  worldjerking: "memes",
  dankmemesfromsite19: "memes",
  funny: "memes",
  okbuddyphd: "memes",
  "196": "memes",
  okbuddyvicodin: "memes",
  bookscirclejerk: "memes",
  leagueoflegends: "esports",
  leagueofmemes: "esports memes",
  summonerschool: "esports",
  valorant: "esports",
  globaloffensive: "esports",
  csgo: "esports",
  overwatch: "esports",
  competitiveoverwatch: "esports",
  overwatchuniversity: "esports",
  overwatch_memes: "esports memes",
  rainbow6: "esports",
  shittyrainbow6: "esports memes",
  r6proleague: "esports",
  esports: "esports",
  gaming: "gaming",
  games: "gaming",
  truegaming: "gaming",
  pcgaming: "gaming",
  pcmasterrace: "gaming",
  patientgamers: "gaming",
  steam: "gaming",
  gamingcirclejerk: "gaming memes",
  girlgamers: "gaming",
  projectzomboid: "gaming",
  stellaris: "gaming",
  hoi4: "gaming",
  kaiserreich: "gaming",
  civ: "gaming",
  rimworld: "gaming",
  aoe2: "gaming",
  battlefield_one: "gaming",
  cyberpunkgame: "gaming",
  darkestdungeon: "gaming",
  hadesthegame: "gaming",
  satisfactorygame: "gaming",
  osugame: "gaming",
  ddlc: "gaming",
  katawashoujo: "gaming",
  coffinofandyandleyley: "gaming",
  girlsfrontline: "gaming",
  azurelane: "gaming",
  createmod: "minecraft",
  minecraftmemes: "minecraft memes",
  minecraftbuilds: "minecraft",
  gamedev: "coding",
  gamedeals: "ephemeral",
  buildapcsales: "ephemeral",
  freegamefindings: "ephemeral",
  frugalmalefashion: "ephemeral",
  freebies: "ephemeral",
  animegifs: "anime",
  animenocontext: "anime memes",
  animememes: "anime memes",
  historyanimemes: "anime memes",
  spyxfamily: "anime",
  kiminonawa: "anime",
  evangelion: "anime",
  domesticgirlfriend: "anime",
  kanojookarishimasu: "anime",
  wholesomeyuri: "anime",
  nagatoro: "anime",
  seishunbutayarou: "anime",
  whenthe: "memes",
  bi_irl: "memes",
  newgreentexts: "memes",
  anarchychess: "memes",
  cursedcomments: "memes",
  unexpected: "memes",
  brandnewsentence: "memes",
  murderedbywords: "memes",
  nonpoliticaltwitter: "memes",
  blursedimages: "memes",
  tihi: "memes",
  suspiciouslyspecific: "memes",
  hopeposting: "memes",
  discord_irl: "memes",
  youtubehaiku: "memes",
  perfectlycutscreams: "memes",
  maybemaybemaybe: "memes",
  hmmm: "memes",
  meme: "memes",
  chadtopia: "memes",
  extrafabulouscomics: "memes",
  politicalcompassmemes: "memes",
  politicalhumor: "memes",
  dndmemes: "memes",
  roughromanmemes: "memes",
  oddlyspecific: "memes",
  physicsmemes: "science memes",
  mathmemes: "science memes",
  shermanposting: "defense memes",
  military: "defense",
  spacex: "science",
  engineeringporn: "science",
  learnpython: "coding",
  learnmachinelearning: "ai_ml",
  machinelearning: "ai_ml",
  datascience: "ai_ml",
  linux: "coding",
  hacking: "coding",
  howtohack: "coding",
} satisfies Record<string, string>;

export const SUBREDDIT_TAGS = Object.fromEntries(
  Object.entries(SUBREDDIT_DATA).map(([sub, tags]) => [sub, tags.split(" ")]),
);

const REDDIT_KEYWORDS: Array<[string, RegExp]> = [
  ["minecraft", /\bminecraft\b|\bmodpack\b/i],
  ["anime", /\banime\b|\bmanga\b|\bwaifu\b/i],
  ["vtubers", /\bvtuber\b|hololive|nijisanji/i],
  ["defense", /\bnon[- ]?credible\b/i],
  ["japan", /\bjapan(ese)?\b/i],
  [
    "ephemeral",
    /\b(?<!dead )giveaway\b|\d+\s*%\s*off\b|\bsale\s+ends\b|\blast\s+chance\b|\blimited[- ]time\b|\bfree\s+until\b|\bfree\s+weekend\b|\bfree\s+to\s+keep\b|\bhumble\s+bundle\b|\bpromo\s+code\b|\bcoupon\b|\bexpires\b|\bflash\s+sale\b/i,
  ],
  [
    "ai_ml",
    /\bllm\b|\bgpt[- ]?\d+\b|\bchatgpt\b|\bclaude\s+(?:\d|ai|model|sonnet|opus|haiku)\b|\btransformer\b|\bembedding\b|\bneural network\b|\bmachine learning\b|\bdeep learning\b|\bartificial intelligence\b/i,
  ],
];

export const KEYWORD_TAGS = REDDIT_KEYWORDS;

function keywordPattern(keyword: string): RegExp {
  let pattern = _KEYWORD_PATTERNS.get(keyword);

  if (!pattern) {
    pattern = new RegExp(keyword, "i");
    _KEYWORD_PATTERNS.set(keyword, pattern);
  }

  return pattern;
}

function nsfwTag(subreddit: string, metadata: Metadata): string | null {
  let rules: z.infer<typeof NsfwRulesSchema>;

  try {
    rules = NsfwRulesSchema.parse(
      JSON.parse(readFileSync(config.get("CONTENT_HOARDER_NSFW_RULES"), "utf8")),
    );
  } catch {
    rules = {};
  }

  if ((rules.talk_subs ?? []).some((name) => name.toLowerCase() === subreddit)) return "nsfw_talk";

  if ((rules.erotic_subs ?? []).some((name) => name.toLowerCase() === subreddit))
    return "nsfw_erotic";

  const keywords = (rules.erotic_keywords ?? []).flatMap((name) => {
    const keyword = name.trim();

    return keyword ? [keyword] : [];
  });

  const excluded = (rules.sfw_exclude ?? []).some((name) => name.toLowerCase() === subreddit);

  if (!excluded && keywords.some((keyword) => keywordPattern(keyword).test(subreddit)))
    return "nsfw_erotic";

  return metadata.over_18 ? "nsfw_other" : null;
}

export function redditTags(item: { title?: string; metadata?: Metadata }): string[] {
  const metadata = item.metadata ?? {};
  const subreddit = String(metadata.subreddit ?? "").toLowerCase();
  const tags: string[] = [];
  const nsfw = nsfwTag(subreddit, metadata);

  if (nsfw) tags.push(nsfw);

  for (const tag of SUBREDDIT_TAGS[subreddit] ?? []) if (!tags.includes(tag)) tags.push(tag);

  if (!tags.some((tag) => !["nsfw_erotic", "nsfw_talk", "nsfw_other"].includes(tag))) {
    const haystack = `${subreddit} ${item.title ?? ""}`;

    for (const [tag, pattern] of KEYWORD_TAGS)
      if (pattern.test(haystack) && !tags.includes(tag)) tags.push(tag);
  }

  return tags;
}

const YOUTUBE_CHANNEL_TAGS = {
  "isaac arthur": ["science"],
  kurzgesagt: ["science"],
  veritasium: ["science"],
  "tom scott": ["science"],
  "practical engineering": ["science"],
  "technology connections": ["science"],
  perun: ["defense"],
  fireship: ["coding"],
  primeagen: ["coding"],
  lockpickinglawyer: ["tips"],
  "gamers nexus": ["gaming"],
  "digital foundry": ["gaming"],
  hololive: ["vtubers"],
  nijisanji: ["vtubers"],
  "abroad in japan": ["japan"],
  "trash taste": ["anime"],
} satisfies Record<string, string[]>;

const YOUTUBE_KEYWORDS: Array<[string, RegExp]> = [
  ["minecraft", /\bminecraft\b|\bmodpack\b/i],
  ["anime", /\banime\b|\bmanga\b/i],
  ["vtubers", /\bvtuber\b|hololive|nijisanji/i],
  ["japan", /\bjapan(ese)?\b/i],
  ["coding", /\bpython\b|\bjavascript\b|\brust\b|\bprogramming\b/i],
];

export function youtubeTags(item: { title?: string; metadata?: Metadata }): string[] {
  const metadata = item.metadata ?? {};
  const channel = String(metadata.channel ?? "").toLowerCase();

  const tags = [
    ...new Set(
      Object.entries(YOUTUBE_CHANNEL_TAGS)
        .filter(([key]) => channel.includes(key))
        .flatMap(([, values]) => values),
    ),
  ];

  if (tags.length) return tags;

  return YOUTUBE_KEYWORDS.flatMap(([tag, pattern]) =>
    pattern.test(item.title ?? "") ? [tag] : [],
  );
}

const BROWSER_HOST_TAGS = {
  steampowered: ["gaming"],
  defensenews: ["defense"],
  hololive: ["vtubers"],
  nijisanji: ["vtubers"],
  vshojo: ["vtubers"],
  melonbooks: ["anime"],
  aniwave: ["anime"],
  crunchyroll: ["anime"],
  modrinth: ["minecraft"],
  curseforge: ["minecraft"],
  planetminecraft: ["minecraft"],
  "feed-the-beast": ["minecraft"],
  stardewvalleywiki: ["gaming"],
  pzwiki: ["gaming"],
  game8: ["gaming"],
  "github.com": ["coding"],
  "gitlab.com": ["coding"],
  "stackoverflow.com": ["coding"],
  "nature.com": ["science"],
  "arxiv.org": ["science"],
  "ieee.org": ["science"],
  "sciencedirect.com": ["science"],
  "openai.com": ["ai_ml"],
  "anthropic.com": ["ai_ml"],
  "huggingface.co": ["ai_ml"],
  "deeplearning.ai": ["ai_ml"],
  "cohere.com": ["ai_ml"],
  "replicate.com": ["ai_ml"],
  "together.ai": ["ai_ml"],
  "css-tricks.com": ["web_dev"],
  "smashingmagazine.com": ["web_dev"],
  "frontendmasters.com": ["web_dev"],
  "vercel.com": ["web_dev"],
  "netlify.com": ["web_dev"],
  "selfh.st": ["self_hosted"],
  "linuxserver.io": ["self_hosted"],
  "nextcloud.com": ["self_hosted"],
  "owncloud.com": ["self_hosted"],
  "linuxjournal.com": ["linux"],
  "lwn.net": ["linux"],
  "archlinux.org": ["linux"],
  "kernel.org": ["linux"],
  "techcrunch.com": ["startups"],
  "wellfound.com": ["startups"],
  "crunchbase.com": ["startups"],
  "coindesk.com": ["crypto"],
  "cointelegraph.com": ["crypto"],
  "decrypt.co": ["crypto"],
  "ethereum.org": ["crypto"],
  "bitcoinmagazine.com": ["crypto"],
  "notion.so": ["productivity"],
  "obsidian.md": ["productivity"],
  "todoist.com": ["productivity"],
  "gettingthingsdone.com": ["productivity"],
} satisfies Record<string, string[]>;

export const BROWSER_HOST_TAG_MAP = BROWSER_HOST_TAGS;

const BROWSER_KEYWORDS: Array<[string, RegExp]> = [
  ["gaming", /\bvideo\s+games?\b|\bgame\s+engine\b|\bsteam\s+(?:deck|library|store|games?)\b/i],
  ["defense", /\bmilitary\b/i],
  [
    "investing",
    /\bearnings\s+(?:beat|miss|call|report)\b|\bstock\s+markets?\b|\bindex[- ]fund\b|\bbond\s+yields?\b|\bstocks?\s+(?:rally|fall|falls|selloff|surge|surges|slide|slides)\b|\bvalue\s+investors?\b/i,
  ],
  ["vtubers", /\bvtuber\b|hololive|nijisanji|vshojo/i],
  ["anime", /\banime\b|\bmanga\b/i],
  ["minecraft", /\bminecraft\b|modrinth|feedthebeast/i],
  ["japan", /\bjapan(ese)?\b|\btokyo\b/i],
  [
    "ai_ml",
    /\bllm\b|\bgpt[- ]?\d+\b|\bchatgpt\b|\bclaude\s+(?:\d|ai|model|sonnet|opus|haiku)\b|\btransformer\b|\bembedding\b|\bneural network\b|\bmachine learning\b|\bdeep learning\b|\bartificial intelligence\b/i,
  ],
  [
    "web_dev",
    /\breact\b|\bvue\b|\bsvelte\b|\bweb dev\b|\bfrontend\b|\bcss\s+(?:grid|flexbox|tricks)\b|\bhtml\s+(?:canvas|forms?|pages?)\b/i,
  ],
  ["self_hosted", /\bself[- ]?hosted\b|\bhomelab\b|\bnextcloud\b|\bhome server\b|\bpi-hole\b/i],
  ["linux", /\blinux\b|\bkernel\b|\bdebian\b|\barch linux\b|\bwayland\b|\bsystemd\b/i],
  [
    "startups",
    /\bstartups?\b|\by combinator\b|\byc\s+[ws]\d{2}\b|\bseed round\b|\bseries a\b|\bventure capital\b|\bindie hacker\b/i,
  ],
  [
    "crypto",
    /\bcryptocurrency\b|\bcrypto\s+(?:wallet|exchange|market|trading|token|coin|currenc(?:y|ies))\b|\bblockchain\b|\bnft\b|\bweb3\b|\bsolidity\b|\bdefi\b/i,
  ],
  [
    "productivity",
    /\bproductivity\b|\bnote-taking\b|\bgetting things done\b|\bpomodoro\b|\btime management\b/i,
  ],
];

export const BROWSER_KEYWORD_TAGS = BROWSER_KEYWORDS;

function browserTags(domain: string, title: string): string[] {
  const normalized = domain.toLowerCase();

  const mapped = [
    ...new Set(
      Object.entries(BROWSER_HOST_TAGS)
        .filter(([host]) => normalized.includes(host))
        .flatMap(([, tags]) => tags),
    ),
  ];

  return mapped.length
    ? mapped
    : BROWSER_KEYWORDS.flatMap(([tag, pattern]) => (pattern.test(title) ? [tag] : []));
}

function itemHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function firefoxTags(item: { title?: string; url?: string; metadata?: Metadata }): string[] {
  return browserTags(String(item.metadata?.domain ?? itemHost(item.url ?? "")), item.title ?? "");
}

export function hackernewsTags(item: { title?: string; url?: string }): string[] {
  return browserTags(itemHost(item.url ?? ""), item.title ?? "");
}

interface TaggableRow {
  fullname: string;
  title: string;
  url: string;
  metadata: string;
}

interface TagResultOptions {
  limit?: number;
  retry?: boolean;
  dryRun?: boolean;
  samples?: number;
}

function tagSource(
  db: Database,
  source: string,
  tagger: (item: { title: string; url: string; metadata: Metadata }) => string[],
  opts: TagResultOptions,
  topicTags: readonly string[] = REDDIT_TAGS,
) {
  const where = ["source=?"];
  const params: (string | number)[] = [source];

  if (!opts.retry && !opts.dryRun && source !== "youtube")
    where.push("json_extract(metadata,'$.tags') IS NULL");
  const limit = opts.limit ? " LIMIT ?" : "";

  if (opts.limit) params.push(Math.trunc(opts.limit));

  // SAFETY: SELECT projects fullname,title,url,metadata, matching TaggableRow.
  const rows = db
    .query(
      `SELECT fullname,title,url,metadata FROM items WHERE ${where.join(" AND ")} ORDER BY last_seen_utc DESC${limit}`,
    )
    .all(...params) as TaggableRow[];

  const counts: Record<string, number> = Object.fromEntries(topicTags.map((tag) => [tag, 0]));
  const samples: Record<string, string[]> = Object.fromEntries(topicTags.map((tag) => [tag, []]));
  const untaggedSample: string[] = [];
  let untagged = 0;
  let processed = 0;
  const maxSamples = opts.samples ?? 6;

  const processRows = () => {
    for (const row of rows) {
      const metadata = parseMetadata(row.metadata);
      const currentTags = Array.isArray(metadata.tags) ? metadata.tags : [];

      if (
        source === "youtube" &&
        !opts.retry &&
        !opts.dryRun &&
        currentTags.some((tag) => topicTags.includes(tag))
      )
        continue;
      processed++;
      const tags = tagger({ title: row.title ?? "", url: row.url ?? "", metadata });

      const label =
        source === "reddit"
          ? `r/${metadata.subreddit ?? "?"}: ${(row.title ?? "").slice(0, 60)}`
          : source === "youtube"
            ? `${metadata.channel ?? "?"}: ${(row.title ?? "").slice(0, 60)}`
            : (row.title ?? "").slice(0, 70);

      if (tags.length) {
        for (const tag of tags) {
          const tagSamples = (samples[tag] ??= []);

          if (tagSamples.length < maxSamples) tagSamples.push(label);

          if (!opts.dryRun)
            setAutoTags(db, row.fullname, tags, {
              preserveTags:
                source === "youtube"
                  ? currentTags.filter((tag) =>
                      PROCESSING_TAGS.some((processingTag) => processingTag === tag),
                    )
                  : [],
              lastSeenUtc: Math.floor(Date.now() / 1000),
            });
        }
      } else {
        untagged++;

        if (untaggedSample.length < maxSamples * 2) untaggedSample.push(label);

        if (opts.retry && !opts.dryRun && metadata.tags_auto)
          setAutoTags(db, row.fullname, [], {
            preserveTags:
              source === "youtube"
                ? currentTags.filter((tag) =>
                    PROCESSING_TAGS.some((processingTag) => processingTag === tag),
                  )
                : [],
            lastSeenUtc: Math.floor(Date.now() / 1000),
          });
      }
    }
  };

  if (opts.dryRun) processRows();
  else withTransaction(db, processRows);
  const visibleCounts = Object.fromEntries(Object.entries(counts).filter(([, count]) => count));

  const visibleSamples = Object.fromEntries(
    Object.entries(samples).filter(([, values]) => values.length),
  );

  const result = {
    selected: processed,
    dry_run: opts.dryRun ?? false,
    tagged: processed - untagged,
    untagged,
    by_tag: visibleCounts,
    samples: visibleSamples,
    untagged_sample: untaggedSample,
  };

  return source === "firefox" || source === "hackernews" ? { source, ...result } : result;
}

export function tagRedditSource(db: Database, opts: TagResultOptions = {}) {
  return tagSource(db, "reddit", ({ title, metadata }) => redditTags({ title, metadata }), opts);
}

export function tagYoutubeSource(db: Database, opts: TagResultOptions = {}) {
  return tagSource(db, "youtube", ({ title, metadata }) => youtubeTags({ title, metadata }), opts);
}

export function tagBrowserSource(db: Database, source: string, opts: TagResultOptions = {}) {
  if (source !== "firefox" && source !== "hackernews")
    throw new Error(`tagBrowserSource: unsupported source ${JSON.stringify(source)}`);

  return tagSource(db, source, source === "firefox" ? firefoxTags : hackernewsTags, opts);
}
