/**
 * Registers the TypeScript resolver hook.
 *
 * Separate from the hook itself because `register()` runs on the main thread
 * while the hook runs on the loader thread — and because building a self-URL on
 * Windows via pathToFileURL(url.pathname) yields "C:\C:\..." (the pathname
 * already carries the drive letter).
 *
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs <script>
 */
import { register } from "node:module";

register("./ts-resolver.mjs", import.meta.url);
