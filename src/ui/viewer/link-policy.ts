export type SafeLink =
  | { readonly kind: "fragment"; readonly href: string }
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "blocked" };

/** Browser-facing URL policy. Relative repository links cannot cross the opaque file-ID boundary. */
export function classifyLink(href: string | undefined): SafeLink {
  if (!href) return { kind: "blocked" };
  const value = href.trim();
  if (/^#[^\s]*$/u.test(value)) return { kind: "fragment", href: value };
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? { kind: "external", href: parsed.href }
      : { kind: "blocked" };
  } catch {
    return { kind: "blocked" };
  }
}

export const SAFE_EXTERNAL_LINK_PROPS = {
  target: "_blank",
  rel: "noopener noreferrer",
  referrerPolicy: "no-referrer",
} as const;
