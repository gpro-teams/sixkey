// The icons only the settings page draws, on the shared set's grid and pen (src/ui/icons.tsx draws them, from their path).
// Kept out of the shared table, which the popup and the side panel count in their budgets (docs/design/notes/
// BUDGET-NOTES.md §9). Every module of the settings page takes Icon from here: it knows the shared names and these.
import { Icon as Draw, type IconName as Shared } from "../ui/icons";

const OWN = {
  link: "M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  file: "M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5l-5-5ZM13.5 3.5v5h5M9 13h6M9 16.5h4",
  moon: "M12 3.5a6 6 0 0 0 8.5 8.5 8.5 8.5 0 1 1-8.5-8.5Z",
  dice: "M6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4ZM8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01",
  enter: "M19.5 5v6.5a3 3 0 0 1-3 3H5M9 10.5l-4 4 4 4",
  pulse: "M3 12h4l2.5-6.5 5 13L17 12h4",
  archive: "M4 5h16v4H4zM5.5 9v9.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4",
  sync: "M19.5 9A8 8 0 0 0 5 7.5M4.5 4v3.5H8M4.5 15A8 8 0 0 0 19 16.5M19.5 20v-3.5H16",
} as const;

export type IconName = Shared | keyof typeof OWN;

export function Icon({ name, size, class: cls }: { name: IconName; size?: number; class?: string }) {
  return Object.hasOwn(OWN, name) ? (
    <Draw d={OWN[name as keyof typeof OWN]} size={size} class={cls} />
  ) : (
    <Draw name={name as Shared} size={size} class={cls} />
  );
}
