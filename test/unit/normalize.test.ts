import { describe, it, expect } from "vitest";
import {
  indexReferences,
  normalizeCommunity,
  normalizeMessage,
  normalizeMessageList,
  normalizeNetwork,
  normalizeThread,
} from "../../src/clients/normalize.js";
import { emptyReferenceIndex } from "../../src/models/index.js";

describe("indexReferences", () => {
  it("indexes user, group, and thread references", () => {
    const idx = indexReferences([
      { id: 1, type: "user", full_name: "Joel" },
      { id: 2, type: "group", name: "Team", full_name: "Team Full", web_url: "https://example/" },
      { id: 3, type: "thread", web_url: "https://example/t/3" },
    ]);
    expect(idx.users.get("1")?.name).toBe("Joel");
    expect(idx.groups.get("2")?.fullName).toBe("Team Full");
    expect(idx.threads.get("3")?.webUrl).toBe("https://example/t/3");
  });

  it("ignores unknown reference types without throwing", () => {
    const idx = indexReferences([
      { id: 1, type: "frob", name: "x" },
      { id: 2, type: "user", full_name: "Y" },
    ]);
    expect(idx.users.size).toBe(1);
    expect(idx.groups.size).toBe(0);
  });

  it("handles missing/null references arrays", () => {
    expect(indexReferences(undefined).users.size).toBe(0);
    expect(indexReferences([]).users.size).toBe(0);
  });
});

describe("normalizeMessage body source preference", () => {
  it("prefers body.plain over body.parsed and body.rich", () => {
    const msg = normalizeMessage(
      {
        id: 10,
        created_at: "2026-01-01T00:00:00Z",
        body: { plain: "plain text", parsed: "parsed text", rich: "<p>rich</p>" },
      },
      emptyReferenceIndex(),
    );
    expect(msg.bodyPlain).toBe("plain text");
    expect(msg.bodyHtml).toBe("<p>rich</p>");
    expect(msg.bodyDerivedFromHtml).toBeUndefined();
  });

  it("falls back to body.parsed when plain is missing", () => {
    const msg = normalizeMessage(
      {
        id: 10,
        created_at: "2026-01-01T00:00:00Z",
        body: { parsed: "parsed text", rich: "<p>rich</p>" },
      },
      emptyReferenceIndex(),
    );
    expect(msg.bodyPlain).toBe("parsed text");
  });

  it("falls back to HTML strip when neither plain nor parsed available", () => {
    const msg = normalizeMessage(
      {
        id: 10,
        created_at: "2026-01-01T00:00:00Z",
        body: { rich: "<p>only rich</p>" },
      },
      emptyReferenceIndex(),
    );
    expect(msg.bodyPlain).toBe("only rich");
    expect(msg.bodyDerivedFromHtml).toBe(true);
  });

  it("yields empty body when body is null/undefined/empty", () => {
    expect(normalizeMessage({ id: 1, created_at: "x" }, emptyReferenceIndex()).bodyPlain).toBe(
      "",
    );
    expect(
      normalizeMessage({ id: 1, created_at: "x", body: null }, emptyReferenceIndex()).bodyPlain,
    ).toBe("");
    expect(
      normalizeMessage(
        { id: 1, created_at: "x", body: { plain: "", parsed: "", rich: "" } },
        emptyReferenceIndex(),
      ).bodyPlain,
    ).toBe("");
  });

  it("accepts string body for legacy responses", () => {
    expect(
      normalizeMessage({ id: 1, created_at: "x", body: "raw text" }, emptyReferenceIndex())
        .bodyPlain,
    ).toBe("raw text");
  });
});

describe("normalizeMessage reference enrichment", () => {
  it("enriches sender and community names when present", () => {
    const refs = indexReferences([
      { id: 1, type: "user", full_name: "Joel" },
      { id: 99, type: "group", name: "TeamX" },
    ]);
    const msg = normalizeMessage(
      { id: 10, sender_id: 1, group_id: 99, created_at: "x", body: { plain: "hi" } },
      refs,
    );
    expect(msg.senderName).toBe("Joel");
    expect(msg.communityName).toBe("TeamX");
  });

  it("preserves raw ids even when references are missing", () => {
    const msg = normalizeMessage(
      { id: 10, sender_id: 7, group_id: 8, created_at: "x" },
      emptyReferenceIndex(),
    );
    expect(msg.senderId).toBe("7");
    expect(msg.communityId).toBe("8");
    expect(msg.senderName).toBeUndefined();
    expect(msg.communityName).toBeUndefined();
  });

  it("handles deleted user (no reference entry) without crashing", () => {
    const msg = normalizeMessage(
      { id: 10, sender_id: 404, created_at: "x", body: { plain: "ghost" } },
      emptyReferenceIndex(),
    );
    expect(msg.senderId).toBe("404");
    expect(msg.senderName).toBeUndefined();
  });
});

describe("normalizeMessageList", () => {
  it("returns empty result for non-object input", () => {
    expect(normalizeMessageList(null).messages).toEqual([]);
    expect(normalizeMessageList(undefined).messages).toEqual([]);
    expect(normalizeMessageList(42).messages).toEqual([]);
  });

  it("normalizes a list with references", () => {
    const payload = {
      messages: [
        { id: 1, sender_id: 100, created_at: "2026-01-01", body: { plain: "first" } },
        { id: 2, sender_id: 100, created_at: "2026-01-02", body: { plain: "second" } },
      ],
      references: [{ id: 100, type: "user", full_name: "Joel" }],
    };
    const { messages } = normalizeMessageList(payload);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.senderName).toBe("Joel");
    expect(messages[1]?.bodyPlain).toBe("second");
  });

  it("attaches replyCount from threaded_extended", () => {
    const payload = {
      messages: [{ id: 1, thread_id: 1, created_at: "2026-01-01", body: { plain: "a" } }],
      threaded_extended: { "1": [{ id: 2 }, { id: 3 }] },
    };
    const { messages } = normalizeMessageList(payload);
    expect(messages[0]?.replyCount).toBe(2);
  });
});

describe("normalizeThread", () => {
  it("identifies the starter and orders replies by createdAt", () => {
    const payload = {
      messages: [
        { id: 2, thread_id: 1, created_at: "2026-01-02", body: { plain: "reply" } },
        { id: 1, thread_id: 1, created_at: "2026-01-01", body: { plain: "starter" } },
      ],
    };
    const t = normalizeThread(payload, "1");
    expect(t.starter?.id).toBe("1");
    expect(t.replies).toHaveLength(1);
    expect(t.replies[0]?.id).toBe("2");
  });

  it("populates participants without duplicates", () => {
    const payload = {
      messages: [
        { id: 1, thread_id: 1, sender_id: 10, created_at: "2026-01-01", body: { plain: "" } },
        { id: 2, thread_id: 1, sender_id: 11, created_at: "2026-01-02", body: { plain: "" } },
        { id: 3, thread_id: 1, sender_id: 10, created_at: "2026-01-03", body: { plain: "" } },
      ],
    };
    const t = normalizeThread(payload, "1");
    expect(t.participants?.length).toBe(2);
  });
});

describe("normalizeCommunity / normalizeNetwork", () => {
  it("normalizes basic community fields and infers privacy", () => {
    const c = normalizeCommunity({
      id: 5,
      name: "BC Devs",
      full_name: "BC Developers",
      description: "...",
      privacy: "private",
      web_url: "https://example/",
      stats: { members: 42 },
      state: "active",
    });
    expect(c.id).toBe("5");
    expect(c.privacy).toBe("private");
    expect(c.memberCount).toBe(42);
    expect(c.archived).toBe(false);
  });

  it("returns unknown privacy for unrecognized values", () => {
    expect(normalizeCommunity({ id: 1, name: "x", privacy: "secret" }).privacy).toBe("unknown");
    expect(normalizeCommunity({ id: 1, name: "x" }).privacy).toBe("unknown");
  });

  it("normalizes a network", () => {
    const n = normalizeNetwork({ id: 9, name: "Contoso", permalink: "contoso", is_primary: true });
    expect(n.id).toBe("9");
    expect(n.name).toBe("Contoso");
    expect(n.isHome).toBe(true);
  });
});
