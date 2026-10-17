import path from "node:path";
import { Office } from "../office.js";
import type { Assets } from "../assets.js";
import type { AssetExtractor } from "../runtime/extractors.js";
export function officeExtractor(
  assets: Assets,
  office = new Office(assets, assets.config),
): AssetExtractor {
  return {
    id: "office-formats",
    supports: (a) =>
      [".docx", ".xlsx", ".pdf", ".pptx"].includes(
        path.extname(a.name).toLowerCase(),
      ),
    extract: ({ asset, limit, signal }) =>
      office.extract(asset.projectId, asset.id, limit, signal),
  };
}
