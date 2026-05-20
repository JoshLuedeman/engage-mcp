import { describe, it, expect } from "vitest";
import { ConfirmationManager } from "../../src/safety/confirmation.js";

const baseClaims = {
  tool: "engage_post_message",
  accountId: "user-1",
  targetId: "community-1",
  payloadHash: "h".repeat(64),
};

function fixed(): ConfirmationManager {
  return new ConfirmationManager({ hmacKey: Buffer.alloc(32, 0x11), ttlMs: 60_000 });
}

describe("ConfirmationManager", () => {
  it("issues a token that verifies when claims match", () => {
    const m = fixed();
    const { token } = m.issue(baseClaims);
    expect(() => m.verifyAndConsume(token, baseClaims)).not.toThrow();
  });

  it("token is single-use (nonce consumed)", () => {
    const m = fixed();
    const { token } = m.issue(baseClaims);
    m.verifyAndConsume(token, baseClaims);
    expect(() => m.verifyAndConsume(token, baseClaims)).toThrowError(
      /already been used/i,
    );
  });

  it("rejects token when tool differs", () => {
    const m = fixed();
    const { token } = m.issue(baseClaims);
    expect(() =>
      m.verifyAndConsume(token, { ...baseClaims, tool: "engage_reply_to_thread" }),
    ).toThrowError(/different tool/i);
  });

  it("rejects token when account differs", () => {
    const m = fixed();
    const { token } = m.issue(baseClaims);
    expect(() =>
      m.verifyAndConsume(token, { ...baseClaims, accountId: "someone-else" }),
    ).toThrowError(/different signed-in account/i);
  });

  it("rejects token when target differs", () => {
    const m = fixed();
    const { token } = m.issue(baseClaims);
    expect(() =>
      m.verifyAndConsume(token, { ...baseClaims, targetId: "community-2" }),
    ).toThrowError(/different target/i);
  });

  it("rejects token when payloadHash differs (tampered payload)", () => {
    const m = fixed();
    const { token } = m.issue(baseClaims);
    expect(() =>
      m.verifyAndConsume(token, { ...baseClaims, payloadHash: "0".repeat(64) }),
    ).toThrowError(/Payload has changed/i);
  });

  it("rejects expired tokens", () => {
    let t = 1000;
    const m = new ConfirmationManager({
      hmacKey: Buffer.alloc(32, 0x11),
      ttlMs: 100,
      now: () => t,
    });
    const { token } = m.issue(baseClaims);
    t += 1000;
    expect(() => m.verifyAndConsume(token, baseClaims)).toThrowError(/expired/i);
  });

  it("rejects tampered signature", () => {
    const m = fixed();
    const { token } = m.issue(baseClaims);
    const [head, sig] = token.split(".");
    const flipped = sig!.slice(0, -1) + (sig!.endsWith("A") ? "B" : "A");
    expect(() => m.verifyAndConsume(`${head}.${flipped}`, baseClaims)).toThrowError(
      /signature is invalid/i,
    );
  });

  it("rejects malformed token", () => {
    const m = fixed();
    expect(() => m.verifyAndConsume("not-a-token", baseClaims)).toThrowError(/Malformed/i);
  });

  it("rejects tokens signed with a different key", () => {
    const a = new ConfirmationManager({ hmacKey: Buffer.alloc(32, 0x11), ttlMs: 60_000 });
    const b = new ConfirmationManager({ hmacKey: Buffer.alloc(32, 0x22), ttlMs: 60_000 });
    const { token } = a.issue(baseClaims);
    expect(() => b.verifyAndConsume(token, baseClaims)).toThrowError(/signature/i);
  });
});
