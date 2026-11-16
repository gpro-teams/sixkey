# Sixkey WebAuthn probe (dev only)

Stage 0 of [`docs/design/proposals/QUICK-UNLOCK.md`](../../docs/design/proposals/QUICK-UNLOCK.md). It is a tiny,
separate Chrome extension that measures, on real hardware, what Touch ID (macOS) and Windows Hello (Windows) passkeys
can do when they are called from an extension page. The design's next step depends on the answers.

It is **not** part of Sixkey: nothing in `extension/` imports it, and it is never in any Sixkey build or store package.

## What it measures

- The browser, OS and Chrome version; whether a platform authenticator is available
  (`isUserVerifyingPlatformAuthenticatorAvailable`, `getClientCapabilities` if present).
- `create()` with **this extension's own origin as the relying party** (no `rp.id`), a platform authenticator, user
  verification required, resident key "preferred", and the PRF extension with a fixed salt. Resident key, attachment
  (platform or not set) and hints (`client-device` or none) can be changed (0.1.1+), to see which save locations Chrome
  offers.
- Three `get()` calls with PRF: salt A, salt A again (by credential), salt B. A fourth button runs `get()` without a
  saved credential ID, for use after a browser restart.
- **Whether PRF works**: `prf.enabled`, whether `results.first` is present, and whether the same salt gives the same
  value and a different salt a different one.
- **Whether the passkey is synced**: the BE (backup eligible) and BS (backup state) flags of the authenticator data.
  Also the transports, the signature algorithm, the authenticator model (AAGUID), the `credProps.rk` result, the RP ID
  hash, and whether the assertion's signature verifies.
- **Whether the toolbar popup survives** the OS dialog: the page logs focus, blur, visibility and pagehide events to its
  service worker. If the popup is closed while `create()` or `get()` is waiting, the worker records that, and the next
  page shows it and puts it in the report.
- Whether `get()` works without a click (an optional checkbox starts one when the page opens).
- (0.1.2) **Whether the credential can hold a secret**:
  - **Blob tests** write a random largeBlob, read it back, and read the credBlob set at creation. Choose "credBlob +
    largeBlob" under "Blob extensions at creation" to request them, or "none" for a plain credential.
  - **Signature determinism** signs the same challenge twice and compares the results. Only lengths and SHA-256
    prefixes are reported.
- Errors verbatim (name and message).

## What it never does

- **It never prints a secret.** PRF outputs and credential IDs appear only as the first 16 hex digits of their SHA-256.
  The salts are fixed and public on purpose, so that reports from different runs can be compared.
- **It sends nothing anywhere.** The manifest's policy and every page set `connect-src 'none'`. There is no host
  permission and no content script.
- **It stores only in `chrome.storage.session`** (memory only, cleared when the browser restarts). That holds the test
  credential's ID and public key (neither is secret), the step results, the lifecycle log, and what you type under
  "What you saw". The only permission is `storage`, which `chrome.storage.session` needs.
- It creates **one test passkey per "Create" click**, named `sixkey-probe-delete-me`. A web page cannot delete a
  passkey, so delete it yourself (below).

## How to run it (English)

You need: Chrome on a MacBook with Touch ID (macOS 15 or later if possible), and Chrome on a Windows 11 PC with Windows
Hello set up, with the latest Windows updates.

1. Get this folder onto the computer (`tools/webauthn-probe/` of the repository).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (the switch in the top-right corner).
4. Click **Load unpacked** and choose the `webauthn-probe` folder.
5. Click the puzzle-piece icon in Chrome's toolbar, then the pin next to **Sixkey WebAuthn probe**.
   (Updating the probe later: replace the folder, then click the circular reload arrow on the probe's card in
   `chrome://extensions`. The extension ID stays the same.)
6. **In the toolbar popup**: click the probe's icon, then **Create test passkey**, and confirm with Touch ID or
   Windows Hello.
   - If Chrome asks where to save the passkey (iCloud Keychain, Google Password Manager, this device or Chrome profile),
     pick one and write which one under **Notes**.
   - If the popup disappears, click the icon again: the page will say whether it closed during the test.
7. Click **Run 3 get() tests**. Confirm three times.
8. Click **Open in a small window** and repeat step 7 there. If the popup could not create the passkey, create it here.
9. Click **Open in a tab** and repeat step 7.
10. Optional: tick **Start one get() by itself when this page opens**, close the popup, and click the icon again.
11. Fill in **What you saw**: the kind of dialog, and the requester name it showed.
12. Click **Copy report** and send the text.
13. Optional, restart test:
    - quit Chrome completely (macOS: Cmd+Q; Windows: close every Chrome window);
    - start it again, click the icon, and click **get() without a saved credential ID**;
    - copy the report again and send it too.

**On the Mac**, if Chrome offers more than one place to save the passkey, please run steps 6–12 once per place
(iCloud Keychain, Google Password Manager, Chrome profile / this device). Use **Clear probe data** between runs.

**On Windows**, please write the Windows version and build under **Notes** (Settings › System › About; for example
"Windows 11 25H2, build 26200.7840"). Say whether you use face, fingerprint or the Windows PIN.

## What to send back

- The copied report (JSON), one per run, from the Mac (one per save location) and from the Windows PC.
- Anything the report cannot see: whether a dialog appeared, what it said, and whether the popup vanished.

## Deleting the test passkey and the probe

- **macOS**: the Passwords app › Passkeys (on macOS 14: System Settings › Passwords). Also check
  `chrome://password-manager/passwords` in case Chrome saved it in Google Password Manager or the Chrome profile.
  Delete every entry named **sixkey-probe-delete-me**.
- **Windows**: Settings › Accounts › Passkeys. Also check `chrome://password-manager/passwords` in case it was saved in
  Google Password Manager. Delete every **sixkey-probe-delete-me**.
- Then remove the probe at `chrome://extensions` (Remove).

## How the probe itself was checked

The probe was run against Chrome's **virtual authenticator** (the DevTools Protocol `WebAuthn` domain), so a mistake in
the probe is not mistaken for a property of the hardware. That says nothing about Touch ID or Windows Hello.

```sh
# from the repository root; uses the Playwright already installed in extension/ (nothing new is installed)
nice -n 19 node tools/webauthn-probe/test/verify.mjs        # 9 scenarios, headless, a throwaway profile
nice -n 19 node --test tools/webauthn-probe/test/core.test.mjs   # RS256, DER, flags, PRF comparison
```

`verify.mjs` checks these scenarios:

- the manifest's promises;
- a PRF-capable platform authenticator: create, three gets, the discoverable get, equal and different PRF values,
  verified signatures, BE = 0, the RP ID hash equal to SHA-256 of `chrome-extension://<id>`, and no secret-looking
  string in the report;
- an authenticator without PRF;
- a synced one (BE = BS = 1);
- failed user verification;
- a page closed while `get()` waits, recorded as closed during the ceremony.
- (0.1.2) an authenticator with largeBlob and credBlob: written and read back, matched by prefix, no blob printed;
- a plain credential without blob support: reported without failing;
- signature determinism: two signatures over one challenge compared (the virtual authenticator's counter changes the
  signed bytes, so it shows the comparison works, not what a real authenticator does).

---

## 运行步骤（中文，简要）

这是一个只用于测试的小扩展，**不属于** Sixkey。它会创建一个名为 `sixkey-probe-delete-me` 的测试通行密钥。它不联网，不保存任何秘密；报告里只有 SHA-256 前缀。

1. 打开 `chrome://extensions`。
2. 打开右上角的 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择 `tools/webauthn-probe` 文件夹。
4. 点工具栏上的拼图图标，把 **Sixkey WebAuthn probe** 固定到工具栏。（以后更新探针：替换文件夹，再在 `chrome://extensions` 里点它卡片上的圆形“重新加载”箭头，扩展 ID 不变。）
5. 点它的图标（工具栏弹窗），点 **Create test passkey**，用 Touch ID 或 Windows Hello 确认。Chrome 若问存到哪里，选一个并在 **Notes** 里写下。弹窗若消失，再点一次图标，页面会说明它是否在测试中途被关掉。
6. 点 **Run 3 get() tests**，确认三次。
7. 点 **Open in a small window**，在小窗口里重复第 6 步；再点 **Open in a tab**，在标签页里重复一次。
8. 在 **What you saw** 里选出看到的对话框，填上对话框里显示的请求方名字。
9. 点 **Copy report**，把整段文字发回来。
10. 可选：完全退出 Chrome（Mac 按 Cmd+Q），重新打开后点 **get() without a saved credential ID**，再复制一次报告发回。

Mac 上如果 Chrome 提供了几个保存位置（iCloud 钥匙串、Google 密码管理器、本机或 Chrome 配置文件），请每个位置各跑一遍，中间点 **Clear probe data**。Windows 上请在 Notes 里写下 Windows 版本与内部版本号（设置 › 系统 › 系统信息）。

**用完后删除测试通行密钥**：

- Mac：在“密码”App › 通行密钥里删除；macOS 14 在“系统设置 › 密码”里删除。
- Windows：在“设置 › 帐户 › 通行密钥”里删除。
- 两边都再查一下 `chrome://password-manager/passwords`。

最后在 `chrome://extensions` 里移除这个扩展。
