import { test } from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { compileSchema } from "../src/runtime/json-schema.js";

test("schema reuse keeps validation errors private and recompiles modified schemas", () => {
  const schema = { $id: "urn:test:same-id", type: "string", minLength: 3 };
  const first = compileSchema(schema),
    second = compileSchema({ ...schema });
  assert.notEqual(first, second);
  assert.equal(first("x"), false);
  const errors = structuredClone(first.errors);
  assert.equal(second("valid"), true);
  assert.deepEqual(first.errors, errors);
  assert.equal(second.errors, null);
  schema.minLength = 10;
  const changed = compileSchema(schema);
  assert.equal(changed("valid"), false);
  assert.equal(
    first("valid"),
    true,
    "the original compiled snapshot must not mutate",
  );
  const independent = compileSchema({ $id: schema.$id, type: "number" });
  assert.equal(independent(12), true);
  assert.equal(independent("valid"), false);
});

test("schema cache retains local references, draft selection and validation constraints", () => {
  for (let i = 0; i < 2; i++) {
    const validate = compileSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { identifier: { type: "integer", minimum: 1 } },
      type: "object",
      properties: { id: { $ref: "#/$defs/identifier" } },
      required: ["id"],
      additionalProperties: false,
    });
    assert.equal(validate({ id: 1 }), true);
    assert.equal(validate({ id: "1" }), false);
    assert.equal(validate({ id: 0 }), false);
    assert.equal(validate({ id: 1, extra: true }), false);
    assert.equal(compileSchema(true)(null), true);
    assert.equal(compileSchema(false)(null), false);
    assert.throws(
      () => compileSchema({ $ref: "https://remote.example/schema" }),
      /External/,
    );
    assert.throws(
      () => compileSchema({ $async: true, type: "string" }),
      /Asynchronous/,
    );
  }
  const payload = { $async: true };
  assert.equal(compileSchema({ const: payload })(payload), true);
});

test("schema cache eviction preserves existing validators and revalidates limits", () => {
  const original = compileSchema({ const: "retained" });
  for (let i = 0; i < 300; i++)
    assert.equal(compileSchema({ const: i })(i), true);
  assert.equal(original("retained"), true);
  assert.equal(compileSchema({ const: "retained" })("different"), false);
  assert.throws(
    () => compileSchema({ description: "x".repeat(1024 * 1024) }),
    /size limit/,
  );
  let nested: unknown = { type: "string" };
  for (let i = 0; i < 82; i++) nested = { items: nested };
  assert.throws(() => compileSchema(nested), /nesting limit/);
});

test("repeated tool catalogs larger than 64 schemas reuse validation code and bounded compiler generations", (t) => {
  const compile = t.mock.method(Ajv.prototype, "compile");
  const schemas = Array.from({ length: 96 }, (_, index) => ({
    $id: "urn:test:catalog-shared-id",
    type: "object",
    properties: { id: { const: `catalog-${index}` } },
    required: ["id"],
  }));
  for (let round = 0; round < 3; round++)
    for (const [index, schema] of schemas.entries()) {
      const validate = compileSchema(structuredClone(schema));
      assert.equal(validate({ id: `catalog-${index}` }), true);
      assert.equal(validate({ id: "other" }), false);
    }
  assert.equal(compile.mock.callCount(), schemas.length);
  const compilers = new Set(compile.mock.calls.map((call) => call.this));
  assert.ok(compilers.size >= 2 && compilers.size <= 3);
});

test("compiler reuse isolates nested IDs and clears failed schemas in both dialects", () => {
  for (const $schema of [
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2020-12/schema",
  ]) {
    const validators = ["string", "number"].map((type) =>
      compileSchema({
        $schema,
        $id: "https://example.test/schema",
        $defs: { item: { $id: "item", type } },
        type: "array",
        items: { $ref: "#/$defs/item" },
      }),
    );
    assert.equal(validators[0](["value"]), true);
    assert.equal(validators[0]([1]), false);
    const errors = structuredClone(validators[0].errors);
    assert.equal(validators[1]([1]), true);
    assert.equal(validators[1](["value"]), false);
    assert.deepEqual(validators[0].errors, errors);
    assert.throws(() =>
      compileSchema({
        $schema,
        $id: "urn:test:failed-compile",
        type: "not-a-type",
      }),
    );
    assert.equal(
      compileSchema({
        $schema,
        $id: "urn:test:failed-compile",
        type: "integer",
      })(1),
      true,
    );
  }
});

test("recursive local references survive compiler rotation and cache eviction", () => {
  const validators = [
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2020-12/schema",
  ].map(($schema) =>
    compileSchema({
      $schema,
      $id: "urn:test:recursive",
      type: "object",
      properties: { value: { type: "string" }, child: { $ref: "#" } },
      required: ["value"],
    }),
  );
  for (let index = 0; index < 300; index++)
    compileSchema({ const: `rotation-${index}` });
  for (const validate of validators) {
    assert.equal(validate({ value: "root", child: { value: "leaf" } }), true);
    assert.equal(validate({ value: "root", child: { value: 42 } }), false);
  }
});

test("compiler reuse preserves built-in meta aliases without admitting a conflicting user ID", () => {
  assert.equal(
    compileSchema({ type: "number", description: "alias warmup" })(1),
    true,
  );
  const first = compileSchema({
    $schema: "http://json-schema.org/schema#",
    type: "string",
  });
  assert.equal(first("text"), true);
  assert.equal(first(1), false);
  assert.throws(
    () =>
      compileSchema({ $id: "http://json-schema.org/schema", type: "string" }),
    /already exists/,
  );
  const second = compileSchema({
    $schema: "http://json-schema.org/schema",
    type: "integer",
  });
  assert.equal(second(1), true);
  assert.equal(second("text"), false);
  assert.equal(first("still valid"), true);
});

test("draft 2020 compiler cleanup retains its public generic meta-schema alias", (t) => {
  const compile = t.mock.method(Ajv2020.prototype, "compile");
  for (const type of ["string", "integer"]) {
    compileSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema#",
      type,
      description: "2020 alias",
    });
    const instance = compile.mock.calls.at(-1)?.this;
    assert.ok(instance instanceof Ajv2020);
    const meta = instance.getSchema("http://json-schema.org/schema#");
    assert.ok(meta);
    assert.equal(meta({ type: "string" }), true);
    assert.equal(meta({ type: "invalid-type" }), false);
  }
});
