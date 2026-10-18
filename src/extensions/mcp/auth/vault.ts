import {
  readEncryptedText,
  writeEncryptedJson,
} from "../../../storage/encrypted-file.js";
import { rmSync } from "node:fs";
import path from "node:path";
import { invariant } from "../../../core/util.js";

/** Encrypted host-local state. The caller supplies both identity binding and its commit guard. */
export class OAuthVault {
  constructor(
    private root: string,
    private key: () => Promise<Buffer>,
    private lifetime: AbortSignal,
  ) {}
  private file(id: string, kind: string) {
    invariant(
      /^[a-zA-Z0-9_-]{1,64}$/.test(id) && /^[a-z-]{1,40}$/.test(kind),
      "Invalid OAuth vault identity",
    );
    return path.join(this.root, id + "." + kind + ".json");
  }
  async load<T>(
    id: string,
    kind: string,
    binding: string,
  ): Promise<T | undefined> {
    this.lifetime.throwIfAborted();
    const text = await readEncryptedText(
      this.identity(id, kind, binding),
      this.key,
      {
        maxBytes: 2 * 1024 * 1024,
        guard: () => this.lifetime.throwIfAborted(),
      },
    );
    return text === undefined ? undefined : JSON.parse(text);
  }

  async save(
    id: string,
    kind: string,
    binding: string,
    value: unknown,
    guard: () => void = () => {},
  ) {
    this.lifetime.throwIfAborted();
    guard();
    await writeEncryptedJson(
      this.identity(id, kind, binding),
      this.key,
      value,
      () => {
        this.lifetime.throwIfAborted();
        guard();
      },
    );
  }
  private identity(id: string, kind: string, binding: string) {
    return {
      file: this.file(id, kind),
      binding,
      aad: id + "\n" + kind + "\n" + binding,
    };
  }

  remove(id: string, kind: string) {
    rmSync(this.file(id, kind), { force: true });
  }
}
