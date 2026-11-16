// Types for notices.mjs, for the test that imports it (test/unit/notices.test.ts).
export interface DataNote {
  file: string;
  what: string;
  author?: string;
  source?: string;
  licence?: string;
  licenceUrl?: string;
  /** The credit the licence asks for (notices-data.mjs). */
  attribution?: string;
  note: string;
}
export interface ShippedPackage {
  name: string;
  version: string;
  licence: string;
  note: string;
  data: DataNote[];
  texts: { file: string; text: string }[];
}
export interface Pin {
  name: string;
  version: string;
}
/** Upstream data in the site rules' bundle, by source (rules/build/baseline.json, rules/upstream/SOURCES.json). */
export interface BundledData {
  source: string;
  what: string;
  author: string;
  url: string;
  licence: string;
  files: { path: string; commit: string }[];
  licenceFile: string;
  text: string;
}
export declare const NOTICES_MD: string;
export declare function shippedPackages(): ShippedPackage[];
export declare function bundledData(): BundledData[];
export declare function devPackages(): (Pin & { licence: string })[];
export declare function pins(file: string): Pin[];
export declare function pythonPackages(): {
  runtime: (Pin & { licence: string; note: string })[];
  dev: (Pin & { licence: string; note: string })[];
};
export declare function noticesMarkdown(): string;
export declare function extensionNoticesText(): string;
