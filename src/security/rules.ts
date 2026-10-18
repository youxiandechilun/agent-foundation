import type { SecurityAuditConfig } from "./config.js";
import type { SecurityAuditRequest, SecurityAuditRule } from "./types.js";
import type { JsonValue } from "../runtime/types.js";

// These bounded patterns are heuristics. Normal discussion can match, so the default only flags.
const injectionPatterns = [
  /\b(?:ignore|disregard|override|bypass)\b[\s\S]{0,80}\b(?:previous|prior|system|developer|safety|security)\b[\s\S]{0,40}\b(?:instructions?|prompts?|rules?|polic(?:y|ies)|restrictions?)\b/i,
  /\b(?:reveal|print|show|output|repeat|disclose)\b[\s\S]{0,80}\b(?:system|developer)\s+(?:prompts?|instructions?)\b/i,
  /(?:忽略|无视|覆盖|绕过|跳过)[\s\S]{0,30}(?:之前|以前|以上|先前|系统|开发者|安全)[\s\S]{0,20}(?:指令|提示词|规则|策略|限制)/,
  /(?:泄露|泄漏|输出|显示|打印|复述|告诉我)[\s\S]{0,30}(?:系统|开发者)[\s\S]{0,10}(?:提示词|指令)/,
];

function requestTexts(request: SecurityAuditRequest): string[] {
  if (request.stage === "input") return [request.text];
  const texts: string[] = [],
    pending: JsonValue[] = [request.arguments],
    visited = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") texts.push(value);
    else if (value && typeof value === "object" && !visited.has(value)) {
      visited.add(value);
      if (Array.isArray(value)) for (const child of value) pending.push(child);
      else
        for (const [key, child] of Object.entries(value)) {
          texts.push(key);
          pending.push(child);
        }
    }
  }
  return texts;
}

export function builtInAuditRules(
  config: SecurityAuditConfig,
): SecurityAuditRule[] {
  const texts = new WeakMap<
    SecurityAuditRequest,
    { original: string[]; lower?: string[] }
  >();
  const text = (
    request: SecurityAuditRequest,
    caseSensitive = true,
  ): readonly string[] => {
    let cached = texts.get(request);
    if (!cached) {
      cached = { original: requestTexts(request) };
      texts.set(request, cached);
    }
    return caseSensitive
      ? cached.original
      : (cached.lower ??= cached.original.map((part) => part.toLowerCase()));
  };
  const rules: SecurityAuditRule[] = config.textRules.map((rule) => {
    const terms = [
      ...new Set(
        rule.terms.map((term) =>
          rule.caseSensitive ? term : term.toLowerCase(),
        ),
      ),
    ];
    return {
      id: rule.id,
      stages: rule.stages,
      evaluate: (request) =>
        terms.some((term) =>
          text(request, rule.caseSensitive).some((part) => part.includes(term)),
        )
          ? [
              {
                code: "text_match",
                severity: rule.action === "deny" ? "high" : "medium",
                action: rule.action,
              },
            ]
          : [],
    };
  });
  if (config.promptInjection !== "off") {
    const action = config.promptInjection;
    rules.unshift({
      id: "builtin.prompt-injection",
      stages: ["input", "tool"],
      evaluate: (request) =>
        text(request).some((part) =>
          injectionPatterns.some((pattern) => pattern.test(part)),
        )
          ? [{ code: "prompt_injection", severity: "high", action }]
          : [],
    });
  }
  return rules;
}
