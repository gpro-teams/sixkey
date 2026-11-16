// Sixkey WebAuthn probe: Stage 0 of docs/design/proposals/QUICK-UNLOCK.md (§1.5, §1.6, §8).
//
// It answers, on real hardware, the questions the design could not settle from documents:
//   - Does a platform authenticator (Touch ID / iCloud Keychain / Chrome profile / Google Password Manager on macOS,
//     Windows Hello on Windows) accept this extension's own origin as the relying party (no rp.id set)?
//   - Does the PRF extension return a value at create() and at get(), and is it stable for one salt and different for
//     another? Is the passkey synced (the BE and BS flags)? Which transports and algorithm?
//   - Does the toolbar popup survive the OS dialog? (The worker, sw.js, notices when this page goes away mid-ceremony.)
//   - Does get() need a click (user activation)?
//
// What it never does: print a secret. PRF outputs and credential IDs appear only as 16-hex-digit SHA-256 prefixes.
// It sends nothing anywhere (the policy has connect-src 'none'; there is no host permission). It stores only in
// chrome.storage.session, which the browser clears when it restarts: the test credential's ID and public key (not
// secret), the step results, the lifecycle log, and what the user typed under "What you saw".

import {
  b64u,
  checkClientData,
  errorInfo,
  fixedSalt,
  fromB64u,
  parseAuthData,
  prfConsistency,
  rpIdHashMatches,
  sha256,
  sha256Prefix,
  signatureDeterminism,
  verifyAssertion,
} from "./core.js";

const NAME = "sixkey-probe-delete-me"; // shown in the OS's passkey list, so the user finds and deletes it
const K = { cred: "probe_cred", results: "probe_results", obs: "probe_obs", auto: "probe_auto", life: "probe_life" };
const MAX_RESULTS = 60;
const TIMEOUT_MS = 120_000;

// The toolbar popup is opened by Chrome as plain probe.html; the probe's own buttons add ?ctx=window or ?ctx=tab.
const param = new URLSearchParams(location.search).get("ctx");
const CTX = param === "window" || param === "tab" ? param : "popup";
const RUN_ID = b64u(crypto.getRandomValues(new Uint8Array(9)));
const session = chrome.storage.session;
const $ = (id) => document.getElementById(id);
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

// ---- lifecycle: a port to the worker, which records it if this page dies while a ceremony is pending -------------

let port = null;
function connect() {
  port = chrome.runtime.connect({ name: JSON.stringify({ runId: RUN_ID, ctx: CTX }) });
  // Only a worker restart disconnects us while we live; reconnect, the worker counts it.
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 100);
  });
}
function life(kind, detail) {
  try {
    port?.postMessage({ kind, detail: detail ?? null });
  } catch {
    /* the worker is restarting; the next event goes through the new port */
  }
}
connect();
setInterval(() => life("ping"), 20_000); // keeps the worker awake while this page is open

let ceremony = null; // { op, focusLost, hidden } while create() or get() is pending
addEventListener("blur", () => {
  if (ceremony) ceremony.focusLost = true;
  life("blur", ceremony?.op);
});
addEventListener("focus", () => life("focus", ceremony?.op));
document.addEventListener("visibilitychange", () => {
  if (ceremony && document.visibilityState === "hidden") ceremony.hidden = true;
  life("visibilitychange", document.visibilityState);
});
addEventListener("pagehide", () => life("pagehide", ceremony?.op));
life("load", CTX);

/** Run one WebAuthn call and record what happened around it, never the secrets in it. */
async function inCeremony(op, call) {
  const ua = navigator.userActivation;
  const before = {
    userActivationAtCall: ua ? { isActive: ua.isActive, hasBeenActive: ua.hasBeenActive } : "unavailable",
    documentHadFocus: document.hasFocus(),
  };
  ceremony = { op, focusLost: false, hidden: false };
  life("ceremony-start", op);
  const t0 = performance.now();
  try {
    const value = await call();
    return { value, ...before, ms: Math.round(performance.now() - t0), ...flagsOf(ceremony) };
  } catch (e) {
    return { error: errorInfo(e), ...before, ms: Math.round(performance.now() - t0), ...flagsOf(ceremony) };
  } finally {
    ceremony = null;
    life("ceremony-end", op);
  }
}
const flagsOf = (c) => ({ focusLostDuringCeremony: c.focusLost, hiddenDuringCeremony: c.hidden });
const timing = (c) => ({
  ms: c.ms,
  userActivationAtCall: c.userActivationAtCall,
  documentHadFocus: c.documentHadFocus,
  focusLostDuringCeremony: c.focusLostDuringCeremony,
  hiddenDuringCeremony: c.hiddenDuringCeremony,
});

// ---- environment ------------------------------------------------------------------------------------------------

async function environment() {
  const uad = navigator.userAgentData;
  let highEntropy = "unavailable";
  if (uad?.getHighEntropyValues) {
    try {
      highEntropy = await uad.getHighEntropyValues([
        "architecture",
        "bitness",
        "model",
        "platformVersion",
        "fullVersionList",
      ]);
    } catch (e) {
      highEntropy = { error: errorInfo(e) };
    }
  }
  let contextTypeFromRuntime = "unavailable";
  try {
    const all = await chrome.runtime.getContexts({});
    contextTypeFromRuntime = all.find((c) => c.documentUrl === location.href)?.contextType ?? "not found";
  } catch (e) {
    contextTypeFromRuntime = { error: errorInfo(e) };
  }
  return {
    userAgent: navigator.userAgent,
    userAgentData: uad ? { brands: uad.brands, mobile: uad.mobile, platform: uad.platform } : "unavailable",
    highEntropy,
    language: navigator.language,
    extensionId: chrome.runtime.id,
    origin: location.origin,
    context: CTX,
    contextTypeFromRuntime, // "POPUP" for the real toolbar popup; "TAB" for a tab or a chrome.windows.create window
    isSecureContext,
  };
}

async function capabilities() {
  const PKC = globalThis.PublicKeyCredential;
  if (!PKC) return { publicKeyCredential: false };
  const ask = async (fn) => {
    if (typeof fn !== "function") return "absent";
    try {
      return await fn.call(PKC);
    } catch (e) {
      return { error: errorInfo(e) };
    }
  };
  const AAR = globalThis.AuthenticatorAttestationResponse?.prototype ?? {};
  return {
    publicKeyCredential: true,
    isUserVerifyingPlatformAuthenticatorAvailable: await ask(PKC.isUserVerifyingPlatformAuthenticatorAvailable),
    isConditionalMediationAvailable: await ask(PKC.isConditionalMediationAvailable),
    getClientCapabilities: await ask(PKC.getClientCapabilities),
    responseMethods: {
      getAuthenticatorData: typeof AAR.getAuthenticatorData === "function",
      getPublicKey: typeof AAR.getPublicKey === "function",
      getPublicKeyAlgorithm: typeof AAR.getPublicKeyAlgorithm === "function",
      getTransports: typeof AAR.getTransports === "function",
    },
    signalApi: typeof PKC.signalAllAcceptedCredentials === "function",
  };
}

// ---- describing results (only public facts and prefixes) ---------------------------------------------------------

async function describePrf(prf) {
  if (!prf) return { present: false };
  const first = prf.results?.first;
  return {
    present: true,
    enabled: prf.enabled ?? null,
    resultsFirstPresent: !!first,
    resultsSecondPresent: !!prf.results?.second,
    firstLength: first ? first.byteLength : null,
    firstSha256Prefix: first ? await sha256Prefix(new Uint8Array(first)) : null,
  };
}

function describeAuthData(ad) {
  if (ad.error) return ad;
  const { rpIdHash: _bytes, ...rest } = ad; // the hash itself is replaced by rpIdHashMatches
  return rest;
}

async function describeCreate(cred, challenge, credBlobPrefix) {
  const resp = cred.response;
  const rawId = new Uint8Array(cred.rawId);
  const out = {
    ok: true,
    authenticatorAttachment: cred.authenticatorAttachment ?? null,
    credentialId: { length: rawId.length, sha256Prefix: await sha256Prefix(rawId) },
    transports: typeof resp.getTransports === "function" ? resp.getTransports() : "unavailable",
    publicKeyAlgorithm: typeof resp.getPublicKeyAlgorithm === "function" ? resp.getPublicKeyAlgorithm() : "unavailable",
  };
  const spki = typeof resp.getPublicKey === "function" ? resp.getPublicKey() : null;
  out.publicKeyAvailable = spki !== null;
  if (typeof resp.getAuthenticatorData === "function") {
    const ad = parseAuthData(resp.getAuthenticatorData());
    out.authenticatorData = describeAuthData(ad);
    if (!ad.error) out.rpIdHash = await rpIdHashMatches(ad.rpIdHash, chrome.runtime.id);
  } else out.authenticatorData = "unavailable";
  out.clientData = checkClientData(resp.clientDataJSON, {
    type: "webauthn.create",
    challenge,
    origin: location.origin,
  });
  const ext = cred.getClientExtensionResults();
  out.credProps = ext.credProps ? { rk: ext.credProps.rk ?? null } : "absent";
  out.prf = await describePrf(ext.prf);
  // Blob extensions, when requested: whether the authenticator took them. Never the blob itself.
  out.credBlob = "credBlob" in ext ? { stored: ext.credBlob } : "absent";
  out.largeBlob = ext.largeBlob ? { supported: ext.largeBlob.supported ?? null } : "absent";
  // Kept for the get() tests, in session memory only. Neither the ID nor the public key is secret; of the credBlob
  // only its SHA-256 prefix is kept, to compare with what get() reads back.
  await session.set({
    [K.cred]: {
      id: b64u(rawId),
      idPrefix: out.credentialId.sha256Prefix,
      alg: out.publicKeyAlgorithm,
      spki: spki ? b64u(new Uint8Array(spki)) : null,
      createdIn: CTX,
      credBlobPrefix: credBlobPrefix ?? null,
      largeBlobWrittenPrefix: null,
    },
  });
  return out;
}

async function describeGet(cred, challenge, saved) {
  const resp = cred.response;
  const rawId = new Uint8Array(cred.rawId);
  const out = {
    ok: true,
    authenticatorAttachment: cred.authenticatorAttachment ?? null,
    credentialId: { length: rawId.length, sha256Prefix: await sha256Prefix(rawId) },
    matchesSavedCredential: saved ? b64u(rawId) === saved.id : null,
  };
  const ad = parseAuthData(resp.authenticatorData);
  out.authenticatorData = describeAuthData(ad);
  if (!ad.error) out.rpIdHash = await rpIdHashMatches(ad.rpIdHash, chrome.runtime.id);
  out.clientData = checkClientData(resp.clientDataJSON, { type: "webauthn.get", challenge, origin: location.origin });
  out.userHandle = resp.userHandle ? { present: true, length: resp.userHandle.byteLength } : { present: false };
  if (saved?.spki && out.matchesSavedCredential) {
    try {
      out.signatureVerified = await verifyAssertion({
        alg: saved.alg,
        spki: fromB64u(saved.spki),
        authData: resp.authenticatorData,
        clientDataJSON: resp.clientDataJSON,
        signature: resp.signature,
      });
    } catch (e) {
      out.signatureVerified = { error: errorInfo(e) };
    }
  } else out.signatureVerified = "not checked: no saved public key for this credential";
  // Signatures are not secret. Their prefixes, with the prefix of the signed bytes, show whether the authenticator
  // signs deterministically (the "signature determinism" test).
  const ad8 = new Uint8Array(resp.authenticatorData);
  const signed = new Uint8Array([...ad8, ...(await sha256(resp.clientDataJSON))]);
  out.signatureSha256Prefix = await sha256Prefix(new Uint8Array(resp.signature));
  out.signedDataSha256Prefix = await sha256Prefix(signed);
  out.prf = await describePrf(cred.getClientExtensionResults().prf);
  return out;
}

// ---- the tests ----------------------------------------------------------------------------------------------------

async function addResult(r) {
  const cur = (await session.get(K.results))[K.results] ?? [];
  cur.push(r);
  await session.set({ [K.results]: cur.slice(-MAX_RESULTS) });
}

const line = (r) =>
  r.ok
    ? `${r.step}${r.label ? ` ${r.label}` : ""}: ok, PRF ${r.prf?.resultsFirstPresent ? "returned" : "not returned"}` +
      `${r.authenticatorData?.flags ? `, synced (BE/BS) ${r.authenticatorData.flags.BE}/${r.authenticatorData.flags.BS}` : ""}`
    : `${r.step}${r.label ? ` ${r.label}` : ""}: ${r.error.name}: ${r.error.message}`;

async function doCreate() {
  const residentKey = $("resident").value;
  const attachment = $("attachment").value; // "" = not set: Chrome may then offer other save locations
  const hints = $("hints").value ? [$("hints").value] : [];
  const blobs = $("blobs").value === "both";
  const credBlob = blobs ? random(32) : null; // random, never printed; only its SHA-256 prefix is kept
  const challenge = random(32);
  const publicKey = {
    rp: { name: NAME }, // no rp.id on purpose: Chrome then uses this extension's origin (QUICK-UNLOCK §1.6)
    user: { id: random(16), name: NAME, displayName: NAME },
    challenge,
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: {
      ...(attachment ? { authenticatorAttachment: attachment } : {}),
      residentKey,
      requireResidentKey: residentKey === "required",
      userVerification: "required",
    },
    hints,
    attestation: "none",
    timeout: TIMEOUT_MS,
    extensions: {
      credProps: true,
      prf: { eval: { first: await fixedSalt("A") } },
      ...(blobs ? { credBlob, largeBlob: { support: "preferred" } } : {}),
    },
  };
  status("create(): waiting for Touch ID / Windows Hello…");
  const c = await inCeremony("create", () => navigator.credentials.create({ publicKey }));
  const r = {
    step: "create",
    salt: "A",
    ctx: CTX,
    runId: RUN_ID,
    at: new Date().toISOString(),
    request: {
      rpId: "(not set: the browser's default for this origin)",
      authenticatorAttachment: attachment || "(not set)",
      residentKey,
      userVerification: "required",
      prfEvalAtCreate: true,
      hints,
      blobExtensions: blobs ? "credBlob + largeBlob(preferred)" : "none",
    },
    ...timing(c),
  };
  if (c.error) Object.assign(r, { ok: false, error: c.error });
  else Object.assign(r, await describeCreate(c.value, challenge, credBlob ? await sha256Prefix(credBlob) : null));
  await addResult(r);
  return r;
}

/**
 * One get(). `extra` (optional): `challenge` to use instead of a random one, `extensions` instead of the PRF request,
 * and `describe(ext, saved)` adding fields from the extension outputs to the result.
 */
async function doGet(label, saltLabel, mode, extra = {}) {
  const saved = (await session.get(K.cred))[K.cred] ?? null;
  if (mode !== "discoverable" && !saved) {
    status("Create a test passkey first, or use “get() without a saved credential ID”.");
    return null;
  }
  const salt = saltLabel ? await fixedSalt(saltLabel) : null;
  const challenge = extra.challenge ?? random(32);
  const publicKey = {
    challenge,
    userVerification: "required",
    timeout: TIMEOUT_MS,
    hints: ["client-device"],
    allowCredentials: mode === "discoverable" ? [] : [{ type: "public-key", id: fromB64u(saved.id) }],
    extensions: extra.extensions ?? {
      prf:
        mode === "evalByCredential" ? { evalByCredential: { [saved.id]: { first: salt } } } : { eval: { first: salt } },
    },
  };
  status(`get() ${label}: waiting for Touch ID / Windows Hello…`);
  const c = await inCeremony(`get:${label}`, () => navigator.credentials.get({ publicKey }));
  const r = {
    step: "get",
    label,
    salt: saltLabel,
    mode,
    ctx: CTX,
    runId: RUN_ID,
    at: new Date().toISOString(),
    request: { userVerification: "required", allowCredentials: mode === "discoverable" ? 0 : 1, prf: mode },
    ...timing(c),
  };
  if (c.error) Object.assign(r, { ok: false, error: c.error });
  else {
    Object.assign(r, await describeGet(c.value, challenge, saved));
    if (extra.describe) Object.assign(r, await extra.describe(c.value.getClientExtensionResults(), saved));
  }
  await addResult(r);
  return r;
}

const savedCred = async () => (await session.get(K.cred))[K.cred] ?? null;

/**
 * Can the credential carry a secret the authenticator releases only after user verification? largeBlob (WebAuthn L2)
 * and credBlob (CTAP 2.1, exposed by Chromium as credBlob / getCredBlob) are the two candidates. Three touches: write a
 * random largeBlob, read it back, read the credBlob set at creation (if any). Blobs never leave this function; only
 * lengths, SHA-256 prefixes and whether they match are recorded.
 */
async function runBlobTests() {
  if (!(await savedCred())) return status("Create a test passkey first.");
  const written = random(32);
  const writtenPrefix = await sha256Prefix(written);
  const steps = [
    [
      "LB-write",
      { largeBlob: { write: written } },
      async (ext) => {
        const ok = ext.largeBlob?.written === true;
        if (ok) await session.set({ [K.cred]: { ...(await savedCred()), largeBlobWrittenPrefix: writtenPrefix } });
        return { largeBlob: ext.largeBlob ? { written: ext.largeBlob.written ?? null } : "absent" };
      },
    ],
    [
      "LB-read",
      { largeBlob: { read: true } },
      async (ext, saved) => {
        const blob = ext.largeBlob?.blob;
        if (!ext.largeBlob) return { largeBlob: "absent" };
        if (!blob) return { largeBlob: { blobPresent: false } };
        const p = await sha256Prefix(new Uint8Array(blob));
        return {
          largeBlob: {
            blobPresent: true,
            length: blob.byteLength,
            sha256Prefix: p,
            equalsWritten: saved?.largeBlobWrittenPrefix ? p === saved.largeBlobWrittenPrefix : null,
          },
        };
      },
    ],
    [
      "CB-read",
      { getCredBlob: true },
      async (ext, saved) => {
        const v = ext.getCredBlob;
        if (v === undefined) return { credBlob: "absent" };
        const p = v.byteLength ? await sha256Prefix(new Uint8Array(v)) : null;
        return {
          credBlob: {
            length: v.byteLength,
            sha256Prefix: p,
            equalsCreateValue: saved?.credBlobPrefix ? p === saved.credBlobPrefix : null,
          },
        };
      },
    ],
  ];
  const done = [];
  for (const [label, extensions, describe] of steps) {
    const r = await doGet(label, null, "blob", { extensions, describe });
    done.push(r.ok ? `${label}: ok` : `${label}: ${r.error.name}`);
    if (!r.ok && r.error.name === "NotAllowedError") break; // cancelled: do not ask for the next touch
  }
  status(`blob tests: ${done.join(" · ")}`);
}

/** Two assertions over the same challenge. Equal signatures over equal signed bytes would mean deterministic signing. */
async function runSignatureDeterminism() {
  if (!(await savedCred())) return status("Create a test passkey first.");
  const challenge = await sha256(new TextEncoder().encode("sixkey-probe/fixed-challenge/v1"));
  const done = [];
  for (const label of ["SIG1", "SIG2"]) {
    const r = await doGet(label, null, "signature", { challenge, extensions: {} });
    done.push(r.ok ? `${label}: ok` : `${label}: ${r.error.name}`);
    if (!r.ok) break;
  }
  status(`signature determinism: ${done.join(" · ")}`);
}

async function runGets() {
  const done = [];
  for (const [label, salt, mode] of [
    ["A1", "A", "eval"],
    ["A2", "A", "evalByCredential"],
    ["B1", "B", "eval"],
  ]) {
    const r = await doGet(label, salt, mode);
    if (!r) return;
    done.push(line(r));
    if (!r.ok) break; // a cancel or a failure: do not ask for the next touch
  }
  status(done.join(" · "));
}

// ---- report -------------------------------------------------------------------------------------------------------

let env = null;
let caps = null;

function lifeSummary(run) {
  const start = [...run.events]
    .reverse()
    .find((e) => e.kind === "ceremony-start" && e.detail === run.closedDuringCeremony);
  return {
    runId: run.runId,
    ctx: run.ctx,
    current: run.runId === RUN_ID,
    connections: run.connections,
    closedDuringCeremony: run.closedDuringCeremony ?? null,
    msFromCeremonyStartToClose: start && run.disconnectedAt ? run.disconnectedAt - start.at : null,
    events: run.events.map((e) => ({ kind: e.kind, detail: e.detail, t: e.at - run.connectedAt })),
  };
}

async function buildReport() {
  const s = await session.get([K.results, K.life, K.obs, K.cred]);
  const results = s[K.results] ?? [];
  const saved = s[K.cred];
  return {
    probe: "sixkey-webauthn-probe",
    probeVersion: chrome.runtime.getManifest().version,
    purpose: "Stage 0 of docs/design/proposals/QUICK-UNLOCK.md",
    reportedAt: new Date().toISOString(),
    reportedFrom: CTX,
    environment: env,
    capabilities: caps,
    observations: s[K.obs] ?? {},
    savedCredential: saved
      ? { idSha256Prefix: saved.idPrefix, publicKeyAlgorithm: saved.alg, createdIn: saved.createdIn }
      : null,
    results,
    prfConsistency: prfConsistency(results),
    signatureDeterminism: signatureDeterminism(results),
    lifecycle: (s[K.life]?.runs ?? []).map(lifeSummary),
    privacy:
      "No secret is in this report: PRF outputs, blobs and credential IDs appear only as 16-hex-digit SHA-256 prefixes. " +
      "The user-agent, extension ID and authenticator model (AAGUID) are included on purpose.",
  };
}

async function render() {
  $("report").value = JSON.stringify(await buildReport(), null, 2);
}

async function showPrevious() {
  const runs = ((await session.get(K.life))[K.life]?.runs ?? []).filter((r) => r.runId !== RUN_ID);
  const closed = runs.filter((r) => r.closedDuringCeremony).map(lifeSummary);
  if (!closed.length) return;
  const last = closed[closed.length - 1];
  $("previous").hidden = false;
  $("previous").textContent =
    `Earlier: a page (${last.ctx}) went away while ${last.closedDuringCeremony} was waiting` +
    (last.msFromCeremonyStartToClose !== null ? `, ${last.msFromCeremonyStartToClose} ms after it started.` : ".") +
    " It is in the report under lifecycle.";
}

// ---- page wiring --------------------------------------------------------------------------------------------------

function status(text) {
  $("status").textContent = text;
}

const buttons = ["create", "gets", "discoverable", "blobtests", "sigdet", "window", "tab", "copy", "clear"];
async function guarded(fn) {
  document.body.dataset.busy = "1"; // read by test/verify.mjs: the report is current once this is "0" again
  buttons.forEach((id) => ($(id).disabled = true));
  try {
    await fn();
  } catch (e) {
    const { name, message } = errorInfo(e);
    status(`Probe error: ${name}: ${message}`);
  } finally {
    buttons.forEach((id) => ($(id).disabled = false));
    await render();
    document.body.dataset.busy = "0";
  }
}

async function saveObservations() {
  await session.set({
    [K.obs]: { dialog: $("dialog").value, requesterName: $("requester").value, notes: $("notes").value },
  });
  await render();
}

async function copyReport() {
  await render();
  const text = $("report").value;
  try {
    await navigator.clipboard.writeText(text);
    status("Report copied.");
  } catch {
    $("report").focus();
    $("report").select();
    status(document.execCommand("copy") ? "Report copied." : "Select the report text and copy it by hand.");
  }
}

async function init() {
  $("ctx").textContent = CTX;
  const s = await session.get([K.obs, K.auto]);
  const obs = s[K.obs] ?? {};
  $("dialog").value = obs.dialog ?? "";
  $("requester").value = obs.requesterName ?? "";
  $("notes").value = obs.notes ?? "";
  $("auto").checked = s[K.auto] === true;

  $("create").addEventListener("click", () => guarded(async () => status(line(await doCreate()))));
  $("gets").addEventListener("click", () => guarded(runGets));
  $("blobtests").addEventListener("click", () => guarded(runBlobTests));
  $("sigdet").addEventListener("click", () => guarded(runSignatureDeterminism));
  $("discoverable").addEventListener("click", () =>
    guarded(async () => {
      const r = await doGet("D1", "A", "discoverable");
      if (r) status(line(r));
    }),
  );
  $("window").addEventListener("click", () =>
    guarded(() =>
      chrome.windows.create({
        url: chrome.runtime.getURL("probe.html?ctx=window"),
        type: "popup",
        width: 460,
        height: 780,
      }),
    ),
  );
  $("tab").addEventListener("click", () =>
    guarded(() => chrome.tabs.create({ url: chrome.runtime.getURL("probe.html?ctx=tab") })),
  );
  $("copy").addEventListener("click", () => guarded(copyReport));
  $("clear").addEventListener("click", () =>
    guarded(async () => {
      await session.clear();
      // The worker's log of this page went with it: reconnect so this page is logged again from now on.
      port?.disconnect();
      connect();
      $("previous").hidden = true;
      status("Probe data cleared. The test passkey itself is still in your OS: delete it as described below.");
    }),
  );
  $("auto").addEventListener("change", () => session.set({ [K.auto]: $("auto").checked }));
  for (const id of ["dialog", "requester", "notes"]) $(id).addEventListener("change", () => void saveObservations());

  [env, caps] = await Promise.all([environment(), capabilities()]);
  await showPrevious();
  await render();
  const uvpaa = caps.isUserVerifyingPlatformAuthenticatorAvailable;
  status(
    `Ready (${CTX}). Platform authenticator available: ${typeof uvpaa === "boolean" ? uvpaa : JSON.stringify(uvpaa)}.`,
  );

  // Optional: one get() with no click at all, to learn whether Chrome needs user activation for it.
  if ($("auto").checked && (await session.get(K.cred))[K.cred]) {
    setTimeout(
      () =>
        void guarded(async () => {
          const r = await doGet("auto", "A", "eval");
          if (r) status(`(started without a click) ${line(r)}`);
        }),
      600,
    );
  }
}

void init();
