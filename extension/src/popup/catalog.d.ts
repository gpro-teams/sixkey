// The popup's catalogs, virtual:popup-catalog/<lang> (src/popup/main.tsx): made by the build from the full catalog and
// the keys popup code can use (scripts/build.mjs, scripts/catalog-keys.mjs). Same shape as _locales/<lang>/messages.json.
declare module "virtual:popup-catalog/*" {
  const catalog: Record<string, { message: string }>;
  export default catalog;
}
