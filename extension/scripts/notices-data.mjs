// The facts about third-party parts that package metadata does not carry, for scripts/notices.mjs. Everything else in
// THIRD-PARTY-NOTICES.md is read from the dependency trees. test/unit/notices.test.ts checks this file against them:
// every file named here exists in the installed package, and the Python tables name exactly the pinned packages.

/**
 * Data inside shipped npm packages whose terms differ from the package's declared licence, or whose source the package
 * does not state. `file` is relative to the package directory. `licenceUrl`: the licence's URI as the SPDX License List
 * (license-list-data 3.29.0) gives it for the licence's identifier (its seeAlso), which both licences below accept in
 * place of a copy of their text (CC BY 3.0 US section 4(a); ODC-By 1.0 section 4.2 b). `attribution`: the credit the
 * licence asks for, in the notices as written here.
 */
export const DATA_NOTES = {
  "@zxcvbn-ts/language-common": [
    {
      file: "src/diceware.json",
      what: "the EFF's wordlist eff_large_wordlist.txt for passphrases (7,776 words), as packaged by zxcvbn-ts, used by the password-strength estimate and by the settings page's passphrase generator",
      author: "Electronic Frontier Foundation (EFF)",
      source: "https://www.eff.org/dice",
      licence: "Creative Commons Attribution 3.0 United States (CC BY 3.0 US)",
      licenceUrl: "https://creativecommons.org/licenses/by/3.0/us/legalcode",
      // CC BY 3.0 US section 4(b): the author, the work (by its file name and address), and that it was changed. Only
      // what the package's file shows: no dice numbers; words out of the list's alphabetical order where a hyphen went
      // (dropdown before dropbox, tshirt before tabasco); and cheetah where only a word between yippee and yodel can sit
      attribution:
        "EFF's wordlist eff_large_wordlist.txt (https://www.eff.org/dice), by the Electronic Frontier Foundation (EFF), used under CC BY 3.0 US; zxcvbn-ts's copy drops the dice numbers, removes the hyphens from some words and replaces at least one word.",
      note: "The package declares MIT for all of its files. That covers the package's code; this word list is the EFF's and is used under the EFF's licence above, as the package provides it: the words only, without the EFF's dice numbers.",
    },
    {
      file: "src/passwords.json",
      what: "a list of common passwords",
      note: "The package does not state where this list comes from; it is distributed with the package under the package's declared licence.",
    },
  ],
  "@zxcvbn-ts/language-en": [
    {
      file: "src/commonWords.json",
      what: "English word frequencies derived from OpenSubtitles 2024 via OPUS (Helsinki-NLP)",
      source: "https://opus.nlpl.eu/datasets/OpenSubtitles",
      licence: "Open Data Commons Attribution License (ODC-BY)",
      licenceUrl: "https://opendatacommons.org/licenses/by/1.0/",
      // ODC-By 1.0 section 4.3 a: its own example notice, the database named and placed as the package's README gives it
      attribution:
        "Contains information from OpenSubtitles 2024, provided by Helsinki-NLP via OPUS (https://opus.nlpl.eu/datasets/OpenSubtitles), which is made available under the ODC Attribution License.",
      note: "The package's NOTICE.md, reproduced verbatim below as it requires, states the source and the processing.",
    },
    {
      file: "src/firstnames.json",
      what: "a list of first names",
      note: "The package does not state where this list comes from; it is distributed with the package under the package's declared licence.",
    },
    {
      file: "src/lastnames.json",
      what: "a list of last names",
      note: "The package does not state where this list comes from; it is distributed with the package under the package's declared licence.",
    },
    {
      file: "src/wikipedia.json",
      what: "a word list whose name suggests it comes from Wikipedia",
      note: "The package does not state where this list comes from; it is distributed with the package under the package's declared licence.",
    },
    {
      file: "src/wordSequences.json",
      what: "word sequences",
      note: "The package does not state where these come from; they are distributed with the package under the package's declared licence.",
    },
  ],
};

/**
 * Data the extension ships that no npm package brings: the site rules' bundle (rules/baseline.json in every build; TOTP
 * autofill Stage 3) takes groups and hosts from upstream files the repository keeps verbatim and pins
 * (rules/upstream/SOURCES.json). By source, as SOURCES.json names it: what of it the bundle holds, and whose it is.
 * scripts/notices.mjs reads the rest from the bundle and the pins (the address, the files and commit, the licence and the
 * licence file's text), and stops on a source of the bundle that this table does not describe.
 */
export const BUNDLED_DATA = {
  apple: {
    what: "the groups of sites that share one sign-in, and the sites that want the code typed after the password, from Apple's password-manager-resources",
    author: "Apple Inc.",
  },
};

/** Notes on a package as a whole, shown in the package table. */
export const PACKAGE_NOTES = {
  qr: "offered under MIT or Apache-2.0; Sixkey uses it under MIT (both texts are reproduced below)",
  "@fontsource/instrument-sans":
    "font files (latin subset) with the SIL Open Font License 1.1, whose full text the package's LICENSE holds",
  "@fontsource/martian-mono":
    "font files (latin subset) with the SIL Open Font License 1.1, whose full text the package's LICENSE holds",
};

/**
 * The sync server's Python packages: SPDX licence of each package pinned in api/server/requirements.txt (runtime) and
 * requirements-dev.txt (tests and formatting only), as the installed wheels declare it (License-Expression, else License
 * or the classifiers). `node scripts/notices.mjs --verify-python <venv>` compares this table with a virtual environment
 * made from those files. Keys are the names as pinned.
 */
export const PYTHON_RUNTIME = {
  fastapi: "MIT",
  starlette: "BSD-3-Clause",
  pydantic: "MIT",
  pydantic_core: "MIT",
  "annotated-doc": "MIT",
  "annotated-types": "MIT",
  typing_extensions: "PSF-2.0",
  "typing-inspection": "MIT",
  anyio: "MIT",
  idna: "BSD-3-Clause",
  uvicorn: "BSD-3-Clause",
  click: "BSD-3-Clause",
  h11: "MIT",
  asyncpg: "Apache-2.0",
  PyJWT: "MIT",
  cryptography: "Apache-2.0 OR BSD-3-Clause",
  cffi: "MIT-0",
  pycparser: "BSD-3-Clause",
};
export const PYTHON_DEV = {
  httpx: "BSD-3-Clause",
  httpcore: "BSD-3-Clause",
  certifi: "MPL-2.0",
  pytest: "MIT",
  pluggy: "MIT",
  iniconfig: "MIT",
  packaging: "Apache-2.0 OR BSD-2-Clause",
  Pygments: "BSD-2-Clause",
  "pytest-asyncio": "Apache-2.0",
  hypothesis: "MPL-2.0",
  sortedcontainers: "Apache-2.0",
  ruff: "MIT",
};
export const PYTHON_NOTES = {
  cryptography:
    "its binary wheels include a statically linked OpenSSL (Apache-2.0), whose notice a server image must carry too",
};
