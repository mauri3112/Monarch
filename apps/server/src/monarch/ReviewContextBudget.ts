import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const REVIEW_CONTEXT_MAX_BYTES = 64 * 1_024;

const CONTENT_KEYS = new Set([
  "text",
  "body",
  "content",
  "description",
  "brief",
  "instructions",
  "prompt",
  "title",
  "indicators",
  "constraints",
]);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function trimContent(value: unknown, limit: number, key?: string): unknown {
  if (typeof value === "string") {
    return key !== undefined && CONTENT_KEYS.has(key) ? value.slice(0, limit) : value;
  }
  if (Array.isArray(value)) return value.map((item) => trimContent(item, limit, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        trimContent(child, limit, childKey),
      ]),
    );
  }
  return value;
}

/** Keep provenance and array structure intact while bounding provider input. */
export const encodeReviewContext = Effect.fn("ReviewContextBudget.encodeReviewContext")(function* (
  input: unknown,
) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return yield* new TextGenerationError({
      operation: "encodeReviewContext",
      detail: "Project evidence must be a JSON object.",
    });
  }
  for (const limit of [Number.POSITIVE_INFINITY, 2_000, 1_000, 500, 250]) {
    const encoded = yield* encodeJson({
      ...(trimContent(input, limit) as Record<string, unknown>),
      inputTruncated:
        limit !== Number.POSITIVE_INFINITY ||
        (input !== null &&
          typeof input === "object" &&
          "inputTruncated" in input &&
          input.inputTruncated === true),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "encodeReviewContext",
            detail: "Could not serialize project evidence.",
            cause,
          }),
      ),
    );
    if (Buffer.byteLength(encoded, "utf8") <= REVIEW_CONTEXT_MAX_BYTES) return encoded;
  }
  return yield* new TextGenerationError({
    operation: "encodeReviewContext",
    detail: "Project evidence exceeds the 64 KiB provider input limit after content trimming.",
  });
});
