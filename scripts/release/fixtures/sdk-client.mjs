import {
  FoundationClient,
  FoundationHttpError,
} from "@local/agent-foundation/client";

const client = new FoundationClient("http://127.0.0.1:4317/", "test-token");
if (
  client.baseUrl !== "http://127.0.0.1:4317" ||
  !new FoundationHttpError(503, "unavailable", "test").retryable
) {
  throw new Error("Portable client import and public constructors failed");
}
console.log("Portable client imported without Node builtins");
