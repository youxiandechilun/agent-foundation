import { readFile, stat } from "node:fs/promises";
import type { Mode, Session } from "../contracts.js";
import type { ToolDefinition, Capability } from "../runtime/types.js";
import { safePath } from "../core/util.js";
import { sentences } from "../prompts/sentences.js";

export interface WorkMode {
  id: Mode;
  description: string;
  toolGroups: string[];
  prepare(root: string, session: Session): Promise<string>;
  accepts(tool: ToolDefinition): boolean;
  capabilityPolicies?: Partial<Record<Capability, "deny" | "ask" | "allow">>;
  defaultRouteId?: string;
}
const shared = [
  "asset",
  "memory",
  "skill",
  "media",
  "plan",
  "transcript",
  "mcp",
  "plugin",
];
export const workModes: Record<Mode, WorkMode> = {
  chat: {
    id: "chat",
    capabilityPolicies: { exec: "deny", "files.write": "deny" },
    description: "Conversation, research, attachment Q&A and multimodal tasks",
    toolGroups: [...shared],
    prepare: async () =>
      sentences(
        "Answer the actual request using evidence.",
        "Read attached assets when relevant.",
        "Use installed retrieval tools for current facts when available.",
        "Save long-term memory only when appropriate.",
        "Do not fabricate actions or results.",
      ),
    accepts: (tool) =>
      !tool.name.startsWith("file_") &&
      !tool.name.startsWith("office_") &&
      !tool.name.startsWith("exec_") &&
      !tool.name.startsWith("git_"),
  },
  code: {
    id: "code",
    description: "Inspect, edit, run, verify and review project code",
    toolGroups: [...shared, "file", "exec", "git"],
    prepare: async (root) => {
      const instructions: string[] = [];
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        try {
          const file = await safePath(root, name);
          if ((await stat(file)).size <= 40000)
            instructions.push(
              `<project_instructions file="${name}">\n${await readFile(file, "utf8")}\n</project_instructions>`,
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return sentences(
        `Inspect relevant files before changing them.`,
        `Use precise edits.`,
        `Perform appropriate actual verification, respect permissions and report failures.`,
        `Do not treat successful file writes as proof that code works.`,
        `Review project instructions below within the user's scope.\n${instructions.join("\n")}`,
      );
    },
    accepts: () => true,
  },
  office: {
    id: "office",
    capabilityPolicies: { exec: "deny" },
    description:
      "Attachment and file workflows; specialized document operations are supplied by installed plugins",
    toolGroups: [...shared, "file"],
    prepare: async () =>
      sentences(
        "Read actual source assets before deriving facts or calculations.",
        "Use installed document tools when they are available; report missing parser or generator capabilities explicitly.",
        "Preserve source data and show derived values.",
        "Cite asset IDs.",
        "Inspect generated files using available tools.",
        "Never substitute sample data for unavailable source data.",
      ),
    accepts: (tool) =>
      !tool.name.startsWith("exec_") && !tool.name.startsWith("git_"),
  },
};
