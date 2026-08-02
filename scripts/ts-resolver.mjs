/**
 * Module resolver hook so plain Node can run the app's TypeScript sources.
 *
 * The source uses TypeScript's `bundler` resolution — extensionless relative
 * imports and the `@/` alias — because that is what Next expects. Node's ESM
 * loader requires explicit file extensions and knows nothing about the alias.
 *
 * Rather than contort the source to suit the test runner (adding `.ts` to every
 * import would need `allowImportingTsExtensions` and risks upsetting Turbopack),
 * this hook teaches Node the two conventions. Used by the eval harness and the
 * classifier tests; never loaded in production.
 */

const ROOT = new URL("../", import.meta.url);

/** Suffixes to retry, in the order TypeScript itself would try them. */
const SUFFIXES = [".ts", ".tsx", "/index.ts", ".mts", ".js"];

export async function resolve(specifier, context, next) {
  let spec = specifier;

  // "@/lib/foo" -> "<root>/src/lib/foo"
  if (spec.startsWith("@/")) {
    spec = new URL(`src/${spec.slice(2)}`, ROOT).href;
  }

  try {
    return await next(spec, context);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND" && err?.code !== "ERR_UNSUPPORTED_DIR_IMPORT") {
      throw err;
    }
    for (const suffix of SUFFIXES) {
      try {
        return await next(spec + suffix, context);
      } catch {
        // try the next suffix
      }
    }
    throw err;
  }
}
