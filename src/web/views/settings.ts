import { html, type SafeHtml } from "./html.ts";

export interface SettingsAi {
  on: boolean;
  provider: string;
}

export interface SettingsUnsave {
  enabled: boolean;
  username: string | null;
  pending: number;
  failed: number;
}

export interface SettingsView {
  ai: SettingsAi | null;
  retention: { days: number; total: number; cutoff: number };
  unsave: SettingsUnsave;
}

function toggle(name: string, on: boolean): SafeHtml {
  return html`<button
    class="settings-switch"
    type="button"
    data-settings-${name}
    aria-pressed="${on ? "true" : "false"}"
  >
    <span data-settings-${name}-state>${on ? "On" : "Off"}</span>
  </button>`;
}

function seg(name: string, options: Array<[string, string]>, active: string): SafeHtml {
  return html`<div class="settings-seg">
    ${options.map(
      ([value, label]) =>
        html`<button
          type="button"
          data-settings-${name}="${value}"
          aria-pressed="${value === active ? "true" : "false"}"
        >
          ${label}
        </button>`,
    )}
  </div>`;
}

const RETENTION_PRESETS = [7, 30, 90, 180, 365];

function retentionOptions(days: number): Array<[string, string]> {
  const values = RETENTION_PRESETS.includes(days)
    ? RETENTION_PRESETS
    : [...RETENTION_PRESETS, days].sort((a, b) => a - b);

  return values.map((value) => [String(value), `${value} days`]);
}

function dateOf(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function retentionText(total: number, cutoff: number): string {
  if (!total) return "Nothing is eligible right now.";

  return `${total.toLocaleString()} Done ${total === 1 ? "item" : "items"} older than ${dateOf(cutoff)} would be permanently deleted.`;
}

function aiGroup(ai: SettingsAi | null): SafeHtml | string {
  if (!ai) return "";

  return html`<section class="settings-group" data-settings-group="ai">
    <div class="settings-group-head">
      <h2>AI suggestions</h2>
      ${toggle("ai", ai.on)}
    </div>
    <p class="settings-help">
      Keep or Archive hints on Clear cards, written by <b>${ai.provider}</b>. You still decide every
      card.
    </p>
    <p class="settings-help">
      Each hint sends the card's fields and your decision counts for that source to ${ai.provider}.
      <a href="/privacy">What's sent</a>.
    </p>
  </section>`;
}

export function renderSettings(view: SettingsView): SafeHtml {
  return html`<section class="settings-page">
    <header class="settings-head">
      <h1 class="settings-title">Settings</h1>
      <p class="settings-sub">How Khaos looks, remembers, and touches the outside world.</p>
    </header>
    ${aiGroup(view.ai)}

    <section class="settings-group" data-settings-group="theme">
      <h2>Theme</h2>
      ${seg(
        "theme",
        [
          ["light", "Day log"],
          ["dark", "Night ops"],
        ],
        "dark",
      )}
    </section>

    <section class="settings-group" data-settings-group="density">
      <h2>Density</h2>
      ${seg(
        "density",
        [
          ["compact", "Ledger"],
          ["comfortable", "Log"],
          ["card", "Pinboard"],
        ],
        "comfortable",
      )}
    </section>

    <section class="settings-group" data-settings-group="goal">
      <h2>Daily goal</h2>
      ${seg(
        "goal",
        [
          ["4", "4"],
          ["8", "8"],
          ["12", "12"],
          ["0", "No goal"],
        ],
        "8",
      )}
      <p class="settings-help">
        Pebbles on the Today screen. Resets quietly each day — nothing carries over, nothing is
        owed.
      </p>
    </section>

    <section class="settings-group" data-settings-group="content">
      <h2>Content</h2>
      ${seg(
        "nsfw",
        [
          ["hide", "Hide NSFW"],
          ["show", "Show all"],
        ],
        "hide",
      )}
      <p class="settings-help">
        Keeps NSFW-tagged items (and over-18 residual) out of the log. Your choice sticks.
      </p>
    </section>

    <section class="settings-group" data-settings-group="archive-media">
      <h2>Archived media</h2>
      ${seg(
        "archive",
        [
          ["off", "Off"],
          ["on", "Prefer local"],
        ],
        "off",
      )}
      <p class="settings-help">
        When on, images load from your locally-archived copies (the
        <code>archive-media</code> pass) instead of Reddit — survives deletion, works offline. Off
        by default.
      </p>
    </section>

    <section class="settings-group" data-settings-group="done-retention">
      <h2>Done retention</h2>
      ${seg("retention", retentionOptions(view.retention.days), String(view.retention.days))}
      <p class="settings-help" id="settings-retention-current">
        Current window: ${view.retention.days} days.
      </p>
      <div
        class="settings-card"
        id="settings-retention-preview"
        aria-live="polite"
        data-days="${view.retention.days}"
        data-total="${view.retention.total}"
        data-cutoff="${view.retention.cutoff}"
      >
        ${retentionText(view.retention.total, view.retention.cutoff)}
      </div>
      <label class="settings-check" for="settings-retention-confirm">
        <input type="checkbox" id="settings-retention-confirm" />
        <span>I understand this permanently deletes Done items older than the current window.</span>
      </label>
      <button type="button" class="settings-btn is-warn" id="settings-retention-purge" disabled>
        Purge eligible Done items
      </button>
      <p class="settings-help" id="settings-retention-feedback">
        The purge writes a timestamped DB backup and appends <code>delete-audit.jsonl</code>.
      </p>
    </section>

    <section class="settings-group" data-settings-group="reddit-unsave">
      <h2>Reddit unsave</h2>
      <div class="settings-group-head">
        <p class="settings-help" id="settings-unsave-state">
          ${
            view.unsave.username
              ? `Connected as u/${view.unsave.username}`
              : "No Reddit session saved yet"
          }
          · ${view.unsave.pending} queued · ${view.unsave.failed} failed
        </p>
        ${toggle("unsave", view.unsave.enabled)}
      </div>
      <p class="settings-help">
        When on, marking a Reddit save Done queues it for removal from your Reddit Saved list.
        Nothing leaves this machine until the drain runs.
      </p>
      <form class="settings-inline" id="settings-unsave-auth">
        <label class="settings-label" for="settings-unsave-cookie">Reddit session cookie</label>
        <input
          class="settings-input"
          id="settings-unsave-cookie"
          name="cookie"
          type="password"
          autocomplete="off"
          placeholder="reddit_session value"
        />
        <button class="settings-btn" type="submit">Save cookie</button>
      </form>
      <p class="settings-help" id="settings-unsave-feedback" role="status"></p>
    </section>

    <section class="settings-group" data-settings-group="collection">
      <h2>Library tools</h2>
      <div class="settings-links">
        <a class="settings-link" href="/library?panel=stats">Stats — the shape of the collection</a>
        <a class="settings-link" href="/library?panel=dupes">Duplicates — review matching saves</a>
      </div>
      <button type="button" class="settings-btn" id="settings-sync">Sync newest from Reddit</button>
      <p class="settings-help" id="settings-status" role="status"></p>
    </section>
    <script type="module" src="/static/home/settings.js"></script>
  </section>`;
}
