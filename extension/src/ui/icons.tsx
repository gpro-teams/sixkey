// The icon set: one 24px grid, 1.75 stroke, round joins. Drawn here so nothing is fetched and nothing is an emoji.
// Every icon is decorative (aria-hidden); the control around it carries the accessible name. The icons only the settings
// page draws are in its own table (src/options/icons.tsx), drawn by this Icon from their path: this table is in the popup's
// and the side panel's counted bundles (docs/design/notes/BUDGET-NOTES.md §9).

const P = {
  search: "M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6ZM15.8 15.8 20 20",
  lock: "M6.5 10.5h11a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19v-7a1.5 1.5 0 0 1 1.5-1.5ZM8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2",
  sliders:
    "M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9M15 9.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM9 18.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  globe:
    "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM3.5 12h17M12 3.5c2.4 2.4 3.4 5.3 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.3-3.4-8.5s1-6.1 3.4-8.5Z",
  plus: "M12 5v14M5 12h14",
  back: "M14.5 6 8.5 12l6 6",
  next: "m9.5 6 6 6-6 6",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  check: "m5 12.5 4.5 4.5L19 7.5",
  clipboard:
    "M9 4.5H7.5A1.5 1.5 0 0 0 6 6v13.5A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H15M9.5 3h5a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5ZM9 11h6M9 15h4",
  scan: "M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5M8 8h3v3H8zM13 8h3v3h-3zM8 13h3v3H8zM13 13h1.5M16 13v1.5M13 16h3",
  image:
    "M5.5 4.5h13a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5ZM4 16l4.5-4.5L13 16l2-2 5 5M15.5 9.5h.01",
  keyboard:
    "M4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-9A1.5 1.5 0 0 1 4.5 6ZM7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M8 14h8",
  transfer: "M4 8.5h14.5M15 5l3.5 3.5L15 12M20 15.5H5.5M9 12l-3.5 3.5L9 19",
  shield: "M12 3.2 19 6v5.4c0 4.3-2.9 8-7 9.4-4.1-1.4-7-5.1-7-9.4V6l7-2.8Z",
  shieldCheck: "M12 3.2 19 6v5.4c0 4.3-2.9 8-7 9.4-4.1-1.4-7-5.1-7-9.4V6l7-2.8ZM8.8 12.2l2.2 2.2 4.2-4.4",
  shieldAlert: "M12 3.2 19 6v5.4c0 4.3-2.9 8-7 9.4-4.1-1.4-7-5.1-7-9.4V6l7-2.8ZM12 8v4.5M12 15.6h.01",
  key: "M8 20a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM11.2 12.3 19 4.5M16 7.5l2.5 2.5M13.6 9.9l2 2",
  clock: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 7.5V12l3 2",
  restore: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9M4.5 4.5V9H9M12 8.5V12l2.5 1.5",
  trash:
    "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7M10 11v5.5M14 11v5.5",
  download: "M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 20h14",
  upload: "M12 15.5V4.5M7.5 9 12 4.5 16.5 9M5 20h14",
  alert: "M10.3 4.6 3.1 17.5A2 2 0 0 0 4.8 20.5h14.4a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0ZM12 9.5v4M12 16.8h.01",
  info: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 11v5M12 7.8h.01",
  hash: "M9.5 4 8 20M16 4l-1.5 16M4.5 9h15M4 15h15",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  device: "M5.5 5h13A1.5 1.5 0 0 1 20 6.5V15H4V6.5A1.5 1.5 0 0 1 5.5 5ZM2.5 18.5h19M10 15l-.5 3.5M14 15l.5 3.5",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  // eyeOff, sun, moon: added once by Phase 0.x R0 for the packages that use them (hidden codes, theme); the set is then closed.
  eyeOff:
    "M10.6 5.6c.5-.07.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a16.6 16.6 0 0 1-2.2 3M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.9 0 3.6-.6 5-1.5M9.9 9.9a2.5 2.5 0 0 0 3.5 3.5M4 4l16 16",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4",
  copy: "M10 8h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1ZM15 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h4",
  x: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  // the side panel: a window with a column on its right (the popup's "Open in side panel")
  panel:
    "M5.5 4.5h13A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5ZM14.5 4.5v15",
} as const;

export type IconName = keyof typeof P;
const HEAVY = new Set<IconName>(["more", "grip"]); // dot glyphs need a fatter pen to read as dots

/** An icon of this table by its name, or one of another table (the settings page's) by its path, `d`. */
export function Icon({
  name,
  d,
  size = 16,
  class: cls,
}: ({ name: IconName; d?: undefined } | { d: string; name?: undefined }) & { size?: number; class?: string }) {
  return (
    <svg
      class={`ic${cls ? " " + cls : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={name && HEAVY.has(name) ? 3 : 1.75}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d ?? P[name!]} />
    </svg>
  );
}
