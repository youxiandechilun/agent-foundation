/**
 * Join prompt sentences with single spaces. Prompts keep one sentence per source line so
 * wording changes stay reviewable; the joined text equals the former single-line literal.
 */
export const sentences = (...lines: string[]) => lines.join(" ");
