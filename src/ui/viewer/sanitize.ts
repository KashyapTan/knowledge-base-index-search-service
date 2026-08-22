import { classifyLink, SAFE_EXTERNAL_LINK_PROPS } from "./link-policy.ts";

const REMOVED_ELEMENTS = new Set([
  "base",
  "button",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "img",
  "input",
  "link",
  "meta",
  "object",
  "portal",
  "script",
  "select",
  "source",
  "style",
  "textarea",
  "track",
  "video",
  "audio",
]);

const RESOURCE_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "longdesc",
  "manifest",
  "ping",
  "poster",
  "src",
  "srcdoc",
  "srcset",
  "usemap",
  "xlink:href",
]);

const UNSAFE_CSS_RESOURCE = /(?:@import|url\((?!\s*['"]?#))/iu;
const CYLINDER_PATH = /^M0,[\d.eE+-]+\s+a/iu;
const TRANSLATE = /^translate\(\s*[-\d.eE+]+\s*,\s*([\d.eE+-]+)\s*\)$/iu;

function centerMultilineCylinderLabels(document: Document): void {
  for (const node of document.querySelectorAll("g.node")) {
    const shape = [...node.children].find(
      (child) =>
        child.tagName.toLocaleLowerCase() === "path" &&
        child.classList.contains("label-container") &&
        CYLINDER_PATH.test(child.getAttribute("d") ?? ""),
    );
    if (!shape) continue;
    const label = [...node.children].find(
      (child) => child.tagName.toLocaleLowerCase() === "g" && child.classList.contains("label"),
    );
    if (!label || label.querySelectorAll("tspan.text-outer-tspan").length < 2) continue;
    const translatedY = TRANSLATE.exec(label.getAttribute("transform") ?? "")?.[1];
    if (!translatedY) continue;
    label.setAttribute("transform", `translate(0, ${translatedY})`);
    for (const text of label.querySelectorAll("text")) text.setAttribute("text-anchor", "middle");
  }
}

function sanitizeElement(element: Element): void {
  const tag = element.tagName.toLocaleLowerCase();
  if (REMOVED_ELEMENTS.has(tag)) {
    element.remove();
    return;
  }
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLocaleLowerCase();
    if (name.startsWith("on") || name === "style" || RESOURCE_ATTRIBUTES.has(name)) {
      element.removeAttribute(attribute.name);
    }
  }
  if (tag === "a") {
    const link = classifyLink(element.getAttribute("href") ?? undefined);
    for (const name of ["href", "target", "rel", "referrerpolicy", "download"]) {
      element.removeAttribute(name);
    }
    if (link.kind === "external") {
      element.setAttribute("href", link.href);
      element.setAttribute("target", SAFE_EXTERNAL_LINK_PROPS.target);
      element.setAttribute("rel", SAFE_EXTERNAL_LINK_PROPS.rel);
      element.setAttribute("referrerpolicy", SAFE_EXTERNAL_LINK_PROPS.referrerPolicy);
    } else if (link.kind === "fragment") {
      element.setAttribute("href", link.href);
    } else {
      element.setAttribute("aria-disabled", "true");
    }
  }
}

export function sanitizeHtmlFragment(content: string): string {
  const parsed = new DOMParser().parseFromString(content, "text/html");
  for (const element of [...parsed.querySelectorAll("*")]) sanitizeElement(element);
  return parsed.body.innerHTML;
}

export interface SafePreviewLink {
  readonly href: string;
  readonly label: string;
}

export function safeExternalPreviewLinks(content: string): readonly SafePreviewLink[] {
  const parsed = new DOMParser().parseFromString(content, "text/html");
  const links = new Map<string, SafePreviewLink>();
  for (const anchor of parsed.querySelectorAll("a[href]")) {
    const link = classifyLink(anchor.getAttribute("href") ?? undefined);
    if (link.kind !== "external" || links.has(link.href)) continue;
    const text = anchor.textContent?.replace(/\s+/gu, " ").trim().slice(0, 200);
    links.set(link.href, { href: link.href, label: text || link.href });
  }
  return [...links.values()];
}

const PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
].join("; ");

export function htmlPreviewDocument(content: string): string {
  const safe = sanitizeHtmlFragment(content);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light;background:#fff}body{max-width:76ch;margin:0 auto;padding:1.5rem;color:#17211b;font:16px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}pre,code{font-family:ui-monospace,monospace}pre{overflow:auto;padding:1rem;background:#f4f6f2}a{color:#175f46}img,video,audio{display:none!important}</style></head><body>${safe}</body></html>`;
}

export function sanitizeDiagramSvg(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.tagName !== "svg") return "";
  for (const element of [...parsed.querySelectorAll("script,foreignObject,iframe,object,embed")]) {
    element.remove();
  }
  for (const element of [...parsed.querySelectorAll("*")]) {
    if (
      element.tagName.toLocaleLowerCase() === "style" &&
      UNSAFE_CSS_RESOURCE.test(element.textContent ?? "")
    ) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLocaleLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        (name === "style" && UNSAFE_CSS_RESOURCE.test(value)) ||
        ((name === "href" || name === "xlink:href") && !value.startsWith("#"))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  // Mermaid 11 offsets multiline plain-SVG labels to the left for legacy cylinder nodes even
  // though the cylinder itself was sized around the centered text. Correct that renderer defect
  // after sanitization without enabling foreignObject/HTML labels.
  centerMultilineCylinderLabels(parsed);
  return new XMLSerializer().serializeToString(parsed.documentElement);
}
