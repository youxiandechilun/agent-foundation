import assert from "node:assert/strict";
import { z } from "zod";

export function firstText(value: unknown): string {
  const result = z
    .object({ content: z.array(z.unknown()).min(1) })
    .parse(value);
  return z
    .object({ type: z.literal("text"), text: z.string() })
    .parse(result.content[0]).text;
}
export function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
export const keyDocument = (value: unknown) =>
  z
    .object({
      jwks: z.object({
        keys: z.array(z.object({ kid: z.string() }).passthrough()),
      }),
    })
    .passthrough()
    .parse(value);
