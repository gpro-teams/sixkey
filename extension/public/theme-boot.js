// Shipped as is, so kept short. Sets the chosen theme before the first paint: see src/ui/theme.ts.
(function () {
  try {
    var choice = localStorage.getItem("sk_theme");
    if (choice !== "light" && choice !== "dark") return;
    document.documentElement.setAttribute("data-theme", choice);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", choice);
  } catch (e) {}
})();
