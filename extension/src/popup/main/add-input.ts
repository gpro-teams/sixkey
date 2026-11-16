// What the "Add account" view takes in, and the words that go with it. Apart from AddMenu.tsx (the view itself, loaded on
// the first Add: docs/design/notes/QUICKVIEW-NOTES.md) because the list's paste shortcut and the empty list's hint need
// these without the view.

/** Something to add, as it was pasted, dropped, typed or scanned. Read on the confirm page (AddConfirm.tsx). */
export type AddInput = { text: string } | { images: Blob[] };

/**
 * What a paste or a drop carries: images (a screenshot of a QR code) first, else its text; null when neither. The
 * paste event's clipboardData comes with the user's own Ctrl+V, so this needs no clipboard permission.
 */
export function inputOf(dt: DataTransfer | null): AddInput | null {
  if (!dt) return null;
  const images = [...dt.files].filter((f) => f.type.startsWith("image/"));
  if (images.length) return { images };
  const text = dt.getData("text/plain");
  return text.trim() ? { text } : null;
}

/** The paste shortcut as this computer spells it. */
export const pasteKey = () => (/Mac/.test(navigator.userAgent) ? "⌘V" : "Ctrl+V");
