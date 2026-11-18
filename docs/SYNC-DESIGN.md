# Sixkey Phase 1 同步设计（SYNC-DESIGN）

> 状态：设计草案（DRAFT）。M0–M6 已按本设计实现并有测试；2026-11-17 起服务器同步搁置（OWNER-DECISIONS/25）：设置页的"同步"一节、开发者同步页和发布开关 `SYNC_UI_IN_STORE_BUILD` 已从所有版本中删除，任何版本都不能开启同步；随后（DV-0b）扩展里的同步客户端也已删除：引擎（`extension/src/core/sync/`）、后台的同步、桥、传输、API origin 及其 host 权限，需要时可从历史中找回；服务器（`api/`）与契约向量保留，留给可能的付费云。下文作为记录保留原样，其中说到扩展客户端的地方都是删除前的样子，不含实现代码。
> 修订 2：已按独立评审 `docs/audit/internal-reviews/SYNC-DESIGN-REVIEW.md`（2026-10-15，27 条）修订，逐条处理见 §0.0。
> 修订 3：已并入指纹浏览器调研 `docs/research/fingerprint-browser-security-lessons.md`，见 §0.0b；不做的事见 §13。
> 修订 4：已按最终评审 `docs/audit/internal-reviews/SYNC-DESIGN-FINAL-REVIEW.md`（30 条，结论"修完即可实施"）修订，见 §0.0c。
> 修订 5：已按 M0 实现中发现的问题 `contract/M0-NOTES.md`（N1–N26）修订，见 §0.0d；契约与向量需按 §0.0d 的"契约改动"一栏重新同步。
> 修订 6：已按 M0 重新同步时发现的 N27–N29 修订，见 §0.0e。
> 修订 7：已按 M1 代码评审 `docs/audit/internal-reviews/M1-REVIEW.md` 与实现说明 `docs/design/notes/M1-NOTES.md` 中属于规格的部分修订，见 §0.0f；并记入所有者 2026-10-16 的决定（AI 代理、体验调研、Phase 0.x），见 §0.0g。
> 修订 8：已按 M1 实现说明的 M1-16–M1-20 与 A2（U1b）换密钥标记的实现修订，见 §0.0h。
> 修订 9：已按 G-M2 评审 `docs/audit/internal-reviews/GM2-REVIEW.md` 中属于设计的 GM2-4、GM2-5 修订，并把 GM2-7、GM2-11 记为 M2 要求，见 §0.0i。
> 修订 10：已按 A4 评审 `docs/audit/internal-reviews/A4-REVIEW.md`、C6 评审的 C6-8 与 M2 交接，补充 §0.0i 的 M2 要求（第 5、8 条，新增第 12–14 条）并记下待办，见 §0.0j。
> 修订 11：已按 YubiKey 设计评审 `docs/audit/internal-reviews/YUBIKEY-REVIEW.md` §7 改正 schemaVersion 的说法，并记下 M2 要做的预留（不实现 YubiKey），见 §0.0k。
> 修订 12：已按 M2 评审 `docs/audit/internal-reviews/M2-REVIEW.md` 修订：applyRemote 不写换密钥标记；`commitKeys` 只接受 M1 的能力对象并自查；钉住值随提交补齐；吊销不被 `needs_adoption` 挡住。见 §0.0l。
> 修订 13：已按合入主线的 M2 与 `docs/design/notes/M2-NOTES.md` 修订：第 18 条的规则、M2 新增的格式与错误码、第一次上传的本地部分、入网对身份的要求，以及未做与部分完成的项。见 §0.0m。
> 修订 14：已按 M2-FIX2（`docs/audit/internal-reviews/M2-REREVIEW.md`、`docs/design/notes/M2-NOTES.md` §4.2、§7、§8.4、§9）修订：第一次上传的读取与检查、RR-6 的残余（所有者委托：接受）、新格式、`cfg_missing` 的规则、M5 的发布约束。见 §0.0n。
> 修订 15：已按 M4 后端评审 `docs/audit/internal-reviews/M4-REVIEW.md` 与 `docs/design/notes/M4-NOTES.md`（A1–A30）修订：重放残余（所有者委托：不加 nonce 缓存）、M4 的偏离、逐条 A 项的决定、M8 上线核对清单。见 §0.0o。
> 修订 16：已按 M4 修复轮（`docs/design/notes/M4-NOTES.md` §9、§10）修订：服务器选定的限额、第二个迁移、请求签名时间的要求、记录的残余与不做的项、14 项的 M8 清单。见 §0.0p。
> 修订 17：已按 M4 修复轮的复审 `docs/audit/internal-reviews/M4-REREVIEW.md` 修订：未经认证即可锁住某个邮箱的 OTP（RR6，所有者委托：Phase 1 接受并写明）、不得直接暴露 uvicorn（RR5）、全局大正文槽位（RR2）、M8 清单的更正，以及几处待 M4 清理的差异（占位）。见 §0.0q。
> 修订 18：已按 M4 清理轮（`docs/design/notes/M4-NOTES.md` §10、§11）把"待 M4 清理"的占位换成最终规则：字节预算（init 按会话计）、按整个请求正文计、OTP 计数表满时 429、`Content-Type` 恰好按 §5.4、0002 的后置条件；并对 A21 作出决定。见 §0.0r。
> 修订 19：已按 M3 复审 `docs/audit/internal-reviews/M3-REREVIEW.md` 修订：D1 改为恢复时保留 outbox 为**孤儿**（M3RR-3，所有者委托决定），以及轮换的对账（M3RR-1）、退避（M3RR-2）、密钥操作取同步锁（M3RR-4）、发送时检查最低版本（M3RR-5）、服务器时差不被重置（M3RR-9）、PITR 恢复栅栏（M3RR-13）。见 §0.0s。
> 修订 20：已按 M3 第三次评审（M3-R3-REVIEW）修订孤儿 outbox：未确认的 outbox 降为孤儿而绝不丢弃（R3R-1）；`lastSynced` 为空时写只用于合并的 outbox，孤儿改为列表（R3R-5）；暂时读不了的条目搁置而不阻塞同步、也不随关闭同步删除（R3R-2、R3R-4）；`vault_lost`（R3R-3）；撤销入网时的守卫回答（R3R-6）。见 §0.0t。
> 修订 21：已按 M5 评审（M5-REVIEW，"Release order" 与 D-1、M-1）修订：API origin 改为**可选** host 权限，在开启同步时请求、关闭时移除；生产环境的服务器不再返回 CORS；每个扩展页面带 `connect-src 'none'`。见 §0.0u。
> 修订 22：已按 M5 第二版的两处更正修订：谁给请求签名（页面签自己的请求，SW 只转发），以及权限检查排在一轮的本机停止之后。见 §0.0v。
> 修订 23：已按 M5 第二版评审的 L-r2-2 更正三处说得过头的地方（没有授权时能发出什么、暂停时本机改动什么、设备密钥能否取回），并记下 M6 移除权限的规则。见 §0.0w。
> 修订 24：已按 M6 第一阶段的实现说明（M6A-r2-NOTES §6、§11、§12）修订，让设计写明产品将做的事：popup 不放同步屏幕、开启的顺序、可当场改正的错误、锁定结束流程、权限不变式、开闸前必须完成的项、第二阶段的模块拆分、批准入网后的去重，以及另一个库的搁置条目不自动删除。见 §0.0x。
> 修订 25：已按合入主线的 M6 第二阶段（`docs/design/notes/M6-NOTES.md` §12、§13，尤其 §13.5 第 12–14 条）修订："丢失或被盗"的吊销顺序与"欠一次轮换"的记录、吊销前唯一的等待（`needs_adoption`）、`sk_prejoin` 改为列表、采用表单里输错的密码照常记录、锁定页的"用服务器上的密码解锁"与 P2 的措辞，以及刷新后的开闸前清单。见 §0.0y。
> 修订 26：已按合入主线的 M6C（`docs/design/notes/M6C-NOTES.md` §1–§3、§8、§9）修订：`server_older_key` 的修复、"找回账户"（O13）、批准入网后的去重、两处行为说明，以及开闸前清单。见 §0.0z。
> 修订 27：按 `docs/design/proposals/PQ-READINESS.md`（维护者受所有者委托批准）修订，防范"先录下、以后用量子计算机解密"：批准入网加入 128 bit 的**配对码**，Sixkey 从不发送它，它混入入网密钥的派生；6 位 SAS 保留，确认码 CC 删除；另加算法与版本标识（crypto-agility）、M8 的混合 TLS 检查、将来后量子迁移的规则与对外措辞。见 §0.0aa。

## 0.0 修订记录（评审意见 → 本次改动）

原则（所有者约束）：功能做到位，但不复杂；能靠**删掉或简化**机制解决的，就不加新机制。

**本次删掉的机制**：`"sync"` 快照类型（及其格式变更和降级说明）；`lastSyncedSeq` 与 `localKver`；`unlock-sensitive` 接口；§3.5 的"你是否输入了 SAS"是非题（被确认码取代）；守卫里的百分比阈值；两步式账户删除；"只在网络失败时才写 outbox"的特例；收到 401/403 就删除设备身份；评审建议的 `op_id` 列与"已吊销 VK 列表"（都用更少的部件达到同样效果，见下）。
**本次新增的机制**：入网确认码 CC（F1）；写入证明 `write_proof`（F6，比评审方案更简单的对称版）；云端头版本无法解密时回溯历史（F6a）；按设备的限流与"暂停入网 24 小时"（F8）。

| 编号 | 处理 | 改动 / 理由 | 位置 |
|---|---|---|---|
| F1 | 接受（MUST） | 新增 A→N 确认码 CC：A 在 SAS 正确且 approve 被接受后显示 `CC(h)`，N 必须让用户输入并与自己按固定的 h 算出的 CC 一致，之前不以任何方式使用载荷。删掉 §3.5 的是非题。抢注由"答对一个问题"变成"攻击者需要在线下骗到确认码"。改正"两边各只有一次"的说法。 | §2.2、§3.2、§3.5、§1.2、§8.1 |
| F2 | 接受，简化 | 不加 `op_id` 列：每次提交的 bundle 含新随机 salt/IV，**bundle 原文本身就是唯一的操作标识**。服务器：`if_kver` 落后一步且已存 bundle 与提交的逐字节相同 → 返回 200（幂等）。客户端：网络错误 / 5xx / 超时 / 409 时先 `GET /v1/keys` 对比原文，再下结论；对账完成前绝不说"新码无效"。不加"待确认操作"标记：bundle 自带 `by`/`at`，设备认得出自己写的那一份。 | §3.6.0 |
| F3 | 接受，简化 | 去掉 seq，只用 `lastSynced = {version, checksum}`：`dirty ⇔ 当前 envelope 校验和 ≠ lastSynced.checksum`。任何存储恢复事件、入网、云端恢复都把 `lastSynced` 置空，强制完整拉取 + 合并。 | §4.1 |
| F4 | 接受 | 服务器 version 只要**不等于** lastSynced.version 就拉取；`base` = 本轮实际看到的头版本；`st.version < maxSeenVersion` 时告警后照常合并。 | §4.2 |
| F5 | 接受 | 同步开启时 HLC 用服务器校正时间；合并前本地与远端用同一 `refNow` 夹紧；"是否上传"与**原始**远端比较。 | §4.2、§4.14 |
| F6 | 部分接受 | (a) 接受：头版本解不开时回溯历史找最新可解的版本合并后再上传。(c) 接受但简化：`K_write = HKDF(VK, "vault-write")` 交给服务器保存，每次写入带 `HMAC(K_write, vaultId‖if_version‖校验和)`。不需要评审方案里的 ECDSA 密钥对和 PKCS8 存储；只持有设备签名密钥（锁定的配置文件副本）的人无法写入。(b) 不接受：每个历史版本记录写入设备 = 每台设备 30 天的活动日志，违背 D3；有了写入证明后也不再需要。(d) 接受：改写 A3。 | §2.2、§4.3、§5.3、§1.2 |
| F7 | 接受，简化 | 在 IDB 身份记录里**只钉住当前 vkId**（不需要已吊销 VK 列表）：不同 vkId 的 bundle 必须能证明连续性（其 previous 能解出钉住的 vkId），否则拒绝——旧 VK 天然通不过。判断用 (vkId, kver) 而非只看 kver。 | §2.5、§3.9、§4.13 |
| F8 | 接受 | 设备认证的操作按设备限流，账户级只设很高的上限；被 401/403/423 拒绝的请求不消耗账户额度；吊销与轮换不受账户级上限；每个账户会话最多 1 个待处理入网请求；已入网设备可"拒绝全部并暂停 24 小时"；OTP 按（邮箱, IP-HMAC）限流，单邮箱全局上限调高。 | §5.5、§5.4 |
| F9 | 接受 | `respond` 需要 `pw_auth`（M2 本来就要求重输密码，无额外操作）。A 显示"已由设备 X 处理"。 | §3.2、§5.4 |
| F10 | 接受，统一 | 两条入网路径（批准、恢复码）统一为：**先写本地，再 `complete`，`complete` 时才建设备行**。恢复码入网也改成这样。"本机 vaultId 与云端不同"不再提示"联系支持"，而是提供"以云端为准重新加入"。 | §3.2、§3.3、§3.5 |
| F11 | 接受，用删除解决 | 删掉 `"sync"` 快照类型：每次有变化的提交本来就会把新 generation 存成 rolling 快照，所以"合并前的状态"已经是最新的 rolling 快照；`applyRemote` 只需确保它确实存在（`transact` 的 `ensureCurrentSnapshot` 选项）。无格式变更、无降级问题。 | §3.13、§4.4、§4.6 |
| F12 | 接受，简化 | 删除账户只调用 Supabase 删除 auth 用户，依靠全部外键 `on delete cascade` 一步清空；失败可原样重试。 | §5.7 |
| F13 | 接受 | (a) 改正"其他设备快照中 ≤7 天"：rolling 快照按次数轮换，安静的设备可能长期保留。(b) 改正"旧密码包裹随即消失"：服务商备份窗口内仍在；改密码对话框加"担心旧密码泄露：同时轮换密钥"。(c) 历史版本与设备时间戳精度降到小时。 | §3.6、§4.4、§5.3、§7 |
| F14 | 部分接受 | 删除 `unlock-sensitive` 接口（诚实客户端不会触发设备锁，锁定的设备只能吊销后重新入网），失败计数改为"先原子加一再校验"，改正"改名幂等"的说法。不接受评审建议的"请求绑定 ECDSA 认证密钥"：多一对密钥和加密存储，而 `pw_auth` 必须配合有效的设备签名才能用，请求体从不记录日志；残余写入 §10。改名重放只能撤销一次更新的改名，无安全影响，接受为残余。 | §3.14、§1.2、§5.2 |
| F15 | 部分接受；墓碑回收转为 Q9 | 条目数上限只在**新增**时检查（非清除条目 ≤5000），解析上限提高到 50 000，合并不会因条目数失败。超出字节上限的合并结果照样在本地提交，只暂停上传（`too_large`），可清理恢复。墓碑回收与 PLAN 3【已决】"墓碑永久保留"冲突，列为 Q9。 | §3.13、§4.3、§11 |
| F16 | 接受，改法不同 | 去掉百分比阈值。阻塞确认只在两种情况：本机仍存活的条目被远端永久清除（跳过了本机回收站），或 secret 被改。普通删除不阻塞：它们进本机回收站，可恢复；≥3 条时给出非阻塞提示。永久清除可从服务器历史或本机快照"找回"。 | §4.4 |
| P1 | 接受 | 钉住规则写成 §3.2 的 MUST；§8.1 加入对应对抗策略。不采纳"服务器重算 h"：客户端测试已覆盖，不必再加一个服务器部件。 | §3.2、§8.1 |
| P2 | 接受，删除 `localKver` | "已采用"按内容判定（本地 keyring 与 bundle.keyring 的 canonical JSON 相同）；先写 keyring 再更新钉住值；本地解锁失败时总会尝试服务器当前 bundle。 | §3.9 |
| P3 | 接受 | 新 bundle 的 previous 必须包含本地 previous（自身 64 条上限的回收除外）；`auth` 只能随密码包裹一起变。 | §3.9 |
| P4 | 接受 | 服务器无钥核对：恢复码包裹变 ⇔ 新 `recovery_verifier`；密码包裹变 ⇔ `auth.kdf` 变 ⇔ 新 `password_verifier`。 | §2.3 |
| P5 | 接受 | 401/403 时不删除身份：标记 `rejected_by_server`、停止同步、每天重试一次，由用户确认后才移除。 | §3.10 |
| P6 | 接受 | 写事务内再查一次 `revoked_at`；入网请求的每条 UPDATE 带 `expires_at > now()`；先验签再回答"已吊销"。 | §5.2、§5.3 |
| P7 | 接受 | 写库前在应用层校验；驱动异常只映射为错误码、从不记录原文；Postgres `log_error_verbosity = terse`（M8 由所有者在 Supabase 设置）。 | §5.6 |
| P8 | 接受 | A4 改为"对已采用 VK2 的设备"。 | §1.2 |
| P9 | 接受 | 批准、轮换前必须先处于服务器当前 vkId 并验证过最新 bundle（§3.14 的发送前检查自然做到），否则先走 R3。 | §3.2、§3.14 |
| P10 | 接受，统一 | 同步开启时**每次本地提交后都写 outbox**（不再只在网络失败时写），推送路径只有一条。写入证明把 outbox 绑定在这一次写入上，存盘无害。 | §4.7 |
| P11 | 接受（10 小项） | envelope 以 JSON 字符串原文传输与存储；bundle 以原文存储（不用 jsonb）；固定 dpk = SPKI DER、epk = 65 字节未压缩点；签名里的 host 用配置值、路径用原始请求目标；账户会话请求的签名输入加入 JWT `sub`；设备名明文补齐到固定 160 字节；同 vaultId 不同 VK 的入网用 `mergeVaults`；首台设备遇到 `vault_exists` 时提示刚生成的恢复码对云端库无效；前向兼容规则（新增字段必须升 schemaVersion）；邀请码复制后走剪贴板清空，并写入防诈骗文案（邀请码随后被所有者决定暂不做，见 §0.0b）。未采纳 Part D 的"把 sub 加入 T"：CC 已关闭跨账户错接，且 A 无法可靠得知 sub。 | 各处 |

统计：完全接受 24 条（其中 F2、F3、F7、F10、F11、F12、F16、P2、P10 用更简单的形式实现），部分接受 3 条（F6、F14、F15），整条拒绝 0 条；推迟给所有者 1 项（F15 的墓碑回收 → Q9）。

## 0.0b 修订 3：并入指纹浏览器调研

所有者方向："安全/隐私功能做到位但不复杂；学这些浏览器怎么处理安全与隐私，不学商业模式"，"按推荐走"。以下编号对应调研报告（d = 对本设计的建议，F = 候选功能；为免与评审编号混淆，下文写作"调研 F1"等）。

**本次删掉的机制**：邀请码（所有者 2026-10-15 决定暂不做：原 §3.4 协议、`invites` 表、3 个端点、限流项、HKDF 标签与界面入口全部删除）；被吊销设备上的"抹掉本机数据"按钮（卸载扩展效果相同，见 §13）；`DeviceIdentity` 里的明文邮箱；"IDB 身份库比 storage.local 更持久"这一假设及其上的单一恢复路径。
**本次新增的机制**：设备签名私钥在 storage.local 里另存一份 VK 加密的副本（d2）；克隆软检测提前到 M6，并配一个"分出独立身份"接口（d3）；`min_client_version`（d6）。

| 编号 | 处理 | 改动 / 理由 | 位置 |
|---|---|---|---|
| d1 | 采纳 | A3 "配置文件副本"改写为**常态**（GoLogin 同步含扩展存储、Kameleo 复制/导出含扩展、MLX 转移含 Local storage、AdsPower/BitBrowser/VMLogin/Dolphin 有可选开关），补 BitBrowser 2023 先例；§4.10 写明厂商与来源；Q6 的实测范围缩小。 | §1.2、§4.10、§11 |
| d2 | 采纳，并作出决定 | "storage.local 显示已入网、但 `sixkey-identity` 不存在"成为一等状态 `identity_missing`。**决定：DSK 私钥在 storage.local 另存一份 VK 加密的副本**——解锁后自动恢复身份，不必重新入网（GoLogin SDK 每次停止都删 IndexedDB，否则每次启动都要重新批准、设备行无限增长）。理由与代价见 §2.5。钉住值的规则随之简化。 | §2.5、§4.13、§3.8、§3.9 |
| d3 | 采纳 | 克隆软检测从 M7 提前到 M6；检测到克隆的副本用一个需 `pw_auth` 的接口"分出独立身份"，并重新生成 HLC 设备 ID `sk_device`（写入验收标准）。 | §4.10、§5.4、§9 |
| d4 | 采纳 | 新增攻击者 A10"能连接配置文件调试端口（CDP）的本机进程"，如实写明我们对它基本不设防、只能缩短窗口。 | §1.2、§1.3 |
| d5 | 采纳；所有者随后决定暂不做邀请码 | 调研认为邀请码的前提（"同一组种子进几十个配置文件"）缺乏证据。所有者 2026-10-15 决定**邀请码暂不做**（§12 Q3），已从协议、后端、界面与里程碑中删除；**选择性加密导出**（§9.1 H2）是共享/批量配置文件的路径；入网确认页加共享警告；§1.3 补"一个同步库 = 一个人"；吊销清单补团队场景的轮换提示。 | §3.4、§3.5、§1.3、§3.10、§6 |
| d6 | 采纳 | 明写"服务器的任何安全判断都不依赖 `Origin`"（旁加载副本的扩展 ID 会变）；状态接口返回 `min_client_version`，过旧的、不会自动更新的副本停止同步；客户端安装来源自检见调研 F4。 | §5.2、§5.4、§6 |
| d7 | 采纳 | `DeviceIdentity` 不再明文存邮箱；邮箱放进 VK 加密的副本里，锁定时只显示"已登录"。 | §2.5 |
| d8 | 采纳 | CI 增加在旧 Chromium（120 = `minimum_chrome_version`，以及 134）上跑的同步 e2e，覆盖 ECDH/ECDSA、`storage.session`、offscreen。 | §8.6、§9 |
| 调研 F1–F8 | 采纳为 Phase 0.x 加固（零网络、无新权限、无新格式、1 个 M + 7 个 S） | 每项的里程碑与改动范围见 §9.1。所有者 2026-10-15 已全部采纳，**含调研 F1（首个账户前必须设主密码）**，它了结 PLAN §15 的悬而未决问题。 | §9.1、§12 |
| 调研 F9–F13 | 采纳进 Phase 1 现有里程碑 | F9 = d2（M2 定设计）、F10 = d3（M6）、F11 = d6（M4/M5）、F12 = d8（M5/M6）、F13 = d7（M2）。 | §9 |
| 不做清单 | 采纳 | 抄入 §13 并写明理由。 | §13 |
| PRIVACY/SECURITY 两处不实表述 | 采纳 | "卸载即删除全部数据"在厂商同步/复制过的配置文件里不成立；IndexedDB 镜像在部分指纹浏览器里不是独立副本。改写计划见 §7。 | §7 |

## 0.0c 修订 4：最终评审（`docs/audit/internal-reviews/SYNC-DESIGN-FINAL-REVIEW.md`，30 条）

评审结论"修完即可实施"。30 条全部逐条对照文档与代码核实后接受；其中 **S2 接受了问题，但没有采用评审（以及维护方指示）建议的"退避"修法**，改用更简单的"只计数 + 告警"（理由见表）。没有推迟。删除入网暂停是评审复杂度表里标明"由所有者决定"的一项，列为 §11 的 Q11 待确认（本修订已按删除来写）。

**本次删掉的机制**：`sensitive_locked` 列、`423` 错误码、"敏感操作已锁定"标记、写入证明失败暂停（S2）；inbox（`sk_sync_inbox`，C1）；入网暂停（`enroll_paused_until`、`POST /v1/enroll/pause`、它与恢复码入网的联动——评审复杂度表列为"可选删除，由所有者决定"，**待所有者确认，见 §11 Q11**；"拒绝全部"与每会话 1 个请求已够用）；状态查询上的 cursor 以及"每次状态查询都必须持锁"的规则（T2）；`GET /v1/time`、`devices.revoked_by`（T3）；"本机生成的恢复码已生效"对 `bundle.by` 的依赖（S4）。
**本次新增的机制**：store 的恢复前钩子 `beforeRecoveryWrite` 与提交后钩子 `afterCommit`（D1、D2）；`DELETE /v1/vault/versions`（C1，让已决 Q5 的按钮真正有接口）；状态里的 `head` 哈希（D5）；独立的本地安全记录 `sk_security_log`（H-b）。

| 编号 | 处理 | 改动 / 理由 | 位置 |
|---|---|---|---|
| S1 | 接受 | 如实写明：配置文件副本 + 主密码 = 同一设备身份的**隐形同步凭据**（d2 的副本让它在另一台机器上也能用）。共享警告与 H8 改为"加入同步的配置文件绝不能被厂商同步或与他人共享"；`forked` 提示旁加"吊销并保护"。 | §1.2、§1.3、§2.5、§3.5、§4.10 |
| S2 | 接受问题；**未采用建议的退避修法** | 删除永久锁、`423`、写入证明失败暂停。**也不采用评审建议的退避**：任何持有设备签名密钥的人都能 `GET /v1/keys` 拿到密码包裹去离线猜，在线限次对他毫无作用；而退避（最长 24 小时、可无限续期）仍是同一个拒绝服务杠杆。只保留按设备的失败计数与"设备 X 多次输错主密码"横幅；带**有效** `pw_auth` 的请求不受按设备限流约束，所以副本持有者无法挤掉用户的吊销与轮换。 | §3.14、§5.3–§5.5 |
| S3 | 接受 | TOTP 默认用本机时钟；偏差 >15 秒时横幅提供"用校正后的时间生成验证码"，由用户选择，偏移限 ±1 小时。HLC 与夹紧仍用校正时间（F5 需要）。 | §4.14、§6 |
| S4 | 接受 | 对账按关键部分判定：恢复码操作看"我提交的恢复码包裹（iv + wrapped）是否在服务器当前 bundle 里"，轮换看"我的 keyring.vkId 是否是服务器的 vk_id"；不再整份比较，也不靠 `by`。 | §3.6.0 |
| S5 | 接受 | fork 请求带新公钥对同一签名输入的签名；DSK 可导出的 JWK 只在发起流程的标签页内存里，直到能写 `sk_sync_cfg`，同一步向 IDB 导入 non-extractable 副本。 | §2.5、§4.10、§5.4 |
| S6 | 接受 | 发送前检查增加恢复码版本；`recovery_auth` 失败计入同一个设备计数。 | §3.14 |
| S7 | 接受（残余） | "数据库只读泄露 + 锁定的配置文件副本 = 可写入"写入 §10；M7 的 KMS 层同时覆盖 `write_key`。 | §10、§9 |
| S8 | 接受 | 吊销自己、给自己改名、设备侧拒绝入网请求都需要 `pw_auth`（"关闭同步"多输一次密码）。 | §3.10、§3.14、§5.4 |
| D1 | 接受 | `VaultStore` 新增 `beforeRecoveryWrite` 钩子：在 store 锁内、任何恢复写入之前，用一次 `storage.local.set` 把 `lastSynced` 置空并清掉 outbox。同步状态永不从用户可见的事件列表推导。 | §3.13、§4.1 |
| D2 | 接受 | outbox 在 `transact` 的 `afterCommit` 步骤里（同一把锁内）只为刚提交的 generation 写；outbox 推送成功后，只有当 `lastSynced` 仍是 `{version: outbox.base, …}` 时才前移。 | §4.7 |
| D3 | 接受 | 删除进回收站与永久删除是**明确豁免**，无论大小一律允许（删进回收站会让条目变大，所以不能靠大小比较推断）；其余编辑只拒绝让库变大且超限的。 | §4.3 |
| D4 | 接受 | `init` 与 `complete` 按原文幂等；结果不明时先以新 deviceId 签名查状态，200 即已入网；只有确认是**别人的**库才提示"恢复码对此库无效"。 | §3.1、§3.2、§3.3、§5.4 |
| D5 | 接受 | 状态返回 `head` = 服务器存的 envelope 原文的 SHA-256；`lastSynced` 记录它；(version, head) 任一不同即拉取，消除回滚后版本号复用的 ABA。 | §4.1、§5.3 |
| D6 | 接受 | 改写 §4.4 的过度说法；远端在 24 小时内"先删后清"≥3 条时横幅用 danger 色。真正的保护是快照与 30 天历史。 | §4.4、§6 |
| D7 | 接受 | 合并结果超过 50 000 条解析上限同样进入 `too_large`，不每轮失败。 | §4.3 |
| D8 | 接受 | 解锁时若本地 keyring 的 vkId ≠ 钉住值、且其 previous 能解出钉住值，就把钉住值前移。 | §3.9 |
| D9 | 接受 | 入网时用现有 `rewriteForKeyChange` 把本机旧快照重新加密到云端 VK（保留原 vaultId），"找回账户"仍能读取，之后按原规则轮换出局。 | §3.5 |
| D10 | 接受 | `sixkey-sync` 锁归"跑这一轮的上下文"；SW 的传输函数从不取锁，只有 SW 自己发起的一轮或 outbox 推送才取。 | §4.9 |
| D11 | 接受 | "关闭同步"与"移除同步身份"一步删除 IDB 身份、`sk_sync_cfg`、`sk_sync_state`、outbox、staged；保留 `sk_prejoin`。 | §3.10 |
| T1 | 接受 | 同步开启时 keyring 操作传入取整到小时的 `now`；上传前把 bundle 的 `at` 与所有 `createdAt` 截断到小时（不在 AAD 里，不影响解包）。保留 `by`（§3.10 的强制保护规则要用），服务器校验 `by` = 签名设备。 | §2.3 |
| T2 | 接受 | cursor 只随 `PUT /v1/vault` 放在已签名的正文里交换；状态查询不写库；`last_seen_at` 改为天粒度、跨天才写。删除"每次状态查询持锁"规则及其测试。只读的克隆不会被发现（无害），写入的克隆在第二次写入时被发现。 | §4.10、§5.3 |
| T3 | 接受（6 项） | 删 `revoked_by`；删 `GET /v1/time`；`revoked_at` 小时精度；`enrollments.created_at` 分钟精度；每天清理 24 小时前未确认的 auth 用户；应用日志时间只到秒。 | §5 |
| C1 | 接受 | 新增 `DELETE /v1/vault/versions`（设备 + `pw_auth`，保留头版本，幂等）：M4 做接口、M6 做按钮。删除 inbox：`review_needed` 不保存远端，点［应用］时重新拉取头版本。 | §4.4、§5.4、§9 |
| C2 | 接受 | 表由只用于迁移的 `sixkey_owner` 拥有；`sixkey_api` 获授权，并有 `TO sixkey_api USING (true) WITH CHECK (true)` 策略；改正"所有外键都指向 auth.users"的说法。 | §5.3 |
| C3 | 接受 | PUT 与 rotate 事务先 `SELECT … FOR SHARE` 锁住设备行。 | §5.3 |
| C4 | 接受（8 项） | §11 清理（Q6、Q9 已决）；限流窗口统一说法；R3 第三条与 R4 规则；64 条回收的精确规则；canonicalJson 比较；第 1 步字段；bundle 前向兼容；补测试（HOTP、加入已有本地库、`different_vault`、以本机为准修复云端、设备名重新加密、时钟边界、超限清理）。 | 各处 |
| H-a | 接受 | `create(password)`、`restoreBackup(backup, password)`、`startOver(password)` 直接生成密码 + 恢复码包裹，**从不写设备包裹**；欢迎页与恢复页先问密码；残留测试扩展到"在新配置文件里从备份恢复"。 | §9.1 H1 |
| H-b | 接受 | H6 用独立的 `sk_security_log`，不碰 `sk_events`。 | §9.1 H6 |
| H-c | 接受 | H1 的测试迁移按评审列出的全部点写入范围（机械性改动，规模仍记 S）。 | §9.1 H1 |
| H-d | 接受 | H2 子集导出用新的条目 id 与重新盖章的 HLC（不带源设备的 HLC 后缀），`createdAt` 取导出时间；"再次导入不重复"的验收放宽为"改名过的账户会作为新条目出现"。H4 对 `installType = admin` 不提示。 | §9.1 H2、H4 |


## 0.0d 修订 5：M0 实现中发现的问题（`contract/M0-NOTES.md`，N1–N26）

所有者已同意修正。每条都对照文档与代码核实过（例如 WebCrypto 的 HMAC `deriveKey` 不写长度确实得到 512 bit 密钥；`date_trunc` 对 `timestamptz` 确实跟随会话时区；Phase 0 `canonicalJson` 确实是 `JSON.stringify` 语义）。**26 条全部接受，没有拒绝**；其中 N18、N25 不需要改行为，只补明文字与测试。M0 实现者据下表"契约改动"一栏重新同步 `api/openapi.yaml`、`contract/vectors/sync-v1.json`（及其 schema、生成器、Python 参考实现）与 `contract/tools/check_consistency.py`；本修订没有修改任何 `api/`、`contract/`、`extension/` 文件。

**本次删掉的机制**：`GET /v1/vault` 的条件请求（`If-None-Match`/`ETag`/304，N2）；`devices_changed_at`（N15，由计数器取代）。
**本次新增的机制**：`vaults.devices_rev` 计数器（N15）；`Sixkey-New-Sig` 请求头（N1，取代正文字段）；"以本机为准修复云端"里的恢复码步骤（N24）。

| 编号 | 处理 | 文档改动 | 契约 / 向量必须改成 |
|---|---|---|---|
| N0 | 接受（无需改文档） | — | 不变（JSON 语法的 YAML）。 |
| N1 | 接受 | fork 的新公钥签名改为请求头 `Sixkey-New-Sig: base64url(P1363 r‖s)`，对与 `Sixkey-Sig` **完全相同**的签名输入签名；服务器用正文的 `new_sig_pubkey` 验它（§4.10、§5.2、§5.4）。 | `POST /v1/devices/fork`：请求体删除 `new_sig`（required 列表同删）；新增必填请求头参数 `Sixkey-New-Sig`（base64url，64 字节 P1363），说明它签的是同一个签名输入；缺失或错误 → 401 `bad_signature`。向量：一个 fork 用例，同一签名输入分别给出旧 DSK 与新私钥的两个签名，均可验证。 |
| N2 | 接受，用删除解决 | `GET /v1/vault` 不做条件请求（§5.4 行与"已删除"一行）。 | 删除 `IfNoneMatch` 参数、`ETag` 响应头组件与 304 响应；`x-sixkey-removed` 增加"`GET /v1/vault` 条件请求（N2）"。 |
| N3 | 接受 | §2.2：除 `vk-id`（64 bit）外所有 HKDF 输出 256 bit；HMAC 密钥显式 `length: 256`。 | 向量已按此固定；把这条写成 `rule`（不再是 M0 的推定），保留"默认 512 bit 得到不同 MAC"的反例。 |
| N4 | 接受 | §2.3："向下截断到 UTC 整点"，给出公式；§5.3：迁移设 `ALTER ROLE sixkey_api SET timezone = 'UTC'`。 | 向量的截断规则不变（已是 floor 到 UTC）；`HourMs`/`DayMs`/`MinuteMs` 描述改为引用 §2.3；M4 的迁移脚本需含该 `ALTER ROLE`。 |
| N5 | 接受（含两项提议） | §2.4：NFKC → 去首尾 U+0020 → 按"非法字符串、空、>40 码点、Cc、Bidi 控制、零宽"的顺序拒绝 → 补齐到 160 字节 → 解码去尾部空格；§3.2：reveal 的 `name_ct` 同样补齐。 | 设备名向量：增加 Bidi 控制（U+202E 等）与零宽（U+200B 等）的拒绝例、首尾空格被去掉的例、全空格 → 空 → 拒绝的例；拒绝原因按上述顺序；reveal `name_ct` 为补齐后的 188 字节（base64 前）线上值。 |
| N6 | 接受 | §3.2：K_enroll 密文为标准 base64 的 `iv(12) ‖ ct ‖ tag(16)`；§5.3 注释改为 `{vkId, iv, ct}`。 | 不变（契约已用 `vkId` 与该格式）；去掉 N6 的"文档未说明"注记。 |
| N7 | 接受 | §3.2 M5：`bundle` 为原文字符串；`P.at` 为精确毫秒。 | 不变（向量已如此）；注记改为引用 §3.2。 |
| N8 | 接受 | §5.2：注册类端点的签名者头为 `Sixkey-Device: {正文 device_id}`，必须与正文一致，验签用正文 `sig_pubkey`，`sub` 为 JWT sub。 | 不变（已如此）；去掉"文档未说明"注记。 |
| N9 | 接受 | §5.2：`host` = `URL.host`（小写，非默认端口才带端口）；`target` 以 `/` 开头、原样；无正文时对零字节求哈希。 | 不变（向量已覆盖）。 |
| N10 | 接受 | §5.2：`Authorization: Bearer {account_token}`。 | 不变。 |
| N11 | 接受 | §5.4"通用错误码"段落：列出 8 个 m0 错误码及其状态，以及只写状态码的格子如何对应。 | 这些错误码的 `source` 从 `m0` 改为 `doc`；其余不变。 |
| N12 | 接受 | §5.4"响应"段落：`server_time` 在每个 JSON 响应体顶层，细节在 `error` 里；§5.5："PUT 30 次/分钟"改为"非 GET 请求 30 次/分钟"。 | 不变（已如此）；204 的说明保留"读 `Date` 头"，删除 304 的说明（N2）。 |
| N13 | 接受 | §5.4 增加逐端点请求体上限表：`init`、`PUT /v1/vault`、`POST /v1/keys/rotate` 为 9 MiB（9 437 184），其余 64 KiB（65 536）；§5.8 历史上限写作 64 MiB；全文 MB → MiB。 | 不变（`x-sixkey-max-body-bytes` 已如此）；`MAX_BODY_BYTES_VAULT` 的 `source` 改为 `doc`，说明列出三个端点。 |
| N14 | 接受 | §5.4：所有时间为纪元毫秒整数，精度按 C14；`last_seen_at` 为 UTC 零点毫秒。 | 不变；注记改为引用 §5.4。 |
| N15 | 接受 | 状态里的 `devices_changed_at` 改为 `devices_rev`（不透明计数器）；§5.3 新增 `vaults.devices_rev bigint not null default 0`，与任何 `devices` 行变化同事务加一（新增、吊销、改名、`auth_failures` 增加、轮换重新加密设备名；`last_seen_at` 不加）。 | 状态响应：字段 `devices_changed_at` 改名为 `devices_rev`（required 列表同改），类型仍为 ≥0 的整数，说明"只比较是否相等"；wire 示例同改。`x-sixkey-removed` 增加 `devices_changed_at`。 |
| N16 | 接受 | §2.3：服务器拒绝 `at`、`wraps[].createdAt`、`previous[].createdAt` 不是 3 600 000 整数倍的 bundle（422）；客户端读取时不检查。 | 保留 `multipleOf: 3600000`；在 `PUT /v1/keys`、`/v1/keys/rotate`、`init` 的 422 说明里写明此原因；增加一个未对齐 bundle 被拒的 wire 反例。 |
| N17 | 接受 | §5.4 PUT 行：`cursor: {cur?, pending}`，16 字节标准 base64。 | 不变；`check_consistency.py` 里把它从"已接受的偏差"中删除（文档现在就是 `cur?`）。 |
| N18 | 接受（只补文字） | §5.4"编码"一条列出 base64url 与标准 base64 各用于哪些字段。 | 不变，除了 `new_sig` 从正文移到请求头后改为 base64url（见 N1）。 |
| N19 | 接受 | §2.2：base64url 严格解码；标准 base64 沿用 Phase 0 规则。 | 不变；注记改为引用 §2.2。 |
| N20 | 接受 | §2.3、§5.4：数字只能是安全整数，服务器拒绝非整数数字记号。 | 在 bundle 与请求体的校验说明里写明；增加 `3.0` 与 `1e3` 被拒的反例（Python 参考实现按严格整数解析）。 |
| N21 | 接受 | §5.2：`min_client_version` 为 Chrome manifest 版本格式，逐段数值比较，缺段为 0。 | 不变。 |
| N22 | 接受 | 在协议步骤里点名：`GET /v1/enroll/requests`（§3.2 M2）、`POST /v1/enroll/reject-all`（§3.2、§3.14）、`GET /v1/devices` 与 `PATCH /v1/devices/{id}`（§3.10、§4.2 第 1 步）、`GET /v1/vault/versions/{v}`（§4.3）、`GET /healthz`（§5.1）。没有删除任何端点。 | 契约不变；`check_consistency.py` 的 S1 应降为 0。 |
| N23 | 接受 | §4.1：已是 16 KiB 整数倍时不补。 | 不变。 |
| N24 | 接受，重新设计修复路径 | §4.2："以本机为准修复云端"是不换 VK 的 rotate：pw_auth 与写入证明按服务器回档后的 bundle（VK1）计算，必要时要旧密码；**恢复码由用户当场输入或新生成**（与 §3.1 第 4 步相同的二选一），本机仍从不保存恢复码（I9）；给不出恢复码就不能修复。 | `POST /v1/keys/rotate` 契约字段不变；说明里增加"修复用法：`bundle.keyring.vkId` 等于 envelope 的 vkId、可以与请求前服务器的 `vk_id` 不同而不换 VK；`recovery_verifier` 必填"。增加一个修复用的 wire 示例。 |
| N25 | 接受（只补测试） | §5.4 说明失败关闭；§8.4 增加经真实代理的测试。 | 不变。 |
| N26 | 接受 | Q11 已决（所有者同意删除入网暂停），§11 清空，§12 增加 Q11 一行，§13 改为"已决"。 | 不变（契约已把 `POST /v1/enroll/pause` 与 `423 enroll_paused` 列为已删除）。 |

M0 实现者重新同步后，`check_consistency.py` 应为 0 处硬不一致、S1 为 0（`GET /healthz` 现在出现在 §5.1 的正文里）。


## 0.0e 修订 6：M0 重新同步时发现的问题（`contract/M0-NOTES.md`，N27–N29）

三条都对照文档核实过：R1 原文只拒绝 `kver < maxSeenKver`、`maxSeenKver` 从不重置、发送前检查又套用 R1–R3，所以诚实回档后的问题确实存在；U+200D 确实在零宽字符列表里；§9 与 §0.0d 对 S1 的说法确实不同。**三条全部接受**，没有新的所有者问题。

| 编号 | 处理 | 文档改动 | 契约 / 向量必须改成 |
|---|---|---|---|
| N27 | 接受，修法比提案更完整 | 用三个序列检验规则：诚实的多步回档、落后的发布者（以等于或低于他人所见的 kver 发布不同内容）、解决之后恶意重放真实的旧 bundle。提案（发布 `max(服务器 kver, maxSeenKver) + 1`、服务器接受跳号）只解决前一和后一，挡不住第二个——R1 原文只拒绝"小于"，同 kver 的不同内容会被静默采用。采用的规则：① 发布一律取 `max(服务器 kver, maxSeenKver) + 1`，服务器接受任何 `kver > if_kver`（CAS 仍按 `if_kver`），幂等改为"已存 bundle 原文与提交的逐字节相同"；② R1：只在 `kver > maxSeenKver` 时才可能自动采用；`kver ≤ maxSeenKver` 且内容相同 → 已同步；内容不同 → 可见状态 `keys_behind`，不采用，也**没有**"采用服务器的"按钮，唯一出路是"以本机为准修复云端"（现在也覆盖同一 VK 的情况，走 `PUT /v1/keys`）；③ R3 解锁时若只有旧密码能打开这个较旧的 bundle，要用户明确确认才采用（保留"永不被锁死"，但不静默降级）；④ `keys_behind` 下只挡会发布或交出 bundle 的操作（改密码、换恢复码、轮换、批准），吊销等照常，紧急吊销永不被挡；⑤ 身份恢复时 `maxSeenKver = 0`，免得只是落后的设备被误判并被引导去发布过时的 keyring。没有删掉机制；只新增一个客户端状态 `keys_behind`，不新增端点或字段。改动在 §2.3、§2.5、§3.6.0、§3.6.1、§3.7、§3.8、§3.9、§3.14、§4.2、§5.3、§5.4、§6 O12、§8、§10 第 80 条。 | `PUT /v1/keys` 与 `POST /v1/keys/rotate`：`bundle.kver` 的约束由"`= if_kver + 1`"改为"`> if_kver`"；`if_kver` 不等于服务器当前 kver 仍是 409 `keys_conflict`；幂等 200 的条件改为"已存 bundle 原文与提交的逐字节相同"（删除"恰好落后一步"）。增加一个同 VK 修复的 wire 示例：`PUT /v1/keys`，`if_kver` = 服务器 kver，`bundle.kver` 跳号，带 `recovery_verifier` 与 `password_verifier`。向量与 Python 参考实现里凡是编码了 `kver = if_kver + 1` 的规则或示例都按新规则改。`check_consistency.py` 预计不需要改动（它不检查这条值约束），重新同步后应仍为 0。 |
| N28 | 接受：保留拒绝，在界面上说明 | 两种做法里更简单的是保留：只在两个 Extended_Pictographic 之间放行 U+200D，需要 TS 与 Python 各带一份随 Unicode 版本变化的表情数据，正是 M0 已经为 NFKC 担心过的跨运行时版本漂移。§6 O3 的设备命名提示（入网与改名共用）写明"组合表情里的连接符也算零宽字符，请改用单个表情或文字"。 | 不变：保留"emoji 序列中的 ZWJ U+200D 被拒"这个向量。 |
| N29 | 接受 | §9 M0 的验收改为"S1 为 0"，与 §0.0d 一致。 | 不变。 |

## 0.0f 修订 7：M1 代码评审（`docs/audit/internal-reviews/M1-REVIEW.md`）与实现说明（`docs/design/notes/M1-NOTES.md`）

每条都对照文档与代码核实过。评审引用的位置与现象都与 `extension/src/core/sync/crypto/` 一致：`classifyKver` 只要求 `kver > maxSeenKver`，`publishKver` 不检查结果；`previousCovers` 在新列表恰好 64 条时允许缺任意多条；`afterRemote` 在本地 keyring 不在时一律判为内容不同；`preSendCheck` 先按 `keys_behind` 拦、后验 MAC；两个状态机的 `abort()` 不经过 `#busy`。Phase 0 的 `rekey` 也确实不设上限（`keyring.ts:269`）。

**结论**：F-01–F-12 全部接受，T-01、T-02 是测试项、接受；M1-1–M1-15 都有了明确的规格。与评审建议不同的只有两处，都更简单：
- **F-01 的客户端上限不做成硬拒绝 `kver_jump`**。超限的 bundle 按 `kver ≤ maxSeenKver` 分类：不能抬高 `maxSeenKver`，内容不同即 `keys_behind`；`maxSeenKver = 0`（身份刚恢复）时不设上限。硬拒绝会让一台离线期间错过了几次最大跳幅的设备再也无法修复与轮换，正是 F-01 要避免的后果；`keys_behind` 已有唯一出路（修复），所以不新增状态或拒绝原因。
- **"最旧"按列表顺序，不按 `(createdAt, vkId)`**（S-5，核实 F-11 时发现）。Phase 0 `rekey` 每次轮换都把更早的条目重新包裹，`createdAt` 一律改成本次时间（`keyring.ts:232、263–269`），同步时又截断到小时（§2.3）。所以同一个 keyring 里所有 previous 条目的 `createdAt` 相同，按 `(createdAt, vkId)` 排序实际是按随机的 vkId 排序，`capPrevious` 会丢掉随机一条而不是最旧的。`rekey` 按"更早的……、刚退役的"顺序追加，列表顺序本来就是时间顺序。改用列表顺序就删掉了排序，刚退役的 VK 也自然在末尾、总被保留。

没有新的所有者问题。新增的只有一个常量（`KVER_MAX_JUMP`）、身份记录里的两个字段（`vaultId`、`adopted`）和一个函数（`capPrevious`）。删掉的有：R2 的 64 条例外、previous 的排序、`localAuth` 的"可省略"、`classifyKver` 的公开导出。

| 编号 | 处理 | 文档改动 | 契约 / 向量必须改成 |
|---|---|---|---|
| F-01 | 接受；客户端一侧按上面的简化 | §2.3 的服务器检查与 `kver` 注释；§3.9 R0：超限跳幅按 `kver ≤ maxSeenKver` 分类，`maxSeenKver = 0` 时不设上限；R1 的 `publishKver = min(max(s, m) + 1, s + KVER_MAX_JUMP)`，结果不是安全整数时抛 `kver_overflow`。§3.6–§3.8 与 §4.2 的发布 kver 一律写成 `publishKver`；还改了 §5.4、§8 和 §10 第 81 条。为什么封顶：服务器回档极深时（本机 `maxSeenKver` 比服务器高出超过上限），修复仍能发布，只是要修复几次才越过最高的 `maxSeenKver`。诚实使用中跳幅不超过回档深度 + 1，碰不到上限。 | `x-sixkey-constants` 增加 `KVER_MAX_JUMP`：value 65536，unit kver，section "§2.3、§3.9 R0/R1"，source doc，enforced_by both。`Kver` 增加 `maximum: 9007199254740991`。`PUT /v1/keys` 与 `POST /v1/keys/rotate` 的说明：把 "kver > if_kver" 改为 "if_kver < kver ≤ if_kver + KVER_MAX_JUMP，否则 422 invalid_request"，把 "clients publish max(server kver, maxSeenKver) + 1" 改为 publishKver 的公式；`kver_rules.rule` 同样改写。向量 `kver_rules.server_accept` 增加两条：if_kver 3 时 kver 65539 → 200 applied，kver 65540 → 422 invalid_request。`kver_rules.publish` 增加两条：(s 5, m 100000) → 65541；(s 9007199254740991, m 0) → 抛 kver_overflow。`kver_rules.adoption` 增加三条：m 3、kver 65540、同一 keyring → in_sync 且 max_seen_after 3；m 3、kver 65540、不同 keyring → keys_behind 且 max_seen_after 3；m 0、kver 70000、不同 keyring → adopt_candidate 且 max_seen_after_adoption 70000（身份刚恢复时不设上限）。 |
| F-02 | 接受；M1-3 一并解决 | §3.9 R2：同一 VK 的 previous 必须包含本地全部真实条目，没有例外（改密码、换恢复码、同 VK 修复都不改 previous）。R3：64 条例外只留在另一个 VK 的路径，缺少的必须是本地真实条目按列表顺序开头连续的一段，数量不限；残余（这个 bundle 的作者持有新 VK）如实写明。S-3 的 2^64 界写入 R2。同 VK 的包含检查有三处：采用、同 VK 解锁、发送前检查，三处都改。 | 不变（包含规则没有向量，由单元测试与 K10 覆盖）。 |
| F-03 | 接受 | §3.9 R0：分类前要求 `bundle.vaultId` 等于本机 vaultId，否则 `wrong_vault`；本地 keyring 不在时用身份记录新增的 `vaultId`（§2.5）。§3.2 M7 与 §3.3 第 4 步用同一个"验证收到的 bundle"函数（vkId、MAC、vaultId）。 | 不变。 |
| F-04 | 接受 | §3.2 MUST 7：失败是终态，并优先于在途步骤。每步先把结果算进局部变量，最后在同步段里提交，条件是起始阶段未变且没有失败；否则丢弃结果，不返回请求体、CC 或密钥。 | 不变。 |
| F-05 | 接受 | §3.2 MUST 8：approve 在途时页面不轮询。`approving` 阶段收到 `approved` 且钉住值不变，等同于 approve 的 200；发出 approve 之前看到 `approved` 仍中止。 | 不变（批准方视角在 `approved` 时带全钉住字段，由 F-10 保证）。 |
| F-06 | 接受 | §2.5 身份记录增加 `adopted {digest, auth}`（M2）。§3.9 R1：本地 keyring 不在时，bundle 的 `SHA-256(canonicalJson({keyring, auth}))` 等于 `adopted.digest` 即"内容相同"，普通云端恢复不再弹出 R3 的确认。 | 不变。 |
| F-07 | 接受；M1-1 一并解决 | 同一记录的 `adopted.auth` 是"auth 只能随密码包裹一起变"的基准，调用方必须传入；只有身份刚恢复时才是 null。"已同步"分支里，已知的 `adopted.auth` 与 `bundle.auth` 不同 → `auth_without_password`。 | 不变。 |
| F-08 | 接受；M1-11 一并解决 | §3.9 R0：只有 MAC 已验证的 bundle 才参与分类，分类函数不对外暴露。§3.14：发送前检查先验 MAC 与 vaultId，再分类。 | 不变。 |
| F-09 | 接受 | §3.14：发送前检查接收原文，返回"已验证的服务器 bundle"对象；respond、approve、`PUT /v1/keys`、轮换与修复的构建函数只接受它，并检查 op 与 keysBehind。§3.2：approve 前重新检查，P 里的 bundle 就是它返回的原文。`…/respond` 加入 `keys_behind` 的禁止清单（M1-4）。 | 不变。 |
| F-10 | 接受；选"契约写明必有"，比"缺了就忽略"简单 | §3.2 与 §5.4：新设备视角从 `responded` 起必有 `approver_device_id`、`approver_epk`，`approved` 时必有 `payload`；批准方视角从 `revealed` 起必有 `new_epk`、`new_nonce`、`new_name_ct`。缺少按 MUST 1/2 中止。 | `EnrollNewDeviceView` 增加 `allOf` 里的两个 `if`/`then`：state 为 responded、revealed、approved 时 required approver_device_id、approver_epk；state 为 approved 时 required payload。`EnrollApproverView` 增加一个：state 为 revealed、approved 时 required new_epk、new_nonce、new_name_ct。顶层 `required` 不变：§5.4 仍用问号，`check_consistency.py` 的 H5 只比较顶层。`wire_examples` 增加一个反例：`responded` 的新设备视角缺 `approver_epk`。 |
| F-11 | 接受；排序改为列表顺序（S-5） | §3.8 P1：轮换构建器在 `rekey` 之后调用 `capPrevious`，按列表顺序保留最后 64 条，刚退役的 VK 总被保留。 | `KEYRING_PREVIOUS_MAX` 的 section 改为 "§2.3、§3.8 P1、§3.9 R3"。 |
| F-12 | 接受（只涉及代码） | 无。 | 不变。 |
| T-01、T-02 | 接受（测试） | §8 列出要纳入的测试；§9 M1 的验收加上 K0–K11 与三个 REPRO 回归。 | 不变。 |
| S-2 | 接受 | §2.3：P4 的"包裹改变"按 iv 与 wrapped 字节判断。 | `PUT /v1/keys`、`POST /v1/keys/rotate` 的 P4 说明加同一句。P4 一致性用例增加一条：两个包裹只差 `createdAt` → 视为未改变，不要求 verifier。 |
| S-3 | 接受 | §3.9 R2 写明 64 bit vkId 的 2^64 第二原像界。 | 不变。 |
| S-5（核实时发现） | 接受 | 见上：previous 的"最旧"按列表顺序（§3.8、§3.9 R3、§10 第 87 条）。 | 不变。 |
| M1-1–M1-15 | 全部给出规格 | M1-1 = F-07；M1-2、M1-2b 写入 R2（两侧都只算真能解开的条目）；M1-3 = F-02 + S-5；M1-4、M1-5 写入 §3.14、§4.2；M1-6、M1-7 写入 §2.3（auth salt 只是客户端的生成规则；客户端也拒绝非整数记号）；M1-8 写入 §3.2 M7（P 中未知成员忽略）；M1-9 写入 §2.5；M1-10 写入 §3.6.0；M1-11 = F-08；M1-12、M1-13 写入 §8（以种子固定；默认跑 2000 个完整会话 + 10⁵ 次哈希级试验，完整的 10⁵ 个会话放在 CI 长任务里）；M1-14、M1-15 写入 §3.2 MUST 9。 | 不变。 |

**M1 代码改动**（交给实现者；M3 开始前完成第 1–8 条与测试，M5 接线前完成第 9–10 条）：
1. `constants.ts` 增加 `KVER_MAX_JUMP = 65536`（与 `x-sixkey-constants` 对照的现有测试会覆盖它）。`publishKver(s, m)` 改为 `min(max(s, m) + 1, s + KVER_MAX_JUMP)`，结果不是安全整数时抛 `kver_overflow`。
2. `classifyKver`：`m > 0` 且 `kver > m + KVER_MAX_JUMP` 时按 `kver ≤ m` 分类（`maxSeenAfter = m`）；`m = 0` 时照常分类。从 `index.ts` 移除导出，只在 MAC 与 vaultId 验证之后内部调用。
3. `previousCovers(local, remoteIds, sameVk)`。同一 VK：远端真实 id ⊇ 本地真实 id，没有例外。另一个 VK：只在远端真实条目恰好 64 条时，允许缺本地真实条目按**列表顺序**开头连续的一段。`PreviousRef` 不再需要 `createdAt`。三个同 VK 调用点都传 `sameVk = true`：`evaluateSameVkBundle`、`afterRemote` 的同 VK 解锁、`preSendCheck` 的 `decideSameVk`。R3 另一个 VK 的路径传 false。
4. 新增并导出 `capPrevious(keyring)`：按列表顺序保留最后 64 条。轮换构建器在 `rekey` 之后、`sealBundle` 之前调用它。
5. `evaluateSameVkBundle`、`afterRemote`、`preSendCheck` 增加必填参数 `expectedVaultId`；不等 → `wrong_vault`（加入 `BundleRejection`）。
6. `localAuth` 改为必填的 `adoptedAuth`（BundleAuth 或 null），另加必填的 `adoptedDigest`（string 或 null）。本地 keyring 为 null 时，`sameKeyring = (digest(bundle) === adoptedDigest)`。"已同步"分支里 `adoptedAuth` 非 null 且不等于 `bundle.auth` → `auth_without_password`。导出 `adoptedRecord(bundle) → {digest, auth}`，M2/M3 只用它计算。
7. `preSendCheck` 接收原文。顺序：解析 → vaultId → MAC（同一 VK 用本机 VK；较旧的 VK 用 `unwrapPreviousVks` 返回的 Vk）→ 分类 → R2 检查。成功时返回带品牌的 `VerifiedServerBundle {raw, bundle, vk, op, keysBehind}`。保留 `not_behind`（M1-5）与 `respond` 的 `keys_behind` 拦截（M1-4）。
8. 导出 `verifyReceivedBundle(raw, vk, expectedVaultId)`，检查 vkId、MAC、vaultId；§3.2 M7 与 §3.3 第 4 步都用它。删除 `NewDeviceEnrollment.#keys`（F-12）。
9. 两个状态机（F-04）：每个转换先算到局部变量，最后同步提交，用"起始阶段未变且没有失败"或一个 `#fail` 会递增的 epoch 守卫；`abort()` 落在 `await` 期间时，转换返回 `{kind: "failed"}`，不带请求体、CC 或密钥。`startApproval` 只接受 `op = respond` 且 `keysBehind === false` 的 `VerifiedServerBundle`，`buildApproval` 只接受 `op = approve` 的（F-09）。
10. `ApproverEnrollment.onPoll`（F-05）：`approving` 阶段收到 `approved` 且全部钉住值不变（含 `new_epk`、`new_nonce`、`new_name_ct`）→ 与 `approveAccepted()` 相同的结果；`verifying`、`sas_ok` 阶段收到 `approved` 仍是 `unexpected_state`。新设备一侧"缺字段即中止"保持不变：契约改为必有（F-10）。
11. 测试：
    - 评审附录的 K0–K11 纳入常驻测试；REPRO-1、REPRO-2、REPRO-11 按修复后的行为改写为回归测试。
    - F-02：同 VK 的三条路径各一例，另加 R3 多次轮换追赶一例。
    - F-03、F-06、F-07、kver 上限、`capPrevious` 各有用例。
    - M06：upload 模式的 auth salt 规则。
    - T-02：每个事实来源一个例子（如 K7、K9、K11）；可选地让少量事实级序列走 `unlockWithSync`，用测试专用的 1 次迭代 KDF。

**M2 的存储要求**（M2 可以立即开始；以下是它新增的）：
1. `DeviceIdentity` 增加 `vaultId: string | null` 与 `adopted: {digest, auth} | null`（§2.5）。M2 尚未发布，直接作为 v1 的字段。
2. 与 `vkId`、`maxSeenKver` 在同一次 IDB 写入里更新，并且在本地 keyring `transact` 成功之后（写入顺序不变）。
3. 取值见 §2.5 的写入顺序：建库、入网、本机成功发布、R2/R3 采用时写；确认"已同步"时不写。
4. 身份从 `sk_sync_cfg` 恢复时：`vaultId` 取本地 keyring 的，`adopted = null`，`maxSeenKver = 0`。
5. digest 只用 M1 的 `adoptedRecord` 计算。
6. 若 U1b（调研 O4）先合入：同步里每条换 VK 的路径都在同一次 `transact` 里写"旧密钥材料待清理"标记（§9.1 末尾）。
7. H1 可以先于 M2 开始；两者都改服务层，后合入的一方变基到先合入的之上（§9.1），不是新的依赖。

**其他里程碑**：
- M3 用 `VerifiedServerBundle`、`expectedVaultId` 与 `adopted` 记录调用 M1。
- M4 实现 `KVER_MAX_JUMP` 上限、P4 以 iv + wrapped 判断包裹改变、轮询视图按状态必填的字段。
- M5 遵守 MUST 7、8，approve 在途时不轮询。

## 0.0g 所有者决定（2026-10-16）：AI 代理、体验调研与 Phase 0.x

来源：`docs/research/mcp-feasibility.md` §7 的 Q1、Q3，以及 `docs/research/ux-study.md` §7。这一节只改文档，不改同步里程碑的内容与顺序。

| 决定 | 本文改动 |
|---|---|
| MCP 调研 Q1：不向 AI 代理返回验证码、种子或账户列表 | §13 增加一行（MCP 或任何代理通道，附理由）；§1.2 A10 写明"驱动浏览器的 AI 代理"属于 A10。 |
| MCP 调研 Q3：H8 指南加《AI 代理与自动化》一节 | §7 的 `docs/guides/FINGERPRINT-BROWSERS.md` 条目写明这一节的四点：为什么不把码交给模型；代理驱动的配置文件 = A10，用另一个配置文件；测试账号的种子放 CI，用 otpauth / otplib；手动接管 2FA。§9.1 H8 同步提及；`docs/security/local-vault.md` 的 A10 补"被代理驱动的配置文件"。 |
| 体验调研 Q2：侧边栏在 M8 之后，新增 `sidePanel` | §9.1 末尾的交叉引用：§7 的"不新增任何 permission"只管到 M8；侧边栏上线时 `check-dist` 的权限白名单另加 `sidePanel`。（2026-10-20：已提前实现，不再在 M8 之后，见 §9.1 末尾的更新。） |
| 体验调研 Q4、Q5："此网站"只给已登记域名；"标准 / 共享·自动化"两个预设 | §9.1 交叉引用：预设就是 Z2（H5）那一问的结果；"记住此网站"写的是条目已有的 `domains` 字段，按普通编辑同步，不改格式。另记 U1b（解锁不再扫描快照）对同步换 VK 路径的要求。 |
| H1–H8 全部采纳（再次确认）；H1 获准在 M2 之前开始 | §9 开头、§9.1 开头、§12 增加一行。 |

## 0.0h 修订 8：M1 实现说明（M1-16–M1-20）与 A2 换密钥标记

M1-16–M1-20 都对照 `docs/design/notes/M1-NOTES.md` 与 `extension/src/core/sync/crypto/` 核实过：`bundle-eval.ts` 的 `afterRemote` 在本地 keyring 为 null 时用 `adopted.auth` 重算 digest（M1-16）；`enroll-approver.ts` 的 `buildApproval` 在 VK 变了时以 `keys_changed` 失败（M1-18）；`presend.ts` 的品牌是模块私有的 `WeakSet`，对象被冻结（M1-19）；Phase 0 `kdf.ts` 读取参数时要求至少 600 000 次迭代（M1-20）。A2 的换密钥标记按评审中的代码（PHASE0X-PLAN A2）核对过 `store.ts`、`format.ts`，尚未合入主线。契约与向量不变；没有新的所有者问题。

| 编号 | 裁定 | 文档改动 |
|---|---|---|
| M1-16 | 确认实现者多做的这条，写入规格。本地 keyring 不在时，bundle 配上 `adopted.auth` 能复现 `adopted.digest`、而 `auth` 不同，就是"只改了 auth"，拒绝 `auth_without_password`。诚实流程里不存在这种 bundle（改密码同时换包裹与 auth，诚实服务器按 P4 拒绝只改 auth 的）。拒绝的代价是这台设备暂时无法从云端恢复，但什么也不写、不丢数据。 | §3.9 R2 加一条；§10 第 88 条。 |
| M1-17 | 规则：R6 照样采用（"永不被锁死"指能用用户已证明或仍记得的秘密打开），不新增机制。采用后若密码包裹不是本机之前用过的那个，显示 R2 已有的"输入新密码以更新本机"横幅，旁边给 §3.3 第 5 步的"设置新密码"。这是 M3/M6 的提示，M1 不改。 | §3.9 R6。 |
| M1-18 | 采用实现者的名字 `keys_changed`：终态，A 作废该请求（`POST …/reject`），先按 R3 跟上，由用户在新设备上重新发起。 | §3.2 F-09 那一条。 |
| M1-19 | 记为 M3 要求：发送前检查与使用其结果的构建函数在同一个 JS 上下文里调用；跨上下文只传服务器 bundle 原文，在构建的上下文里重新检查。 | §3.14；§9 M3。 |
| M1-20 | 只做记录：真实函数序列用恢复码解锁，密码包裹按字节检查；不加低迭代 KDF，不改 Phase 0。§0.0f 第 11 条里"可选的 1 次迭代 KDF"不做。 | §8。 |

**M2 的存储要求（补充，来自 A2 / U1b 的实现）**（修订 9 改写了第 1、2、4、6 条并有补充，以 §0.0i 的清单为准）。它取代 §0.0f M2 要求第 6 条和 §9.1 原来的 U1b 写法：标记由 `transact` 自己写，不需要调用方在每条换 VK 的路径上自己写。
1. **改变密钥的写入一律经过 `VaultStore.transact`**。改变密钥指：vkId 变化、设备包裹消失、覆盖丢失的数据。`transact` 在写槽位之前写 `sk_keychange = {v: 1, vkId, at}`，写不进去整次保存就失败。
2. **不改当前密钥、却会留下旧密钥副本的写入用 `transact({keyChange: true})`**：M2 入网时重新加密旧快照、`openVault` 的 previous-VK 回退、`applyRemote`。
3. **每个 `VaultStore` 实例**（任何上下文）都用锁名 `sixkey-vault`，否则写标记与清理不在同一把锁下。
4. **重新加密回调必须能打开所有可能留下的旧密钥**：keyring 的全部 previous，以及 §3.5 入网（vaultId 不同）时的本机旧 VK——它不在新 keyring 的 previous 里。回调打不开的副本会被丢弃。若在 §3.5 ⑤ 与 ⑥ 之间崩溃，旧 VK 已不可得，旧快照随之丢弃；当前数据已在 ④ 的 `sk_prejoin` 里，不丢。
5. **采用一个不把本机旧密钥列为 previous 的远端 keyring 时**（§3.5 入网、§3.3 恢复码入网、云端恢复），清理只靠标记触发：`sk_store_v` 只能认出"新 keyring 把记录的密钥列为 previous"的旧版本换密钥。所以这类写入绝不能绕过 `transact`。
6. **`sk_store_v = {v: 2, vkId}`**：记录上次确认全部副本（本库与镜像）都在该密钥下时的 vkId。只由完成的清理在同一个加锁步骤里写，`sk_keychange` 最后删除。

## 0.0i 修订 9：G-M2 评审（`docs/audit/internal-reviews/GM2-REVIEW.md`）中的设计决定

**核实**：都对照合入后的代码核实过。
- GM2-4：`finishKeyChange` 以 `unknownKey: "keep"` 调用 `rewriteInner`（`store.ts:570`、`:688`），从不把未知密钥下的快照交给回调，随后删除标记；`rewriteForKeyChange` 用 `"drop"`（`:639`）。`staleIn`（`:595–627`）只认两槽、keyring 副本与快照，把未知密钥的快照算作"不陈旧"。`checkSnapshot` 不比较 vaultId，所以保留原 vaultId 的重新加密快照能通过。
- GM2-5：§2.5 的写入顺序与 D8 都只考虑"钉住值落后"一个方向；两个 LevelDB 各丢各的尾部这一点由构造成立。
- GM2-7：`openVault` 的回退循环（`store.ts:727–747`）不收集读取失败。
- GM2-11：`store.ts:120` 默认 `createMutex()`，只有 `platform/runtime.ts:22` 传 `webLock("sixkey-vault")`。

**契约与向量不变**：采用向量以 `same_keyring` 为输入事实，"内容相同"改从哪里得出不影响它们；`check_consistency.py` 不涉及。没有所有者问题。

| 编号 | 决定 | 文档改动 |
|---|---|---|
| GM2-4 | **一个清理入口、一条规则；不加评审建议的 `extraKeys` 输入，也不给 store 登记 M2 的记录。** 回调本身就是"调用方手里有哪些密钥"的唯一出处。未知密钥（既不是当前、也不在 previous 里）下的副本先交给回调：重新加密成功就保留，`checkSnapshot` 不看 vaultId，所以 D9 的旧库快照保留原 vaultId，供 §4.6 的"找回账户"以 added 模式使用。回调打不开时，**同一 vaultId 保留**：返回的 keyring 以后可能打开它，例如 FIXa2 或恢复回退之后较新的密钥、同一库的 `restoreBackup`。**另一个 vaultId 丢弃**：`startOver` 之后用户已输入 DELETE、旧密钥已不在；§3.5 在 ⑤ 与 ⑥ 之间崩溃时旧 VK 已不可得，当前数据在 `sk_prejoin` 里。`rewriteForKeyChange` 只剩永久删除的语义。 | §3.5 ⑥、§3.8 P4、§3.9 R3 改为清理入口；§2.5；§7 的 SECURITY 残余（A2-4）；§8；§10 第 89 条。 |
| GM2-5 | **R1 的"内容相同"包括 `adopted.digest`，加上 D8 的第二个方向；不另存一份权威钉住值。** 评审只写了换 VK 的情况，同 VK 的改密码、换恢复码在同样的掉电下也会回退：钉住值不变，D8 不触发，设备判为 `keys_behind`，"修复"会把旧包裹重新发布、悄悄撤销用户自己的改动。一条规则同时覆盖 F-06、GM2-5 换 VK 与同 VK 三种情况：bundle 的 digest 等于身份记录的 `adopted.digest`，即本机自己最近一次提交过的状态，就把它采用回来，不弹确认。换 VK 时，钉住值领先、本地解不出它 → `needs_password`；钉住值与本地不同时按 R4 顺序解锁，R3 连续性还要求真的解出本地 vkId。为什么不选 storage.local 里的权威钉住值：它会和 storage.local 一起回退，而 storage.local 单独回退或被替换正是 IDB 钉住值要作证的情况；本方案也不新增存储。 | §2.5；§3.9 R1、R3、D8、新增的"钉住值与本地不同"一条；§8；§9 M3；§10 第 90 条。 |
| GM2-7 | 记为 M2 的 `openVault` 要求（下面第 8 条）。 | — |
| GM2-11 | 记为 M2 要求（下面第 3 条）。 | — |

**M2 的存储要求**（修订 9 汇总，取代 §0.0f 的第 6 条与 §0.0h 的清单；§0.0f 的第 1–5、7 条不变。修订 10 补充第 5、8 条，新增第 12–14 条，见 §0.0j；修订 11 新增第 15 条，见 §0.0k；修订 12 改写第 2 条、新增第 16–18 条，见 §0.0l；修订 13 写入第 18 条的规则并补充第 16 条，见 §0.0m；修订 14 补充第 16、17 条，见 §0.0n）：
1. **改变 keyring 的写入一律经过 `VaultStore.transact`**。"改变"按 `canonicalJson(keyring)` 判断，包括同 VK 的包裹变化（依赖 GM2-3 的代码修复），也包括覆盖丢失的数据。`transact` 在写槽位之前写 `sk_keychange = {v: 1, vkId, at}`，写不进去整次保存就失败。
2. **只有 `openVault` 的 previous-VK 回退用 `transact({keyChange: true})`**（修订 12，M2R-10）。
   - `applyRemote` **不写标记**：它在当前 VK 与逐字节不变的 keyring 下写入，目标是另一槽，新快照也在当前 VK 下，只会覆盖旧材料、不会产生旧材料。改 keyring 的合并（R3）经 `commitKeys`，标记由 `transact` 自动写。
   - 原来让 applyRemote 写标记的代价：每次远端变化后的第一次打开先做一次完整清理（评审夹具里 29 次本地读取）；有 64 条 previous 时，紧接同步的本地轮换被 `cleanup_pending` 拒绝（PROBE-9）。
   - 测试：applyRemote 之后没有标记、`canonicalJson(keyring)` 不变、`loadView().cleanup === "none"`；同步后第一次打开的读取 ≤ 4。
   - "入网时重新加密旧快照"不是 transact，由第 4 条的回调完成。
3. **`StoreOptions.lock` 必填**（GM2-11）。生产代码只在 `platform/runtime.ts` 用 `webLock("sixkey-vault")` 构造 `VaultStore`，测试显式传 `createMutex()`；加一个 grep 测试，`src/` 里别处不得 `new VaultStore(`。
4. **清理一律用 `finishKeyChange(当前 VK, 回调)`**。回调能打开调用方手里的每一把旧密钥：keyring 的全部 previous，§3.5 入网时还有内存里的本机旧 VK。未知密钥下的副本先交给回调；打不开时同一 vaultId 保留、另一个 vaultId 丢弃。`staleIn` 把另一个 vaultId 的未知密钥副本算作陈旧（本库与镜像都是），否则清理不运行就清掉标记。这是对 A2 store 代码的改动。
5. **服务层只有一个清理入口**：先把 `sk_sync_cfg.enc` 与 `sk_prejoin` 重新加密到当前 VK，再调用 `finishKeyChange`。
   - 读取出错就停在 `finishKeyChange` 之前，标记保留，下次解锁重试。
   - 一把密钥都打不开时：`sk_prejoin` 保留（它永不自动删除）；`sk_sync_cfg.enc` 走 §2.5"副本无法解开"的一键重新入网。二者都不阻塞标记。
   - **入口（修订 10，A4 已实现）**：服务层的 `finishKeyChanges(vk, keyring, held)`。
     - `held` 是调用方内存里的旧密钥：轮换时是旧 VK；§3.5 入网时是本机的旧 VK，新 keyring 不列它。可用的密钥 = `held` + `keyring` 的全部 previous。
     - 它先依次调用每个 `VkRecord.reencrypt(current, held)`（M2 的 `sk_sync_cfg.enc`、`sk_prejoin`），再调用 store 的 `finishKeyChange`。
   - **`VkRecord.reencrypt` 的契约**（A4R-4）：
     - 读取、"活动 keyring 的 vkId 仍是 `current`"的检查与写入，是**同一个** `webLock("sixkey-vault")` 临界区；活动密钥已不是 `current` 时什么也不写，由较新的那次换密钥自己移动它。
     - 临界区内不回调 store 或 service。
     - 它**从不在锁内被调用**：`webLock` 不可重入，而 `afterCommit` 在锁内，所以清理不能从 `afterCommit` 里发起。
     - 读取抛错向上传播；`unopenable` 不阻塞标记。
     - M2 的两个真实记录各自要过 A4R-4 的交错测试：与两次轮换交错，结束时记录在最新的密钥下。
   - §3.5、§3.8 P4、§3.9 R3、解锁时的清理，以及 Phase 0 的 `housekeeping`、`scrub` 都经过这个入口；加一个 grep 测试，别处不得直接调用 `finishKeyChange`。
6. **采用一个不把本机旧密钥列为 previous 的 keyring 时，清理只靠标记触发**（不变）。
7. **`sk_store_v = {v: 2, vkId}` 是本库的状态**：本库（chrome.storage.local）清理完成时写。镜像另由仅限镜像的标记 `{v: 1, vkId, at, mirror: true}` 跟踪，直到之后的清理也确认镜像干净。`sk_keychange` 最后删除。
8. **`openVault` 的回退**（GM2-7，与 M2 的 previous-VK 回退是同一个循环）：收集读取失败。只要有读取抛错、而能打开的候选不是最新的，就抛错（界面显示重试），不提交较旧的副本——与 P-4 在 `recover()` 里的规则相同。**镜像例外**（修订 10，A4R-3，已实现）：
   - 读不出的镜像来源（镜像的 generation 或索引），在没有别的信息说明它多新时，按**活动槽的保存计数**算。镜像在本地提交之后以同一个计数写入，只有 GM2-8 那种本地尾部丢失才会让它更新；所以 IndexedDB 一直出错时，那次保存的本地副本仍能恢复。
   - 读不出的**本地索引**仍算作"可能比任何副本都新"。
   - 两个方向都有测试（`gm2-fixes.test.ts`）。M2 用 previous-VK 回退扩展这个循环时保留这条例外。
9. **身份记录**：按 §0.0f 第 1–5 条；D8 两个方向；M2 的故障测试见 §8"本地提交掉电、身份记录已写"。
10. **`capPrevious` 只在没有标记时执行**：先完成上一次清理，不丢掉一把仍有副本在它下面的 VK。
11. **有同步时，"数据无法读取"界面先提供云端恢复**（§4.13），再提供 `startOver`。`startOver` 会生成新的 vaultId，旧库的快照随后按第 4 条丢弃。
12. **keyring 逐字节稳定**（修订 10，A4R-11）：每个 keyring 差异（按 `canonicalJson`）都会写标记，下次打开时做一次完整清理；FIXa2、FIXb 也以它为准。所以 M2 不得把任何随保存变化的字段放进 keyring：同步状态放 `sk_sync_*`，`kver`、`adopted` 与钉住值在 bundle 或 IDB 里（§3.13：`Keyring` v1 不变）。
    - keyring 只在真正的密钥操作时改变：改密码、换恢复码、轮换（含 `capPrevious`）、采用远端 keyring，以及 §2.3 首次上传前的一次 `createdAt` 截断（一次标记、一次清理，是对的）。
    - 采用时本地写入的就是 `bundle.keyring` 本身。`canonicalJson` 排序键、丢掉 `undefined`，所以键顺序不同不算变化。
    - 加一个单元测试：普通 `mutate` 与 `applyRemote` 前后 `canonicalJson(keyring)` 不变。
13. **永久删除也覆盖另一个 vaultId 的副本**（修订 10，A4R-12）：§3.5 入网时为"找回账户"重新加密保留的旧库快照里，与被永久删除的条目 **secret 相同**的条目一并清除。added 模式给这些条目换了 id，只能按 secret 认。不整份丢弃那些快照，因为其中其余的已删账户仍可能要找回。SECURITY 与 PRIVACY 的"从 Sixkey 保存的每一份副本中清除"据此成立。
14. **恢复码只经过两条路离开 service**（修订 10，A4R-5）：
    - **先提交后显示**：必填的 `onCode`（`newRecoveryCode(password, deliver)`、`rotateKey`、`enableMasterPassword`），在提交后立即调用，码不作为返回值；
    - **先显示后提交**：`prepareReset` / `commitReset`，码先在内存里，用户确认已保存后才写入。
    - M2 里所有生成恢复码的流程都走"先显示后提交"并遵守同一纪律：码只在内存里，用户确认已保存之前服务器和本地都不写；service 不在清理完成后把码作为返回值交出。这些流程是 §3.1 第 4 步 (b)、§3.3 第 5 步、§3.7、§3.8 P1–P2、§4.2 修复第 2 步。
    - **残余**：页面在 `onCode` 里拿到码、却等调用的 promise 结算后才显示，能通过类型检查和源码规则，GM2-1(b) 的"从未显示"窗口就回来了。只能靠评审，加上界面测试：在调用的 promise 结算之前断言码已出现在屏幕上。
15. **YubiKey 预留**（修订 11，`docs/audit/internal-reviews/YUBIKEY-REVIEW.md` §7）。只是预留，M2 不实现任何 YubiKey 功能：
    - **R1**：`openVault` 的回退（含 M2 的 previous-VK 回退）与 `applyRemote` 遇到 `newer_schema` 时停下并抛出：不当作损坏，不回退到旧副本，不写恢复事件（`store.ts` 约 773、803、813 行现在就是这样）。加故障测试：活动槽放一份合成的 `schemaVersion: 2` 世代 → 抛 `newer_schema`，没有任何写入与恢复事件；`applyRemote` 同样。
    - **R2**：库只经 `emptyVault`、`parseVault`、`mergeVaults` 与 ops 构建（§3.13）；grep 测试检查 `schemaVersion: 1` 字面量只出现在 `model.ts`、`merge.ts`、`validate.ts` 与测试里。
    - **R3**：按 secret 判断条目身份的地方都走具名函数（如 `entryIdentity(e)`、`isPurged(e)`），不直接比较 `e.secret`。这些地方是：§4.4 守卫的 `secretChanged`、第 13 条的跨 vaultId 永久删除、§3.5 入网 added 模式的去重、§4.6"找回账户"。原因是 YubiKey 引用条目没有 secret。
    - **R5**：本机键名 `sk_prf`、`sk_oath` 保留，不放在 `sk_sync_*` 下。它们不算 `hasAnyData` 的库数据，"关闭同步 / 移除同步身份"（D11）也不碰它们。`vkRecords` 保持开放列表，A4R-4 的交错测试工具可以复用。
    - **R6**：M3 的 F6a 回溯遇到 `newer_schema` 的版本立即停下（`paused_newer`，§4.3）。引擎测试用合成的 v2 远端：不上传，outbox 保留，本地不变。
    - **R8**：安全记录只升一次版本（v: 2），一并加入 M2 的种类与将来的 `prf_enrolled`、`prf_removed`、`prf_failed`、`oath_on`、`oath_off`。v1 的读取方把 v2 记录当作"较新"并停止追加（`security-log.ts:149`），所以不要连升两次。**修订 25 取代了这一条**：记录在改写时保留不认识的种类与字段，新种类不再需要升版本（§3.13）。
    - R4（KeyBundle 只许 password + recovery 两个包裹）已由 `keybundle.ts` 满足，保留测试即可；R7 是 M5 改写 `check-dist` 时的评审项。
16. **`commitKeys` 只接受 M1 发出的能力对象，并自己执行不需要秘密的检查**（修订 12，M2R-4、Q3）。R2、R3 在 `commitKeys` 里强制，不留给 M3 的约定：
    - **能力对象**：M1 的 `evaluateSameVkBundle`（adopt）、`unlockWithSync`（adopt）与发布路径（服务器接受之后，§3.6.0）返回冻结、以 `WeakSet` 打品牌的 `Adoption` / `Published` 对象，带 bundle、它的 VK、要保留的旧 VK 与新的 `maxSeenKver`。`commitKeys` 只接受这两种（同一上下文规则，M1-19），所以 R2 的"`needs_new_password` 时不采用"与 R3 的检查由构造保证。
    - **连续性**：在 transact 回调里检查。同一 VK 时，previous 包含本地真实条目（`previousCovers(…, true)`）；否则新 keyring 的 previous 必须真的解出本地 keyring 的 vkId。
    - **云端恢复**（覆盖丢失数据）时：钉住的 vkId（若有）必须可达，vaultId 必须等于身份记录的。
    - `maxSeenKver` 从不降低。任何一项失败 → `bad_state("discontinuous")`，什么都不写。
    - **绑定到 M1 判断时的本地 keyring**（修订 14，RR-1、RR-2）：
      - 每个能力对象带 `base`，即 M1 据以判断的本地 keyring：`evaluateSameVkBundle` 与 `unlockWithSync` 的 `local`（云端恢复为 null），`published()` 则是签发其 `VerifiedServerBundle` 的发送前检查的 `local`。
      - M1 登记的是 bundle 与 `base` 的深度冻结副本，以及 VK 的副本；之后改动交给 M1 的对象，不影响提交的内容。
      - transact 内、其余检查之后，除非存放的 keyring 就是 `base` 或 bundle 自己的 keyring（同一次提交已落地后的重试），`commitKeys` 以 `bad_state("stale")` 拒绝，什么都不写。
      - 所以过时或被重放的能力对象写不进去；M3 丢掉它、重新判断。
    - **防锁死**：写入的 keyring 必须能被本次流程里证明过的秘密打开，满足其一：密码包裹与本地逐字节相同（别处只换了恢复码，R2）；`Adoption` 带着输入的秘密从 `bundle.keyring` 打开的 VK（R3、R6、云端恢复）；这台设备自己构建了它（`Published`）。GM2-5 的"采用回来"算作"这台设备自己构建了它"：本机提交过这一份 keyring，在锁内按 settle 之后的 `adopted` 重查（M2 的决定）。
    - **第一次上传（§3.1）不需要发行者，也不经 `commitKeys`**（修订 13）。`commitKeys` 拒绝裸 bundle，`published()` 又需要服务器 bundle，而 `init` 之前没有。规则是：
      - 本地 keyring 在 `init` 之前就已是将要上传的那一份——第 4 步之后、第 5 步之前，用一次本地 keyring transact 把全部 `createdAt` 截断到小时（已对齐时不写；它改变 keyring，所以照第 1 条写标记、做一次清理）；`init` 的 `bundle.keyring` 就是本地 keyring 本身。
      - 201 之后没有 keyring 要写，钉住值按"已同步"处理：`setPins({vkId, vaultId, maxSeenKver: 1, adopted: adoptedRecord(发出的 bundle)})`，再 `update` 写 `state: "enrolled"`、`maxSeenVersion = 1`，并 `cfg.setState("enrolled")`。
      - 结果不明、请求已丢失时：状态查询 200 之后，`GET /v1/keys` 的 bundle 经 `evaluateSameVkBundle` 得到 `in_sync`（本机 VK 验 MAC、keyring 与本地相同），钉住值同样写入。
      - **RR-12**（修订 14）：
        - `init` 的 bundle 用第 5 步之后读到的本地 keyring 构建。写好 `sk_sync_cfg` 之后，Phase 0 密钥操作就被拒了。
        - 写"已同步"的钉住值之前（201 之后，或上面的恢复之后），再确认本地 keyring 仍是发出的那份；不是就不写，按普通一轮处理。
        - 截断本身是带 `noSync` 的服务方法。
      - 理由：不新增能力对象。若把截断放在 201 之后、经 `commitKeys` 写入，崩溃在两者之间时，本地与服务器的 keyring 只差 `createdAt`；R2 的 `sameWrap` 按 `canonicalJson` 比较，会把它当成别处改了密码，要求重新输入。截断是 Phase 0 层的一次本地 keyring 改写，不在第 18 条的六个操作里；同步已开启时它以 `sync_on` 拒绝。
17. **钉住值随提交补齐**（修订 12，M2R-1）：
    - 在写 keyring 的 transact 回调里、提交之前，把这次要写的钉住值写成 `sk_sync_state.pendingPins = {vkId, vaultId, maxSeenKver, adopted}`，只含 id、哈希与 KDF 参数，没有秘密。它与 keyring 在同一个 LevelDB 里、先于提交写入，所以提交落地它就在；GM2-5 的尾部丢失则把两者一起丢掉。
    - 提交后 `afterCommit` 写 IDB 钉住值，再清除 `pendingPins`，两步都有保护。
    - 每次采用或发送前判断之前、每次解锁时调用 `settlePins()`：若 `pendingPins` 指的正是活动 keyring（`adoptedRecord({keyring: 活动, auth: pending.adopted.auth}).digest === pending.adopted.digest`），而且只往前走（同一库且 `pending.maxSeenKver ≥ identity.maxSeenKver`，或还没有钉住值），就写进 IDB；无论写不写都清除它。
    - IDB 一直写不进去时，判断改读 `pendingPins`。
    - 这补上了"钉住值写入丢失"的一边。否则 R1 按 `adopted.digest` 采用回来的规则会悄悄撤销用户自己的改密码或新恢复码（PROBE-1），同 VK 改密码之后诚实的 bundle 也会每轮被判 `auth_without_password`、连吊销都被拒（PROBE-2、2b）。
    - 测试：扩展崩溃矩阵里的"PINS BEHIND"行在 `settlePins` 之后消失；PROBE-1、2、2b 翻转。
    - **修订 14（RR-3、RR-4、RR-7、RR-9）**：
      - 待写副本还带 `deviceId`（它为之写入的身份）与 `prev`（那个身份在提交开始时的 `pinCount`）。
      - "只往前"改为：为这个身份写的、同一个库，并且满足其一：还没有钉住值、`maxSeenKver` 更高、或身份的 `pinCount` 仍等于 `prev`（提交开始之后没人写过钉住值）。`maxSeenKver` 是最大值，不是顺序。
      - 为别的身份或没有身份写的副本永不生效：较晚入网的新身份不继承过时的钉住值。
      - 写 IDB 与 settle 都先读回再清除副本，所以谎报写入成功的磁盘不会让副本被清掉。
      - 没有可读的 keyring（云端恢复）时，副本只往前地叠加在判断上，不写。
      - "关闭同步"在 vault 锁内进行。
18. **同步开启时 Phase 0 的密钥操作一律拒绝**（修订 13，M2R-3；M2-NOTES §4.1）。只要本配置文件有 `sk_sync_cfg`，`enableMasterPassword`、`rotateKey`、`changePassword`、`prepareReset`、`commitReset` 与 `newRecoveryCode` 就以 `sync_on` 拒绝：什么都不写、不记录，也不显示码。不拒绝的话，下一轮的"采用回来"会悄悄撤销它们（PROBE-4）。
    - 同步开启时的密钥操作是 §3.6–§3.8：先服务器，再 `commitKeys` 一个 `Published`。M6 把用户引到那里。
    - 不做"转接"：这些方法先本地提交，而 §3.6.0 与 §3.7 要求先服务器后本地，转接就得在服务层里做网络步骤。
    - 检查在每个操作自己的 transact 里，所以另一页面开启同步插不进来。
    - `prepareReset` 与 `newRecoveryCode` 另在检查任何秘密之前先查一次，所以被拒的调用不留 `unlock_failed` 或 `recovery_used`。
    - `commitReset` 在"已落地"检查之后才查，所以开启同步之前已落地的重设仍算完成。
    - §3.1 第 4 步 (b) 的新恢复码与随后的 `createdAt` 截断都在 `sk_sync_cfg` 写入（第 5 步）之前，不受影响。`startOver`、`restoreBackup` 不是这六个之一，它们按第 11 条先提供云端恢复。

**M1 代码改动**（纯函数，随 M2/M3 合入）：
1. **"内容相同"** = 本地 keyring 相同，或 `adoptedRecord(bundle).digest === adoptedDigest`，不论本地 keyring 在不在。`evaluateSameVkBundle`、`unlockWithSync`、`preSendCheck` 三处一致。
2. **内容相同、本地 keyring 却不同 → 采用回来**：同一 VK 立即采用（不返回 `needs_new_password`）；另一个 VK 走 R3。`preSendCheck` 此时返回 `needs_adoption`。
3. **`unlockWithSync` 在 `pinnedVkId !== local.vkId` 时按 R4 顺序先试远端**；R3 采用在本地 keyring 存在时要求真的解出它的 vkId。
4. **`afterLocal` 的 D8**：本地解不出钉住值时不动钉住值，并返回 `pin_ahead`，M3 据此置 `needs_password`。

## 0.0j 修订 10：A4 与 C6 合入后的 M2 交接（`docs/audit/internal-reviews/A4-REVIEW.md`、`docs/audit/internal-reviews/C6-REVIEW.md` C6-8）

**核实**：都对照合入后的代码核实过。
- `service.ts`：`finishKeyChanges(vk, keyring, held)`（:462）是唯一入口；可用密钥 = `held` + `unwrapPreviousVks(keyring, vk)`；它先跑 `vkRecords`，再调用 `store.finishKeyChange`。`VkRecord` 的契约注释（:73–92）已写明"一个临界区、从不在锁内调用"。
- `CodeDelivery = {onCode}` 是必填参数（:107），用在 `enableMasterPassword`、`rotateKey`、`newRecoveryCode(password, deliver)` 上；`prepareReset` / `commitReset` 在 :729、:759；两步重设在码被接受时就记 `recovery_used`（:743）。
- `store.ts`：读不出的镜像来源按活动槽的计数算，读不出的本地索引按 `Infinity` 算（:776–787），两个方向的测试在 `gm2-fixes.test.ts`。
- `options/Reset.tsx`：重设在设置页里，新密码有确认框；先 `prepareReset`，确认已保存后才 `commitReset`。
- C6-8：子集文件的 vaultId 每次导出都随机（`core/backup/subset.ts:120`），`restoreBackup`（`service.ts:815`）恢复时保留它。

**契约与向量不变。没有所有者问题。**

| 项 | 记录 | 文档改动 |
|---|---|---|
| 1 A4R-4 | 清理入口与 `VkRecord.reencrypt` 的契约 | §0.0i 第 5 条 |
| 2 A4R-3 | 读不出的镜像按活动槽的计数算；本地索引仍算作可能最新 | §0.0i 第 8 条 |
| 3 A4R-11 | keyring 逐字节稳定 | §0.0i 新第 12 条 |
| 4 A4R-12 | 永久删除按 secret 也清除另一个 vaultId 的副本 | §0.0i 新第 13 条；§7 SECURITY；§10 第 91 条 |
| 5 A4R-5 | 恢复码只经 `onCode` 或"先显示后提交"离开 service；M2 的生成码流程一律先显示后提交；残余写明 | §0.0i 新第 14 条 |
| 6 A4R-1 | 重设在设置页里进行，新密码输两次；§3.3 第 5 步用同一界面 | §3.3 |
| 7 待办 | 见下 | §9 M8 |
| 8 C6-8 | **决定**：vaultId 相同而密钥无关 → 按 vaultId 不同处理；不阻止同步 | §3.5；§10 第 92 条 |
| 9 H6 | 安全记录的种类清单，见下 | §9.1 H6 |

**仍要看得见的待办**（不阻塞 M2，标注了期限）：
- **GM2-8**（Low，推迟到 M2）：`selfCheck` 会覆盖比两槽都新的镜像 generation。M2 的服务器副本是更好的来源，但不开同步的用户没有服务器副本，对他们仍是 Low 的数据回退。
- **GM2-9**（Low，推迟）：永久删除在编辑提交之后被打断，secret 留在其余副本里，没有重试，要等轮换出局。要么加一个删除待办标记，要么写进 docs/security/local-vault.md。
- **GM2-2(b)**（Low，**发布前**）：FIXa2 回退一次密钥改动时没有面向用户的提示。加一个 `keychange_rolled_back` 事件与弹窗文字（A4R-7）。
- **A4R-9**（Info）：`touch()` 可能清掉刚完成的解锁；失败方向安全，暂不改。
- **A4R-10**（Info，原有问题）：在会谎报写入成功的磁盘上，没有读回的写入（快照重新加密、`startOver` 的标记）会让"标记仍在 ⇔ 有旧材料"的承诺失效。真实磁盘要么写成要么抛错。可选的修法：读回快照重写；`makeVault` 覆盖丢失数据后也跑一次清理。
- **SECURITY 文字**：未知密钥下的副本只对同一 vaultId 说"保留"（§7）。
- **A4R-3 的剩余情况**：只有较旧的副本能打开、而镜像读取一直抛错时，"重试"不会结束。评审建议最终提供"打开能读到的最新副本"，需用户同意并记一个事件。

**安全记录的种类**（`core/service/security-log.ts`，供 H6 与界面文字使用；只存 `{at, kind}`，最多 50 条）：
- `unlock_failed`：主密码错误，在锁屏，或导出、改密码、轮换前再次询问时。
- `recovery_failed`：恢复码错误，解锁或重设时。格式都不对的码算打错字，不记。
- `recovery_used`：恢复码被接受，在打开库之前就记。两步重设在码被接受时也记这一条，所以一次重设会显示 `recovery_used` 再加 `password_reset`。
- `export_encrypted`、`export_plain`、`export_subset`：导出之后由设置页记。
- 密钥变化：`password_enabled`（Phase 0 库设了主密码）、`password_changed`、`password_reset`（用恢复码）、`key_rotated`、`recovery_code_new`。
- `log_cleared`：清空记录（需要主密码）后留下的那一条，所以清空不是无声的。

"N 次错误"计数只算 `unlock_failed` 与 `recovery_failed`。M2 若要加种类（例如设备加入），版本号随之改为 v: 2，并与 YubiKey 的种类合并成一次升版（§0.0i 第 15 条 R8）。（修订 25：新种类不再升版本，见 §3.13。）

## 0.0k 修订 11：YubiKey 设计评审的预留（`docs/audit/internal-reviews/YUBIKEY-REVIEW.md` §7）

**核实**：`store.ts` 的 `openVault` 与回退循环在 `newer_schema` 时抛出（约 773、803、813 行，`tryOpen` 的 `newerSchema`）；`security-log.ts:149` 遇到较新版本的记录就不再追加。

**改动**：
- §3.13 与 I11：schemaVersion 改为按内容派生（评审的 New 行），同步代码不手写 `schemaVersion: 1`。
- §4.3：F6a 回溯遇到 `newer_schema` 时停下（R6）。
- §0.0i 新增第 15 条：R1、R2、R3、R5、R6、R8，并说明 R4、R7。这些都只是预留，M2 不实现 YubiKey。

不改契约、向量、envelope、KeyBundle 或服务器。没有所有者问题。

## 0.0l 修订 12：M2 评审（`docs/audit/internal-reviews/M2-REVIEW.md`）中与设计有关的决定

**核实**：
- 按 M2 工作副本（尚未合入主线）核实：`core/service/sync-flows.ts:180` 的 applyRemote 带 `keyChange: true`；`store.ts` 第 17 行的说明把 applyRemote 列为 `keyChange` 的用户；轮换在清理未完成时抛 `cleanup_pending`（`service.ts:692`），即 PROBE-9。
- 按主线核实：`security-log.ts:149` 是"较新的记录就不再追加"的检查，`:93` 是解析。

**契约与向量不变。** 没有所有者问题；第 18 条的规则待 M2 实现者给出。

| 项 | 决定 | 文档改动 |
|---|---|---|
| Q1 / M2R-10 | applyRemote 不写换密钥标记；`keyChange: true` 只留给 previous-VK 回退 | §0.0i 第 2 条；§4.6 |
| (a) M2R-4 / Q3 | `commitKeys` 只接受 M1 的 `Adoption` / `Published` 能力对象，自己检查连续性、钉住值可达与防锁死 | §0.0i 第 16 条；§3.9 |
| (b) M2R-1 | `pendingPins` 在 transact 里写进 storage.local；`settlePins()` 在每次判断之前把它只往前写进 IDB | §0.0i 第 17 条；§2.5 |
| (c) M2R-2 | GM2-5 状态下"需要先采用"只挡会发布或交出 bundle 的操作；紧急吊销永不被挡 | §3.9 R1 |
| (d) M2R-3 | 同步开启时 Phase 0 的密钥操作不得绕过同步流程运行；**规则待定**，等实现者的 M2-NOTES，不在这里预设 | §0.0i 第 18 条（占位；修订 13 已写入规则，§0.0m） |
| (e) | 安全记录的行号改为 `security-log.ts:149` | §0.0i 第 15 条；§0.0k |

## 0.0m 修订 13：M2 合入主线（`docs/design/notes/M2-NOTES.md`）

**核实**（主线代码）：
- `service.ts`：`noSync()`（:645）在六个操作的 transact 内各调用一次，`prepareReset`（:807）与 `newRecoveryCode`（:866）另在检查秘密之前先调用。
- `service-error.ts`：有 `sync_on`、`prejoin_exists`。
- `local/state.ts`：`sk_sync_state` 带 `pendingPins?`，并写明"保留别人的成员、锁内读-改-写"。
- `local/record-writers.ts`：`sk_sync_cfg.state` 写入时为 "pending"，`setState` 保持同步。
- `sync-flows.ts:344`：`commitJoin` 拒绝另一台设备或另一个 vaultId 的身份。
- `presend.ts:130`：`published()` 要求 `VerifiedServerBundle`。
- `keybundle.ts:199`：R2 用的 `sameWrap` 按 `canonicalJson` 比较，含 `createdAt`。这是第一次上传选择"截断在 `init` 之前"的依据。

**契约与向量不变**（第一次上传的 `init` 请求体不变）。**没有所有者问题。**

| 项 | 记录 | 文档改动 |
|---|---|---|
| 1 第 18 条 | 以 M2-NOTES §4.1 的规则替换占位：同步开启时六个 Phase 0 密钥操作以 `sync_on` 拒绝，什么都不写、不记录；检查在各自的 transact 内，`prepareReset`、`newRecoveryCode` 另在检查秘密之前先查 | §0.0i 第 18 条 |
| 2 格式与协议 | `sk_sync_cfg.state`（身份 state 的明文副本）；`sk_sync_state.pendingPins`；`sk_sync_state` 的写入规则（M3 遵守）；客户端错误码 `sync_on`、`prejoin_exists` | §2.5；§4.1；§3.13 |
| 3 第一次上传 | **决定**：截断在 `init` 之前，以一次本地 transact 完成；201 之后只写钉住值，按"已同步"处理；不新增发行者，也不经 `commitKeys`。这条决定解除了 M3 §3.1 本地部分的阻塞 | §0.0i 第 16 条；§3.1 第 4、6、7 步；§2.3 |
| 4 入网与身份 | `commitJoin` 只写进入网设备自己的身份；重新加入到新 vaultId 之前先替换身份 | §3.5 |
| 5 未做与部分完成 | 见下 | §3.13（Q2）；§9 M6 |

**未做与部分完成**：
- **M2R-14**（部分完成）：只有 `sk_prejoin` 的写入会读回校验——入网之后它是那个库唯一完整的副本，丢写则入网失败。记录重写与合并前快照的丢写仍是已知的 A4R-10 残余（`LIE_RESIDUAL`）。
- **M2R-15**：新错误码（`sync_on`、`prejoin_exists`、`cleanup_pending` 等）的界面文字由 M6 提供。
- **M2R-16**：超过 5000 条的库的 docs/security/local-vault.md 说明归文档负责人。C13 的规则是：新增时上限 5000，读取时上限 50 000；降级到 Phase 0 构建后读不了超过 5000 条的库。
- **可选的 `adopted.from` 加固**：不做。有了 `settlePins` 已不需要，而且它会改 M1 的 `AdoptedRecord` 格式。
- **Q2**：恢复钩子 fail closed，冗余修复不调用钩子，两点写入 §3.13。撤回 GM2-REVIEW 里"`beforeRecoveryWrite` 仍须看到这次写入"那一行（GM2-8）：清空 `lastSynced` 救不回被覆盖的较新镜像，保护它的是 GM2-8 自己的修法，开启同步时则靠服务器副本。

## 0.0n 修订 14：M2-FIX2（`docs/audit/internal-reviews/M2-REREVIEW.md` 的修复，已合入主线）

**核实**（主线代码）：
- `local/identity.ts`：`pinCount` 只由 `setPins` 加一（:115），`update` 不碰钉住值字段。
- `local/pins.ts`：`PendingPins` 带 `deviceId`、`prev`（:33）。
- `crypto/capability.ts`：每个能力对象带 `base`，并登记冻结副本（:29、:52）。
- `service/sync-flows.ts`：`commitKeys` 以 `"stale"` 拒绝（:267、:281）；`commitJoin` 在没有身份时也拒绝（:359）。
- `service.ts`：`noSync()` 仍只看 `sk_sync_cfg`（经 `sync.context()`）。

**契约与向量不变。没有所有者问题**：RR-6 已由所有者委托决定为接受。

| 项 | 记录 | 文档改动 |
|---|---|---|
| 1 RR-12 | `init` 的 bundle 用第 5 步之后读到的 keyring 构建；写"已同步"的钉住值之前确认本地 keyring 仍是发出的那份；截断是带 `noSync` 的服务方法 | §3.1；§0.0i 第 16 条 |
| 2 RR-6 | **接受残余**：`adopted_back` 只信任 IndexedDB；不加 `adopted.from`，不改 D8；写明攻击者需要什么与用户看到的后果（只影响同一 VK 的改动）；M5/M6 把"密钥已采用回来"显示为可见事件 | §1.3；§3.9 R1；§7 SECURITY；§9 M5 |
| 3 格式 | 身份记录的 `pinCount`；`pendingPins` 的 `deviceId`、`prev`；钉住值字段只经 `setPins` 改变；待写副本按 `pinCount` 排序（generation 随 storage.local 回退，digest 分不清 A → B → A）；`commitJoin` 没有身份时也拒绝；能力对象带 `base`，`commitKeys` 的 `bad_state("stale")` | §2.5；§4.1；§3.5；§0.0i 第 16、17 条 |
| 4 RR-10 | 同步守卫仍只看 `sk_sync_cfg`；`cfg_missing` 且库可读 = 没做完的"关闭同步"，M3 完成它，从不在这里跑同步轮次 | §2.5 |
| 5 | M2-FIX2 的变异与测试数字不写进设计文档 | — |
| 6 M5 | M6 的"同步设置"一节存在之前，不得发布"开启同步" | §9 M5 |

另按 M2-NOTES §9 的设计负责人清单补上了 RR-5（`sk_prejoin` 的自重试例外需要明文相同，§3.5）。

## 0.0o 修订 15：M4 后端（`docs/audit/internal-reviews/M4-REVIEW.md`、`docs/design/notes/M4-NOTES.md`）

**核实**（`api/server/sixkey_server`）：
- 已与评审一致：
  - 设备行 `FOR NO KEY UPDATE`（`routes/common.py:41`）；
  - `enrollments.name_ct`（`migrations/0001_sixkey.sql:106`）；
  - `expires_at` 向上取整到分钟（`routes/enroll.py:44`，`minute_ceil`）；
  - 轮换的检查顺序：幂等 200 → `keys_conflict` → `version_conflict` → 写入证明 → `pw_auth` → P4（`routes/keys.py`）；
  - 超过 8 MiB 的 envelope 在 schema 之前回 413（`pipeline.py:320`）。
- 修订 15 写作时主线还缺的三项修复，**已由 M4 修复轮完成**（修订 16 核实）：
  - `SIXKEY_ENV` 必须显式为 dev、test 或 production（`config.py:96–98`，S12）；
  - 死锁与串行化冲突 → 503 + `Retry-After`（`db.py:26–27`），删除账户在服务器端重试一次（`routes/account.py`，S7）；
  - `reject-all` 只删 `created_at ≤ minute_floor(签名的 Sixkey-Ts)` 的请求（`routes/enroll.py:281`）。

**所有者问题**：没有。重放的决定已由所有者委托。

**重放（S9 / A2）**：不加 nonce 缓存；六种残余写入 §1.2 A6、§5.2、§7 的 SECURITY 计划文字与 §10 第 93 条；采纳 `reject-all` 的时间戳缓解。

**M4 的偏离，本文采纳**：
- 设备行 `FOR NO KEY UPDATE` 与全局锁顺序（设备 → 库 → 入网），删除账户级联是唯一反序，答 503 + `Retry-After` 并重试一次（A1、S7）；
- `enrollments.name_ct`（A3）；
- `PUT /v1/keys` 与轮换的幂等 200 排在一切证明之前（A5）；
- 超过 8 MiB 的 envelope 在 schema 之前 413（A8）；
- `expires_at` 向上取整到分钟（A13）；
- 设备 ID 被占用时 complete 答 409 `enroll_state`（A16）；
- `SIXKEY_ENV` 必须显式给出（S12）。

**A1–A30 的决定**（"接受"指以服务器的做法为设计，写在所列位置）：
- A1 接受（§5.3）；A2 接受、不加缓存（§5.2）；A3 接受（§5.3）；A4 接受（§5.4，契约本来就对）。
- A5 接受（§5.3）；A6 接受（§5.3）；A7 接受（§5.3）；A8 接受（§5.4）。
- A9 接受：上限对所有端点成立（§5.2）；A10 接受（§5.5）；A11 接受（§5.4）；A12 接受（§5.3）。
- A13 接受（§5.3）；A14 接受（§5.4）；A15 接受（§5.4）；A16 接受：保留 `enroll_state`，不加 `device_exists`（§5.3）。
- A17 接受（§3.2、§5.3、§9 M5）；A18 接受（§5.2）；A19 接受（§5.2）；A20 接受（§5.2）。
- A21 接受（§5.5）；A22 接受，次数先占用（§5.5，S1）；A23 接受（§5.2）；A24 接受（§5.8）。
- A25 不变（§5.2 已如此）；A26 → M8 清单第 6 项；A27 接受（§5.1）；A28 保留作防御（§5.4）。
- A29 不变；A30 → §9 M5（TS 契约测试对 `make run`）。

**M0 实现者要改的契约**（契约文件不由本文改动）：
1. `EnrollCreateResponse.expires_at` 与 `EnrollListItem.expires_at`：`Ms` → `MinuteMs`。`MinuteMs` 的说明改为"整数倍的 60 000 ms（UTC 分钟边界）：`created_at` 向下取整，`expires_at` 向上取整"（A13）。
2. `POST /v1/enroll/reject-all` 的说明（A2、A14）：只删除 `created_at ≤ minute_floor(Sixkey-Ts)` 的打开请求，批准与恢复码请求都算；`rejected` 计未过期的那些。
3. `x-sixkey-signature.no_nonce_cache` 的说明：把"唯一例外是改名"改为六种残余并引用 §5.2。
4. `PUT /v1/keys` 与 `POST /v1/keys/rotate` 的说明写入检查顺序（A5）。轮换另写：两个前提都过时先 `keys_conflict`（A7）；`device_names` 的规则（A6）。
5. `EnvelopeText` 的说明：先按 UTF-8 字节数检查，超过 `MAX_ENVELOPE_BYTES` 回 413 `too_large`，在 schema 之前；`maxLength` 只是 schema 层的上界（A8）。
6. 在 `x-sixkey-errors` 里给每个操作（或通用错误集）加 413 `too_large`：没有正文的操作同样受 64 KiB 上限（A9）。
7. `x-sixkey-rate-limits`：
   - `invalid_proof_per_device` 的规则写明超出时 429 + `Retry-After`、不写库（A10）；
   - `otp_verify_code` 的键改为"email（HMAC），发送新码时清零"，并写明格式错误的邮箱回 401 `otp_invalid`（A22）；
   - 新增 `session_writes`（30/60 s）与 `session_reads`（60/60 s），键为账户会话，适用于 `GET /v1/account`、init、发起入网（A21）；
   - 写明入网中的设备以 `enroll:{rid}` 为键并计入账户上限。
8. `POST …/{rid}/reject` 的说明：设备一侧缺少证明 → 403 `password_mismatch`，不计数（A11）。
9. `POST …/{rid}/complete` 的说明（A16、A17）：同一 rid 的重试 → 410；设备 ID 被占用 → 409 `enroll_state`；批准路径带 `name_ct` → 422；恢复码路径的 `name_ct` 可省。
10. `respond` / `reveal` / `approve` 的说明：相同重试 → 200，值不同 → 409；重复 approve → 409（A15）。
11. `GET /v1/sync/status` 的 `pending_enrollments` 与列表的说明（A14）：只计未过期、pending 的批准请求；恢复码请求不列出，GET → 410。
12. 请求严格性的说明（A18）：重复键、NUL、孤立代理项 → 422；整数记号规则也适用于 envelope 原文。
13. `name_ct.vkId` 的规则写进 init、approve、complete、改名、fork 的说明（A19）。
14. 入网中或设备都可调用的端点的认证说明：签名者请求头恰好一个，`Sixkey-Enroll` 等于路径 rid（A20）。
15. `POST /v1/auth/verify` 的说明：立即登出失败 → 503（A23）。
16. 若 `devices_rev` 的说明列了触发条件，加上"`auth_failures` 清零"（A12）。

**M0 实现者要加的向量**（`contract/vectors/sync-v1.json` 的 `wire_examples` 反例）：
- 重复对象键、NUL 字符、孤立代理项、envelope 原文里的非整数记号（A18）；
- `expires_at` 为 60 000 倍数的入网创建响应示例（A13）。

**本文改动**：
- §1.2 A6；§5.1（布局、`SIXKEY_ENV`）；
- §5.2（重放、A9、A18–A20、A23）；
- §5.3（锁、A3、A5–A7、A12、A13、A16、A17）；
- §5.4（A4、A8、A11、A14、A15、A28）；
- §5.5（A10、A21、A22）；§5.7（503）；§5.8（A24）；
- §3.2（complete 的措辞）；§7（SECURITY）；§8（锁的测试）；
- §9（M8 核对清单、M5 行）；§10 第 41 条，新增第 93、94 条。

## 0.0p 修订 16：M4 修复轮（`docs/design/notes/M4-NOTES.md` §9、§10）

**核实**（`api/server/sixkey_server`）：
- `migrations/0002_least_privilege.sql` 存在。
- `config.py:96–98`：`SIXKEY_ENV` 必须显式给出。
- `db.py:26–27`：死锁与串行化冲突 → 503。
- `routes/enroll.py:281`：`reject-all` 按 `minute_floor(ctx.ts)`。
- `config.py:37–39, 64–68` 与 `__main__.py:35`：选定的限额与 uvicorn 参数。
- `pipeline.py:247`：`ip_key`；`pipeline.py:262`：JSON 的 `Content-Type`。
- `account_session.py:72`：`role` 与 `aud`。

**没有所有者问题。** 按账户的有效证明桶覆盖吊销与轮换。它不违背"紧急吊销永不被挡"：无效证明进不了这个桶，所以只持有副本、不知道密码的人填不满它；知道密码的人本来就能直接吊销真设备（A3 的残余），限额不改变这一点。

**本文改动**：
1. §0.0o 的核实段：三项修复已完成。
2. §5.1 与 §9 M8 第 6 项：两个迁移，应用 0002 之前的核对。
3. §5.5：服务器选定的限额（有效证明 60/60 s、envelope 字节每设备 256 MiB/h 与每账户 1 GiB/h、8 个大正文槽位与 10 s 等待、60 s 正文超时、每表 200 000 个键、uvicorn 256 与 5 s、连接池 5 s）；IPv6 按 /64，IPv4 映射按 IPv4。§5.4：JSON 的 `Content-Type`。§5.2：`aud` 与 `role` 都恰好是 `authenticated`。
4. §4.14 与 §9 M5：请求签名一律用校正后的时间。残余：同一分钟内的 `reject-all` 重放（§5.2 第 2 项已写）、外键 ERROR（§5.6）。
5. 不做的项：S4 的坏签名桶、S3 的窗口提前（§5.5、§10 第 95 条）。**I3**：reveal 时服务器不校验 `commit`，承诺由批准方按 P1/MUST 1 校验。在服务器上加它是设计变更，只能早点挡掉有缺陷的新设备，所以不做。
6. §9 的 M8 清单改为与 M4-NOTES §10 一致的 14 项。

**M0 实现者要改的契约**（`api/openapi.yaml`；契约文件不由本文改动）：
1. `x-sixkey-rate-limits.limits` 新增三条，标 `"source": "m4"`。字节限额加一个成员 `"unit": "bytes"`（现有条目计的是请求数）：
   - `proof_valid_account`：key account，limit 60，window_s 60；适用于带有效 `password_auth` 或 `recovery_auth` 的请求，含吊销与轮换；section "§5.5"。
   - `device_envelope_bytes`：key device，limit 268435456，window_s 3600，unit bytes；适用于每个不带有效证明、带 envelope 的请求（`POST /v1/vault/init`、`PUT /v1/vault`、`POST /v1/keys/rotate`），失败的也算，不退还。
   - `account_envelope_bytes`：key account，limit 1073741824，window_s 3600，unit bytes；适用于每次 envelope 写入，401/403 退还。
2. `x-sixkey-rate-limits.rules`：
   - 改写 "Revocation and rotation are never subject to the account-level ceiling (F8)" 为：它们不受 `account_writes` 约束，但受 `proof_valid_account` 与 `account_envelope_bytes` 约束；无效证明进不了 `proof_valid_account`。
   - 新增：IP 键按 IPv4 地址或 IPv6 的 /64 计，IPv4 映射的 IPv6 按 IPv4。
   - 新增：每张限流表至多 200 000 个键，满了以后新键 429。
3. 一条通用的请求规则（放在 `info.description`，或新的 `x-sixkey-request-rules` 列表）：
   - 带 JSON 正文的每个操作要求 `Content-Type: application/json`，不区分大小写，只允许 `charset=utf-8`；在读正文之前检查，否则 422 `invalid_request`。
   - 这个 422 已在每个带正文的操作的 `x-sixkey-errors` 里。
4. `components.securitySchemes.accountSession.description`：把 "aud = authenticated" 改为 "aud must be exactly the string authenticated (not a list) and role must be authenticated"。
5. 503 `unavailable` 的说明（`x-sixkey-error-codes.unavailable`）加上它的来源：取连接超时（5 s）、大正文槽位等待超时（10 s）、正文读取超时（60 s）、可重试的数据库冲突，并带 `Retry-After`。另写明：超过 `limit_concurrency` 时的 503 由服务器进程直接给出，**没有** JSON 错误体；客户端对任何 503 一律按 `unavailable` 处理。
6. `POST /v1/enroll/reject-all` 的说明（修订 15 已列）补一句：这个范围用的是客户端签名的 `Sixkey-Ts`，客户端用校正后的时间签名（§4.14）。

**向量**：不变。

## 0.0q 修订 17：M4 修复轮的复审（`docs/audit/internal-reviews/M4-REREVIEW.md`，结论：合入）

按复审核对（`api/server/sixkey_server`）：
- 字节预算只在有设备行时计入，计的是整个请求正文（`pipeline.py` `charge()`：`self.device is not None`，`n = len(self.raw)`）；
- OTP 每码次数只按邮箱计（`routes/auth.py`，`ov:` + email）；
- 计数表满时 `incr` 的结果让 `verify` 答 `otp_invalid`；
- `Content-Type` 检查接受 `utf-8` 与 `utf8`（可带引号），并忽略其他参数（`pipeline.py` `json_content_type`）。

契约与向量本次不变；"待 M4 清理"的项已在修订 18 定下，契约改动见 §0.0r。没有新的所有者问题：RR6 已由所有者委托决定为 Phase 1 接受。

| 项 | 记录 | 文档改动 |
|---|---|---|
| RR6 | **接受，Phase 1 写明**：按邮箱或 IP 计的 OTP 桶（每码次数只按邮箱计；每邮箱每天 50 次发送）不经认证就能被填满，针对某个邮箱拒绝恢复码入网、入网、init 与删除账户的二次确认最长约 24 小时；不暴露任何数据。缓解由 M8 选定：Supabase 一侧的保护（如 CAPTCHA，因 API 代理 `/otp` 需要改契约），或第三方耗不尽的校验失败策略 | §1.2 新增 A11；§5.5；§10 第 96 条；§9 M8 清单第 15 项 |
| RR5 | 从不直接暴露 uvicorn：M8 代理必须有请求与请求头读取空闲超时、按 IP 的连接上限、短于 60 秒的正文读取超时；`limit_concurrency` 大于代理的连接上限 | §9 M8 清单第 10 项；§10 第 97 条 |
| RR2 | 全局的大正文槽位池在验签之前占用：记录为残余（S3） | §5.5；§10 第 95 条 |
| RR4 | 核对代理把客户端追加在 `X-Forwarded-For` 最右边，并加多值测试 | §9 M8 清单第 10 项 |
| 0002 | 确认 `0002_least_privilege.sql` 真的生效（非属主的 `REVOKE … FROM PUBLIC` 只给 WARNING）：后置条件 `DO` 块，或对项目跑 `test_db_roles.py` | §9 M8 清单第 6 项 |
| RR1 | 轮换的 422 路径与 init 的字节预算：**已定（修订 18，§0.0r）**——解析失败的正文付所有适用的桶；init 按账户会话计 | §5.5 |
| RR3 | 计数表满时 OTP 校验答 429：**已定（修订 18，§0.0r）**——429 + `Retry-After: 60`，不询问 provider；RR3b（共用一张表）记录 | §5.5；§9 M8 清单第 13 项 |

**契约实现者报告的四处服务器与文档差异**，修订 17 记为"待 M4 清理"，**修订 18 已定**（§0.0r）：
1. init 按账户会话计入字节预算（`session_envelope_bytes`），不计入设备与账户的预算；
2. 字节预算计整个请求正文，解析失败的也算；
3. OTP 计数表满时答 429；
4. `Content-Type` 恰好按 §5.4。

## 0.0r 修订 18：M4 清理轮（`docs/design/notes/M4-NOTES.md` §10、§11）

**核实**（`api/server`）：
- `config.py:43`：`session_envelope_bytes`；`pipeline.py:154`：按会话以 `len(self.raw)` 计。
- `routes/auth.py:64`：计数表满 → 429，`retry_after=60`。
- `pipeline.py` `json_content_type`：只认 `application/json` 与可选的 `charset=utf-8`。
- `migrations/0002_least_privilege.sql` 末尾的后置条件 `DO` 块。

**接受为设计**：
1. **字节预算的归属**：init 只付按账户会话的预算（`session_envelope_bytes`，1 GiB/h），不付设备与账户的预算。轮换、吊销、其他带 `pw_auth` 的操作与注册类操作，正文无法解析（422/413）时也付所有适用的桶。
2. 字节预算计**整个请求正文**（含无法解析的正文），不只算 envelope 原文；§5.5 的"envelope 字节"即请求正文字节。
3. OTP 每码计数表满 → 429 `rate_limited` + `Retry-After: 60`，不询问 provider。
4. `Content-Type` 恰好按 §5.4；客户端只发 `application/json`（§9 M5）。
5. 0002 改过（以 `public` 与数据库的属主运行；后置条件报错即回滚；记录过旧 0002 的本地数据库 `make pg-reset`）：§5.1、§9 M8 第 6 项。
6. M8 清单与 M4-NOTES §10 对齐（第 6、10、13、15 项；去掉已解决的第 16 项）。

**A21 的决定**（本文作为设计负责人决定，**不是所有者问题**）：
- 入网中的设备（`enroll:{rid}`）**不计入** `account_reads`、`account_writes`，只受它自己的按 rid 限额（`device_reads`、`device_writes`）、每会话 1 个待处理请求与 OTP 发送上限约束。
- 理由与"init 不计入账户字节预算"相同：只控制邮箱的人不应能影响主人的设备（§1.2 A2）；约 20 个会话以上限轮询就会让主人的状态查询 429。代价只是服务器负载。
- 这需要契约改动（下面第 6 条）与服务器改动（M4 的后续）。

**M0 实现者要改的契约**（`api/openapi.yaml`，`x-sixkey-rate-limits`）：
1. `device_envelope_bytes.applies_to` 去掉 init，改为："`PUT /v1/vault` and `POST /v1/keys/rotate` requests without a valid proof, counted by the whole request body including bodies that fail to parse (422/413); never refunded"。
2. `account_envelope_bytes.applies_to` 去掉 init，改为："every `PUT /v1/vault` and `POST /v1/keys/rotate` request, valid proof or not, counted by the whole request body including bodies that fail to parse; refunded when the request ends in 401 or 403"。
3. 新增条目 `session_envelope_bytes`，section "§5.5 (§0.0r, M4 RR1)"：
   ```
   {"id": "session_envelope_bytes", "key": "account session", "limit": 1073741824, "window_s": 3600,
    "unit": "bytes", "source": "m4",
    "applies_to": "POST /v1/vault/init only, parsed or not, counted by the whole request body; refunded when the request ends in 401 or 403"}
   ```
4. 规则 "A limit with unit bytes counts request bytes; every other limit counts requests" 改为："A limit with unit bytes counts the whole request body's bytes, including a body that does not parse (422 or 413); every other limit counts requests."
5. 新增规则："A request whose body does not parse carries no valid proof and pays every bucket that applies to it (device_writes, the account ceiling, device_envelope_bytes and account_envelope_bytes; for init, session_writes and session_envelope_bytes)."
6. 规则 "An enrolling device (Sixkey-Enroll) is limited like a device keyed enroll:{rid} (device_writes, device_reads) and counts toward the account ceiling" 改为："… keyed enroll:{rid} (device_writes, device_reads); it does not count toward account_reads or account_writes (§5.5, §0.0r A21)"。
7. 规则 "Each limiter table holds at most 200000 keys; a request that needs a new key once a table is full gets 429 rate_limited" 后加 "with Retry-After 60"；`otp_verify_code.applies_to` 加："if the counter table is full and this email has no counter yet, 429 rate_limited with Retry-After 60, and the provider is not asked"。
8. 规则 "Requests rejected with 401 or 403 never count against any quota, with one exception: device_envelope_bytes …" 不变，但要与第 1 条一致（`device_envelope_bytes` 不含 init）。
9. `x-sixkey-request-rules.json_content_type.rule` 写到逐字精确："the media type is application/json, case-insensitive, optionally followed by one parameter charset=utf-8 (case-insensitive), with optional whitespace around the ';'. charset=utf8, a quoted value, any other parameter, a trailing ';' and 'charset = utf-8' are 422."

向量不变。

## 0.0s 修订 19：M3 复审（`docs/audit/internal-reviews/M3-REREVIEW.md`）

**核实**：
- 按 M3 的复审副本（`m3-rereview-r18`，尚未合入主线）：
  - `local/outbox.ts`：outbox 已记下 `base`、`head` 与 `from`；`lastSynced` 为 null 时写入器删除 outbox。
  - `local/state.ts`：`clearLastSynced` 同时清 outbox，并被入网、云端恢复、密钥提交共用。
- 主线的 `core/sync/local/state.ts` 也是这样。所以孤儿必须放在单独的键里。

**D1 的新规则**（M3RR-3，所有者委托决定；没有所有者问题）：
- 恢复前钩子只清 `lastSynced`，把 outbox 原样移到 `sk_sync_orphan`。
- 孤儿只在服务器 (version, head) 恰好等于它记下的基准时推送，409 时保留。
- 持有 VK 的上下文在每一轮开头，把孤儿作为"本机自己较早的状态"的第二个远端并入（常规的打开、夹紧、守卫），无论这一轮之后怎样结束。
- 只在三种情况退役：推送 200；设置 `lastSynced` 的同一次写入；校验和相等。
- 打不开时保留，直到能打开；只有密钥确已永远消失时才移除。
- 至多一个，不按时间老化。
- 替换或重新加密本机库的流程先并入它：入网、云端恢复、R3、轮换、关闭同步。
- 它不是 `VkRecord`。完整规则见 §4.7；另改了 §3.5、§3.10（D11）、§3.11、§3.13、§4.1、§4.2、§8.2、§9 M3 与 M5 两行、§10 第 30、72、98 条。§0.0c 的 D1 历史行保持原样。

**其他决定**：

| 项 | 决定 | 文档改动 |
|---|---|---|
| M3RR-1 | 轮换在第一次发送之前记待确认记录（以新 `vk_id` 为键），重试时先对账（`GET /v1/keys`）再"先合并"：已生效 → 提交；别处的改动 → `changed_elsewhere`。服务器可能已持有时，绝不报"没有生效"或 `not_synced` | §3.6.0；§10 第 99 条 |
| M3RR-6 | "未生效"的十分钟用校正后的时钟，从最后一次签名算起；M5 的请求超时至多 60 秒（上一条成立的前提） | §3.6.0；§9 M5 |
| M3RR-2 | 每个 503 都计入退避（`Retry-After` 为下限）；429 只有在仍在退避中时用户显式发起的那一轮不计 | §4.8 |
| M3RR-4 | 密钥操作像一轮那样持有 `sixkey-sync`；SW 的传输函数仍不取它 | §4.9 |
| M3RR-5 | 每个非豁免写入在发送时检查 `min_client_version`（含 `commitRecoveryCode`）；M4 不强制它，它是安全阀 | §5.2 |
| M3RR-9 | 停下的一轮从不把存下的服务器时差重置为 0；新启动先读入存下的值 | §4.14 |
| M3RR-13 | M8 的 PITR 恢复栅栏：拒绝早于恢复时间的签名（`401 clock_skew`）；之前记为 §1.2 A5 的暂时性残余 | §1.2 A5；§5.2；§9 M8 清单第 16 项；§10 第 100 条 |
| FS-1 | FakeServer 的 `Content-Type` 宽松只是测试替身的问题；应改为与 §5.4 一样精确 | §8.5 |

契约与向量不变（恢复栅栏是服务器的运维规程，不改接口）。

## 0.0t 修订 20：M3 第三次评审（M3-R3-REVIEW，结论：修复后合入）

所有者把这类决定委托给维护者，维护者交本文决定。没有所有者问题；契约与向量不变（`vault_lost` 与搁置提示都是客户端的结果，不是 API 错误码）。

| 项 | 决定 | 理由 |
|---|---|---|
| R3R-1 | **降级而不丢弃**：一份未经 200 确认的 outbox，只有在本轮已合并的库包含它时才能删除。允许删除的只有：完整一轮"无需上传"时、CAS 写入 `lastSynced` 时、清 `lastSynced` 的流程删除仍有效的 outbox 时。其余一律在 vault 锁内用一次写入追加到孤儿列表、清空 `lastSynced`，与恢复钩子同一次写入。已有孤儿时也是追加，从不覆盖 | 原型（评审的 `R3R-1-demote.patch`）在已有孤儿时会丢弃新的那份；列表让这种情况也不丢 |
| R3R-5 | **选第一种**：`lastSynced` 为空时，写只用于合并的 outbox（没有写入证明，从不推送，覆盖上一份——最新的 generation 包含之前每次保存）；恢复钩子把它追加为列表的新条目 | 同一个写入器、同一个键，只是少了推送字段；"孤儿里放并集"要在 popup 的提交里解密并合并（违反 popup 的模块规则与读取预算）；接受风险则违背"永不丢数据"，而窗口可能长达几周 |
| R3R-4 | **搁置**：暂时打不开的条目（FIXa2 的较新 VK、较新的 schema、超过条目上限）留在列表里，但不计入不变式。同步照常设置 `lastSynced`，轮换不再 `not_synced`；每次持有 VK 的一轮都重试。界面持续提示原因与出路，"高级"里可在确认后删除 | 否则一份读不了的条目让设备永远停在完整一轮，连"吊销并保护"都轮换不了 |
| R3R-2 | **保留，不拒绝**：关闭同步、移除同步身份、撤销入网，先并入能打开的条目；搁置条目保留（`sk_sync_orphan` 不随 D11 删除），界面同上 | 关闭同步与移除身份是紧急出口，不能被一份读不了的保存挡住；保留不丢数据 |
| R3R-3 | 本机库丢失或为空时，这些流程与并入返回 `vault_lost`（不是 `locked`），界面引导去云端恢复或从备份恢复 | 那里没有什么可解锁的 |
| R3R-6 | 两个撤销用入网输入里的 `answer`，与入网自己的合并共用复核界面；也可由 `round({answer})` 回答 | 一个复核界面，两条等价的路 |

**规则正文**见 §4.7 的"孤儿 outbox"；另改了 §3.5、§3.10（D11）、§3.11、§3.13、§4.1、§4.2、§4.4、§6 O12、§8.2、§9 M3 与 M6 两行、§10 第 98 条，新增第 101、102 条。§0.0s 里"至多一个孤儿"的说法是修订 19 的历史，以 §4.7 为准。

**M3 实现者要改的**（对照评审的探针测试）：
1. **降级**：`lockedRound` 里三处 `dropOutbox`（`write_denied` 且密钥已变、409、服务器不在 (base, head)）改为降级。在 vault 锁内，outbox 仍是 `ob` 时，用一次写入追加到列表、清空 outbox 与 `lastSynced`；已有条目时也追加。评审原型里"已有孤儿就丢弃"的分支要去掉。完整一轮"无需上传"与 `casLastSynced` 的删除保留。
2. **`sk_sync_orphan` 改为 `{v: 1, items: [...]}`**，恢复钩子改为追加；`clearingItems` 等清 `lastSynced` 的路径仍不碰它。
3. **写入器**：`lastSynced` 为空时写只用于合并的 outbox，而不是删除：`{v: 1, from: null, checksum, envelope}`，其中 `envelope` 就是刚提交的 generation 自己的本地 envelope 原文（本地 `rev`，不重新加密、不填充），没有 `base`/`head`/`proof`；超过 `MAX_ENVELOPE_BYTES` 时不写。推送路径跳过没有写入证明的记录。
4. **并入、退役、推送按条目**：
   - 第 0 步并入全部能打开的条目；
   - 守卫按各条的 `seen` 绑定；
   - 设置 `lastSynced` 的那次写入退役本轮并入的条目，"无需上传"的分支也一样；
   - 推送 200 退役相符的那一条；校验和相等的退役。
5. **搁置**：打不开（vkId 不在当前链里但不能断定已永远消失）、`newer_schema`、超过条目上限的条目标为搁置，不阻止设置 `lastSynced`，每轮重试。`orphanLockedOut` 与"必须先并入"的判断只看未搁置的条目。
6. **关闭同步、移除同步身份、两个撤销**：先并入能打开的；搁置条目保留，`sk_sync_orphan` 不随 D11 删除；只在完全没有条目时才删这个键。同步关闭之后，设置页解锁时重试本机并入搁置条目（不依赖同步引擎）。
7. **`vault_lost`**：`orphanLockedOut` 与 `foldForFlow` 把"本机库丢失或为空"与"锁定"区分开，返回 `vault_lost`。
8. **R3R-6**：`requireOff` 把 `i.answer` 传给并入；M3-NOTES §1.2 写明 `round({answer})` 也能回答。
9. **测试**：
   - 评审的探针 R3R-1、-1b、-1d、-2b、-5、-7 改为必须通过；R3R-3、R3R-4 改为断言新的 `vault_lost` 与搁置行为；
   - 模型加上"别处写入 → 锁定推送 → 撕裂"的 tear 顺序；
   - §8.2 列出的修订 20 用例。

## 0.0u 修订 21：M5 评审的 D-1 与 M-1（M5-REVIEW §2、§5、§7）

维护者受所有者委托决定，交本文定稿。**决定：采用可选 host 权限。** 没有所有者问题。

**核实与推理**：
- **授权之后 SW 能连**：有 host 权限的扩展页面与 SW 发跨源请求不受 CORS 约束；可选权限授予之后与必需权限效果相同，对整个扩展立即生效，`onAdded` 触发。
- **CSP 仍须列出 origin**：CSP 不是权限。M5 评审验证过：manifest 的 `connect-src` 为 `'none'` 时，有 host 权限的 SW 也被拦。
- **请求必须在用户手势里**：`chrome.permissions.request` 要在用户手势里、在任何异步步骤之前调用，所以放在开启或加入那一次点击的最前面，在主密码与 OTP 之前。OTP 本身就要联网。
- **SW 的唤醒**：alarms 唤醒 SW 与权限无关，所以不会出现"授权了却唤不醒"的问题。
- **找到的一个必须同时改的地方**：服务器的 CORS。M4 对 `SIXKEY_CORS_ORIGINS` 里的来源放行预检，并允许全部 `Sixkey-*` 头（`main.py:68–91`）。若生产环境按原计划放行商店扩展 ID，没有授权的商店构建也能经 CORS 连上 API，可选权限就不是网络开关了。所以 M8 把它设为空（§5.2、§9 M8 第 11 项）。服务器代码与契约都不用改，契约里没有 CORS 来源。
- **授权之前能发出什么**（修订 23 更正）：
  - 引擎与 SW 的传输层在每次请求前检查权限，所以诚实的代码什么都不发。
  - 跳过检查的代码仍能让一个 CORS 简单请求整个送达（正文也到达）；只有带引擎请求头的请求会被缩减为预检。
  - 这样的请求不带会话与签名，响应也读不到（生产环境没有 CORS）。原来"至多一个空预检"的说法不对。
- **未核实**：自动化测试能否接受 Chrome 的权限弹窗。所以 e2e 构建声明必需的 host 权限，弹窗是一项人工检查。

**改动**：
- §7：manifest、CSP、页面 `<meta>`、check-dist、`network.spec`、商店说明、PRIVACY 与 SECURITY 的计划文字；
- §3.1 第 1 步；§3.10；§4.9；§5.2 的 CORS；§6 O1 与 O12；
- §9 M5、M6 两行与 M8 第 11 项；§0.2 D1 的注；§10 第 103、104 条。

契约与向量不变。

**M-1 的决定**：采纳，作为 §7 的规则。
- 每个页面的 `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">` 放在第一个 `<script>` 之前，check-dist 断言。
- 交集语义：页面同时受 manifest 与 `<meta>` 两份策略约束，请求须同时满足。
- `<meta>` 策略只约束其后加载的内容，`connect-src` 可经 `<meta>` 下发。
- SW 没有文档，不受页面策略约束。

**M5/M6 实现清单**：
1. **manifest**：
   - prod 与 dev：`optional_host_permissions: [origin]`，没有 `host_permissions`；e2e：必需的 `host_permissions: [origin]`；
   - CSP 的 `connect-src` 仍列出 origin；
   - 四个 HTML 页面加 `<meta>`。
2. **check-dist**：
   - prod 恰好一个可选 host 权限、没有 `host_permissions`、精确的 CSP、每个页面的 `<meta>` 在第一个脚本之前；
   - `--dev`、`--e2e` 各自的变体；
   - 篡改用例：删掉 `<meta>`、`<meta>` 放在脚本之后、多一个可选 origin、出现 `host_permissions`。
3. **SW**：
   - 每轮与每次推送前 `chrome.permissions.contains`；不在 → `permission_removed`，不发网络请求、不改失败计数与退避，同步记录只经 §4.9 的不联网维护改变（修订 23）；
   - `onRemoved` 置状态，`onAdded` 安排一轮；
   - `runtime.onStartup` 时"有权限而没有 `sk_sync_cfg`"→ `permissions.remove`。
4. **设置页（M6）**：
   - 开启与加入：`permissions.request` 放在按钮点击处理的第一行，在任何 `await` 之前；拒绝 → 说明、停止；首次上传与入网除 `done`、`unconfirmed` 以外的每一种结果（含 `vault_exists`、`keyring_changed`）→ `permissions.remove`（修订 23）；
   - 关闭同步与移除同步身份：最后 `permissions.remove`；关闭同步需要联网但权限不在时，在同一次点击里先请求，拒绝则提供只在本机的"移除同步身份"；
   - `permission_removed` 的面板与"重新授权"按钮。
5. **测试**：
   - 单元测试用替身 `chrome.permissions`，覆盖上面各路径（§7 `network.spec` 第 6 项）；
   - `network.spec` 断言页面的 fetch 被拦；
   - 评审的 `page-csp.spec.ts` 去掉 `test.fail()`，`check-dist-tamper.test.ts` 的"M-1 guard"改为普通测试；
   - 真实弹窗列入 OWNER-DECISIONS/12 的人工检查。
6. **M8**：`SIXKEY_CORS_ORIGINS` 为空；核对没有授权时读不到任何响应、也没有任何签名请求被接受，授权之后能连（§9 M8 第 11 项，修订 23）。
7. **文档**：PRIVACY 与 SECURITY 按 §7 改写；商店说明与 OWNER-DECISIONS/06 的那一句在同步上线时改。

## 0.0v 修订 22：M5 第二版的两处更正

1. **谁签名**（§4.9；§4.2、§4.14 的措辞跟着改）：
   - 原文"SW 用 IDB 中的 DSK 签名后发出"不对。按实现（`platform/bridge-worker.ts`："It never signs, never stores what passes through"）：页面签自己的请求，SW 只转发；SW 只签它自己发起的一轮、推送与轮询。转发时钉住 origin，并要求目标与签过名的逐字相同。
   - 安全理由写进 §4.9：DSK 在 IndexedDB 里是 non-extractable，扩展上下文都能用它签名（修订 23 更正：`sk_sync_cfg.enc` 另有一份 VK 加密的副本，持有 VK 的代码可以取回它）；SW 的接口不提供签名，所以它不是签名服务；保证的是"网络只经 SW、只到一个 origin、请求原样送达"。
   - §3 与 §7 没有说 SW 签名的地方。修订 21 把 §4.9 第一条的后半句误放到了权限那一条之后，这里一并改正。
2. **权限检查的位置**（§4.9、§4.2）：
   - 决定：不联网的本机停止排在权限检查之前，即第 0 步的并入、`cfg_missing` 完成关闭同步的本机部分、`cloud_restore` 的报告。
   - 理由：它们什么都不发送，权限只守网络。比起让设置页另给一个本机出口，这样更简单，也更安全：没做完的关闭同步不会卡在"请重新授权"上。
   - 与浏览器启动时"没有 `sk_sync_cfg` 就移除权限"的回收互不依赖。

契约与向量不变。

## 0.0w 修订 23：M5 第二版评审 L-r2-2 的三处更正

**(a) 没有授权时能发出什么**（§7 的 SECURITY 文字、§0.0u、§9 M8 第 11 项）：
- 诚实的代码什么都不发，因为引擎与 SW 的传输层先查权限。跳过检查的代码仍能让一个 CORS 简单请求整个送达（实测：`text/plain` 的 `no-cors` POST 带正文到达）；只有带引擎请求头的请求被缩减为预检。
- 结论不变：这样的请求没有会话、没有签名，响应读不到（生产环境没有 CORS）。
- M8 的核对改为"读不到任何响应，也没有任何签名请求被接受"。

**(b) 暂停时本机改动什么**（§4.9、§7、§0.0u；§0.0v 的说法由此补全）：
- `permission_removed` 时不发网络请求，不改失败计数与退避。
- 本机库、outbox、`lastSynced`、身份与钉住值只经不联网的本机维护改变：并入孤儿、清掉损坏的孤儿列表、从副本恢复身份、完成没做完的关闭同步、报告 `cloud_restore`。

**(c) 设备密钥能否取回**（§4.9、§0.0v）：
- DSK 在 IndexedDB 里是 non-extractable，但 `sk_sync_cfg.enc` 有一份 VK 加密的副本，持有 VK 的代码可以取回它。
- "谁签名"的论证改为依据 SW 的接口提供什么（不提供签名）、请求能从哪里发出（只经 SW，只到一个 origin），并如实写明：被攻破、持有 VK 的页面能签任何东西，也能把数据放进发往 API origin 的请求。

**M6 规则**（§7、§0.0u 第 4 项）：首次上传与入网的每一种结果都移除权限，除了 `done` 与 `unconfirmed`；包括作为结果返回的 `vault_exists` 与 `keyring_changed`。

契约与向量不变。

## 0.0x 修订 24：M6 第一阶段（M6A-r2-NOTES §6、§11、§12）

代码尚未合入；本文按作者的判断写明产品将做的事，不请示所有者。

| 项 | 决定 | 写在 |
|---|---|---|
| 偏离 1：popup 不放同步屏幕 | 采纳。P1、P3、P4 的内容放在设置页的同步一节，角标计数并用文字说明；P2 是开闸前的要求；P5 等模块拆分之后 | §6 Popup 之后；§9 M8 第 17 项 |
| 偏离 2：开启的顺序 | 采纳：主密码 → 邮箱验证码 → 账户检查 → 设备名 → 恢复码 → 上传。与 §3.1 的步骤一致，只把设备名放到账户检查之后 | §3.1；§6 O3 |
| 偏离 3：可当场改正的错误 | 采纳：不结束流程，权限保持；锁定结束流程 | §6 开头；§7 |
| 偏离 4：回填两组确认新恢复码 | 采纳（§3.1 本来就这样写）；另记 30 秒清空剪贴板，以及"确认之后旧码即失效" | §3.1 第 4 步 |
| 偏离 5：同步关闭时在同步一节显示保留的保存 | 采纳 | §4.7 |
| 偏离 6：商店 ID 存在之前没有商店链接 | 采纳；链接是开闸前的要求 | §6 O12；§9 M8 第 17 项 |
| 偏离 7：角标文字跟随浏览器语言 | 采纳 | §3.11 |
| 偏离 10：批准入网的重复 | 采纳摘要的说明；**设计要求以后去重**：第一轮之后把这次入网新加的重复条目移进回收站，不改契约 | §3.5 |
| (c) 服务层的锁定检查 | §3.1 第 4 步 (b) 与 §3.5 的提交在库锁定之后以 `locked` 拒绝；锁定结束一切打开的流程 | §3.1；§3.5；§6 开头 |
| (d) 权限不变式 | 同步开启 ⇒ 持有权限，或用户撤销了它；关闭同步的复核关闭时只归还那次点击重新授予的权限 | §7 |
| (e) 开闸前必须完成的项 | P2；`keys_behind`、`different_vault` 卡片的出路；商店链接；开关；popup 预算 | §9 M8 第 17 项 |
| (f) 第二阶段的模块拆分 | 五个共享模块中只有引擎用的部分移出，测试保证不进 popup 的模块图；这是第二阶段的第一个改动 | §7；§9 M6 |
| M6A §12 第 1 条（另加） | 另一个 vaultId 的搁置条目不自动删除，入网到另一个库也不删，只在用户确认后删除 | §4.7 |

契约与向量不变。

**留给第二阶段、不需要设计决定的**（M6A §12 第 2、3 条，均按已有的设计实现）：
- "用恢复码设置新的主密码"（§3.3 第 5 步，一次 bundle 更新、以 `recovery_auth` 代替 `pw_auth`）；
- 分出独立身份（§4.10）；
- 以云端为准重新加入（§3.5）；
- 删除同步账户（§3.12）。

这些缺的是引擎函数，不是规则。

## 0.0y 修订 25：M6 第二阶段（`docs/design/notes/M6-NOTES.md` §12、§13）

代码已合入主线。本文按作者的判断记录为设计，不请示所有者。

| 项 | 决定 | 写在 |
|---|---|---|
| (1) "丢失或被盗"的顺序 | 能准备轮换时先显示并回填新码 → 持久的"欠一次轮换"记录 → 吊销（永不被挡）→ 轮换；不能准备时照样立即吊销，卡片说还欠一次轮换。记录只由生效的轮换、或吊销之后采用的轮换清除；关闭同步与移除身份先警告，没有明确勾选就拒绝 | §3.10；§3.13；§10 第 105 条 |
| (2) 吊销之前的等待 | **接受这个限制并如实写明**：服务器持有本机尚未采用的密钥时，吊销的密码那一步以 `needs_adoption` 拒绝（证明不能按未经验证的参数派生）；出路是"更新本机"；服务器还要求扩展更新时，本机在更新之前无法吊销——"紧急吊销永不被挡"的唯一例外 | §3.14；§10 第 106 条 |
| (3) `sk_prejoin` 列表 | 只追加，格式 2（v1 读作一条）；读回校验；重试幂等；只经已解锁页面里对屏幕上那几条的确认删除；至多 8 条 / 2 MiB，入网在第一步以 `kept_full` 拒绝；"永久删除"清理能打开的、保留其余并当场说明；Start over 保留它们、DELETE 框说明 | §3.5 ④；§3.13 |
| §3.13 的格式清单 | `sk_prejoin` v2；搁置原因 `"vault"`；安全记录保留不认识的种类与字段，新增 `keys_adopted_back` 等；`rotationOwed` 记录 | §3.13；§0.0i R8 与 §0.0j 的旧说法已标注取代 |
| (4) 采用表单里输错 | 照常记 `unlock_failed` / `recovery_failed`，计入同一个失败次数；Phase 0 按设计不锁定 | §3.9 |
| (5) 锁定页的采用 | "用服务器上的密码解锁"（有"已发出、未确认"记录时）与"更新本机"的语义；P2 的措辞，只在解锁失败之后出现 | §3.9；§6 P2 |
| (6) 开闸前清单 | 刷新为三组：已完成；开闸前必须（开关、docs/security/local-vault.md 那句话、商店链接、`server_older_key` 的修复、O13、旧内核的运行）；可以之后（批准入网后的去重、保留库的导出与重新导入），各有理由 | §9 M8 第 17 项 |

契约与向量不变。

**没能决定的问题**：没有。开闸前清单里"必须"的三项（`server_older_key` 的修复、O13、旧内核）是本文的判断，理由写在 §9 M8 第 17 项；若维护者认为上线范围应更小，可以把它们降为"可以之后"，但需同时接受：诚实 PITR 回到某次轮换之前会让同步停住而没有出路，以及 D6 的兜底在窗口之后无法经界面取回。

## 0.0z 修订 26：M6C（`docs/design/notes/M6C-NOTES.md`）

代码已合入主线。本文按作者的判断记录为设计，不请示所有者。说明文件已移到 `docs/design/notes/`：本文先前写的 `docs/M*-NOTES.md` 指的就是那里的同名文件。

| 项 | 记录 | 写在 |
|---|---|---|
| (1) `server_older_key` 的修复 | 沿用本机已采用的 auth（不换新 salt：新 salt 会让已采用轮换的设备以 `auth_without_password` 拒绝）；发送之前确认当前密码能打开本机 keyring（第二阶段的同 VK 修复一并补上）；上传本机的库，不合并恢复后的头版本（它留在历史里，经"找回账户"可达）；发送密钥之前，按粘住的设备列表再次吊销本机见过被吊销、而恢复后的服务器列为有效的设备（表单列出；名单过时 → `stale` 重来；锁定即停；一次吊销失败就停止修复）；本机从没见过的吊销不在名单里——接受的残余；修复不生成新恢复码；双重故障的残余；没有真实数据库的端到端测试，由 M8 的 PITR 演练核对 | §4.2；§4.4；§10 第 107、108 条；§9 M8 第 17 项 |
| (2) "找回账户"（O13） | 读服务器历史（至多 64 个、只用本机持有的密钥、较旧密钥的版本做标记）与本机快照；版本按不可信数据解析、核对 vaultId；只显示 issuer 与 label 及相似标记，不显示秘密；找回是一次普通的本地编辑，任何版本内容都不原样发出；保留期按 §5.8 如实写明 | §6 O13；§4.6；§4.4 |
| (3) 批准入网后的去重 | 孪生 = secret + issuer + label 相同**且** OTP 参数相同；HOTP 只在计数器不领先时移走；先到者留下，所以每个账户总有一份存活；移进回收站而不永久删除；一条通知；记录入网新加的 id（§3.13 新行），并跨越一次撤销掉的未完成入网交给合并到同一库的重新入网 | §3.5；§3.13 |
| (4) 行为说明 | 设备列表在第 1 步、密钥检查之前刷新（锁定的一轮也一样），取不到时这一轮失败（以前停在 `needs_password` / `server_older_key` 的轮次现在报失败）；吊销在列表里粘住；本机吊销时立即标记，所以自己的吊销不再收到"一台设备已移除"的通知 | §4.2 第 1 步；§3.13 |
| (5) 开闸前清单 | 已完成：`server_older_key` 的修复、O13、去重、SECURITY 那句话（以及 M6 已完成的各项）。开闸之前还要：开关、商店链接、Chromium 120/134 的运行；修复由 M8 的 PITR 演练核对 | §9 M8 第 17 项 |

契约与向量不变（修复用的是已有的 `POST /v1/keys/rotate`，"找回账户"用已有的历史端点）。

**没能决定的问题**：没有。

## 0.0aa 修订 27：后量子准备（`docs/design/proposals/PQ-READINESS.md`）

维护者受所有者委托批准了三项：配对码；恢复码保持 128 bit；对外措辞按 PQ-READINESS §5。

| 项 | 内容 | 写在 |
|---|---|---|
| 派生 | `K = HKDF-SHA256(IKM = Z ‖ S, salt = h, info = "sixkey/v2/enroll-key", 256 bit)`，Z 为 32 字节 ECDH 结果，S 为 16 字节配对码；设备名（reveal）与载荷（approve）都用这个 K | §3.2；§2.2 |
| 谁显示、谁输入 | **批准方显示配对码，新设备输入**；SAS 不变（新设备显示，批准方输入）。理由：(1) 批准方在 `respond` 被接受之后显示 S，新设备在 reveal 之前输入，所以设备名也在 S 之下，入网里没有任何东西只靠 ECDH；(2) 两边各输一次（新设备 28 个字符，批准方 6 位），而不是在一边输 34 个；(3) 它占用的正是原来确认码的那一步输入 | §3.2；§6 O5、O6、O9 |
| 确认码 CC | 删除。它的作用（防止服务器冒充批准方骗新设备）由配对码承担：配对码不泄露时更强（2^-128 对 10⁻⁶），泄露时新设备一侧没有第二道（残余，§1.3、§10 第 110 条） | §3.2 MUST 5；§10 第 1、28、110 条 |
| 输入与输错 | 恢复码的格式（28 个字符，7 组 × 4，校验位带 `sixkey-pairing-code\|1\|` 标签）；粘贴、Crockford 容错；格式或校验位不对只在本地提示、不算次数；校验位漏过的输错由批准方在设备名解密时发现（`pairing_mismatch`，终态，重新开始）；没有预言机；寿命至多 10 分钟，任何结束都丢弃 | §3.2 MUST 10 |
| 标签与版本 | 入网的全部域分隔升为 v2：`sixkey-enroll-commit\|2\|`、`sixkey-enroll\|2\|`、`sixkey/v2/enroll-sas\|`、`sixkey/v2/enroll-key`、`sixkey-enroll-name\|2\|`、`sixkey-enroll-payload\|2\|`，载荷 `v: 2`；新增 `sixkey-pairing-code\|1\|`；删除确认码 CC 的标签（v1 的 `enroll-confirm`） | §2.2；§2.6 |
| crypto-agility | 首次发布前必须存在的算法与版本标识（全部字段），验签按 SPKI OID 选择、不认识的拒绝，入网版本靠域分隔失败关闭，永不丢弃旧读取器 | §2.6 |
| 将来的后量子迁移 | 入网：混合 ML-KEM 只在 WebCrypto 于我们最低 Chrome 版本上稳定提供时用；纯 JS 只在经独立审计时考虑；从不用 WASM。签名：ML-DSA 稳定后经分出身份或重新入网更换设备密钥 | §2.6 |
| TLS | M8 第 18 项：代理提供 X25519MLKEM768 | §9 M8 |
| 对外措辞 | 可以说与不得说的清单 | §7 |

**契约改动**：
- **openapi 不变**：Sixkey 从不发送配对码，载荷与设备名仍是不透明的密文，长度不变。
- **向量**（`contract/vectors/sync-v1.json`）：
  - `labels`：
    - 删除 v1 的六个入网标签：HKDF 的 `enroll-key`，域分隔 `sixkey-enroll-commit`、`sixkey-enroll`、`sixkey-enroll-name`、`sixkey-enroll-payload` 的 `|1|` 版，以及 `enroll-sas` 与 `enroll-confirm` 两个 v1 标签（这里故意不写全，免得 H8 把历史记录当成在用的标签）；
    - 加入：`hkdf_info` 的 `sixkey/v2/enroll-key`；`domain_tags` 的 `sixkey-enroll-commit|2|`、`sixkey-enroll|2|`、`sixkey-enroll-name|2|`、`sixkey-enroll-payload|2|`、`sixkey/v2/enroll-sas|`、`sixkey-pairing-code|1|`；
    - "所有 HKDF 标签两两不同"与"域分隔互不为前缀"的断言照旧覆盖新标签；
  - `enrollment`：
    - `inputs` 加固定的 S（`pairing_secret_hex`）、它的显示文本（`pairing_code`）与 IKM（`ikm_hex` = Z ‖ S）；
    - 重新计算 `commit_input`/`commit_b64`、`transcript`、`h_*`、`k_enroll_hex`、`sas`/`sas_u32`、`reveal_name`、`payload`（P 的 `v: 2`），以及 `substitutions`、`mitm`、`commit_checks` 里的全部派生值；
    - 删除 `cc`、`cc_u32`；`mitm` 删除 `cc_expected_by_N`、`cc_shown_by_A`，改写 `note`；
    - `must_not_open` 加一条"只由 Z 派生的 K（v1 的派生，没有 S）打不开设备名与载荷"，再加一条"S 错了一个 bit 的 K 打不开"；
    - `label_swap` 改为校验位的域分隔：同一个 16 字节秘密，按恢复码与按配对码算出的校验位不同，互相输入都被拒绝；
  - `sas_cc` 改名为 `sas`，只留 SAS（v2 标签）的用例，删除 CC 的；新增 `pairing_code` 组：格式化、规范化（大小写、空格、`-`、O/I/L）、不是 28 个字符、校验位不对、恢复码当配对码输入被拒；
  - `wire_examples` 里的入网例子：create 的请求体（`commit`）、reveal（`name_ct`）、approve（`transcript_hash`、`payload`；`name_ct` 用 VK 派生的密钥，不变）、新设备看到 `approved` 的轮询视图（`payload`）、批准方看到 `revealed` 的轮询视图（`commit`、`new_name_ct`）；respond 的例子不变（`epk_A` 与 S 无关）。实现时按 `enroll` 搜一遍这个组，不要只改这里列的。
- **向量的 schema**（`contract/vectors/sync-v1.schema.json`）：随上面的字段与组名改。
- **工具**：
  - `check_consistency.py` 的 H8 现在只认 `sixkey/v1/` 与 `|1|`，看不见 v2 标签。要改成任意版本号（`sixkey/v\d+/` 与 `\|\d+\|`），否则 v2 标签不受检查。
  - 本修订之后、向量更新之前，检查器报 8 个 H8 不一致（全部是入网标签）；向量与 H8 改好后应回到 0。CI 会跑这个检查，所以本修订必须与向量一起合并。
  - 生成器 `contract/tools/gen-vectors.mjs` 与 Python 参考实现（`contract/py/`）按 v2 改。

**迁移**：不需要。还没有任何构建发布过，入网 v1 直接被 v2 取代，没有存储的数据受影响。

**`docs/security/local-vault.md`**：没有改。它不谈密钥协商（它只把入网代码列为服务器注册请求的唯一调用者）。

**与 PQ-READINESS 的差别**：建议里写的是"批准之后才显示配对码"。本修订改为在 `respond` 被接受之后显示，让 reveal 的设备名也在配对码之下。

**没能决定的问题**：没有。

---

## 0. 范围、术语与已定决策

### 0.1 术语

| 术语 | 含义 |
|---|---|
| 设备（device） | **一个 Sixkey 安装 = 一个 Chrome 配置文件（profile）里的扩展实例**。同一台电脑上 50 个 AdsPower / Multilogin 配置文件 = 50 个设备。卸载重装 = 新设备。 |
| 已入网设备（enrolled device） | 服务器 `devices` 表里有记录、未吊销、持有设备签名私钥的设备。只有它能读云端密文；写入还需要写入证明（即需要 VK）。 |
| 账户会话（account session） | 邮箱 OTP 换来的 Supabase access token（≤15 分钟）。**只**用于：首台设备建库、发起入网请求、恢复码入网、删除账户的二次确认。拿到它**不能**读取任何密文或包裹密钥。 |
| 设备凭据（DSK） | 每台设备一对 ECDSA P-256 签名密钥（私钥在 IndexedDB 中 non-extractable，另有一份 VK 加密的副本，§2.5）。已入网设备的每个 API 请求都用它签名。 |
| VK / keyring / envelope | 沿用 Phase 0：`core/crypto/vk.ts`、`keyring.ts`、`envelope.ts`。 |
| KeyBundle | 云端保存的 keyring（密码包裹 + 恢复码包裹 + 历史 VK），带 `kver` 版本号和 VK 派生的 MAC。 |
| 恢复码 / 恢复密钥 | 128 bit 的恢复秘密 R（28 个 Crockford 字符，含 12 bit 校验），打开 keyring 的恢复包裹。2026-10-23 起界面统一叫“恢复密钥 / Recovery key”，分片叫“恢复密钥分片”（OWNER-DECISIONS/16 问题 C）；本文的协议部分与契约（`recovery_verifier`、`recovery_auth`、`RecoveryWrap`）沿用“恢复码”指同一个秘密，引用的界面文案已改为新叫法，以 `extension/scripts/i18n/` 为准。 |
| SAS / 配对码 | 批准入网时的两个码：配对码（28 个字符，128 bit）显示在批准方上、输入到新设备，Sixkey 从不发送它；SAS（6 位数字）显示在新设备上、输入到批准方。修订 27 起不再有确认码 CC。 |
| `version` / `kver` / `head` | 服务器端库版本号 / KeyBundle 版本号（都是单调递增的乐观锁）/ 服务器当前 envelope 原文的 SHA-256。 |

### 0.2 用户已定决策（不再讨论）

- **D1** 传输：FastAPI + Supabase，端到端加密，服务器只存密文；邮箱 OTP 由 FastAPI 代理；扩展只对 API 域名有 `host_permissions`，e2e 网络测试与 `check-dist.mjs` 改为"只允许这一个 origin"。（修订 21：仍然只有这一个 origin，但声明为 `optional_host_permissions`，开启同步时才请求，§7。）
- **D2** 新设备入网必须由已入网设备**批准**；**恢复码**可以绕过批准自助入网。理由：只拿到邮箱的攻击者不能拿到密文或包裹密钥去离线爆破主密码。
- **D3** 设备身份 = 随机设备 ID + 用户起的设备名 + 最后同步时间，**仅此而已**。不收集 UA、不做 IP 地理定位、不做浏览器指纹；服务器日志不保留 IP。
- **D4** 云同步必须设主密码（PLAN 5.5）。
- **D5** 永不丢数据；日志中不得有密钥或验证码；没把握的安全决定列为 OPEN QUESTION。
- 另见 §12 所有者对 Q1–Q9 与调研清单的决定。

### 0.3 相对 PLAN.md 与 Phase 0 代码的变更（均标【变更】，正文有理由）

| # | 原文 | 本设计 | 位置 |
|---|---|---|---|
| C1 | PLAN 7.1：refresh token 存 storage.local，由 SW 单点刷新；access token 15 分钟（Q10） | 【变更】已入网设备用**设备签名**认证，不再持有任何长期 Supabase token。`/v1/auth/verify` 之后 FastAPI 立即撤销该 Supabase 会话（`POST /auth/v1/logout?scope=local`），refresh token 永不下发到扩展；`/v1/auth/refresh` 取消。Q10 的 15 分钟 access token 只作为一次性"账户会话"。 | §5.2 |
| C2 | PLAN 7.1：开启 Supabase IP 转发（`Sb-Forwarded-For`） | 【变更，已决 Q1】不转发；限流在 FastAPI 内存中做（IP 只做带日轮换密钥的 HMAC，不落盘）。 | §5.6 |
| C3 | PLAN 7.2：`vault_versions` 每行存 `wrapped_keys` | 【变更】历史版本**不存**包裹密钥。旧版本靠当前 KeyBundle 里的历史 VK 打开。 | §5.3 |
| C4 | PLAN 5.4 / 7.2：`wrapped_keys jsonb` + `keys_version` | 【变更】改为 KeyBundle 对象（带 `kver` 和 VK-MAC，**原文存储**），服务器另存恢复码校验值。乐观锁沿用。 | §2.3 |
| C5 | PLAN 7.3：请求体 1 MB 上限 | 【变更】envelope 上限 `MAX_ENVELOPE_BYTES` = 8 MiB；同步开启时，**让库变大的**本地编辑在提交前按同一度量检查；合并结果超限时本地照存、只暂停上传；缩小库的编辑永远允许。 | §4.3 |
| C6 | （未提及） | 【新增】设备名在服务器上端到端加密，并补齐到固定长度。 | §2.4 |
| C7 | PLAN 4.4：恢复链最后一级"云端（已登录）" | 【变更】"已登录"具体化为：设备凭据在 IndexedDB `sixkey-identity` 与 storage.local（VK 加密副本）**两处**，任一处还在就能恢复；两处都没了才需要重新入网。 | §2.5、§4.13 |
| C8 | PLAN 6："锁定状态下只做快进式推/拉" | 【变更】锁定时只推送 outbox（每次本地提交时在同一把锁里算好，带写入证明）；锁定时**不拉取**远端内容（只查状态）；**锁定时绝不改写本地 generation**。 | §4.7 |
| C9 | （未提及） | 【新增】只有 service worker 访问网络；`check-dist` 只允许 `sw.js` 出现 `fetch(`。 | §4.9、§7 |
| C10 | PLAN 3："rev 云端阶段与服务器 version 对应" | 【变更/精化】上传的 envelope `rev` = 服务器新 version；本地 generation 的 `rev` 仍是本地计数器；远端 envelope 永不原样落为本地 generation。 | §4.1 |
| C11 | （未提及） | 【新增，已决 Q8】敏感操作的密码证明 `pw_auth`。 | §3.14 |
| C12 | （未提及） | 【新增】写入证明 `write_proof`：服务器保存 VK 派生的 `K_write`，`PUT /v1/vault` 与轮换必须带 HMAC 证明。 | §2.2、§4.2 |
| C13 | Phase 0 `validate.ts`：`parseVault` 拒绝 >5000 条 | 【变更】5000 条（非清除条目）只在新增/导入时检查；解析上限 50 000 条。墓碑仍永久保留（PLAN 3【已决】，已决 Q9）。 | §3.13 |
| C14 | PLAN 7.2：`vault_versions.created_at` 精确时间 | 【变更】服务器能看到的时间戳一律降精度：历史版本、设备加入与吊销时间到小时；KeyBundle 里的 `at` 与各包裹的 `createdAt` 到小时（T1）；`last_seen_at` 到天、跨天才写（T2）；入网请求时间到分钟。 | §2.3、§5.3 |
| C15 | （未提及） | 【新增】设备签名私钥的 VK 加密副本（`sk_sync_cfg.enc`），以及一等状态 `identity_missing`（d2）。 | §2.5 |
| C16 | PLAN §15"首个账户前是否必须设主密码"（悬而未决） | 【已决，所有者 2026-10-15】新安装必须先设主密码才能添加第一个账户；新建、从备份恢复、重新开始都在写入任何东西之前要密码，从不写设备包裹（调研 F1 + 最终评审 H-a，Phase 0.x 的 H1）。 | §9.1、§12 |
| C17 | PLAN 4.3："偏差 >15 秒提示并校正" | 【变更】只提示；验证码默认仍按本机时钟生成，由用户选择是否改用校正后的时间（偏移限 ±1 小时），以免服务器时钟出错时所有验证码失效（S3）。 | §4.14 |

---

## 1. 威胁模型

### 1.1 资产
1. TOTP 种子（vault 明文）——最高价值，泄露后只能到各网站重新绑定 2FA。
2. VK（及历史 VK）。3. 主密码、恢复码。4. 设备凭据。5. 元数据：邮箱、设备数、设备名、同步时间、库大小。6. **可用性**：用户本地数据永不因同步而丢失（D5）；验证码的生成不依赖服务器（S3）。

### 1.2 攻击者与保证

| 攻击者 | 能拿到什么 | 我们保证什么 | 残余风险（如实告知） |
|---|---|---|---|
| **A1 恶意/被攻破的服务器**（含 DB 转储、Supabase 内部、托管商） | 全部密文、KeyBundle（含 PBKDF2 密码包裹、恢复码包裹）、两个校验值、`K_write`、设备公钥、设备名密文、时间与大小元数据（都已降精度） | 看不到种子、VK、主密码、恢复码、设备名。篡改密文/包裹/参数会被 AEAD/MAC 发现。不能冒充新设备从批准方拿到 VK（配对码与 SAS），**也不能冒充批准方骗新设备把种子交给它**（配对码，§3.2；修订 27 之前是确认码 CC）。录下的入网流量，将来即使 ECDH 被量子计算机解开也没用（Sixkey 从不发送配对码，§3.2、§2.6）。KDF 参数下限在读取时强制。服务器时钟出错或撒谎不会让验证码失效（§4.14）。 | **机密性最终取决于主密码强度**：服务器可以离线猜主密码。最便宜的是 `password_verifier`：它按 `auth.kdf` 的轮数（600k）算，与密码包裹的轮数（本机设的 2M，同步引擎做的 600k）无关。2026-10-22 起本地设主密码时低于 50 bit 只警告（OWNER-DECISIONS/15），开启同步会把这个密码原样带上来；这道前提目前只靠发布开关守着（§9 第 17 项；2026-11-17 起任何版本都不能开启同步，OWNER-DECISIONS/25）。批准入网（D2）防的是邮箱攻击者获得爆破材料，对恶意服务器无此作用。设备列表、吊销、限流、`pw_auth`、写入证明对恶意服务器都只是"建议性"的。服务器可以拒绝服务、隐藏他人更新（冻结）、向不同设备展示不同版本（不提供分叉一致性）。 |
| **A2 只拿到邮箱** | 账户会话（≤15 分钟） | 拿不到任何密文、KeyBundle 或设备列表；只能发起入网请求（每个会话 1 个，会在已入网设备上显示，可"拒绝全部"），只能看到"该邮箱是否已有库、何时建立、几台设备"。不能删除账户（需要设备签名 + 邮箱二次确认 + `pw_auth`）。 | **抢注**（在用户开启同步前接管邮箱并先建库）：攻击者自己的批准设备会显示配对码，但它只出现在攻击者屏幕上；要让用户的新设备接受它的载荷，攻击者必须在线下骗用户输入这串字符（社会工程）。加入已有库前另有警告文字。 |
| **A3 被盗设备 / 配置文件副本**——在指纹浏览器里这是**常态**，不是边缘情况：GoLogin 的云同步包含扩展存储（其 SDK 上传时不排除 `Local Extension Settings`）；Kameleo 的复制与导出包含扩展及其存储；Multilogin X 的转移包含 Local storage 与扩展；AdsPower、BitBrowser、VMLogin、Dolphin 有可选的"同步扩展数据"开关，BitBrowser 还能把一个配置文件的扩展数据同步进其他配置文件。先例：2023-08 BitBrowser 服务端缓存被入侵，开启了扩展数据同步的用户钱包被盗。团队共享配置文件同理。 | 本地 keyring（密码包裹）、本地密文、设备凭据（含 storage.local 里的 VK 加密副本，没有 VK 打不开）；若当时处于解锁状态还有 VK | **锁定状态的副本、不知道主密码**：能以共用的设备身份拉取密文、全部历史和**当前** bundle（仍需密码，与本地 keyring 同等暴露；改密码之后它仍能拿到新密码包裹去离线猜，所以要赶走它必须吊销 + 轮换）；能看加密的设备列表；能制造"多次输错主密码"告警。**不能**写入库（写入证明需要 VK）；**不能**做任何 `pw_auth` 操作——批准、响应或拒绝入网、吊销任何设备（包括它与真设备共用的这个身份，S8）、改名、改密钥、轮换、分出身份、清除历史、删除账户；也**不能**让真设备的敏感操作被锁住或被限流挤掉（S2）。设备凭据被吊销后服务器拒绝它的所有请求。 | **副本 + 主密码 = 隐形的同步凭据**（S1）：例如厂商同步的配置文件被同事在另一台机器上打开、用共享的密码解锁，§2.5 的副本会恢复出**同一个**设备身份，于是他能读写之后的所有版本，设备列表里看不出多了一个人，只有克隆检测（写入时）可能发现。因此**加入同步的配置文件绝不能被厂商同步或与他人共享**（§1.3、H8）。**解锁状态被拿走**：此刻的全部种子、30 天内的服务器历史（含期间被永久删除的）、可上传恶意内容（由 §4.4 守卫、快照和版本历史兜底）。`pw_auth` 是固定值，只有与有效设备签名一起才有用，请求体从不记录（§10）。已被看到的种子无法收回。 |
| **A4 已吊销、但仍知道旧 VK 的设备** | 吊销前的全部数据、VK1、旧密码包裹 | 诚实服务器拒绝它；轮换后 `K_write` 也随之更换。若轮换 VK：**对已采用 VK2 的设备**，轮换后新增/修改的数据它看不到，即使它与恶意服务器勾结。自动同步**只接受当前 VK 加密的远端版本**；设备在 IDB 中钉住当前 vkId，即使本地数据丢失也不会被引回旧 VK（§3.9）。 | 吊销前它见过的种子永久泄露。恶意服务器可以向部分设备隐瞒轮换（分叉），这些设备继续用 VK1 写入的内容它能读。若持有者还知道主密码，轮换时必须同时改密码。 |
| **A5 服务器回滚 / 冻结**（含诚实服务器的 PITR 恢复） | — | 服务器 (version, head) 与上次同步不同就拉取并合并（版本号在回滚后被复用也能发现）；倒退时一次性告警、照常合并（合并单调，旧数据赢不了新时间戳），永不把本地退回远端。KeyBundle 倒退：忽略并告警，永不降级到旧 VK。 | 冻结（一直返回同一个旧版本）无法被单个设备察觉。诚实的 PITR 之后，一个在恢复前签名、迟到的写入若碰巧带着被复用的 `if_version`，会被接受并覆盖另一个头版本（M3RR-13，暂时性：其他设备仍持有数据并会合并回来）；M8 的恢复栅栏关闭它（§5.2）。 |
| **A6 重放** | 截获的请求（需先攻破 TLS 或日志泄露） | 签名覆盖配置的 host、方法、原始请求目标、时间戳、正文哈希（账户会话请求还覆盖 `sub`），窗口 ±5 分钟。库写入与密钥写入带乐观锁（重放必然 409 或命中幂等）；吊销、拒绝是幂等的；入网状态机一次性；写入证明绑定 `if_version` 与校验和。 | 窗口（±5 分钟）内的六种重放，见 §5.2：改名撤销、`reject-all`、清除历史、被拒后重放入网创建（幽灵请求）、"拒绝全部"后重放恢复码入网（重建已批准请求并返回密文）、已签名 GET 返回密文与包裹过的密钥。都需要截获受 TLS 保护的已签名请求，都不暴露明文、不破坏库的完整性。不加 nonce 缓存（M4，所有者委托决定）。 |
| **A7 两台设备竞争** | — | 服务器 CAS（`if_version` / `if_kver`）恰好一个成功；失败方拉取、合并、重试。合并满足交换律/结合律/幂等，任意顺序都收敛。 | — |
| **A8 同机多配置文件 / 配置文件克隆** | 同一用户的其他配置文件 | 每个配置文件是独立设备（独立存储、独立 session、独立锁）。克隆（Kameleo exact clone、AdsPower 一次复制最多 30 份、BitBrowser 跨窗口同步扩展数据）共用设备身份时，写入时的软检测会发现并让副本分出独立身份（§4.10，M6）。 | 检测之前，两个副本共用设备列表中的一行、吊销粒度变粗。只读的克隆不会被发现（它也写不了任何东西）。不造成数据风险。 |
| **A9 网络攻击者** | 流量 | TLS（仅 HTTPS，CSP 只允许 API origin）；内容本身已端到端加密。 | 流量时间/大小。大小按 16 KiB 分桶填充（§4.1）。 |
| **A10 能连接该配置文件调试端口（CDP）的本机进程**（d4）。指纹浏览器的本地 API 会返回配置文件的 CDP 地址，鉴权多为可选或未写文档：AdsPower 只有开启"安全校验"时才要求 API Key；BitBrowser 的 Token 定位为公网环境使用；VMLogin 未见鉴权文档；Kameleo 的 OpenAPI 没有任何鉴权定义，且其配置参考表写默认监听所有网卡。Puppeteer 可以直接在扩展 service worker 里执行代码。这个"进程"可能就是团队自己的自动化脚本，或局域网上的另一台机器，或驱动浏览器的 AI 代理（Playwright、Puppeteer、chrome-devtools-mcp 之类）。 | 能在 Sixkey 的 SW 和页面里执行任意代码 | **解锁期间几乎不设防**：它能读走 `storage.session` 里的 VK、全部种子；用户在设置页输入主密码时也能读走密码，此时 `pw_auth` 不再构成屏障。**锁定且没有打开 Sixkey 页面时**，它得到的与锁定的配置文件副本（A3）相同。缓解只有缩短窗口：对被脚本控制的配置文件使用"每次都锁定"（VK 只在打开着的 popup/设置页内存中，设置页闲置 15 分钟锁定；首次运行的风险提问会预设它，§9.1 H5），并且**不要在被脚本控制的配置文件里开启同步**（同步会让它额外拿到吊销前的设备凭据）。 | 我们不声称能防住它；文档与首次运行提示如实说明（§9.1 H5、H8）。 |
| **A11 只知道受害者邮箱的人**（RR6，Phase 1 接受） | 不需要任何认证：只要发起 OTP 发送与校验 | 拿不到任何数据：OTP 只换来账户会话，而账户会话读不到密文（A2）。 | **可以针对某个邮箱拒绝服务最长约 24 小时**：① 从任何 IP 用 5 次错误校验耗尽受害者当前验证码的次数（每码次数只按邮箱计，A22），受害者只能再要新码，而它又能被耗尽；② 从约 17 个 IP 填满每邮箱每天 50 次的发送上限，受害者自己的发送得到 429，直到 24 小时窗口腾出，同时收到约 50 封邮件。由此恢复码入网、新设备入网、init 与删除账户的二次确认都暂时不可用；已入网设备的同步与本地使用不受影响。缓解由 M8 选定（§9 M8 清单第 15 项）。 |

### 1.3 明确不保证的
- 不防恶意软件（与 Phase 0 相同），也不防能在解锁期间连上配置文件调试端口的进程（A10）。
- 不防"用户把 SAS、配对码或恢复码告诉骗子"——UI 文案只能尽量提醒（§6）。
- 配对码泄露到恶意服务器一方时（屏幕被人看到，或复制之后经系统的云剪贴板离开这台电脑），新设备一侧没有第二道防线：服务器可以冒充批准方，让新设备把本机账户导入它的库。批准方一侧仍有 SAS（§3.2，§10 第 110 条）。
- 不提供团队共享（一个账户 = 一个人，已决 Q7）。**推荐做法**：一个同步库 = 一个人；**加入同步的配置文件绝不能被厂商同步或与他人共享**（否则它的副本加上主密码就是一个隐形的同步凭据，A3）。要放进共享配置文件或厂商云配置文件的，只放该配置文件需要的那几个账户，用"导出所选账户"（§9.1 H2），而不是让它加入同步库。
- 能生成验证码的客户端必然持有种子：任何"能用码、不能看种子"的成员权限都只是客户端强制（见 §13）。
- **"采用回来"只信任 IndexedDB 里的身份记录**（RR-6，接受的残余，§3.9 R1）：IndexedDB 单独回退（厂商同步了一份过时的副本，或身份数据库的旧副本），使身份记录的 `adopted` 回到较旧的 bundle B5，而 storage.local 里是本机之后的提交（B6、B7）。若服务器此时正好给出 B5（恶意服务器的重放，或恰好重合的回档），GM2-5 的"采用回来"会把 B5 当作"本机最近一次提交的状态"立即采用，不问用户。攻击者需要两样：**单独回退本配置文件的 IndexedDB**，以及**控制或重放服务器上的 bundle**。用户看到的后果：在这台设备上，B5 之后改的主密码或生成的恢复码不再能打开，B5 时的旧密码与旧恢复码又能打开了；若当初改密码是因为旧密码泄露，泄露的那个在这台设备上又有效了。只影响同一 VK 的改动：轮换无法这样退回，较旧 VK 的 keyring 解不出本地的 VK，连续性检查会拒绝。能写本扩展 IndexedDB 的人也能直接写 storage.local 的 keyring，所以这从来不是挡本地攻击者的边界。M5/M6 必须把"密钥已采用回来"显示为可见事件，让用户能发现它。

---

## 2. 密钥与对象总览

### 2.1 分层

```
主密码 ──PBKDF2──┐
恢复码 ──HKDF────┼──> KEK ──AES-GCM 包裹──> VK（32B 随机）──HKDF──> K_enc（库）
                 │                          ├─HKDF──> K_mac（KeyBundle MAC）
                 │                          ├─HKDF──> K_name（设备名）
                 │                          ├─HKDF──> K_prev（包裹历史 VK）
                 │                          ├─HKDF──> K_devbackup（设备凭据副本）
                 │                          └─HKDF──> K_write（写入证明；服务器保存此值）
恢复码 ──HKDF──> recAuth ──SHA-256──> recovery_verifier（服务器）
主密码 ──PBKDF2(另一 salt)──HKDF──> pw_auth ──SHA-256──> password_verifier（服务器，§3.14）
入网：ECDH(P-256 临时) ──HKDF(salt=transcript)──> K_enroll（一次性传输 VK，不落盘）
设备：ECDSA P-256 DSK（签名请求；与 VK 无关）
```

**没有"每设备持久包裹"**：曾考虑让每台设备持有一把公钥、轮换时把新 VK 包给每台设备。否决理由：那把设备私钥只能明文（non-extractable 也只是防 JS 导出）放在配置文件里，等于 Phase 0 的"设备包裹"，拿到配置文件副本就能不经密码解出 VK。所以"批准包裹"只是**一次性传输**，用完即删。

`K_write` 交给服务器是有意的：它由 HKDF 以独立的 info 从 VK 派生，推不出 VK 或其他子密钥；服务器本来就能写入任何东西，所以它持有 `K_write` 不增加能力。它的作用是让**没有 VK 的设备凭据持有者**写不进去。残余：数据库只读泄露 + 锁定的配置文件副本合起来可以写入（S7，§10；M7 的 KMS 层覆盖它）。所有 HKDF 标签两两不同（M0 的向量文件断言这一点；WebCrypto 对同一 info 的 `deriveKey(AES-256)` 与 `deriveBits(256)` 产生相同字节，标签相同就会把 K_enc 交给服务器）。

### 2.2 标签与 AAD 一览（所有 HKDF 都是 SHA-256；`∅` = 空 salt）

| 用途 | 构造 | HKDF info / 哈希前缀 | AAD / MAC 输入 | 状态 |
|---|---|---|---|---|
| VK 指纹 `vkId` | HKDF(VK, ∅) 64 bit | `sixkey/v1/vk-id` | — | 现有 |
| 库加密 | HKDF(VK, ∅) → AES-256-GCM | `sixkey/v1/vault-enc` | `sixkey-vault\|1\|{vaultId}\|{vkId}\|{rev}` | 现有 |
| 密码包裹 | PBKDF2-SHA256 ≥600k（本机的新包裹 2M，同步引擎的 600k）, 16B salt | — | `sixkey-wrap\|1\|password\|{vkId}\|{vaultId}\|PBKDF2-SHA256:{iter}:{salt}` | 现有 |
| 恢复码包裹 | HKDF(code₁₂₈, salt) | `sixkey/v1/kek-recovery` | `sixkey-wrap\|1\|recovery\|{vkId}\|{vaultId}\|HKDF-SHA256:{salt}` | 现有 |
| 历史 VK | HKDF(VK_new, ∅) | `sixkey/v1/kek-previous` | `sixkey-prev\|1\|{vaultId}\|{newVkId}\|{oldVkId}` | 现有 |
| KeyBundle MAC | HKDF(VK, ∅) → HMAC-SHA256 | `sixkey/v1/keybundle-mac` | `"sixkey-keybundle\|1\|" ‖ canonicalJson(bundle 去掉 mac)` | 新 |
| 设备名 | HKDF(VK, ∅) → AES-256-GCM | `sixkey/v1/device-name` | `sixkey-devname\|1\|{vaultId}\|{vkId}\|{deviceId}` | 新 |
| 写入证明 | `K_write` = HKDF(VK, ∅) 256 bit；`write_proof` = HMAC-SHA256(K_write, 输入) | `sixkey/v1/vault-write` | 输入 `sixkey-write\|1\|{vaultId}\|{if_version}\|{envelope.checksum}` | 新 |
| 设备凭据副本（d2） | HKDF(VK, ∅) → AES-256-GCM | `sixkey/v1/device-backup` | `sixkey-devkey\|1\|{vaultId}\|{vkId}\|{deviceId}` | 新 |
| 恢复码入网证明 | `recAuth` = HKDF(code₁₂₈, ∅) 256 bit | `sixkey/v1/recovery-auth` | `verifier = SHA-256("sixkey-recovery-verifier\|1\|" ‖ recAuth)` | 新 |
| 敏感操作密码证明 | `pw_auth` = HKDF(PBKDF2-SHA256(NFKC(pw), salt_auth, ≥600k, 256 bit), ∅) | `sixkey/v1/password-auth` | `verifier = SHA-256("sixkey-password-verifier\|1\|" ‖ pw_auth)`；salt_auth 与迭代数在 KeyBundle.auth 中 | 新 |
| 入网承诺 C | SHA-256 | `sixkey-enroll-commit\|2\|` | 见 §3.2 | 修订 27（原 `\|1\|`） |
| 入网 transcript h | SHA-256 | `sixkey-enroll\|2\|` | 见 §3.2 | 修订 27（原 `\|1\|`） |
| SAS（N 显示，A 输入） | SHA-256 前 4 字节 uint32be mod 10⁶ | `sixkey/v2/enroll-sas\|` ‖ h | — | 修订 27（原 v1） |
| 配对码 S 的校验位（A 显示，N 输入） | 16 字节随机；校验位 = SHA-256(标签 ‖ S) 的前 12 bit | `sixkey-pairing-code\|1\|` | — | 修订 27 新增；确认码 CC 及其 v1 标签删除 |
| 入网密钥 K_enroll | ECDH P-256 → Z(32B)；HKDF(IKM = Z ‖ S, salt = h) → AES-256-GCM | `sixkey/v2/enroll-key` | 载荷 `sixkey-enroll-payload\|2\|{b64url(h)}`；设备名 `sixkey-enroll-name\|2\|{b64url(h)}` | 修订 27（原 v1，IKM 只有 Z） |
| 请求签名 | ECDSA P-256 / SHA-256，IEEE-P1363 r‖s | `sixkey-req\|1\|` | 见 §5.2 | 新 |

编码规则：
- 所有用 `|` 拼接的字段都来自不含 `|` 的字母表（base64url 无填充、标准 base64、小写 hex、十进制、UUID、大写 HTTP 方法、ASCII 路径；服务器拒绝含 `|` 的路径）。新增 base64url 辅助函数仅用于拼接字段，存储格式仍用标准 base64。
- 入网中 `dpk` 一律为 **SPKI DER**，`epk` 一律为 **65 字节未压缩点**（WebCrypto `raw` 导出），再 base64url。
- 所有新标签进入共享的已知答案向量（TS 与 Python 共用一份 JSON），并断言两两不同。
- **输出长度**（N3）：除 `vk-id`（64 bit）外，每个 HKDF 输出都是 256 bit；派生 HMAC 密钥（`K_mac`、`K_write` 的使用方）时必须显式给出 `length: 256`——WebCrypto 的 `deriveKey({name: "HMAC", hash: "SHA-256"})` 不写长度会得到 512 bit 的密钥，MAC 随之不同。
- **base64url 解码是严格的**（N19）：无填充、不接受其他字符、拒绝长度 mod 4 = 1 与非规范的尾部比特。标准 base64 沿用 Phase 0 `fromB64` 的规则（接受 `AB==` 这类非规范尾部比特），向量两种都覆盖。
- **哈希输入里的字节串**：SAS 与两个校验值的输入是 ASCII 标签后接**原始** 32 字节（`‖`），不是其 base64；SAS 是 6 位补零的十进制字符串；HKDF 的 IKM `Z ‖ S` 是原始的 32 + 16 字节；配对码校验位的输入是标签后接原始 16 字节；`rid` 在 T 中与线上都是小写带连字符的 UUID。

### 2.3 KeyBundle

```ts
type KeyBundle = {
  format: "sixkey-keybundle"; v: 1;
  vaultId: string;
  kver: number;          // 1 ≤ kver ≤ 2^53−1；每次改密码/换恢复码/轮换/修复都严格增大，取值见 §3.9 R1 的 publishKver（N27、F-01）；进入 MAC
  keyring: Keyring;      // 现有 v1 格式；同步时约束：wraps 恰好 {password, recovery}，无 deviceKey，previous ≤ 64
  auth: { kdf: Pbkdf2Params };  // pw_auth 的 salt 与迭代数（§3.14）；与密码包裹的 salt 不同
  by: string;            // 写入它的 deviceId；服务器校验它等于签名设备
  at: number;            // 写入时间，取整到小时（T1）
  mac: string;           // base64 HMAC-SHA256(K_mac(VK), "sixkey-keybundle|1|" ‖ canonicalJson(其余字段))
};
```
- 只有持有 VK 的一方能产生有效 MAC。MAC 防服务器篡改恢复码包裹、历史 VK 列表、`kver`、`auth`。
- **局限**：任何持有 VK 的人（包括轮换前的被吊销设备）都能为该 VK 伪造 MAC，所以 §3.9 的采用规则保证：即使收到持 VK 者伪造的 bundle，设备也不会被锁死、不会丢掉历史 VK、不会被引回旧 VK。
- **时间降精度**（T1、N4）：同步开启时所有 keyring 操作传入**向下截断到 UTC 整点**的 `now`（`floor(ms / 3 600 000) × 3 600 000`；天与分钟同理）；首次上传前把本地 keyring 里所有 `wraps[].createdAt`、`previous[].createdAt` 同样截断（它们不在任何 AAD 里，不影响解包）。截断在 §3.1 第 4 步之后、`init` 之前，以一次本地 transact 完成，所以上传的 keyring 与本地逐字节相同。保留 `by`：§3.10 的"写过当前 bundle 的设备必须走保护路径"要用它。
- **原文传输与存储**：bundle 在请求和数据库里都是 JSON 字符串原文（不用 jsonb），服务器不做任何"解析再序列化"。
- **前向兼容**：客户端按通用 JSON 解析 bundle、保留未知字段，所以较新客户端加的字段不会让 MAC 失效、仍可验证与采用；但若 bundle 含本客户端不认识的字段，它**拒绝在其基础上做任何密钥操作**（改密码、换恢复码、轮换），提示"请更新 Sixkey"——否则重建时会把那些字段丢掉。
- **只有整数**（N20）：KeyBundle、入网载荷与所有请求体里的数字都必须是安全整数（≤ 2⁵³−1）；服务器拒绝任何非整数的数字记号（如 `3.0`、`1e3`），因为 Phase 0 的 `canonicalJson` 是 `JSON.stringify` 语义，与 Python 的序列化只在整数上一致。
- 服务器无钥校验：形状、`vaultId` 与账户一致、`keyring.vkId` 与当前 `vk_id` 一致（改密钥）或与新 envelope 一致（轮换）、`if_kver < kver ≤ if_kver + KVER_MAX_JUMP`（N27：允许跳号，好让回档之后发布的 bundle 仍高于各设备见过的值；F-01：跳幅有上限 `KVER_MAX_JUMP = 65 536`，否则一个持 VK 者发布一次 kver = 2^53−1 就能让此后任何 bundle 都无法发布——再也不能改密码、换恢复码、轮换或修复；越界 → 422 `invalid_request`，与现有的 kver 规则同一个错误码）、`by` = 签名设备、KDF 参数在范围内、**`at` 与每个 `wraps[].createdAt`、`previous[].createdAt` 都是 3 600 000 的整数倍**（否则 422，N16——在毫秒时间进入数据库与 PITR 之前就挡住有缺陷的客户端；客户端读取时不做此检查）；**一致性**（P4）：恢复码包裹改变 ⇔ 请求带新 `recovery_verifier`；密码包裹改变 ⇔ `auth.kdf` 改变 ⇔ 请求带新 `password_verifier`。"包裹改变"按包裹的 `iv` 与 `wrapped` 字节判断，不看 `createdAt` 等其余成员（S-2；客户端与服务器用同一个依据，否则只差截断后 `createdAt` 的包裹会得到 422）。`auth.kdf.salt` 不同于密码包裹的 salt 是**客户端的生成规则**，服务器不检查（M1-6：没有任何安全性质依赖它，HKDF 单向）。客户端解析 bundle 与入网载荷时同样拒绝非整数的数字记号（M1-7）。不一致 → 422。

### 2.4 设备名密文

明文规则（N5）：先 NFKC，再去掉首尾的 U+0020；之后按以下顺序检查并拒绝——不是合法的 Unicode 字符串（含孤立代理项）、为空、超过 40 个**码点**（不是 UTF-16 单元）、含 General_Category Cc 的控制字符、含 Bidi 控制字符（U+061C、U+200E–200F、U+202A–202E、U+2066–2069）或零宽字符（U+200B–200D、U+2060、U+FEFF）。后两类会在批准方看到的"自称：…"里重排或隐藏文字。通过后 UTF-8 编码并**用空格补齐到 160 字节**（服务器看不出名字长短；40 码点 × 4 字节 = 160）；解码后去掉尾部空格。`name_ct = {vkId, iv, ct}`（成员名用 `vkId`，N6），`ct = AES-GCM(K_name(VK), 补齐后的名字)`，AAD 见 2.2。锁定时设备列表只显示"设备 · 最后同步时间"。轮换 VK 时由轮换方把所有设备名（含已吊销的）用新 VK 重新加密。

### 2.5 设备身份（IndexedDB `sixkey-identity` + storage.local 里的 VK 加密副本）

设备身份放在**两处**，因为在指纹浏览器里哪一处都可能单独丢失（d2）：GoLogin SDK 每次停止都删除 `Default/IndexedDB` 且不上传它；AdsPower、BitBrowser 的 IndexedDB 同步默认关闭——云同步的配置文件常常是"storage.local 跟着走、IndexedDB 不跟着走"。反过来，Chrome 修复损坏的 LevelDB 时也可能只丢 storage.local。

```ts
// IndexedDB 库 sixkey-identity：锁定时也能用（状态轮询、outbox 推送、角标需要签名）
type DeviceIdentity = {
  v: 1;
  deviceId: string;            // 16 随机字节 base64url（22 字符，符合 ID_RE）
  keyPair: CryptoKeyPair;      // ECDSA P-256；私钥在 IDB 中以 non-extractable 形式保存
  apiOrigin: string;           // 写入时的 API origin，换环境（dev/prod）不串用
  state: "pending" | "enrolled" | "rejected_by_server";
  vkId: string | null;         // 钉住的当前 VK（F7）；只在本地 keyring 写入成功之后更新
  maxSeenVersion: number;      // 回滚检测
  maxSeenKver: number;         // 回滚检测
  vaultId: string | null;      // 本账户库的 vaultId；本地 keyring 不在时用于"vaultId 必须一致"的检查（F-03）
  pinCount?: number;           // setPins 写钉住值的次数（缺省为 0），用来给待写副本排序（RR-4）
  adopted: {                   // 最近一次采用或确认同步的 bundle（F-06、F-07），与 maxSeenKver 同一次写入
    digest: string;            //   SHA-256(canonicalJson({keyring, auth}))，标准 base64；本地 keyring 不在时用它判断"内容相同"
    auth: { kdf: Pbkdf2Params };//  与本地密码包裹配套的 auth；R2 的"auth 只能随密码包裹一起变"以它为准
  } | null;                    // 未知时为 null（例如身份刚从副本恢复）
};                             // 不保存邮箱（d7）

// storage.local 键 sk_sync_cfg：VK 加密的副本，解锁后才能用
type SyncCfg = {
  v: 1;
  deviceId: string;
  apiOrigin: string;
  cursor?: { cur: string; pending?: string };   // 克隆软检测，只随 PUT 交换（§4.10）
  state: "pending" | "enrolled" | "rejected_by_server"; // 身份 state 的明文副本（M2R-7）：写入时为 "pending"；M3 每次改身份状态都用 cfg.setState 同步；身份从副本恢复时取它
  enc: { vkId: string; iv: string; ct: string }; // AES-GCM(K_devbackup(VK), canonicalJson({dsk: {crv, d, kty, x, y}, email}))，JWK 的 ext、key_ops 不保留（M1-9）；AAD 见 §2.2
};
```

**决定：DSK 私钥另存一份 VK 加密的副本**（`sk_sync_cfg.enc`）。
- 为什么：没有它，在"每次停止都删 IndexedDB"的环境里，配置文件每次启动都要重新入网，设备行无限增长，其他设备被批准请求刷屏——同步在这些环境里实际上不可用。
- 安全上的代价（S1，如实）：对**这台机器**不削弱——打开副本需要 VK，拿得到 VK 的人本来就能在这台机器上使用它的凭据，IDB 里那份 non-extractable 私钥也挡不住"复制 IndexedDB 文件"。但对**被复制到别处的副本**，副本 + 主密码就恢复出同一个设备身份，成为隐形的同步凭据（A3 残余）。这正是"加入同步的配置文件绝不能被厂商同步或共享"的原因。
- 为什么不只留这一份（删掉 IDB 那份）：那样锁定时就无法签名，outbox 快进推送、状态轮询、待批准角标都会失效。
- **生成流程**（S5）：DSK 以可导出方式生成；同一步把私钥以 non-extractable 形式导入 IDB（之后所有签名都用 IDB 那份），可导出的 JWK 只留在发起流程的标签页内存里，直到 VK 可用、写入 `sk_sync_cfg`，然后丢弃：首台设备本来就持有 VK，所以在**发送 `init` 之前**就写（§3.1 第 5 步），这样 `init` 的结果即使不明、标签页随后关闭，副本也已经在；入网设备在 §3.2 M7 / §3.3 第 4 步、`complete` 之前写；分出独立身份时，新身份的 `sk_sync_cfg` 与新 IDB 身份一起写好，再切换过去。标签页在写之前关闭，入网本来就要重新开始。
- 邮箱只在这份密文里（d7）：配置文件副本里不再有明文的"此配置文件用某某邮箱开启了 Sixkey 同步"。锁定时界面只显示"已登录"。
- VK 变化时（轮换、采用新 VK、入网）与其他 storage.local 密文一起重新加密；没来得及重新加密的旧副本仍可经 keyring.previous 打开。重新加密在清理（`finishKeyChange`）之前、由同一个服务层清理入口完成（§0.0i M2 要求第 5 条）。

**四种组合，都是一等状态**：

| IDB 身份 | storage.local（keyring + `sk_sync_cfg`） | 状态与处理 |
|---|---|---|
| 有 | 有 | 正常。 |
| **无** | 有 | `identity_missing`。界面明说原因（"浏览器或指纹浏览器清除了 IndexedDB"）。已解锁 → 自动从副本恢复 IDB 身份（状态取 `sk_sync_cfg.state`，M2R-7；钉住值：`vkId` 与 `vaultId` 取本地 keyring 的、`maxSeenVersion` 取服务器当前值、`adopted` 置 null、**`maxSeenKver` 置 0**——若取服务器当前值，本地 keyring 只是落后的设备会被误判为"服务器的密钥状态比本机旧"，并被引导去发布它过时的 keyring，N27），记一条本地事件；锁定 → 状态"解锁以恢复同步"，期间不签名、不推送。副本无法解开（不应发生）→ 一键重新入网，入网完成后用 `pw_auth` 吊销旧 deviceId，设备行不累积。 |
| 有 | **无** | 原 C7 路径：两槽/快照/镜像都丢了 → 云端恢复（§4.13），钉住值防止被引回旧 VK。 |
| 无 | 无 | 等同新安装，重新入网。 |

- **钉住值字段（`adopted`、`vaultId`、`maxSeenKver`）只经 `setPins` 改变**，每次 `pinCount` 加一。`update` 只改 state、`maxSeenVersion` 与 D8 前移的 `vkId`。否则一份较旧的待写副本会看起来仍然当前（RR-4）。排序用 `pinCount` 而不用 store 的 generation 或 digest：generation 会随 storage.local 一起回退，digest 分不清 A → B → A 与一份过时的 A。
- **`cfg_missing`**（IDB 身份在、库可读、`sk_sync_cfg` 不在）是一次没做完的"关闭同步"（或厂商只丢了 `sk_sync_cfg`）（RR-10）。同步守卫（§0.0i 第 18 条）仍只看 `sk_sync_cfg`，所以这里 Phase 0 的密钥操作照常可用，否则用户连密码都改不了。M3 在这里**从不跑同步轮次、不签名**：它完成关闭（`turnOffSync`），或由 M6 重新入网。设备密钥的副本无法从 non-extractable 的身份重建。
- 钉住值只在 IDB；IDB 丢失时，本地 keyring 本身就是"当前 VK"的依据，`maxSeen*` 丢一次只少一次回滚告警。
- 写入顺序：先 `transact` 本地 keyring，成功后才更新钉住值（`vkId`、`maxSeenKver`、`adopted` 一起写）与副本。钉住值另在提交前写成 storage.local 里的 `pendingPins`，提交后写进 IDB；每次判断之前由 `settlePins()` 只往前补齐（§0.0i 第 17 条，M2R-1）。`adopted` 取本机最近一次采用或成功发布的 bundle：建库时是上传的 bundle，入网时是载荷里（或恢复码入网时服务器返回）的 bundle，改密码、换恢复码、轮换、修复成功后是发布的 bundle，R2/R3 采用后是被采用的 bundle；确认"已同步"时不写。digest 一律用 M1 导出的同一个函数计算。中途崩溃由 §3.9 的钉住值修复规则（D8，两个方向）补上：本地提交因掉电丢失、身份记录却已写入（两个 LevelDB 各丢各的尾部）时，本机落后于自己的身份记录，见 D8 的第二个方向与 R1（GM2-5）。
- "关闭同步"与"移除同步身份"一步删除 IDB 身份、`sk_sync_cfg`、`sk_sync_state`、`sk_sync_outbox`、`sk_sync_orphan`、`sk_sync_staged`（D11；先把能打开的孤儿条目并入本机库；只剩搁置条目时保留 `sk_sync_orphan`，§4.7），否则下次解锁会从副本把已撤掉的身份又恢复出来；`sk_prejoin` 保留。
- 和 HLC 设备 ID（`sk_device`，Phase 0）不是同一个东西：后者只是时间戳的平局裁决者，继续保留（克隆分身时重新生成，§4.10）。

### 2.6 算法与版本标识（crypto-agility，修订 27）

**原则**：首次发布之前，凡是可能更换的算法都要能从数据本身认出来，所以将来换算法不必猜、也不会丢数据。

**这些标识在首次发布前必须存在**（现在都已存在，入网的那几项在修订 27 升为 v2）：

| 对象 | 字段与取值 |
|---|---|
| 库 envelope | `format: "sixkey-vault"`、`formatVersion: 1`、`cipher: "AES-256-GCM"` |
| keyring | `format: "sixkey-keyring"`、`v: 1`；每个包裹的 `method` 与 `kdf {name, hash, v, …}`（如 `{name: "PBKDF2", hash: "SHA-256", iterations, salt, v: 1}`） |
| KeyBundle | `format: "sixkey-keybundle"`、`v: 1`；`auth.kdf` 同上 |
| 入网载荷 P | `format: "sixkey-enroll-payload"`、**`v: 2`** |
| 入网的域分隔 | `sixkey-enroll-commit\|2\|`、`sixkey-enroll\|2\|`、`sixkey-enroll-name\|2\|`、`sixkey-enroll-payload\|2\|`、`sixkey/v2/enroll-key`、`sixkey/v2/enroll-sas\|`、`sixkey-pairing-code\|1\|` |
| 其余 HKDF 标签与 AAD | `sixkey/v1/...`、`sixkey-*\|1\|`（§2.2，契约检查 H8 守住） |
| 请求签名输入 | `sixkey-req\|1\|` |
| 设备公钥 | SPKI DER：算法由其中的 OID 表明（现为 `id-ecPublicKey` + `prime256v1`） |
| 库的 schema | `schemaVersion`（按内容派生，§3.13） |
| 本机记录 | 带版本的本机记录（如 `sk_keychange`、`sk_store_v`、`sk_sync_orphan`、`sk_prejoin`）的 `v` |

**规则**：
- **验签按设备公钥 SPKI 里的算法 OID 选择验证方法**，不认识的 OID 一律拒绝。现在契约只接受 P-256 SPKI 的精确前缀，这就是 v1 的写法。将来加 ML-DSA 时，新增一个 OID、签名输入的下一个版本号及其签名长度；openapi 的 `SpkiP256` 那时也要放宽。不需要协商字段 `sig_alg`：OID 就是标识。
- **入网版本由域分隔表明**：N 与 A 若版本不同，承诺、SAS 或解密会失败，即失败关闭，不会悄悄互通。没有协商。
- **永不丢弃旧格式的读取器**：旧 envelope、keyring 与快照必须一直读得出；新版本只增加读取器（§3.13 的兼容性一栏）。入网是例外，它不留存任何东西，所以 v2 直接取代 v1。
- **将来的后量子迁移**：
  - **对称部分**（AES-256-GCM、HKDF/HMAC-SHA256、PBKDF2、128 bit 的恢复码与配对码）不需要为量子而迁移。
  - **入网**：以后若要恢复成短码、或在配对码之外再加一层，就用混合 KEM：`IKM = Z ‖ ss_mlkem ‖ S`（或把配对码换成 KEM），作为入网 v3。只在 WebCrypto 的 ML-KEM 在我们的最低 Chrome 版本上**稳定**提供时才用。纯 JS 实现只有经过独立审计、并对常数时间有可接受的说明时才考虑；从不用 WASM（CSP 禁止）。
  - **请求签名**：ML-DSA 在稳定的 WebCrypto 提供之后，经"分出独立身份"或吊销后重新入网换成新的设备密钥，不触及库的数据。至迟按 NIST IR 8547 草案的时间表（2030 年后不推荐 P-256 一类的经典公钥算法）。
  - 现状见 `PQ-READINESS.md`：截至 2026-10，Chrome 的 ML-KEM/ML-DSA 只在 M150 的 DevTrial（需开关）与 M151–154 的 origin trial 里。

---

## 3. 协议

### 3.0 代码层面必须遵守的不变量（来自 Phase 0 实现，评审已逐条核对）

| # | 不变量 | 来源 | 本设计如何遵守 |
|---|---|---|---|
| I1 | 一个 Generation 的 envelope.vkId/vaultId 必须等于其 keyring 的 | `checkGeneration` | 换 VK 时在**一次 `transact`** 中同时写入重新加密的 envelope 和新 keyring。远端 keyring 永不单独进入 Generation；待采用的密钥材料放在 `sk_sync_staged`。 |
| I2 | session 中的 VK id ≠ keyring.vkId 时 `currentVk` 视为锁定 | `service.currentVk` | 采用新 VK 的 `transact` 提交后**立即** `startSession(newVk)`；两步之间崩溃 = 设备显示锁定，输入密码即可。 |
| I3 | `openVault`/`tryOpen` 只尝试当前 VK | `store.openVault` | 【逻辑变更】回退候选可用 keyring.previous 中的旧 VK 打开；选中旧 VK 的候选时先用当前 VK 重新加密再 `transact`。 |
| I4 | 每次本地保存 `rev = cur.rev + 1` | `service.mutate` | 本地 rev 是本地计数器；上传时单独重新加密，`rev` = 服务器新 version。 |
| I5 | `rekey()` 总会生成新的恢复码 | `keyring.rekey` | 所有轮换都"先展示新恢复码、用户确认已保存，再提交服务器"（§3.8）。 |
| I6 | `mergeVaults` 遇到不同 vaultId 抛异常 | `merge.ts` | 引擎先比 vaultId；已有账户的设备入网走"采用云端库 + added 模式导入"；同 vaultId 走 `mergeVaults`（§3.5）。 |
| I7 | `addSnapshot`/`parseSnapshotIndex`/`checkSnapshot` 只认 `rolling` 与 `daily` | `store.ts` / `format.ts` | **本设计不新增快照类型**，合并前状态由已有的 rolling 快照承担（§4.4）。 |
| I8 | `editEntry` 不能改 `secret`（只有 purge 能把它清空） | `ops.ts` | 同一 id 的 secret 从非空变成另一个非空值必为异常，是守卫的阻塞条件（§4.4）。 |
| I9 | 存储里只有恢复码的包裹，没有恢复码本身 | `keyring.setRecovery` | 开启同步需要用户重新输入恢复码（或生成新码），才能算出 `recovery_verifier`（§3.1）。 |
| I10 | 无变化的 `mutate` 仍会 `transact`，但写回原 envelope | `service.mutate` | 因此 envelope 校验和是可靠的"内容是否变化"标记（§4.1）。 |
| I11 | `parseEntry` 只重建已知字段 | `validate.ts` | 前向兼容规则：新增任何条目字段都必须升 `schemaVersion`，旧客户端随之 `paused_newer`，不会把未知字段合并丢掉（§3.13）。`schemaVersion` 本身按内容派生，不是保存的常量（§3.13）。KeyBundle 的同类规则见 §2.3。 |
| I12 | store 不知道同步状态；恢复只追加用户可确认的事件（可被确认、被截断） | `store.recover`/`pushEvent`/`ackEvents` | store 新增 `beforeRecoveryWrite` 钩子，同步状态永不从事件列表推导（§4.1，D1）。 |

### 3.1 第一台设备开启同步

前提：本机已设主密码（H1 之后的新安装天然满足；旧的设备密钥库先走 Phase 0 的 `enableMasterPassword`，它会换 VK）、已解锁、在线。

1. 设置页 → 同步 → "开启同步"：先展示"服务器能看到什么"（O1 卡片）。
   - **在这一次点击里**，先调用 `chrome.permissions.request({origins: ["https://api.sixkey.app/*"]})` 请求可选 host 权限（§7）。它必须在用户手势里、在任何异步步骤之前，所以排在主密码与邮箱 OTP 之前。之后的每一步都要联网，第 2 步的 OTP 也是。
   - 用户拒绝 → 停在这里，说明"不授权就无法同步，本机照常使用"。
   - 授权后要求输入一次主密码（用来计算 `pw_auth`，也确认用户记得它）。
   - "加入已有保险库"（§3.2、§3.3）同样在第一次点击里请求。
2. 邮箱 OTP：`POST /v1/auth/otp` → 用户输入 6 位 → `POST /v1/auth/verify` → 账户会话（只在该标签页内存中）。
- **界面上的顺序**（修订 24，M6）：主密码 → 邮箱验证码 → 账户检查 → 设备名 → 恢复码 → 上传。
  - 设备名与恢复码都排在账户检查之后：邮箱已有库的用户直接转入入网，不必先起名，也不必生成一份在那里没用的恢复码。
  - 设备名只是先在界面上收集，第 5 步才生成 `deviceId` 与 DSK。
3. `GET /v1/account`：`has_vault: false` → 继续；`has_vault: true` → 转入入网（§3.2 / §3.3），并显示 §3.5 的警告。
4. 恢复码（I9）：(a) 输入现有恢复码，客户端用 `unlockWithRecoveryCode(本地 keyring)` 验证；或 (b) 生成新码：内存中 `setRecovery` → 展示 → 用户回填随机两组确认已保存 → 才本地 `transact`。这一步不可跳过（已决 Q2-a）。
   - 确认方式是回填两组，不是 Phase 0 界面的勾选框。
   - 复制按钮在用户允许时 30 秒后清空剪贴板。
   - 屏幕写明：新码一经确认，旧码立即失效，即使用户随后中止开启——本地提交已经发生。
   - **锁定规则**（修订 24）：码准备之后库若已锁定，(b) 的提交以 `locked` 拒绝。否则站在锁定页面前的人可以把屏幕上看到的码确认生效。随后、第 5 步之前（同步尚未开启），用一次本地 keyring transact 把本地 keyring 的全部 `createdAt` 截断到小时：已对齐则不写；它改变 keyring，所以照常写标记、做一次清理。第 6 步上传的就是这份 keyring 本身（§0.0i 第 16 条）。截断是一个带 `noSync` 的服务方法。**`init` 的 bundle 用第 5 步之后读到的本地 keyring 构建**（RR-12）：第 4–5 步时 `sk_sync_cfg` 还不在，另一标签页的 Phase 0 密钥操作不会被拒；第 5 步之后才会。
5. 生成 `deviceId`、DSK（§2.5 的生成流程）；用户填写设备名（默认"Chrome 配置文件"）；写入 `sixkey-identity`（`state: "pending"`），并**在发送 `init` 之前**写好 `sk_sync_cfg`（DSK 副本 + 邮箱，用当前 VK 加密，D4）。
6. `POST /v1/vault/init`（账户会话 + 新 DSK 签名，证明持有私钥）：
   - `vault_id`（沿用本地 keyring.vaultId）；`envelope`：明文填充（§4.1）后用当前 VK 加密，`rev = 1`，JSON 字符串原文
   - `bundle`：`{kver: 1, keyring: 本地 keyring 本身（第 4 步之后已截断到小时）, auth: {kdf: 新 PBKDF2 参数}, by, at, mac}`（原文）
   - `recovery_verifier`、`password_verifier`、`write_key`（`K_write`）
   - `device: {device_id, sig_pubkey, name_ct}`
7. `201 {version: 1, kver: 1}` → identity `enrolled`（并 `cfg.setState("enrolled")`），钉住 `vkId`、`vaultId`、`maxSeenVersion = 1`、`maxSeenKver = 1`、`adopted = adoptedRecord(发出的 bundle)`（`setPins` 与 `update`；本地 keyring 没有变，不经 `commitKeys`）；`sk_sync_state.lastSynced = null`（第一轮做一次完整拉取，§4.1）；丢弃账户会话。（`sk_sync_cfg` 已在第 5 步写好。）
   - **结果不明**（网络错误、超时、标签页或 SW 中途被关，D4）：`init` 按原文幂等——同样的 `vault_id`、`device_id`、`sig_pubkey` 与 bundle 原文重试，服务器返回同样的 201。若请求内容已丢失（标签页关闭），重开后以 pending 身份的 deviceId 签名查 `GET /v1/sync/status`：200 = 已经建好，补做第 7 步的本地部分（写"已同步"的钉住值之前，无论 201 之后还是这里，都先确认本地 keyring 仍是发出的那份，不是就不写、按普通一轮处理，RR-12；钉住值取 `GET /v1/keys` 的 bundle：用本机 VK 验 MAC、keyring 与本地相同，即 `evaluateSameVkBundle` 的 `in_sync`）；`401 unknown_device` = 没建成，重新开始。
   - `409 vault_exists` 且上一步确认本 deviceId **不在**该库中（另一台设备抢先建了库）→ 转入入网；若第 4 步刚生成了新恢复码，此时才提示"刚才的恢复密钥只对本机原来的库有效，对已有的同步库无效"，并指向"验证恢复密钥"。

**服务器上存在的包裹密钥**：密码包裹、恢复码包裹（都在 KeyBundle 中）。没有持久的每设备包裹；批准包裹只在入网的 10 分钟内以密文形式经过服务器，完成即删。

### 3.2 通过批准入网（承诺式 ECDH + 配对码 + 6 位 SAS；修订 27 为入网 v2）

角色：N = 新设备，A = 已入网、已解锁的批准方，S = 服务器（只转发）。两端都在**设置页标签页**中进行（popup 失焦即关闭）。

```
N0  N: 邮箱 OTP → 账户会话；GET /v1/account → has_vault=true（显示 §3.5 警告）→ 选"用另一台设备批准"
N1  N: 生成 devN、DSK_N(dpk_N)（§2.5 生成流程）、临时 ECDH(esk_N, epk_N)、32B 随机 n_N
       C = SHA-256("sixkey-enroll-commit|2|" devN "|" b64u(dpk_N) "|" b64u(epk_N) "|" b64u(n_N))
M1  N→S  POST /v1/enroll/requests {device_id: devN, sig_pubkey: dpk_N, commit: C}   （账户会话 + DSK_N 签名）
    S→N  {request_id: rid, expires_at: now+10min}      状态 pending（每个账户会话最多 1 个）
    N 显示："在已同步的设备上打开 Sixkey 设置 → 同步 → 批准新设备"（此时还没有任何码）
M2  A: 打开"批准新设备"→ 输入主密码 → §3.14 的发送前检查（拉最新 bundle 并验证；A 必须处于服务器当前 vkId，否则先 R3）
       → GET /v1/enroll/requests 列出待处理请求（"30 秒前发起"）→ 用户点选一个
       A 读取该请求并【钉住】(rid, devN, dpk_N, C)；缺任何一项则拒绝
       A 生成临时 ECDH(esk_A, epk_A) 与配对码 S = 16 字节随机（crypto.getRandomValues；只在 A 的内存与屏幕上）
    A→S  POST /v1/enroll/requests/{rid}/respond {epk: epk_A, password_auth}   （A 签名；CAS pending→responded，只允许一个批准方）
       请求里没有 S，也没有任何由 S 派生的东西
    respond 被接受之后，A 大字显示配对码（28 个字符，7 组 × 4，附［复制］）："在新设备上输入这个配对码"
M3  N 轮询 GET /v1/enroll/requests/{rid}（DSK_N 签名）→ 第一次看到 responded 时【钉住】(devA, epk_A)
       N 请用户输入批准设备上显示的配对码（可粘贴；规范化与校验位见 MUST 10）→ 得到 S（16 字节）
       T  = "sixkey-enroll|2|" rid "|" devN "|" devA "|" b64u(dpk_N) "|" b64u(epk_N) "|" b64u(epk_A) "|" b64u(n_N)
       h  = SHA-256(T)；Z = ECDH(esk_N, epk_A)；K = HKDF(IKM = Z ‖ S, salt = h, info = "sixkey/v2/enroll-key") → AES-256-GCM
       SAS = uint32be(SHA-256("sixkey/v2/enroll-sas|" ‖ h)[0..4]) mod 10^6      （只算一次）
    N→S  POST …/reveal {epk: epk_N, nonce: n_N, name_ct: AES-GCM(K, 设备名, AAD "sixkey-enroll-name|2|" b64u(h))}
    N 大字显示 SAS "123 456"："在刚才显示配对码的那台设备上输入这 6 位数字"
M4  A 轮询 → 用【钉住的】devN、dpk_N、C 校验收到的 (epk_N, n_N)（不一致：拒绝并告警"可能被篡改"）
       算 T、h、Z、K（用它自己的 S）、SAS_A（只算一次）；用 K 解出设备名，标注为"自称：…"
       设备名解不开 → 中止 pairing_mismatch：N 上输错了配对码（校验位漏掉的约 1/4096），或 reveal 被篡改；
         A 作废请求（POST …/reject）并提示"配对码不符，请重新开始"（终态，MUST 3、7）；
         N 只看到请求被拒绝（它无从得知原因，服务器也可能谎报），提示"请求已结束；如果配对码输错了，请重新开始"
       用户输入 N 屏幕上的 SAS（允许粘贴；最多 3 次，都与同一个 SAS_A 比较，之后作废该请求）
M5  SAS 相等 → A 组装 P = canonicalJson({format:"sixkey-enroll-payload", v:2, vaultId, vk: b64(VK), bundle: <发出 approve 前发送前检查返回的服务器 bundle 原文（F-09）>, approver: devA, at})
       payload = AES-GCM(K, P, AAD "sixkey-enroll-payload|2|" b64u(h))；name_ct = AES-GCM(K_name(VK), 补齐后的设备名)
       （`bundle` 是原文字符串，N 拿到的正是服务器存的字节，P 里没有任何东西被重新序列化；`P.at` 是精确毫秒，服务器看不到它，N7）
    A→S  POST …/approve {transcript_hash: h, payload, name_ct, sig_pubkey_sha256: SHA-256(dpk_N), password_auth}   （CAS revealed→approved）
    200 之后 A 显示"已批准，新设备正在完成加入"；没有确认码；A 丢弃 S 与临时私钥
M6  N 轮询 → approved，收到 payload → 用 K 解密（AES-GCM 认证）
       解不开 → 中止 bad_payload，POST …/reject 并清除 pending 身份
       【只有用 K 解开的载荷才会被使用；不知道 S 的服务器做不出这样的载荷】
M7  解开 → 校验 vkFromRaw(vk).id == bundle.keyring.vkId、bundle MAC、P.vaultId == bundle.vaultId、P.approver == 钉住的 devA、P.v == 2（P 中未知成员忽略，M1-8）
       → 按 §3.5 写本地（空 / 有自己的库 / 同 vaultId；同一步写 sk_sync_cfg）→ startSession(VK) → 钉住 vkId、maxSeenKver
    N→S  POST …/complete（Sixkey-Enroll 签名）→ S 此时才建 devices 行（joined_via=approval, approved_by=devA, name_ct），删除请求（含 payload）
       complete 删除请求行，同一 rid 的重试得到 410；结果不明时 N 以 devN 签名查状态，200 即已入网（D4、A17）；幂等 200 只适用于另一次请求为同一 devN + 同一公钥再次 complete
M8  N 第一次同步（lastSynced 为空 → 完整拉取 + 合并）
```
- 任一状态 10 分钟内未完成：S 删除；双方提示"已过期，请重试"。任一方可随时 `POST …/reject`；批准方还可在待处理列表上一次拒绝全部：`POST /v1/enroll/reject-all {password_auth}`（N22）。
- **轮询视图里的字段**（F-10）：新设备视角从 `responded` 起的每个状态都带 `approver_device_id` 与 `approver_epk`，`approved` 时另带 `payload`；批准方视角每个状态都带 `new_device_id`、`new_sig_pubkey`、`commit`，从 `revealed` 起另带 `new_epk`、`new_nonce`、`new_name_ct`。缺少应有的字段与给出不同的值一样，按 MUST 1/2 中止。
- **批准用的 bundle 来自发送前检查**（F-09）：第 M2 步的 `respond` 使用 §3.14 发送前检查（`op = respond`）返回的"已验证的服务器 bundle"对象；第 M5 步在发出 `approve` 之前**重新**做一次（`op = approve`），P 里的 `bundle` 就是它返回的原文。这个对象是服务器当前的、MAC 与 vaultId 已验证的原文，且本机不处于 `keys_behind`；构建 respond/approve 的函数只接受它，不接受任意 bundle 原文。两次检查之间 VK 变了（别处轮换）→ 请求以失败 `keys_changed` 结束（终态，MUST 7），A 作废该请求（`POST …/reject`，与 SAS 三次不符相同），先按 R3 跟上，再由用户在新设备上重新发起（MUST 3；M1-18）。
- **K_enroll 密文的线上形式**（N6）：`payload` 与 reveal 的 `name_ct` 都是标准 base64 的 `iv(12) ‖ ciphertext ‖ tag(16)`；reveal 的设备名同样按 §2.4 的规则校验并**补齐到 160 字节**再加密（N5），所以入网期间服务器也看不出名字长短。

**MUST 规则**（P1 + F1；配对码的 2^-128 与 SAS 的 10⁻⁶ 两个界都依赖它们，实现与测试都必须覆盖）：
1. A 在 `respond` 之前一次性钉住 `(rid, devN, dpk_N, C)`；之后服务器给出任何不同的值 → 中止。
2. N 从第一次看到 `responded` 的轮询结果钉住 `(devA, epk_A)`；SAS 只算一次、只显示这一个数；之后服务器给出不同的值 → 中止并告警。
3. N **永不自动重新发起**请求（410、网络错误、超时都只显示错误，由用户显式重新开始）。
4. A 的 3 次输入都与同一个钉住的 SAS_A 比较，其间不更换临时密钥。
5. A 只在 `respond` 被服务器接受之后显示配对码 S。S 从不发送、存储或记录：不进任何请求体、URL、日志、诊断、安全记录或 storage，在 A 上只在内存与屏幕上；唯一的例外是用户自己点的［复制］，它经过系统剪贴板（§7 的提示）。N 只使用用 K（其中含 S）解开的载荷。修订 27 起没有确认码。
6. 请求结束（完成、拒绝、过期、标签页关闭）时两端丢弃临时私钥。
7. **失败是终态，并且优先于在途的异步步骤**（F-04）：每一步先把结果算进局部变量，最后在一个同步段里提交，提交前确认状态机仍处于这一步开始时的阶段且没有失败；用户取消、请求被拒或过期发生在某一步的 `await` 期间时，该步丢弃结果，不返回任何请求体、配对码或密钥。
8. **批准方的 approve 竞争**（F-05）：approve 请求在途时页面不轮询；若仍收到一次轮询结果为 `approved` 且全部钉住值不变，它等同于 approve 的 200（可以显示"已批准"）；在发出 approve 之前（例如还在核对 SAS）看到 `approved` 仍是异常，按 9 中止。
9. 其他边界（M1-14、M1-15）：不是 6 位数字的输入（先去掉空格与 `-`）返回"格式不对"，**不计入** 3 次机会；轮询结果报告的状态领先于本端（例如 N 还没 reveal 就看到 `approved`）→ 中止 `unexpected_state`；epk_A 与 epk_N 相同（反射）→ 中止 `reflected_key`。
10. **配对码 S**（修订 27）：
    - **生成与显示**：128 个随机 bit。显示为恢复码的格式：128 bit + 12 个校验位 = 140 bit = 28 个 Crockford base32 字符，7 组 × 4，以 `-` 连接，等宽字体。校验位是 `SHA-256("sixkey-pairing-code|1|" ‖ S)` 的前 12 bit；恢复码的校验位不带标签，所以把恢复码输进这里会被校验位拒绝（漏过的约 1/4096）。A 的［复制］在用户允许时 30 秒后清空剪贴板。
    - **输入（N）**：可粘贴；不分大小写，忽略空格与 `-`，O 读作 0、I/L 读作 1（Crockford）。规范化之后不是 28 个合法字符 → "格式不对"；校验位不对 → "这个码有误，请对照批准设备上的码核对"。两者都只在本地判断，**不算一次机会、不改状态**，输入框保留内容供改正。
    - **没有在线预言机**：Sixkey 从不发送 S，也不发送由它派生、可以单独核对的东西（没有哈希、没有校验值）。失败只以作废请求的形式让服务器知道，与 SAS 三次不符相同。唯一的离线检验是：做中间人的服务器知道自己那一侧的 Z，可以拿 reveal 的 `name_ct` 或载荷试猜 S，每猜一次要做一次 HKDF + AES-GCM，而这个密钥依赖 S 的全部 128 bit，所以不可行。
    - **S 的长度是安全参数，永远不能缩短**：上面的离线检验只因为 128 bit 才不可行。将来要用短码，就必须换成 PAKE，不能沿用这个构造（§2.6）。
    - **一个请求只 reveal 一次**：校验位漏过的输错（约 1/4096）在 M4 由 A 发现（设备名解不开 → `pairing_mismatch`，终态），用户重新开始（MUST 3）。
    - **寿命**：至多到请求过期（10 分钟）；任何结束（完成、拒绝、过期、取消、锁定、标签页关闭）都丢弃它（MUST 6）。

为什么这样能挡住中间人，以及"先录下、以后解密"：
- **机密性靠配对码**（修订 27）：
  - 入网的每一份密文（reveal 时的设备名、approve 时的载荷）都在 `K = HKDF(Z ‖ S, h)` 之下。
  - S 有 128 bit，Sixkey 从不发送它，它由用户从一块屏幕抄到另一台设备上。所以录下整个入网过程的服务器，即使将来用量子计算机解出 ECDH 的 Z，没有 S 也解不开：经典上 2^128，Grover 约 2^64 次串行求值，相当于 NIST 第 1 类。
  - 修订 27 之前，载荷里的 VK 只受 ECDH P-256 保护，那是全设计里唯一一处"先录下、以后解密"的暴露（`PQ-READINESS.md`）。
- 服务器若替换任一方的临时公钥或身份，A 与 N 的 transcript 不同（h1 ≠ h2）。
- **A 一侧**：
  - 第一道是配对码：没有 S 的服务器做不出 A 能解开的设备名（M4，否则 `pairing_mismatch`），也解不开 A 发出的载荷，概率 2^-128。
  - 第二道是 SAS，与 S 无关：N 的全部贡献在看到 epk_A 之前就被承诺，A 的贡献在 N 揭示之前就被固定，所以 SAS_A 与 SAS_N 对服务器而言是两个独立均匀的数，单次 10⁻⁶。配对码泄露（例如屏幕被人看到）时，它仍然挡住中间人。
  - 所以 SAS 保留，它也是防诈骗提示的落脚处。
- **N 一侧**（F1，取代确认码 CC）：服务器做不出一份用含 S 的 K 加密的载荷，而 N 只使用用 K 解开的载荷。所以**只要 S 没有泄露**，N 被骗（把本机账户导入服务器的假库）的概率是猜中 S 的概率 2^-128。
  - 这和 CC 的前提不同：CC 不必保密，它安全是因为只有真实的 A 会把它显示在用户屏幕上。S 必须保密。
  - S 泄露到服务器一方时，N 一侧没有第二道防线，A 的 SAS 核对保护不了 N：服务器可以冒充 A，用含 S 的 K 送出自己的载荷。这条残余见 §1.3 与 §10 第 110 条。
- 每次失败都需要用户可见地重来一次；按规则 3，服务器无法让 N 自己反复重抽。
- **输入**：两个方向各输一次，A→N 输 28 个字符的配对码，N→A 输 6 位 SAS。配对码对服务器是秘密，但对用户自己不是：同一台电脑上不同配置文件之间复制粘贴（共用系统剪贴板）没有问题。
- 全部用 WebCrypto 原生 ECDH P-256 + HKDF + AES-GCM，无需新依赖。

其他安全要点：服务器替换 dpk_N 会改变 C 与 T；载荷绑定 h，只有 esk_N 能解，状态机一次性；首台设备被服务器谎称"已有库"时，用户没有真实的 A 可以给出配对码，流程走不下去（恢复码路径同样安全，见 §3.3）。

### 3.3 通过恢复码入网（自助，绕过批准）

1. N：邮箱 OTP → `has_vault: true` → 选"使用恢复密钥"。
2. 用户输入恢复码 → `parseRecoveryCode`（12 bit 校验位先在本地发现打错）→ 128 bit secret → `recAuth`。
3. N 生成 devN、DSK_N → `POST /v1/enroll/recovery {device_id, sig_pubkey, recovery_auth}`（账户会话 + DSK_N 签名）。S：限流 → 常数时间比较 verifier → 不符 `403 recovery_mismatch` → 相符则建一条 `via=recovery, state=approved` 的入网记录，返回 `{request_id, vault_id, version, envelope, kver, bundle}`。同一 devN + 同一公钥在有效期内重试得到同样结果。
4. N：`unlockWithRecoveryCode(bundle.keyring, code)` → VK → 校验 MAC、vkId 与 `bundle.vaultId == vault_id`（用与 M7 同一个"验证收到的 bundle"函数）→ §3.5 写本地（含 `sk_sync_cfg`）→ session → 钉住 → `POST …/complete {name_ct}`（此时才建设备行，`joined_via=recovery`；幂等与结果不明的处理同 §3.2 M7）。
5. 紧接着强烈建议生成新的恢复码（§3.7）；忘了主密码的用户同时设置新密码（一次 bundle 更新里同时换两个包裹，以 `recovery_auth` 代替旧 `pw_auth`，发送前检查用恢复码版本，§3.14）。界面与 Phase 0.x 的重设相同（A4）：在设置页标签页里进行（不在会因失焦关闭的弹窗里），新密码输入两次，新恢复码先显示、用户确认已保存后才提交（先显示后提交，§0.0i 第 14 条）。
6. 其他所有设备显示："新设备'X'于 {时间} 通过**恢复密钥**加入。不是你？立即吊销并保护。"

恢复码路径不怕服务器冒充：服务器不知道恢复码，做不出能用用户恢复码打开的包裹，所以给不了假库。服务器在这一刻得知 `recAuth`，它与恢复码 KEK 由不同 info 派生，打不开包裹。

### 3.4 邀请码：暂不做（所有者 2026-10-15）

共享或批量的配置文件用"导出所选账户"（§9.1 H2），只放它需要的那几个账户。设计里不保留任何邀请码专用的表、端点、状态或标签；将来若要加，它只是第三条"先写本地、再 `complete`"的入网路径（与 §3.2、§3.3 同一模式），不需要改动现有对象。

### 3.5 加入已有库：警告与本机数据

- **警告文字**（防抢注，A2）：`GET /v1/account` 返回库的建立时间和设备数，N 显示："此邮箱在 {日期} 已建立同步库，共 {n} 台设备。如果你从未在别处开启过 Sixkey 同步，说明别人可能控制了你的邮箱——不要继续。"（这些数字由服务器给出，只是提醒；真正的保护是配对码，§3.2。）
- 原来的"你是否在自己的设备上输入了 SAS"是非题已删除，由 CC 取代（F1），修订 27 起由配对码取代。
- **共享警告**（d5、S1，入网确认页）："这个配置文件会被他人使用，或会被浏览器厂商同步、复制吗？若是，**不要让它加入同步**：每个能打开它并知道主密码的人都能看到全部账户，它的副本还会成为一个看不见的同步设备。请改用'导出所选账户'，只放这个配置文件需要的那几个。"
- **本机数据的处理**（M7 在载荷用 K 解开之后、`complete` 之前执行；无论哪种情况，同一步里都写 `sk_sync_cfg`——DSK 副本 + 邮箱，用云端 VK 加密；`lastSynced` 为空）：
  - **`sk_prejoin` 是只追加的列表**（修订 25，M6 §13.5 第 12 条）：
    - **格式**：格式 2 为 `{v: 2, items: [...]}`。修订 25 之前的单条记录读作列表里的一条，原样不变，下一次改动列表的写入才把它写成列表。
    - **追加**：每次 added 模式的入网追加自己的一条，从不替换；同一次入网的重试不重复写入。
    - **读回校验**：入网的写入把整个列表（含先前的条目）读回比较，磁盘丢了或改了任何一条，入网失败。
    - **上限**：至多 8 条、合计 2 MiB（一个 `chrome.storage.local` 值，每次换密钥与每次永久删除都整体重写）。入网自己那条会超过上限时，在第一步就被拒（`kept_full`：什么都不写、不发送，告诉用户先删掉哪些）；从不为腾地方丢掉列表里的任何一条。
    - **删除**：只有用户在页面里确认的删除能移除条目，页面须已解锁，删除的恰好是屏幕上列出的那几条。不需要主密码，但要经页面内的 danger 确认。页面只按存储的样子列出它们，从不解密。
    - **"永久删除"**：从每个能打开的保留库里清除被删除的账户（按账户的身份，与另一个库的副本相同）；打不开的原样保留（例如 start over 之后不再持有的密钥下的，或损坏的），并当场说明有几个没能检查、去哪里删除。docs/security/local-vault.md 与 PRIVACY.md 写明这个残余：这样的条目可能还含有之后删除的账户，持有那个旧云端账户密码并能访问其服务器的人仍能打开它。
    - **Start over** 不删除保留的库：它们不是它要丢弃的不可读残留。它的 DELETE 确认框在有保留库时写明这一点。
    - **导出与重新导入**保留库暂不做：需要的密钥在 start over 之后可能已不在，重新导入还会带回入网以来在同步库里删除的账户。
  - **锁定规则**（修订 24）：在本配置文件的库打开时准备的入网，库若随后锁定，提交以 `locked` 拒绝。提交以云端密钥的会话结束，否则会不经主密码就打开锁定的页面。本机没有可锁的东西（空库、库不可读、或没有主密码）时，锁定纪元会变，但不算锁定，首次运行的入网照常进行。
  - **批准入网的摘要**（修订 24，M6 偏离第 10 条）：
    - 批准路径在准备入网时还看不到云端库的账户，它们随第一轮同步才到（入网载荷带的是 KeyBundle，不是库）。所以本机与云端都有的账户会出现两次：id 不同，什么都不丢。摘要如实说明，不给"跳过 d 个重复"的数字；恢复码路径看得到云端账户，照常跳过并计数。
    - **去重**（修订 24 要求，修订 26 按 M6C 的实现写定）：
      - **记录**：批准入网在它提交的第一次写入里（与清空 `lastSynced`、`pendingPins` 同一次写入，在提交点之前）记下它新加的条目 id：`sk_sync_state.joinAdded = {vaultId, ids, at}`，只有 id，没有内容与名字。其他入网不写，并清掉先前留下的记录。
      - 一次没做完的入网（complete 没落地）在下一次入网之前会被撤销，撤销删除同步的记录，也删这条。但撤销把它交给下一次入网：若下一次是合并到同一个库的入网（本配置文件已持有记录所指的副本），就保留它，去重照样进行。
      - **时机**：在一次持有 VK、结果为 `ok` 且设置了 `lastSynced` 的一轮之后（云端库已在本地合并）进行。在一次普通的本地编辑里，按当时的库判断，把这次入网新加、且在入网**没有**新加的存活账户中有**孪生**的每个账户移进回收站，**从不永久删除**。
      - **孪生**：secret、issuer、label 相同（`addedModeKey`），**并且** OTP 参数相同（类型、算法、位数、周期）：码不同的副本不算重复，保留。对 HOTP，孪生的计数器不得落后于这份副本（留下的那份的计数器从不后退）。
      - **先到者留下**：在每台设备算出相同的顺序 `(createdAt, id)` 里，孪生排在前面。两个带着同一账户入网的配置文件，各自都在自己的记录之外看到对方的副本；没有这个顺序，双方可能各删各的，账户就哪里都不存活了。有了它，较早的那份总会留下，所以每个账户至少有一份存活。`createdAt` 是条目自己的，从不夹紧，合并保留较小的，所以顺序会收敛。
      - 入网自己带来的两个相同账户互相保留（都在记录里）。入网与那一轮之间改过的账户不再算匹配。issuer 与 label 只按小写比较，按空白或 Unicode 形式不同的副本不匹配、保留，这是偏安全的一侧。
      - **然后**：一次写入清掉记录；有移动时加一条通知（"本配置文件入网时加入的 N 个账户已在同步库中：多出的副本在回收站"，链接到回收站），再跑一轮上传这些移动。没跑通的一轮不移动、保留记录；另一个库的记录不移动；解析不了的记录清掉。
      - **其他设备**：通常什么都看不到，因为第一次上传副本的那一轮也上传了移进回收站。恰好在两次上传之间跑一轮的设备会看到副本来了又去，三个以上时它的合并说另一台设备删除了账户（§4.4 的通知，指向回收站）。接受：那是真的，什么都不丢。
      - 摘要相应地说明：本配置文件里云端库已有的账户，第一次同步之后多出的副本会移进回收站。
    - 不改契约：不让入网载荷带头版本的 envelope。这不属于第一阶段。
  - 本机为空（新配置文件的常见情况）：`transact(prev=null)` 写 `{envelope: 远端明文以本地 rev 0 重新加密, keyring: bundle.keyring}`。
  - 本机有自己的库、vaultId 不同（I6）：要求先在本机解锁。① 内存中以 `importBackup` 的 added 模式把本机存活账户加入云端库（新 id，按 secret + issuer + label 去重）；② 内存中校验"本机每个存活账户都在结果中存活"，否则中止、什么都不写；③ 显示"将把本机 k 个账户加入同步库（跳过 d 个重复）"并确认；④ 本机原库明文用**云端 VK** 加密，**追加**到 `sk_prejoin` 的列表（保留原 vaultId，不保留原 keyring 与设备密钥；修订 25，见下）；⑤ `transact {合并结果 + 云端 keyring}`；⑥ 立即走服务层的清理入口（§0.0i）：它的回调除云端 keyring 的 previous 外还能打开内存里的本机旧 VK（它不在云端 keyring 的 previous 里），把本机旧快照重新加密到云端 VK（保留原 vaultId，D9），"找回账户"仍能读取它们，之后按原规则轮换出局。⑤ 与 ⑥ 之间崩溃时旧 VK 已不可得，这些另一个 vaultId 的旧快照会在下次清理时被丢弃；当前数据在 ④ 的 `sk_prejoin` 里，不丢（GM2-4）。
  - 本机库与云端 **vaultId 相同但密钥无关**：本地 keyring 的 vkId 与云端的不同，而且两边的 previous 都真的解不出对方。例如在新安装上用备份 `restoreBackup` 过，或两个配置文件从同一个子集文件恢复（C6-8：同一个子集文件的接收者 vaultId 都相同）。这时**按 vaultId 不同处理**：added 模式导入、`sk_prejoin`、同样的确认，其余同上。
    - 理由：相同的 vaultId 证明不了是同一条血统。按 id 合并会把对方的删除与改动带进来，而 ② 一旦失败，用户就无法加入。代价只是改过名的账户可能重复，由用户删除。
    - 只有 vaultId 相同**且**密钥相关（同一个 VK，或一方的 previous 真的解出另一方）才用 `mergeVaults`，例如下面"`complete` 之前崩溃"后的重新入网。
    - 不阻止这样的配置文件同步：加入同一个同步账户需要批准或恢复码，是有意的；不同同步账户的库互不相干（服务器按账户存库，§5.3）。
  - 本机为 `lost`：与 Phase 0 的 `restoreBackup` 一样，需要明确确认才覆盖不可读的残留。
- **孤儿 outbox**（修订 19、20）：
  - 本机若有能打开的孤儿条目，`prepareJoin` 先把它们并入本机库（§4.7），`sk_prejoin` 与 added 导入都基于并入后的结果。
  - 入网的两个撤销（`join_unfinished` 之后的撤销，以及被吊销的待定身份的撤销）同样先并入；它们用入网输入里的 `answer`，与入网自己的合并共用一个复核界面（R3R-6）。
  - 任何并入被守卫挡住时，也可以由一轮 `round({answer})` 回答：第 0 步先并入。M6 遇到撤销返回 `review_needed` 时，显示同一个复核界面，再带着回答重试入网。
- **入网只写进入网设备自己的身份**（M2）：本配置文件的身份若属于另一台设备、已钉住另一个 vaultId，或根本不在（例如入网准备之后另一页面关闭了同步，RR-3），`commitJoin` 拒绝（`bad_state`）。所以"以云端为准重新加入"到一个新的 vaultId 之前，M3/M6 先替换身份：
  - 移除旧身份（§2.5 的一步删除），生成新的 deviceId 与 DSK，再入网；
  - 入网完成后用 `pw_auth` 吊销旧 deviceId，设备行不累积；
  - 若更早一次入网留下了 `sk_prejoin`，added 模式的入网以 `prejoin_exists` 拒绝，M6 请用户先导出或删除它（"高级"）。例外是这次入网自己在提交前中断留下的那份：同一云端密钥、本配置文件的 vaultId，**且明文相同**（RR-5），这时重试可以继续。
- `complete` 之前崩溃：本地已经是云端库（或已合并），设备尚未入网；重启后显示"加入未完成"，用户重新入网时本地与云端 vaultId 相同，走 `mergeVaults`，不丢任何东西。
- 已入网设备在同步中发现本地 vaultId 与云端不同（理论上只会因存储异常出现）：状态 `different_vault`，提供"以云端为准重新加入"（输入主密码 → `GET /v1/keys` → 走上面的导入流程；vaultId 不同，所以先按上面替换身份）。

### 3.6 改主密码（同步已开启）

#### 3.6.0 密钥操作的通用规则（§3.6–§3.8、§3.10 共用，F2、S4）

- **服务器幂等**：`PUT /v1/keys` 与 `/v1/keys/rotate` 若服务器当前 bundle 原文与请求中的逐字节相同 → 返回 200 和当前结果（不再要求 `if_kver` 恰好落后一步，因为 kver 可以跳号，N27）。每份 bundle 都含新随机 salt/IV，原文本身就是唯一的操作标识，不需要 op_id。
- **客户端对账**：遇到网络错误、5xx、超时或 409，先 `GET /v1/keys`，按**关键部分**判定，而不是整份比较（S4：在本机对账前，别的设备可能已经在我的 bundle 基础上又改了一次）：
  - 换恢复码：我提交的恢复码包裹（`iv` + `wrapped`）出现在服务器当前 bundle 里 → 成功，新码有效；
  - 改密码：我提交的密码包裹出现在服务器当前 bundle 里，或服务器 bundle 是在它基础上的后续版本（本机用新密码能打开服务器当前的密码包裹）→ 成功；
  - 轮换：服务器 `vk_id` 等于我的 keyring2.vkId → 成功；
  - 都不满足 → 才是失败。
- **轮换也记待确认记录，并先对账再合并**（M3RR-1）：
  - 轮换在**第一次发送之前**写待确认记录，以新的 `vk_id` 为键（与换恢复码的包裹指纹并列）；结果确定后清除。
  - 重试同一个准备好的轮换时，每一遍先看状态：服务器的 `vk_id` 或 `kver` 已不是准备时的值，就先 `GET /v1/keys` 按上面的规则对账，再决定要不要"先合并"：
    - 已生效 → 提交本机这一侧（`Published`）；
    - 别处的改动 → `changed_elsewhere`（刚显示的码作废）。
  - 只要服务器可能已经持有这次操作，就绝不报"什么都没发生，可以重试"（`not_synced`）。
- **"未生效"的十分钟用校正后的时钟，从最后一次签名算起**（M3RR-6）：本机时钟跳变或几次慢的重试，都不能让一个仍在签名窗口内、可能晚到的请求被判为未生效。
- **对账完成之前绝不告诉用户"新恢复密钥无效"**。无法对账（离线、标签页关闭）时显示"结果未确认：新旧恢复密钥请都先保留，联网后会自动确认"，并在 `sk_sync_state` 里记下"待确认的恢复码包裹指纹"（`SHA-256(原始 iv ‖ 原始 wrapped)` 的标准 base64，不含任何秘密，M1-10）；以后任何一次同步按上面的规则判定，显示"本机于 {时间} 生成的恢复密钥已生效"或"未生效，请重新生成"。
- 409 的提示文字按对账结果决定：确认不是本机的操作，才说"已在另一台设备修改"。

#### 3.6.1 流程

1. A：输入旧密码 + 新密码（强度检查）；**必须在线**。勾选项"我担心旧密码已泄露：同时轮换密钥"（F13b，勾选则走 §3.8）。
2. 发送前检查（§3.14）；`setPassword(bundle.keyring, VK, 新密码)`（新 salt）；新 `auth.kdf`；bundle 的 kver 取 `publishKver(服务器 kver, maxSeenKver)`（下同，§3.9 R1），重新 MAC。
3. `PUT /v1/keys {if_kver, bundle, password_auth: 旧, password_verifier: 新}` → 成功（含对账成功）→ 本地 `transact {envelope 不变, keyring 新}` → `startSession`。先服务器后本地：本地提交前崩溃，本机旧密码仍能打开，新密码通过服务器当前 bundle 也能打开（§3.9 R3）。
4. 对账后确认失败且对方改了密码："主密码已在另一台设备上修改（{at}），请先用新密码解锁。"
5. 服务器**当前数据**中旧密码包裹和旧校验值随即被替换；但它们仍会留在服务商备份（PITR / 每日备份）里直到备份窗口结束，而改密码**不换 VK**，所以有人在备份窗口内拿到备份并破解出旧密码，仍能打开当前数据——这正是第 1 步那个勾选项的用途。持有锁定配置文件副本的人改密码后也仍能拿到新包裹去离线猜（A3）：要赶走它必须吊销 + 轮换。其他设备在采用前仍保留旧包裹（以及 LevelDB 残留），见 §3.9。

### 3.7 生成新恢复码（同步已开启）

输入主密码 → 发送前检查 → 内存中 `setRecovery(bundle.keyring, VK)` → 展示新码 → 用户回填确认 → `PUT /v1/keys {if_kver, bundle(kver = publishKver(服务器 kver, maxSeenKver)), recovery_verifier, password_auth}` → 按 §3.6.0 判定结果 → 本地 `transact`。其他设备随后显示"恢复密钥已于 {at} 在 {by} 上更换"（被植入的恢复码是最隐蔽的后门，必须可见）。

### 3.8 轮换 VK（"轮换密钥"与"吊销并保护"）

1. **P1（只在内存）**：A 已解锁、输入密码、通过发送前检查。先做一次正常同步，保证轮换后的库包含一切。`r = rekey(bundle.keyring, VK1, 密码或新密码)` → `{keyring2, VK2, code2}`（keyring2.previous 含 VK1 及更早的 VK）。Phase 0 的 `rekey` 不设上限，第 65 次轮换会产生 `validateKeyring` 拒绝的 65 条，所以轮换构建器随后调用 `capPrevious`：按**列表顺序**只保留最后 64 条（F-11）。`rekey` 按"更早的……、刚退役的"顺序追加，列表顺序就是时间顺序，刚退役的 VK1 总在末尾、总被保留；不按 `createdAt` 排序，因为 `rekey` 每次都把全部条目的 `createdAt` 改成本次时间，同步时又截断到小时，同一 keyring 里它们都相同（S-5）。被丢掉的只是 64 次轮换之前的 VK；本机快照在 P4 里已重新加密到 VK2，只有那么久之前的服务器历史版本会因此打不开。
2. **P2**：展示 code2 → 用户回填确认已保存（I5）。到此为止什么都没提交。
3. **P3**：`POST /v1/keys/rotate {if_version: v, if_kver: k, envelope(VK2, rev v+1), write_proof（用当前 K_write）, new_write_key（K_write2）, bundle(kver = publishKver(k, maxSeenKver), MAC 用 VK2), recovery_verifier, password_auth, password_verifier（新 auth salt）, device_names: [...]}`。服务器在一个事务里：先锁设备行（§5.3）、双 CAS、换 `vk_id` 与 `write_key`、写历史、更新设备名、作废所有未完成的入网请求。
   - 结果按 §3.6.0 对账。`version_conflict` → 回到 P1 的合并步骤，复用同一个 VK2/keyring2/code2。确认的 `keys_conflict`（别人同时改了密钥）→ 整个轮换作废，此时才告诉用户"刚才的新恢复密钥无效"。
4. **P4**：本地 `transact {本地合并结果用 VK2 加密, keyring2}` → **立即** `startSession(VK2)` → 钉住 vkId = VK2 → 服务层的清理入口（§0.0i）：先把 `sk_prejoin` 与 `sk_sync_cfg.enc` 重新加密到 VK2，再 `finishKeyChange(VK2, 回调)` 把另一槽和全部快照重新加密到 VK2（回调能打开 VK1 与 keyring2 的全部 previous）；outbox 丢弃；`lastSynced` 置空。
5. P3 成功、P4 前崩溃：本机仍是 VK1；下次同步看到 `vk_id = VK2` → 需要密码 → §3.9 R3 采用（连续性检查通过）。code2 用户在 P2 已保存。
6. 其他设备：§3.9 R3/R4，各需输入一次主密码。

### 3.9 其他设备采用远端密钥材料（不会被锁死、不会被引回旧 VK）

远端 KeyBundle 先放在 `sk_sync_staged`（storage.local），永不直接放进 Generation（I1）。"已采用"**按内容判定**：`canonicalJson(本地 keyring) == canonicalJson(bundle.keyring)`（不另存 `localKver`，P2）。

- **R0 先验证、再分类**（F-08、F-03、F-01）：只有 MAC 已验证的 bundle 才参与 R1–R3 的分类——同一 VK 用本机 VK 验，另一个 VK 在解锁时由输入的秘密打开后用它验，较旧的 VK 用 previous 解出的 VK 验；MAC 不对 → 拒绝 `bad_mac`，既不改 `maxSeenKver` 也不进入 `keys_behind`。分类前还要求 `bundle.vaultId` 等于本机的 vaultId（本地 keyring 的，本地 keyring 不在时取身份记录里的 `vaultId`），否则拒绝 `wrong_vault`——包裹的 AAD 绑定了 vaultId，换了 vaultId 的 bundle 即使包裹字节原样复制也打不开。`maxSeenKver > 0` 且 `kver > maxSeenKver + KVER_MAX_JUMP` 的 bundle 按 `kver ≤ maxSeenKver` 分类（内容相同 → 已同步，不同 → `keys_behind`），**不能抬高 `maxSeenKver`**（F-01）。`maxSeenKver = 0`（身份刚恢复，§2.5；在每次停止都删 IndexedDB 的环境里每次启动都如此）时不设这条上限，恢复后第一个 MAC 已验证的 bundle 定下基准——否则上限会变成固定的 65 537，持副本 + 密码者一次 +65 536 的发布就能让这些设备从此把每个正常改动都看成 `keys_behind`。诚实服务器不接受这样的跳幅，它只来自持 VK 者配合恶意服务器，或本机离线期间持 VK 者连续做了几次最大跳幅。不做成硬拒绝：硬拒绝会让这台设备再也无法修复与轮换，正是 F-01 要避免的后果；`keys_behind` 已有唯一出路（修复，它以 `publishKver` 发布，服务器一定接受）。分类函数不对外暴露，调用方只能经过这些检查。
- **R1**（N27 修订）：**只在 `kver > maxSeenKver` 时才可能自动采用**（还要满足 R2/R3 的其余规则）。`kver ≤ maxSeenKver` 时看内容：
  - 服务器 bundle 的 keyring 与本地 keyring 相同，**或**它的 `SHA-256(canonicalJson({keyring, auth}))` 等于身份记录的 `adopted.digest` → 已同步（`maxSeenKver` 不变），不弹 R3 的确认。后一种是本机自己最近一次提交过的状态：本地 keyring 不在时（F-06），或本地提交因掉电回退、落后于身份记录时（GM2-5，同 VK 的改密码、换恢复码同样会发生）。**接受的残余**（RR-6，所有者委托决定：接受；不加 `adopted.from`——它会改 M1 的 `AdoptedRecord` 格式；也不改 D8）：这条规则只信任 IndexedDB，见 §1.3。每次"采用回来"都记 `keys_adopted` 安全记录，由 M5/M6 显示为可见事件。本地 keyring 与它不同时把它**采用回来**：同一 VK 立即采用（这个密码包裹本机提交过，不按 R2 等用户证明新密码）；另一个 VK 走 R3。发送前检查遇到这种情况，只对会发布或交出 bundle 的操作返回"需要先采用"（不是 `keys_behind`——否则唯一的按钮"修复"会把旧包裹重新发布上去，悄悄撤销用户自己的改动）。吊销、拒绝入网、清除历史等其余操作照常进行，与 `keys_behind` 下相同：**紧急吊销永不被挡**（M2R-2）。若已知的 `adopted.auth` 与 bundle 的 `auth` 不同、keyring 却相同，拒绝 `auth_without_password`（F-07：只改 auth 的 bundle）；
  - 不同 → 进入可见状态"服务器的密钥状态比本机旧"（`keys_behind`），**不采用**。它覆盖三种情况：诚实服务器的数据库回档（PITR）、一台落后的设备以等于或低于他人所见的 kver 发布了不同内容、恶意服务器重放一份真实的旧 bundle。三者对设备来说无法区分，所以都不自动采用，也**没有**"采用服务器的"按钮——唯一的出路是"以本机为准修复云端"（§4.2），它以更高的 kver 重新发布本机的 keyring，之后所有曾同步的设备都会因 `kver > maxSeenKver` 而正常采用或确认内容相同。
  - 发布任何 bundle 时一律取 `kver = publishKver(服务器 kver, maxSeenKver) = min(max(服务器 kver, maxSeenKver) + 1, 服务器 kver + KVER_MAX_JUMP)`，结果不是安全整数时抛错而不是发布（F-01）；服务器接受 `if_kver < kver ≤ if_kver + KVER_MAX_JUMP`（CAS 仍按 `if_kver`），所以回档之后的发布永远高于本机见过的值，不会再被曾同步的设备拒绝。诚实的跳幅不超过回档深度 + 1，远小于 65 536；要耗尽 kver 空间需要约 2^37 次发布。
  - `kver` 只用于排序与发现回滚，**从不单独决定是否采用**（F7：持 VK 者可以任意抬高 kver，所以 R2 的密码包裹规则、previous 包含规则与 R3 的连续性检查照旧）。
  - 采用之后 `maxSeenKver = max(maxSeenKver, kver)`。
- **R2** 同一 VK（bundle.keyring.vkId == 钉住的 vkId）、本机已解锁：用 VK 验 MAC，并要求
  - `previous` 包含本地 previous 中的每个 vkId，**没有例外**（F-02）：改密码、换恢复码、同 VK 修复都不改 previous，所以同一 VK 的 bundle 少了任何一条都是攻击（例如持 VK 者塞进 64 个新生成的 VK，把真正的历史挤掉）。两侧都只算**真能解开**的条目——bundle 一侧用它的 VK 解，本地一侧用本地 VK 解；本地 VK 不可知时用列出的条目（只会更严，M1-2、M1-2b）。VK 以 64 bit 的 `vkId` 识别，伪造一条连续的历史需要对 HKDF 做 2^64 的第二原像（S-3）；
  - `auth` 只有在密码包裹也变了的时候才能变（P3）。比较基准是身份记录的 `adopted.auth`（最近一次采用的 bundle 的 auth，与本地密码包裹配套），调用方必须显式传入它或 null（F-07，不再可省略）。为 null 只发生在身份刚从副本恢复时（与 `maxSeenKver = 0` 同一时机），这时这一条无从比较、跳过；诚实服务器仍按 P4 拒绝只改 auth 的 bundle。
  - 本地 keyring 不在时没有本地密码包裹可比（M1-16）：bundle 若配上 `adopted.auth` 就能复现 `adopted.digest`（keyring 与上次采用的相同），而它自己的 `auth` 不同，同样拒绝 `auth_without_password`。这时这台设备暂时无法从云端恢复，但什么也不写、不丢数据；这种 bundle 只有持 VK 者配合恶意服务器能造出，诚实服务器按 P4 拒绝它。
  - 密码包裹与本地逐字节相同（只换了恢复码）：立即采用。
  - 密码包裹不同（别处改了密码）：**暂不替换本地密码包裹**，横幅提示"主密码已在另一台设备上修改，输入新密码以更新本机"。用户输入的密码能打开新包裹时才采用。理由：持 VK 者 + 恶意服务器能伪造 MAC 有效但密码包裹是垃圾的 bundle；**一台设备只在用户在本机证明了替代品可用之后，才丢弃一个已被证明可用的密码包裹**。
- **R3** 解锁流程：输入的密码先试本地 keyring；失败 → 在线时试**服务器当前 bundle**（`GET /v1/keys`，P2），离线时试 staged。若该 bundle 的 `kver ≤ maxSeenKver` 且内容与本地不同（即 R1 的 `keys_behind`），**要用户明确确认**才采用："这个密码只能打开服务器上较旧的密钥状态；采用它会把本机退回到旧的主密码和恢复密钥。［改用当前密码］［仍然采用］"——保留"永不被锁死"（用户只记得旧密码时仍能解锁），但绝不静默降级（N27）：
  - 打开的 VK 与钉住的相同 → 验 MAC 与 R2 的两条要求 → 采用 → session。
  - 打开的是另一个 VK → 用它验 MAC → **连续性检查**：`unwrapPreviousVks(新 keyring, 新 VK)` 必须**真的解出**钉住的 vkId（只列出 id 不算，F7）；本地 keyring 在时还必须真的解出**本地 keyring 的 vkId**（本机数据在它下面，合并要用它解开；它通常就是钉住值，GM2-5 时不是）；且 previous 包含本地真能解开的全部 vkId，唯一例外是轮换时的 64 条上限：新列表恰好有 64 条真能解开的条目时，可以缺少本地真实条目**按列表顺序开头连续的一段**（即最旧的那些，缺几条不限，M1-3、S-5）——这正是一次或几次 `capPrevious` 会丢的条目（离线期间错过了几次轮换就会多丢几条）。列表顺序只受 MAC 保护，持 VK 者可以重排；`createdAt` 同样不在 AAD 里、同样可伪造，所以这不比按时间排序弱。残余：这个 bundle 的作者持有新 VK，本来就掌控轮换之后的一切；否则拒绝并显示"密钥链不连续"。旧 VK（例如被吊销设备伪造的 VK1 bundle）天然通不过：它的 previous 里不可能有 VK2。通过 → 用旧 VK 解本地、拉取远端、合并 → 一次 `transact {合并结果用新 VK, 新 keyring}` → 立即 `startSession` → 更新钉住值 → 服务层的清理入口（§0.0i：先重新加密 `sk_prejoin`、`sk_sync_cfg.enc`，再 `finishKeyChange`）。
  - 本地包裹打开了（用户输的是旧密码），而服务器 bundle 与钉住值**同一 VK**、MAC 有效、密码包裹不同 → 正常解锁，并按 R2 提示输入新密码。服务器 bundle 是**另一个 VK** 时，本机无法验证它的 MAC，按 R4 处理。
- **钉住值与本地 keyring 的 vkId 不同**（两者都是明文 id，锁定时就能看出）：解锁按 R4 的顺序先试服务器/staged bundle，再试本地 keyring（GM2-5）。这样钉住值领先时一次输入密码就能采用，钉住值落后时由 D8 的第一个方向前移。
- **R4** 远端已轮换（`needs_password`）：本机照常显示验证码、允许本地编辑（本地仍以 VK1 提交），同步暂停，弹窗非阻塞横幅"密钥已在另一台设备更新：输入主密码以继续同步"。处于 `needs_password` 时，解锁**先试服务器/staged 的 bundle**——即使本地包裹也能打开（同一个密码轮换时两者都能开）——成功就走 R3 的采用流程。
- **R5** 只用本机当前 VK 加密新数据；永不"采用" previous 列表里的 VK。
- **锁定页上的采用（界面，修订 25，M6 §13.4）**：
  - **"用服务器上的密码解锁"**：只要 §3.6.0 的"已发出、未确认"记录在，锁定卡片就在本页自己的解锁旁边提供它。典型情况：用恢复码设置新主密码的改动到达了服务器，但页面在本地提交之前关了。它就是引擎的采用（R3 的顺序），能打开锁定的页面。同一个表单也能打开一个自己的 keyring 就接受所输密码的页面，例如密码没变、只有一份未确认的新恢复码。
  - **"更新本机"**：服务器持有另一台设备的、本机尚未采用的密钥时（R2 的 `needs_new_password`、R4 的 `needs_password`），同步一节提供它；输入服务器当前的主密码完成采用。
  - 经这两个表单，锁定的页面能以服务器当前的密码打开；服务器处于较旧的密钥状态时，确认"仍然采用"之后，也能以较早的密码打开（"永不被锁死"的残余）。开闸时 docs/security/local-vault.md 要写明这一点（§9 M8 第 17 项）。
  - **输错照常记录**：在这两个表单或同步一节的任何采用表单里输错主密码或恢复码，安全记录与 Phase 0 的解锁一样记 `unlock_failed` 或 `recovery_failed`，计入下一次解锁报告的同一个失败次数。Phase 0 按设计不做锁定（§13 F23）。
- **R6** 用恢复码解锁时同理（M1-17）：恢复码打开的 bundle 照样可以采用，即使其中的密码包裹本机没有验证过——"永不被锁死"指能用用户已证明或仍记得的秘密打开，刚输入的恢复码仍能打开采用后的 keyring。采用后若密码包裹与本机之前的不同（或本机之前没有），显示 R2 那条横幅"输入新密码以更新本机"，旁边给"忘了主密码？设置新密码"（§3.3 第 5 步的恢复码路径）。不新增状态。
- **钉住值修复**（D8）：解锁时若本地 keyring 的 vkId ≠ 钉住值、且 `unwrapPreviousVks(本地 keyring, 本地 VK)` 能解出钉住值（即 keyring 写入成功、更新钉住值前崩溃过），把钉住值前移到本地 keyring 的 vkId。**第二个方向**（GM2-5）：本地 keyring 的 vkId ≠ 钉住值，而本地 keyring **解不出**钉住值——本地提交因掉电丢失、身份记录已写入，本机落后于自己的钉住值。钉住值不动（那是本机已提交过的密钥，退回会打开 F7 的口子），状态记为 `needs_password`（R4）：同步只查状态、不处理服务器 bundle，本机照常显示验证码、允许本地编辑，直到按上一条的顺序经 R3 采用。服务器 bundle 若也解不出钉住值（服务器同时回档，双重故障），保持这个状态、不向服务器写；出路是持有钉住值那个 VK 的设备修复云端，或"以云端为准重新加入"。不另存一份权威钉住值到 storage.local：它会和 storage.local 一起回退，而 storage.local 单独回退或被替换（掉电、厂商只同步 storage.local、旧副本，§2.5）正是 IDB 钉住值唯一能作证的情况。
- **采用由 M2 的 `commitKeys` 写入**：它只接受 M1 发出的 `Adoption` / `Published` 能力对象，并自己再查连续性、钉住值可达与防锁死；R2/R3 在这里强制，不靠调用方自觉（§0.0i 第 16 条，M2R-4）。
- 批准、轮换之前，设备必须已处于服务器当前 vkId 并验证过最新 bundle（P9）；§3.14 的发送前检查自然保证这一点，不满足则先走 R3。

### 3.10 吊销

设备列表由 `GET /v1/devices` 取得；改名（含给自己改名）用 `PATCH /v1/devices/{id} {name_ct, password_auth}`（N22）。
流程：设备列表 → 吊销 X → 输入主密码 → 用户**明确选择**原因（不预选）：
- "我仍控制这台设备（停用的配置文件）" → `POST /v1/devices/{id}/revoke {password_auth}`。若当前 KeyBundle 是 X 写的（`bundle.by == X`），这一选项不可用，强制走"保护"路径（它可能植入了恢复码）。
- 对话框同时列出"由 X 批准加入的设备"（`approved_by`），默认一并勾选吊销。
- "丢失 / 被盗 / 不确定" → 吊销 + 轮换（§3.8）+ 建议同时改主密码。
  - **顺序**（修订 25，M6 §13.5 第 9 条）。网络上吊销总是先于轮换，被吊销的设备在密钥变化之前就被切断；移到吊销之前的只是用户的步骤。
    1. 能准备轮换时，先准备它，并在吊销任何设备之前显示新恢复码、让用户回填两组。所以在这些步骤里取消、锁定或失败，都什么也没做。
    2. 写下一条持久的"欠一次轮换"记录（`sk_sync_state.rotationOwed`：将被吊销的设备与时间）。
    3. 吊销（永不被挡，§3.14）。记录随即写明"已吊销"，以及吊销刚完成时服务器的密钥。
    4. 发送轮换。
  - **不能准备轮换时，照样立即吊销**：例如这一轮不是 `ok`、有复核在等、服务器要求更新、`keys_behind`、有待做的清理；输错密码与锁定不算这一类。记录写明轮换为什么在等，流程以"已吊销，还欠一次轮换"结束，并给出［轮换密钥］。
  - 在吊销与轮换之间停下（被拒、锁定、页面关闭），流程结束时说明密钥仍需轮换。
  - **记录的生命周期**：
    - 它跨越锁定、关闭的页面与新页面。同步一节的 danger 卡片一直显示它并提供轮换，直到有一次轮换生效。
    - 卡片只在记录里有吊销时才说"已吊销一台设备"。若吊销请求还没发出页面就关了，卡片说"可能没有完成：请查看设备列表，若它还在就吊销，然后轮换"，这时一次轮换并不清除记录。
    - 只有两种情况清除它：服务器接受了的一次轮换（记录里已有吊销）；或从另一台设备采用的轮换，且它在吊销之后（密钥不同于吊销刚完成时服务器的密钥，kver 更高；被吊销的设备可能取到过更早的那份）。
    - 第一次吊销在任何设备被吊销之前就被拒时，记录收回。
  - **写当前 KeyBundle 的那台设备**（`bundle.by == X`）只提供这一条路（它可能植入了恢复码）。任何能挡住轮换的东西都挡不住它的吊销，§3.14 的那一个等待除外。
  - **欠着轮换时**，关闭同步与移除同步身份会删掉这条记录，所以它们先警告，没有用户明确勾选"仍要继续：我会从另一台设备轮换密钥"就拒绝。
  - 并给出清单："若这台设备当时处于解锁状态并落入他人之手，它见过的 2FA 种子已泄露，请到各网站重新绑定。"团队场景（d5，参照 Bitwarden 的离职建议）另加一句："若有人曾使用这个配置文件且现已离开，请到各网站轮换他见过的种子——吊销收不回已经被看到的种子。"
- 本机"关闭同步" = 输入主密码 → 吊销自己（`password_auth` 必填，S8：配置文件副本与真设备共用这个身份，不要求密码就等于让任何副本一键踢掉真设备）→ 先把能打开的孤儿条目并入本机库（§4.7，修订 19、20）→ 一步删除 IDB 身份、`sk_sync_cfg`、`sk_sync_state`、outbox、staged，以及没有搁置条目时的孤儿列表（D11；搁置条目保留并提示，R3R-2）→ 保留本地数据与 `sk_prejoin` → `chrome.permissions.remove` 移除 API 的 host 权限（§7，修订 21）。
  - "移除同步身份"同样在最后移除权限。
  - 关闭同步要联网吊销自己，若权限已被用户移除，就在关闭按钮的同一次点击里先重新请求；用户拒绝时，改为提供只在本机生效的"移除同步身份"。
- 吊销最后一台设备：云端库保留，之后只能用恢复码重新入网，UI 警告。

服务器：置 `revoked_at`（小时精度）；之后该设备一切请求 `403 device_revoked`（先验签再回答，P6）；它发起的、未完成的批准作废。
设备收到 `403 device_revoked` 或 `401 unknown_device`（P5）：停止同步，身份标记为 `rejected_by_server`，**不删除身份、保留本地数据**；每天重试一次状态查询（诚实服务器回档后可能恢复）；面板提供［重试］［移除同步身份］，只有用户确认才删除（删除范围同"关闭同步"，本地操作，不需要密码）。不提供"抹掉本机数据"按钮（§13）：需要时卸载扩展即可；面板写明"厂商云端或复制出去的配置文件副本不会因卸载而消失"。

能保证 / 不能保证：见 §1.2 A4。核心：吊销阻止诚实服务器继续为它服务；轮换让它看不到已采用 VK2 的设备在轮换后的变化；吊销前它已有的一切无法收回。

### 3.11 锁定状态

| 操作 | 锁定时 | 说明 |
|---|---|---|
| 状态轮询（version、head、kver、待批准数） | 可以 | 只需 DSK 签名；不写服务器数据库（T2） |
| 拉取远端内容 | 不拉 | 解锁后再拉（inbox 已删除，C1） |
| 推送 | 只推 `sk_sync_outbox` 或孤儿 `sk_sync_orphan`（每次本地提交时在同一把锁里算好、带写入证明），且仅当服务器 (version, head) 仍等于它记下的基准 | 409 → 降为孤儿，等解锁（§4.7，从不丢弃） |
| 合并、采用密钥、批准、吊销、轮换、改密码 | 不可以 | 需要 VK 或密码 |
| 扩展图标角标显示待批准数 | 可以 | `chrome.action.setBadgeText`，无需新权限。角标的文字（标题）跟随浏览器的语言，而不是 Sixkey 里选的语言：SW 没有自己的词表，只能读 `chrome.i18n`，而语言选择存在页面的 `localStorage` 里，SW 读不到（修订 24） |

"每次都锁定"模式下 SW 永远拿不到 VK：编辑时 outbox 已在提交步骤里写好，SW 可以在 popup 关闭后快进推送（P10）；需要合并时等下次打开。

### 3.12 删除账户

需要 DSK 签名 + 10 分钟内的新邮箱 OTP 会话（`sub` 与该设备账户一致）+ `pw_auth`，三者缺一不可。服务器侧删除（§5.7），所有设备上的本地数据保留。

### 3.13 格式与代码变更清单

| 对象 | 变更 | 兼容性 |
|---|---|---|
| `EncryptedVault` v1 | 不变。上传前明文末尾补 ASCII 空格到 16 KiB 的整数倍（`JSON.parse` 忽略首尾空白）；**以 JSON 字符串原文传输与存储**，大小度量就是这段文本的 UTF-8 字节数 | 完全兼容 |
| `Keyring` v1 | 不变；同步时约束：无 device 包裹、wraps 恰好 password + recovery；上传前 `createdAt` 截断到小时 | 兼容 |
| `sk_prejoin` | 修订 25：格式 2 `{v: 2, items}`，只追加、至多 8 条 / 2 MiB；修订 25 之前的单条记录读作一条 | 新格式（还没有任何构建发布过，所以没有旧构建会遇到它） |
| `sk_sync_orphan` 的搁置标记 | 修订 24、25：新增搁置原因 `"vault"`（另一个 vaultId 的条目，从不自动删除） | 新值。比这更旧的构建会把它读作未搁置并删除；目前没有发布过的构建，这一点不成立 |
| `sk_security_log` | 修订 25：改写记录时保留不认识的种类与字段（照常计数与截断，不显示），所以新种类不必升版本，降级也不丢条目；新增种类 `keys_adopted_back`（R1：本机提交过的密钥被不经询问地取回）与 `device_approved`、`device_revoked`、`history_cleared`（服务器接受之后才记，不含细节） | 规则改变（`security-log.ts`） |
| `sk_sync_state.rotationOwed` | 修订 25："欠一次轮换"的记录（§3.10）：将被吊销的设备、时间、是否已吊销、吊销刚完成时服务器的密钥、轮换为什么在等 | 新成员 |
| `sk_sync_state.joinAdded` | 修订 26：`{vaultId, ids, at}`，批准入网新加的条目 id（§3.5 的去重），只有 id；第一次跑通的一轮之后清掉；每个新加账户一个 id（条目上限 5000 时约 195 KB） | 新成员 |
| `sk_sync_state.devices` | 修订 26：保存的设备列表里吊销是粘住的：本机吊销得到 200 时立即标记，刷新只会标记、从不撤销（§4.2 第 1 步）；`server_older_key` 的修复按它再次吊销 | 规则改变 |
| `KeyBundle` v1、入网载荷 v2（修订 27：v1 从未发布，直接取代）、`DeviceIdentity` v1 | 新增；bundle 以原文传输与存储；前向兼容规则见 §2.3 | — |
| 快照 | **不变**（不新增快照类型）。 | 兼容 |
| `store.transact` | 新增两个选项：`ensureCurrentSnapshot`（若最新 rolling 快照不是当前 envelope，先补一份，再写新 generation，供 `applyRemote`）；`afterCommit(gen)`（提交后、仍在 store 锁内调用，供写 outbox，D2） | 逻辑变更 |
| `VaultStore` 构造选项 | 新增 `beforeRecoveryWrite()`：在 store 锁内、**任何恢复写入之前**调用——`recover()` 中改变活动 generation 的指针切换、`writeBoth`、`openVault` 回退里的 `transact`、任何 `overwriteLost` 的 `transact`。同步层用它一次 `storage.local.set` 把 `sk_sync_state.lastSynced` 置为 null，并把 `sk_sync_outbox`（若有）原样追加到 `sk_sync_orphan` 的列表（D1，修订 19、20：不再删除 outbox，见 §4.7 的孤儿 outbox）。先清后写是保守的：清完就崩溃，下一轮只是多做一次完整拉取。M2 的两点（Q2）：① 钩子读取出错时恢复失败（fail closed，重试即可，PROBE-8）；② 冗余修复（另一槽、镜像的 heal）不调用它，因为它们不改变活动 generation，D1 的判断只看活动 generation 的校验和 | 逻辑变更 |
| 客户端服务错误码（不是 API 错误码） | M2 新增 `sync_on`（同步开启时拒绝 Phase 0 的密钥操作，§0.0i 第 18 条）与 `prejoin_exists`（更早一次入网留下的 `sk_prejoin` 还在，§3.5）。连同已有的 `cleanup_pending`、`too_large_for_sync`、`review_needed`、`different_vault`、`too_large`，界面文字由 M6 提供（M2R-15） | 新增 |
| `store.openVault` | 回退候选可用 previous VK 打开，采用前重新加密到当前 VK（I3） | 逻辑变更 |
| `validate.ts` | 5000 条上限（非清除条目）移到新增/导入时检查；`parseVault` 接受 ≤50 000 条（C13） | 降级到 Phase 0 构建时，>5000 条的库会被旧版判为无法解析；Phase 0 不会自动降级，写入 docs/security/local-vault.md |
| `Vault.schemaVersion` | **按内容派生**（`docs/design/proposals/YUBIKEY-DESIGN.md` §2.2）：平时为 1；只有存在未清除的 YubiKey 引用条目（`kind: "ykoath"`）时为 2。同步代码从不手写 `schemaVersion: 1`：库只经 `emptyVault`、`parseVault`、`mergeVaults` 与 `ops.ts` 的操作构建，不用对象字面量，也不展开一个库再改版本（grep 测试守住）。**规则**（I11）：今后新增条目字段仍须升 schemaVersion | — |
| storage.local 新键 | `sk_sync_cfg`（含 VK 加密的 DSK 副本与邮箱，§2.5）、`sk_sync_state`、`sk_sync_staged`、`sk_sync_outbox`、`sk_sync_orphan`（修订 19、20，§4.7；只剩搁置条目时关闭同步也保留它）、`sk_prejoin`；Phase 0.x 的 `sk_security_log`（H6，与 `sk_events` 分开） | 不属于 `hasAnyData` 的"库数据"键 |

不需要迁移已有本地数据；开启同步是显式操作。

### 3.14 敏感操作的密码证明（`pw_auth`，已决 Q8）

- 派生：`pw_auth = HKDF(PBKDF2-SHA256(NFKC(密码), salt_auth, iter, 256 bit), ∅, "sixkey/v1/password-auth")`；`salt_auth`（16 B）与 `iter`（≥600k，读取时强制上下限）在 KeyBundle.auth 里，受 MAC 保护。`pw_auth` 从不存储，每次由当场输入的密码计算。
- 服务器存 `password_verifier = SHA-256("sixkey-password-verifier|1|" ‖ pw_auth)`，常数时间比较。
- **需要它的端点**：`PUT /v1/keys`、`/v1/keys/rotate`、`…/respond`、`…/approve`、设备侧的 `…/reject`、`POST /v1/enroll/reject-all`、吊销（**包括吊销自己**）、改名（**包括给自己改名**）、分出独立身份（§4.10）、清除服务器历史、`DELETE /v1/account`（S8：配置文件副本与真设备共用身份，"自己"对副本来说就是真设备）。**不需要**：同步读写（写入另有写入证明）、状态轮询、`complete`、新设备在入网中拒绝自己的请求。
- **`keys_behind` 状态下的敏感操作**（N27）：会发布或交出 bundle 的操作——改密码、换恢复码、轮换（`PUT /v1/keys`、`/v1/keys/rotate`，修复本身除外）与批准入网（`…/respond` 与 `…/approve`：respond 之后的批准在 `keys_behind` 下无法完成，M1-4）——必须等修复完成；反过来，**不处于** `keys_behind` 时修复被拒（`not_behind`），否则会用本机的 keyring 覆盖服务器上更新的密钥状态（M1-5）；其余需要 `pw_auth` 的操作（吊销，**紧急吊销永不被挡**，唯一的例外见下一条；拒绝、拒绝全部、改名、分出身份、清除历史、删除账户）照常进行，`pw_auth` 按**服务器当前** bundle 的 `auth.kdf` 计算（它必须与服务器当前的校验值相符；回档跨过改密码时需要当时的旧密码，界面如实提示）。
- **吊销之前唯一的等待**（修订 25，M6 §13.5 第 14 条；设计接受这个限制）：
  - 服务器持有另一台设备的、本机尚未采用的密钥时，吊销在输入密码那一步就被拒（`needs_adoption`）。原因：发送前检查必须先用本机持有的密钥验证服务器的密钥参数（§3.9 R0），才能按这些参数派生证明；用没有验证过的参数派生 `pw_auth`，等于让一个恶意服务器挑选 salt 来收集可预计算的证明。
  - 出路是同步一节的"更新本机"：输入同一个主密码采用服务器的密钥，然后吊销就能进行。
  - 这次更新本身也可能等待：服务器要求扩展更新（`min_client_version`）时，它与其他采用一样被停下，于是在扩展更新之前，**本机无法吊销**。这时从另一台设备吊销，或先更新扩展。这是"紧急吊销永不被挡"的唯一例外，如实写明。
- **发送前检查的形式**（F-08、F-09）：它接收服务器 bundle 的**原文**，自己解析，先按 R0 验证 MAC 与 vaultId，再分类；成功时返回一个"已验证的服务器 bundle"对象 `{raw, bundle, vk, op, keysBehind}`。respond、approve、`PUT /v1/keys` 与轮换的构建函数都只接受这个对象（并检查 `op` 与 `keysBehind`），所以"用的是服务器最新的、已验证的 bundle、且不在 `keys_behind`"由类型保证，而不是靠调用方自觉。这个对象只在创建它的 JS 上下文里有效：品牌是模块私有的 `WeakSet`，复制、结构化克隆（例如经 `chrome.runtime` 消息）、存储或手工构造的对象都会被拒绝。所以 M3 必须在构建请求的同一个上下文里调用发送前检查；跨上下文只传服务器 bundle 的原文，到构建的上下文里重新检查（M1-19）。
- **发送前检查**（诚实客户端永远不会发出错误的证明）：① `GET /v1/keys` 取最新 bundle 并验证（MAC、R1–R3 的规则）——这也就是 §3.2 M5 所用的 bundle；② 用输入的密码在本地解开**这个** bundle 的密码包裹（失败就在本地报错；若本地旧包裹能开而新的不能开，提示"密码已在别处修改，请输入新密码"）；③ 成功后才按其 `auth.kdf` 计算 `pw_auth`。**恢复码版本**（S6，忘记密码时用恢复码重置）：② 改为用输入的恢复码解开该 bundle 的恢复码包裹，③ 改为计算 `recAuth`。
- **失败只计数、不锁定**（S2）：服务器先校验证明；**有效**的不受任何限流约束；**无效**的先过一个只属于它的小桶（每设备 10 次/分钟，内存中），桶满后直接拒绝、**不碰数据库**；桶内的失败才原子地加一（`UPDATE devices SET auth_failures = auth_failures + 1 WHERE device_id = $1 AND auth_failures < 10 RETURNING auth_failures`——计数封顶 10，超过横幅阈值就不再写，免得在 WAL/PITR 里留下一串失败记录）；成功后清零；`recovery_auth` 失败计入同一个计数。计数 ≥3 时其他设备显示横幅"设备 X 多次输错主密码"（强烈的被盗或被复制信号）。**不锁定、不退避**：任何能以这个设备签名的人都能 `GET /v1/keys` 拿到密码包裹去离线猜，在线限次挡不住他；而锁定或退避会落在与它共用身份的真设备上，让用户无法吊销、轮换（这正是最终评审 S2 指出的拒绝服务杠杆，退避只是让它可以按天续期）。
- **限流豁免**：带**有效** `pw_auth`（或 `recovery_auth`）的请求不受按设备限流约束——服务器先做这次很便宜的校验再判断限流——所以副本持有者刷满共用设备的额度，也挡不住用户的吊销与轮换。
- 为什么不增加攻击面：服务器本来就持有同等强度的密码包裹；verifier 从不发给未入网会话；`pw_auth` 与 KEK 用不同 salt 派生，推不出 KEK。
- 残余（F14）：`pw_auth` 在改密码前是固定值。能截获请求体的人（例如记录请求体的 TLS 代理）再加上一个有效的设备签名密钥，就能执行敏感操作。我们不记录请求体（§5.6），托管必须不记录（已决 Q1）。将来若做"邮箱 + 主密码入网"（Q2-b），那时攻击者没有包裹可离线猜，在线限次才有意义，届时再为那个端点单独加限次。

---

## 4. 同步引擎

代码位置：`core/sync/`（纯逻辑：engine 状态机、backoff、协议函数；Transport / Clock / KV 全部注入），`platform/api.ts`（只被 `sw.js` 打包）。

### 4.1 同步单元、版本号与同步状态

- 单元：**整库一个 envelope**（PLAN 6）。100 个账户约 40 KB 明文。
- 服务器 `version`：从 1 开始，每次接受写入 +1。上传的 envelope `rev` = `if_version + 1`，服务器检查头部，客户端解密后（AAD 已认证 rev）再核对。服务器另给出 `head` = 所存 envelope 原文的 SHA-256（D5）。
- 本地 generation 的 `rev` 是本地计数器（I4）；上传时总是对明文重新加密一次。
- 填充：上传明文末尾补空格到 16 KiB 的整数倍（已经是整数倍时不补，N23），服务器只能把账户数估计到约 ±40 个。
- `sk_sync_state`（storage.local）：`{v:1, lastSynced: {version, head, checksum} | null, lastOkAt, lastAttemptAt, failures, backoffUntil, status, lastErrorCode, serverOffsetMs, useCorrectedTotp, devicesSeenAt, pendingRecoveryWrap?, pendingPins?}`。`pendingPins = {vkId, vaultId, maxSeenKver, adopted, deviceId, prev}` 是钉住值的待写副本（§0.0i 第 17 条）：`deviceId` 是它为之写入的身份（没有则为 null），`prev` 是那个身份在提交开始时的 `pinCount`。**每个写 `sk_sync_state` 的模块都保留不归它管的成员，并在 vault 锁内做读-改-写**：M3 的状态、退避与 `lastSynced` CAS 写入同样遵守。只含数字、哈希、校验和与错误码，无密钥、无账户名。钉住值在 IDB 身份记录里（§2.5）。
- **两个推导量**（F3、F4、D5）：
  - `dirty ⇔ lastSynced == null 或 当前 generation 的 envelope.checksum ≠ lastSynced.checksum`。无变化的写入写回原 envelope（I10），只改 keyring 的写入也不动 envelope，所以不会误判；任何真实改动都会换 IV、换校验和；恢复到另一个 generation 也会换校验和。
  - `needPull ⇔ lastSynced == null 或 服务器 (version, head) ≠ (lastSynced.version, lastSynced.head)`——version 不等（包括服务器倒退）或者 version 相同但内容不同（回滚后版本号被别的设备复用）都会拉取。
- **置空规则与机制**（D1）：只有当本地确实是从上次同步状态演变而来时，才允许"不合并直接上传"。因此：
  - 任何存储恢复写入之前，store 的 `beforeRecoveryWrite` 钩子先把 `lastSynced` 清掉（基准不再可信），并把 outbox **保留为孤儿**（追加到 `sk_sync_orphan` 的列表，§4.7；修订 19、20，M3RR-3、R3R-1、R3R-5）。这是机制，不是约定：**同步状态永不从用户可见的事件列表推导**（用户可能已点"知道了"，列表也会截断）。
  - 为什么不删 outbox：恢复把本地退回较旧的 generation，outbox 可能是一次已向用户确认的保存的唯一活副本（"每次都锁定"模式下尤其如此，P10）。其余副本只有没有任何自动路径会读的 rolling 快照，10 次保存后就轮换出局，而且它的写入有保护、失败时只记日志。删掉 outbox 就违背"永不丢数据"。
  - 入网、`restoreBackup`/`startOver`、云端恢复、轮换、分出身份这些流程自己在同一步里把 `lastSynced` 置空。
  - 之后第一轮必然完整拉取并合并，较旧的本地永远不会覆盖较新的服务器头版本。

### 4.2 一轮同步（本上下文持有 VK）

```
sync():
  取 web lock "sixkey-sync"（ifAvailable；忙则置 rerun 标志后返回）。锁归跑这一轮的上下文（§4.9）
  refNow = Date.now() + clamp(serverOffsetMs, ±7 天)        （F5：只用于 HLC 与夹紧；TOTP 见 §4.14）
  0  （本上下文持有 VK）孤儿列表里有能打开的条目 → 先并入本机（§4.7），无论这一轮之后怎样结束
     不联网的停止（cfg_missing 完成关闭同步的本机部分、cloud_restore 的报告）也在这里；之后才查 host 权限，不在 → permission_removed（§4.9）（离线、吊销、update_required、identity_missing、keys_behind）
  1  st = GET /v1/sync/status → {version, head, vk_id, kver, pending_enrollments, devices_rev, min_client_version, server_time}
     低于 min_client_version → status = update_required，停止
     更新时钟偏移；kver 有变 → GET /v1/keys → 按 §3.9 处理；devices_rev 有变 → GET /v1/devices 刷新设备列表（新设备、改名、吊销、多次输错密码等横幅）
     设备列表的刷新在第 1 步完成，排在第 2 步的密钥检查之前，锁定的一轮也一样（修订 26，M6C）：
       列表里的吊销是"粘住的"：本机吊销一台设备得到 200 时立即标记；每次刷新都标记服务器说已吊销的设备，从不把一台设备重新标为有效
       （吊销对一个设备 ID 是终结的；只有服务器数据库的恢复会撤销它）。
       取不到列表时这一轮失败：以前停在 needs_password / server_older_key 的轮次现在报失败，下一轮再到达密钥状态。
     st.version < maxSeenVersion → 一次性回滚告警（A5），之后照常进行，并把 maxSeenVersion 重置为 st.version
  2  vk_id ≠ 钉住的 vkId：若它在本机 previous 中 → 服务器回到了旧密钥 → 告警并停止（见下）
                         否则 → 远端已轮换 → status = needs_password，停止（R4）
  3  base = st.version
     if !needPull and !dirty → 结束
     if !needPull and dirty  → remote = 无；跳到 6（本地确实从 lastSynced 演变而来，§4.1）
     if needPull → head = GET /v1/vault（其 version 必须 == base，否则回到 1）
                   按 §4.3 验收；头版本解不开 → 回溯历史，remote = 最新可解的版本，并记 headUnreadable
                   remoteRaw = 头版本解密并解析后的 Vault（未夹紧）
  4  local = 解密当前 generation（短暂持有 store 锁）
     merged = mergeVaults(clampVault(local, refNow), clampVault(remote, refNow))；守卫（§4.4）触发 → status = review_needed，停止（不保存远端）
  5  merged ≠ local（canonicalJson 比较解析后的 Vault）→ service.applyRemote：transact 内重读当前 generation、
     重新计算 merge(clamp(cur), clamp(remote))、ensureCurrentSnapshot、写入；afterCommit 写 outbox；返回提交后的 envelope 校验和 c
     否则 c = 当前 envelope 校验和
  6  需要上传 ⇔ remote 无（!needPull 且 dirty）或 headUnreadable 或 canonicalJson(merged) ≠ canonicalJson(remoteRaw)
     PUT /v1/vault {if_version: base, envelope(提交后的明文, rev = base+1), write_proof, cursor}
       200 {version, forked} → lastSynced = {base+1, SHA-256(上传的 envelope 原文), c}；maxSeenVersion = base+1；清除 outbox；同一次写入里退役本轮已并入的孤儿条目；
                               forked → 克隆提示（§4.10）
       409 version_conflict / vk_mismatch → 回到 1（每轮最多 5 次，200–1000 ms 抖动）
       网络错误（结果未知）→ 保留 outbox；下一轮的状态查询会澄清
     不需要上传 → lastSynced = {base, st.head, c}（同一次写入里退役本轮已并入的孤儿条目）
  7  rerun 则再来一轮
```
- "是否上传"与**原始**远端比较（F5），而且比较的是解析后 Vault 的 canonicalJson（填充不同，字节必然不同）：时钟快的设备第一次夹紧后把夹紧的时间戳上传一次，之后所有设备看到的都是已夹紧的值，收敛。
- 第 2 步的"服务器回到了旧密钥"也可能来自诚实服务器回档到某次轮换之前；同一 VK 下的 bundle 回档则表现为 R1 的 `keys_behind`。两种情况设备都不降级，而在错误面板提供"以本机为准修复云端"（N24、N27），把本机当前的 keyring 以更高的 kver 重新发布：
  - **VK 也回档了**（服务器 `vk_id` 在本机 previous 中）：一次**不换 VK** 的 `/v1/keys/rotate`，把本机当前的 VK2 与 keyring2 重新发布上去，步骤如下。
  - 只在确实处于 `keys_behind` 或"服务器回到了旧密钥"时提供修复；否则拒绝（`not_behind`，M1-5）。
  - **只有 bundle 回档**（同一 VK，`keys_behind`）：一次 `PUT /v1/keys {if_kver: 服务器 kver, bundle(本机 keyring, kver = publishKver(服务器 kver, maxSeenKver), 重新 MAC), recovery_verifier, password_auth, password_verifier?}`；第 1–3 步同下（不需要写入证明）。
  修复的规则（修订 26，按 M6C 的实现；两种修复都适用，标明"VK 也回档"的只适用于它）：
  1. **表单**：要当前的主密码、服务器密钥所用的密码（回档跨过了一次改密码时不同），以及本机的恢复码；并列出修复要先再次吊销的设备（第 5 步）。服务器的密钥需要当时的密码时，表单保持打开并如实说明（`old_password_required`），与输错时一样。
  2. **发送任何东西之前，先做完全部本地检查**：
     - 发送前检查（§3.14）以服务器**当前**（回档后的）bundle 为准，用本机 previous 里真能解开的 VK1 验它的 MAC（R0）；服务器密钥的密码必须打开那个 bundle 的密码包裹，按它的 `auth.kdf` 算 `pw_auth`。
     - 恢复码必须打开本机的 keyring（I9：从不保存），所以旧密钥的恢复码被拒。
     - **当前密码也必须打开本机的 keyring**：新的 `password_verifier` 由它计算，一个与密钥不符的校验值会让每台设备的 `pw_auth`（包括吊销）都被服务器拒绝，直到有人用恢复码重设。输错时在同一表单报"密码错误"，什么都不发。第二阶段的同 VK 修复原来缺这一条，现在两种修复都检查。
  3. **不生成新恢复码**：修复只用 keyring 现有的码，与同 VK 修复的表单相同。不知道这个码的用户不能从本机修复；另一台设备的修复会同时放开本机。原来"或生成新码"的选项取消。
  4. **auth 用本机已采用的那份，不换新 salt**（修订 26，原第 3 步写的是"新的 auth salt"）：
     - 已采用轮换的设备会把 bundle 的 auth 与自己的 `adopted.auth` 比较；同一份 keyring 配另一份 auth 会被拒为 `auth_without_password`（§3.9 R1）。所以换新 salt 恰好会让修复要放开的那些设备停在"密钥被拒"。
     - 修复采用本机与这份 keyring 一起采用的 auth；只有本机没有、或它与服务器的相同时才用新的。
     - 沿用它得到的是恢复前服务器上本来就有的 `pw_auth` 与校验值，不暴露任何新东西。
  5. **先再次吊销恢复撤销掉的吊销**（VK 也回档时）：
     - 恢复到某次轮换之前，也就恢复到了那次轮换所跟随的"丢失"吊销之前（§3.10）。那台设备在恢复后的服务器上又是有效的，并持有 VK1，而重新发布的 keyring 的 previous 能用 VK1 打开：有主密码的话，修复会把较新的密钥交给它；处在两者之间某个密钥上的设备则会拿到库本身。
     - 所以在发送密钥之前，本机见过被吊销、而恢复后的服务器列为有效的每台设备，都先再吊销一次。
     - **"见过被吊销"的来源**是本机保存的设备列表（`sk_sync_state.devices`），其中的吊销是粘住的（§4.2 第 1 步）。
     - 表单按名字列出这些设备；修复按同一规则重算，名单里有表单没显示的设备就拒绝（`stale`，表单按当前名单重新显示），在发送任何东西之前。
     - 每台都用检查算出的 `pw_auth` 吊销（§3.14：吊销永不被挡），并且只在库仍在修复所针对的密钥下打开时进行：期间锁定就停下，不再发送任何东西。照常记录、在列表里标记，合在一条通知里（"一台设备已从同步中移除"）。
     - 一次被拒或网络错误都在发送密钥之前停下修复；网络错误按网络错误说明。一次答复丢失的吊销无论结果如何都是安全的：下一次表单只列仍有效的设备。
     - **接受的残余**：本机从没见过的吊销（在另一台设备上做的，本机在它与恢复之间没有跑过一轮）不在名单里，不会再吊销。表单提醒先到"设备"里再吊销它们（列表能读出名字）。
  6. **发送**：`POST /v1/keys/rotate {if_version: 服务器 version, if_kver: 服务器 kver, envelope(VK2, rev = version+1), write_proof（K_write1）, new_write_key（K_write2）, bundle(keyring2, kver = publishKver(服务器 kver, maxSeenKver), MAC 用 VK2，auth 按第 4 步), recovery_verifier（由输入的码）, password_auth, password_verifier（由当前密码与第 4 步的 auth）, device_names（全部从 VK1 重新加密到 VK2）}`。
     - 头版本在此期间移动了（`version_conflict`：一台仍在旧密钥上的设备写入了）→ 用同样的 bundle 原文为新头版本重新构建上传，至多三次；然后失败，什么都不声称。
     - 结果按服务器上 bundle 的原文（它的 MAC）判断，不只看 VK：另一台设备的修复会放回同一个 VK，这里是 `changed_elsewhere`。
     - 之后经 `published()` 能力与 `commitKeys` 本地提交，会话带着发送前读到的锁定纪元（§3.6.0）。
  7. **envelope 是本机的库，不合并服务器恢复后的头版本**：
     - 用旧密钥加密的远端版本只在"找回账户"里由用户明确选择使用，从不自动合并（§4.3 R5、§4.6）；而一台吊销被恢复撤销的设备可能已经写进了恢复后的头版本（守卫挡得住改 secret 与清除，挡不住新增账户）。
     - 恢复后的头版本留在服务器历史里，保留期按 §5.8：最新 30 个版本，加上 30 天内每个 UTC 日的最后一个版本，64 MiB 以内。繁忙账户上不是当日最后一版的版本，再上传 30 次就可能被清掉。在那之前，"找回账户"能用本机持有的旧密钥打开它。
     - 只持有旧密钥的设备保留它自己的写入，采用新密钥时并入（R3 的连续性成立）。所以只要写入的设备还在，就不丢；只在服务器上才有的写入，只在那个窗口内找得回。
  8. **之后**：采用过轮换的设备一轮回到 `ok`；只持有旧密钥的设备看到服务器"已轮换"（R4），输入密码采用新密钥。与任何轮换一样，服务器作废该账户未完成的入网请求（§3.8 P3）。
  **双重故障的残余**：身份从副本恢复过的设备没有 `adopted.auth`（§2.5）。若恰好由它在一次跨过轮换的恢复之后修复，它会发布新的 auth，已采用轮换的设备随后以 `auth_without_password` 拒绝这份 bundle（卡片"密钥被拒"），直到其中一台修复。由保留了身份的设备来修复就能避免。
  **没有真实数据库的端到端测试**：修复只对内存里的服务器测试过（端到端的测试装置不能恢复服务器的数据库）。M8 要在一次真实的 PITR 恢复演练上核对（§9 M8 第 16、17 项）：恢复到一次轮换之前 → 各设备停在 `server_older_key` → 从一台设备修复 → 被恢复撤销的吊销再次生效 → 各设备回到 `ok`，没有任何数据丢失。
- `review_needed` 不保存任何远端数据（inbox 已删除，C1）：用户点［应用］或［保留我的］时重新跑一轮，重新拉取头版本。

### 4.3 远端数据验收规则（坏数据永不覆盖好数据）

| 检查 | 失败时 |
|---|---|
| 头版本 `validateEnvelope` + 校验和，或解密 / 解析失败（不含 `newer_schema`） | **回溯**（F6a）：`GET /v1/vault/versions` 列出版本，再用 `GET /v1/vault/versions/{v}` 从新到旧逐个取回尝试（N22；途中遇到 `newer_schema` 的版本立即停下，status = `paused_newer`，绝不跳过它去用更旧的 v1 版本覆盖头版本，YubiKey 预留 R6），取第一个能用当前 VK 解开的版本作为 remote，合并后以 `if_version = 头版本` 上传，覆盖坏的头版本（坏版本仍留在历史里）。一个都解不开 → 不上传，status = `remote_unreadable`，本地不受影响。有了写入证明，坏头版本只可能来自持 VK 者的缺陷、恶意服务器，或数据库泄露 + 配置文件副本（S7）。 |
| `vaultId` 与本地相同（I6） | `different_vault` → 提供"以云端为准重新加入"（§3.5） |
| `vkId` = 钉住的 vkId（R5） | 见 4.2 第 2 步。用 previous VK 加密的远端版本只在"找回账户"里由用户显式使用，永不自动合并 |
| 认证后的 `rev` = 服务器声称的 version | 不一致 → 记一次告警，照常合并 |
| `newer_schema` | status = `paused_newer`（"请更新 Sixkey"），不上传 |
| 时间戳 | 本地与远端都 `clampVault(·, refNow)`（§4.2） |
| 大小（C5、D3） | 唯一常量 `MAX_ENVELOPE_BYTES = 8 388 608`，唯一度量 = 上传用 envelope 的 JSON 文本 UTF-8 字节数（也是服务器的 `size_bytes`），由填充后明文长度精确算出。**本地编辑**：同步开启时，**删除进回收站与永久删除是明确的豁免，无论大小一律允许**——不能靠大小比较来推断，因为删进回收站会给条目加上 `deleted`/`dhlc`，跨过 16 KiB 填充桶时度量反而变大，而永久删除只能从回收站做，否则超限的库会卡死在无法清理的状态。其余编辑由 `mutate` 在提交前算出新旧两个度量，只拒绝让度量变大且超过上限的（抛 `too_large_for_sync`）。**合并结果**超限：照常在本地提交（绝不丢弃合并来的数据），只暂停上传，status = `too_large`，提示清理；回到上限以下后自动恢复上传 |
| 条目数（F15、D7） | 解析接受 ≤50 000 条；5000 条（非清除条目）只在新增/导入时检查，所以合并通常不会因条目数失败。若合并结果超过 50 000 条（只有持 VK 的恶意方能做到），不提交、不每轮重试，同样进入 `too_large` |

体积估算（依据 `validate.ts` LIMITS）：普通条目 canonical JSON 约 350–450 B，按上限填满的 ASCII 条目约 5.6 KB，含转义或三字节 UTF-8 时文本字段可再膨胀约 3–6 倍。5000 条典型约 2 MiB 明文 / 2.7 MiB envelope；病态情况远超 8 MiB，所以在本地编辑时就被挡住。被清除的墓碑约 250 B/条，永久保留（PLAN 3【已决】，已决 Q9）；极端情况下会推动 `too_large`，那时 UI 显示原因与墓碑数量。

### 4.4 合并与破坏性变更守卫（F16）

合并就是现有的 `mergeVaults`。提交前与当前本地比较：
- **阻塞确认**（status = `review_needed`，不提交，不保存远端）仅在：
  1. `secretChanged ≥ 1`：两边 secret 都非空且不同（I8，正常操作不可能产生）；
  2. 任一**本机仍存活**的条目会被合并结果永久清除（它跳过了本机的回收站——正常流程是先删除进回收站、回收站同步过来、再永久删除）。
  - ［应用］→ 重新拉取并提交合并。［保留我的］→ 重新拉取、提交合并后，对受影响条目用新时间戳重新声明本地内容（content `hlc` 与 `dhlc`/`deleted:false` 都取新 tick），然后上传。
- **非阻塞提示**：一次合并使 ≥3 个条目进入回收站，或永久清除 ≥3 个本机已在回收站里的条目 → 横幅"另一台设备删除了 N 个账户 · ［查看］［找回］"。若被清除的条目是在过去 24 小时内由**另一台设备**删进回收站的（看 `dhlc` 的时间与设备后缀），横幅用 danger 色（D6）。
- **如实说明守卫的边界**（D6）：持 VK 的一方可以先删除（进各设备回收站，只有提示）、过几分钟再永久清除（此时它们"已在回收站"，也只有提示），两步都不阻塞。真正兜底的是本机 rolling 10 次 + daily 7 天快照与服务器的历史（最新 30 个版本，加上 30 天内每个 UTC 日的最后一个版本，64 MiB 以内，§5.8；繁忙账户上不是当日最后一版的版本，再上传 30 次就可能被清掉），都能"找回账户"（O13）；守卫只拦住一步到位的清除与改 secret。
- **孤儿条目的并入**（§4.7）走同一个守卫：阻塞时全部条目保留，回答按各条的 `seen` 摘要绑定；来自条目的删除算本机自己的（看 HLC 的设备后缀），不触发 danger 横幅。
- **合并前快照**：不新增快照类型（F11）。每次有变化的提交本来就会把新 generation 存成 rolling 快照，所以当前状态通常已经是最新的 rolling 快照；`applyRemote` 用 `ensureCurrentSnapshot` 在它缺失时补一份。
- 远端的永久删除应用到活动库，**不清理本机快照**（与本机发起的 `purgeForever` 不同）：能清除的远端（包括持 VK 的恶意方）不应能抹掉本机最后的好副本。代价（F13a，已如实写入隐私政策）：被永久删除的种子在其他设备上会留在 daily 快照里最多 7 天，留在 rolling 快照里直到**该设备之后再发生 10 次改动**——安静的设备可能长期保留；服务器历史最多 30 天（可用"清除服务器历史"提前删除）；服务商备份窗口内也还在。

### 4.5 409 与竞争

- `version_conflict`：拉取、合并、重试；每轮最多 5 次，之后进入退避。
- 服务器已提交但响应丢失：下一轮 `needPull`（version 变了）→ 拉取 → 远端正是自己写的 → 合并结果 = 远端 → 不再上传。收敛。
- 50 个配置文件同时看到一次改动：各自 GET、合并结果 = 远端、零 PUT。
- 时钟错的设备不会乒乓：见 §4.2 的说明与 §4.14。

### 4.6 与两槽存储的配合

- **store 锁内不做网络**，网络在锁外，提交时在 `transact` 内重读重合并。
- `service.applyRemote(remote)`：`transact(fn, {ensureCurrentSnapshot: true, afterCommit})`（不带 `keyChange`：当前 VK、keyring 不变，不留旧材料，所以不写换密钥标记，§0.0i 第 2 条）内解密当前 → 夹紧并合并 → 再跑一次守卫 → 无变化返回原值 → 有变化则写合并结果（rev+1），走原有"写非活动槽 → 读回校验 → 切指针"。它和 `mutate` 一样经过 `requireVk`，同步途中被锁定（lockEpoch 变了）会直接失败；远端不保存，下一轮重新拉取。
- 本地编辑永远先在本地提交，再安排上传。
- 不存在"用远端整体替换本地"的代码路径；"找回账户"= 选中旧版本或本机快照里的账户，用一次普通的本地编辑找回（§6 O13，修订 26）：
  - "当时在、现在不在"按"当时存活、现在不存活"判断；
  - 现在在回收站里的，以它自己的 id、新时间戳重新声明（secret 与类型是条目自己的，HOTP 计数器保留本机的，计数器从不后退）；
  - 已永久删除的、本机根本没有的、或来自旧库快照的，以 added 模式作为新条目加入。永久删除的条目从不在原 id 下复活。

### 4.7 outbox 与 staged（P10、D2）

- **outbox**：同步开启时，**每次本地提交**都由 `transact` 的 `afterCommit` 在**同一把 store 锁内**为刚提交的 generation 写 outbox。`lastSynced ≠ null` 时它**可推送**：`{base: lastSynced.version, head, from, checksum: 该 generation 的 envelope 校验和, envelope(rev base+1), write_proof}`。`lastSynced == null` 时它**只用于合并**：就是刚提交的 generation 自己的本地 envelope 的副本（本地 `rev`、当前 VK、vaultId，不重新加密），校验和即该 generation 的；没有基准、没有写入证明，从不推送（修订 20，R3R-5）。所有提交（popup、设置页、SW）都经过同一把锁，所以 outbox 永远对应最新的 generation，不会被别的页面的旧计算覆盖。
- **推送**：只有一条路径。SW 被触发时取 `sixkey-sync` 锁，若服务器 version == outbox.base 就 `PUT`（锁定或解锁都可以，带 cursor）；200 → **只有当 `lastSynced` 仍为 `{version: outbox.base, …}` 时**才把它前移为 `{base+1, SHA-256(outbox envelope 原文), outbox.checksum}`（本地比较再写，D2——期间若发生了恢复，钩子已把 `lastSynced` 清空，这里就不会把它"复活"）；若此后本地又改了，校验和不同，仍为 dirty。409、`write_denied` 且密钥已变、或服务器不在它的 (base, head) → **降为孤儿**（下面，修订 20），绝不丢弃；之后由持有 VK 的完整一轮合并。完整一轮成功后清除 outbox。
  - 写入证明把 outbox 绑定在这一次写入（`if_version` + 校验和）上，配置文件副本里的 outbox 只能被原样重放，也就是快进推送这一次本来就要做的写入。
  - `lastSynced == null` 时写只用于合并的 outbox，覆盖上一份：恢复或降级之后的保存一个接一个，最新的 generation 包含之前每一次。超过 `MAX_ENVELOPE_BYTES` 时不写；那时同步本来就以 `too_large` 暂停（§4.3），本节的保护不适用。
- **孤儿 outbox**（`sk_sync_orphan = {v: 1, items: [...]}`；D1 修订 19，**修订 20：列表；降级而不丢弃；搁置而不阻塞**）。
  - **唯一的规则：一份未经 200 确认的 outbox，只有在本轮已合并的库包含它时才能删除**（R3R-1）。
    - 允许删除的只有三处：
      - 完整一轮在"无需上传"时；
      - 完整一轮 CAS 写入 `lastSynced` 时；
      - 入网、云端恢复、采用或发布密钥等清 `lastSynced` 的流程删除仍有效的 outbox 时。

      这三处的活动 generation 或本轮合并的库都包含它的内容。`restoreBackup` 与 `startOver` 只在库为空或丢失时运行；覆盖丢失的数据时，钩子已先把 outbox 降为孤儿。
    - 其余任何会删除 outbox 的地方一律**降为孤儿**：锁定推送遇到 409、`write_denied` 且密钥已变、服务器不在它的 (base, head)。
    - 降级的做法：在 vault 锁内，若 outbox 仍是那一份，用**一次写入**把它追加到列表、清空 `sk_sync_outbox` 与 `lastSynced`。这正是恢复前钩子的那次写入。
  - **恢复前钩子**：把当时的 `sk_sync_outbox`（可推送的或只用于合并的）追加到列表，并清空它与 `lastSynced`，一次写入，不需要密钥。
  - **不变式**：列表里有待并入的条目 ⇒ `lastSynced` 为 null。原因：只有可推送的 outbox 会被降级，降级同时清 `lastSynced`；此后的保存只写只用于合并的 outbox。所以下一次持有 VK 的一轮一定是完整一轮，并且在设置 `lastSynced` 之前并入全部条目。
  - **推送**：
    - 锁定时只推送带写入证明、且服务器 (version, head) 恰好等于它记下的 (base, head) 的那一条。头版本是 envelope 原文的 SHA-256，所以至多一条相符。
    - 200 → 该条退役；其他结果 → 保留。
  - **并入**（只在持有 VK 的上下文：SW 或设置页，从不在 popup；每一轮的第 0 步，无论之后怎样结束）：
    - 逐条打开：用当前 VK 或 `previous` 里的 VK，vaultId 必须相同。
    - 把每条当作"本机自己较早的状态"：`merged = merge(clamp(本地), clamp(条目₁), …)`，经同样的守卫（§4.4），作为一次本地提交写入。
    - 守卫阻塞 → 全部保留，回答按各条的 `seen` 摘要绑定。
    - 来自条目的删除算本机自己的，不触发 danger 横幅。
    - 并入是幂等的。
  - **退役**：只有三种情况。
    1. 推送得到 200。
    2. 在完整一轮设置 `lastSynced` 的**同一次写入**里（上传成功或无需上传），退役本轮并入的全部条目。只在本地并入还不够：上传前再撕裂一次，它们就又成了唯一的副本。
    3. 条目的校验和等于活动 generation 的。
  - **暂时打不开的条目：搁置，不阻塞同步**（R3R-4）：
    - 搁置的条件：当前 keyring 打不开它（例如 FIXa2 把 keyring 退回 VK1，而条目在 VK2 下）；它来自较新的 schema（降级之后的 `newer_schema`）；或并入会超过条目上限。
    - 搁置的条目留在列表里，但**不计入**上面的不变式：这一轮照常完成、设置 `lastSynced`，设备不会永远停在完整一轮，轮换也不会因此 `not_synced`。
    - 每次持有 VK 的一轮都重试；能打开时按普通条目并入，在那一轮的 CAS 写入里退役。
    - 界面（§6 O12，M6）持续提示"本机有 N 份保存这个版本暂时读不了，已保留"，并给出出路：更新 Sixkey（较新的 schema），或用新的主密码解锁以采用较新的密钥（FIXa2）。"高级"里可在确认后删除。
    - 只有在完整一轮已确认本机持有服务器当前的整条 keyring 链、而条目的 vkId 仍不在其中时，才说明它的密钥已永远消失（`capPrevious` 丢掉了 64 次轮换之前的 VK）：移除，并显示一次 `orphan_unreadable`。**这一条只对同一 vaultId 的条目**（修订 24，M6A §12 第 1 条）。另一个 vaultId 的条目一直搁置，例如关闭同步时保留、之后入网到另一个库：它的密钥不在新库的链里，并不说明它已永远消失。它只在用户于同步一节确认后删除，入网到另一个库也不删它。损坏、无法解析的条目移除，它里面没有可救的内容。
  - **删除同步记录的流程**（R3R-2）：
    - 关闭同步、移除同步身份、§3.5 的两个撤销，先并入能打开的条目。
    - **搁置的条目不删除**，这些流程照常完成，不拒绝：关闭同步与移除身份是紧急出口。`sk_sync_orphan` 只剩搁置条目时保留下来（D11 的一步删除跳过它），界面同上。
    - 同步关闭之后，设置页每次解锁（VK 在手）也重试在本机并入搁置条目，打开方式与守卫相同。提示显示在设置页的同步一节：同步关闭时这一节仍在，显示说明卡片（修订 24，M6 偏离第 5 条）。
    - 较新的 schema 的条目在更新 Sixkey 之后的下一次解锁时并入。FIXa2 那种较新 VK 下的条目，关闭同步之后只能靠重新入网同一个库（云端 keyring 列着那个 VK）来并入。
  - **本机库丢失或为空**（R3R-3）：上面这些流程与并入返回 `vault_lost`，不是 `locked`，界面引导去云端恢复（§4.13）或从备份恢复。云端恢复在打开服务器 VK 之后并入。
  - **其他流程**：
    - 会替换或重新加密本机库的流程先并入可打开的条目，在各自的 transact 里经守卫：§3.5 入网（`sk_prejoin` 与 added 导入都基于并入后的本机库）、云端恢复、§3.9 R3 采用新 VK、轮换（"先合并"的那一轮）、§3.10 关闭同步。
    - `startOver` 只在库丢失、密钥已不可得时才运行，这时条目也打不开，随用户确认清除的残留一起删除。
    - R2 同一 VK 的采用与本机发布的改密码、换恢复码不改库内容，不碰列表。
  - **界限**：
    - 每次恢复或降级至多追加一条，每条 ≤ 一个上传 envelope（≤ `MAX_ENVELOPE_BYTES`）。
    - 一次持有 VK 的一轮并入所有能打开的条目，所以待并入的条目数 ≤ 1 + 两次这样的一轮之间发生的恢复次数；另有少量搁置条目。
    - 不按时间老化："每次都锁定"模式下并入要等下一次在设置页的一轮，可能是几周后。
  - **与 FIXa2、快照、`keys_adopted` 的关系**：
    - FIXa2 回退同样经过钩子。
    - 快照规则不变，并入产生的是普通的新 generation。
    - 条目不是 `VkRecord`：只读、只用于合并，打开时靠 keyring 的 `previous`，所以换密钥的清理不移动它们，标记的承诺也不包括它们。
    - `keys_adopted` 不受影响。
- **staged**：远端 KeyBundle，§3.9。
- 锁定时**从不**改写本地 generation，也不拉取远端内容（C8）。

### 4.8 触发、防抖与 MV3 定时（PLAN 6）

- 本地提交之后（outbox 已在提交步骤里写好），页面给 SW 发 `sk-sync-soon`；SW `setTimeout(3s)` 防抖，同时建 `sk-sync-kick` alarm（+30 s）兜底。dirty 是推导出来的，SW 被杀后重启自然补做。
- SW 每次启动：同步已开启且 dirty 或有 outbox → 安排一轮；确认 `sk-sync-periodic`（30 分钟）存在，首次创建时用随机相位（1–30 分钟），避免同时拉起几十个配置文件时打满服务器。
- 弹窗打开：**先渲染本地**（PLAN 9 的 <100 ms 不等网络），`lastOkAt` 超过 30 秒则后台同步。设置页打开同理，并刷新设备列表。
- 退避：失败 n 次 → `min(30 分钟, 5 s × 2ⁿ) ± 20 %`；<30 s 用 setTimeout，≥30 s 用 alarm；成功即清零。429/503 遵守 `Retry-After`，以它为下限（M3RR-2）：
  - **每个 503 都计入失败次数**，否则持续返回 503（带 `Retry-After: 5`）时，会让每个客户端每 10 秒左右重试一次，放大服务器的故障；
  - 429 也计入，唯一例外：仍在退避中时用户显式发起的那一轮。
- 入网/批准页面自己每 2 秒轮询自己的端点，不经过同步引擎。

### 4.9 谁来跑：网络只在 SW

- 所有 HTTP 只在 SW（`platform/api.ts` 只被打包进 `sw.js`，check-dist 强制）。**由浏览器强制**（修订 21，M-1）：每个扩展页面都带自己的 `connect-src 'none'`（§7），所以 popup、设置页、offscreen 与开发页连 API origin 也连不上；SW 没有文档，不受页面策略约束，只受 manifest 的策略约束。
- **权限是网络开关**（修订 21）：
  - SW 在每一轮与每次推送之前先 `chrome.permissions.contains` 那个 origin。权限不在 → 状态 `permission_removed`：不发任何网络请求；不算失败，不改失败计数与退避。本机库、outbox、孤儿列表、`lastSynced`、身份与钉住值**只经下面那些不联网的本机维护**改变（修订 23）；本地编辑照常写 outbox。
  - `chrome.permissions.onRemoved` 立即置这个状态，`onAdded` 安排一轮。
  - 检查与 fetch 之间权限才被移除时，那一次失败按普通网络错误处理，下一轮的检查给出 `permission_removed`。
  - 重新授权只能在同步设置页的按钮里（用户手势）。
  - 权限回来后照常继续：`lastSynced` 仍然可信（暂停期间只有本机维护会改它，与平时一样），CAS 保证正确，没有任何数据丢失。
  - **权限检查排在一轮的本机停止之后**（修订 22）。一轮先做不联网的本机维护，然后才检查权限。维护包括：
    - 第 0 步并入孤儿；
    - 清掉损坏的孤儿列表；
    - 从副本恢复身份（`identity_missing` 的本机部分）；
    - `cfg_missing` 时完成关闭同步的本机部分；
    - `cloud_restore` 向页面报告。
    - 这些步骤什么都不发送，权限要守的只是网络，所以不必等重新授权。否则一个没做完的关闭同步会一直等到用户重新授权，而用户正想关掉同步。
    - 与浏览器启动时的回收一致：没有 `sk_sync_cfg` 时启动会移除已授予的权限，而关闭同步的本机部分照样在下一轮的开头完成，两者互不依赖。
- **谁签名，谁发出**（修订 22，与 M3、M5 的实现一致）：
  - 设备签名私钥（DSK）以 non-extractable 的形式存在 IndexedDB `sixkey-identity` 里，同一配置文件里的扩展上下文都能用它签名。它另有一份用 VK 加密的副本在 `sk_sync_cfg.enc`（§2.5），所以持有 VK 的代码可以取回它（修订 23）。下面的论证不依赖"密钥拿不到"，而在于 SW 的接口提供什么、请求能从哪里发出。
  - **SW 只签它自己的请求**：它自己发起的一轮、outbox 推送、状态轮询。
  - **页面跑一轮或一个流程时，自己签自己的请求**，再把签好的请求经 `chrome.runtime.sendMessage({type: "sk-api", …})` 交给 SW 转发。现有的 `sender.id === chrome.runtime.id` 校验沿用。
  - SW 转发时**从不签名**，也不保存经过的任何东西（账户会话 token 也不）。它只：
    - 确认发送者是允许的页面（设置页；dev/e2e 另有开发页；popup 不在其中）；
    - 确认请求只有引擎会设的方法、请求头与大小；
    - 把 origin 钉在配置的 API origin；
    - 确认请求目标与签过名的目标逐字相同。
  - 理由：一个替页面签"随便什么"的 SW 就是一个签名服务，任何能给它发消息的代码都能借它的身份签名，而不必持有 VK。按现在的分工，SW 的消息接口不提供签名。
    - 被攻破、持有 VK 的页面能取回 DSK、签任何东西，但它的请求只能经 SW 发往那一个 API origin：页面自己的 `connect-src 'none'` 不让它直接连任何地方（§7）。
    - 桥只检查形状、请求头与大小，不检查内容，所以这样的代码仍能把数据放进发往 API origin 的请求，例如写进它自己控制的账户。能做到这一步的代码本来就能读整个库。
  - 对外部审计者，这里的保证是"网络只经 SW、只到一个 origin、请求原样送达"，而**不是**"只有 SW 能签名"。
- 账户会话 token 只存在发起流程的设置页标签页内存中，每次账户级调用随消息交给 SW，SW 不保存。
- 涉及 VK 的运算（解密、合并、写入证明、outbox）留在持有 VK 的上下文：SW 若在 `storage.session` 拿得到 VK 就自己跑完整一轮；否则由打开着的页面跑 `core/sync/engine`，其 Transport 经消息桥转给 SW。
- 两把 web lock：`sixkey-sync`、`sixkey-vault`（现有）。**`sixkey-sync` 归跑这一轮的上下文**（D10）：页面跑一轮时由页面持有，SW 的传输函数（替页面发请求）**从不**取这把锁，否则会互相等死；只有 SW 自己发起的一轮或 outbox 推送才由 SW 取锁。**密钥操作也像一轮那样持有 `sixkey-sync`**（M3RR-4）：轮换的读取本机库、读同步状态、查状态与发送都在锁内，锁忙则稍后再试；否则另一个上下文的一轮可以插在它读库与读状态之间，使它轮换一个没有并入最新头版本的库。SW 的传输函数仍从不取这把锁。这样同一配置文件里的 PUT 一定串行，克隆 cursor（只随 PUT 交换，§4.10）不会误报；状态查询不涉及 cursor，不需要锁。

### 4.10 同机多配置文件

- 每个配置文件的 storage.local / storage.session / IndexedDB / web lock 都相互隔离，配置文件之间只通过服务器 CAS 协调。
- 每个配置文件独立解锁；锁屏时每个配置文件的 SW 都会各自上锁（Phase 0 行为）。`lockEpoch` 也是每配置文件一份；同步提交走 `requireVk`，会尊重它。
- 负载：几十个配置文件 × 每 30 分钟一次状态轮询 + 弹窗打开时一次，量很小，而且状态查询不写服务器数据库；只有发生改动的那个配置文件会 PUT；限流按设备计（§5.5），配置文件多不会互相挤占。
- **解锁摩擦**：每次浏览器（或每个配置文件进程）重启后，每个配置文件都要输一次主密码（已决 Q4，Phase 3 用 WebAuthn PRF 改善）。
- **厂商同步、复制、转移配置文件 = A3**，在这些产品里是文档化的正常功能：GoLogin 云同步含扩展存储；Kameleo 复制/导出含扩展及其存储；Multilogin X 转移含 Local storage 与扩展；AdsPower、BitBrowser、VMLogin、Dolphin 有"同步扩展数据"开关（BitBrowser 2023-08 正是经此路径出事）。保护靠主密码；**加入同步的配置文件不能被厂商同步或共享**（§1.3）；转移配置文件前先卸载 Sixkey（§9.1 H8 的使用指南）。
- **IndexedDB 可能单独丢失**（GoLogin SDK 每次停止都删除），由 §2.5 的设备凭据副本处理。
- **配置文件克隆**（d3，M6）：克隆连扩展存储一起复制时，两个副本共用 deviceId、DSK、HLC 设备 ID 和本地库，合并仍确定性收敛、不丢数据，但需要分开身份。同一个云配置文件先后在两台机器上打开，效果也一样。
  - **软检测，只在写入时**（T2）：`sk_sync_cfg.cursor = {cur, pending?}`。每次 `PUT /v1/vault`（完整一轮或 outbox 推送），客户端若没有 `pending` 就生成 16 字节随机数并**先写入本地**，再把 `cursor: {cur, pending}` 放进**已签名的请求正文**。服务器在同一个写事务里：存的值 = `cur` → 改存 `pending`；存的值 = `pending`（上次已更新、客户端没来得及确认）→ 照常；都不是 → 照常接受这次写入，但响应带 `forked: true`、不改存值。客户端收到 200 就把 `cur` 换成 `pending`。没有 cursor 的设备开始新的一条链。
  - 两个写入的克隆各自生成不同的 `pending`，最迟第二次写入就有一个被判为 `forked`；只读的克隆不会被发现（它也写不了任何东西）；一次崩溃不会误报；同一配置文件内的 PUT 由 `sixkey-sync` 锁串行化（§4.9），也不会误报。状态查询完全不碰 cursor，所以状态轮询不写数据库。
  - **处理**：非阻塞提示"此配置文件似乎是另一个配置文件的副本（克隆或厂商同步）"，两个选项：［为本配置文件建立独立身份］与［吊销并保护］（S1：被判为副本的可能恰恰是真设备，而副本持有者也可能知道密码）。建立独立身份 → 输入主密码 → `POST /v1/devices/fork {new_device_id, new_sig_pubkey, name_ct, password_auth}`（用当前 DSK 签名；另加请求头 `Sixkey-New-Sig: base64url(P1363 r‖s)`——新私钥对**完全相同**的签名输入的签名，证明持有新私钥，S5。放在请求头而不是正文里，是因为签名输入含正文哈希，正文里的签名无法覆盖自身，N1）→ 服务器新建一行（`joined_via=fork`、`approved_by` = 原设备）→ 本副本先写好新 IDB 身份与新 `sk_sync_cfg`，再切换过去，**重新生成 `sk_device`**，`lastSynced` 置空。原副本保持原身份。需要 `pw_auth`，所以只拿到设备凭据的人无法借此"繁殖"新设备。
  - 验收标准：分身后两个副本的 deviceId、DSK、`sk_device` 都不同；之后它们的编辑产生不同的 HLC 设备后缀。
- 指纹浏览器厂商同步配置文件 = A3（厂商持有配置文件副本），保护靠主密码；帮助文案里说明。

### 4.11 离线

本地功能完全不变；编辑本地提交并写 outbox；状态"离线 · 有改动待同步"；恢复联网后由下一次触发补做。长时间离线期间别处轮换了密钥 → 重连后 `needs_password`，本地编辑在采用新 VK 的合并中保留。

### 4.12 HOTP（Phase 1 开始生成）

- 计数器按 max 合并（`merge.ts`），与内容时间戳无关。
- 规则：① 同步开启且在线时，先拉取合并（2 秒超时）；② **计数器 +1 先在本地提交，再显示验证码**；③ 立即上传（不等 3 秒防抖）；④ 离线也照常生成，并提示"离线：其他配置文件可能用了同一个计数"。
- 计数器递增不改 content `hlc`（避免覆盖并发的重命名），canonical 差异照样会触发上传。
- 残余：两个离线配置文件仍可能发出同一计数的码；网站接受先到的那个，其前瞻窗口能接受下一个。

### 4.13 恢复链的"云端"一级（PLAN 4.4，C7）

两槽 → 快照 → 镜像都失败（`lost`）时，若 `sixkey-identity` 中有 `enrolled` 身份：提供"从云端恢复（需要主密码）"→ DSK 签名拉取 envelope + bundle → 用户输入密码 → 解包 → **按钉住的 vkId 检查**（F7）：bundle 的 vkId 必须等于钉住值，或通过 R3 的连续性检查；否则拒绝（防止被引回旧 VK）→ 确认后 `transact(overwriteLost)`（先触发恢复前钩子）写 `{本地 rev 0 重新加密, keyring: bundle.keyring}` → 恢复事件 `cloud_restore` → `lastSynced` 为空。
`storage.local` 被整库删除而 IndexedDB 还在时，这一级可用；反过来 IndexedDB 丢了而 storage.local 还在时，走 §2.5 的 `identity_missing`（从 VK 加密副本恢复身份）。两者都没了（卸载扩展，或厂商只同步了其中一部分又丢了另一部分）就只能重新入网。注意：在每次停止都删除 IndexedDB 的指纹浏览器里，Phase 0 的 IndexedDB 镜像也不是独立副本（§7 的文档更正）。单设备用户重装后只能靠恢复码（已决 Q2-a）。

### 4.14 时间（F5、S3）

- 服务器时间取自响应里的 `server_time` 与 `Date` 头；偏移存 `sk_sync_state`。
- **HLC 与夹紧**：同步开启时，HLC（`createClock` 的 `now`）和 `clampVault` 的参考时间用 `Date.now() + 偏移`，偏移限制在 ±7 天（F5 需要它，否则时钟快的设备会让大家乒乓上传）；同步关闭时与 Phase 0 相同。
- **TOTP 默认用本机时钟**（S3）：生成验证码不依赖服务器——服务器时钟出错或撒谎（偏 40 分钟）不能让所有已同步设备的验证码同时失效。偏移 >15 秒时弹窗横幅"系统时间与服务器相差 N 秒，验证码可能无效"，附开关"用校正后的时间生成验证码"（`useCorrectedTotp`，由用户选择；偏移超过 ±1 小时时只提示、不提供校正）。
- **存下的服务器时差只由真正收到的服务器时间改写**（M3RR-9）：一轮在开头就停下（`identity_missing`、`damaged`、`wrong_origin`、`cloud_restore`），或推送在收到任何响应之前就停下时，都不得把 `serverOffsetMs` 重置为 0。新启动的 SW 先从 `sk_sync_state` 读入时差，再开始一轮。否则本地编辑的 HLC 会退回未校正的时钟，开着"用校正后的时间"的 TOTP 也会失效。
- 请求签名用校正后的时间，签名的上下文是页面还是 SW 都一样，都读存下的时差（§4.9）；收到 `401 clock_skew` 时采用其中的 `server_time` 重试一次。这是 M3/M5 的硬性要求：`reject-all` 的范围按客户端签名的 `Sixkey-Ts` 计（§5.2）。本机时钟慢 4 分钟时用未校正的时间签名，"拒绝全部"会漏掉最近 4 分钟里发起的请求，而用户以为全拒了。

---

## 5. 后端

### 5.1 结构

```
api/
  app/main.py                 create_app()
  app/routes/                 auth, account, vault, keys, devices, enroll, health（只做 HTTP；`GET /healthz` 只供托管平台存活探测，无认证、不读数据库，N22）
  app/deps.py                 account_auth（JWT）、device_auth（签名）、pending_auth（入网中的签名）
  app/auth_provider.py        接口 AuthProvider: send_otp / verify_otp / revoke_session / delete_user / purge_unconfirmed
                              实现：SupabaseAuthProvider、FakeAuthProvider（本地与测试；OTP 写入测试专用收件箱）
  app/wire.py                 无钥校验：envelope 形状与校验和、KeyBundle 形状与一致性、P-256 SPKI、签名（P1363→DER）、HMAC 写入证明
  app/ratelimit.py            内存滑动窗口（单实例；多实例时换 Redis）。按 IP-HMAC 的计数 TTL ≤1 小时；
                              按邮箱或账户的天级计数以 HMAC(当日密钥, 邮箱/账户) 为键，TTL ≤24 小时；都不落盘
  app/jobs.py                 每日清理：过期入网请求、24 小时前未确认的 auth 用户（T3）、历史保留
  app/logging.py              见 5.6
supabase/migrations/0001_sixkey.sql   同一份迁移也在本地 Postgres 上跑（本地用一个 auth.users 桩表）
api/tests/                            pytest + httpx，真实 Postgres（docker compose）
```
- **实际布局**（M4，A27）：包在 `api/server/sixkey_server/`，迁移在 `api/server/migrations/`，共两个：
  - `0001_sixkey.sql`；
  - `0002_least_privilege.sql`（S11）：从 PUBLIC 收回 `public` schema 上的 CREATE 与数据库上的 TEMP、CREATE。权限是叠加的，只从 `sixkey_api` 收回没有用。

  M8 把两者都复制到 `supabase/migrations/`。应用 0002 之前，先确认没有任何 Supabase 角色依赖这些 PUBLIC 授权。
  - 0002 以一个后置条件结束：`sixkey_api` 仍有 `public` 上的 CREATE 或数据库上的 TEMP/CREATE 就报错。非属主执行 `REVOKE … FROM PUBLIC` 只给 WARNING 并返回成功，报错使整个文件回滚、不被记录。所以要以 `public` schema 与数据库的属主运行它。
  - 这个文件改过，哈希变了；迁移运行器拒绝哈希不同的已记录文件，所以记录过旧 0002 的本地数据库要 `make pg-reset` 一次。
- **`SIXKEY_ENV` 必须显式给出**（S12）：未设置时拒绝启动。FakeAuthProvider 只在 dev/test 且只监听回环地址时可用，否则一个忘了设 `SIXKEY_ENV` 的部署会跑假的认证。

### 5.2 认证

**账户会话**（邮箱 OTP，D1）
- `POST /v1/auth/otp {email}` → Supabase `POST /auth/v1/otp {email, create_user: true}`；无论邮箱是否存在都返回 202。邮件模板只放 `{{ .Token }}`。`create_user: true` 会给任何被输入的邮箱建一个未确认的 auth 用户：每日任务删除 24 小时前仍未确认的（T3），隐私政策披露。
- `POST /v1/auth/verify {email, token}` → Supabase `POST /auth/v1/verify {type: "email", …}` → 拿到 access + refresh token → **立即**用该 access token 调 `POST /auth/v1/logout?scope=local` 撤销会话 → 只把 access token 作为 `account_token` 返回（C1）。
- 账户会话随请求头 `Authorization: Bearer {account_token}` 发送（N10）。
- 立即登出失败时，`verify` 返回 503（失败关闭：这个验证码已用掉，用户重新获取一个，A23）。
- 项目 JWT 有效期 900 秒。校验沿用 PLAN 7.1：JWKS（ES256）、`algorithms=["ES256"]`、`aud=authenticated`、`iss`、`exp`、`sub`，拒绝 `is_anonymous`；`aud` 必须恰好是字符串 `authenticated`（不能是列表），`role` 也必须是 `authenticated`（M4 I2）；删除账户另要求 `iat ≥ now − 600`。

**设备签名**
- 请求头：`Sixkey-Device: {deviceId}`（入网中的新设备改用 `Sixkey-Enroll: {request_id}`）、`Sixkey-Ts: {ms}`、`Sixkey-Sig: {base64url(P1363 r‖s)}`。
- 签名输入：`sixkey-req|1|{host}|{METHOD}|{target}|{signer}|{sub}|{ts}|{base64url(SHA-256(body))}`
  - `host` = **配置的** API origin 的 `URL.host`：小写，只有非默认端口时才带 `:port`（e2e 为 `127.0.0.1:8787`），不是代理后收到的 `Host` 头；`target` = 原始请求目标（以 `/` 开头的路径 + 查询串，百分号编码原样保留）；没有正文的请求对零字节求哈希（N9）；
  - `signer` = deviceId 或 `enroll:{rid}`；`sub` = 请求带账户会话时为 JWT `sub`，否则为 `-`。
- 服务器：按主键查设备 → **先验签**（无论是否已吊销）→ 已吊销 `403 device_revoked`、不存在 `401 unknown_device`（P6）；`|ts − now| > 300 s` → `401 clock_skew {server_time}`；之后所有查询只用设备行里的 user_id。写操作的事务先锁设备行并确认未吊销（§5.3，C3）。
- 注册类端点（init、发起入网、恢复码入网）的请求体带 `sig_pubkey`，并用对应私钥签名，证明持有私钥。此时还没有设备行也没有 rid，签名者请求头为 `Sixkey-Device: {正文里的 device_id}`，必须与正文一致；验签用正文的 `sig_pubkey`；签名输入里的 `sub` 是 JWT `sub`（N8）。
- 分出独立身份另带请求头 `Sixkey-New-Sig`：新私钥对与 `Sixkey-Sig` **同一个**签名输入的签名；服务器用正文的 `new_sig_pubkey` 验它（N1）。
- **不加 nonce 缓存**（M4，所有者委托决定）：窗口内的重放大多命中乐观锁或幂等判定，或是幂等操作（吊销、拒绝），或命中一次性状态机。M4 评审确认了六种残余，每一种都需要截获受 TLS 保护的已签名请求（需要时连同其中的 `pw_auth`），都不暴露明文、不破坏库的完整性：
  1. **改名**：重放一个较早的改名请求，撤销一次较新的改名。
  2. **`reject-all`**：重放会拒绝原请求之后新发起的入网请求。**采纳的缓解**：`reject-all` 只删除 `created_at ≤ minute_floor(签名的 Sixkey-Ts)` 的请求，所以只剩同一分钟内发起的请求会被误删。
  3. **`DELETE /v1/vault/versions`**：重放会删除原请求之后写入的历史版本。用户本来就要求清除历史，损失的是这几分钟内新写的历史。
  4. **被拒之后重放入网创建**：账户会话 15 分钟内仍有效，唯一行已随拒绝删除，所以重放会再建一个带 N 的 id、公钥与承诺的待处理请求。重放者推进不了它（没有私钥），它只是在 A 上显示为待处理（幽灵请求），10 分钟后过期。
  5. **"拒绝全部"之后重放恢复码入网**：重建一条已批准的恢复码请求，并把 envelope 与 bundle 返回给重放者。这是密文与包裹过的密钥，同 6。
  6. **已签名的 GET**（`/v1/vault`、`/v1/keys`、历史版本）在 5 分钟内重放，会把密文与包裹过的密钥交给截获了请求头的人，可用于离线猜密码。这只对"记录请求头却不记录响应"的人有意义；真正的控制是托管规则"从不记录请求头或正文"（§5.6）。
  - 不加缓存的理由：Chromium 会自动重发"复用的 keep-alive 连接失败了"的请求；若服务器其实已处理过，缓存会答 401，客户端把它当认证失败（§3.10 遇 401 `unknown_device` 即停止同步），把本来正确的 409/200 变成误报。而且缓存只在一个进程里，重启或第二个实例就重新打开窗口。
- **PITR 恢复栅栏**（M8，M3RR-13）：服务器的 CAS 只按 `if_version`，写入证明也不含头版本。所以诚实的 PITR 之后，一个在恢复前签名、迟到的 PUT 或轮换，若碰巧带着被复用的 `if_version`，会被接受，覆盖它从未见过的头版本。对策：恢复时服务器记下恢复时间，拒绝 `Sixkey-Ts` 早于它的签名，答 `401 clock_skew`；客户端重新签名，引擎按新的状态重新决定。不需要客户端或契约改动。
- **写入证明**：`PUT /v1/vault` 与 `/rotate` 必须带 `write_proof = HMAC(K_write, "sixkey-write|1|{vaultId}|{if_version}|{envelope.checksum}")`，服务器用 `vaults.write_key` 常数时间校验，失败 `403 write_denied`（不计入任何额度，也不会让设备被暂停，S2）。
- **`pw_auth` 与限流的顺序**（S2）：需要 `pw_auth` 的请求先校验它；有效则不受按设备限流约束，无效则计数后拒绝（不锁定、不退避）。
- CORS（修订 21）：生产环境**不返回任何 CORS 头**（`SIXKEY_CORS_ORIGINS` 为空），预检也不放行。
  - 扩展的 SW 有了 host 权限就不受 CORS 约束、也不发预检，所以不需要 CORS。
  - 反过来，若对商店扩展 ID 返回 CORS，没有授权的商店构建也能经 CORS 连上 API（服务器的预检放行全部 `Sixkey-*` 头），可选权限就不再是网络开关。
  - 没有 CORS，网页也读不到响应。
  - 开发与 e2e 构建声明必需的 host 权限，同样不需要 CORS。
  - 原来"只对商店扩展 ID 返回 ACAO，目的仅是防止网页读取响应"的做法取消。**服务器的任何安全判断都不依赖 `Origin`**（d6）：SW 带 host 权限本来就不受 CORS 约束；而指纹浏览器常用 zip/crx/未打包目录安装扩展，此时扩展 ID 由路径决定、可能变化，按 Origin 拒绝只会误伤合法用户、挡不住任何攻击者。
- **最低客户端版本**（d6）：`GET /v1/sync/status` 返回 `min_client_version`，格式同 Chrome manifest 版本号（`^\d{1,5}(\.\d{1,5}){0,3}$`），逐段按数值比较，缺的段视为 0（N21）。低于它的客户端进入 `update_required`，停止一切读写，提示"此副本过旧且不会自动更新，请从 Chrome 应用商店安装"。客户端在**发送**每个非豁免的写入时检查它，而不只在准备时检查：例如 `commitRecoveryCode` 的 PUT（M3RR-5；豁免的是只收回权限的写入：吊销、关闭同步、拒绝）。M4 不强制它，它是给诚实构建的安全阀，不是访问控制。

### 5.3 数据库（细化 PLAN 7.2）

- 表放在不对外暴露的 `sixkey` schema；全部开启 RLS。**角色**（C2）：表由只用于迁移的 `sixkey_owner`（NOLOGIN 或只在迁移时使用）拥有；FastAPI 用 `sixkey_api` 连接，获得 `select/insert/update/delete` 授权，并在每张表上有一条 `TO sixkey_api USING (true) WITH CHECK (true)` 的策略；`anon`/`authenticated`/`public` 没有任何授权也没有任何策略，因而被拒绝。（只开 RLS 而不建策略，非属主角色什么都看不到，API 会读写不了自己的表。）M4 用测试确认：在这套属主与策略下，删除 `auth.users` 行的级联照常生效。
- asyncpg 走 transaction pooler 时 `statement_cache_size=0`。迁移中设 `ALTER ROLE sixkey_api SET timezone = 'UTC'`（N4）：`date_trunc` 与 `current_date` 跟随会话时区，否则 +05:30 时区下得到的不是 UTC 整点；应用层的时间也一律按 UTC 计算。
- **`devices_rev`**（N15）：`vaults.devices_rev` 是一个不透明计数器，与任何 `devices` 行变化在**同一事务**里加一——新增（init、complete、fork）、吊销、改名、`auth_failures` 增加（计数封顶后不再写，也就不再加）与被有效证明清零（A12，其他设备随之去掉横幅）、轮换时重新加密设备名。`cursor` 与 `last_seen_at` 的写入不加。`last_seen_at` 的每日更新不加。状态查询返回它，客户端只比较是否相等；它取代 `devices_changed_at`，后者没有对应列、在小时精度下会漏掉改名、输错密码与同一小时内的两次加入，还会泄露时间。
- **级联**：`vaults`、`devices`、`enrollments` 的外键指向 `auth.users`，`vault_versions` 指向 `sixkey.vaults`，全部 `on delete cascade`，所以删除 auth 用户会一步清空全部行（§5.7）。
- **时间精度**（C14）：`vaults`、`vault_versions`、`devices.created_at`、`devices.revoked_at` 到小时；`devices.last_seen_at` 到天、只在跨天时写一次（T2）；`enrollments.created_at` 到分钟（只用于"N 分钟前发起"，记录 10 分钟内删除）；`enrollments.expires_at` 是 (now + 600 s) **向上**取整到分钟（A13），所以有效期在 10 到 11 分钟之间，也不泄露精确的发起时间。
- **状态查询不写库**（T2）：除跨天时更新一次 `last_seen_at` 外，`GET /v1/sync/status` 只读。

```sql
create table sixkey.vaults (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  vault_id           text   not null,
  version            bigint not null,
  vk_id              text   not null check (vk_id ~ '^[0-9a-f]{16}$'),
  envelope           text   not null,              -- EncryptedVault JSON 原文
  head               bytea  not null check (length(head) = 32),               -- SHA-256(envelope 原文)（D5）
  devices_rev        bigint not null default 0,                               -- 设备列表变化计数（N15）
  size_bytes         int    not null check (size_bytes <= 8388608),           -- = envelope 原文 UTF-8 字节数（MAX_ENVELOPE_BYTES）
  kver               bigint not null,
  bundle             text   not null,              -- KeyBundle 原文（不用 jsonb，P11）
  recovery_verifier  bytea  not null check (length(recovery_verifier) = 32),
  password_verifier  bytea  not null check (length(password_verifier) = 32),
  write_key          bytea  not null check (length(write_key) = 32),          -- K_write（C12）；M7 起受 KMS 层保护（S7）
  history_bytes      bigint not null default 0,
  created_at         timestamptz not null default date_trunc('hour', now()),
  updated_at         timestamptz not null default date_trunc('hour', now())
);
create table sixkey.vault_versions (               -- 【变更 C3】不存 wrapped_keys / bundle；不记录写入设备
  user_id    uuid   not null references sixkey.vaults(user_id) on delete cascade,
  version    bigint not null,
  vk_id      text   not null,
  envelope   text   not null,
  size_bytes int    not null,
  created_at timestamptz not null default date_trunc('hour', now()),   -- 小时精度（F13c）
  primary key (user_id, version)
);
create table sixkey.devices (
  device_id     text  primary key check (device_id ~ '^[A-Za-z0-9_-]{22}$'),
  user_id       uuid  not null references auth.users(id) on delete cascade,
  sig_pubkey    bytea not null,                     -- P-256 SPKI DER
  name_ct       text,                               -- {vkId, iv, ct}，端到端加密、定长（C6、N6）
  joined_via    text  not null check (joined_via in ('first','approval','recovery','fork')),
  approved_by   text,
  created_at    timestamptz not null default date_trunc('hour', now()),
  last_seen_at  date,                               -- 天粒度，跨天才写（T2）
  revoked_at    timestamptz,                        -- 小时精度（T3）；不记录"谁吊销的"
  auth_failures int   not null default 0,           -- pw_auth / recovery_auth 失败计数，只用于告警（§3.14）
  cursor        bytea                               -- 克隆软检测的当前值，只在 PUT 中更新（§4.10）
);
create index devices_by_user on sixkey.devices(user_id);
create table sixkey.enrollments (                   -- 完成、拒绝、过期即删除，不留历史
  request_id         uuid  primary key default gen_random_uuid(),
  user_id            uuid  not null references auth.users(id) on delete cascade,
  via                text  not null check (via in ('approval','recovery')),
  session_ref        bytea not null,                -- SHA-256(JWT session_id)：每个账户会话 1 个待处理请求（F8）
  new_device_id      text  not null,
  new_sig_pubkey     bytea not null,
  commit             bytea,                         -- approval 必填，32 B
  state              text  not null check (state in ('pending','responded','revealed','approved')),
  approver_device_id text,
  approver_epk       bytea,
  new_epk            bytea,
  new_nonce          bytea,
  new_name_ct        bytea,                          -- reveal：K_enroll 密文，批准方视角在 approved 时仍要返回（F-10）
  name_ct            text,                           -- approve：K_name 设备名密文，complete 时成为 devices.name_ct（A3）
  transcript_hash    bytea,
  payload            bytea,
  created_at         timestamptz not null default date_trunc('minute', now()),
  expires_at         timestamptz not null
);
create index enrollments_by_user on sixkey.enrollments(user_id, state);
create unique index enrollments_one_per_session on sixkey.enrollments(user_id, session_ref);
```
- `enrollments` 的**每一条** UPDATE 都带 `AND expires_at > now()`（P6）；过期行由每日任务删除（并在每次访问时顺手删除）。
- **PUT 事务**（沿用 PLAN 7.2 的 CAS，补上设备行锁，C3）：
```sql
BEGIN;
SELECT 1 FROM sixkey.devices WHERE device_id = $6 AND revoked_at IS NULL FOR NO KEY UPDATE;   -- 0 行 → 403；与并发吊销串行（A1）
WITH upd AS (
  UPDATE sixkey.vaults SET version = version + 1, envelope = $2, head = $7, size_bytes = $3,
                           updated_at = date_trunc('hour', now())
   WHERE user_id = $1 AND version = $4 AND vk_id = $5
  RETURNING user_id, version, vk_id, envelope, size_bytes)
INSERT INTO sixkey.vault_versions (user_id, version, vk_id, envelope, size_bytes)
SELECT * FROM upd RETURNING version;
-- 0 行：SELECT version, vk_id, kver → version 不符 = 409 version_conflict；vk_id 不符 = 409 vk_mismatch
-- 同一事务内：按 §4.10 比较并更新 devices.cursor，决定响应里的 forked
COMMIT;
-- 事先在应用层检查：写入证明、envelope.rev = $4 + 1、envelope.vaultId = vault_id、envelope.vkId = $5、校验和、大小
```
- **行锁与全局锁顺序**（A1）：设备行用 `FOR NO KEY UPDATE`，不用 `FOR SHARE`。同一事务随后还会更新这一行（PUT 的 `cursor`、轮换的设备名、`auth_failures`），两个都持有 `FOR SHARE` 再更新同一行的事务会死锁，例如同一身份的两个克隆同时 PUT。`FOR NO KEY UPDATE` 仍与吊销事务的 UPDATE 冲突，所以 C3 照样成立。
  - **每个写事务都按同一顺序加锁**：设备行（按 device_id）→ vault 行 → 入网请求行（按 request_id）；`vault_versions` 行只在持有 vault 行时触碰。
  - 由此：轮换在 CAS 之前锁住该账户全部设备行；`complete` 先锁 vault 行，再锁它的请求；吊销先锁 vault 行，再作废批准方的请求；批量删除请求按 request_id 顺序。
  - 已知的唯一反序是删除账户：auth 用户的级联顺序由 Postgres 决定。它与另一台设备的写入并发时可能死锁，被选中的一方什么都没做完；死锁与串行化冲突返回 503 `unavailable` + `Retry-After`，删除先在服务器端重试一次（§5.7）。
- **`PUT /v1/keys` 与轮换的检查顺序**（A5）：
  1. 形状与 kver 范围（422）；
  2. 已存 bundle 原文与提交的逐字节相同 → 幂等 200；
  3. CAS 前提（409；轮换时 `if_version` 与 `if_kver` 都过时，先报 `keys_conflict`，因为密钥竞争让这次轮换作废，A7）；
  4. 写入证明（轮换，403）；
  5. `pw_auth` / `recovery_auth`（403，计数）；
  6. vaultId、vkId、`by` 与 P4（422）；
  7. 事务。

  幂等 200 必须排在一切证明之前：同一请求在原请求成功之后逐字节重放，带的是被替换掉的状态下的 `pw_auth`（此时已不对）；而 P4 拿它与已存的相同 bundle 比较时会要求"不带校验值"。先查证明的服务器永远答不出承诺的 200。这个 200 不改任何东西，透露的也只有 `GET /v1/keys` 本来就返回的内容。409 排在证明之前，诚实的竞争才不会被算成输错密码。
- **轮换的 `device_names`**（A6）：每个 id 必须是本账户的设备（否则 422），不得重复，每个 `name_ct.vkId` 必须是新 VK；没列出的设备保留旧的 `name_ct`（例如并发完成入网的设备），由客户端之后补列。
- `/v1/keys/rotate` 一个事务：先按 device_id 顺序锁住该账户全部设备行（`FOR NO KEY UPDATE`）→ `WHERE version = $if_version AND kver = $if_kver` 的 UPDATE（新 kver 只需 `> $if_kver`，N27）（换 vk_id、envelope、head、bundle、两个 verifier、write_key）→ 插入历史 → 批量更新 `devices.name_ct` → 删除该用户全部 `enrollments`。幂等 200 按上面的检查顺序判定（§3.6.0）。
- `init` 幂等（D4）：`vault_id`、`device_id`、`sig_pubkey` 与 bundle 原文都与已存的相同 → 201 同样结果；否则 `409 vault_exists`。`complete`：
  - 第一次 complete 就删除请求行，所以同一 rid 的重试连认证都做不了，得到 410（A17）。结果不明时的出路是 D4：N 以 devN 签名查状态，200 即已入网；M5 在一次结果不明的 complete 之后遇到 410 就走这条。
  - 幂等 200 只适用于另一次请求（另一个会话）为同一账户里同一 device_id + 同一公钥再次 complete。
  - 设备 ID 在发起与 complete 之间已被占用（别的账户 init、一次 fork）→ 409 `enroll_state`，请求仍保留（A16）。
  - 批准路径的正文带 `name_ct` → 422；恢复码路径不带 `name_ct` 时，建一个名字为 null 的设备行。

### 5.4 API

通用约定：
- JSON；`envelope` 与 `bundle` 字段是 JSON **字符串**（原文）。**编码**（N18）：ID、`Sixkey-Sig` 与 `Sixkey-New-Sig` 请求头、以及拼进字符串的字段（T、C、各 AAD）用 base64url；其余字节字段（`head`、`commit`、`nonce`、`transcript_hash`、`sig_pubkey_sha256`、两个校验值、`write_key`、`new_write_key`、`write_proof`、`password_auth`、`recovery_auth`、`epk`（65 字节点）、`sig_pubkey`（SPKI）、K_enroll 密文）用标准 base64。数字只能是安全整数（N20）。带 JSON 正文的操作要求 `Content-Type: application/json`（媒体类型不区分大小写，`;` 两侧可有空白；唯一允许的参数是 `charset=utf-8`（不区分大小写），也可以不带。`charset=utf8`、带引号的值、其他参数、末尾多一个 `;`、`charset = utf-8` 一律 422（M4 清理轮）。客户端一律只发 `Content-Type: application/json`），在读正文之前检查，否则 422 `invalid_request`（M4 S6：网页不能用跨站"简单请求"触发 OTP 邮件或消耗校验次数）。请求体严格：未知成员一律 422；响应可以增加成员，客户端忽略不认识的。
- **时间**（N14）：一律为 Unix 纪元以来的整数毫秒，精度按 C14（小时、天或分钟）；`last_seen_at` 是 UTC 当天零点的毫秒数。
- **请求体上限**（N13，单位一律 MiB/KiB，逐端点）：
  - 9 MiB（9 437 184 字节）：vault 初始化、库写入、密钥轮换这三个端点——它们都带最大 8 MiB 的 envelope；
  - 64 KiB（65 536 字节）：其他所有端点。

- **响应**（N12）：每个 JSON 响应体（包括错误与 202）顶层都有 `server_time`（毫秒）；204 没有正文，客户端改读 `Date` 头。错误体为 `{"error": {"code": "…", …细节}, "server_time": …}`，细节都在 `error` 里：`retry_after`（429）、`version_conflict` 的 `{version, vk_id, kver}`、`enroll_state` 的 `handled_by`。`clock_skew` 只用顶层的 `server_time`（A4）。从不回显用户数据。
- **通用错误码**（N11），在表中各行之外对所有适用的端点成立：401 `session_invalid`（账户会话无效）、401 `bad_signature`、401 `unknown_device`、401 `clock_skew`、403 `device_revoked`（所有设备签名的端点）、404 `not_found`、404 `no_vault`（库与密钥的读取）、409 `too_many_devices`（`complete` 与 `fork`，超过 200 台）、422 `invalid_request`、429 `rate_limited`、500 `internal_error`、503 `unavailable`。表中只写状态码的格子按此读：需要 `pw_auth` 的端点上的 403 是 `password_mismatch` 或 `device_revoked`；410 是 `enroll_gone`；413 是 `too_large`；未知的或别的账户的 rid 一律 410 `enroll_gone`（不泄露是否存在）；不是 respond 那一台的设备来 approve 得到 409 `enroll_state`。恢复码入网也可能得到 409 `device_exists` / `one_per_session`（唯一索引同样覆盖 `via = recovery` 的行）。
- **签名者请求头**（A20）：入网中或设备都可调用的端点上，`Sixkey-Device` 与 `Sixkey-Enroll` 恰好出现一个，且 `Sixkey-Enroll` 必须等于路径里的 rid，否则 `bad_signature`。签名输入里的 `sub` 只在带账户会话的操作上是 JWT `sub`（注册类端点与 `DELETE /v1/account`）。
- **严格 JSON**（A18）：请求体、bundle 与 envelope 中，重复的对象键、任何字符串里的 NUL 字符或孤立代理项一律 422；整数记号规则（N20）也适用于 envelope 原文。
- **`name_ct` 的 VK**（A19）：init、approve、complete、改名、fork 里的 `name_ct.vkId` 必须等于账户当前的 `vk_id`（init 取 envelope 的，轮换取新的），否则 422。
- **正文上限对所有端点都成立**（A9）：没有正文的端点收到的正文同样受 64 KiB 上限（超出 413 `too_large`），并像任何正文一样计入签名输入的哈希。
- `DELETE` 带正文（`/v1/vault/versions`、`/v1/account`）：若中间层丢掉正文，签名里的正文哈希对不上，请求以 `bad_signature` 失败，即失败关闭（N25）。

| 方法与路径 | 认证 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|---|
| `GET /healthz` | 无 | — | `{ok}` | — |
| `POST /v1/auth/otp` | 无（限流） | `{email}` | 202 | 400 `invalid_email`、429 |
| `POST /v1/auth/verify` | 无（限流） | `{email, token}` | `{account_token, expires_at}` | 401 `otp_invalid`（错码/过期不区分）、429 |
| `GET /v1/account` | 账户 | — | `{has_vault, vault_created_at?, device_count?}` | 401 |
| `POST /v1/vault/init` | 账户 + 持钥证明 | `{vault_id, envelope, bundle, recovery_verifier, password_verifier, write_key, device: {device_id, sig_pubkey, name_ct}}` | 201 `{version: 1, kver: 1}`（原文相同的重试 → 同样 201） | 409 `vault_exists` / `device_exists`、413、422 |
| `GET /v1/sync/status` | 设备 | — | `{version, head, vk_id, kver, pending_enrollments, devices_rev, min_client_version}` | 401、403 `device_revoked`、404 `no_vault` |
| `GET /v1/vault` | 设备 | —（不做条件请求，N2） | `{version, envelope}` | — |
| `PUT /v1/vault` | 设备 + 写入证明 | `{if_version, envelope, write_proof, cursor: {cur?, pending}}`（`cur` 在设备第一次写入时没有；两者都是 16 字节标准 base64，N17） | `{version, forked}` | 403 `write_denied` / `device_revoked`、409 `version_conflict {version, vk_id, kver}`、409 `vk_mismatch`、413 `too_large`、422、429 |
| `GET /v1/vault/versions` | 设备 | — | `{versions: [{version, vk_id, size_bytes, created_at}]}` | — |
| `GET /v1/vault/versions/{v}` | 设备 | — | `{version, envelope}` | 404 |
| `DELETE /v1/vault/versions` | 设备 + `pw_auth` | `{password_auth}` | `{deleted: n}`（保留头版本；幂等）（C1，已决 Q5） | 403 |
| `GET /v1/keys` | 设备 | — | `{kver, bundle}` | — |
| `PUT /v1/keys` | 设备 + `pw_auth`（或 `recovery_auth`） | `{if_kver, bundle, password_auth \| recovery_auth, recovery_verifier?, password_verifier?}`（是否必填由 §2.3 一致性规则决定） | `{kver}`（新 kver 须满足 `if_kver < kver ≤ if_kver + KVER_MAX_JUMP`，F-01；已存 bundle 原文与提交的相同 → 幂等 200，N27） | 403 `password_mismatch`、409 `keys_conflict`、422 |
| `POST /v1/keys/rotate` | 设备 + `pw_auth` + 写入证明 | `{if_version, if_kver, envelope, write_proof, new_write_key, bundle, password_auth, recovery_verifier, password_verifier, device_names: [{device_id, name_ct}]}` | `{version, kver}`（kver 规则与幂等同上） | 403、409 `version_conflict` / `keys_conflict`、422 |
| `GET /v1/devices` | 设备 | — | `{current, devices: [{device_id, name_ct, joined_via, approved_by, created_at, last_seen_at, revoked_at, auth_failures}]}` | — |
| `PATCH /v1/devices/{id}` | 设备 + `pw_auth`（含给自己改名，S8） | `{name_ct, password_auth}` | `{}` | 403、404、422 |
| `POST /v1/devices/{id}/revoke` | 设备 + `pw_auth`（含吊销自己，S8） | `{password_auth}` | `{revoked_at}`（幂等） | 403、404 |
| `POST /v1/devices/fork` | 设备 + `pw_auth` + 新公钥的持钥证明（请求头 `Sixkey-New-Sig`，N1） | `{new_device_id, new_sig_pubkey, name_ct, password_auth}` | 201 `{device_id}`（`joined_via=fork`） | 403、409 `device_exists` |
| `POST /v1/enroll/requests` | 账户 + 持钥证明 | `{device_id, sig_pubkey, commit}` | 201 `{request_id, expires_at}` | 404 `no_vault`、409 `device_exists` / `one_per_session` |
| `GET /v1/enroll/requests` | 设备 | — | `{requests: [{request_id, created_at, expires_at, state, handled_by?}]}` | — |
| `GET /v1/enroll/requests/{rid}` | 入网中 或 设备 | — | 新设备视角 `{state, approver_device_id?, approver_epk?, payload?}`；批准方视角 `{state, new_device_id, new_sig_pubkey, commit, new_epk?, new_nonce?, new_name_ct?}`（带问号的字段按状态必有：新设备视角从 responded 起有前两项、approved 时有 payload，批准方视角从 revealed 起有后三项；F-10，§3.2） | 410 `enroll_gone` |
| `POST …/{rid}/respond` | 设备 + `pw_auth` | `{epk, password_auth}` | `{state: "responded"}` | 403、409 `enroll_state`（附 `handled_by`） |
| `POST …/{rid}/reveal` | 入网中 | `{epk, nonce, name_ct}` | `{state: "revealed"}` | 409 `enroll_state` |
| `POST …/{rid}/approve` | 设备（respond 的那一台）+ `pw_auth` | `{transcript_hash, payload, name_ct, sig_pubkey_sha256, password_auth}` | `{state: "approved"}` | 403、409、422 `key_mismatch` |
| `POST …/{rid}/complete` | 入网中（新设备） | `{name_ct?}`（恢复码路径在此提交设备名） | `{device_id}`（此时才建设备行；幂等） | 409 `enroll_state`、410 |
| `POST …/{rid}/reject` | 设备 + `pw_auth`，或入网中的新设备（拒绝自己的请求） | `{password_auth?}` | `{}` | 403 |
| `POST /v1/enroll/reject-all` | 设备 + `pw_auth` | `{password_auth}` | `{rejected: n}` | 403 |
| `POST /v1/enroll/recovery` | 账户 + 持钥证明 | `{device_id, sig_pubkey, recovery_auth}` | `{request_id, vault_id, version, envelope, kver, bundle}` | 403 `recovery_mismatch`、404 `no_vault`、429 |
| `DELETE /v1/account` | 设备 + 账户（`iat` ≤ 10 分钟）+ `pw_auth` | `{password_auth}` | 204 | 401 `step_up_required`、403 |

- **入网的范围**（A14）：`pending_enrollments` = 未过期、状态为 pending 的批准请求。列表显示各个状态的批准请求（respond 之后带 `handled_by`）。恢复码请求从不出现在列表里，也不能被轮询（GET → 410）。`reject-all` 删除本账户所有打开的请求（含恢复码请求，按 §5.2 的时间戳条件），`rejected` 计未过期的那些。
- **入网各步的重试**（A15）：完全相同的 respond（同一批准方、同一 epk）与完全相同的 reveal → 200；值不同 → 409 `enroll_state`。重复的 approve → 409，丢失的 200 由 MUST 8 的轮询补上。
- **拒绝**（A11）：设备一侧在 schema 允许缺省的地方缺少证明 → 403 `password_mismatch`，不计数（没有猜测发生）；其他地方 schema 要求该字段（422）。
- **设备签名的读取上的 404 `no_vault`**（A28）：设备行只与它的库一起存在，所以这些组合不可达，保留作防御。
- **超过 8 MiB 的 envelope**（A8）：先按 UTF-8 字节数检查，回 413 `too_large`，在 schema 校验之前；否则全是 ASCII 的超大 envelope 会先被 `maxLength`（按码点计）判为 422。

已删除：库读取上的条件请求——`If-None-Match` 请求头、`ETag` 响应头与 304（N2：版本号在回滚后会被复用，按版本号做条件请求恰好会把 D5 要发现的情况答成 304；而第 3 步只在 `needPull` 已为真时才取头版本，304 只可能是错误答案）、`devices_changed_at`（由 `devices_rev` 取代，N15）、`POST /v1/auth/refresh`（C1）、`POST /v1/devices/{id}/unlock-sensitive`（F14）、`GET /v1/time`（T3）、`POST /v1/enroll/pause` 与 `423 enroll_paused`（入网暂停整体删除）、`423 sensitive_locked`（S2）、状态查询上的 `Sixkey-Cursor` 头（T2）。

### 5.5 限流（默认值，均可配置；F8、S2）

| 对象 | 限额 |
|---|---|
| 设备认证的操作 | **按设备**：非 GET 请求（所有写操作）30 次/分钟、GET/状态 60 次/分钟（N12）。账户级只设上限 = 单设备的 20 倍。被 401/403 拒绝的请求**不计入**任何额度。带**有效** `pw_auth`/`recovery_auth` 的请求不受按设备限流约束（§3.14），所以只持有副本、不知道密码的人挡不住吊销、轮换与改密钥。它们只受下面"有效证明"一行与账户字节预算约束；知道密码的人本来就能直接吊销真设备 |
| 有效证明的请求（M4 选定，S2） | **按账户** 60 次/60 秒，含吊销与轮换；无效证明不进入这个桶，它们在自己的小桶里就被挡下 |
| 请求正文字节（"envelope 字节"；M4 选定，S2、S4、RR1） | 三个预算都按**整个请求正文**的字节数计，正文无法解析（422、413）时也算，不只算 envelope 原文：解析失败的正文没有 envelope 可量，而两者只差 bundle 与证明，远小于 1 MiB。**按设备** 256 MiB/小时：`PUT /v1/vault` 与轮换中不带有效证明的请求都算，失败的也算，不退还；有效证明的请求（主人的轮换）不受它约束，所以没有密码的副本挤不掉轮换。**按账户** 1 GiB/小时：`PUT /v1/vault` 与轮换的每个请求都算，401/403 退还。**按账户会话** 1 GiB/小时（`session_envelope_bytes`）：只有 init，解析与否都算，401/403 退还；init 不计入设备与账户的预算——那时还没有设备行，正文里的设备 ID 可以每次都换；而会话只需要邮箱，若计入账户预算，只控制邮箱的人就能用失败的 init 耗尽本账户设备写入要用的预算（§1.2 A2）。轮换、吊销、其他带 `pw_auth` 的操作与注册类操作，正文无法解析时照样付所有适用的桶：这样的正文不带有效证明 |
| 大正文与超时（M4 选定，S3） | 三个 9 MiB 端点同时至多处理 8 个请求，等槽位至多 10 秒，否则 503；读取一个正文至多 60 秒，否则 503；uvicorn `limit_concurrency` 256（超出时直接 503）、keep-alive 5 秒；连接池取连接至多等 5 秒，否则 503（S10） |
| 限流表（M4 选定，S5、RR3） | 每张表至多 200 000 个键，满了以后新键 429 `rate_limited` + `Retry-After: 60`。OTP 每码计数表满、而这个邮箱还没有计数时也一样：`verify` 答 429，不询问 provider。IP 与邮箱的键和设备的键共用一张表，大量廉价的 IP 键可能挤掉设备的限流状态（RR3b，残余；M8 第 13 项：多实例或实际出现时换成按族设上限的 Redis） |
| `pw_auth` / `recovery_auth` 失败 | 只按设备计数（封顶 10），用于"多次输错主密码"横幅；**不锁定、不退避**（理由见 §3.14）。无效证明另有每设备 10 次/分钟的内存小桶，超出即以 429 `rate_limited` + `Retry-After` 拒绝且不写库（A10）；有效证明不受它影响 |
| 带账户会话的操作（A21） | `GET /v1/account`、init、发起入网：每个账户会话写 30 次/分钟、读 60 次/分钟。入网中的设备像一台以 `enroll:{rid}` 为键的设备那样限流。**决定（修订 18）：入网中的设备不计入账户上限**（`account_reads`、`account_writes`），由它自己的按 rid 限额、每会话 1 个待处理请求与 OTP 发送上限约束。理由同 init 不计入账户字节预算：只控制邮箱的人开约 20 个会话、各以上限轮询，就会填满 `account_reads`（1200/分钟），让主人设备的状态查询得到 429（§1.2 A2）。代价只是服务器负载，而会话数又受每邮箱每天 50 次 OTP 发送的约束。**M4 尚未实现**，契约改动见 §0.0r |
| 写入证明失败 | 只拒绝该请求（`403 write_denied`），不计入额度、不暂停设备 |
| 入网请求 | 每个账户会话最多 1 个待处理；每个请求 10 分钟后过期；已入网设备可"拒绝全部" |
| OTP 发送 | 每（邮箱, IP-HMAC）3 次/10 分钟、10 次/天；每邮箱全局 50 次/天（足够高，陌生人难以把主人锁在门外）；每 IP-HMAC 20 次/小时 |
| OTP 校验（RR6：这两行可被未经认证的第三方填满，针对某个邮箱拒绝服务最长约 24 小时，Phase 1 接受，§1.2 A11） | 每邮箱（HMAC）5 次错误之后，在发送新码之前该邮箱的校验一律 `otp_invalid`（A22）；次数在等待 provider **之前**占用（S1）；格式错误的邮箱也是 `otp_invalid`；每 IP-HMAC 30 次/小时 |
| 恢复码入网 | 每（账户, IP-HMAC）5 次/小时；每账户全局 50 次/天 |
| 设备数 | 每账户 ≤200 个未吊销设备（可调） |

不做的（M4 修复轮）：
- **按设备的 `bad_signature` 桶**（S4）：任何只知道设备 ID 的人都能把它填满，把真设备挡在它自己的写入之外。坏签名只花服务器一次验签，9 MiB 的正文再占一个槽位（S3）。
- **把 ±300 s 窗口检查移到读正文之前**（S3）：设计的错误顺序（P6：验签 → 已吊销 → 窗口）决定了一个有多种错误的请求得到哪一个，移动它会改变这个结果。残余：知道一个设备 ID 的人（账户里每台设备都在 `GET /v1/devices` 里看得到）能让服务器每个请求读最多 9 MiB、然后以 `bad_signature` 失败；由 8 个槽位（共 72 MiB）、正文超时以及 M8 时代理的大小与超时限住（§10 第 95 条）。
- **槽位是全进程共用的一个池，而且在验签之前就占用**（RR2，记录的残余）：
  - 一个身份就能让所有账户的大写入（PUT、init、轮换）得到 503。持有槽位只需要一个已知的设备 ID，init 则只需要一个 OTP 会话。
  - 每个请求最多占 60 秒，但 8 个连接轮流占用可以一直占满。
  - 应用内能做的是按来源分配槽位；真正限住它的是 M8 代理的按 IP 连接上限与读取超时（§9 M8 清单第 10 项）。

IP 的计数单位：IPv4 地址，或 IPv6 的 /64；IPv4 映射的 IPv6 按 IPv4 计（M4 S5）。计数窗口：按 IP-HMAC 的 ≤1 小时；按邮箱/账户的天级计数以 `HMAC(当日密钥, 邮箱或账户)` 为键、≤24 小时；都只在内存中（§5.1）。

### 5.6 日志与 IP（D3、D5）

- 应用日志字段只有：时间（**到秒**，T3）、随机 request_id、**路由模板**、方法、状态码、耗时、错误码。常规日志不含 user_id / device_id；5xx 时附 `ref = HMAC(当日密钥, user_id)` 前 8 字符。
- 永不记录：IP、UA、任何请求头的值、请求/响应体、token、签名、邮箱、OTP、envelope、bundle、校验值、cursor。uvicorn 关闭 access log。日志保留 14 天。
- **数据库错误**（P7）：Postgres 的约束错误会在 `DETAIL` 里带出整行数据。对策：写库前在应用层校验全部字段；驱动异常只映射为错误码，**从不记录异常原文**；Supabase 项目设 `log_error_verbosity = terse`、不记录语句参数（M8 由所有者设置并核对）。预期的唯一冲突用 `INSERT … ON CONFLICT DO NOTHING RETURNING` 判定，Postgres 日志里不再有这类 ERROR（M4 S8）。残余：init 或发起入网用的是 15 分钟内被删除的 auth 用户的 token 时，外键冲突仍会在 Postgres 日志里留一条 ERROR（答 `session_invalid`）；terse 日志下它不带 DETAIL。
- IP 只在内存里用于限流：键 = HMAC-SHA256(进程内每 UTC 日随机生成、从不落盘的密钥, IP)，计数 TTL ≤1 小时。只信任已知代理地址发来的唯一一个转发头。
- 不向 Supabase 转发客户端 IP（已决 Q1）；Supabase 端按 IP 的 OTP 限额相应调高。Supabase 仍会保存邮箱和认证审计事件（含我们服务器的 IP），隐私政策中披露。
- 托管平台/CDN/负载均衡的访问日志必须关闭或不记录客户端 IP（托管商待所有者选定，§12）。
- 数据库里没有任何 IP 列；状态轮询不写数据库（T2），WAL / PITR 里因此也没有每台设备的轮询时间序列。

### 5.7 删除账户（F12）

`DELETE /v1/account` 校验通过后，只做一件事：调用 Supabase admin API 删除 auth 用户（硬删除）。外键级联（§5.3）在同一个数据库操作里清空全部行。失败时什么都没删：与写入并发造成的死锁或串行化冲突返回 503 `unavailable` + `Retry-After`（服务器先自己重试一次删除，S7），客户端按 `Retry-After` 原样重试。M8 时级联在 GoTrue 里运行，它的 500 也这样映射。其他设备下次请求得到 `401 unknown_device` → 按 §3.10 停止同步、保留本地数据。Supabase 备份（PITR / 每日备份）中的数据会保留到备份窗口结束，隐私政策披露。

### 5.8 版本保留与配额

- 保留最近 30 个版本 + 最近 30 天内每个 UTC 日的最后一个版本："最近 30 天"= 今天与之前的 29 个 UTC 日（A24）；在 PUT 的同一事务里做有界清理（或每日任务，它锁 vault 行）。版本时间为小时精度。历史包含 init 写入的版本 1。
- 每账户历史总量上限 64 MiB（超出时从最旧的、非"每日最后一版"开始删；只剩每日最后一版时再从最旧的删；头版本永不删，A24）。
- "清除服务器历史"（已决 Q5，C1）：`DELETE /v1/vault/versions` 删除头版本以外的全部历史，需要 `pw_auth`——服务器历史是 §4.4 两步删除的兜底，不能让只持有设备凭据的人抹掉。
- 历史版本可能是旧 VK 加密的：客户端用 keyring.previous 打开；版本历史只用于"找回账户"，不做整体替换。

---

## 6. 扩展 UX（屏幕与状态清单）

沿用现有设计系统（Brass dial：钢灰中性色 + 唯一黄铜强调色，数字用 Martian Mono，横幅/对话框/状态卡组件已存在）。所有文字走 i18n（en + zh_CN）。**入网、批准、吊销都在设置页标签页里完成**。所有 6 位数字（OTP、SAS）共用一个 6 格输入组件；28 个字符的码（恢复码、配对码）共用一个 7 组输入组件（自动分组、O/I/L 容错）。所有需要 `pw_auth` 的操作都先要求输入主密码。
- **锁定结束一切打开的流程**（修订 24）：
  - 无论锁定来自哪里（popup 的锁定、SW 的闲置或锁屏、另一个页面），一个打开的流程都立即结束：主密码、恢复码、屏幕上的新码与准备好的入网都丢弃，批准请求放弃，权限按 §7 归还。
  - 正在进行的写入先完成，流程报告它的结果：锁定之前刚写下的新码，就说它已生效。
  - 服务层另有自己的锁定检查（§3.1 第 4 步 (b)、§3.5）。
- **可以当场改正的错误不结束流程**（修订 24，M6 偏离第 3 条）：密码、一次性验证码或恢复码输错、格式不对、登录过期。流程与权限都保持打开，重输一个码不会让 Chrome 的权限弹窗再出现。清单写在实现里（`model.ts FIXABLE`）。锁定不在其中，它结束流程。唯一的例外是入网警告卡：用户选择入网方式时页面已经锁着，它说"请先解锁"并保持打开，此时什么都还没发送。

**Popup**
| # | 屏幕 / 状态 | 内容 |
|---|---|---|
| P1 | 同步指示（页头右侧小刻度） | 关闭：不显示。已同步：黄铜实心 + 悬停显示时间。同步中：刻度转动。离线 · 有改动待同步：灰。需要处理：warn。已暂停：danger。点击 → 设置页 `#sync`。 |
| P2 | 锁定页附加一行 | 修订 25（M6 §13.5 第 1 条）。popup 不带同步代码，取不了服务器的密钥，所以新密码要等同步一节采用之后才能打开本机。这一行只在**解锁失败之后**出现：那时它才在解释什么，成功的解锁也不必为它多读一次。它读一条记录，不显示任何秘密，链接到设置页。两种措辞："密钥已在另一台设备修改：请用本机上次使用的密码解锁，再到 设置 › 同步 输入当前的密码"；"本机的一次改动尚未确认：请在 设置 › 同步 用在那里设置的密码解锁"。前一种在单纯打错时也会出现，无害，那时它也是对的。 |
| P3 | 欢迎页新增选项 | "加入我已同步的保险库" → 设置页 `#sync/join`。 |
| P4 | 横幅（复用现有组件） | 新设备已加入（注明方式，恢复码方式用 warn 色）· 恢复码已在 X 上更换 / 本机生成的恢复码已生效或未生效 · 设备 X 多次输错主密码（danger，附"吊销并保护"）· 有设备等待批准 · 另一台设备删除了 N 个账户（［查看］［找回］；24 小时内先删后清时用 danger 色）· 同步变更需要你确认 · 时钟偏差（附"用校正后的时间生成验证码"开关，§4.14）。 |
| P5 | HOTP 离线提示 | 生成 HOTP 时离线的一行提示（§4.12）。 |

**popup 不放同步屏幕**（修订 24，M6 偏离第 1 条）：popup 的预算是 60 KB，开闸后的实测已是 58.3 KB，所以 P1–P5 的内容放在设置页的同步一节：
- P1 → 侧栏的同步状态行；
- P3 → 首次运行向导里的"加入已同步的保险库"（popup 的"开始使用"会打开它）；
- P4 → 同步一节卡片上的通知与待批准一行；
- 工具栏角标照常计数，并用文字说明（§3.11）。

P2（锁定页的"主密码已在另一台设备修改"一行）是**开闸前必须完成**的项（§9 M8 清单第 17 项）：没有它，别处改了密码之后，在 popup 解锁会失败而没有任何说明。P5 等第二阶段的模块拆分给 popup 腾出空间之后再做（§7）。

**设置页**：侧栏新增"同步"一节（在"安全"之后）；侧栏状态卡已有的"同步"一行改为显示状态和最后同步时间。
| # | 屏幕 / 状态 | 内容 |
|---|---|---|
| O1 | 同步关闭卡片 | 一句话说明 + 可展开的"服务器能看到什么" + 前置条件（主密码 ✓/✗）+ "会被厂商同步或与他人共享的配置文件不要开启同步"的提示 + ［开启同步］［加入已有保险库］。点按钮时立即弹出 Chrome 的权限请求（"读取和更改你在 api.sixkey.app 上的数据"），卡片事先说明为什么需要、关闭同步时会移除（§3.1，修订 21）。 |
| O2 | 邮箱登录 | 邮箱 → 6 格 OTP + 重新发送倒计时；错误：验证码无效、太频繁（显示等待时间）、网络。 |
| O3 | 首台开启 | 输入主密码 → 邮箱验证码 → 账户检查（已有库 → 转入入网）→ 设备命名（输入框提示"1–40 个字符；不能包含控制字符、双向控制字符或零宽字符——组合表情（如 👩&#x200D;💻）里的连接符也算零宽字符，请改用单个表情或文字"，N28；入网与改名用同一提示）→ 恢复码：输入现有 / 生成新码（展示 → 回填两组确认）→ 上传进度（结果不明时"正在确认…"，不提示失败）→ 完成；确认是别人的库时的"刚才的恢复密钥对已有同步库无效"说明。 |
| O4 | 已有保险库 | 警告卡（建立日期、设备数）+［用另一台设备批准］［使用恢复码］。 |
| O5 | 新设备：输入配对码，再显示 SAS | 步骤指引 →（A 选中请求、显示配对码之后）"输入批准设备上显示的配对码"（7 组输入，可粘贴；格式或校验位不对只提示、不算次数）→ 表盘中央大字 SAS"123 456"→ 状态行（等待响应 / 等待对方输入）→ 外圈刻度做 10 分钟倒计时 →［取消］。 |
| O6 | 新设备：完成加入 | （修订 27：不再输入确认码）批准之后新设备用配对码解开载荷 → 共享警告（§3.5）→ 本机已有账户时的导入摘要（加入 k 个，跳过 d 个重复）→［继续］。 |
| O7 | 恢复码入网 | 7 组 4 位输入（自动分组、O/I/L 容错）→ 成功后两张后续卡：生成新恢复码（推荐）、设置新主密码。 |
| O8 | 设备列表 | 每行：设备名、"本机"标记、加入方式与日期（含"从 X 分出"）、最后同步（天）、已吊销灰显、"多次输错主密码"标记、"90 天未同步"提示；行操作：改名、吊销（都要主密码）。顶部：已登录邮箱（锁定时只显示"已登录"）、［批准新设备］、有待处理请求时［拒绝全部］、［在此设备上关闭同步］（要主密码）。锁定时名称显示占位。 |
| O9 | 批准 | 输入主密码 → 待处理请求列表（发起时间；多于一个时警告"只批准你此刻正在设置的那一个"；"已由设备 X 处理"）→ 选中 → 大字显示配对码（7 组，附［复制］）"在新设备上输入这个配对码"→ 新设备显示 SAS 后，6 格输入 SAS + "自称：X"（配对码不符时提示"配对码不符，请重新开始"）→ 成功后"已批准"/ 失败（3 次作废）；［拒绝］。防诈骗文案（两块屏幕上都有）："这两个码只在你自己的两台设备之间抄写；任何人让你输入或告诉他这些码都是诈骗。" |
| O10 | 吊销 | 密码 → 原因二选一（不预选；该设备写过当前 KeyBundle 则只能选"保护"）→ 附带列出由它批准的设备（默认勾选）→ "丢失/被盗"路径：轮换说明 → 新恢复码展示与确认 → 可选改密码 → 完成清单。 |
| O11 | 安全区的同步感知 | 改密码 / 新恢复码 / 轮换要求在线；改密码对话框的"担心旧密码泄露：同时轮换密钥"勾选项；结果未确认时的"新旧恢复密钥都先保留"说明；409 文案按对账结果区分本机/他机；"验证恢复密钥"；bundle 含未知字段时"请更新 Sixkey 后再修改密钥"。 |
| O12 | 同步状态 / 错误面板（一个组件按状态切换） | 离线 · 需要密码 · 需要确认（阻塞项列表 +［应用］［保留我的］）· 服务器数据比本机旧（一次性告警）· 云端最新版本无法解密（`remote_unreadable`）· 服务器的密钥状态比本机旧（`keys_behind`：说明"可能是服务器恢复了备份，也可能是另一台设备落后"，唯一按钮［以本机为准修复云端］；改密码、换恢复码、轮换、批准在修复前不可用，吊销等照常，N27）· 需要更新 Sixkey · 库过大（清理指引：删除与永久删除始终可用）· 本机库与云端不同（［以云端为准重新加入］）· 加入未完成（［重新加入］）· 服务器拒绝本设备（［重试］［移除同步身份］，并说明"需要抹掉时卸载扩展；厂商云端副本不会因此消失"）· 同步身份丢失（`identity_missing`：说明原因，锁定时"解锁以恢复"，解锁后自动恢复并提示一次）· 此副本过旧（`update_required`，附商店链接；商店 ID 存在之前不放链接，说明 Chrome 会自己更新、可在 chrome://extensions 里点"更新"。check-dist 不允许脚本里出现 API origin 以外的 URL，链接是开闸前必须完成的项，§9 M8 第 17 项；修订 24）· 疑似复制的配置文件（`forked`，［为本配置文件建立独立身份］［吊销并保护］）· 时钟偏差 · 同步已暂停：访问 api.sixkey.app 的权限已被移除（`permission_removed`，［重新授权］只在同步设置页，修订 21）· 本机库无法读取（`vault_lost`：［从云端恢复］［从备份恢复］，R3R-3）· 本机有暂时读不了的保存（搁置的孤儿条目：说明原因与出路——更新 Sixkey，或用新主密码解锁；"高级"里可在确认后删除，R3R-4）。 |
| O13 | 找回账户 | 修订 26（M6C）。同步一节的一个框（页面须已解锁），也是"另一台设备删除了账户"通知上的［找回］。点击时先请求 API 权限，拒绝则什么都不读。**来源**：服务器历史，最新的在前、小时精度、至多 64 个版本，只列本机持有密钥的版本（当前 VK，或 previous 真能解开的 VK）；用旧密钥的版本标为"较旧的密钥"，因为当时持有它的任何人、包括之后被吊销的设备，都可能在服务器帮助下写过它。另加本机快照（rolling 与 daily，含入网时重新加密、保留旧库 id 的旧快照，§3.5 ⑥）。历史读不到时如实说明，本机列表照常。**打开一个版本**：只用本机持有的密钥打开，核对 vaultId，按不可信数据解析；列出当时存活、现在不存活的账户（既不按 id，也不按 identity + issuer + label 存活），每个一次，只显示 issuer 与 label；与某个存活账户相似的行注明"它的密钥现在在库里，名字不同"（找回会多一份）或"现在库里有同名账户，密钥不同"（密钥已被替换）。离开引擎的只有这些标记，从不含秘密。打不开的版本（别的密钥、损坏、已不在、较新的记录格式）如实说明；较新 schema 的提示更新 Sixkey；另一个库的服务器版本不用。**找回**：勾选后用一次普通的本地编辑（开库检查、同步开启时的大小检查、outbox），在编辑内按当时的库再检查一次（其间又存活的不动）。规则见 §4.6。版本的任何内容都不原样发出，也不自动合并；只有这次编辑自己的上传会离开本机。`sk_prejoin` 不是来源（§3.5 ④）。没有"全选"。 |
| O14 | 危险区 / 高级 | 删除同步账户（OTP 二次确认 + 主密码；说明本地数据保留）；清除服务器历史（主密码；已决 Q5）；"入网前的本机数据"（`sk_prejoin`）。 |

**Phase 0.x 加固涉及的界面**（§9.1；零网络，与同步无关，同步开启前就生效）
| # | 屏幕 / 状态 | 内容 |
|---|---|---|
| Z1 | 首次运行与恢复（H1，已决） | 欢迎页去掉"不设密码直接开始"；"开始"与"从备份恢复"都**先**要求设主密码，再显示并确认恢复码，然后才写入任何东西（从不写设备包裹）。已有的设备密钥库照常使用，但侧栏状态卡持续警告并提供"现在设置主密码"。 |
| Z2 | 首次运行的风险提问（H5） | "这个配置文件会被他人使用、同步到厂商云，或由脚本/自动化工具控制吗？"选"是"→ 预设"每次都锁定"，并引导去设置页开启剪贴板自动清空；附一句为什么（A10），以及"这样的配置文件不要开启同步"。可随时在设置里改。 |
| Z3 | 导出（H2、H3） | 导出前一律重新输入主密码（明文导出与加密备份都是）。新增"导出所选账户"：按分组或勾选账户，生成标准 `sixkey-backup` 文件（总是新的 vaultId、新的条目 id 与时间戳），说明"适合放进共享或厂商云配置文件：对方只会得到这几个账户"。 |
| Z4 | 安全状态卡（H6） | 设置页一张卡：上次以来输错主密码 N 次（解锁后提示一次）、最近的导出 / 改密码 / 轮换记录；"本机存了什么"清单（是否有设备密钥、快照数、镜像状态、上次备份、网络请求 = 0 或"仅同步服务器"）。数据来自独立的 `sk_security_log`，与"数据已恢复"横幅互不影响。 |
| Z5 | 安装来源提示（H4） | 扩展 ID 不是商店 ID，或 `installType` 不是 `normal`/`admin` 时，持续横幅"此副本不是从 Chrome 应用商店安装，不会自动更新"，并显示本副本的扩展 ID 供用户与官网核对。dev/e2e 构建关闭。 |
| Z6 | 纯文本密钥行导入（H7） | 添加账户页接受 `名称\|密钥` 和裸 base32 行；预览表让用户确认哪一列是密钥；其他列（例如密码）一律丢弃并明说"不会保存"。 |

---

## 7. Manifest / CSP / check-dist / 文档变更

**manifest.base.json**
- 新增 `"optional_host_permissions": ["https://api.sixkey.app/*"]`（修订 21，原为必需的 `host_permissions`）。
  - 在开启同步或加入已有保险库的那次点击里，由设置页 `chrome.permissions.request` 请求（§3.1）。
  - 关闭同步或移除同步身份时 `chrome.permissions.remove`（§3.10）。
  - **首次上传与入网的每一种结果都移除它，除了 `done` 与 `unconfirmed`**（修订 23）。
    - 这包括作为结果而不是异常返回的 `vault_exists` 与 `keyring_changed`，以及失败与取消。
    - `unconfirmed` 保留，因为结果待对账（§3.1 D4）。
    - **"结果"指流程的结束**（修订 24）：上传或入网的结果、结束流程的失败、Sixkey 的锁定、用户离开（取消、同步一节消失、页面关闭；浏览器启动时的回收兜底）。§6 列出的可当场改正的错误不是结果：流程与权限都保持打开。
  - **不变式（修订 24）：同步开启 ⇒ 持有权限，或用户自己撤销了它。**
    - 写入进行中（首次上传、新恢复码、入网的"继续"）什么都不归还权限：这时不提供取消；同步一节消失、页面关闭与锁定都等写入结束，因为结果可能是同步已开启。
    - 页面关闭时，在任何 `await` 之前，只立即归还流程为自己持有、且它启动的任何东西都不再需要的权限；其余交给浏览器启动时的回收。
    - 一个流程被另一个取代时（入网发现没有库、转为开启），权限留给新流程。
    - 关闭同步因守卫复核而停下时，复核打开期间保留它那次点击授予的权限，因为回答之后的吊销要用。复核以其他方式关闭（被关掉、锁定、标签页隐藏、页面关闭）时，**只归还**那次关闭点击重新授予的权限，即之前已被用户撤销、为关闭同步才重新请求的那一份。关闭之前本来就持有的权限不归还，同步仍是开启的。标签页中途关闭时，下一次浏览器启动（`runtime.onStartup`）发现"有权限而没有 `sk_sync_cfg`"就移除。
  - 理由：
    - 从不开启同步的用户永远没有 host 权限；
    - 安装时没有警告；
    - 更新到带同步的版本不会让 Chrome 停用已有的安装（新增**必需**的 host 权限会让每个已有安装停用，直到用户接受）；
    - 用户同意的时刻是明确的：就在开启同步时。
  - 可选的 `nativeMessaging`（若将来做）也是这种用法。
- CSP 中 `connect-src 'none'` → `connect-src https://api.sixkey.app`，其余不变。CSP 不是权限：即使授权了，SW 要连这个 origin，manifest 的 `connect-src` 也必须列出它（M5 已验证：把它改回 `'none'` 时，有 host 权限的 SW 也被拦）。
- **每个扩展页面另带 `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`**（修订 21，M-1）：`popup`、`options`、`offscreen`、`devsync` 的 HTML，放在第一个 `<script>` 之前。
  - 浏览器同时执行页面上的每一份策略：一个请求必须满足 manifest 的策略**与**页面的策略，效果是交集，所以页面连不上任何地方。
  - `<meta>` 策略只约束它之后加载的内容，所以必须在任何脚本之前。
  - `connect-src` 可以用 `<meta>` 下发（`frame-ancestors`、`sandbox`、报告类指令不行）。
  - SW 没有文档，不受它约束，所以只有 SW 能连 API。M5 评审在 Chromium 里验证过：页面被拦，SW 与消息桥照常。
  - 导航类的外泄（`location`、`window.open`）不归 `connect-src` 管，Phase 0 起就是这样，不是这次的回退。
- 不新增任何 permission。
- `build.mjs` 的 overlay 合并是浅合并：`manifest.dev.json` 与 `manifest.e2e.json` 必须完整重写 `content_security_policy` 和 host 权限键。dev 用开发域名；e2e 用固定端口 `http://127.0.0.1:8787`。
  - e2e 构建把它的 origin 声明为**必需**的 `host_permissions`，因为自动化测试能否点掉 Chrome 的权限弹窗未核实。请求、移除与 `onRemoved` 的逻辑由单元测试（替身 `chrome.permissions`）覆盖；真实弹窗是一项人工检查（OWNER-DECISIONS/12）。
  - dev 构建用可选权限，便于人工走一遍弹窗。
- API origin 在构建时注入（Vite `define`），构建脚本断言它与 manifest 的 host 权限（prod/dev 为 `optional_host_permissions`，e2e 为 `host_permissions`）一致。

**scripts/check-dist.mjs**
- **prod**（修订 21）：
  - `EXPECTED_CSP` 是精确的新字符串；
  - `optional_host_permissions` 恰好等于 `["https://api.sixkey.app/*"]`；
  - **不得有** `host_permissions`；
  - 仍禁止 `content_scripts`、`externally_connectable`，`permissions` 列表不变（`chrome.permissions` API 不需要声明）；
  - 每个发布的 HTML 页面在第一个 `<script>` 之前带上述精确的 `<meta>` `connect-src 'none'`（M-1；篡改用例：删掉它、或放到脚本之后 → 失败）。
- **原来"禁止 `optional_host_permissions`"的规则为什么存在**：Phase 0 起，它让 manifest 成为网络可达范围唯一、静态的声明，代码不能在运行时请求 manifest 上看不见的 origin。它也把 OWNER-DECISIONS/08 的 (b)（用户输入服务器地址，需要宽泛的可选 host 权限）挡在门外，直到所有者决定。
- **改为**：可选 host 权限只许是**该构建风味**列出的那几个精确 origin。商店风味恰好一个。将来的自托管风味：(a) 单独构建，列出它自己的 origin；(b) 用户输入地址，需要一个更宽的可选模式。到时由 check-dist 断言那个风味的精确值，现在不决定。
- `DEV_MARKERS` 的扫描从 manifest 扩展到所有发布的 JS 与 HTML。
- **popup 的预算与第二阶段的模块拆分**（修订 24）：
  - popup 的预算 60 KB（check-dist 执行）。开闸后实测 58.3 KB：popup 已经导入的五个模块，同步一节也在用，打包器按模块共享，把它们更多的导出带进了 popup 的块。这五个模块是 `core/sync/crypto/keybundle.ts`、`encoding.ts`、`subkeys.ts`、`core/sync/local/outbox.ts`、`state.ts`。
  - **要求**：M6 第二阶段的第一个改动，是把这五个模块里只有引擎用的部分移到各自的模块。补救在源码里，打包器不能把一个模块拆到两个块。同时加一个测试，保证这些只有引擎用的部分不进 popup 的模块图。之后第二阶段才能给它们增加新的使用者。
  - 一个让开闸后的 popup 超出预算的改动，会让 `m6-gate` 测试失败。
- 网络原语绊线：`XMLHttpRequest`/`WebSocket`/`EventSource`/`sendBeacon` 仍全部禁止；`fetch(` 只允许出现在 `sw.js`。
- JS 中每个 `http(s)://` 字面量必须是 API origin 或在极小的白名单里（如 SVG 命名空间）。
- `--dev` / `--e2e` 变体各自断言自己的 origin（dev 为可选，e2e 为必需），以及同样的页面 `<meta>`。

**test/regression/network.spec.ts 改写为"只允许 API origin"**
1. 固定端口 8787 的模拟 API + 随机端口的诱饵服务器。
2. 同步关闭时完整使用扩展 → 模拟 API **收到零请求**。
3. popup、设置页、SW 向诱饵发 fetch / img / XHR / WebSocket / beacon → 全部被拦。
4. SW 向 API origin 的 fetch 成功；页面向 API origin 的 fetch 与 img 都被拦（页面 `<meta>`，修订 21）。
5. 开启同步后，模拟 API 收到的每个请求都带有效设备签名，写请求都带有效写入证明。
6. （单元测试，替身 `chrome.permissions`）权限被移除 → `permission_removed`，零请求、退避不变、outbox 与孤儿列表不变；重新授权 → 下一轮照常；关闭同步、移除身份、开启流程失败或取消时移除权限；浏览器启动时"有权限而没有 `sk_sync_cfg`"被移除。

**文档**（评审 F13 与调研指出的错误表述，计划文本已改正）
- `PRIVACY.md` 重写为 Phase 1 版本：
  - 只有开启同步、并在弹出的权限请求里授权之后才有网络（修订 21）；可以随时在 chrome://extensions 里撤销，同步随即暂停、不再联网，本机数据不会丢失；关闭同步时 Sixkey 自己移除这个权限；发送哪些数据（邮箱；加密库及最多 30 个版本 / 30 天，**版本时间只到小时**；KeyBundle（其中时间只到小时）；两个校验值；`K_write`；设备记录：随机 ID、加密且定长的设备名、加入方式、加入与吊销时间（小时）、最后同步日期；入网请求最长 10 分钟）；
  - 不存 IP（仅在内存中以 HMAC 形式用于限流，≤1 小时）、不收集 UA、无指纹、无分析；状态轮询不留记录；子处理者（Supabase、SMTP 服务商、托管商）；
  - 请求验证码时，Supabase 会为该邮箱建一个未确认的账户记录；24 小时内未完成验证的，每天删除；
  - **永久删除**：发起删除的设备立即从它的全部副本清除；**其他设备**上，被删条目会留在每日快照最多 7 天、留在最近 10 次改动快照里直到该设备之后再改动 10 次（很少改动的设备可能长期保留）；服务器历史最多 30 天（可用"清除服务器历史"提前删除）；服务商备份窗口内仍在；
  - **改主密码**：旧密码保护的密钥副本会留在服务商备份里直到备份窗口结束；若担心旧密码泄露，请同时轮换密钥；
  - 删除账户与服务商备份窗口；服务器理论上可以尝试猜测弱密码，所以同步的改密码有 50 bit 强度要求（本地设的主密码低于 50 bit 只警告：上线同步前须先有设备持有的账户密钥，OWNER-DECISIONS/15）；
  - **改正（调研）**：现行"removing the extension deletes all its stored data"改为："卸载扩展会删除它在**这个**配置文件里的数据。如果你的浏览器（包括指纹浏览器）把配置文件同步到云端、复制或导出过，那些副本里的 Sixkey 数据不会因卸载而消失——它们仍受主密码保护（未设主密码的旧库则只有基础加密）。"
- `docs/security/local-vault.md` 的"Limits"一节，**改正（调研）**：现行把 IndexedDB 镜像描述为挡住"单个库被删/被修"的第二份副本。补充："在部分指纹浏览器里（例如 GoLogin 的 SDK 每次停止都删除 IndexedDB，AdsPower、BitBrowser 默认不同步 IndexedDB），镜像要么每次启动都是空的，要么不会跟着配置文件走，此时它不是独立副本；真正离开这个配置文件的副本只有导出的备份文件（以及开启同步后的云端）。"
- 新文档 `docs/guides/FINGERPRINT-BROWSERS.md`（《在指纹浏览器中使用 Sixkey》，§9.1 H8）：厂商云同步、克隆、共享、转移、本地 API/CDP 各意味着什么；只通过商店链接安装并核对扩展 ID；转移配置文件前先卸载 Sixkey；**加入同步的配置文件绝不能被厂商同步或共享**（副本 + 主密码 = 隐形同步设备）；共享配置文件只放"导出所选账户"的子集；被脚本控制的配置文件用"每次都锁定"、不开同步；未设主密码的设备密钥模式在这些环境里等于把种子交给厂商与团队。另含一节《AI 代理与自动化》（所有者 2026-10-16，MCP 调研 Q3）：① 为什么 Sixkey 不把验证码、种子或账户列表交给模型或代理（§13：第二因素交给会读不可信内容的代理就不再是第二因素）；② 被代理或脚本驱动的配置文件就是 A10——用"每次都锁定"（或"共享·自动化"预设）、不开同步，真实账户放在不受代理控制的**另一个配置文件**里；③ 自动化测试用**测试账号**，把它的种子放进 CI 的密钥库或环境变量，用 otpauth / otplib 现场算码，不要把真实账户的 2FA 交给脚本；④ 代理走到 2FA 时停下、由人**手动接管**：自己点 Sixkey 图标、复制验证码、在页面里输入，不要把验证码贴进对话。设置页与商店说明链接到它。
- `docs/security/local-vault.md`：
  - 网络边界（修订 21）：
    - API 的 host 权限是可选的，开启同步时才授予；
    - 没有授权时，诚实的代码什么都不发：引擎与 SW 的传输层在每个请求之前都检查权限。
    - 跳过检查的代码（被攻破的扩展代码）仍能发出 CORS 简单请求，并且**整个送达**（M5 第二版实测：没有授权时，一个正文为 `text/plain` 的 `no-cors` POST 原样到达服务器）；只有带引擎请求头的请求会被缩减为预检。这样的请求不带账户会话、不带签名；生产环境的服务器不返回 CORS（§5.2），所以它也读不到任何响应。修订 23 更正了原来"至多一个空预检"的说法。
    - 每个页面带 `connect-src 'none'`，只有 SW 能连 API。
    - 暂停（`permission_removed`）时不发任何网络请求，本机只做 §4.9 列出的不联网维护。
  - 威胁表补 A10（调试端口，含被 AI 代理或自动化工具驱动的配置文件）；新增"Phase 1 同步"一节（§1.2 威胁表、§2–3 密码学细节、§10 残余：恶意服务器下设备列表、吊销、`pw_auth`、写入证明都只是建议性的；持 VK 者可伪造 KeyBundle MAC；配置文件副本 + 主密码 = 隐形同步凭据；数据库泄露 + 副本可写入；抢注与社会工程；`pw_auth` 是固定值；克隆配置文件；降级到 Phase 0 构建时 >5000 条的库不可读；在同一 vaultId 上用 `restoreBackup` 覆盖丢失的设备密钥库后，旧库快照在轮换出局之前仍能被持有旧设备密钥的人打开——GM2-4、A2-4；窗口内重放的六种残余及不加 nonce 缓存的理由，写法见 §5.2；"采用回来"只信任 IndexedDB 的残余，写法见 §1.3（攻击者需要单独回退的 IndexedDB 与对服务器 bundle 的控制或重放；后果是这台设备上较新的主密码或恢复码失效、较旧的又能用；轮换不受影响），RR-6；未知密钥下的副本只对**同一 vaultId** 说"保留"：另一个 vaultId 的在清理时丢弃；§3.5 入网时重新加密保留的旧库快照，也随永久删除按 secret 清除——A4R-12）；Phase 0 的"无网络"表述改为"同步关闭时无网络"。
- **对外措辞：后量子**（修订 27；PQ-READINESS §5，维护者受所有者委托批准）：
  - **可以说**：
    - 对称的核心（AES-256，SHA-256 系的密钥派生）；
    - 对量子保守的秘密（256 bit 密钥，128 bit 的恢复码与配对码）；
    - 库的机密性不依赖公钥密码：录下的库密文与入网过程，对将来的量子计算机也无用（邮箱、OTP 等连接层内容要等 M8 第 18 项的混合 TLS）；
    - 配对新设备用一个 Sixkey 从不发送的一次性码。界面上的［复制］旁写一句：复制会经过系统剪贴板，开启了跨设备剪贴板（如 macOS 的通用剪贴板、Windows 的云剪贴板）时它可能离开这台电脑，这种情况下请手动输入；
    - 浏览器支持时，连接用混合后量子密钥交换（M8 第 18 项完成之后）；
    - 为算法更换而设计（crypto-agile）：设备签名现为 ECDSA P-256，计划在浏览器稳定支持后换成 NIST 的后量子签名。"可加混合 KEM"（hybrid-ready）只指协议留了版本，不得说成已经在用。
  - **不得说**："抗量子"不加限定、"量子安全"、"后量子认证"、"使用 NIST 后量子算法"（我们现在一个都没用）。
- 权限（修订 21）：
  - 安装时**不请求**任何 host 权限。
  - 开启端到端加密同步时，Sixkey 才请求访问 api.sixkey.app（它自己的服务器）；关闭同步时移除。不开同步就不联网。
  - **2026-10-20 补充（侧边栏，与同步无关）**：清单新增 `sidePanel` 权限（无安装警告），只用于用户在设置 › 外观里打开的
    侧边栏（见 `docs/design/notes/SIDEPANEL-NOTES.md` §5）。
- 新增界面文字中英两份都要有。

---

## 8. 测试计划

**8.1 单元 / 属性（vitest + fast-check，`core/sync`）**
- 已知答案向量：transcript（固定 SPKI DER / 65 字节点编码）、承诺、SAS、配对码（格式、规范化、校验位、与恢复码的域分隔）、含 S 的入网密钥 K、所有新 HKDF 标签（并断言两两不同）、KeyBundle MAC（时间已取整到小时）、写入证明、recAuth/verifier、签名输入（含 host/target/sub）。TS 与 Python 共用同一份 JSON。
- 篡改：envelope / bundle / 载荷 / 设备名密文 / 签名 / 写入证明的任一字节，以及任一 AAD 字段 → 必须失败。
- **入网对抗模型**：模拟服务器的各种策略。每种都在全长 SAS 与截短到 4 bit 的 SAS 下运行，并分两种情况（修订 27）：
  - **服务器不知道 S**（正常情况）：两种 SAS 长度下成功率都是 0。替换在 A 一侧表现为 `pairing_mismatch`（在 SAS 这一步之前），在 N 一侧表现为 `bad_payload`。
  - **服务器知道 S**（模拟配对码泄露）：针对 A 的攻击在全长 SAS 下 10⁵ 次试验为 0，截短到 4 bit 时最优成功率 ≈ 1/16。这证明 SAS 是 A 一侧独立的第二道防线，且只有单次猜测。针对 N 的"冒充 A"在这种情况下会成功；断言它与 §10 第 110 条的残余一致，测试名写明这一点。
  - 策略：
    - 替换任一方 epk；替换 dpk 或 devN；
    - **在 A respond 之后更换 C**（P1-1）；**在 N reveal 之后更换 epk_A**（P1-2）；**迫使 N 重新发起请求**（P1-3）；在 A 的重试之间改值（P1-4）；
    - **服务器冒充 A**：对 N 回应自己的 epk、送出自己做的载荷（F1）——断言 N 只使用用含 S 的 K 解开的载荷，否则从不写入、导入或 complete；
    - **"量子"对手**（修订 27）：把 ECDH 的 Z 直接交给模拟的服务器，断言它仍解不开设备名与载荷（K 不等于只由 Z 派生的密钥），也伪造不出 N 会接受的载荷；
    - 重放旧载荷、两个批准方竞争、重复 reveal。
- **采用规则不变量**（fast-check）：任意序列的服务器下发 bundle（持 VK 者伪造的、kver 被抬高的旧 VK bundle、删掉 previous 的、只改 auth 的、垃圾的、含未知字段的）都不能让设备：失去用本机已证明可用的密码解锁的能力；丢掉历史 VK（64 条回收规则除外）；在钉住 VK2 之后被引回 VK1（包括本地数据丢失、只剩 IDB 钉住值时，F7）。keyring 写入与钉住值更新之间任意点崩溃后，设备仍接受自己已有的 keyring，并在下次解锁时修复钉住值（P2、D8）。`needs_password` 下同一密码的轮换能被采用（R4）。
- 密钥操作对账（F2、S4）：提交成功但响应丢失、重试得到 409 → 对账判为成功、不提示"新码无效"；本机对账前另一台设备又在此基础上改了密码 → 仍判为成功（恢复码包裹仍在）；真正被他人抢先 → 判为失败。
- 发送前检查（§3.14）：错误密码、未采用的新密码、恢复码版本，都在本地被拦下，不产生服务器请求。
- **修订 7（M1 评审）**：评审附录的 K0–K11 杀变异测试全部纳入常驻测试；REPRO-1（终止优先于在途步骤）、REPRO-2（approve 竞争）、REPRO-11（kver 耗尽）在修复后作为回归测试；F-02 的同 VK 用例分别经采用、解锁与发送前检查三条路径各测一次；F-03 换 vaultId 的 bundle 被拒；F-06 本地 keyring 不在时按 `adopted.digest` 判为已同步、不弹确认；F-07 只改 auth 的 bundle 被拒；kver 跳幅两端（服务器：`+65 536` 接受、`+65 537` 拒绝；客户端：超限的 bundle 按 `kver ≤ maxSeenKver` 分类且不抬高 `maxSeenKver`，`maxSeenKver = 0` 时照常分类）与 `publishKver` 的上限与溢出；`capPrevious` 在第 65 次轮换后仍产生合法 keyring，丢的是列表最前的条目；离线期间错过两次轮换、列表已满 64 条的设备仍能通过 R3 连续性检查；upload 模式的 auth salt 规则（评审 M06）。采用规则的模型测试至少有一组事实级序列走真正的 `unlockWithSync`/`evaluateSameVkBundle`（T-02），而不是只驱动判定函数。这组序列用恢复码解锁（HKDF，便宜），密码包裹只按字节检查：Phase 0 读取参数时拒绝低于 600 000 次的 PBKDF2，所以不加测试专用的低迭代 KDF，也不为测试改 Phase 0（M1-20）；默认 40 次运行，`SIXKEY_T02_RUNS` 可加大。模拟一律以种子固定（M1-12）；默认跑 2000 个完整会话 + 10⁵ 次哈希级试验，完整的 10⁵ 个会话放在 CI 的长任务里（M1-13）。
- **旧密钥副本的清理**（GM2-4）：§3.5 入网后旧库快照被重新加密、保留原 vaultId，"找回账户"能从中找回入网前删除的账户；⑤ 与 ⑥ 之间崩溃 → 下次清理丢弃它们，`sk_prejoin` 仍可导入；`startOver` 之后旧库的快照被丢弃（`residue.spec.ts` 的 start-over 用例改为从设备密钥库开始）；同一 vaultId、未知密钥的快照保留；读取 `sk_sync_cfg.enc` 或 `sk_prejoin` 出错时标记保留；grep 测试：只有服务层的清理入口调用 `finishKeyChange`，只有 `platform/runtime.ts` 构造 `VaultStore`。
- **本地提交掉电、身份记录已写**（GM2-5）：M2 的故障测试用两个各自丢失未落盘尾部的 KV（chrome.storage.local 与 IndexedDB）。分别在 P4 轮换、R3 采用、§3.5 入网、改密码、换恢复码提交之后，丢掉 storage.local 的尾部、保留 IDB 的身份写入；重启后本地 keyring 回到旧状态，钉住值与 `adopted` 领先，而且没有任何写入。M3 端到端（FakeServer）：换了 VK 的情况，一次输入密码就按 R4 顺序采用服务器 bundle，不弹"较旧的密钥状态"确认、不出现 `bad_mac` 或 `keys_behind`，期间以旧 VK 做的本地编辑被合并上传；同 VK 的情况，下一轮同步把本机自己提交过的包裹采用回来、不提供"修复"；服务器已到 VK3 时同样采用；服务器同时回档到 VK1（双重故障）时停在 `needs_password`，本地可用，不向服务器写。
- **kver 回档**（N27，模型测试）：① 诚实的多步回档——服务器 kver 从 10 回到 7、所有设备 `maxSeenKver = 10` → 都进入 `keys_behind`，一台修复后以 kver 11 发布，其他设备全部恢复，没有设备被永久卡住；② 落后的发布者——A 只见过 8、B 见过 10，回档后 A 修复发布 9 → B 不静默采用（进入 `keys_behind`），B 修复发布 11 → A 采用，A 的新恢复码失效时 A 上出现"恢复密钥已更换/未生效"提示；③ 解决之后恶意服务器重放一份真实的旧 bundle → 不采用、进入 `keys_behind`；④ `keys_behind` 状态下吊销照常成功，改密码与批准被挡；⑤ R3 只能用旧密码打开服务器旧 bundle 时必须明确确认；⑥ 身份恢复（`identity_missing`）时服务器 kver 领先 → 正常采用、不误报 `keys_behind`。
- 修订 5 的向量（M0 重新生成）：HMAC 密钥一律 256 bit（并保留"默认 512 bit 得到不同 MAC"的反例）；设备名规则的每一类拒绝（孤立代理项、全空格、41 码点、Cc、Bidi 控制、零宽）与 40 个 emoji 的通过例，以及 reveal `name_ct` 的 160 字节补齐；入网载荷里 `bundle` 为原文字符串；fork 的 `Sixkey-New-Sig` 与 `Sixkey-Sig` 共用同一签名输入；未按小时对齐的 bundle 时间与非整数数字记号被拒。

**8.2 同步引擎模型测试（内存 FakeServer）**
3–6 台模拟设备，随机交错：增 / 改 / 移动 / 删除 / 恢复 / 永久删除、同步、锁定 / 解锁、改密码、换恢复码、轮换、吊销、离线、409 竞争、"服务器已提交但响应丢失"、任意 await 点崩溃。另有专项：
- **存储恢复后编辑**（F3、D1）：`sk_sync_state` 保留、本地从另一槽/快照/镜像/云端恢复、**用户在引擎运行前点了"知道了"**、之后编辑 → 编辑必须上传，且服务器上较新的数据不被旧本地覆盖；恢复写入之前任意点崩溃都不能让旧本地被直接上传；
- **outbox 与恢复、与并发页面**（D2）：有待推送的 outbox 时发生恢复 → outbox 推送成功也不会让 `lastSynced` 复活；popup 与设置页先后提交 → outbox 总是最新的 generation；
- **孤儿 outbox**（修订 19，M3RR-3）。模型的 tear 族必须撕裂**有未同步改动**的设备，不能只撕裂恰好同步的设备（M3RR-11）。每种情况都断言那次已确认的保存最终在每台设备上、在头版本里：
  - 撕裂一个有 outbox 的脏槽位：在"每次都锁定"下（SW 重启 → 服务器仍在 (base, head) 时推送孤儿 → 解锁后完整一轮），以及在解锁状态下；
  - 服务器已前进时孤儿推送 409 → 孤儿保留，解锁后作为第二个远端并入并上传；
  - 上传之前再撕裂一次（双重撕裂）；
  - 恢复之后、完整一轮之前的本地编辑不会删掉孤儿；
  - 并入被守卫阻塞时孤儿保留，回答之后退役；
  - 带孤儿关闭同步（先并入再删）；被吊销的设备带孤儿（本地拿回保存）；
  - FIXa2 把 keyring 退回而孤儿在较新的 VK 下（保留，采用之后并入）；
  - 带孤儿入网（`sk_prejoin` 含那次保存）、云端恢复、R3 采用；
  - 损坏的孤儿被移除；校验和相等时退役。
  - **修订 20**：
    - R3R-1 的三种情况：别处已写入后锁定推送、推送 409、推送途中第二次保存。每种都先让 outbox 降为孤儿，再撕裂槽位，那次保存仍到达每台设备与头版本。模型的 tear 族加上"别处写入 → 锁定推送 → 撕裂"这个顺序。
    - R3R-5：孤儿等待期间的保存写只用于合并的 outbox；第二次撕裂把它追加为第二个条目，两次保存都到达。
    - 列表与多次降级、多次恢复。
    - 搁置：FIXa2 的较新 VK、较新的 schema。同步照常设置 `lastSynced`；轮换不再 `not_synced`；采用或更新之后并入。
    - 关闭同步、移除同步身份时搁置条目保留（R3R-2）。
    - 本机库丢失时返回 `vault_lost`（R3R-3）。
    - 撤销入网时以 `answer` 回答被挡住的并入（R3R-6）。
- **服务器回滚**：服务器 version 从 100 回到 90 → 拉取、告警、合并、上传，无 409 死循环（F4）；回滚后另一台设备复用了同一个版本号写入不同内容 → 本机因 head 不同而拉取合并（D5）；
- **时钟快 2 天 / 慢 2 天的设备**：编辑后每台设备各自至多上传一次、其他设备至多提交一次，之后静止（F5）；服务器时钟偏 +40 分钟时 TOTP 显示不受影响，打开校正开关后才按校正时间，偏移 >1 小时不提供校正（S3）；
- **坏头版本**：持 VK 设备的缺陷写入不可解的头版本 → 回溯合并，任何设备上的数据不丢（F6a）；
- **合并后条目数 > 5000**：同步不中断（F15）；> 50 000：进入 `too_large`、不每轮失败（D7）；合并后超过字节上限：本地保留、上传暂停；**之后删除进回收站（数量足以跨过一个 16 KiB 填充桶）与永久删除都被允许，库回到上限以下后上传自动恢复**（D3）；
- "每次都锁定"模式：编辑后 popup 立即关闭 → outbox 由 SW 推送（P10）；
- **HOTP**（C4.8）：在线时先拉取（2 秒超时）、计数器先落盘再显示、立即上传、离线提示；两台离线设备的计数在合并后取 max；
- **加入时本机已有库**：added 模式导入、"本机每个存活账户都在结果中存活"的检查、`sk_prejoin` 的建立与再次导入、旧快照重新加密后仍能被"找回"（D9）；同 vaultId 不同 VK 的合并；`different_vault` →"以云端为准重新加入"；
- **以本机为准修复云端**（N24）：服务器回档到轮换之前 → 用户输入 keyring2 的恢复码或生成新码后，以不换 VK 的 rotate 修复，各设备收敛；回档跨过改密码时要求旧密码；不提供恢复码时修复被拒、本地不受影响；
- **轮换时设备名重新加密**（含已吊销的设备）。

不变量：静止后所有设备与服务器 canonical 一致；每个已确认的本地编辑要么在最终状态中，要么被一个时间戳更新的编辑覆盖；Phase 0 的存储不变量仍成立；无改动不 PUT；新数据只用当前 VK；previous-VK 的远端版本从不被自动合并；守卫只在两个阻塞条件下阻塞，日常删除从不阻塞。

**8.3 故障**：服务器 500 / 超时 / 截断 / 校验和正确但 AAD 错 / 新 schema / 超大 / 旧版本 / 旧 kver / 401 与 403（身份不被删除，P5）；`FaultyKV` 注入同步提交中的每一次写；storage.local 整库清空 → 云端恢复。§2.5 的四种组合逐一测试（d2）：**每次启动前删除 IndexedDB**（模拟 GoLogin SDK）→ 解锁后身份自动恢复、不产生新设备行、不触发批准；锁定期间不签名、不推送；IDB 与 storage.local 都丢 → 重新入网后旧 deviceId 被吊销。"关闭同步"与"移除同步身份"之后再解锁，不会从副本恢复出旧身份（D11）。克隆（d3）：复制整个 userDataDir 后两份都写入 → 最迟第二次写入报 `forked`；只读的克隆不报；分身后 deviceId、DSK、`sk_device` 全部不同；单次崩溃（cursor 已写 pending、响应丢失）不误报；同一配置文件的页面一轮与 SW outbox 推送并发不误报。`init` 与 `complete` 响应丢失 → 客户端以签名的状态查询确认已入网，不提示"恢复密钥无效"，不产生第二个设备行（D4）。`min_client_version` 高于本机 → 停止读写。

**8.4 API（pytest + httpx + 真实 Postgres）**
- 20 个并发、相同 `if_version` 的 PUT 恰好一个 200；`version_conflict`、`vk_mismatch`、`write_denied` 区分正确；**吊销与 PUT 并发时，吊销提交之后不会再有该设备的写入落地**（`FOR NO KEY UPDATE` 设备行锁，C3、A1）；PUT×PUT、轮换×PUT、complete×轮换、吊销×complete 的确定性交错不死锁（全局锁顺序）。
- 密钥操作：原文相同的重放返回 200（不论 `if_kver`）；新 kver 跳号（`> if_kver`）被接受，`≤ if_kver` 被拒（N27）；原文不同返回 409；P4 一致性规则逐条（缺 verifier、只改 auth 等）返回 422；`by` ≠ 签名设备返回 422；rotate 原子且作废入网请求。`init`、`complete` 原文相同的重试返回同样结果（D4）。
- 签名：错钥、改正文、改目标、改 host、改 sub、ts 越界、已吊销（先验签再回答）、别的账户的设备、P1363↔DER 转换；fork 缺少或错误的 `Sixkey-New-Sig` 请求头被拒（S5、N1）。
- **每个端点**的跨租户隔离（表驱动）。JWT：过期、aud/iss 错、HS256 公钥混淆、匿名用户、step-up 的 `iat`。
- **角色与 RLS**（C2）：`sixkey_api` 能读写；`anon`/`authenticated` 什么都看不到；删除 `auth.users` 行后级联清空全部表。
- 入网状态机：全部合法 / 非法转移；**过期但未删除的请求不能被推进**（P6）；两个批准方并发 respond；每个会话 1 个请求；"拒绝全部"。
- `pw_auth`（S2、S8）：每个需要它的端点在缺失/错误时拒绝（含吊销自己、给自己改名、设备侧拒绝、清除历史）；失败只计数、计数并发安全（F14）、封顶 10；无效证明洪水超过小桶后不再写库；**以共用设备身份故意输错任意多次之后，真设备带正确 `pw_auth` 的吊销与轮换照常成功、不被限流**；改密码后旧 `pw_auth` 失效；恢复码重置路径接受 `recovery_auth` 且其失败计入同一计数。
- **状态查询不写库**（T2）：连续状态查询前后 `devices` 与 `vaults` 行不变（跨天的 `last_seen_at` 除外）；cursor 只在 PUT 中变化。
- 修订 5：`GET /v1/vault` 不再有 304（N2）；`devices_rev` 在新增、吊销、改名、输错密码、轮换重新加密设备名时各加一，而状态查询与 `last_seen_at` 不加（N15）；fork 缺少或错误的 `Sixkey-New-Sig` 被拒（N1）；请求体上限按 §5.4 的表逐端点检查，8 MiB envelope 的 rotate 能通过（N13）；bundle 时间未对齐 422（N16）；非整数数字记号 422（N20）；会话时区为 +05:30 时写入的时间仍是 UTC 整点（N4）；经真实反向代理发送带正文的 `DELETE`，正文被丢时得到 `bad_signature`（N25，M8 在预发环境复测）。
- 恢复码错误与限流（假时钟）；保留策略（假日期）；`DELETE /v1/vault/versions` 保留头版本、幂等、需要 `pw_auth`；时间戳精度（小时/天/分钟）；未确认 auth 用户的每日清理。
- 删除账户：一次 auth 删除后扫描所有表无残留；auth 删除失败时什么都没删、可重试（F12）。
- **日志扫描**：整套测试期间捕获全部日志（含故意触发的约束错误），断言不出现测试 IP（含伪造的 `X-Forwarded-For`）、测试邮箱、OTP、长度 >40 的 base64 串、任何 `Authorization`/签名头的值、`DETAIL: Failing row`（P7），时间戳不超过秒精度。

**8.5 契约一致**：同一套 TS 契约测试分别对 FakeServer 和真实 FastAPI 运行，结果必须一致。FakeServer 的 `Content-Type` 判定比 M4 宽（FS-1），这只是测试替身的问题：客户端只发 `application/json`，与引擎无关，但 FakeServer 应改为与 §5.4 一样精确，免得测试掩盖传输层改写请求头的错误。

**8.6 E2E（Playwright）**：2–3 个 `launchPersistentContext`，各自独立 userDataDir，对本地 FastAPI + Postgres + FakeAuthProvider：
- P1 开启同步；P2 经批准入网（从 P1 页面读配对码填到 P2，再从 P2 读 SAS 填到 P1；另测输错配对码的路径）；P3 经恢复码入网；P4 在已有本地账户的配置文件上入网（导入摘要、`sk_prejoin`）。
- 三者并发编辑 → 收敛；弹窗先显示本地数据。
- 仅吊销 P2 → P2 显示"服务器拒绝本设备"、本地数据仍在、身份未删除；吊销并保护 → P1 展示并确认新恢复码 → P3 输入密码后收敛。
- P1 改密码 → P3 用新密码解锁成功；用旧密码解锁 → 出现"请输入新密码"横幅。
- 生成新恢复码时让响应丢失（测试钩子）→ UI 不提示"新码无效"，下次同步显示"已生效"。
- 离线时编辑 → 恢复后同步；同步途中杀 SW → 下次启动补做；破坏活动槽 → 恢复横幅点"知道了" → 编辑 → 同步后服务器上没有丢失任何较新的数据（D1）。
- 服务器回滚、远端批量删除（提示 + 找回）、远端清除本机存活条目（阻塞确认，［应用］时重新拉取）。
- §7 的网络白名单测试。
- **旧内核**（d8）：上述同步 e2e 的一个子集（入网、并发编辑、吊销）另在 Chromium 120（= `minimum_chrome_version`）和 134 上跑（用 Chrome for Testing 的对应版本作为 `executablePath`），覆盖 WebCrypto ECDH/ECDSA（含 non-extractable 私钥存 IDB、JWK 导出导入）、`storage.session`、offscreen。指纹浏览器的内核常落后于 Chrome（调研：Orbita 153、VMLogin 保留 109 但低于我们的下限、BitBrowser 134）。

**8.7 人工**：真实 Supabase 项目上的 OTP 邮件送达；两台物理电脑；低端机上 PBKDF2 与同时启动多个配置文件的负载。（指纹浏览器不做专门实测，已决 Q6；使用中发现的差异只更新帮助文案。）

---

## 9. 分阶段实施计划

每个里程碑单独可验收。M0–M7 **不需要任何 Supabase 账户**（本地 Postgres 用 docker；认证用 `FakeAuthProvider`）；M8 需要所有者提供的资源。修订 2（评审）改动的里程碑标 ★，修订 3（指纹浏览器调研与所有者决定）改动的标 ◆，修订 4（最终评审）改动的标 ▲，修订 5（M0 发现的问题）改动的标 ◇，修订 6（N27–N29）改动的标 ◈，修订 7（M1 评审）改动的标 ✦，修订 8（M1-16–M1-20、A2）改动的标 ✧，修订 9（G-M2 评审）改动的标 ◎，修订 10（A4、C6）改动的标 ◉，修订 11（YubiKey 预留）改动的标 ⊙，修订 12（M2 评审）改动的标 ⊛，修订 13（M2 合入）改动的标 ⊕，修订 14（M2-FIX2）改动的标 ⊗，修订 15（M4 评审）、修订 16（M4 修复轮）、修订 17（M4 复审）与修订 18（M4 清理轮）改动的标 ⊘，修订 19（M3 复审）与修订 20（M3 第三次评审）改动的标 ⊚，修订 21（M5 评审）改动的标 ⊜，修订 24（M6 第一阶段）、修订 25（M6 第二阶段）与修订 26（M6C）改动的标 ⊝，修订 27（后量子准备）改动的标 ⊞。Phase 0.x 加固与体验调研的交叉引用见 §9.1，都不改变 M0–M8 的内容与顺序（H1 获准在 M2 之前开始；两者都改服务层，后合入的一方在先合入的基础上变基，不是新的依赖）。

| # | 内容 | 验收 | 依赖 |
|---|---|---|---|
| M0 ★▲◇ | 契约与向量：§5.4 写成 `openapi.yaml`；错误码表；共享已知答案向量（⊞ 修订 27：入网 v2 与配对码的向量取代 CC 的，§0.0aa；写入证明、固定的公钥编码、含 sub 的签名输入；▲ 时间取整到小时的 bundle；▲ 全部 HKDF 标签两两不同的断言）；◇ **按 §0.0d 重新同步契约与向量**（N1、N2、N3、N5、N6、N7、N11–N16、N20 等） | TS 与 Python 都能加载向量文件；◇ `check_consistency.py` 0 处硬不一致、S1 为 0（N29）；◈ 按 §0.0e 再同步一次（kver 规则与示例） | 无 |
| M1 ★▲◇ | `core/sync/crypto`（纯函数）：KeyBundle（原文、一致性规则、▲ 小时精度、▲ 未知字段规则）、设备名（定长）、recAuth/verifier、`pw_auth` 与发送前检查（▲ 含恢复码版本）、`K_write`/写入证明、入网两侧状态机（⊞ 修订 27：配对码取代 CC、入网 v2 的派生与标签；含 §3.2 全部 MUST 规则）、请求签名、填充、密钥操作对账（▲ 按关键部分判定）、▲ fork 的新公钥签名（◇ 放在 `Sixkey-New-Sig` 头）、◇ 设备名的完整规则、◇ HKDF 输出一律 256 bit、◇ 严格的 base64url 与整数规则；◈ R1 新规则、`keys_behind` 下的发送前检查、发布时的 kver 取值；✦ 按 §0.0f 的"M1 代码改动"清单修正（R0、kver 跳幅、同 VK 无例外、vaultId、`adopted`、已验证 bundle 对象、`capPrevious`、状态机终态规则） | §8.1 全过；✦ 评审的 K0–K11 与三个 REPRO 回归通过 | M0（◇ 重新同步后） |
| M2 ★◆▲ | 存储与服务层改动：不新增快照类型，`transact` 的 `ensureCurrentSnapshot` 与 ▲ `afterCommit`、▲ `VaultStore.beforeRecoveryWrite` 钩子、`openVault` 的 previous-VK 回退、`applyRemote`、▲ 只拒绝变大的本地体积检查、`validate.ts` 条目上限移到新增时、HLC 可注入校正时间、`sk_sync_*` 键（▲ 无 inbox）、`sixkey-identity`（含钉住值、写入顺序与 ▲ 钉住值修复）；◆ `sk_sync_cfg` 的 VK 加密 DSK 副本（▲ 生成流程）与 §2.5 四种组合；▲ "关闭同步/移除身份"的一步删除；▲ 入网时旧快照重新加密；✦ 身份记录增加 `vaultId` 与 `adopted {digest, auth}`，与 `maxSeenKver` 同一次写入；✧ §0.0h 的换密钥标记协议（A2）；◎ §0.0i 的清理规则与 M2 要求清单（单一清理入口、`lock` 必填、`openVault` 回退的读取错误规则、D8 第二个方向的故障测试）；◉ §0.0i 第 5、8 条的补充与第 12–14 条、§3.5 vaultId 相同而密钥无关时按 added 导入；⊙ YubiKey 预留（§0.0i 第 15 条）；⊛ §0.0i 第 2、16–18 条（applyRemote 不写标记、`commitKeys` 的能力对象与自查、`pendingPins`/`settlePins`） | Phase 0 的全部测试与故障矩阵仍过 + 新故障用例 + §2.5 四种组合 + ▲ 恢复后不覆盖较新服务器数据 | M1 |
| M3 ★▲ | 同步引擎 + 内存 FakeServer：`lastSynced = {version, head, checksum}` 状态模型与置空机制、`needPull`、夹紧与"与原始远端比较"（canonicalJson）、回溯、outbox（▲ 在提交步骤里写、成功时本地 CAS）、采用规则 R1–R6、新守卫（▲ 不保存远端、▲ danger 横幅规则）、退避；▲ TOTP 本机时钟与可选校正、◈ `keys_behind` 状态与身份恢复时 `maxSeenKver = 0`；✧ 发送前检查与构建函数在同一上下文（M1-19）；◎ R1 的"内容相同"包括 `adopted.digest`、钉住值与本地不同时的 R4 顺序（GM2-5，端到端）；⊙ F6a 回溯遇到 `newer_schema` 时停下（R6）；⊛ 每次采用或发送前判断之前调用 `settlePins()`，只把 M1 的能力对象交给 `commitKeys`；⊕ §3.1 第一次上传的本地部分（截断在 `init` 之前，钉住值按已同步写入，不经 `commitKeys`）、`sk_sync_state` 的写入规则；⊚ 孤儿 outbox（D1 修订 19，§4.7：恢复时保留、按 (base, head) 推送、作为第二个远端并入、按服务器确认退役；修订 20：降级而不丢弃、只用于合并的 outbox、条目列表、搁置而不阻塞、`vault_lost`）、轮换的待确认记录与先对账后合并（M3RR-1）、503 计入退避（M3RR-2）、密钥操作取 `sixkey-sync`（M3RR-4）、发送时检查最低版本（M3RR-5）、时差不被重置（M3RR-9） | §8.2、§8.3 全过；⊚ §8.2 的孤儿 outbox 测试族 | M1、M2 |
| M4 ★◆▲◇ | FastAPI + 本地 Postgres + FakeAuthProvider：全部端点；写入证明；按原文的幂等判定（▲ 含 `init`、`complete`）；P4 一致性与 ▲ `by` 校验；按设备的限流（▲ 有效 `pw_auth` 豁免）；▲ 失败只计数（无锁定、无 423）；▲ 吊销自己/改名自己需要 `pw_auth`；▲ `DELETE /v1/vault/versions`；▲ `reject-all`（无暂停）；▲ `head` 字段；▲ 设备行 `FOR SHARE` 锁；▲ 属主/策略与级联测试；▲ 状态查询不写库、cursor 只在 PUT；▲ 删除 `/v1/time`、`revoked_by`；▲ 时间精度与未确认用户清理；一步式级联删除；日志与数据库错误规则（▲ 秒精度）；◆ `min_client_version`、`POST /v1/devices/fork`（▲ 新公钥签名，◇ 走请求头）；◆ 不依赖 `Origin` 的测试；◇ `devices_rev`、逐端点请求体上限、UTC 会话时区、bundle 时间对齐与整数检查、通用错误码与响应约定、无条件 GET；◈ `kver > if_kver` 与按原文的幂等；✦ `KVER_MAX_JUMP` 上限、P4 以 iv + wrapped 判断包裹改变、轮询视图字段按状态必填 | §8.4 全过；§8.5 契约测试对真实 API 通过 | M0 |
| M5 ◆▲ | 扩展接线：SW API 桥、DSK、alarms/防抖/退避、状态轮询、角标；▲ `sixkey-sync` 锁归属规则（SW 传输函数不取锁）；`update_required` 状态；prod/dev/e2e 三套 manifest 与 CSP；check-dist；network.spec 改写；◆ 旧内核 CI（Chromium 120 与 134）管线；✦ 入网界面接线前确认状态机的终态规则与 approve 竞争规则（§3.2 MUST 7、8）已实现；⊗ ⊘ 请求签名一律用校正后的时间（§4.14，`reject-all` 的范围依赖它）；⊘ 带 JSON 正文的请求一律只发 `Content-Type: application/json`（§5.4，别的写法都是 422）；⊘ 一次结果不明的 complete 之后遇到 410，走以 devN 签名的状态查询（A17）；TS 契约测试对 `make run` 跑（A30）；⊗ M6 的"同步设置"一节存在之前不得发布"开启同步"（`sync_on` 与 `cleanup_pending` 的文字指向那里）；把"密钥已采用回来"显示为可见事件（RR-6）；⊚ 接上 outbox 写入器之前，孤儿 outbox 规则必须已实现（M3RR-3）；传输层的请求超时至多 60 秒，内部不自动重试（M3RR-6）；⊜ manifest 改为可选 host 权限（prod/dev），e2e 为必需；check-dist 的新规则；每个页面的 `<meta>` `connect-src 'none'`（M-1）；SW 的权限检查与 `permission_removed`、`onRemoved`/`onAdded`、浏览器启动时的回收 | `npm run verify` 全过；网络白名单 e2e 通过；旧内核上 WebCrypto/IDB/`storage.session` 冒烟通过 | M3、M4 |
| M6 ★◆▲◇ | §6 全部界面（含确认码输入、批准方显示确认码——⊞ 修订 27 改为批准方显示配对码、新设备输入配对码；删除提示与找回、加入未完成、服务器拒绝本设备、▲ 拒绝全部、改密码时的轮换勾选、▲ 清除服务器历史按钮、▲ 时钟校正开关、◇ "以本机为准修复云端"的恢复码步骤、◈ `keys_behind` 面板与同 VK 的修复、R3 的确认对话框、设备名输入提示）+ 多配置文件 e2e；◆ 克隆软检测与"分出独立身份"（▲ 只在写入时交换 cursor；▲ 提示旁加"吊销并保护"）；◆ `identity_missing` 与共享警告的界面；◆ 旧内核上跑 §8.6 子集；⊕ M2 新错误码的界面文字（M2R-15）、"以云端为准重新加入"前替换身份、`prejoin_exists` 的处理；⊚ `vault_lost` 与搁置孤儿条目的提示与"高级"里的删除、撤销入网时的复核（§3.5，R3R-6）；⊜ 开启与加入时在第一次点击里请求权限、拒绝时的说明、`permission_removed` 的提示与"重新授权"、关闭同步与移除身份时移除权限；⊝ 第一阶段：同步一节代替 popup 屏幕、开启的顺序、可当场改正的错误与锁定结束流程、权限不变式；第二阶段的第一个改动是模块拆分（§7），然后是批准、设备列表、吊销、密钥操作、修复、以云端为准重新加入、云端恢复、分出独立身份、清除服务器历史、批准入网后的去重（§3.5）；⊝ 第二阶段（已合入）：设备列表、批准、吊销（"丢失或被盗"的顺序与"欠一次轮换"的记录，§3.10）、密钥操作、`keys_behind` 的修复、以云端为准重新加入、云端恢复、分出独立身份、删除同步账户、清除服务器历史、`sk_prejoin` 列表、锁定页的采用表单；⊝ M6C（已合入）：`server_older_key` 的修复、"找回账户"（O13）、批准入网后的去重 | §8.6 全过；克隆验收：分身后 deviceId、DSK、`sk_device` 都不同 | M5 |
| M7 ★◆▲ | bundle 与 ▲ `write_key` 的 KMS 应用层加密（PLAN Q7、S7）。（墓碑回收已按 Q9 取消；▲ inbox 已删除；▲ "清除服务器历史"已移到 M4/M6） | 各自测试 | M6 |
| M8 ★ | Supabase 与上线：`SupabaseAuthProvider`；在 Supabase 中建 schema、角色、RLS 策略并跑隔离测试；JWT 有效期 900 s；`log_error_verbosity = terse` 等日志设置；自定义 SMTP 与邮件模板；`api.sixkey.app` 域名与 TLS；不记录 IP 的托管；CORS 用商店扩展 ID；PRIVACY/SECURITY 定稿；预发环境跑完整 e2e；◉ 发布前处理 §0.0j 的待办 | 预发环境 e2e 全过；两台物理电脑 + 指纹浏览器人工验收；PLAN Phase 1 验收标准 | 所有者 |

**M8 上线核对清单**（与 `docs/design/notes/M4-NOTES.md` §10 一致的 15 项，另加第 16 项，逐项在真实 Supabase 项目与托管上验证，不在本地）：
1. **签名密钥**：只用非对称的 ES256 签名密钥，从不接受旧的 HS256 密钥；`iss` 精确匹配；JWT 有效期 900 s；关闭匿名登录。JWKS 缓存，遇到未知 `kid` 时刷新，至多每 N 秒一次（P2）。
2. **只在本地校验 token**（JWKS），从不调用 `/auth/v1/user`：会话按设计在 verify 后立即登出，`/user` 会拒绝它。
3. **OTP**：
   - 邮件模板只有 `{{ .Token }}`，长度 6；新码作废旧码。
   - Supabase 自身的 60 秒重发限制与它的各种 4xx/429 一律映射成不泄露邮箱是否存在的响应；测量新旧邮箱的耗时差，需要时补齐（P1）。
   - `create_user: true`；不向 Supabase 转发客户端 IP，Supabase 的按 IP 限额相应调高（S1 已在 API 修复）。
4. **登出后 refresh token 失效**：verify 之后立即 `logout?scope=local`，用真实项目证明 refresh token 已不能用；登出失败答 503（A23）。
5. **删除用户**：
   - 管理接口硬删除（`should_soft_delete=false`）；以 GoTrue 的角色执行时级联经 RLS 清空全部 sixkey 行。
   - 删除与写入并发 → 503 + 重试（§5.7，S7）：只有在什么都没删时，才把 provider 的错误映射为 `ProviderUnavailable`。
   - `purge_unconfirmed` 实现，并与保留任务一起每日调度，只输出计数。
6. **迁移**：
   - 以 `postgres` 运行 `0001_sixkey.sql`。`GRANT REFERENCES ON auth.users TO sixkey_owner` 必须成功（`auth.users` 属于 `supabase_auth_admin`），否则采用备选方案（A26）。`sixkey` 不在 API 暴露的 schema 里。
   - 应用 `0002_least_privilege.sql` 之前，确认没有任何 Supabase 角色依赖 PUBLIC 在 `public` 上的 CREATE 或数据库上的 TEMP，因为它会从 PUBLIC 收回这些授权（§5.1）。
   - **以 `public` schema 与数据库的属主运行 0002**。非属主的 `REVOKE … FROM PUBLIC` 只给 WARNING，0002 的后置条件随即报错、回滚整个文件（§5.1）。这是换角色的信号，不是去改文件。
7. **以 `sixkey_api` 审计权限**：`auth`、`storage`、`vault`、`extensions`、`graphql`、`realtime`、`public`、`sixkey_meta` 里的 schema 与表权限；数据库上的 CREATE 与 TEMP（S11）；`anon`、`authenticated`、`service_role` 对 `sixkey` 没有 USAGE。对项目跑 `test_db_roles.py` 与 `test_migrations.py`。
8. **连接**：
   - `sixkey_api` 的密码在迁移之外设置；经 Supavisor transaction pooler（`sixkey_api.<ref>`，端口 6543）连接，`statement_cache_size=0`；经 pooler 证明会话时区为 UTC。
   - 按 pooler 的容量设 `SIXKEY_DB_POOL_MAX`，保留取连接超时 `db_acquire_timeout_s`（S10）。
9. **Postgres 日志**：
   - `log_error_verbosity = terse` 能设且已设。S8 已去掉预期的唯一冲突 ERROR，§5.6 的外键残余仍在。
   - 参数不进日志：`log_parameter_max_length_on_error = 0`、`log_statement = none`，`sixkey_api` 不开 pgaudit。
   - 故意触发一次 `one_per_session`，在日志浏览器里核对。
10. **托管**：
    - 访问日志关闭或不含 IP。恰好一个实例（限额在内存里），否则换 Redis。
    - `SIXKEY_TRUSTED_PROXIES` = 那一个代理，它把客户端地址追加为最右边的 `X-Forwarded-For` 值（未设置时应用启动会告警，P3）。核对它确实追加在最右边；服务器测试 `test_forwarded_for_only_from_a_trusted_proxy` 已检查"按最右边的值计"（RR4）。IPv6 按 /64 计。
    - 代理上：正文大小上限（9 MiB）、正文超时与空闲超时（S3、P5）；不做 URL 规范化、不合并请求头、转发 DELETE 的正文（P4）。
    - 经真实代理重跑"丢掉 DELETE 正文"（N25）与百分号编码请求目标的测试；TLS。
    - 按实例内存调 `SIXKEY_LIMIT_CONCURRENCY` 与 `large_body_slots`。
    - **从不直接暴露 uvicorn**（RR5，上线门槛）。代理必须有：
      - 请求与请求头的读取空闲超时：什么都不发的连接现在会一直占住 `limit_concurrency` 的名额；
      - 按 IP 的并发连接上限；
      - 远短于 60 秒的正文读取超时。

      `SIXKEY_LIMIT_CONCURRENCY` 设得比代理的连接上限大。8 个大正文槽位是所有账户共用的一个池（RR2），让单个来源占不住它们的，是按 IP 的连接上限。
11. **配置**：`SIXKEY_ENV=production`（S12）；`SIXKEY_API_ORIGIN` = 精确的公开 host；`SIXKEY_CORS_ORIGINS` **为空**（修订 21：不返回 CORS，§5.2；核对没有授权时读不到任何响应、也没有任何签名请求被接受，授权后能连；修订 23）；`min_client_version`；每日任务已调度（cron 或 pg_cron）。
12. **披露**：隐私政策写明备份 / PITR 窗口（§5.7），以及 Supabase 的认证审计日志保存服务器 IP 与邮箱（PRIVACY）。
13. **容量**（P6）：存储告警；决定是否设全局注册上限（每个账户最多约 72 MiB，而账户很便宜）。限流表由所有键族共用（RR3b）：多于一个实例，或实际中 IP 键挤掉了设备键时，换成按族设上限的 Redis。
14. **SMTP** 与它的 DNS 记录；`api.sixkey.app` 域名（另加一个开发域名）。
15. **锁住某个邮箱的 OTP**（RR6，Phase 1 已接受并写明，§1.2 A11）：不需要任何认证，任何 IP 的错误校验就能耗尽一个邮箱当前验证码的 5 次机会，多个 IP 能填满它每天 50 次的发送，把该邮箱挡在登录、恢复码入网、新设备入网、init 与删除账户的二次确认之外最长一天。M8 选定缓解，可选做法：
    - Supabase 一侧的保护，例如在 `send`、`verify` 之前加 CAPTCHA/Turnstile。API 代理了 `/otp`，所以这需要改契约。
    - 一种第三方耗不尽的校验失败策略。

    与 P1（耗时）、第 13 项（全局注册上限）一起决定。
16. **PITR 恢复栅栏**（M3RR-13）：PITR 的操作规程里，服务器记下恢复时间，拒绝 `Sixkey-Ts` 早于它的签名（`401 clock_skew`）；对一次真实的恢复演练验证（§5.2）。
17. **开闸**（修订 24 列出，修订 25、26 刷新）。
    - **已完成**：
      - 由 M6：popup 的 P2 一行；`keys_behind` 卡片的修复，以及 `different_vault` 卡片的"以云端为准重新加入"；开闸后的 popup 在 60 KB 预算内。
      - 由 M6C：`server_older_key` 的修复（§4.2）；"找回账户"（O13）；批准入网之后的去重（§3.5）；SECURITY.md 与 `docs/security/local-vault.md` 里关于"同步开启时什么能打开锁定的页面"的那句话。
    - **开闸之前还要完成**：
      - 总开关 `SYNC_UI_IN_STORE_BUILD`。这是一次单独提交、经过独立评审的改动：常量、`m6-gate` 测试、商店的权限说明、OWNER-DECISIONS/06 的那一句。（2026-11-17：总开关已随"同步"一节从所有版本删除，此项作废，OWNER-DECISIONS/25。）
      - "更新 Sixkey"的商店链接（商店 ID 那时已存在）。
      - **主密码强度**（OWNER-DECISIONS/15 的前提，独立评审 F4，2026-10-22）：本地设主密码时低于 50 bit 只警告，开启同步会把
        这个密码原样带上服务器，而服务器上的 `password_verifier` 按 `auth.kdf` 的 PBKDF2 轮数（600k）算，与包裹的轮数无关，
        数据库一旦泄露就能离线猜。所以 `SYNC_UI_IN_STORE_BUILD` 翻转之前，开启同步必须二选一：检查密码强度（`measure(pw).ok`
        不成立就不让开启），或要求设备持有的账户密钥。以后改同步的密钥操作时，包裹与 `auth.kdf` 一起提高到
        `PBKDF2_PASSWORD_WRAP_ITERATIONS`。
      - 在旧内核（Chromium 120 与 134）上跑 §8.6 的子集。
      - 修复没有真实数据库的端到端测试：在第 16 项的 PITR 演练里一并核对 §4.2 写下的修复过程。
    - **可以之后做**：保留库的导出与重新导入（§3.5 ④）。
18. **混合后量子 TLS**（修订 27）：API 的 TLS 终结点（反向代理）向 Chrome 提供混合密钥交换 X25519MLKEM768（Chrome 131 起默认使用它，这一条只有二手来源，未核实）。核对方法：Chrome 开发者工具的 Security 面板显示的密钥交换；或用支持它的客户端探测，如 `openssl s_client -groups X25519MLKEM768`（OpenSSL 3.5 起，未核实）。这样网络上的旁观者录下的邮箱、OTP、`pw_auth` 与元数据也不怕"先录下、以后解密"。

**需要所有者提供**：Supabase 项目（URL、publishable/secret key、JWKS 地址）及其日志设置；`api.sixkey.app`（与开发域名）的 DNS；SMTP 服务商账号及其 DNS 记录；托管方案；商店扩展 ID；（Q6、Q9 已决，无需答复）；隐私政策文本的法律审阅。

### 9.1 Phase 0.x 加固（来自指纹浏览器调研，所有者 2026-10-15 全部采纳）

预算（硬约束，来自调研 §3）：**1 个 M + 7 个 S，不出现 L**；不新增任何 permission 或 host_permission；**Phase 0 仍然零网络**（CSP 与 check-dist 不变）；**不新增加密格式**（子集导出复用 `sixkey-backup` v1；安全记录是一个只含时间与类型的本地列表）；每项都带测试（PLAN §13 第 3 条）。这些项与同步无关，可以在 Phase 1 M1 之前或与之并行实施。所有者 2026-10-16 再次确认 H1–H8 全部采纳，并**授权 H1 在 M2 之前开始**。H1 改的是服务层的 `create`、`restoreBackup`、`startOver`，M2 也改服务层：后合入的一方在先合入的基础上变基，不构成新的依赖。编号 H*n* 对应调研的 F*n*；建议按 H1、H8、H2、H3、H5、H6、H4、H7 的顺序做。

| # | 项（调研编号） | 规模 | 改动范围 | 验收 |
|---|---|---|---|---|
| H1 ▲ | 首个账户前必须设主密码（F1）——**已决** | S（代码改动小；测试迁移是机械性的） | **服务层**（H-a）：`create(password)`、`restoreBackup(backup, password)`、`startOver(password)` 用新 VK 直接 `setPassword` + `setRecovery`，返回恢复码，**从不写设备包裹**（否则恢复出来的真实种子会以设备包裹的形式留在 LevelDB 残留里，而"从备份恢复"正是 H2 推荐给共享/厂商配置文件的路径）。**界面**：欢迎页去掉"不设密码直接开始"；"开始"与"从备份恢复"都先问主密码、再显示并确认恢复码（Z1）；已有的设备密钥库照常可用但持续警告。**测试迁移**（H-c）：`test/e2e/harness.ts` 的 `startFresh` 改为设密码后开始（并加入 H5 的首次运行问题）；`flows.spec.ts` 的语言测试（断言了被删按钮的中英文）、"加密备份恢复新安装"测试（加密码步骤、H3 的导出前重输密码）；`residue.spec.ts` 改用从 SW 预置一份设备密钥库的 fixture；约 27 处 `svc.create()` 调用（`service.test.ts` 16、`import-backup` 2、`enable-crash` 2、`write-read-mismatch` 2、`platform`/`clock`/`session`/`purge`/`store-misc` 各 1）改用测试 world 的辅助函数，另留一个只供测试的"建旧设备密钥库"辅助函数；i18n 键 `welcomeStart`、`noPasswordNotice` 只保留给旧库 | e2e：新安装在设密码前无法添加账户；旧设备密钥库（fixture）仍能打开并看到警告；**残留测试扩展**：在新配置文件里从备份恢复 → 扫描配置文件目录（`Local Extension Settings` 与 `IndexedDB`）→ 找不到任何种子明文、设备密钥或设备包裹；`npm run verify` 在迁移后全过 |
| H2 ▲ | 选择性加密导出（F2）——共享/批量配置文件的路径 | **M** | `core/backup`：`createBackup` 接收子集 Vault——只含选中的存活条目；排除回收站、墓碑与未选条目的任何字段；**新的 vaultId、新的条目 id、重新盖章的 HLC**（用一个随机设备后缀的临时时钟，不带源设备的 HLC 后缀与编辑时间），`createdAt` 取导出时间（H-d：接收方的同事看不出每个账户何时加入、改过，也无法把几个文件关联到同一台设备）；导入方走 added 模式按 secret + issuer + label 去重；`options/Backup.tsx` 的选择界面（Z3） | 属性测试：子集文件解密后不含任何未选条目的 id、名称、secret，也不含源 id、源 HLC 后缀；导入到另一个配置文件得到且只得到所选账户；再次导入更新后的子集时未改名的账户不重复（改名过的会作为新条目出现，由用户删除——H-d 放宽的验收） |
| H3 | 导出前重新输入主密码（F3） | S | `options/Backup.tsx` 的明文导出与加密备份两条路径；service 增加只读的"验证密码"调用（复用 `unlockWithPassword`，不改会话）。H1 之后新安装不再有无主密码可验的设备密钥库；旧库导出时显示警告 | e2e：已解锁但未重输密码时无法导出；错误密码计入 H6 的失败次数 |
| H4 ▲ | 安装来源自检（F4） | S | `chrome.management.getSelf()`（无需 `management` 权限）比较 `id` 与商店 ID 常量、`installType` 是否为 `normal` 或 `admin`（企业强制安装不提示，H-d）；popup/设置页横幅（Z5）；构建注入商店 ID（Phase 2 首次提交 CWS 后才有，之前留常量位）；dev/e2e 构建关闭，或在 e2e 中断言横幅出现。**如实说明它挡不住恶意副本**（恶意副本可以删掉这项检查），只用于发现不会自动更新的旁加载旧副本、并给用户一个可核对的 ID | 单元：各种 `installType`/id 组合；check-dist：prod 构建含商店 ID 常量 |
| H5 | 首次运行的风险提问 → 预设"每次都锁定"（F5） | S | 首次运行流程（Z2）；只改默认值，不加机制（`always` 模式已有）。把 A10 能读到 VK 的窗口从"闲置 15 分钟"缩短到"popup 或设置页打开期间" | e2e：选"是"后自动锁定模式为 `always`，并出现剪贴板清空引导 |
| H6 ▲ | 本地安全记录 + 安全状态卡（F6） | S | **独立的** `sk_security_log`（H-b）：`{v:1, entries: [{at, kind}]}`，上限 50 条，记录失败解锁、导出、改密码/轮换（已实现的种类见 §0.0j，供界面文字使用）；**不复用 `sk_events`**——那是"数据已恢复"横幅的数据源，混用会让失败解锁显示成"数据已恢复"、挤掉未读的恢复事件，清空安全卡也会清掉未读的恢复（D1 也依赖恢复事件保持原样）。设置页安全状态卡与"本机存了什么"清单（Z4）。只存本地、不含账户名；如实说明它是告警线不是证据（持有配置文件副本的人能改它） | 单元：计数、清零、上限；e2e：输错 3 次后解锁看到"3 次错误密码"，且没有出现"数据已恢复"横幅 |
| H7 | 本地纯文本密钥行导入（F7） | S | `core/import` 的 `planImport` 接受 `名称\|密钥` 与裸 base32 行；预览由用户确认密钥列；**其他列一律丢弃**、不保存密码（Z6）。把用户从会外传种子的 2fa.live、2fa.cn 拉回本地 | 单元：≥30 条边界用例（含多列、空列、非法 base32）；断言结果中不出现非密钥列的内容 |
| H8 | 文档《在指纹浏览器中使用 Sixkey》（F8） | S | 新建 `docs/guides/FINGERPRINT-BROWSERS.md`（内容见 §7，含"加入同步的配置文件绝不能被厂商同步或共享"，以及《AI 代理与自动化》一节——所有者 2026-10-16），设置页与商店说明链接到它 | 人工审阅；链接检查 |

调研中落在 Phase 1 的项（不计入上表预算）：F9 = d2（M2）、F10 = d3（M6）、F11 = d6（M4/M5）、F12 = d8（M5/M6）、F13 = d7（M2）。

**体验调研中与同步有关的决定**（`docs/research/ux-study.md` §7，所有者 2026-10-16）。这里只做交叉引用，不改 M0–M8 的内容与顺序：
- **侧边栏模式**（调研 U4，M8 之后）：需要新增 `sidePanel` 权限，并改 `scripts/check-dist.mjs` 的权限白名单。§7 的"不新增任何 permission"只管到 M8，侧边栏不属于任何同步里程碑。侧边栏按"一直开着的页面"处理：与设置页一样有 15 分钟闲置上限，关闭即丢弃 VK；网络仍只在 SW（§4.9）。"共享·自动化"预设下不提供。
  - **2026-10-20 交叉引用更新**：侧边栏模式不再排在 M8 之后。所有者要求现在就做，已在同步里程碑之外实现，见 `docs/design/notes/SIDEPANEL-NOTES.md`。`sidePanel` 加入 `check-dist` 的权限白名单（必需权限，不是可选权限）；同步的任何内容不变：侧边栏不发 `sk-api`，网络仍只在 SW；发布开关 `SYNC_UI_IN_STORE_BUILD` 关闭时，侧边栏与弹窗一样不含同步界面。上面三条中，"15 分钟闲置上限"与"共享预设下不提供"按原意实现；"关闭即丢弃 VK"有偏差：只在"每次都锁定"模式下成立（VK 只在侧边栏自己的内存里，关闭即消失）。标准预设（闲置 N 分钟）和"浏览器重启时"模式下，VK 在 `chrome.storage.session` 里由各页面共用，关闭侧边栏与关闭弹窗一样不会清除它，由自动锁定和 15 分钟闲置上限结束。偏差及理由见该笔记 §3 与 §9 第 3 项，待所有者确认。
- **"标准 / 共享·自动化"两个预设**（调研 U1，随 H5 一起做）：预设就是 §6 Z2 那一问的结果。"共享·自动化"= 每次都锁定 + 默认隐藏验证码 + 不提供侧边栏，并沿用 Z2 与 O1 已有的"这样的配置文件不要开启同步"。不新增同步状态。
- **"此网站"只给已登记域名**（调研 U1）：名称猜测降为"可能相关"。"记住此网站"写的是条目 content 寄存器里已有的 `domains`（`core/vault/model.ts`），按普通编辑同步，不改格式。它与另一台设备的并发改名按现有 LWW 只保留一方的 content；secret 不可编辑（I8），所以守卫不会因此阻塞。
- **U1b**（调研 O4，PHASE0X-PLAN A2，与 M2 一起或在它之前）：解锁时不再扫描快照，改用"旧密钥材料待清理"标记 `sk_keychange`。标记由 `VaultStore.transact` 自己写；M2 要遵守的协议见 §0.0i（它汇总并取代 §0.0h 的清单）。

---

## 10. 自我攻击复查

"已修复"指之前的稿子里有、后来改掉的问题；"残余"写进 docs/security/local-vault.md。第 28–54 条来自第一次独立评审，第 55–63 条来自指纹浏览器调研，第 64 条起来自最终评审（编号对应 `docs/audit/internal-reviews/SYNC-DESIGN-FINAL-REVIEW.md`），第 80 条来自 M0 重新同步（N27），第 81–87 条来自 M1 代码评审（修订 7，§0.0f），第 88 条来自 M1 实现说明（修订 8，§0.0h），第 89–90 条来自 G-M2 评审（修订 9，§0.0i），第 91–92 条来自 A4 与 C6 评审（修订 10，§0.0j），第 93–95 条来自 M4 评审与修复轮（修订 15、16，§0.0o、§0.0p），第 96–97 条来自 M4 复审（修订 17，§0.0q），第 98–100 条来自 M3 复审（修订 19，§0.0s），第 101–102 条来自 M3 第三次评审（修订 20，§0.0t），第 103–104 条来自 M5 评审（修订 21，§0.0u），第 105–106 条来自 M6 第二阶段（修订 25，§0.0y），第 107–108 条来自 M6C（修订 26，§0.0z），第 109–110 条来自后量子准备（修订 27，§0.0aa）。

| # | 攻击 | 结论 |
|---|---|---|
| 1 | 服务器替换新设备（或批准方）的临时公钥做中间人 | 配对码（两侧，2^-128：没有 S 就解不开、也做不出对方会接受的密文；修订 27 取代 CC）+ 承诺与 SAS（A 一侧的第二道，单次 10⁻⁶，配对码泄露时仍有效），每次失败用户可见（§3.2）。 |
| 2 | 承诺只覆盖 epk_N 和 n_N 时，服务器可在 N 揭示后磨出 SAS 相同的 dpk | 已修复：承诺覆盖 N 的全部贡献；approve 时提交 SHA-256(dpk_N) 供服务器核对。 |
| 3 | 批准方选错请求（攻击者用邮箱同时发起一个） | N 的数字只在 A 选中 N 的请求后才出现；A 的输入必须等于 A 自己算出的 SAS。 |
| 4 | 重放批准 / 把旧载荷给新设备 | 载荷绑定 h；状态机一次性；设备行在 complete 时才建立。 |
| 5 | 降级到免批准 | 客户端没有任何受服务器控制的"跳过"路径。恶意服务器谎称"还没有库"只会造成分裂（拒绝服务）。 |
| 6 | 恢复码路径泄露 | 服务器只见 `recAuth` 及其哈希；有限流；用恢复码加入会醒目提示并引导换新码。 |
| 7 | 回滚到旧 VK 加密的旧库 | 自动同步只接受钉住的当前 VK；服务器拒绝旧 vk_id 的写入；旧 VK 版本只在"找回账户"中显式使用。 |
| 8 | 持 VK 者 + 恶意服务器伪造 MAC 有效的 KeyBundle，把密码包裹换成垃圾 → 所有设备锁死 | 已修复：R2 只在用户证明新密码包裹后替换。残余：恢复码包裹仍可能被换掉，"恢复密钥已更换"横幅与"验证恢复密钥"让它可见。 |
| 9 | 偷到已解锁设备、不知道密码的人植入恢复码、劫持轮换、批准自己的设备、吊销你的设备、删除账户 | 已修复：`pw_auth` 由服务器强制；吊销对话框对"写过当前 KeyBundle 的设备"强制轮换，并连带吊销它批准的设备。 |
| 10 | 持 VK 者上传恶意内容 | §4.4：改 secret 或清除存活条目会阻塞；删除进回收站并提示；永久清除可从服务器历史和本机快照找回。两步删除的边界见 66（D6）。 |
| 11 | 抢注 | 残余，但已收窄：攻击者的批准设备显示的配对码只在攻击者屏幕上，必须线下骗用户输入（社会工程）；另有警告文字。 |
| 12 | 社会工程："请在你的 Sixkey 里输入 482 913" | 残余；批准页与新设备页的防诈骗文案；新设备加入会在所有设备上提示；吊销 + 轮换补救。 |
| 13 | 锁定设备采用了未经认证的 keyring | 已修复：远端 keyring 只进 staged，锁定时从不改写 generation。 |
| 14 | 轮换时新恢复码丢失 | 已修复：先展示并确认，再提交服务器；结果按 §3.6.0 对账。 |
| 15 | 时钟错误的设备与其他设备乒乓上传 | 已修复：HLC 用校正时间、两边夹紧、与原始远端比较。 |
| 16 | 同步途中被锁定，用失效会话提交 | `applyRemote` 走 `requireVk`，失败则下一轮重新拉取。 |
| 17 | 本地能存、云端拒收导致永久卡住；或超限后无法清理 | 已修复（第二版）：同一常量、同一度量；删除进回收站与永久删除是明确豁免，其余只拒绝让库变大的编辑（D3）；合并超限本地照存、只暂停上传。 |
| 18 | 克隆配置文件共用 refresh token | 不复存在：扩展不持有 refresh token。克隆本身见 §4.10。 |
| 19 | 邀请码在兑换前泄露 | 不适用：邀请码已决定暂不做（§3.4）。 |
| 20 | 恶意服务器无视吊销、隐藏设备、冻结或分叉版本 | 残余，威胁表中明说；此时保护只剩主密码强度。 |
| 21 | `keyring.previous` 上限 64 | 轮换时只丢弃最旧的；R2 只允许在新列表恰好 64 条时缺少最旧的那几条。 |
| 22 | 新设备在入网中途崩溃 | 已修复：先写本地再 complete，设备行在 complete 时才建；complete 幂等、结果不明时以签名的状态查询确认（D4）。 |
| 23 | 两台离线配置文件使用同一个 HOTP 计数 | 残余；先拉后用、先落盘后显示、立即上传。 |
| 24 | 小偷故意输错 `pw_auth` 让真设备的敏感操作被冻结 | 已修复（第二版，S2）：不锁定、不退避，只计数与告警；有效 `pw_auth` 不受限流约束。 |
| 25 | 诚实用户因未采用新密码而发出过时的 `pw_auth` | 已修复：发送前先拉最新 bundle 并在本地验证。 |
| 26 | 小偷互换设备名，诱导吊销错误的一行 | 已修复：任何改名都需要 `pw_auth`（S8 之后包括给自己改名）。 |
| 27 | 客户端与服务器对体积上限的度量不一致 | 已修复：envelope 以原文传输，度量就是原文字节数。 |
| 28 | **F1** 服务器冒充批准方，用自己的载荷让新设备把全部种子导入假库 | 已修复：CC（§3.2 M5–M6、MUST 5）；修订 27 起由配对码承担：只要配对码没有泄露，界是 2^-128；泄露时见第 110 条。 |
| 29 | **F2** 密钥操作提交成功但响应丢失 → 用户被告知新恢复码无效 | 已修复：按原文幂等 + 对账后才下结论；对账按关键部分判定（S4）。 |
| 30 | **F3** 本地恢复后后续编辑永远不上传，或旧本地覆盖新服务器数据 | 已修复：校验和判定 dirty；store 恢复前钩子清空 `lastSynced`（D1），outbox 保留为孤儿（修订 19，第 98 条）。 |
| 31 | **F4** 服务器回滚后永不拉取、PUT 在 409 上空转 | 已修复：(version, head) 不等即拉取；`base` = 本轮看到的头版本。 |
| 32 | **F5** 时钟快 >24 小时的设备每轮上传，冲掉快照 | 已修复：同第 15 条。 |
| 33 | **F6** 只持有设备签名密钥的人写入不可解的头版本 | 已修复：写入证明 + 头版本不可解时回溯合并。残余见 70（S7）。 |
| 34 | **F7** 持 VK1 者抬高 kver，借云端恢复把设备引回 VK1 | 已修复：IDB 钉住当前 vkId + 连续性检查；kver 不单独决定采用。 |
| 35 | **F8** 账户级限流让小偷或邮箱攻击者挤占吊销、同步、入网、登录额度 | 已修复：按设备限流、被拒请求不计入、有效 `pw_auth` 豁免、每会话 1 个入网请求、"拒绝全部"、OTP 按（邮箱, IP）计。残余：拥有大量 IP 的攻击者仍可耗尽单邮箱全局 OTP 额度（50 次/天）；副本持有者能刷满共用设备的同步额度（吊销 + 轮换后停止）。 |
| 36 | **F9** 小偷抢先 respond | 已修复：respond 需要 `pw_auth`。 |
| 37 | **F10** complete 之后、本地写入之前崩溃 | 已修复：先写本地再 complete；`different_vault` 提供"以云端为准重新加入"。 |
| 38 | **F11** "合并前快照"按原设计会在写入的同一调用里被删掉 | 已修复：不新增快照类型。 |
| 39 | **F12** 删除账户半途失败后无法重试 | 已修复：只删 auth 用户，级联清空。 |
| 40 | **F13** 三处隐私表述不实 | 已修复：如实改写；时间戳降精度（并扩展到 bundle，T1）。 |
| 41 | **F14** `pw_auth` 是固定值；`unlock-sensitive` 可被重放；失败计数有竞态 | 部分修复：删除 `unlock-sensitive`；先原子加一再校验。残余：截获请求体 + 设备签名密钥两者同时到手时可执行敏感操作；窗口内的六种重放（§5.2，第 93 条）。 |
| 42 | **F15** 合并后条目数超过 5000 | 已修复：条目上限只在新增时检查；超过 50 000 进入 `too_large`（D7）。墓碑永久保留（已决 Q9）。 |
| 43 | **F16** 守卫阈值太宽且把清除当作删除 | 已修复：清除存活条目或改 secret 即阻塞；删除进回收站并提示。 |
| 44 | **P1** 10⁻⁶ 的界依赖从未写明的钉住规则 | 已修复：§3.2 MUST 1–6 与 §8.1 对抗策略。 |
| 45 | **P2** `localKver` 先于 keyring 写入后崩溃 | 已修复：删除 `localKver`，按内容判定；钉住值修复规则（D8）。 |
| 46 | **P3** 只"改 previous"的 bundle 可以删掉历史 VK | 已修复：previous 必须包含本地的（64 条规则精确化）；auth 只随密码包裹变。 |
| 47 | **P4** 服务器上的校验值与包裹脱节 | 已修复：服务器无钥一致性检查。 |
| 48 | **P5** 设备一收到 401/403 就删除身份 | 已修复：只标记、停止同步，用户确认才删除。 |
| 49 | **P6** 吊销检查与写入不在同一事务等 | 已修复：设备行 `FOR SHARE` 锁（C3）；UPDATE 带过期条件；先验签。 |
| 50 | **P7** 数据库约束错误把整行带进日志 | 已修复：写前校验、不记录异常原文、terse 日志级别。 |
| 51 | **P8** A4 的保证说得过满 | 已修复："对已采用 VK2 的设备"。 |
| 52 | **P9** 批准方自己还停在旧 VK | 已修复：批准/轮换前必须处于服务器当前 vkId。 |
| 53 | **P10** "每次都锁定"模式下编辑要等下次打开才上传 | 已修复：outbox 在提交步骤里写，SW 快进推送；成功时本地 CAS（D2）。 |
| 54 | **P11** 规格精度十项 | 已修复，见 §0.0（邀请码剪贴板一项随邀请码取消）。 |
| 55 | **调研 A10**：连上配置文件调试端口（CDP）的本机进程在解锁期间读走 VK、种子或主密码 | 残余，如实不设防（§1.2）。缩短窗口：高风险配置文件预设"每次都锁定"（H5）；指南建议被脚本控制的配置文件不开同步（H8）。 |
| 56 | **调研**：厂商把配置文件（含 `storage.local`）同步到云端或复制给团队，设备密钥模式下等于交出种子 | 已修复：首个账户前必须设主密码，且新建与恢复从不写设备包裹（H1，含 H-a）；同步本就要求主密码（D4）；storage.local 里的 DSK 副本与邮箱都用 VK 加密。残余：密码强度是唯一屏障，副本 + 密码 = 隐形同步凭据（64，S1）。 |
| 57 | **调研**：IndexedDB 每次停止都被删 → 反复重新入网、设备行无限增长 | 已修复：VK 加密的 DSK 副本 + `identity_missing` 状态（§2.5）。 |
| 58 | **调研**：旁加载或被投毒的扩展副本；永远不会自动更新的旧副本用旧逻辑写入 | 部分：`min_client_version`；服务器不依赖 `Origin`；安装来源自检（H4）；指南要求只从商店安装（H8）。残余：恶意副本可以去掉这些检查。 |
| 59 | **调研**：克隆配置文件共用设备身份 | 已修复（M6）：写入时的 cursor 软检测 + 需 `pw_auth` 的"分出独立身份"，同时重新生成 `sk_device`（§4.10）。同一配置文件内的 PUT 由锁串行化，不误报。 |
| 60 | **调研**：把整个同步库放进多人共用或上厂商云的配置文件 | 产品层缓解：共享警告、§1.3 推荐做法、H2 子集导出。残余：用户执意加入时无法阻止。 |
| 61 | **调研**：身份记录里的明文邮箱 | 已修复：邮箱只在 VK 加密的副本里。 |
| 62 | **调研**：同事坐到已解锁的共享配置文件前导出全部种子 | 已修复：导出前必须重新输入主密码（H3）；导出记录进安全记录（H6）。 |
| 63 | **调研**：用户为批量生成验证码而使用会外传种子的网页 | 产品层缓解：本地纯文本密钥行导入（H7）。 |
| 64 | **S1** 配置文件副本 + 主密码经 DSK 副本恢复出同一设备身份，成为隐形的同步凭据 | 残余，如实写入 A3 与 §2.5；"加入同步的配置文件绝不能被厂商同步或共享"写进共享警告、O1 与 H8；`forked` 提示旁加"吊销并保护"。 |
| 65 | **S2** 永久的 `sensitive_locked` 让副本持有者冻结真设备的吊销与轮换 | 已修复：不锁定、不退避，只计数与告警；有效 `pw_auth` 不受限流约束。 |
| 66 | **D6** 持 VK 者先删除、再永久清除，两步都不阻塞 | 残余，如实写明；24 小时内先删后清时 danger 色横幅；快照与 30 天历史可找回；"清除服务器历史"需要 `pw_auth`。 |
| 67 | **S8** 副本持有者无需密码就能"吊销自己"，即吊销真设备 | 已修复：吊销自己、给自己改名、设备侧拒绝入网都需要 `pw_auth`。 |
| 68 | **S3** 恶意或出错的服务器时钟让所有已同步设备的验证码失效 | 已修复：TOTP 默认用本机时钟，校正由用户选择且限 ±1 小时。 |
| 69 | **S4** 别的设备在对账前又改了一次密钥，整份比较误报"新码无效" | 已修复：按关键部分对账。 |
| 70 | **S7** 数据库只读泄露（含 `write_key`）+ 锁定的配置文件副本 = 可写入 | 残余；坏头版本由回溯合并兜底；M7 的 KMS 层覆盖 `write_key`；轮换会更换它。 |
| 71 | **S5/S6** fork 新公钥无持钥证明；恢复码重置无发送前检查、失败不计数 | 已修复：新公钥签名（`Sixkey-New-Sig` 请求头，N1）；恢复码版本的发送前检查与计数。 |
| 72 | **D1/D2** 恢复写入没有清空同步状态的机制；outbox 推送让旧状态复活；并发页面写出过时 outbox | 已修复：store 恢复前钩子；outbox 在提交步骤内写、成功时本地 CAS；恢复时 outbox 成为孤儿而不是被删（第 98 条）。 |
| 73 | **D4** `init`/`complete` 响应丢失 → 误报恢复码无效或留下孤儿设备行 | 已修复：按原文幂等 + 以新身份签名的状态查询确认。 |
| 74 | **D5** 回滚后版本号被复用，设备快进覆盖了没见过的头版本 | 已修复：`head` 哈希参与 `needPull`。 |
| 75 | **D8–D11** 钉住值卡住、入网丢弃旧快照、锁互等、撤掉的身份被副本恢复 | 已修复：钉住值修复；旧快照重新加密；锁归属规则；一步删除全部同步状态。 |
| 76 | **T1/T2/T3** bundle 里的毫秒时间与写入设备、每次轮询的写库（WAL/PITR 时间序列）、多余的记录 | 已修复：小时精度；状态查询不写库、cursor 只在 PUT、`last_seen_at` 天粒度；删 `revoked_by` 与 `/v1/time`、降其他时间精度、清理未确认用户、日志到秒。保留 `by`（强制保护规则需要），服务器校验它等于签名设备。 |
| 77 | **C1–C4** 清除历史无接口、inbox 被更早的代码依赖、只开 RLS 不建策略导致 API 读写不了、`EXISTS` 不防并发吊销、若干不一致 | 已修复：`DELETE /v1/vault/versions`；删除 inbox；属主 + 策略；`FOR SHARE`；§11 与其他各处清理。 |
| 78 | **H-a** 从备份恢复时的设备包裹残留含真实种子，且这是共享配置文件的推荐路径 | 已修复：新建与恢复直接用密码 + 恢复码包裹，从不写设备包裹；残留测试覆盖"从备份恢复"。 |
| 79 | **H-b/H-d** 安全记录混进"数据已恢复"事件；子集导出泄露源 id 与编辑时间 | 已修复：独立 `sk_security_log`；子集导出用新 id 与新时间戳。 |
| 80 | **N27** 诚实回档后 kver 被复用，设备永久拒绝之后的 bundle、发送前检查挡住所有敏感操作；或落后的设备以相同 kver 发布不同内容被静默采用 | 已修复：发布取 `max(服务器 kver, maxSeenKver) + 1`、服务器接受跳号；只在 `kver > maxSeenKver` 时自动采用，否则内容不同即 `keys_behind`，唯一出路是以更高 kver 修复；R3 用旧密码时需确认；`keys_behind` 下吊销照常；身份恢复时 `maxSeenKver = 0`。 |
| 81 | **M1 F-01** 持 VK 者发布 kver = 2^53−1，此后任何 bundle 都无法发布，"吊销并保护"永久失效 | 已修复：`KVER_MAX_JUMP` 同时约束服务器接受范围与客户端分类；`publishKver` 封顶且溢出时抛错。 |
| 82 | **M1 F-02** 同 VK 的 bundle 用 64 个新生成的 VK 挤掉全部历史 | 已修复：同 VK 的 previous 无例外地必须包含本地真实条目；64 条例外只在轮换路径，且只许缺 `capPrevious` 会丢的那几条。 |
| 83 | **M1 F-03** 换了 vaultId、包裹原样复制的 bundle 被判为可采用 | 已修复：R0 要求 vaultId 一致（本地 keyring 不在时用身份记录的 vaultId）。 |
| 84 | **M1 F-04/F-05** 用户取消被在途步骤覆盖、仍返回带 VK 的请求体；approve 与轮询竞争被误判为篡改 | 已修复：§3.2 MUST 7（失败优先于在途步骤）与 MUST 8（approve 在途不轮询，`approved` 等同 200）。 |
| 85 | **M1 F-06/F-07** 普通云端恢复弹出"采用较旧的密钥状态？"，训练用户点"仍然采用"；只改 auth 的 bundle 不被拦 | 已修复：身份记录的 `adopted {digest, auth}`。 |
| 86 | **M1 F-08/F-09** 未验证的 bundle 参与分类（可抬高 `maxSeenKver`）；批准可以交出任意旧 bundle | 已修复：R0 先验证再分类、分类函数不暴露；发送前检查返回已验证对象，构建函数只接受它。 |
| 87 | **S-5**（修订 7 核实时发现）`rekey` 把全部 previous 条目的 `createdAt` 改成同一时间，"按 createdAt 丢最旧"实际丢的是随机一条 | 已修复：previous 的"最旧"按列表顺序；`capPrevious` 保留最后 64 条，R3 只许缺本地列表开头的一段。 |
| 88 | **M1-16** 本地 keyring 丢失时，持 VK 者重发上次采用的 keyring、只换 auth，绕过"auth 只能随密码包裹一起变" | 已修复：bundle 配上 `adopted.auth` 能复现 `adopted.digest` 而 auth 不同 → `auth_without_password`。 |
| 89 | **GM2-4** 清理从不把未知密钥下的副本交给回调，却清掉标记；§3.5 入网的旧快照与 M2 的两份 VK 密文可能停在旧密钥下 | 已修复：一个服务层清理入口；未知密钥副本先交给回调，打不开时同一 vaultId 保留、另一个 vaultId 丢弃；M2 的记录先于 `finishKeyChange` 重新加密。 |
| 90 | **GM2-5** 掉电丢了本地提交、IDB 的身份记录却已写入，设备卡在 `bad_mac` 或 `keys_behind`，修复又需要它没有的新 VK | 已修复：R1 的"内容相同"包括 `adopted.digest`，本机自己提交过的状态被采用回来、不弹确认；D8 的第二个方向（`needs_password` + R3）；钉住值与本地不同时按 R4 顺序解锁。 |
| 91 | **A4R-12** 永久删除按 id 清除，§3.5 入网后为"找回账户"保留的旧库快照里同一个 secret（added 模式换了 id）仍在 | 已定（M2）：永久删除也清除另一个 vaultId 副本中 secret 相同的条目（§0.0i 第 13 条）。 |
| 92 | **C6-8** 从同一个子集文件恢复的配置文件 vaultId 相同；入网时按 id 合并会带进对方的删除，② 失败时还无法加入 | 已定（M2）：vaultId 相同而密钥无关时按 vaultId 不同处理（added 导入 + `sk_prejoin`）。残余：Phase 0 两个这样的配置文件之间导入完整备份仍按 id 合并，真正的修法需要文件里的标记，属于格式变更，现在不做。 |
| 93 | **M4 S9** 签名窗口内的重放：`reject-all`、清除历史、被拒后的入网创建、"拒绝全部"后的恢复码入网、已签名 GET、改名 | 残余，接受（所有者委托决定）：不加 nonce 缓存，它会把 Chromium 的自动重发变成 401，而且只在一个进程里；`reject-all` 只删签名时间所在分钟及以前的请求。每一种都需要截获受 TLS 保护的已签名请求，都不暴露明文（§5.2）。 |
| 94 | **M4 A1** 设备行 `FOR SHARE` 之后更新同一行，两个克隆同时 PUT 互相死锁；设备、库、入网三类行没有固定的锁顺序 | 已修复：`FOR NO KEY UPDATE` 与全局锁顺序（设备 → 库 → 入网）；删除账户的级联是唯一反序，答 503 + 重试（§5.3、§5.7）。 |
| 95 | **M4 S3/S4** 知道设备 ID 的人能让服务器读 9 MiB 正文再以 `bad_signature` 失败；按设备的坏签名桶会被用来把真设备挡在外面 | 残余，接受：不加坏签名桶（它会成为把真设备锁在外面的杠杆）；窗口检查仍在读正文之后（P6 的错误顺序）。由 8 个大正文槽位（72 MiB）、60 秒正文超时与 M8 代理的限制限住（§5.5）。槽位是全局的一个池、在验签前占用，所以一个身份就能挡住所有账户的大写入（RR2）。 |
| 96 | **M4 RR6** 只知道邮箱的人耗尽受害者的验证码次数、填满每邮箱的每日发送上限，锁住该邮箱的恢复码入网、入网、init 与删除账户最长约 24 小时 | 残余，Phase 1 接受（所有者委托决定），不暴露任何数据（§1.2 A11）；M8 选定缓解（§9 M8 清单第 15 项）。 |
| 98 | **M3RR-3** 撕裂槽位后，恢复前钩子删掉了 outbox，而它是一次已确认保存的唯一活副本，那次保存从每台设备上消失（"每次都锁定"最糟） | 已修复（所有者委托决定）：钩子只清 `lastSynced`，outbox 保留为孤儿；孤儿只在 (base, head) 相符时推送，否则由持有 VK 的一轮作为第二个远端并入；只在服务器确认之后退役；不按时间老化（§4.7）。修订 20 起孤儿是一个列表（第 101、102 条）。 |
| 99 | **M3RR-1** 轮换的答复丢失后重试，报"什么都没发生"，而轮换与新码在服务器上已经生效 | 已修复：第一次发送前记待确认记录，重试时先对账再合并；可能已在服务器上生效时绝不报未生效（§3.6.0）。 |
| 100 | **M3RR-13** 诚实 PITR 之后，迟到的写入带着被复用的 `if_version` 覆盖另一个头版本 | M8：恢复栅栏，拒绝早于恢复时间的签名（§5.2，M8 清单第 16 项）；在此之前是暂时性的残余（§1.2 A5）。 |
| 101 | **R3R-1** 锁定推送删掉推不出去的 outbox（别处已写入、409、推送途中第二次保存），之后一次撕裂就让那次已确认的保存从每台设备上消失 | 已修复：未经 200 确认的 outbox 只在本轮已合并的库包含它时才删除；其余一律降为孤儿（与恢复钩子同一次写入）（§4.7）。 |
| 102 | **R3R-5** 孤儿等待期间的保存没有第二份活副本，第二次撕裂就丢失它 | 已修复：`lastSynced` 为空时写只用于合并的 outbox，恢复钩子把它追加为孤儿列表的新条目；暂时打不开的条目搁置而不阻塞同步（R3R-4），也不随关闭同步删除（R3R-2）（§4.7）。 |
| 103 | **M5 M-1** 放宽 manifest 的 `connect-src` 让 popup 与设置页也能连 API，"网络只在 SW"只剩构建的文本检查 | 已修复：每个页面带 `<meta>` `connect-src 'none'`，浏览器按交集执行；check-dist 断言它在第一个脚本之前（§7）。 |
| 105 | **M6** "丢失或被盗"：吊销与轮换之间停下，轮换就被忘掉；或为了准备轮换而推迟吊销 | 已修复：能准备时先显示并确认新码，再写"欠一次轮换"记录、吊销、轮换；不能准备时照样立即吊销；记录跨锁定与页面保留，只由生效的轮换清除；关闭同步需明确勾选（§3.10）。 |
| 106 | **M6** 服务器持有本机尚未采用的密钥时吊销被拒（`needs_adoption`）；服务器还要求扩展更新时，本机在更新之前无法吊销 | 接受的限制，如实写明：证明不能按未经验证的参数派生；出路是"更新本机"或从另一台设备吊销（§3.14）。 |
| 107 | **M6C** 跨过轮换的 PITR 之后，修复把较新的密钥交给一台被恢复"复活"的、已吊销的设备 | 已修复：修复先按粘住的设备列表再次吊销本机见过被吊销、而服务器列为有效的设备，并在表单上列出。残余：本机从没见过的吊销不在名单里，表单提醒先在"设备"里吊销（§4.2）。 |
| 108 | **M6C** 修复发出一个与密钥不符的密码校验值，使每台设备的 `pw_auth`（含吊销）都被拒 | 已修复：两种修复都先确认当前密码能打开本机的 keyring，否则什么都不发；auth 沿用已采用的那份，不换新 salt（§4.2）。 |
| 104 | **M5 §5 / D-1** 必需的 host 权限：安装警告针对一个还用不了的功能；更新会停用每个已有安装；只在本机使用的人也带着它 | 已修复：可选 host 权限，开启同步时请求、关闭时移除；生产环境不返回 CORS，权限就是网络开关；权限被撤销时同步暂停为 `permission_removed`，不丢数据（§7、§4.9）。 |
| 109 | **PQ** 录下批准入网的服务器，将来用量子计算机解出 ECDH，得到载荷里的 VK，进而解开它存过的全部库版本 | 已修复：入网密钥加入 128 bit、Sixkey 从不发送的配对码 S（`HKDF(Z ‖ S, h)`），设备名与载荷都在它之下；TLS 用混合密钥交换由 M8 核对（§3.2、§2.6、§9 M8 第 18 项）。 |
| 110 | **PQ** 配对码泄露到服务器一方（屏幕被看到，或复制后经系统的云剪贴板离开电脑），服务器冒充批准方，让新设备把本机账户导入它的库 | 残余（修订 27）：新设备一侧只有配对码一道；批准方一侧仍有 SAS（10⁻⁶）。缓解：［复制］旁的云剪贴板提示与 30 秒清空（§7），防诈骗文案（§6 O9）。以前的确认码 CC 在这种情况下仍能保护新设备，删除它是换取"不加第三次输入"的有意取舍。 |
| 97 | **M4 RR5** 直接暴露的 uvicorn：只打开、什么都不发的 TCP 连接占住 `limit_concurrency` 的名额，不会被关闭，整个服务 503 | M8 的硬性要求：从不直接暴露 uvicorn；代理必须有请求头读取空闲超时、按 IP 的连接上限、短于 60 秒的正文读取超时，`limit_concurrency` 大于代理的连接上限（§9 M8 清单第 10 项）。 |

---

## 11. OPEN QUESTIONS

目前没有需要所有者回答的问题。Q1–Q11 与调研清单的决定见 §12。

`pw_auth` 失败**不做退避**是对最终评审建议的有意偏离（理由见 §3.14：在线限次挡不住能离线猜的人，退避却会落在共用身份的真设备上，成为可按天续期的拒绝服务杠杆），不是待决问题。

---

## 12. 开放问题的决定（2026-10-15，所有者）

| 问题 | 决定 |
|---|---|
| Q1 IP 与托管日志 | 采纳推荐：不向 Supabase 转发 IP；限流在 FastAPI 内存中用日轮换密钥的 IP 哈希；托管商必须能关闭访问日志，**托管商仍待所有者选定**（M8 前）。 |
| Q2 单设备用户找回 | 采纳 (a)：开启同步时强制核对恢复码，只有一台已入网设备时持续提醒，提供"验证恢复密钥"。(b) 邮箱 + 主密码入网留作上线后的开关，不在首发。不做 (c)。 |
| Q3 邀请码 | **已决：暂不做**（2026-10-15 更新；原决定为排在 SAS 流程之后于 M7 实施）。共享或批量的配置文件用选择性加密导出（§9.1 H2）；设计不保留邀请码专用的部件（§3.4）。 |
| Q4 解锁摩擦 | 按推荐：Phase 1 不改，Phase 3 用 WebAuthn PRF。（所有者未单独回答，按推荐值执行，可随时推翻。）**2026-10-19 所有者补充**：快速解锁按 `docs/design/proposals/QUICK-UNLOCK.md` 执行——Touch ID / Windows Hello（WebAuthn PRF）为主，PIN 只作仅存于内存的后备（见 §13 F25 的同日注记）；每 14 天要求输一次主密码。（2026-10-27、2026-10-30 起 PIN 改为存在配置文件里、重启后也能用，见下文 F25 一行的注记。） |
| Q5 永久删除语义 | 按推荐：保持默认，增加"清除服务器历史"按钮，隐私政策披露。（同上，按推荐值执行。） |
| Q6 指纹浏览器是否复制扩展存储 | **已决（所有者授权由设计者定）**：不做实测，按最坏情况设计，即**默认这些浏览器会复制扩展存储，包括 IndexedDB 可能被清空**。设计已按此处理（§2.5 四种状态、§4.10 克隆检测），协议不依赖实测结果；三处细节只影响帮助文案，实际使用中遇到再改。 |
| Q7 团队共享 | 按推荐：确认不是 Phase 1 目标。（同上，按推荐值执行。） |
| Q8 服务器保存密码校验值 | 采纳：同意存放（C11 / §3.14）。 |
| Q9 墓碑回收 | **已决（所有者授权由设计者定）**：Phase 1 **不回收**，沿用 PLAN 3「墓碑永久保留」。理由：回收会让离线很久的设备把已永久删除的账户带回来，违背「永久删除」；而不回收的代价只是库变大，已有 `too_large` 暂停上传加可清理的兜底。M7 里的「墓碑回收」条目取消。仅当真实库逼近大小上限、`too_large` 在实际使用中出现时再重新评估。 |
| 调研 F1–F8（§9.1 H1–H8） | 采纳（2026-10-15）：全部按推荐实施，**含 H1"首个账户前必须设主密码"**（了结 PLAN §15 的悬而未决问题）。 |
| Q11 删除入网暂停 | **已决（所有者同意）**：删除。不再有 `enroll_paused_until`、`POST /v1/enroll/pause`、`423 enroll_paused`；"拒绝全部"保留（2026-10-15，见 §0.0d N26）。 |
| 2026-10-16 的决定（MCP 调研 Q1、Q3；体验调研 §7；H1–H8） | MCP Q1：不向 AI 代理返回验证码、种子或账户列表，写入 §13。MCP Q3：H8 指南加《AI 代理与自动化》一节（§7）。体验调研：侧边栏（M8 之后，新增 `sidePanel`）、两个安全预设、"此网站"只给已登记域名，见 §9.1 末尾的交叉引用。H1–H8 全部采纳，H1 获准在 M2 之前开始。见 §0.0g。 |

实施前置：协议部分（§2–§3、§10）须先经独立评审，评审意见处理完才开始 M1。（2026-10-15：评审 `docs/audit/internal-reviews/SYNC-DESIGN-REVIEW.md` 的 27 条已在修订 2 中逐条处理，见 §0.0；最终评审 `docs/audit/internal-reviews/SYNC-DESIGN-FINAL-REVIEW.md` 的 30 条已在修订 4 中逐条处理，见 §0.0c。最终评审认为 M0 可以立即开始，M1 在 T1 与 S4 写入后即可开始——两者都已写入。）

---

## 13. 明确不做（Non-goals）

来自指纹浏览器调研的"不做"清单（调研 §3）、所有者 2026-10-15 的决定，以及最终评审后删掉的机制。做这些要么违背零追踪 / 零网络 / 最小权限 / 永不丢数据，要么给的是虚假的安全感，要么复杂度远超收益。

| 不做 | 理由 |
|---|---|
| 邀请码（暂不做，所有者决定） | 前提（同一组种子进几十个配置文件）缺乏证据；它是一个 10 分钟的持有者凭证，外加一组端点。共享/批量配置文件用选择性加密导出（H2）。将来要加时见 §3.4 的一句话。 |
| WebRTC / DNS / IP 泄露检测（调研 F19） | 需要联网，与 2FA 无关，是反检测工具的地盘。 |
| 带 IP 或地理位置的登录提醒、IP 白名单（F18） | 违反 D3（不收集 IP）。Phase 1 已有不含 IP 的"新设备加入"横幅。 |
| 新设备加入时发邮件提醒（F17，暂不做） | 批准入网和恢复码入网都要求新设备先过邮箱 OTP，攻击者通常已经控制邮箱、能删掉邮件；价值低于 SMTP 模板与防滥用的成本。邀请码取消后，所有入网路径都经过邮箱，这一判断更成立。 |
| 内容脚本自动填码（F20） | 需要内容脚本和 host 权限；其宣传用途是规避风控，超出范围；还会让 Sixkey 变成网页可以接触的攻击面。 |
| 团队角色、"能用码不能看种子"的成员权限（F21） | 能生成验证码的客户端必然持有种子，这类权限只能在客户端强制（Bitwarden、1Password 自己都承认），给的是虚假的安全感。真做需要每人独立密钥，即已决 Q7 说的另一套设计。 |
| 限时分享验证码（F22，Phase 1 之前不做） | 需要新格式或服务器；同事拿码登录后 cookie 会话照样在他手里，增量价值有限。等 H2 上线后看需求。 |
| Sixkey 同步账户本身的 TOTP 二次验证 | 账户会话读不到任何东西（§0.1），数据由设备签名、批准入网和主密码把守；再加一层只会增加找回负担。 |
| 错误密码 N 次锁定或自毁（F23） | 对复制走的配置文件做离线爆破不受 UI 限制；自毁违反"永不丢数据"，还会变成同事手里的拒绝服务按钮。用 H6 的告警代替。 |
| 服务器端 `pw_auth` 失败后的锁定或退避（最终评审 S2） | 任何能以某设备签名的人都能拉到密码包裹去离线猜，在线限次挡不住他；锁定或退避却会落在与副本共用身份的真设备上，让用户无法吊销、轮换。只计数并告警。 |
| 向 AI 代理返回验证码、种子或账户列表（MCP 或任何代理通道；所有者 2026-10-16，MCP 调研 Q1） | TOTP 的价值在于"只有持有设备的人才能在 30 秒内拿出这串数字"。代理一旦能按需取码，第二因素就变成"任何能操纵这个代理的东西"：网页、邮件、工具输出里的提示注入至今没有可靠解法，泄露的码在有效期内可被立即中继。MCP 的批准界面归客户端，可以被自动代答，挡不住这一点。头部厂商（1Password、Dashlane）的公开原则相同；而且任何通道都要新权限、本机程序或服务器中转。将来若做"交接"，代理只能请求，码只出现在用户亲手打开的 Sixkey 弹窗里，从不进入返回值（调研 §6 的触发条件）。 |
| 远程抹除 | 离线副本无法保证被抹掉，承诺了也兑现不了。诚实的版本是吊销、轮换、到网站重绑（§3.10）。 |
| 检测"是否运行在指纹浏览器或自动化环境中" | 近似于浏览器指纹，而厂商会伪造 `navigator.webdriver` 等信号，不可靠。改为直接问用户（H5）。 |
| 多保险库 / 按分组密钥同步（F24） | L 级。在那之前用 H2，或每人一个独立的同步账户。 |
| "记住我" / PIN（F25） | 等于把设备密钥放回配置文件，而厂商会复制配置文件（已决 Q4）。**2026-10-19 所有者修订（只收窄，不推翻）**：**存放在配置文件里**的 PIN 或"记住我"仍然不做；**只存在内存里**（`chrome.storage.session`）的会话解锁获准——Sixkey 自己的 PIN（作为后备），以及没有 PRF 时只作门禁的 Touch ID / Windows Hello（这时解锁所需的密钥原样留在内存里，挡不住本机程序，界面如实标为"便利级"；所有者 2026-10-19 确认二者同属这一类：磁盘上没有任何东西能打开库，浏览器重启即失效）：浏览器重启、输主密码 12 小时后、输错 5 次、任何密钥变更即失效，"共享/自动化"模式下不提供。见 `docs/design/proposals/QUICK-UNLOCK.md` §0.5 Q1。**2026-10-27、2026-10-30 所有者再修订（OWNER-DECISIONS/20）**：PIN 改为存放在配置文件里（`sk_pin_restart`，VK 包在由 PIN 派生的密钥下，只在本机、不同步），先是可选开关，2026-10-30 起每个 PIN 都这样：重启后也能用，没有时间限制，唯一的限制是连续输错 5 次；密钥变更暂停它，"共享/自动化"模式下仍不提供；代价（拿到配置文件副本的人可以离线猜 PIN）在设 PIN 处如实提示。见 `docs/design/notes/PIN-RESTART-NOTES.md` §18。 |
| 用系统钥匙串或 native messaging 保存设备密钥 | 需要 `nativeMessaging` 权限和本机安装程序，破坏"只是一个扩展"的定位；配置文件被同步到另一台机器时钥匙串不跟着走，会导致无法解锁。 |
| 单独的"抹掉本机数据"按钮（Phase 0 与 Phase 1 都不做） | 卸载扩展效果相同。真正需要的是说明"厂商云端或复制出去的副本不会因卸载而消失"（§7、H8）。 |
| 每设备持久的 VK 包裹 | 设备私钥只能放在配置文件里，等于 Phase 0 的设备密钥；拿到配置文件副本即可不经密码解出 VK（§2.1）。 |
| 锁定时预拉取远端内容（原 inbox，最终评审 C1） | 只在"锁定时在线、解锁时离线"这种少见情况下有用，却让守卫与锁定中断都依赖一个本应可选的部件。解锁后直接拉取最新的即可。 |
| 入网暂停开关（原"拒绝全部并暂停 24 小时"；已决 Q11） | 每个账户会话 1 个请求、OTP 限流与 10 分钟过期已经限住了刷请求；"拒绝全部"覆盖了界面需求。删掉少一列、一个端点、一个错误码和它与恢复码入网的联动。 |
| 在状态轮询上做克隆检测（最终评审 T2） | 每次轮询写库会在 WAL/PITR 里留下每台设备的轮询时间序列，还要求跨上下文的锁规则；只读的克隆本来无害。只在写入时检测。 |
