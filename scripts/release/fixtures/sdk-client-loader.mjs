export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith("node:")) {
    throw new Error(
      `Portable client unexpectedly imports a Node builtin: ${result.url}`,
    );
  }
  return result;
}
