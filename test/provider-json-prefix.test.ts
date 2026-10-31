import assert from "node:assert/strict";
import { test } from "node:test";
import { isIncompleteJson } from "../src/providers/json-prefix.js";

test("every unfinished prefix of valid provider JSON is classified without parsing error prose", () => {
  for (const source of [
    String.raw`{"choices":[{"delta":{"content":"split \u1234 \" text"}}],"ok":true,"other":null}`,
    '[false,-12.34e-56,{"a":[],"b":{}},"\\n\\t\\\\"]',
    "true",
    "false",
    "null",
    "-0.25e+10",
  ]) {
    assert.equal(isIncompleteJson(source), false);
    for (let length = 0; length < source.length; length++) {
      const prefix = source.slice(0, length);
      let unfinished = false;
      try {
        JSON.parse(prefix);
      } catch {
        unfinished = true;
      }
      assert.equal(
        isIncompleteJson(prefix),
        unfinished,
        JSON.stringify(prefix),
      );
    }
  }
});

test("invalid syntax cannot become a recoverable EOF by appending more bytes", () => {
  for (const source of [
    "{invalid",
    '{"a" 1',
    "[1,]",
    "[1 2",
    '{"a":01',
    '{"a":"\\q',
    '{"a":"\\u12x',
    '{"a":"line\n',
    "truth",
    "-x",
    "1.e",
    "1e+x",
    '{"a":}',
    "[] trailing",
    "[".repeat(514),
  ]) {
    assert.equal(isIncompleteJson(source), false, JSON.stringify(source));
  }
});
