/**
 * HTML → plain-text fallback for Yammer message bodies.
 *
 * Use only when `body.plain` and `body.parsed` are unavailable on a
 * response. Strategy: sanitize-html with an empty allowlist (drops
 * everything) and a custom text walker that:
 *   - keeps text nodes
 *   - converts block tags and `<br>` to single newlines
 *   - converts paragraph boundaries to double newlines
 *   - preserves `@mention` text where Yammer wraps mentions
 *
 * NEVER feed user-controlled HTML to anything else without an
 * allowlist; this function returns *text*, not HTML.
 */
import sanitizeHtml from "sanitize-html";

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "header",
  "footer",
]);

const PARA_TAGS = new Set(["p", "div", "blockquote"]);

/**
 * Convert a Yammer-style HTML body to plain text.
 *
 * - `null`/`undefined`/empty input → `""`.
 * - Collapses internal whitespace but preserves block/paragraph breaks.
 * - Result is `.trim()`ed.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (html === null || html === undefined) return "";
  const input = String(html);
  if (input.length === 0) return "";

  // Transform tags into text-friendly tokens before sanitization, then
  // strip all remaining HTML.
  const tokens: string[] = [];
  sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (text) => {
      tokens.push(text);
      return "";
    },
    nonTextTags: ["script", "style", "noscript"],
    parser: {
      lowerCaseTags: true,
    },
    transformTags: {
      "*": (tagName) => {
        const lower = tagName.toLowerCase();
        if (lower === "br") tokens.push("\n");
        else if (lower === "li") tokens.push("\n- ");
        else if (PARA_TAGS.has(lower)) tokens.push("\n\n");
        else if (BLOCK_TAGS.has(lower)) tokens.push("\n");
        return { tagName: lower, attribs: {} };
      },
    },
  });

  const joined = tokens
    .join("")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return joined;
}
