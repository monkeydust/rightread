import { prisma } from "@/lib/db";

/**
 * Sparse float ordering over a single queue.
 *
 * Moving an item sets its position to the midpoint between the two items it
 * lands between, so a reorder is a single-row write. Floats run out of
 * precision after ~50 consecutive splits in the same gap, so we renormalize
 * when a gap gets too tight.
 *
 * There is deliberately only ONE bucket. Starring used to sort an item above
 * everything else, which meant `move` could only swap within the starred set —
 * so with a single starred item, up and down had nothing to swap with and
 * silently did nothing. Starring is now just a marker; order is order.
 */
const MIN_GAP = 1e-6;

/**
 * "top" and "bottom" are supported by the API but not currently surfaced in the
 * row: a third ordering button sat away from the arrows and mostly duplicated
 * them. Worth reinstating behind an overflow menu once a queue is long enough
 * that tapping up 30 times is the alternative.
 */
type Move = "up" | "down" | "top" | "bottom";

/** The whole queue for this status, in display order. */
async function siblings(userId: string, status: string) {
  return prisma.item.findMany({
    where: { userId, status },
    orderBy: [{ position: "asc" }, { savedAt: "desc" }],
    select: { id: true, position: true },
  });
}

async function renormalize(userId: string, status: string) {
  const list = await siblings(userId, status);
  await prisma.$transaction(
    list.map((item, index) =>
      prisma.item.update({
        where: { id: item.id },
        data: { position: index * 100 },
      })
    )
  );
}

/**
 * Moves an item within its queue. Returns false if it is already at that end
 * and nothing changed.
 */
export async function moveItem(
  userId: string,
  itemId: string,
  move: Move
): Promise<boolean> {
  const item = await prisma.item.findFirst({
    where: { id: itemId, userId },
    select: { id: true, status: true },
  });
  if (!item) throw new Error("Item not found");

  const list = await siblings(userId, item.status);
  const index = list.findIndex((i) => i.id === itemId);
  if (index === -1) throw new Error("Item not found in queue");

  // The two items it should end up between.
  let before: number | null;
  let after: number | null;

  switch (move) {
    case "up":
      if (index === 0) return false;
      before = index >= 2 ? list[index - 2].position : null;
      after = list[index - 1].position;
      break;
    case "down":
      if (index === list.length - 1) return false;
      before = list[index + 1].position;
      after = index + 2 < list.length ? list[index + 2].position : null;
      break;
    case "top":
      if (index === 0) return false;
      before = null;
      after = list[0].position;
      break;
    case "bottom":
      if (index === list.length - 1) return false;
      before = list[list.length - 1].position;
      after = null;
      break;
  }

  let position: number;
  if (before === null && after === null) position = 0;
  else if (before === null) position = after! - 100;
  else if (after === null) position = before + 100;
  else position = (before + after) / 2;

  // Gap collapsed below float precision — rebuild the queue and retry once.
  if (before !== null && after !== null && Math.abs(after - before) < MIN_GAP) {
    await renormalize(userId, item.status);
    return moveItem(userId, itemId, move);
  }

  await prisma.item.update({ where: { id: itemId }, data: { position } });
  return true;
}

/**
 * Starring is a marker only — it never moves anything. Use `moveItem(…, "top")`
 * if you want the item at the front.
 */
export async function setStarred(
  userId: string,
  itemId: string,
  starred: boolean
) {
  await prisma.item.updateMany({
    where: { id: itemId, userId },
    data: { starred },
  });
}
