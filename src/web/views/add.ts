import { googleConfigured, hostedOrigin, twitchConfigured } from "../../hosted.ts";
import type { LibraryPull } from "../state.ts";
import { html, type SafeHtml } from "./html.ts";

const REDDIT_SAVES = [
  "(async()=>{",
  "const fail=m=>alert('Khaos: '+m);",
  "if(!/(^|\\.)reddit\\.com$/.test(location.hostname))return fail('open reddit.com first, then click this again.');",
  "const get=async u=>{const r=await fetch(u,{credentials:'include'});if(!r.ok)throw new Error('Reddit answered '+r.status);return r.json()};",
  "try{",
  "const me=await get('/api/me.json');const name=me&&me.data&&me.data.name;",
  "if(!name)return fail('log in to Reddit first.');",
  "const children=[];let after='';",
  "do{const page=await get('/user/'+encodeURIComponent(name)+'/saved.json?limit=100&raw_json=1'+(after?'&after='+encodeURIComponent(after):''));",
  "const list=(page.data&&page.data.children)||[];children.push(...list);after=(page.data&&page.data.after)||'';",
  "}while(after&&children.length<1000);",
  "const blob=new Blob([JSON.stringify({kind:'Listing',data:{children:children,after:null}})],{type:'application/json'});",
  "const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='reddit-saved.json';document.body.appendChild(a);a.click();a.remove();",
  "alert('Khaos: saved '+children.length+' items to reddit-saved.json. Drop that file on the Add page.');",
  "}catch(e){fail(e.message)}",
  "})();",
].join("");

export const REDDIT_BOOKMARKLET = `javascript:${encodeURIComponent(REDDIT_SAVES)}`;

const PULLED_LABELS = new Map([
  ["youtube", "YouTube"],
  ["twitch", "Twitch"],
]);

const CONNECT_YOUTUBE_HREF = "/oauth/google/start?connect=youtube&return=%2Fadd%3Fyoutube%3Dchoose";

export interface YoutubePlaylistView {
  id: string;
  title: string;
  count: number | null;
  imported: boolean;
}

export type YoutubeChoiceView =
  | {
      state: "choose";
      playlists: YoutubePlaylistView[];
      expiresIn: number;
      generation: string;
    }
  | { state: "expired" }
  | { state: "none" }
  | { state: "denied" };

export interface OnboardingView {
  step: 1 | 2 | 3;
  collapsed: boolean;
}

function playlistRow(playlist: YoutubePlaylistView): SafeHtml {
  return html`<label class="add-yt-row">
    <input class="add-yt-check" type="checkbox" name="ids" value="${playlist.id}" />
    <span class="add-yt-main">
      <span class="add-yt-name">${playlist.title}</span>
      ${
        playlist.count === null
          ? ""
          : html`<span class="add-yt-count"
              >${playlist.count} ${playlist.count === 1 ? "item" : "items"}</span
            >`
      }
    </span>
    ${playlist.imported ? html`<span class="add-yt-tag">Already imported</span>` : ""}
  </label>`;
}

function youtubeStopped(state: "expired" | "none", imported: boolean): SafeHtml {
  const line = state === "expired" ? "Your YouTube sign-in timed out." : "Nothing to choose yet.";

  return html`<section class="add-section add-yt" aria-labelledby="add-youtube-title">
    <h2 id="add-youtube-title" tabindex="-1">Choose YouTube playlists</h2>
    <p class="add-note" role="status">${line}</p>
    <a class="add-btn" href="${CONNECT_YOUTUBE_HREF}"
      >${imported ? "Choose more YouTube playlists" : "Connect YouTube"}</a
    >
  </section>`;
}

function youtubeChooser(playlists: YoutubePlaylistView[], generation: string): SafeHtml {
  return html`<section
    class="add-section add-yt"
    id="add-youtube"
    aria-labelledby="add-youtube-title"
    data-youtube-choice
  >
    <h2 id="add-youtube-title" tabindex="-1">Choose YouTube playlists</h2>
    <p class="add-help">Pick what to bring over. Nothing is ticked yet.</p>
    <form id="add-youtube-form" data-generation="${generation}">
      <fieldset class="add-yt-list">
        <legend class="add-label">Playlists</legend>
        ${playlists.map(playlistRow)}
      </fieldset>
      <p class="add-help">This list stays open for 10 minutes.</p>
      <div class="add-preview-actions">
        <button id="add-youtube-all" class="add-yt-all" type="button" aria-pressed="false">
          Select all
        </button>
        <button id="add-youtube-import" class="add-btn is-primary" type="submit" disabled>
          Import playlists
        </button>
      </div>
    </form>
    <p id="add-youtube-status" class="add-note" hidden role="status"></p>
  </section>`;
}

function youtubeSection(
  choice: YoutubeChoiceView | undefined,
  imported: boolean,
): SafeHtml | string {
  if (!choice) return "";

  if (choice.state === "choose") return youtubeChooser(choice.playlists, choice.generation);

  if (choice.state === "denied")
    return html`<p class="add-note add-yt-denied" role="status">
      No problem — YouTube stays off. You can connect it any time.
    </p>`;

  return youtubeStopped(choice.state, imported);
}

export function renderPull(pull: LibraryPull | undefined): SafeHtml | string {
  const label = pull ? PULLED_LABELS.get(pull.source) : undefined;

  if (!pull || !label) return "";

  if (pull.state === "running")
    return html`<p
      class="add-note"
      role="status"
      hx-get="/hx/add/pull"
      hx-trigger="every 2s"
      hx-swap="outerHTML"
    >
      ${label}: bringing your saves over. You can use Khaos meanwhile.
    </p>`;

  if (pull.state === "error")
    return html`<p class="add-note is-error" role="status">
      ${label} didn't share anything.
      ${
        pull.source === "youtube"
          ? "On Google's screen, tick the YouTube box, then try again."
          : "Try again in a minute."
      }
    </p>`;

  if (pull.state === "cancelled")
    return html`<p class="add-note" role="status">${label} wasn't connected.</p>`;

  if (pull.count === 0)
    return html`<p class="add-note" role="status">
      ${label}: nothing new on that account. Signed in to the right one?
    </p>`;

  return html`<p class="add-note is-ok" role="status">
    ${label}: ${pull.count} ${pull.count === 1 ? "item" : "items"} added.
    <a href="/clear?n=10">Clear 10 →</a>
  </p>`;
}

function connectSection(imported: boolean): SafeHtml | string {
  const google = googleConfigured();
  const twitch = twitchConfigured();

  if (!google && !twitch) return "";

  return html`<section class="add-section">
    <h2>Sign in to bring them over</h2>
    <p class="add-help">Read-only. Khaos never changes your accounts.</p>
    <div class="add-connect">
      ${
        google
          ? html`<a class="add-btn" href="${CONNECT_YOUTUBE_HREF}"
              >${imported ? "Choose more YouTube playlists" : "Connect YouTube"}</a
            >`
          : ""
      }
      ${
        twitch
          ? html`<a class="add-btn" href="/oauth/twitch/start?return=/add">Twitch follows</a>`
          : ""
      }
    </div>
    <p class="add-help">
      YouTube's Watch Later list can't be read this way (Google blocks it). Liked videos and your
      own playlists come over.
    </p>
  </section>`;
}

function onboardingSteps(step: 1 | 2 | 3): SafeHtml {
  const bodies = new Map<1 | 2 | 3, SafeHtml>([
    [
      1,
      html`<p class="add-welcome-line">Bring in your saves</p>
        <div class="add-welcome-sources">
          <a class="add-welcome-chip is-primary" href="${CONNECT_YOUTUBE_HREF}">Connect YouTube</a>
          <a class="add-welcome-chip" href="#add-reddit">Reddit</a>
          <a class="add-welcome-chip" href="#add-tabs">Tabs/links</a>
        </div>
        <p class="add-welcome-quiet">
          Google will warn that it hasn't verified Khaos yet. Tap Advanced, then Go to
          khaosapp.tech, and tick the YouTube box.
        </p>`,
    ],
    [
      2,
      html`<p class="add-welcome-line"><a class="add-welcome-link" href="/clear">Clear 10</a></p>`,
    ],
    [3, html`<p class="add-welcome-line">Done for today. Nothing is owed.</p>`],
  ]);

  return html`<ol class="add-welcome-steps">
    ${([1, 2, 3] as const).map((row) => {
      const done = row < step;
      const current = row === step;

      const classes = ["add-welcome-step", current ? "is-current" : "", done ? "is-done" : ""]
        .filter(Boolean)
        .join(" ");

      return html`<li class="${classes}" ${current ? html` aria-current="step"` : ""}>
        <span class="add-sr">Step ${row} of 3${current ? ", current" : done ? ", done" : ""}.</span>
        <span class="add-welcome-badge" aria-hidden="true">${done ? "✓" : row}</span>
        <div class="add-welcome-body">${bodies.get(row)}</div>
      </li>`;
    })}
  </ol>`;
}

function onboardingSection(onboarding: OnboardingView | undefined): SafeHtml | string {
  if (!onboarding || !hostedOrigin()) return "";

  const steps = onboardingSteps(onboarding.step);
  const collapsed = onboarding.collapsed;

  return html`<section
    class="add-welcome${collapsed ? " is-collapsed" : ""}"
    aria-label="Getting started"
    data-onboarding-step="${onboarding.step}"
  >
    <div class="add-welcome-full" ${collapsed ? html`hidden` : ""}>
      <h2 class="add-welcome-title">Start here</h2>
      ${steps}
      ${
        onboarding.step === 3
          ? html`<button class="add-welcome-gotit" type="button" data-onboarding-seen>
              Got it
            </button>`
          : ""
      }
    </div>
    <div class="add-welcome-collapsed" ${collapsed ? "" : html`hidden`}>
      <p class="add-welcome-summary">
        You're set up · <a class="add-welcome-link" href="/clear" data-onboarding-seen>Clear 10</a>
      </p>
      <details class="add-welcome-more">
        <summary>Show steps</summary>
        ${steps}
      </details>
    </div>
  </section>`;
}

export interface AiSettingsView {
  on: boolean;
}

function aiSection(ai: AiSettingsView | undefined): SafeHtml | string {
  if (!ai) return "";

  return html`<section class="add-section" data-ai-settings>
    <h2>AI suggestions</h2>
    <p class="add-help">
      AI suggestions: ${ai.on ? "On" : "Off"} · <a href="/settings">Settings</a>
    </p>
  </section>`;
}

export function renderAdd(
  pull: LibraryPull | undefined,
  ai?: AiSettingsView,
  youtube?: YoutubeChoiceView,
  onboarding?: OnboardingView,
  youtubeImported = false,
): SafeHtml {
  return html`<section class="add-page">
    <header class="add-head">
      <h1 class="add-title">Add your stuff</h1>
      <p class="add-sub">Bring in what you saved. Nothing changes in your accounts.</p>
    </header>
    <div id="add-pull">${renderPull(pull)}</div>
    ${onboardingSection(onboarding)} ${youtubeSection(youtube, youtubeImported)}
    ${connectSection(youtubeImported)} ${aiSection(ai)}
    <section class="add-section" id="add-tabs">
      <h2>Tabs on your computer</h2>
      <ol class="add-steps">
        <li>Chrome or Edge: press <b>Ctrl+Shift+D</b> to bookmark all tabs into one folder.</li>
        <li>
          Open the bookmarks manager (<b>Ctrl+Shift+O</b>) → ⋮ →
          <b>Export bookmarks</b>.
        </li>
        <li>Drop that file here.</li>
      </ol>
      <label class="add-drop" id="add-drop">
        <input id="add-file" type="file" accept=".html,.htm,.txt,.json,.csv,.zip" />
        <span class="add-drop-main">Drop a file here</span>
        <span class="add-drop-sub">or tap to choose one</span>
      </label>
      <label class="add-label" for="add-paste">Or paste links (one per line is fine)</label>
      <textarea id="add-paste" class="add-paste" rows="5" placeholder="https://…"></textarea>
      <button id="add-paste-go" class="add-btn" type="button">Preview pasted links</button>
    </section>
    <section id="add-preview" class="add-preview" hidden aria-live="polite">
      <p id="add-preview-line" class="add-preview-line"></p>
      <ul id="add-preview-list" class="add-preview-list"></ul>
      <div class="add-preview-actions">
        <button id="add-commit" class="add-btn is-primary" type="button">Add them</button>
        <button id="add-cancel" class="add-btn" type="button">Cancel</button>
      </div>
    </section>
    <p id="add-status" class="add-note" hidden role="status"></p>
    <section class="add-section" id="add-reddit">
      <h2>Reddit saves</h2>
      <p class="add-help add-phone">
        On a phone, the button below can't run. Use Reddit's data request instead (last line), or do
        the button on a computer.
      </p>
      <ol class="add-steps">
        <li>
          On a computer, drag this button to your bookmarks bar:
          <a class="add-bookmarklet" href="${REDDIT_BOOKMARKLET}">Get my Reddit saves</a>
        </li>
        <li>Open reddit.com, logged in, and click it. It only reads; a file downloads.</li>
        <li>Drop <code>reddit-saved.json</code> in the box above.</li>
      </ol>
      <p class="add-sub add-more">
        More than 1,000 saves, or on a phone?
        <a href="https://www.reddit.com/settings/data-request" target="_blank" rel="noopener"
          >Request your Reddit data</a
        >
        (Reddit says up to 30 days), then drop the ZIP in the box above. The button stops at 1,000;
        cards from the ZIP show only the title from the link.
      </p>
    </section>
    <script type="module" src="/static/add/add.js"></script>
  </section>`;
}
