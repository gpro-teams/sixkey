// Which part of the settings page is shown. The page is planned in four groups (the rail), and a group in pages, its
// leaves (the row of links under the page's title, only where a group has more than one). One leaf is on the page at a
// time. The links are plain anchors, so the address bar's #hash is the choice, and the browser's Back and Forward move
// between leaves. A hash names a leaf by itself (#security-log), by its group (#accounts, the group's first leaf), by an
// older name that now lives inside a leaf (#clipboard) or by its first word (#add-scanned from the popup's Add
// menu). Everything else (#setup, #setup-restore, #reset, #install, #sync, none) names none: the page shows the default
// leaf. Nothing here rewrites the hash: parts of the page read it themselves (#add-scanned, #reset, #setup*, #install).
// No text, no browser calls: tests call it directly.

/** A group of the rail and the leaves (pages) it holds, the first being the one its own link opens. */
export type Group = { id: string; leaves: readonly string[] };

export const GROUPS: readonly Group[] = [
  { id: "accounts", leaves: ["add", "groups", "backup", "trash"] },
  { id: "security", leaves: ["security", "security-keys", "security-log", "autofill"] }, // autofill: its sites, AUTOFILL2
  { id: "appearance", leaves: ["appearance"] }, // with its Clipboard panel
  { id: "advanced", leaves: ["advanced"] },
];

/** Names that are not leaves any more: where they went (#clipboard is a panel inside a leaf). */
const MOVED: Readonly<Record<string, string>> = { clipboard: "appearance" };

/** The leaf the page opens on when the hash names none. */
export const DEFAULT_LEAF = "security";

/** Every leaf, in the rail's order. */
export const LEAVES: readonly string[] = GROUPS.flatMap((g) => g.leaves);

/** The group a leaf is in. */
export const groupOf = (leaf: string): Group | undefined => GROUPS.find((g) => g.leaves.includes(leaf));

/** The leaf a hash names (one of `leaves`), or null. */
export function leafOfHash(hash: string, leaves: readonly string[]): string | null {
  if (!hash.startsWith("#")) return null;
  const h = hash.slice(1);
  if (leaves.includes(h)) return h;
  const head = /^([a-z]+)(?:[-/]|$)/.exec(h)?.[1];
  if (head === undefined) return null;
  const group = GROUPS.find((g) => g.id === head);
  if (group) return leaves.includes(group.leaves[0]!) ? group.leaves[0]! : null; // #accounts, #security-…
  const m = MOVED[head];
  if (m !== undefined) return leaves.includes(m) ? m : null;
  return leaves.includes(head) ? head : null;
}

/**
 * The leaf chosen after the hash changed: the one it names, else none (the default shows). The page shows what the address
 * says: Back to an address that names no leaf (the first one, #install) is the default, not the leaf last shown.
 */
export const nextPicked = (hash: string, leaves: readonly string[]): string | null => leafOfHash(hash, leaves);

/** The panel inside a leaf that a hash points at (#clipboard): the page scrolls to it, as the long page did. */
export const panelOfHash = (hash: string): string | null => /^#(clipboard)(?:[-/]|$)/.exec(hash)?.[1] ?? null;
