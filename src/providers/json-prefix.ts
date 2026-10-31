/** True only when appending bytes could complete a valid JSON document. */
export function isIncompleteJson(text: string): boolean {
  const incomplete = Symbol("incomplete"),
    invalid = Symbol("invalid");
  let at = 0;
  const space = () => {
    while (/[\t\n\r ]/.test(text[at] ?? "")) at++;
  };
  const need = () => {
    if (at === text.length) throw incomplete;
  };
  const string = () => {
    at++;
    while (true) {
      need();
      const character = text[at++];
      if (character === '"') return;
      if (character.charCodeAt(0) < 32) throw invalid;
      if (character !== "\\") continue;
      need();
      const escape = text[at++];
      if (escape === "u") {
        for (let digit = 0; digit < 4; digit++) {
          need();
          if (!/[0-9a-f]/i.test(text[at++])) throw invalid;
        }
      } else if (!'"\\/bfnrt'.includes(escape)) throw invalid;
    }
  };
  const value = (depth: number): void => {
    // Classification must not consume an unbounded call stack for hostile input.
    if (depth > 512) throw invalid;
    space();
    need();
    const character = text[at];
    if (character === '"') return string();
    if (character === "{" || character === "[") {
      const object = character === "{",
        end = object ? "}" : "]";
      at++;
      space();
      need();
      if (text[at] === end) {
        at++;
        return;
      }
      while (true) {
        if (object) {
          if (text[at] !== '"') throw invalid;
          string();
          space();
          need();
          if (text[at++] !== ":") throw invalid;
        }
        value(depth + 1);
        space();
        need();
        if (text[at] === end) {
          at++;
          return;
        }
        if (text[at++] !== ",") throw invalid;
        space();
        need();
      }
    }
    const literal =
      character === "t"
        ? "true"
        : character === "f"
          ? "false"
          : character === "n"
            ? "null"
            : undefined;
    if (literal) {
      for (const expected of literal) {
        need();
        if (text[at++] !== expected) throw invalid;
      }
      return;
    }
    if (character === "-") {
      at++;
      need();
    }
    if (text[at] === "0") at++;
    else {
      if (!/[1-9]/.test(text[at] ?? "")) throw invalid;
      while (/[0-9]/.test(text[at] ?? "")) at++;
    }
    if (text[at] === ".") {
      at++;
      need();
      if (!/[0-9]/.test(text[at])) throw invalid;
      while (/[0-9]/.test(text[at] ?? "")) at++;
    }
    if (text[at] === "e" || text[at] === "E") {
      at++;
      need();
      if (text[at] === "+" || text[at] === "-") {
        at++;
        need();
      }
      if (!/[0-9]/.test(text[at])) throw invalid;
      while (/[0-9]/.test(text[at] ?? "")) at++;
    }
  };
  try {
    value(0);
    space();
    return false;
  } catch (error) {
    return error === incomplete;
  }
}
