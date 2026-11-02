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

function connectSection(): SafeHtml | string {
  const google = googleConfigured();
  const twitch = twitchConfigured();

  if (!google && !twitch) return "";

  return html`<section class="add-section">
    <h2>Sign in to bring them over</h2>
    <p class="add-help">Read-only. Khaos never changes your accounts.</p>
    <div class="add-connect">
      ${
        google
          ? html`<a class="add-btn" href="/oauth/google/start?return=/add">YouTube playlists</a>`
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

export function renderAdd(pull: LibraryPull | undefined): SafeHtml {
  return html`<section class="add-page">
    <header class="add-head">
      <h1 class="add-title">Add your stuff</h1>
      <p class="add-sub">Bring in what you saved. Nothing changes in your accounts.</p>
    </header>
    ${renderPull(pull)} ${connectSection()}
    <section class="add-section">
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
    <section class="add-section">
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
    ${
      hostedOrigin()
        ? html`<form class="add-signout" method="post" action="/auth/logout">
            <button class="add-btn" type="submit">Sign out</button>
          </form>`
        : ""
    }
    <script type="module" src="/static/add/add.js"></script>
  </section>`;
}
