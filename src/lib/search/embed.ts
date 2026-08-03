/**
 * Embeddings for semantic search, via OpenRouter.
 *
 * Vectors are stored as a raw float32 BLOB on the item rather than JSON: 1536
 * floats are 6 KB packed versus roughly 30 KB as text, and they are read in
 * bulk on every semantic search.
 *
 * Similarity is computed in JavaScript over every stored vector. That sounds
 * naive and is the right call here: a thousand items is 1.5M multiply-adds,
 * low single-digit milliseconds, against the alternative of adding a vector
 * extension to SQLite and a build dependency to the image. Revisit at ~50k
 * items, not before.
 */

const EMBED_URL = "https://openrouter.ai/api/v1/embeddings";

// Trimmed and emptiness-checked, not just `?? default`. Docker Compose sets an
// undeclared variable to the empty string rather than leaving it unset, so a
// bare `??` would hand an empty model name to the API and fail every search.
export const EMBED_MODEL =
  process.env.OPENROUTER_EMBED_MODEL?.trim() || "openai/text-embedding-3-small";

/** Cheap relative to an article; well short of the model's 8k limit. */
const MAX_CHARS = 8_000;

/**
 * Cosine similarity below which a semantic hit is noise.
 *
 * Measured on text-embedding-3-small over a real library rather than guessed —
 * an earlier value of 0.34 was set by assumption and sat *above* most genuine
 * matches, so semantic search silently returned nothing:
 *
 *   deliberately irrelevant query ("cooking pasta recipes")   ceiling 0.151
 *   conceptual match ("data races" -> Rust ownership)                0.291
 *   direct match ("ownership" -> Rust ownership)                     0.345
 *   strong match ("react hooks" -> useEffect guide)                  0.542
 *
 * 0.22 clears the noise ceiling with headroom while admitting conceptual
 * matches. It is specific to this embedding model — changing the model means
 * re-measuring, which is what OPENROUTER_SEMANTIC_FLOOR is for.
 */
export const DEFAULT_SEMANTIC_FLOOR = 0.22;

/**
 * Reads the floor from the environment, defensively.
 *
 * Not `Number(env ?? default)`. Docker Compose turns a variable listed under
 * `environment:` but absent from the env file into the *empty string* rather
 * than leaving it unset, and `Number("")` is 0, not NaN. A bare `??` would
 * therefore drop the floor to zero in exactly one environment — production —
 * and every item in the library would come back as "related by meaning" with
 * nothing in any log to explain it. An out-of-range value is refused loudly
 * for the same reason: a threshold that silently means "match everything" is
 * worse than one that is obviously wrong.
 */
export function readFloor(): number {
  const raw = process.env.OPENROUTER_SEMANTIC_FLOOR?.trim();
  if (!raw) return DEFAULT_SEMANTIC_FLOOR;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn(
      `[search] ignoring OPENROUTER_SEMANTIC_FLOOR=${JSON.stringify(raw)} ` +
        `(want a number 0-1); using ${DEFAULT_SEMANTIC_FLOOR}`
    );
    return DEFAULT_SEMANTIC_FLOOR;
  }
  return parsed;
}

export class EmbeddingUnavailableError extends Error {}

/**
 * Embeds one string. Throws on failure — callers decide whether that is fatal
 * (a search) or merely means "no semantic result for this item" (indexing).
 */
export async function embed(text: string): Promise<Float32Array> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new EmbeddingUnavailableError("OPENROUTER_API_KEY is not set");

  const input = text.trim().slice(0, MAX_CHARS);
  if (!input) throw new EmbeddingUnavailableError("nothing to embed");

  let res: Response;
  try {
    res = await fetch(EMBED_URL, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://www.rightread.net",
        "X-Title": "rightread",
      },
      body: JSON.stringify({ model: EMBED_MODEL, input }),
    });
  } catch (err) {
    throw new EmbeddingUnavailableError(
      err instanceof Error ? err.message : "network error"
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EmbeddingUnavailableError(`HTTP ${res.status}: ${body.slice(0, 160)}`);
  }

  const data = await res.json().catch(() => null);
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new EmbeddingUnavailableError("empty embedding");
  }

  return Float32Array.from(vector as number[]);
}

/**
 * What actually gets embedded for an item.
 *
 * Title and site are repeated ahead of the body because the opening of an
 * article is disproportionately about what it *is*, and because only the first
 * MAX_CHARS survive truncation — a long page would otherwise be represented
 * entirely by its introduction.
 */
export function embeddableText(item: {
  title: string;
  siteName?: string | null;
  excerpt?: string | null;
  textContent?: string | null;
}): string {
  return [
    item.title,
    item.siteName ?? "",
    item.excerpt ?? "",
    item.textContent ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Copies into a freshly allocated Uint8Array rather than viewing the existing
 * buffer: Prisma's Bytes type requires `Uint8Array<ArrayBuffer>`, and a view
 * over a Float32Array's buffer is typed `ArrayBufferLike` (it could in
 * principle be a SharedArrayBuffer).
 */
export function toBlob(vector: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(vector.byteLength));
  out.set(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
  return out;
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copy rather than view: a Buffer from Prisma may sit at a non-zero offset
  // in a pooled ArrayBuffer, and Float32Array requires 4-byte alignment.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/**
 * Cosine similarity. OpenAI-family embeddings arrive L2-normalised, so this is
 * effectively a dot product — but the magnitudes are computed anyway, because
 * silently returning wrong scores if that ever changes would be worse than the
 * few microseconds it costs.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
