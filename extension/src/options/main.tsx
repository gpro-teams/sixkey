import { render } from "preact";
import "../ui/styles.css";
import "./base.css";
import "./options.css";
import { getLang } from "../ui/i18n";
import { applyTheme } from "../ui/theme";
import { followTheme } from "../ui/theme-set";
import { App } from "./App";
import { loadParts } from "./parts";

document.documentElement.lang = getLang() === "zh_CN" ? "zh-CN" : "en";
applyTheme(); // public/theme-boot.js already did this before the first paint; again in case that script did not run
followTheme(); // a theme chosen in the popup or the side panel shows here at once, whichever section is drawn

document.body.classList.add("options");
// No top-level await: it switches off the bundler's chunk optimisation for the whole build (+popup bytes).
// The page's core text first (parts.tsx: each part's text is loaded before that part is drawn). Only this language's,
// and it never rejects (falls back to English).
void loadParts(["core"]).then(() => render(<App />, document.getElementById("app")!));
