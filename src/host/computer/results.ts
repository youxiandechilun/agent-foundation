import { z } from "zod";
import type { Asset } from "../../contracts.js";

const windowSchema = z.object({
  windowId: z.string(),
  processId: z.number().int(),
  title: z.string(),
  left: z.number(),
  top: z.number(),
  width: z.number(),
  height: z.number(),
  foreground: z.boolean(),
});
const elementSchema = z.object({
  elementId: z.string(),
  automationId: z.string(),
  name: z.string(),
  controlType: z.string(),
  enabled: z.boolean(),
  offscreen: z.boolean(),
  password: z.boolean(),
  value: z.string().nullable(),
  patterns: z.array(z.string()),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
});
/** Payload produced by the bundled Windows computer adapter. */
export const computerResultSchema = z.object({
  ok: z.literal(true),
  action: z.string(),
  width: z.number(),
  height: z.number(),
  left: z.number(),
  top: z.number(),
  cursor: z.object({ x: z.number(), y: z.number() }),
  foregroundTitle: z.string(),
  window: windowSchema.optional(),
  windows: z.array(windowSchema).optional(),
  elements: z.array(elementSchema).optional(),
  bounded: z.boolean().optional(),
});
export type ComputerResult = z.infer<typeof computerResultSchema>;
export type ComputerActionResult = ComputerResult & { asset?: Asset };
