import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { deepFreeze, invariant } from "../core/util.js";
import { z } from "zod";
import { Type } from "typebox";

const toolSchemas = new WeakMap<z.ZodType, Record<string, unknown>>();
/** Describe the same input accepted by the service; refinements still run in its parser. */
export function toolParameters<S extends z.ZodType>(schema: S) {
  let parameters = toolSchemas.get(schema);
  if (!parameters) {
    const { $schema: _dialect, ...input } = z.toJSONSchema(schema, {
      io: "input",
      target: "draft-7",
    });
    parameters = deepFreeze(input);
    toolSchemas.set(schema, parameters);
  }
  return Type.Unsafe<z.input<S>>(parameters);
}

export interface SchemaValidator {
  (value: unknown): boolean;
  errors?: ValidateFunction["errors"];
}

const cache = new Map<string, { validate: ValidateFunction; bytes: number }>();
const MAX_ENTRIES = 256,
  MAX_BYTES = 4 * 1024 * 1024;
let cachedBytes = 0;
const compilers = new Map<
  boolean,
  { ajv: Ajv | Ajv2020; entries: number; bytes: number }
>();

/** Rotate bounded compiler generations: Ajv retains codegen scope after removeSchema. */
function compiler(draft2020: boolean, bytes: number): Ajv | Ajv2020 {
  let entry = compilers.get(draft2020);
  if (!entry || entry.entries >= 64 || entry.bytes + bytes > MAX_BYTES / 4) {
    const options = {
      strict: false,
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      validateFormats: false,
    } as const;
    entry = {
      ajv: draft2020 ? new Ajv2020(options) : new Ajv(options),
      entries: 0,
      bytes: 0,
    };
    compilers.set(draft2020, entry);
  }
  entry.entries++;
  entry.bytes += bytes;
  return entry.ajv;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Local validation only: no remote schema fetching, coercion or application of defaults. */
export function compileSchema(schema: unknown): SchemaValidator {
  const serialized = JSON.stringify(schema);
  invariant(typeof serialized === "string", "Invalid JSON schema");
  const bytes = Buffer.byteLength(serialized);
  invariant(bytes <= 1024 * 1024, "JSON schema exceeds size limit");
  const cached = cache.get(serialized);
  if (cached) {
    cache.delete(serialized);
    cache.set(serialized, cached);
    return scopedValidator(cached.validate);
  }
  // Compilation must not retain the caller's mutable schema or share IDs between schemas.
  const snapshot: unknown = JSON.parse(serialized);
  invariant(
    typeof snapshot === "boolean" || isSchemaObject(snapshot),
    "Invalid JSON schema",
  );
  const check = (value: unknown, depth: number): void => {
    invariant(depth <= 80, "JSON schema exceeds nesting limit");
    if (!value || typeof value !== "object") return;
    if ("$ref" in value && typeof value.$ref === "string")
      invariant(
        value.$ref.startsWith("#"),
        "External JSON schema references are unsupported",
      );
    for (const item of Object.values(value))
      if (typeof item === "object") check(item, depth + 1);
  };
  check(snapshot, 0);
  const ajv = compiler(
    isSchemaObject(snapshot) &&
      typeof snapshot.$schema === "string" &&
      snapshot.$schema.includes("2020-12"),
    bytes,
  );
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(deepFreeze(snapshot));
  } finally {
    // Clear user IDs, including failed compilations, but retain Ajv's built-in meta alias.
    ajv.removeSchema(/^(?!http:\/\/json-schema\.org\/schema$)/);
  }
  invariant(
    !("$async" in validate && validate.$async === true),
    "Asynchronous JSON schemas are unsupported",
  );
  while (cache.size >= MAX_ENTRIES || cachedBytes + bytes > MAX_BYTES) {
    const oldest = cache.entries().next().value;
    if (!oldest) break;
    cachedBytes -= oldest[1].bytes;
    cache.delete(oldest[0]);
  }
  cache.set(serialized, { validate, bytes });
  cachedBytes += bytes;
  return scopedValidator(validate);
}

/** Ajv errors belong to one caller even when compiled validation code is reused. */
function scopedValidator(compiled: ValidateFunction): SchemaValidator {
  const validate: SchemaValidator = (value) => {
    const valid = compiled(value);
    validate.errors = compiled.errors;
    return valid;
  };
  return validate;
}
