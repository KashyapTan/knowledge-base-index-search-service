import { SAFE_EXTERNAL_LINK_PROPS } from "./link-policy.ts";
import { htmlPreviewDocument, safeExternalPreviewLinks } from "./sanitize.ts";

export function HtmlPreview({ content }: { readonly content: string }) {
  const links = safeExternalPreviewLinks(content);
  return (
    <div className="html-preview-shell">
      {links.length > 0 ? (
        <aside className="html-preview-links" aria-label="Safe external links in HTML preview">
          <span>External links:</span>
          {links.map((link) => (
            <a key={link.href} href={link.href} {...SAFE_EXTERNAL_LINK_PROPS}>
              {link.label}
            </a>
          ))}
        </aside>
      ) : null}
      <iframe
        className="html-preview"
        title="Sandboxed HTML preview"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={htmlPreviewDocument(content)}
      />
    </div>
  );
}
