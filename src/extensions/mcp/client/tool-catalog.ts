import { invariant, errorText } from "../../../core/util.js";
import { compileSchema } from "../../../runtime/json-schema.js";
import { headerBindings, type HeaderBinding } from "../headers.js";
import {
  wireObject,
  type WireObject,
  type MCPToolDeclaration,
  type MCPToolResult,
} from "../protocol.js";

interface MCPToolMetadata {
  input: ReturnType<typeof compileSchema>;
  output?: ReturnType<typeof compileSchema>;
  headers: HeaderBinding[];
}
export type MCPToolOutputValidator = ReturnType<typeof compileSchema> | null;

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
  private metadata = new Map<string, MCPToolMetadata>();
  constructor(private record: (method: string, params: unknown) => void) {}
  headers(name: string): HeaderBinding[] | undefined {
    return this.metadata.get(name)?.headers;
  }
  accept(r: WireObject, bindHeaders: boolean) {
    const { page, metadata } = this.prepare(r, bindHeaders);
    this.append(metadata);
    return page;
  }
  prepare(r: WireObject, bindHeaders: boolean) {
    const declared = r.tools;
    invariant(
      Array.isArray(declared) && declared.every(isToolDeclaration),
      "Invalid MCP tool list",
      502,
    );
    invariant(
      r.nextCursor === undefined || typeof r.nextCursor === "string",
      "Invalid MCP tool pagination cursor",
      502,
    );
    const metadata = new Map<string, MCPToolMetadata>();
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
        const headers = bindHeaders ? headerBindings(tool.inputSchema) : [];
        metadata.set(tool.name, { input, output, headers });
        return true;
      } catch (error) {
        this.record("tools/rejected", {
          name: tool.name,
          reason: errorText(error),
        });
        return false;
      }
    });
    return { page: { ...r, tools, nextCursor: r.nextCursor }, metadata };
  }
  replace(metadata: Map<string, MCPToolMetadata>): void {
    this.metadata = metadata;
  }
  append(metadata: Map<string, MCPToolMetadata>): void {
    for (const [name, entry] of metadata) this.metadata.set(name, entry);
  }
  clear(): void {
    this.metadata.clear();
  }
  outputValidator(name: string): MCPToolOutputValidator {
    return this.metadata.get(name)?.output ?? null;
  }
  validateInput(name: string, value: unknown): void {
    const schema = this.metadata.get(name);
    if (schema)
      invariant(
        schema.input(value),
        "MCP tool input violates its catalog schema",
      );
  }
  validateResult(
    name: string,
    value: unknown,
    output: MCPToolOutputValidator = this.outputValidator(name),
  ): MCPToolResult {
    const r = wireObject(value);
    invariant(
      r && (Array.isArray(r.content) || r.structuredContent !== undefined),
      "Invalid MCP tool result",
      502,
    );
    if (!r.isError && output)
      invariant(
        r.structuredContent !== undefined && output(r.structuredContent),
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
