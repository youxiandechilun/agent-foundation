import { compileSchema } from "./json-schema.js";
import { invariant } from "../core/util.js";
import type { ToolDefinition } from "./types.js";

/** Name of the run-scoped tool through which a model submits a structured final result. */
export const OUTPUT_TOOL = "submit_result";
const SOURCE = { kind: "builtin" as const, id: "structured-output" };

/**
 * The output tool has no side effect beyond recording the run result, so mode, agent and
 * route tool allowlists do not apply to it (otherwise a narrow allowlist makes the run unfinishable).
 */
export const isOutputTool = (tool: Pick<ToolDefinition, "name" | "source">) =>
  tool.name === OUTPUT_TOOL &&
  tool.source?.kind === SOURCE.kind &&
  tool.source.id === SOURCE.id;

/** Tool parameters must be an object; other schemas are wrapped as { result } with $defs hoisted. */
export function outputParameters(schema: Record<string, any>) {
  invariant(
    schema && typeof schema === "object" && !Array.isArray(schema),
    "outputSchema must be a JSON Schema object",
    400,
  );
  compileSchema(schema);
  if (schema.type === "object") return { parameters: schema, wrapped: false };
  const { $defs, definitions, $schema: _ignored, ...inner } = schema;
  const parameters = {
    type: "object",
    properties: { result: inner },
    required: ["result"],
    additionalProperties: false,
    ...($defs ? { $defs } : {}),
    ...(definitions ? { definitions } : {}),
  };
  compileSchema(parameters);
  return { parameters, wrapped: true };
}

export function structuredOutputTool(
  schema: Record<string, any>,
  record: (output: unknown) => void,
): ToolDefinition {
  const { parameters, wrapped } = outputParameters(schema);
  return {
    name: OUTPUT_TOOL,
    description:
      "Submit the final structured result of this task. Call exactly once when the work is done; the arguments must match the schema. Calling it ends the run.",
    parameters,
    risk: "read",
    capabilities: [],
    source: SOURCE,
    execute: async (_callId, args: Record<string, unknown>) => {
      const output = wrapped ? args.result : args;
      record(output);
      return {
        content: [{ type: "text", text: "Structured result recorded." }],
        details: { output },
      };
    },
  };
}
