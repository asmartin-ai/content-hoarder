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

export function escapeHtml(text: string): string {
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

function renderValue(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return "";

  if (value instanceof SafeHtml) return value.value;

  if (Array.isArray(value)) return value.map(renderValue).join("");

  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? "";

  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + (strings[i + 1] ?? "");
  }

  return new SafeHtml(out);
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

export function joinHtml(parts: SafeHtml[], sep = ""): SafeHtml {
  return new SafeHtml(parts.map((part) => part.value).join(sep));
}
