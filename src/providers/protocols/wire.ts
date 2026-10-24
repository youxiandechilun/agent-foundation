import { z } from "zod";

const index = z.number().int().nonnegative();
export const nativeBlock = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
    signature: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.record(z.string(), z.json()).optional(),
  })
  .passthrough();
export type NativeBlock = z.infer<typeof nativeBlock>;

const completionMessage = z
  .object({
    content: z
      .union([
        z.string(),
        z.array(z.object({ text: z.string().optional() }).passthrough()),
      ])
      .nullable()
      .optional(),
    reasoning_content: z.string().nullable().optional(),
    reasoning: z.string().nullable().optional(),
    tool_calls: z
      .array(
        z
          .object({
            index: index.optional(),
            id: z.string().nullable().optional(),
            function: z
              .object({
                name: z.string().nullable().optional(),
                arguments: z.string().nullable().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();
export const completionEvent = z
  .object({
    id: z.string().nullable().optional(),
    choices: z
      .array(
        z
          .object({
            delta: completionMessage.nullable().optional(),
            message: completionMessage.nullable().optional(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
    usage: z.unknown().optional(),
  })
  .passthrough();

const responseContent = z
  .object({ type: z.string(), text: z.string().optional() })
  .passthrough();
const responseItem = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    content: z.array(responseContent).optional(),
  })
  .passthrough();
export const responseCall = z
  .object({
    type: z.literal("function_call"),
    call_id: z.string().min(1),
    name: z.string(),
    arguments: z.string(),
  })
  .passthrough();
const responseBody = z
  .object({
    id: z.string().optional(),
    status: z.string().optional(),
    usage: z.unknown().optional(),
    error: z.unknown().optional(),
    output: z.array(responseItem).optional(),
  })
  .passthrough();
export const responseEvent = z
  .object({
    type: z.string(),
    response: responseBody.optional(),
    delta: z.string().optional(),
    text: z.string().optional(),
    output_index: index.optional(),
    content_index: index.optional(),
    item_id: z.string().optional(),
    item: responseItem.optional(),
    part: responseContent.optional(),
  })
  .passthrough();
export type ResponseEvent = z.infer<typeof responseEvent>;
export type ResponseItem = z.infer<typeof responseItem>;
export const responseJson = responseBody;

export const anthropicEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_start"),
    message: z
      .object({ id: z.string(), usage: z.unknown().optional() })
      .passthrough(),
  }),
  z.object({
    type: z.literal("content_block_start"),
    index,
    content_block: nativeBlock,
  }),
  z.object({
    type: z.literal("content_block_delta"),
    index,
    delta: z
      .object({
        type: z.string(),
        text: z.string().optional(),
        thinking: z.string().optional(),
        signature: z.string().optional(),
        partial_json: z.string().optional(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal("message_delta"),
    usage: z.unknown().optional(),
    delta: z
      .object({ stop_reason: z.string().nullable().optional() })
      .passthrough()
      .optional(),
  }),
  z.object({ type: z.literal("error"), error: z.unknown().optional() }),
]);
export const anthropicJson = z
  .object({
    id: z.string(),
    content: z.array(nativeBlock).optional(),
    stop_reason: z.string().nullable().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough();

const tokens = z.number().int().nonnegative();
export const usagePayload = z
  .object({
    input_tokens: tokens.optional(),
    prompt_tokens: tokens.optional(),
    output_tokens: tokens.optional(),
    completion_tokens: tokens.optional(),
    cache_read_input_tokens: tokens.optional(),
    cache_creation_input_tokens: tokens.optional(),
    total_tokens: tokens.optional(),
    input_tokens_details: z
      .object({ cached_tokens: tokens.optional() })
      .nullable()
      .optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: tokens.optional() })
      .nullable()
      .optional(),
  })
  .passthrough();
