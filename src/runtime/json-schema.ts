import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { invariant } from "../util.js";

/** Local validation only: no remote schema fetching, coercion or application of defaults. */
export function compileSchema(schema: any): ValidateFunction {
  invariant(
    Buffer.byteLength(JSON.stringify(schema)) <= 1024 * 1024,
    "JSON schema exceeds size limit",
  );
  const check = (value: any, depth: number) => {
    invariant(depth <= 80, "JSON schema exceeds nesting limit");
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string")
      invariant(
        value.$ref.startsWith("#"),
        "External JSON schema references are unsupported",
      );
    for (const item of Object.values(value))
      if (typeof item === "object") check(item, depth + 1);
  };
  check(schema, 0);
  const options = {
    strict: false,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    validateFormats: false,
  } as const;
  return (
    schema.$schema?.includes("2020-12")
      ? new Ajv2020(options)
      : new Ajv(options)
  ).compile(schema);
}
