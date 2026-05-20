/**
 * Input invariants applied during preview.
 *
 * Reject obviously-malformed write payloads BEFORE we resolve targets
 * or issue a confirmation token. These checks intentionally do NOT
 * try to model Yammer's server-side validation completely — they
 * catch the cheap, common mistakes (empty body, control characters,
 * absurd length) so the assistant gets fast, actionable feedback.
 */
import { EngageValidationError } from "../utils/errors.js";

export const WRITE_LIMITS = {
  bodyMin: 1,
  bodyMax: 10_000,
  titleMax: 255,
  reasonMin: 8,
  reasonMax: 500,
} as const;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function assertNoControlChars(value: string, field: string): void {
  if (CONTROL_CHAR.test(value)) {
    throw new EngageValidationError(
      `${field} contains control characters that are not allowed.`,
      { details: { field } },
    );
  }
}

export function validateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length < WRITE_LIMITS.bodyMin) {
    throw new EngageValidationError("body must be a non-empty string.", {
      details: { field: "body" },
    });
  }
  if (body.length > WRITE_LIMITS.bodyMax) {
    throw new EngageValidationError(
      `body exceeds the maximum allowed length of ${WRITE_LIMITS.bodyMax} characters.`,
      { details: { field: "body", length: body.length, max: WRITE_LIMITS.bodyMax } },
    );
  }
  assertNoControlChars(body, "body");
  return body;
}

export function validateTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  if (title.length > WRITE_LIMITS.titleMax) {
    throw new EngageValidationError(
      `title exceeds the maximum allowed length of ${WRITE_LIMITS.titleMax} characters.`,
      { details: { field: "title", length: title.length, max: WRITE_LIMITS.titleMax } },
    );
  }
  assertNoControlChars(title, "title");
  return title;
}

export function validateReason(reason: string): string {
  if (reason.length < WRITE_LIMITS.reasonMin) {
    throw new EngageValidationError(
      `reason must be at least ${WRITE_LIMITS.reasonMin} characters.`,
      { details: { field: "reason", min: WRITE_LIMITS.reasonMin } },
    );
  }
  if (reason.length > WRITE_LIMITS.reasonMax) {
    throw new EngageValidationError(
      `reason exceeds the maximum allowed length of ${WRITE_LIMITS.reasonMax} characters.`,
      { details: { field: "reason", max: WRITE_LIMITS.reasonMax } },
    );
  }
  assertNoControlChars(reason, "reason");
  return reason;
}
