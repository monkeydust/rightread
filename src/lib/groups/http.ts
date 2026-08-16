/**
 * Turning group errors into responses.
 *
 * Kept in one place so that every group route answers a stranger the same way:
 * **404, never 403**. A 403 confirms that the id you guessed is real, which is
 * exactly what an enumeration attempt is looking for, and it is the convention
 * the rest of the app already follows for a row you do not own
 * (`api/items/[id]/route.ts`).
 */

import { NotAMember } from "./access";
import { InvalidGroupName, InvalidEmail } from "./manage";

/**
 * Maps a thrown group error to a Response, or returns null if it is not one of
 * ours — in which case the caller should rethrow rather than swallow it.
 */
export function groupErrorResponse(err: unknown): Response | null {
  if (err instanceof NotAMember) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (err instanceof InvalidGroupName || err instanceof InvalidEmail) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  return null;
}
