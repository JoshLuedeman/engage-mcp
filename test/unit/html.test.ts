import { describe, it, expect } from "vitest";
import { htmlToPlainText } from "../../src/utils/html.js";

describe("htmlToPlainText", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(htmlToPlainText(null)).toBe("");
    expect(htmlToPlainText(undefined)).toBe("");
    expect(htmlToPlainText("")).toBe("");
  });

  it("strips tags but preserves text content", () => {
    expect(htmlToPlainText("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("converts paragraphs to double newlines", () => {
    const out = htmlToPlainText("<p>First.</p><p>Second.</p>");
    expect(out).toBe("First.\n\nSecond.");
  });

  it("converts <br> to single newline", () => {
    expect(htmlToPlainText("Line 1<br>Line 2<br>Line 3")).toBe("Line 1\nLine 2\nLine 3");
  });

  it("removes script and style content entirely", () => {
    const out = htmlToPlainText("<p>visible</p><script>alert(1)</script><style>.x{}</style>");
    expect(out).toBe("visible");
  });

  it("collapses runs of whitespace", () => {
    expect(htmlToPlainText("<p>a    b\t\tc</p>")).toBe("a b c");
  });

  it("handles list items as bulleted lines", () => {
    const out = htmlToPlainText("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("- one");
    expect(out).toContain("- two");
  });

  it("preserves @mention plain text", () => {
    const out = htmlToPlainText(
      '<p>Hi <span class="mention" data-user-id="42">@Joel</span>, thanks.</p>',
    );
    expect(out).toBe("Hi @Joel, thanks.");
  });

  it("does not blow up on malformed HTML", () => {
    expect(() => htmlToPlainText("<p>unclosed")).not.toThrow();
    expect(() => htmlToPlainText("<<<>>>")).not.toThrow();
  });
});
