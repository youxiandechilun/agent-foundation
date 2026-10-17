import type { Asset } from "../contracts.js";
import { invariant } from "../util.js";
export interface AssetExtractor {
  id: string;
  supports: (asset: Asset) => boolean;
  extract: (context: {
    asset: Asset;
    limit: number;
    signal?: AbortSignal;
    read: () => Promise<Buffer>;
  }) => Promise<{ text: string; supported: boolean; truncated: boolean }>;
}
export class ExtractorRegistry {
  private entries = new Map<string, AssetExtractor>();
  register(extractor: AssetExtractor) {
    invariant(!this.entries.has(extractor.id), "Duplicate extractor ID");
    this.entries.set(extractor.id, extractor);
    return () =>
      this.entries.get(extractor.id) === extractor &&
      this.entries.delete(extractor.id);
  }
  list() {
    return [...this.entries.keys()];
  }
  find(asset: Asset) {
    return [...this.entries.values()].find((parser) => parser.supports(asset));
  }
}
