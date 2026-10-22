import { invariant, errorText } from "../../../core/util.js";
import { compileSchema } from "../../../runtime/json-schema.js";
import { headerBindings, type HeaderBinding } from "../headers.js";
import {
  wireObject,
  type WireObject,
  type MCPToolDeclaration,
  type MCPToolResult,
} from "../protocol.js";

function isToolDeclaration(value: unknown): value is MCPToolDeclaration {
  const tool = wireObject(value);
  if (
    !tool ||
    typeof tool.name !== "string" ||
    (tool.description !== undefined && typeof tool.description !== "string") ||
    !wireObject(tool.inputSchema) ||
    (tool.outputSchema !== undefined && !wireObject(tool.outputSchema))
  )
    return false;
  if (tool.execution === undefined) return true;
  const execution = wireObject(tool.execution);
  return Boolean(
    execution &&
    (execution.taskSupport === undefined ||
      ["forbidden", "optional", "required"].some(
        (support) => support === execution.taskSupport,
      )),
  );
}

/** Validated tool schemas and HTTP parameter bindings come from the same catalog. */
export class MCPToolCatalog {
  private toolHeaders = new Map<string, HeaderBinding[]>();
  private toolSchemas = new Map<
    string,
    {
      input: ReturnType<typeof compileSchema>;
      output?: ReturnType<typeof compileSchema>;
    }
  >();
  constructor(private record: (method: string, params: unknown) => void) {}
  headers(name: string): HeaderBinding[] | undefined {
    return this.toolHeaders.get(name);
  }
  accept(
    r: WireObject,
    bindHeaders: boolean,
  ): WireObject & { tools: MCPToolDeclaration[] } {
    const declared = r.tools;
    invariant(
      Array.isArray(declared) && declared.every(isToolDeclaration),
      "Invalid MCP tool list",
      502,
    );
    const tools = declared.filter((tool) => {
      try {
        if (!tool.inputSchema.$schema)
          tool.inputSchema = {
            ...tool.inputSchema,
            $schema: "https://json-schema.org/draft/2020-12/schema",
          };
        const input = compileSchema(tool.inputSchema),
          output = tool.outputSchema
            ? compileSchema({
                ...tool.outputSchema,
                $schema:
                  tool.outputSchema.$schema ||
                  "https://json-schema.org/draft/2020-12/schema",
              })
            : undefined;
        this.toolSchemas.set(tool.name, { input, output });
        if (bindHeaders)
          this.toolHeaders.set(tool.name, headerBindings(tool.inputSchema));
        return true;
      } catch (error) {
        this.record("tools/rejected", {
          name: tool.name,
          reason: errorText(error),
        });
        return false;
      }
    });
    return { ...r, tools };
  }
  validateInput(name: string, value: unknown): void {
    const schema = this.toolSchemas.get(name);
    if (schema)
      invariant(
        schema.input(value),
        "MCP tool input violates its catalog schema",
      );
  }
  validateResult(name: string, value: unknown): MCPToolResult {
    const schema = this.toolSchemas.get(name),
      r = wireObject(value);
    invariant(
      r && (Array.isArray(r.content) || r.structuredContent !== undefined),
      "Invalid MCP tool result",
      502,
    );
    if (!r.isError && schema?.output)
      invariant(
        r.structuredContent !== undefined && schema.output(r.structuredContent),
        "MCP tool structured output violates its catalog schema",
        502,
      );
    return {
      ...r,
      content: Array.isArray(r.content)
        ? r.content
        : [{ type: "text", text: JSON.stringify(r.structuredContent) }],
    };
  }
}
