import { z } from "zod";
import type { Config } from "../config.js";
import type { Input, Session } from "../../contracts.js";
import type { Assets } from "../../storage/assets.js";
import type { SkillManager } from "../../extensions/skills.js";
import type { ImagePart, TextPart, UserMessage } from "../../runtime/types.js";
import { textOf } from "../../runtime/types.js";
import { invariant, redactJson } from "../util.js";

export const inputSchema = z
  .object({
    contextSessionIds: z.array(z.string().min(1)).max(20).default([]),
    teamRoleDecision: z.enum(["redistribute", "add_agents"]).optional(),
    text: z.string().max(100_000).optional(),
    assetIds: z.array(z.string()).max(20).default([]),
    delivery: z.enum(["start", "steer", "enqueue"]).default("start"),
    clientMessageId: z.string().min(1).max(180).optional(),
    skillIds: z.array(z.string()).max(20).default([]),
    resumeFromRunId: z.string().optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Prepare attachments and selected skills before accepting an input into a run. */
export function createInputBuilder(
  config: Config,
  assets: Assets,
  skills: SkillManager,
) {
  return async function buildInput(
    input: Input,
    session: Session,
    inputId: string,
    signal?: AbortSignal,
    includeAuditText = false,
  ): Promise<{ message: UserMessage; auditText?: string }> {
    signal?.throwIfAborted();
    const content: (TextPart | ImagePart)[] = [
      { type: "text", text: input.text || "" },
    ];
    const inputAssets = (input.assetIds || []).map((assetId) =>
      assets.owned(assetId, session.projectId),
    );
    invariant(
      inputAssets.reduce((sum, a) => sum + a.size, 0) <=
        config.limits.maxInputAssetBytes,
      "Combined attachments exceed the input byte budget",
      413,
    );
    const excerptLimit = Math.max(
      0,
      Math.floor(
        Math.min(
          config.limits.maxAttachmentText,
          config.routes[session.routeId].contextWindow * 0.2,
        ) / Math.max(1, inputAssets.length),
      ),
    );
    for (const assetId of input.assetIds || []) {
      signal?.throwIfAborted();
      const a = assets.owned(assetId, session.projectId);
      const meta = `Attachment ${a.id}: ${a.name} (${a.mime}, ${a.size} bytes).`;
      if (
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          a.mime,
        ) &&
        config.routes[session.routeId].acceptsImages &&
        a.size <= 5 * 1024 * 1024
      )
        content.push(
          { type: "text", text: meta },
          {
            type: "image",
            mimeType: a.mime,
            data: (await assets.read(a.id, session.projectId, signal)).toString(
              "base64",
            ),
          },
        );
      else {
        const extracted = excerptLimit
          ? await assets.extract(a.id, session.projectId, excerptLimit, signal)
          : {
              supported: false,
              truncated: true,
              text: "Inline excerpt omitted. Use asset_read with this asset ID to inspect its content.",
            };
        content.push({
          type: "text",
          text: `${meta}\n<untrusted_attachment supported="${extracted.supported}" truncated="${extracted.truncated}">\n${extracted.text}\n</untrusted_attachment>`,
        });
      }
    }
    signal?.throwIfAborted();
    if (input.skillIds?.length)
      content.push({
        type: "text",
        text: `<selected_skill_instructions>\n${skills.instructions(input.skillIds)}\n</selected_skill_instructions>`,
      });
    const message: UserMessage = {
      role: "user",
      content: redactJson(content),
      timestamp: Date.now(),
      inputId,
    };
    // Keep pre-redaction text separate: it may be inspected, but never persisted as a message.
    return {
      message,
      auditText: includeAuditText ? textOf({ content }) : undefined,
    };
  };
}
