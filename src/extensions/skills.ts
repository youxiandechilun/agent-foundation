import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { Store } from "../store.js";
import type { Skill } from "../contracts.js";
import type { Capability } from "../runtime/types.js";
import { hash, now, invariant } from "../util.js";
import { within } from "../util.js";
import { validateSourceFiles } from "./source-bundle.js";
import { realpath, readdir, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";

export class SkillManager {
  constructor(
    readonly store: Store,
    readonly config?: Config,
  ) {}
  install(
    source: string,
    resources: Record<
      string,
      string | { encoding: "utf8" | "base64"; data: string }
    > = {},
  ): Skill {
    invariant(Buffer.byteLength(source) <= 128000, "Skill exceeds 128 KB");
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    invariant(match, "SKILL.md must have YAML frontmatter");
    const meta = z
      .object({
        name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
        description: z.string().min(1).max(2000),
        version: z.string().max(80).default("1.0.0"),
        capabilities: z
          .array(
            z.enum([
              "files.read",
              "files.write",
              "exec",
              "media",
              "browser",
              "computer",
              "mcp",
              "plugin",
              "memory.read",
              "memory.write",
              "network",
              "node",
            ]),
          )
          .default([]),
      })
      .passthrough()
      .parse(parseYaml(match[1], { maxAliasCount: 20 }));
    const instructions = match[2].trim();
    invariant(instructions.length > 0, "Skill instructions missing");
    const normalized = Object.entries(resources).map(([name, value]) => {
      const resource =
        typeof value === "string"
          ? { encoding: "utf8" as const, data: value }
          : z
              .object({
                encoding: z.enum(["utf8", "base64"]),
                data: z.string(),
              })
              .strict()
              .parse(value);
      invariant(
        name !== "SKILL.md",
        "SKILL.md is the main source, not a resource",
      );
      const bytes = Buffer.from(
        resource.data,
        resource.encoding === "utf8" ? "utf8" : "base64",
      );
      invariant(
        resource.encoding !== "base64" ||
          bytes.toString("base64") === resource.data,
        "Resource base64 is not canonical",
      );
      return {
        path: name,
        ...resource,
        sha256: hash(bytes),
        bytes: bytes.length,
      };
    });
    if (normalized.length)
      validateSourceFiles(
        Object.fromEntries(normalized.map((r) => [r.path, r.data])),
      );
    normalized.sort((a, b) => a.path.localeCompare(b.path));
    const skill: Skill = {
      id: meta.name,
      name: meta.name,
      description: meta.description,
      instructions,
      enabled: true,
      capabilities: meta.capabilities,
      sha256: normalized.length
        ? hash(JSON.stringify({ source, resources: normalized }))
        : hash(source),
      source,
      version: meta.version,
      resources: normalized,
      createdAt: now(),
    };
    return this.store.put("skills", skill);
  }
  async installDirectory(directory: string) {
    invariant(
      this.config,
      "Skill directory installation needs host configuration",
    );
    const actual = await realpath(directory),
      roots = await Promise.all(
        this.config.extensions.allowedRoots.map((root) => realpath(root)),
      );
    invariant(
      roots.some((root) => within(root, actual)),
      "Skill directory outside extension roots",
      403,
    );
    const files: Record<string, { encoding: "utf8" | "base64"; data: string }> =
      Object.create(null);
    let size = 0;
    const walk = async (dir: string) => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name),
          info = await lstat(file);
        invariant(!info.isSymbolicLink(), "Skill symlinks are forbidden", 403);
        if (info.isDirectory()) await walk(file);
        else {
          invariant(
            info.isFile() && Object.keys(files).length <= 200,
            "Skill resource limit exceeded",
          );
          size += info.size;
          invariant(size <= 4 * 1024 * 1024, "Skill resources exceed 4 MiB");
          const bytes = await readFile(file),
            text = bytes.toString("utf8"),
            utf8 = !text.includes("\0") && Buffer.from(text).equals(bytes);
          files[path.relative(actual, file).replaceAll("\\", "/")] = {
            encoding: utf8 ? "utf8" : "base64",
            data: utf8 ? text : bytes.toString("base64"),
          };
        }
      }
    };
    await walk(actual);
    const source = files["SKILL.md"];
    invariant(
      source?.encoding === "utf8",
      "Skill directory needs a UTF-8 SKILL.md",
    );
    delete files["SKILL.md"];
    return this.install(source.data, files);
  }
  get(skillId: string) {
    return this.store.get<Skill>("skills", skillId);
  }
  resource(skillId: string, name: string) {
    const skill = this.get(skillId);
    invariant(skill.enabled, "Skill disabled", 403);
    const resource = skill.resources?.find((r) => r.path === name);
    invariant(resource, "Skill resource not found", 404);
    return resource;
  }
  export(skillId: string) {
    const skill = this.get(skillId);
    return {
      source:
        skill.source ||
        `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n${skill.instructions}`,
      resources: Object.fromEntries(
        (skill.resources || []).map((r) => [
          r.path,
          { encoding: r.encoding, data: r.data },
        ]),
      ),
    };
  }
  list() {
    return this.store.list<Skill>("skills");
  }
  enable(skillId: string, enabled: boolean) {
    return this.store.put("skills", {
      ...this.store.get<Skill>("skills", skillId),
      enabled,
    });
  }
  remove(skillId: string) {
    this.store.get("skills", skillId);
    this.store.remove("skills", skillId);
  }
  catalog() {
    return this.list()
      .filter((s) => s.enabled)
      .map((s) => ({
        id: s.id,
        description: s.description,
        capabilities: s.capabilities,
        version: s.version,
        resources: s.resources?.map((r) => ({
          path: r.path,
          bytes: r.bytes,
          encoding: r.encoding,
        })),
      }));
  }
  instructions(ids: string[]) {
    return ids
      .map((skillId) => {
        const skill = this.store.get<Skill>("skills", skillId);
        invariant(skill.enabled, `Skill ${skillId} disabled`, 403);
        return `<skill id="${skill.id}" hash="${skill.sha256}">\n${skill.instructions}\n</skill>`;
      })
      .join("\n\n");
  }
}
