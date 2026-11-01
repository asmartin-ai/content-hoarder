/**
 * Server-side HTML templating: an `html` tagged template that escapes every
 * interpolation unless it is already trusted `SafeHtml`.
 */

/** A string of trusted, already-escaped HTML. */
export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
} as const;

/** Escape text for an HTML text node or a quoted attribute value. */
export function escapeHtml(text: string): string {
  // SAFETY: ESCAPES is a finite known map; ch comes from the regex match
  return text.replace(/[&<>"']/g, (ch) =>
    Object.hasOwn(ESCAPES, ch) ? ESCAPES[ch as keyof typeof ESCAPES] : ch,
  );
}

export type HtmlValue =
  | SafeHtml
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly HtmlValue[];
// Template values are the one place HtmlValue is accepted: anything that is not
// SafeHtml (or an array of values) is stringified and escaped.

function renderValue(value: HtmlValue): string {
  // Conditional parts (`${cond && html`…`}`) render nothing when absent.
  if (value === null || value === undefined || value === false) return "";

  if (value instanceof SafeHtml) return value.value;

  if (Array.isArray(value)) return value.map(renderValue).join("");

  return escapeHtml(String(value));
}

/** Tagged template: literal parts pass through, interpolations are escaped. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? "";

  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + (strings[i + 1] ?? "");
  }

  return new SafeHtml(out);
}

/** Mark a string as trusted HTML. Only for output of escaping renderers. */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

/** Concatenate trusted fragments with an optional (trusted) separator. */
export function joinHtml(parts: SafeHtml[], sep = ""): SafeHtml {
  return new SafeHtml(parts.map((part) => part.value).join(sep));
}
