import { invariant } from "../../core/util.js";
import type { ResponseBuilder } from "../protocol.js";
import { responsesOutputText } from "../responses-search.js";
import type { ResponseEvent, ResponseItem } from "./wire.js";

interface TextBlock {
  type: string;
  text: string;
  done: boolean;
  emitted: number;
}
interface TextItem {
  id?: string;
  type?: string;
  done: boolean;
  blocks: Map<number, TextBlock>;
}
const textConflict = "Responses terminal text differs from streamed text";

/** Keeps wire addresses until snapshots validate them and text can be emitted in order. */
export class ResponsesText {
  private readonly items = new Map<number, TextItem>();
  private readonly identities = new Map<string, number>();
  private mode?: "indexed" | "legacy";

  private item(index: number, id?: string, type?: string) {
    let item = this.items.get(index);
    if (!item) {
      item = { done: false, blocks: new Map() };
      this.items.set(index, item);
    }
    if (id !== undefined) {
      const previous = this.identities.get(id);
      invariant(
        (item.id === undefined || item.id === id) &&
          (previous === undefined || previous === index),
        "Conflicting Responses text item identity",
        502,
      );
      item.id = id;
      this.identities.set(id, index);
    }
    if (type !== undefined) {
      invariant(
        item.type === undefined || item.type === type,
        "Conflicting Responses text item type",
        502,
      );
      item.type = type;
    }
    return item;
  }

  private block(item: TextItem, index: number, type: string) {
    let block = item.blocks.get(index);
    invariant(!item.done || block, textConflict, 502);
    if (!block) {
      block = { type, text: "", done: false, emitted: 0 };
      item.blocks.set(index, block);
    }
    invariant(block.type === type, textConflict, 502);
    return block;
  }

  private snapshot(block: TextBlock, text: string, done: boolean) {
    invariant(
      block.done ? text === block.text : text.startsWith(block.text),
      textConflict,
      502,
    );
    block.text = text;
    block.done ||= done;
  }

  private itemSnapshot(index: number, value: ResponseItem, done: boolean) {
    const item = this.item(index, value.id, value.type);
    const content = value.content;
    if (value.type === "message" && content !== undefined) {
      if (done)
        invariant(
          [...item.blocks.keys()].every((i) => i < content.length),
          textConflict,
          502,
        );
      for (const [i, part] of content.entries()) {
        const block = this.block(item, i, part.type);
        if (part.type === "output_text") {
          invariant(
            typeof part.text === "string",
            "Invalid Responses text snapshot",
            502,
          );
          this.snapshot(block, part.text, done);
        } else block.done ||= done;
      }
    } else if (done && value.type === "message")
      invariant(!item.blocks.size, textConflict, 502);
    item.done ||= done;
  }

  private async flush(response: ResponseBuilder) {
    if (this.mode !== "indexed") return;
    let outputIndex = 0;
    for (const [index, item] of [...this.items].sort(([a], [b]) => a - b)) {
      if (index !== outputIndex++) return;
      if (item.type !== "message") continue;
      let contentIndex = 0;
      for (const [index, block] of [...item.blocks].sort(([a], [b]) => a - b)) {
        if (index !== contentIndex++) return;
        if (block.type === "output_text") {
          const suffix = block.text.slice(block.emitted);
          block.emitted = block.text.length;
          await response.text(suffix);
        }
        if (!block.done) return;
      }
      if (!item.done) return;
    }
  }

  async observe(event: ResponseEvent, response: ResponseBuilder) {
    const outputIndex = event.output_index,
      contentIndex = event.content_index;
    if (event.type === "response.output_text.delta") {
      invariant(
        typeof event.delta === "string",
        "Invalid Responses text delta",
        502,
      );
      const indexed = outputIndex !== undefined && contentIndex !== undefined;
      this.mode ??= indexed ? "indexed" : "legacy";
      response.started ||= Boolean(event.delta);
      if (this.mode === "legacy") {
        await response.text(event.delta);
        return;
      }
      invariant(
        indexed,
        "Responses indexed text delta is missing its index",
        502,
      );
      const item = this.item(outputIndex, event.item_id, "message"),
        block = this.block(item, contentIndex, "output_text");
      invariant(
        !block.done || !event.delta,
        "Responses text delta follows completed content",
        502,
      );
      block.text += event.delta;
    }
    if (
      (event.type === "response.output_item.added" ||
        event.type === "response.output_item.done") &&
      outputIndex !== undefined &&
      event.item
    ) {
      response.started ||= Boolean(responsesOutputText([event.item]));
      this.itemSnapshot(outputIndex, event.item, event.type.endsWith(".done"));
    }
    if (
      [
        "response.output_text.done",
        "response.content_part.added",
        "response.content_part.done",
      ].includes(event.type) &&
      outputIndex !== undefined &&
      contentIndex !== undefined
    ) {
      const item = this.item(outputIndex, event.item_id, "message"),
        part =
          event.type === "response.output_text.done"
            ? { type: "output_text", text: event.text }
            : event.part;
      invariant(part, "Responses content part is missing", 502);
      const block = this.block(item, contentIndex, part.type);
      if (part.type === "output_text") {
        invariant(
          typeof part.text === "string",
          "Invalid Responses text snapshot",
          502,
        );
        this.snapshot(block, part.text, event.type.endsWith(".done"));
        response.started ||= Boolean(part.text);
      } else block.done ||= event.type.endsWith(".done");
    }
    await this.flush(response);
  }

  async terminal(
    output: ResponseItem[] | undefined,
    response: ResponseBuilder,
  ) {
    if (output !== undefined) {
      if (this.mode !== "legacy")
        for (const [index, item] of this.items)
          invariant(
            index < output.length || !item.blocks.size,
            textConflict,
            502,
          );
      for (const [index, item] of output.entries())
        this.itemSnapshot(index, item, true);
    }
    if (this.mode === "legacy") {
      const text = responsesOutputText(output);
      if (text !== undefined) {
        const received = response.output.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        invariant(text.startsWith(received), textConflict, 502);
        await response.text(text.slice(received.length));
      }
      return;
    }
    this.mode = "indexed";
    await this.flush(response);
    invariant(
      [...this.items.values()].every((item) =>
        [...item.blocks.values()].every(
          (block) => block.emitted === block.text.length,
        ),
      ),
      "Responses terminal output is missing streamed text",
      502,
    );
  }
}
