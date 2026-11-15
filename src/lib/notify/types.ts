/**
 * The notification types this app can send — the registry.
 *
 * Adding a type is one entry here and one `notify("<id>", …)` call at the
 * place the thing happens. Nothing else changes: the Settings switch, the
 * stored preference and the delivery path all work from this list. The id is
 * stored as a plain string (`NotificationPreference.type`), so a new type
 * needs no schema change, and an id that has since been removed from here is
 * simply never asked about again.
 */

export type NotificationType = {
  /** Stored and logged. Lowercase letters and underscores; never renamed. */
  id: string;
  /** The switch's label in Settings. */
  label: string;
  /** One line under the label saying when it fires. */
  description: string;
  /** What applies until the user has chosen. */
  defaultOn: boolean;
};

export const NOTIFICATION_TYPES = [
  {
    id: "group_share",
    label: "Group shares",
    description: "When someone shares a link to a group you are in.",
    defaultOn: true,
  },
] as const satisfies readonly NotificationType[];

export type NotificationTypeId = (typeof NOTIFICATION_TYPES)[number]["id"];

export function notificationType(id: string): NotificationType | null {
  return NOTIFICATION_TYPES.find((t) => t.id === id) ?? null;
}

export function isNotificationTypeId(id: unknown): id is NotificationTypeId {
  return typeof id === "string" && notificationType(id) !== null;
}

/**
 * Whether a user wants a type: their stored choice, else the type's default.
 * An unknown type is never wanted — a stale row cannot switch something on.
 */
export function wantsType(typeId: string, stored: boolean | null | undefined): boolean {
  const type = notificationType(typeId);
  if (!type) return false;
  return typeof stored === "boolean" ? stored : type.defaultOn;
}

/** The registry with each user's resolved choice, for the Settings page. */
export function resolvePreferences(
  stored: ReadonlyArray<{ type: string; enabled: boolean }>
): Array<NotificationType & { enabled: boolean }> {
  const byType = new Map(stored.map((row) => [row.type, row.enabled]));
  return NOTIFICATION_TYPES.map((type) => ({
    ...type,
    enabled: wantsType(type.id, byType.get(type.id)),
  }));
}
