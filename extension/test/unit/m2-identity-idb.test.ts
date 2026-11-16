// The device identity in a real IndexedDB (fake-indexeddb), in its own database `sixkey-identity` beside the mirror's
// (SYNC-DESIGN §2.5): a CryptoKeyPair is stored and comes back usable, the private key still non-extractable; an
// IndexedDB wiped (GoLogin deletes it on every stop) reads as no identity ("identity_missing" with the copy in
// storage.local), not as a damaged one.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { bs, utf8 } from "../../src/core/crypto/bytes";
import { IdentityStore } from "../../src/core/sync/local/identity";
import { IDENTITY_DB } from "../../src/core/sync/local/keys";
import { IdbKV } from "../../src/platform/idb-kv";
import { newIdentity } from "../helpers/m2-world";

describe("the identity in IndexedDB", () => {
  it("stores the key pair in sixkey-identity, apart from the mirror; the private key signs and stays non-extractable", async () => {
    const idb = new IDBFactory();
    const ids = new IdentityStore(new IdbKV(IDENTITY_DB, idb));
    const mirror = new IdbKV("sixkey-mirror", idb);
    await mirror.set({ sk_mirror_gen: { v: 1 } });
    const { id } = await newIdentity({ state: "enrolled" });
    await ids.put(id);
    const back = await new IdentityStore(new IdbKV(IDENTITY_DB, idb)).get(); // a new context, the same database
    if (back === null || back === "damaged") throw new Error("not stored");
    expect(back.keyPair.privateKey.extractable).toBe(false);
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, back.keyPair.privateKey, bs(utf8("req")));
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, id.keyPair.publicKey, sig, bs(utf8("req"))),
    ).toBe(true);
    expect(await mirror.keys()).toEqual(["sk_mirror_gen"]); // two databases: the identity is not in the mirror's
    expect((await idb.databases()).map((d) => d.name).sort()).toEqual(["sixkey-identity", "sixkey-mirror"]);
    // IndexedDB wiped (a GoLogin stop): a new run finds no identity, which is "missing", never a damaged one
    expect(await new IdentityStore(new IdbKV(IDENTITY_DB, new IDBFactory())).get()).toBeNull();
  });
});
