# 交给 M2 的说明（M2-HANDOFF）

> **History, not current.** An internal working document from 2026-10, kept for the record. It describes how
> the work was planned and split between AI coding agents, and how their patches were exchanged and merged; it is
> not a guide for contributors (see `CONTRIBUTING.md`) and its file and line references are to the tree of its date.
> Local paths were replaced with placeholders. 历史文档，不再更新；描述当时如何在多个 AI 编码代理之间分工与交接补丁，
> 不是贡献指南，文中的文件与行号对应当时的代码树。本地路径已替换为占位符。

日期：2026-10-16。性质：Phase 0.x 全部合入之后，M2（SYNC-DESIGN §9 的"存储与服务层改动"）开工时代码的确切状态。

- 以代码为准。文中的 `文件:行号` 取自 2026-10-16 的主树；路径以 `src/`、`test/`、`scripts/` 开头的都相对 `extension/`。
- `docs/SYNC-DESIGN.md` 正在被同时修改，所以只按节号引用（§0.0i、§0.0j），不引用行号。M2 的要求以 SYNC-DESIGN 原文为准；下面第 2 节只是摘要，与原文不符时以原文为准。
- 各评审文件里的行号对应评审者自己的临时副本，不一定等于主树。

**闸门**：G-M2 已满足。
- `docs/audit/internal-reviews/GM2-REVIEW.md` 列为"M2 开始前"的五项里，GM2-1(a)(b)、GM2-3、GM2-11 已由 A4 在代码里完成，GM2-4、GM2-5 已写进 SYNC-DESIGN §0.0i。
- `docs/audit/internal-reviews/A4-REVIEW.md` 要求在合入前修复的 A4R-1、A4R-2 已修（第 3 节有现状）。

---

## 1. M2 构建在哪些代码上

### 1.1 存储层：`src/core/storage/store.ts`、`format.ts`

- **`VaultStore`**（`store.ts:119`）。
  - `StoreOptions.lock` 必填（`store.ts:66`），没有默认值。
  - 生产代码只在 `src/platform/runtime.ts:23` 构造它，用 `webLock("sixkey-vault")`；测试显式传 `createMutex()`。
  - `test/unit/source-rules.test.ts` 守着这两条。
- **`transact(fn, { overwriteLost?, keyChange? })`**（`store.ts:435`）：读、改、写都在锁内。提交顺序：
  1. 需要时先写换密钥标记（`store.ts:456-460`）。需要的情况：`canonicalJson(keyring)` 有任何变化（新 VK、设备包裹消失、同一 VK 的新密码或恢复码包裹），或覆盖丢失的数据，或调用方传了 `keyChange: true`。标记写不进去，整次保存失败。
  2. 写非活动槽，读回校验。
  3. 翻指针（`store.ts:465`），这是提交点。
  4. 受保护的冗余写入：滚动快照（数据变了才写）、keyring 副本、镜像。失败只记诊断日志，不让已经成功的保存失败。
  - **FIXb**（`store.ts:472`）：keyring 变化的保存在提交前失败时，把目标槽改写成当前活动的那一代（`prev`）。
- **标记协议**（文件头 `store.ts:10-37`，不变量在 `:12`）。
  - 两个键：`sk_keychange = {v: 1, vkId, at, mirror?: true}`、`sk_store_v = {v: 2, vkId}`（`format.ts:14-16`、`:46`、`:60`）。
  - `cleanupNeeded`（`store.ts:105`）决定 `loadView`（`store.ts:161`）返回的 `cleanup`：`none`、`mirror`（只剩镜像，下次解锁再查）或 `full`。
- **`finishKeyChange(vk, reencrypt)`**（`store.ts:569`）：一个加锁步骤。
  - 活动 vkId 已不是 `vk` 时什么都不做。
  - `staleIn`（`store.ts:626`）按整份 keyring 比较。
  - 本库的读取抛错就向上传播，标记保持原样；镜像的读取错误被捕获，标记改成"只剩镜像"（`store.ts:588-595`、`:609-612`）。
  - 本库干净后写 `sk_store_v`；镜像也干净才删标记，镜像够不着就把标记改成"只剩镜像"。
  - 未知密钥下的快照（既不是当前、也不在 previous 里）先交给回调：重新加密成功就保留；打不开时，同一 vaultId 保留，另一个 vaultId 丢弃。新格式的记录永不删除。
  - **只能经服务层的唯一入口调用**（见 1.2）。
- **`rewriteForKeyChange`**（`store.ts:671`）：只剩永久删除的语义，未知密钥下的快照一律丢弃。
- **`recover()`**（`store.ts:193`）与 **FIXa2**（`store.ts:202-221`）。
  - 指针所指的槽与较新的另一槽 keyring 不同时，按未提交的密钥改动回退：用指针所指的槽，并在同一步覆盖被拒绝的那个槽（GM2-2(a)）。
  - 回退只写一行诊断日志，不产生事件（GM2-2(b) 未做）。
  - 普通保存（keyring 相同）仍按"序号最高者胜"。
- **`openVault(vk, known?)`**（`store.ts:763`）：解密层面的回退。
  - 读取失败的来源按保存计数参与比较：本地索引读不出算 `Infinity`；镜像读不出按活动槽的计数算（`store.ts:780`，A4R-3）。
  - 另一个 vaultId 的副本永远不作回退。
  - `newer_schema` 停下并抛出（`store.ts:773`、`:803`、`:813`）。
  - M2 的 previous-VK 回退扩展的就是这个循环。
- **`selfCheck()`**（`store.ts:144`）：在 SW 的 `onInstalled` / `onStartup` 运行（`src/background/sw.ts:35-36`）。其中 `restoreRedundancy`（`store.ts:273`）覆盖残留的设备密钥，不需要任何密钥。

### 1.2 服务层：`src/core/service/service.ts`

- **打开与解锁**
  - `openView()`（`:194`）是弹窗通往首屏的唯一服务调用（`src/popup/load.ts:20` 的 `loadScreen`）；列表画出之后 App 另外调用 `touch()`（`src/popup/App.tsx:42-44`）。`openVault(vk, r.gen)` 复用已经读到的 generation；`cleanup === "full"` 时才清理。
  - `unlockWithPassword` / `unlockWithRecoveryCode`（`:394`、`:398`）经 `finishUnlock`（`:428`）返回视图，弹窗不再整页重新加载；`cleanup !== "none"` 时清理。
  - 设置页仍用 `status()` + `read()`，它们也是 `test/fault/open-view-diff.test.ts` 的参照实现。
- **新库**
  - `prepareKeys(password, { vaultId? })`（`:326`）：只在内存里算 keyring（password + recovery 两个包裹，无设备密钥），不写任何存储，返回不透明句柄。
  - `create`（`:389`）、`restoreBackup`（`:816`）、`startOver`（`:891`）都经 `makeVault`（`:364`）。
  - 句柄一次性；落盘却报错的写入，用同一句柄重试时认作完成（`LANDED`）；会话写入成功之后句柄才作废。
- **唯一的清理入口 `finishKeyChanges(vk, keyring, held)`**（`:463`）。
  - 可用的旧密钥 = `held` + `keyring` 的全部 previous。
  - 先依次调用 `ServiceDeps.vkRecords`（`:68`，现在为空，M2 填 `sk_sync_cfg.enc`、`sk_prejoin`），再调用 store 的 `finishKeyChange`。
  - 解锁与打开时的 `housekeeping`（`:441`）、本页密钥改动之后的 `scrub` 都经过它。
  - **`VkRecord` 契约**（`:73-97`，A4R-4）："读、检查活动 vkId 仍是 `current`、写"是同一个 `webLock("sixkey-vault")` 临界区；从不在锁内被调用；读取错误向上传播；`unopenable` 不阻塞标记。
- **恢复码的两条路**（SYNC-DESIGN §0.0i 第 14 条）
  - 先提交后显示：`CodeDelivery = { onCode }`（`:107`）是必填参数，用在 `enableMasterPassword`（`:603`）、`rotateKey`（`:623`）、`newRecoveryCode(password, deliver)`（`:787`）上。码不作为返回值。
  - `committed()`（`:682`）的顺序：`onCode` → 安全记录 → 会话（失败只记日志，提交之后不报失败）→ 清理。
  - 先显示后提交：`prepareReset` / `commitReset`（`:730`、`:760`），界面在设置页 `src/options/Reset.tsx`。一步完成的重设已删除。
- **H3 / H6**：`verifyPassword`（`:517`，不碰会话、不写库键，只在输错时记一条安全记录）、`recordExport`（`:535`）、`clearSecurityLog(password)`（`:546`）。
- **会话**
  - `currentVk`（`:223`）与 `sessionVk`（`:245`）是有意保留的两份拷贝：改会话规则要两处一起改，`open-view-diff.test.ts` 是守卫。
  - `touch()`（`:278`）有锁竞争的前后检查（GM2-10）。
  - `updateSettings`（`:312`）在锁定模式变化时清空会话。
  - "每次都锁定"模式的 15 分钟上限 `ALWAYS_MODE_MAX_IDLE_MINUTES`（`:117`、`isSessionExpired` `:119`）只在下一次用到密钥时检查，没有定时器。
- **编辑与导入**
  - `mutate`（`:570`）。
  - `importBackup`（`:826`）：同一 vaultId 合并；不同 vaultId 按 secret + issuer + label 去重后添加。
  - `purgeForever`（`:855`）：先 `mutate`，再 `rewriteForKeyChange`，两步之间没有标记（GM2-9）。

### 1.3 安全记录：`src/core/service/security-log.ts`

- 键 `sk_security_log`，格式 `{v: 1, entries: [{at, kind}], ackAt?, failed?}`，最多 50 条（`:27-36`）。种类列表 `SECURITY_KINDS` 在 `:54`。
- 独立的锁 `sixkey-security-log`（`src/platform/runtime.ts:27`）。它从不进 `transact`，也从不读写 `sk_events`。
- 页面只拿到读接口（`securityReader`，`:217`）。清空只能经 `clearSecurityLog(password)`；确认（ack）只由弹窗解锁后的提示调用（`src/popup/notice.ts:28-29` 的 `ackNotice`，由 `src/popup/App.tsx:30-34` 调用）。
- 版本规则：读到 `v > 1` 就当作"较新版本"，不再追加（`:93`、`:149`）。M2 若加种类，就升到 v: 2，并与 YubiKey 设计的 R8 合并成一次升版。

### 1.4 设置与预设

- `Settings`（`src/core/service/types.ts:12`）由 `autoLock`、`lockOnScreenLock`、`display` 组成。`parseSettings`（`types.ts:47`）在读和写时都丢掉不认识的字段：M2 要加设置字段，必须先加在这里，否则保存看起来成功，实际会丢。
- 预设：`src/core/service/presets.ts` 的 `PRESETS`（`:11`）、`applyPreset`（`:22`）、`detectPreset`（`:28`）。"当前预设"不存储，按设置推导。
- 设置页的面板共用 `src/options/settings-store.ts` 的 `changeSettings`（`:19`）：每次改动都从存储读整份记录，一次一个。
- 主题、语言和安装来源检查的结果在 localStorage（`sk_theme`、`sk_lang`、`sk_install`），不在 `Settings` 里。

### 1.5 平台接线与读取路径

- `createRuntime({ local, session, mirror })`（`src/platform/runtime.ts:19`）可以注入 storage area，读取门槛测试走的就是这份真实接线。一个运行时里只有一个 store、一个 service，以及安全记录的读接口。
- 弹窗打开只走 `loadScreen`（`src/popup/load.ts:20`）。首帧之后的读取有两处，都写明了：每次打开时 `touch()` 读两次 `sk_settings`（GM2-16，`perf.spec.ts` 的"总共 6 次"已计入）；解锁之后、首个验证码出现之后读一次 `sk_security_log`（`src/popup/notice.ts:17`）。

---

## 2. M2 的要求（引用，不重述）

**原文**
- SYNC-DESIGN **§0.0i "M2 的存储要求" 第 1–15 条**：修订 9 汇总，修订 10 补充了第 5、8 条、新增第 12–14 条，修订 11 新增第 15 条（YubiKey 预留，见 §0.0k）。
- **§0.0j**：对应 A4、C6 的核实与决定，以及"仍要看得见的待办"。
- **§0.0f** 的 M2 要求第 1–5 条（身份记录）与第 7 条不变。
- `docs/audit/internal-reviews/GM2-REVIEW.md` 的 "M2 hand-off checklist" 中 "While building M2" 第 6–14 项。

**一行摘要**（只为便于查找，以原文为准）

| 条 | 摘要 | 现状 |
|---|---|---|
| 1 | 改变 keyring 的写入一律经 `transact`，按 `canonicalJson` 判断 | 已在代码里 |
| 2 | 不改 keyring、却会留下旧副本的写入用 `transact({keyChange: true})`：previous-VK 回退、`applyRemote` | 钩子已有，M2 用 |
| 3 | `StoreOptions.lock` 必填，只在 `runtime.ts` 构造 | 已在代码里，有 grep 测试 |
| 4 | 清理一律用 `finishKeyChange(当前 VK, 回调)`；未知密钥：同一 vaultId 保留，另一个丢弃 | 已在代码里 |
| 5 | 唯一清理入口 `finishKeyChanges`；`VkRecord` 契约（A4R-4） | 入口已有；M2 的两个记录各自要过交错测试 |
| 6 | 采用不列本机旧密钥的 keyring 时，清理只靠标记触发 | 规则 |
| 7 | `sk_store_v` 是本库的状态；镜像另有"只剩镜像"标记 | 已在代码里 |
| 8 | `openVault` 回退收集读取失败，保留镜像例外（A4R-3） | 已在代码里；M2 扩展时保留 |
| 9 | 身份记录：§0.0f 第 1–5 条，D8 两个方向 | M2 做 |
| 10 | `capPrevious` 只在没有标记时执行 | M2 做，Phase 0 本地轮换也要用 |
| 11 | 有同步时，"数据无法读取"界面先提供云端恢复 | M2 / M6 做 |
| 12 | keyring 逐字节稳定，同步状态不进 keyring | 规则，另加单元测试 |
| 13 | 永久删除也按 secret 清除另一个 vaultId 的副本（A4R-12） | M2 做 |
| 14 | 恢复码只经 `onCode` 或"先显示后提交"离开 service | 已在代码里；M2 的生成码流程一律先显示后提交 |
| 15 | YubiKey 预留：R1、R2、R3、R5、R6、R8（R4 已满足，R7 是 M5 的评审项），M2 不实现 YubiKey | 规则与测试，见第 6 节 |

**另外两条**（§0.0j）
- C6-8：子集文件每次导出都有新的随机 vaultId（`src/core/backup/subset.ts:120`），`restoreBackup` 保留它。决定是"vaultId 相同而密钥无关时，按 vaultId 不同处理"。
- 安全记录的种类以 §0.0j 的清单为准；M2 若加种类，按第 1.3 节的版本规则。

---

## 3. 评审找到的陷阱（主树当前位置）

1. **keyring 必须逐字节稳定**（`store.ts:456`）。标记、FIXa2（`store.ts:217`）和 FIXb（`store.ts:472`）都比较 `canonicalJson(keyring)`。往 keyring 里放任何随保存变化的字段，每次普通保存都会被当成换密钥：写标记、触发完整清理，指针写丢失时还会被回退（A4R-11，§0.0i 第 12 条）。
2. **`VkRecord.reencrypt` 在锁外被调用**（`service.ts:466`）。实现时拆成"先读、重新加密、过一会儿再写"，就会在较新的换密钥之后把记录留在被取代的密钥下，而且没有标记（A4R-4）。`webLock` 不可重入：M2 要加的 `afterCommit` 在锁内运行，所以清理不能从 `afterCommit` 里发起，否则死锁。
3. **提交之后的步骤不能报失败**（`service.ts:682-700`）：现有代码里，`onCode` 抛错、`startSession` 失败和清理失败都只记日志（GM2-1）。M2 新增的钉住值写入与 `afterCommit`（现在代码里还没有）照此办理。
4. **FIXa2 与另一个数据库里的身份记录**（`store.ts:202-221`）：掉电可能丢掉本地提交，而 IndexedDB 的钉住值已经写成新值（GM2-5，§0.0i 的 D8 第二个方向）。
5. **回退是静默的**（`store.ts:218` 只写诊断日志）：GM2-2(b) 的 `keychange_rolled_back` 事件与提示要在发布前补上，M2 不要依赖"回退会有事件"。
6. **`selfCheck` 会覆盖较新的镜像 generation**（`store.ts:297`，GM2-8，推迟）。M2 的 `beforeRecoveryWrite` 钩子要能看到这次写入。
7. **解密回退的读取规则**（`store.ts:776-781`、`:798`）：镜像例外只适用于镜像；本地索引读不出仍算作"可能最新"。只有较旧的副本能打开、而镜像一直抛错时，"重试"不会结束（A4R-3 的剩余情况）。
8. **永久删除两步之间没有标记**（`service.ts:859-872`，GM2-9）。另一个 vaultId 的副本还要按 secret 清除（A4R-12，§0.0i 第 13 条）。
9. **IndexedDB 一直出错时**（`store.ts:263` 先于 `:264` 抛出；`hasAnyData` 在 `:303-307` 不捕获 `mirror.keys()`）：新安装建不了库（GM2-6 / P-9，未修）。
10. **64 条上限**（`src/core/crypto/keyring.ts:125`；`rekey` 在 `keyring.ts:258` 起，不截断）：previous 已有 64 条的 keyring 再轮换会失败，什么都不写（GM2-15 / P-8）。在 transact 之前调用 `capPrevious`，而且只在没有标记时调用（§0.0i 第 10 条）。
11. **`currentVk` 与 `sessionVk` 是两份拷贝**（`service.ts:223`、`:245`）。改会话规则要两处一起改。
12. **"每次都锁定"的上限没有定时器**（`service.ts:117-124`）：打开着的设置页把 VK 留在内存里，直到下一次使用。SW 里的同步轮次必须经 `requireVk` 取密钥，不能缓存。
13. **单设备假设**：`seq` 是每个 store 自己的计数，不能跨设备比较；`recover()` 按本地 `savedAt` 排 keyring 来源（`store.ts:246-248`）；`hasAnyData` 与 `sk_store_v` 都是本库的；`sk_device`（`types.ts:84-90`）是 HLC 的平局决胜，不是同步身份（§2.5）。
14. **事件读取吞掉错误**（`store.ts:828-834`）：读失败时 `pushEvent` 会覆盖未确认的提示（GM2-14）。同步状态不要从事件推导（I12）。
15. **`transact` 的回调在跨上下文的锁内运行**（`store.ts:439`）：回调里不能联网（SYNC-DESIGN §4.6；GM2-REVIEW Q3 第 6 项与清单第 13 项）。
16. **新格式记录**：`isNewerRecord`（`format.ts:72`）的快照记录不当作损坏、不被清理删除，但仍按 10 / 7 的上限轮换出局；安全记录 `v > 1` 时停止追加（`security-log.ts:93`、`:149`）。M2 加格式时同时考虑旧版本读到它的结果。
17. **设置页的死代码**：`src/options/AddAccounts.tsx:22-30` 读取 `#add-scanned` 与 `chrome.storage.session` 的 `sk_scan_text`，已经没有写入方。`test/e2e/firstrun.spec.ts:35-36` 用它检查新安装在设主密码前不能由此添加账户。M2 不要重新启用这条转交路径。

---

## 4. 测试命令与闸门

```bash
cd extension
python3 scripts/messages.py      # 合并文案分片，中英键集合必须一致
npm run verify                   # typecheck + vitest + build + check-dist + 全部 e2e
npx vitest run test/unit/read-budget.test.ts test/unit/source-rules.test.ts
npx vitest run test/fault test/regression
```

- **读取门槛（硬门槛，M2 不得让它变红）**
  - `test/unit/read-budget.test.ts`（`BUDGET` 在 `:27`）：打开不超过 4 次、1.5 倍当前槽；解锁不超过 8 次、3 倍；快照数为 2 与 17 时结果相同；mirror 读取为 0。
  - `test/e2e/perf.spec.ts` 的 `READS`：打开到首个验证码 4 次、总共 6 次；解锁到首个验证码 8 次、总共 10 次。
  - 需要多读时，先改门槛并在同一补丁里写明理由（PHASE0X-PLAN D 第 4 条）。
- **崩溃安全的底线**
  - `test/regression/enable-crash.test.ts` 与 `test/fault/store.test.ts`：断言不变。它们已有两处机械改动：`lock: createMutex()`（GM2-11），以及 `enable-crash` 里必填的 `onCode`（`NO_PAGE`、`codeOf`，见 `test/helpers/vaults.ts:26-29`）。M2 只能做同类机械改动，并在交付报告里列出 diff。
- **其余要保持全绿的**
  - `test/fault/keychange-marker.test.ts`、`test/fault/gm2-crash-matrix.test.ts`、`test/fault/open-view-diff.test.ts`、`test/fault/security-log-crash.test.ts`；
  - `test/regression/gm2-fixes.test.ts`：其中第 839 行起是 A4R-4 的 `VkRecord` 交错测试，M2 的真实记录可以照它写；
  - `test/regression/a2-review.test.ts`、`test/regression/create-crash.test.ts`。
- **源码规则**（`test/unit/source-rules.test.ts`）
  - `new VaultStore(` 只出现在 `platform/runtime.ts`；
  - store 的 `finishKeyChange` 只有一个调用点；`rewriteForKeyChange` 只给永久删除用；
  - 生成恢复码的页面调用必须直接传 `{ onCode: setCode }`；
  - 弹窗里不做重设。
- **check-dist**：权限白名单、CSP、网络绊线、弹窗预算。M2 不改这些；网络相关的改动按 SYNC-DESIGN §7 在 M5 里做。
- **M1 区域**：`test/unit/sync-crypto-*`、`test/unit/contract-*` 照样全过。

---

## 5. 开发方式

- **仓库没有任何提交**，不要 commit。每个包一份私有副本，交回补丁，由集成者按顺序合入（PHASE0X-PLAN §0.3 的命令）。补丁先做越界 grep；集成者合入前做快照，合入后跑全量 `npm run verify`。几条道的 Chromium e2e 错开运行。
- **文案**：每个包一个分片 `scripts/i18n/<包号小写>.py`，里面可以有 `EN`、`ZH`、`OVERRIDE_EN`、`OVERRIDE_ZH`、`REMOVE`。
  - `scripts/i18n/base.py` 冻结。
  - `_locales/*/messages.json` 是生成物，不进补丁、不手改。
  - 键必须和用到它的代码在同一个包里落地：`test/unit/i18n.test.ts` 有"每个键都必须在源码里出现"的测试。
- **界面约定**
  - 新界面配新的 CSS 文件；
  - e2e 稳定选择器是契约（PHASE0X-PLAN 附录 D）；
  - `test/e2e/harness.ts` 冻结，新的辅助函数放新文件；
  - 新的常驻横幅用 `role="status"`，不用 `role="alert"`。
- **预算**：每个包报告弹窗 gz 的增量。现在是 57.4 KB，门槛 60 KB。M6 的同步界面是预算的大头，处理建议见 PHASE0X-PLAN 附录 E 的预算结论。

---

## 6. YubiKey 设计为 M2 预留的 R1–R8（待评审）

YubiKey 支持是已经决定的未来功能，目前只有设计（`docs/design/proposals/YUBIKEY-DESIGN.md`，未实现）。它的 §5.1 列出 M2 现在就要遵守的预留，写这份说明时已有 R1–R9，R9 只改文档。

- `docs/audit/internal-reviews/YUBIKEY-REVIEW.md` 第 7 节已逐条确认或修正了 R1–R8：R2 写得更严，R3 列出具体位置，R5、R6 有补充。
- SYNC-DESIGN 修订 11 已把其中的 R1、R2、R3、R5、R6、R8 写成 §0.0i 第 15 条（§0.0k），并说明 R4 已满足、R7 是 M5 的评审项。M2 以第 15 条为准。
- 设计稿本身的评审还在进行：**下表各条的状态是"待评审"（pending review）**。开工前重读 YUBIKEY-DESIGN §5.1 与 SYNC-DESIGN §0.0i 第 15 条的最新版本。

| 条 | 指向 | 一句话 |
|---|---|---|
| R1 | YUBIKEY-DESIGN §5.1；`store.ts:773`、`:803`、`:813` | `newer_schema` 停下并抛出，不当作损坏，不回退；`applyRemote` 与 previous-VK 回退同样，加故障测试 |
| R2 | §5.1 | M2 不手写 `schemaVersion: 1`，Vault 只经 `emptyVault` / `parseVault` / `mergeVaults` / `ops.ts` 构造 |
| R3 | §5.1；评审第 7 节 | 按 `secret` 判断条目身份的地方走具名函数（`entryIdentity`、`isPurged`） |
| R4 | §5.1；`src/core/sync/crypto/keybundle.ts:56` | KeyBundle 的包裹恰好是 password 与 recovery，`webauthn-prf` 永不进同步的 keyring |
| R5 | §5.1 | 保留本机键名 `sk_prf`、`sk_oath`（不放在 `sk_sync_*` 下），`vkRecords` 保持开放列表 |
| R6 | §5.1 | M3：`paused_newer` 用合成的 v2 远端做引擎测试 |
| R7 | §5.1 | M5 改 check-dist 时 `OPTIONAL_ALLOWED` 仍是单独的列表，不禁止页面里的 `connectNative` |
| R8 | §5.1；`security-log.ts:93` | 安全记录加种类时一次升到 v: 2，与 M2 的种类合并 |

---

## 7. 与 M2 有关的已知推迟项

完整列表与代码位置见 `docs/history/PLAN-zh.md` §15 的"已知推迟项"。与 M2 直接相关的：
- GM2-2(b)：发布前补上。
- GM2-8：M2 的服务器副本是更好的来源。
- GM2-9 与 A4R-12：永久删除。
- GM2-6 / P-9。
- GM2-14。
- GM2-15 / P-8：`capPrevious`。
- A4R-3 的剩余情况。
- A4R-10：会谎报写入成功的磁盘。
