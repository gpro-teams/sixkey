# 预算整理 3：保险库页面的文字体积，回收站的“由插件 X 移入”，PIN 重启开关进安全记录

日期：2026-10-29（r2 同日）。状态：**已实现；独立审查结论“可以合入，没有阻断项”，r2 按审查修改（§10）**。所有者 2026-10-29 同意三件事（OWNER-DECISIONS/19 问题 3：现在就画回收站的标记；
OWNER-DECISIONS/20 补充问题 3：开关的开启和关闭记进安全记录；两者都要先整理体积）。方案由维护者从第一阶段的研究
（快照目录 `budget3/STUDY.md`）里定下：只用不改规则、不改用词的整理 (i)，不放宽任何上限。以代码为准；本文与代码不一致时，
以代码和测试为准，并请指出。

文中数字：字节都是 gzip 后、按 `scripts/check-dist.mjs` 的计法（zh_CN 较大的那种语言在前，en 在括号里）；“基线”是 539e9f6。

> **2026-10-30 补记（PINONE，OWNER-DECISIONS/20 第二条补充）：第 3 件已随开关一起删掉。** 所有者决定 PIN 一直能用、只限连续输错
> 5 次，“重启后也可以”开关整个去掉（`docs/design/notes/PIN-RESTART-NOTES.md` §18）。开关没了，就没有东西再记 `pin_restart_on`、
> `pin_restart_off`：按本文 §5.1 定下的规则（`budget3-rules.test.ts`：表里每个种类都要有人记），这两个种类从 `SECURITY_KINDS` 删掉，
> 两句文字 `secKRestartOn`、`secKRestartOff` 和 SecurityCard.tsx 里的两个标签一起删，`test/unit/budget3-pin-restart-record.test.ts`
> 整个删掉（它测的 §5.2 每一行都不存在了）。已经记下的这两种旧条目照“新版本的种类”处理：留在记录里、照常计数和裁剪，只是不列出
> （security-log.ts 只按格式认种类）。种类表挪出弹窗（§5.1）、第 1、2 件都不变。下面 §1、§2、§5、§7、§8 里讲这两个种类的地方
> 保留原样作为历史。

---

## 1. 做了什么

| 件 | 做法 | 落在哪 |
|---|---|---|
| 整理体积 (i-a) | 4 处两种语言都逐字相同的键合并成一个：`protPassword`→`passwordLabel`、`restoreAction`→`restore`、`afsOn`→`clipOn`（全目录），`pxTitle`→`pxMenu`（设置页的插件目录） | Rail.tsx、Backup.tsx、Misc.tsx、Plugins.tsx；`scripts/i18n/budget3.py` 的 `REMOVE` |
| 整理体积 (i-b) | 去掉从没记过的预留种类 `oath_on`、`oath_off` 和它们从不显示的标签 `secKOathOn`、`secKOathOff` | security-kinds.ts、SecurityCard.tsx、budget3.py |
| 回收站的标记 | 插件移入、用户确认的账户旁画“由插件 $1 移入”；恢复后标记随之去掉 | `src/ui/plugins/trash-marks.ts`（新，平台的懒加载块）、Misc.tsx `Trash`、grants.ts / store.ts `unmarkTrashed` |
| 安全记录 | 新种类 `pin_restart_on`、`pin_restart_off`；种类表挪出弹窗：共享的记录类只按格式认种类，名字只在设置页 | `src/core/service/security-kinds.ts`（新）、security-log.ts、SecurityCard.tsx、pin-restart-admin.ts、pin-admin.ts、service.ts |
| 规则的说法 | messages.py、check-dist 的注释改准确：那条 15,360 量的是“保险库视图 + 4 个懒加载目录”，不含 firstrun | §6 |

没有改任何上限（15,360、12,288 和各目录的预算都不动），没有改任何已有的界面用词；新加 3 个键（§7，2026-10-30 已定）。

## 2. 体积（实测，check-dist；基线 539e9f6 → 本补丁 r2）

| 项 | 基线 | 本补丁 | 增量 | 上限 | 余量 |
|---|---|---|---|---|---|
| **保险库页面 + 全部懒加载目录**（`PLUGINS_VIEW`，zh；en） | 15,265（13,599） | **15,258**（13,597） | −7（−2） | 15,360 | **102**（≥ 80） |
| 设置页，每个部分（zh；en） | 12,112（10,711） | 12,116（10,720） | +4（+9） | 12,288 | 172 |
| 设置页，有保险库（zh） | 11,592 | 11,597 | +5 | 12,288 | 691 |
| 保险库视图 + shares（所有者原话管的那一项，zh） | 12,876 | 12,880 | +4 | 15,360 | 2,480 |
| 保险库视图 + firstrun + 全部懒加载目录（真正最多能装的，zh；不受任何上限管，§6） | 15,783 | 15,776 | −7 | — | — |
| settings-core / security / backup / misc（zh） | 3,885 / 3,360 / 1,207 / 1,456 | 3,880 / 3,372 / 1,192 / 1,469 | | 5,120 / 5,120 / 3,072 / 3,072 | |
| 设置页的插件目录 `plugins`（zh） | 1,951 | 1,946 | −5 | 3,072 | |
| 弹窗，关门（总计 = 静态 + 目录） | 58,260 = 53,787 + 4,473 | **58,090** = 53,617 + 4,473 | **−170** | 61,440 | 3,350 |
| 弹窗，开门 | 59,535 = 54,864 + 4,671 | **59,366** = 54,695 + 4,671 | **−169** | 61,440 | 2,074 |
| 侧边栏，关门 | 60,488 = 56,015 + 4,473 | **60,319** = 55,846 + 4,473 | −169 | 63,488 | 3,169 |
| 侧边栏，开门 | 61,761 = 57,090 + 4,671 | **61,593** = 56,922 + 4,671 | −168 | 63,488 | 1,895 |
| **`sidepanel-check-dist` 填充测试**：塞 3 KB 后的静态部分 | 63,475 | **63,305** | −170 | 63,488 | **183**（基线 13） |

各项的分账（与 check-dist 同一算法，快照目录 `budget3/tools/cat.py`，在基线的目录上逐项单独量，zh）：

| 改动 | 视图 | 每个部分 |
|---|---|---|
| `secKOathOn`、`secKOathOff` 去掉 | −27 | −32 |
| 4 处合并（`protPassword` −4、`restoreAction` −7、`afsOn` −3、`pxTitle` −5） | −19 | −15 |
| 第 2 件 `trashBy`（misc） | +15 | +15 |
| 第 3 件 `secKRestartOn`、`secKRestartOff`（security） | +27 | +32 |
| 合起来（gzip 跨项的重复，比逐项相加少 3 B） | −7 | +4 |

弹窗、侧边栏少了约 165–170 B：种类表（30 个名字）不再在它们的包里（§5.1）。其中 r1 → r2 又少的 6–8 B 不是代码改动带来的：
弹窗和侧边栏各块的原文字节数和 r1 完全相同，差别来自懒加载块文件名里的哈希（静态块里 import 的字符串变了），gzip 后差 1–3 B 一块；
§2 表里的数是实测值，只是这几个字节不该算作 r2 的收益（复核的 B3-11）。第 2 件的代码只在设置页，两者都没有增加一个字节——但这是改了
两次才做到的（§4.5）。

## 3. 整理 (i)：去掉了什么，为什么不算改用词

### 3.1 (i-a) 4 处合并

| 去掉的键 | 用来代替的键 | en | zh | 唯一的用处 |
|---|---|---|---|---|
| `protPassword` | `passwordLabel` | Master password | 主密码 | 侧栏的保护级别（Rail.tsx） |
| `restoreAction` | `restore` | Restore | 恢复 | 备份页的“恢复”按钮（Backup.tsx） |
| `afsOn` | `clipOn` | On | 已开启 | 自动填写页的网站状态（Misc.tsx） |
| `pxTitle`（插件目录） | `pxMenu`（同一目录，共享词） | Plugins | 插件 | 设置 › 插件的标题（Plugins.tsx） |

显示出来的字逐字不变，两种语言都是（`test/unit/budget3-rules.test.ts` 钉住了每个键现在的文字）。代价：这两处界面从此共用一个键，
将来要只改其中一处的措辞时得重新拆开。维护者没有采纳的第五处：`ungrouped`（导出子集里“没有分组”的标题）和 `grpAccounts`
（侧栏的分组名）两种语言碰巧相同，但意思不同，不应共用一个键，保留。

### 3.2 (i-b) 预留种类 `oath_on`、`oath_off`

它们是 YUBIKEY-DESIGN §5.1 R8 在 M2 那次升版本时一并预留的，从来没有代码记过（`git log -S` 只有引入它们的那一次提交），所以标签
从不显示。预留的理由——旧版本读到新种类会停止追加——已经被 SYNC-DESIGN 修订 25 取代：每个版本改写记录时都保留不认识的种类，
新种类不再需要升版本。YubiKey 功能做的时候连同种类和标签一起加回来即可（YUBIKEY-DESIGN 补了一句）。

维护者要求先查清的两件事：

1. **同步或备份里会不会已经带着 `oath_*` 条目？不会。** 安全记录只在 `sk_security_log` 这一个键里，只有 `security-log.ts`
   读写它（SecurityCard 只监听它的变化）；备份和导出由保险库生成，镜像只存保险库的副本，同步只传加密的保险库和密钥包，诊断文件
   也不含它（`security-log.ts` 页首；`test/unit/security-log.test.ts` “touches its own key and nothing else”）。别的设备、
   旧版本都不可能把条目带进来；何况从来没有版本写过 `oath_*`。Chrome 的整个配置文件同步不同步 `chrome.storage.local`。
2. **去掉之后读到这种条目会怎样？保留，不显示，不出问题。** `oath_on` 符合种类的格式：记录照样读回、改写时逐字保留、照样算进
   50 条的裁剪；不算输错次数；设置页的卡片没有它的标签，不列出（`budget3-dom.test.ts`、`m2-source-rules.test.ts` R8 一条）。

### 3.3 没做的（维护者定）

- (i-d) 去掉每个键外面那层 `{message:…}`：能再省视图 332 B、弹窗计数的目录约 105 B，但要动每个页面取文字的路径，留到下一次。
- (ii) 换成“视图 + 任意一个懒加载目录 ≤ 15,360”加一个讲得清理由的总上限：这次不做（§6）。

## 4. 第 2 件：回收站里的“由插件 X 移入”

### 4.1 数据从哪来

W2b 在 Apply 之后把移入回收站的账户 ID 记进那个插件的授权条目（`trashed`，最新的 5,000 个，`grants.ts markTrashed`）。
`src/ui/plugins/trash-marks.ts trashMarks` 只读**用这个页面持有的保险库密钥校验过的**授权记录（`withFreshKeys`、
`GrantStore.read`）：锁着、记录的标签对不上、没有记录，一律没有标记；页面提示 `sk_plugins_any` 不在（这个配置文件没有批准过插件）
就连存储都不读。设置 › 回收站在已解锁、回收站不空时用 `import()` 加载它；弹窗和侧边栏都没有回收站，也到不了这个块。

### 4.2 显示什么名字（插件后来被移除、改名、换版本）

和“设置 › 插件”那一行画的是同一个名字（`provenanceOf` 的 name：`policy.ts shownName` 再经 `text.ts displayText`，同一个
install），所以：

| 情形 | 显示 |
|---|---|
| 官方或已列出（目录里有）的插件 | 目录里的名字，Chrome 里改名也不变 |
| 按 ID 添加的插件，Sixkey 持有 `management` | Chrome 现在的名字：改了名就显示新名字，和插件那一行一致 |
| 没有 `management`，或插件已从 Chrome 卸载 | 批准时它报的名字（页面语言的那一种） |
| 换了版本 | 名字不受影响；插件暂停、关闭、被封都照样显示（标记是已发生的事） |
| 从“设置 › 插件”移除 | 授权条目连同标记一起删掉，这些账户在回收站里不再有标记 |
| 名字用了受保护的词，或清理后什么也不剩；条目读不出名字 | 它的 ID（和插件那一行一样） |

插件自己给的文字一律经平台画插件文字的规则（§7.3 第 1 项 `displayText`：NFKC；去掉控制字符、双向控制字符、默认可忽略字符和
孤立代理项；最多 40 个字符），作为文本节点画出，不当标记解析。说明：平台的这条规则是**去掉**孤立代理项，不是换成 U+FFFD
（U+FFFD 是 `toWellFormed`，用在 Sixkey 发给插件的消息里）；这里照平台已有的画法，与“设置 › 插件”一致。没有新增任何文字，
也没有“未知插件”一类的退路：找不到名字就显示 ID。

### 4.3 恢复以后（审查人请重点看）

只记 ID、不记时间，所以一个被插件移入、后来用户恢复、再后来用户自己又删除的账户，会被误标成“由插件移入”。为此：在回收站点“恢复”、
恢复的写入成功之后（只看这一次写入，不看页面之后的 reload 成不成功：r2，B3-04），如果这一行有标记，就把这个 ID 从所有插件的条目里
删掉（`forgetMarks`：新密钥、清理未完成时跑一次清理再试一次，和 W2b 记标记的写法一样；`grants.ts unmarkTrashed` 只动这些 ID）。

这次写入是一次**记账性的写入**（`GrantStore.write` 的 `onlyVerifiedChange` 选项；r2 叫 `tidy`，后续补丁按行为改了名，§11）：只在授权记录通过校验、
并且确实有要去掉的 ID 时才写。
记录校验不过时一律不碰 `sk_plugins`、也不放到 `sk_plugins_unverified`，原样留着——这正是 store.ts 页首对校验不过的记录定下的规则
（“原样留着，直到用户再批准一个插件”）；一个 ID 都找不到时（比如插件在另一个标签页里刚被移除）也不写，epoch 不变。没有另开写入路径：
同一个 `write`，多一个选项、两行判断。后续补丁里 W2b 的 `markTrashed` 也改用它（§11）。

残余：别处的恢复不经过这里（同步从另一台设备带来的恢复、`sync-flows.ts` 的冲突处理），之后用户在这台设备上再删除，标记会回来；写入
失败、记录校验不过时也一样。都不会抛异常，也不碰账户本身。根本的办法是让标记带上插件移入时这个账户的删除时间戳（`dhlc`，W2b 的
`markOf(e)` 里已经有），回收站只在账户当前的 `dhlc` 等于标记里那个时才画；要改 W2b 的 `trashed` 格式，留作后续（§9）。

### 4.4 为什么文字放 misc

回收站本身在 misc 部分，用 `t("trashBy", name)`；名字由平台块交回，平台模块仍不用 Sixkey 自己目录的词（源码规则不变）。放进懒加载的
`plugins` 目录视图一样 +14、“每个部分”不加，但回收站就得去加载平台的文字模块，多一层耦合，不值得。

### 4.5 打包器重新分组：两次实测

第一版 `trash-marks.ts` 从 `ui/plugins/view.ts` import `HINT_KEY`，弹窗计数的包 +12 B（弹窗插件块的预加载列表多了一项
`Entries-*.js`）；改成照 view.ts 拼写锁定纪元键的做法重写一遍键名之后，又因为从 `slots.ts` import `provenanceOf` 而多了一个
`slots-*.js`，+18 B。现在只 import `policy.ts`、`store.ts`、`text.ts`、`platform/plugins/chrome.ts`、`ui/i18n.ts`
（`budget3-rules.test.ts` 钉住），弹窗的入口块（`boot`）回到 10,128 B（基线 10,129 B），预加载列表与基线相同。SHAMIR-NOTES §7 的教训又一次成立：给弹窗也用的
模块加一个新的懒加载入口，要先在开门、关门两种构建里量过。

## 5. 第 3 件：PIN 重启开关进安全记录

> 2026-10-30 起已删除（开关去掉，见文件开头的补记）：§5.2 的表和 §5.2 之后的讨论只是历史；§5.1 的种类表照旧。

### 5.1 种类表挪出弹窗（方案 (b)）

- `src/core/service/security-kinds.ts`：种类表 `SECURITY_KINDS` 和类型 `SecurityKind`，每个种类什么时候记都写在这里。只有
  `security-log.ts`（`import type`）和 `SecurityCard.tsx`（`import type`）引用它：没有哪个页面的包带着这张表。
- `security-log.ts`：共享的记录类（弹窗、侧边栏、设置页、后台都建它）只按**格式**认种类：一个小写 ASCII 字母开头，后面是小写
  ASCII 字母和下划线，一共 1 到 32 个字符（`/^[a-z][a-z_]{0,31}$/`，写在 `isKind` 里，不做模块常量：弹窗的包带着这个类，
  常量要多 15 B）。不是这个格式的不写；是这个格式的，不管哪个版本写的，读回、保留、改写时逐字不动（不变量，`security-log.test.ts`
  用 fast-check 随机生成格式合法的种类和额外字段验证）。
- “不显示不认识的种类”从记录类挪到设置页的卡片：只列 `KIND_LABEL` 自己有的属性（`Object.hasOwn`，所以 `constructor` 这种
  格式合法的名字也不会被当成有标签），“更早的 N 条”只数列出的。
- 调用方仍受 `SecurityKind` 类型约束；源码规则另外保证：每个 `record("…")`、`["record"]("…")`、`guarding("…")` 的字面量都在表里，
  表里每个种类都有地方在记（不会再有没人写的预留），卡片的标签与表一一对应且都有文字（`budget3-rules.test.ts`）。
- 从参数拿种类的公开方法有两个。页面直接调用的只有 `recordExport(kind)`（设置页导出之后）：以前靠记录类的名字表挡住不认识的导出
  种类；现在 `export_` 加任何小写词都符合格式，所以它自己核对 `ExportKind`（三种之一），否则什么也不记（`service.test.ts`
  “recordExport … ignores anything that is not one”原样通过；它在全量单元的第一轮里抓到了这一处）。另一个是 `SyncFlows.recordAction(kind)`，
  只由同步引擎调用（不在弹窗的包里），运行时不核对：它的参数是 5 个名字的联合类型，调用处都是引号里的名字（源码规则钉住，见下）。
- 源码规则（r2 收紧，B3-05；后续补丁再扩，B3-10）：`record(…)`、`["record"](…)`、`recordAction(…)`、`guarding(…)` 和记录类
  自己的 `security.append(…)` 的第一个参数，在所有模块里（插件平台的目录也不例外），要么是引号里的、表里的名字，要么是规则里点名的
  10 个带类型的参数（`unlockWith` 的 `failed` / `used`、`guarding` 的 `failed`、`committed` 的 `kind`、`recordExport` 里的
  `` `export_${kind}` ``、`record()` 自己转给 `append` 的 `kind`、PinAdmin 的转发、SyncFlows 的两处转发、同步引擎里两个名字的三元式）；
  反引号模板、别的标识符、强制类型转换都会被抓住，名单也不会过期（名单里的每一项都必须还在）。不算种类的只有两样：函数定义里带类型的
  参数，和对象字面量——那是插件平台自己的日志条目（`PluginSession.record({ at, … })`），插件目录里除此之外没有别的 `record()`。
- 实测：弹窗、侧边栏的静态部分少约 165–170 B；侧边栏填充测试余量 13 → 183（§2）。

### 5.2 什么时候记

| 情形 | 记录 |
|---|---|
| 开启（主密码） | `pin_restart_on`，记录写成之后 |
| 换密钥或改主密码后重新开启（主密码，或刚换完 10 分钟内只输 PIN） | `pin_restart_on` |
| 拒绝：主密码错、PIN 太短、共享配置文件、锁着；记录没写成（密钥或 PIN 的设置在这期间变了） | 只记它本来就记的（`unlock_failed`、`pin_failed`），不记开关 |
| 用开关关闭，删掉的是 Sixkey 自己做的记录 | `pin_restart_off` |
| 用开关关闭，删掉的是别人塞进来的记录（MAC 对不上），或这个页面锁着、无法判断 | 只删除，不记 |
| **暂停期间改了 PIN**（记录随旧 PIN 一起删掉，开关变成关） | **`pin_restart_off`**，紧跟在 `pin_set` 之后 |
| 开着时改 PIN（用新 PIN 重做，开关仍开） | 只有 `pin_set` |
| 配置文件设为“共享或由脚本控制”（记录被删） | `pin_restart_off`（保存前在保险库仍打开时判断：设为共享是一次硬锁定） |
| 移除 PIN | 只有 `pin_removed` |
| 新保险库（首次创建、恢复备份、重新开始） | 不记 |
| 开关仍开着的结束：输错 5 次、换密钥暂停、“立即结束快速解锁”、14 天到期 | 不记（和 `quick_ended` 的规则一致：开关那一栏会说它在等什么） |

**暂停期间改 PIN 算不算“自动结束”（维护者的问题）。** 按“用户能不能看懂自己的安全记录”来定，记 `pin_restart_off`。这个开关是
用户特意打开、长期有效的设置，而且是较弱的一条路（配置文件副本可以离线猜 PIN）。如果不记，记录里关于它的最后一行是“开启了 PIN 的
‘重启后也可以’”，而开关其实已经关了——用户读记录会以为它还开着。记了以后，记录读起来是“开启了 … → 更换了加密密钥 → 设置了 PIN
→ 关闭了 …”，前因后果都在。这和 `quick_ended` 不记硬锁定并不矛盾：会话快速解锁本来就短命（12 小时、浏览器关闭为止），它结束
是常态；而这里是一个持久的开关变了状态，并且不是用户点开关造成的。同一理由也用在“设为共享”上。移除 PIN 不另记：“移除了 PIN”
已经说明所有基于 PIN 的方式都没了，就像移除 PIN 时不另记 `quick_ended`。只对 Sixkey 自己做的记录记 `pin_restart_off`，免得
一条被塞进来的假记录被删时，记录里出现“用户关闭了开关”。

## 6. 那条 15,360 量的是什么（说法改准确，规则不变）

所有者 2026-10-23 的原话（SHAMIR-NOTES §6）管的是“保险库视图 + shares”。后来 PRF、插件、PIN 重启把 device、plugins、restart
也加进同一个数（工程上的延伸）。messages.py 的注释把 `DEVICE_VIEW` 说成“一个保险库页面最多能装的”，check-dist 也有类似的话——
不准确：有保险库的页面还能从“备份”或“高级 › 重新开始”打开首次运行向导，于是加载 firstrun 部分。算上它，真正最多能装的是
15,783 B（基线；本补丁 15,776），没有任何上限管它。这次只把注释和本说明改准确：那条 15,360 量的是“保险库视图 + 4 个懒加载目录”；
规则本身没改。要不要换成“视图 + 任意一个懒加载目录 ≤ 15,360”，再给“最多能装的”一个单独、讲得清理由的上限（例如按每个预算的老
规矩：实测加至少 1.5 KB，向上取整到 512 B），是维护者以后的决定。放宽的真实代价很小：这些是扩展包里的本地文件，不走网络；
V8 编译加运行全部 43 KB 原文约 0.45 ms，堆上约 90 KiB；懒加载目录在对应的叶子或框画出来时才加载，不挡首屏。

**侧边栏填充测试的隐形上限。** `sidepanel-check-dist.test.ts` 塞固定的 `noise(3)`（约 7,460 B gz），要求塞完后的静态部分仍低于
63,488。它要证明的只是“算上目录才超预算”，可固定的噪声正好压在允许区间（大于 3,000 B、小于 7,473 B）的上沿，于是实际上给侧边栏的
静态部分立了一道约 56,028 B 的上限，比真正的预算（63,488 − 4,473 = 59,015）紧 3 KB 左右。这次按维护者的要求不改这条测试（现在余
174 B）；建议以后按构建算噪声，取区间的正中，让真正管着侧边栏的只有 `PANEL_BUDGET_GZ`。

## 7. 新增的 3 句文字（2026-10-30 已定）

> 2026-10-30 当天随后删掉了 `secKRestartOn`、`secKRestartOff`（开关去掉，见文件开头的补记），只剩 `trashBy`。

新增 3 个键，没有改任何已有用词。原定随 06 号文件请所有者批；所有者答复“你来决定就行”（2026-10-30），维护者定为按下表用：

| 键 | 在哪 | en | zh_CN |
|---|---|---|---|
| `trashBy` | 设置 › 回收站，插件移入的账户名下 | Moved here by the plugin $1 | 由插件 $1 移入 |
| `secKRestartOn` | 设置 › 安全 › 记录 | PIN “Also after a restart” turned on | 开启了 PIN 的“重启后也可以” |
| `secKRestartOff` | 同上 | PIN “Also after a restart” turned off | 关闭了 PIN 的“重启后也可以” |

中文 `trashBy` 用的是 19 号文件问题 3 里的说法（所有者选了“现在就画”）。英文 r2 改成 “Moved here by the plugin $1”（B3-03）：名字是插件自己起的，它可以叫自己
“you”，没有 “the plugin” 时就成了 “Moved here by you”，把插件做的事说成用户自己做的；中文本来就有“插件”二字。英文仍省掉 SDK §9.7
的 “to the trash”（回收站里不必再说一遍）。en 的视图因此 13,593 → 13,597 B（上限 15,360），“每个部分”en 10,715 → 10,720 B，zh 都不变。
两条记录行用开关在界面上的名字（PIN 快速解锁下的“重启后也可以”），句式照已有的记录行（“开启了 YubiKey 账户” / “YubiKey accounts
turned on”）。

## 8. 测试、变异体、门禁、e2e

### 8.1 新的和改了的测试

| 文件 | 守着什么 |
|---|---|
| `test/unit/budget3-rules.test.ts`（新） | 种类表只以类型被引用，弹窗和侧边栏的模块图里没有它；每个记录调用（`record`、`["record"]`、`recordAction`、`guarding`）的第一个参数是引号里的、表里的名字，或者规则点名的少数带类型参数（r2），表里每个种类都有人记；卡片的标签与表一一对应、都有文字、用 `Object.hasOwn` 过滤；4 处合并的键已去掉、文字逐字不变、`ungrouped` 保留；YubiKey 预留的标签已去掉；`trash-marks.ts` 只由回收站 `import()`、只 import 不会让弹窗重新分组的模块；messages.py 与 check-dist 量的是同一组目录（保险库视图 + 4 个懒加载目录，不含 firstrun），上限同为 15,360 |
| `test/unit/budget3-trash-marks.test.ts`（新） | 只从校验过的记录读；锁着、标签不对、别的密钥、没有页面提示都没有标记（后两者不读存储）；名字与“设置 › 插件”一致：目录名、Chrome 改名、换版本、卸载、移除、中文名、不可信字符（双向控制、零宽、孤立代理项、控制字符、NFKC、40 字、受保护的词、清理后为空、读不出来）；从不抛异常；`forgetMarks` 只去掉给出的 ID、其余不变、锁着不写；记录校验不过时原样不动、没有被标记的 ID 时不写（r2：审查人的 Y1，和 Y2） |
| `test/unit/budget3-dom.test.ts`（新） | 卡片只列有标签的种类（新版本的、`constructor`、`oath_on` 都不列），“更早的”只数列出的，两行新文字；回收站：标记只在被移入的那一行、作为文本；锁着（包括状态已锁、保险库还在的那一刻）不去读；恢复的写入成功且有标记才 `forgetMarks`，失败不调，页面 reload 失败照样调（r2）；只有不认识种类的条目时显示“没有记录”、不给“清除”（r2） |
| `test/unit/budget3-pin-restart-record.test.ts`（新） | §5.2 表里的每一行。r1 只说对了一半：塞进来的记录只在“用开关关闭”那条路测过，“记录写成之后才记”只测了 `enable`，删除和保存失败、开着改 PIN 而重做失败、新保险库、暂停中用开关关闭都没测（审查的 B3-01，7 个变异体 RC1–RC7 当时全部存活）。r2 并入审查人的 X1–X8，另补“共享配置文件里拒绝开启”，现在逐行都有用例 |
| `test/unit/security-log.test.ts`（改） | 不是格式的不写不读、留在记录里；格式合法的不论名字都写、读回；表里每个名字都合格式；fast-check：任何版本写的格式合法条目读回、改写时逐字保留 |
| `test/unit/m2-source-rules.test.ts`（改） | R8：不再预留 `oath_*`；`oath_on` 条目读回保留 |
| `plugins-source-rules`、`plugins-w2a-source-rules`、`autofill2-settings-dom`、`pin-restart-service`（改） | 页面提示的读取者多了 `trash-marks.ts`；它的带标签写入走 W2A-01 的同一条路；`afsOn`→`clipOn`；开启后记录多一行 `pin_restart_on` |
| `test/e2e/plugins-w2b.spec.ts`、`test/e2e/pin-restart.spec.ts`（改） | 真实 Chromium：插件提议、确认后回收站那一行写“Moved here by the plugin Reader test plugin”，恢复后授权记录里的 ID 没了，用户自己再删不再有标记；开启、关闭、暂停期间改 PIN、设为共享后，记录页的最新一行 |

### 8.2 变异体（`budget3/tools/mutants.py`，每个单独打上、单独还原，只认断言失败）

24 个全部被断言杀死，对照（只改一行注释）存活：

| 编号 | 变异 | 杀死它的测试 |
|---|---|---|
| M01 | 开启不记 | record、pin-restart-service |
| M02 | 关闭记成 on | record |
| M03 | 先记 on 再核对主密码 | record（主密码错、记录写不成） |
| M04 | 不论记录是谁的都记 off | record（锁着、塞进来的记录） |
| M05 | 重新开启不记 | record |
| M06 | 记录类 import 种类表的值（进了弹窗的包） | rules |
| M07 | 去掉格式核对 | security-log |
| M08 | 卡片不过滤 | dom |
| M08b | 用 `in` 过滤（`constructor` 漏过） | dom |
| M09 | 标记来自没核对标签的记录 | trash-marks |
| M10 | 锁着也去读标记 | dom |
| M10b | 没有页面提示也读存储 | trash-marks |
| M11 | 名字用描述符里的 | trash-marks |
| M12 | 回收站静态 import 平台块 | rules、plugins-source-rules |
| M13 | 撤回一处合并（键已删） | rules（budget-split 也因收集器报错失败） |
| M14、M14b | messages.py / check-dist 量的视图漏掉 restart | rules |
| M15 | check-dist 的 15,360 多 1 B | shares-check-dist |
| M16 | 恢复后不去掉标记 | dom |
| M17 | 恢复失败也去掉标记 | dom |
| M18 | 暂停期间改 PIN 不记 off | record |
| M19 | 设为共享时不论记录是谁的都记 off | record |
| M20 | `unmarkTrashed` 清空整个条目的标记 | trash-marks |
| M21 | 开着时改 PIN 也记 off | record |

r2 又加了 15 个，全部被断言杀死（对照照旧存活）。审查人的 7 个（RC1–RC7）在 r1 的测试下全部存活，r2 并入 X1–X8 之后都被
`budget3-pin-restart-record.test.ts` 杀死：

| 编号 | 变异 | 杀死它的测试 |
|---|---|---|
| RC1 | 设为共享：“已解锁且存了记录”就算 Sixkey 自己的 | record X1 |
| RC2 | 改 PIN：“改之前存了记录”就算 | record X2 |
| RC3 | 用开关关闭：先记 off 再删 | record X7 |
| RC4 | 设为共享：先记 off 再保存 | record X8 |
| RC5 | 重新开启：先记 on 再写记录 | record X3 |
| RC6 | 开着改 PIN 而重做失败：不记 off | record X4 |
| RC7 | 新保险库：存了记录就记 off | record X5 |
| T1 | 整理性写入去掉“通过校验才写” | trash-marks：store 的 `tidy` 本身（经 `forgetMarks` 测不出：校验不过时的底稿是空的，去标记什么也不改，T2 的检查先挡住了，所以另写了一条直接测 `write` 的用例） |
| T2 | 去掉“有变化才写” | trash-marks：没有被标记的 ID 时不写 |
| T3 | `unmarkTrashed` 用普通写入 | trash-marks：Y1、没有被标记的 ID |
| R1 | 页面 reload 成功才去掉标记 | dom：reload 失败照样去掉 |
| E1 | “清除”按全部条目判断 | dom：只有不认识的种类时没有“清除” |
| A10、A11、A12 | 引号里拼错的名字加 `as never`、反引号模板加 `as never`、名单外的标识符 | rules：第一个参数的规则 |

另外 r1 的 M17 因为恢复的写法改了，换了定位点（“恢复失败也去掉标记”：把去掉标记挪到写入之前），仍被杀死。

### 8.3 门禁与全量单元

在树的一次性副本上（`heavy.lock` 下）：`messages.py`、`npm run typecheck`、prod / e2e / dev 三种构建各自的 check-dist、
开门构建的 check-dist、`npm run format:check`、`npm run notices:check` 全部通过，没有 `.orig` / `.rej`；数字见 §2。
全量单元（两个 worker）：第一轮 296 个文件里 1 个失败——`service.test.ts` 的“recordExport … ignores anything that is not
one”，即 §5.1 那一处，已修；修完的最终树 296 个文件全部通过：4,549 通过、4 个预期失败、1 个跳过（与基线相同的那几个）。

r2：门禁全套在新副本上重跑，全部通过（数字见 §2）。按维护者的安排，这一轮只跑针对性单元：改到的测试文件，加上安全记录、回收站标记、
插件授权、PIN 重启相关的 26 个文件，546 条全部通过（`budget3/tools/targeted.sh`）；全量单元在合入时跑。

### 8.4 e2e

全量 `npm run e2e` 的同样步骤（prod / e2e / dev 构建各自 check-dist，然后 playwright，串行），在一次性副本里跑：副本路径不含
`/e2e/`；本机上 API 的那个端口被别的程序占着，所以只在副本里，把 `src scripts test manifest*.json playwright*.ts` 里的端口逐个文件
换成另一个（18 个文件），并确认两个 manifest 都已改、副本里不再有原来的端口。补丁里没有端口的改动。

- **全量 e2e：429 通过、2 失败、1 跳过（34.6 分钟）。** 跳过的是 `quickview.spec.ts` 的截图一条，基线就跳过。
  - 失败 1：新加的 `pin-restart.spec.ts` “turned off by its switch”。是测试自己的错：那个复选框是受控的（显示的是记录的状态，
    关闭在异步完成之前它一直勾着），Playwright 的 `uncheck()` 要求点完立刻变；改成 `click()`。改后在新副本里把
    `pin-restart.spec.ts` 连跑 3 遍：33/33 通过（新的这条 3/3）。
  - 失败 2：`regression/offscreen-race.spec.ts` “how far apart two copies must be to both get cleared”，间隔 20 ms 的那一次没被清掉：
    计时型的回归测试，本补丁不碰剪贴板和离屏文档。重跑：本补丁 3/3、基线 539e9f6 3/3 都通过。
  - 本补丁新加或扩展的 e2e 都通过：`plugins-w2b.spec.ts` “an update and a trash applied”（回收站的标记、恢复后授权记录里的 ID
    没了、用户自己再删不再有标记），`pin-restart.spec.ts` 的开启（首条）、暂停期间改 PIN、设为共享、用开关关闭。
- **e2e:sync：12 通过（3.4 分钟）。** API 服务器的 Python 环境从活树的 `api/server/.venv` 克隆进副本（只读）；数据库是测试自己在
  临时目录里起的 PostgreSQL，随测试停掉。

## 9. 残余与给审查人重点看

- §4.3：别处的恢复之后再删除，标记会回来；标记写入失败、记录校验不过时同。后续：标记带上移入时的 `dhlc`，只在账户当前的 `dhlc`
  相等时才画（要改 W2b 的 `trashed` 格式，这次不做）。
- §5.1：种类核对从“按表”改成“按格式加类型”。不变量和源码规则见上；请确认这个取舍。
- §5.2：`pin_restart_off` 记在三处（开关、暂停期间改 PIN、设为共享），都只对 Sixkey 自己做的记录；理由见上。
- 回收站显示的名字是插件那一行的名字，但没有那一行的“（名称由插件自己提供）”提示（那个词在插件目录里，回收站不加载它）；判断信任
  仍在“设置 › 插件”。
- 一个账户若先后被两个插件移入（中间在别处恢复过），显示的是授权记录里排在后面的那个插件。
- 种类的源码规则看不见存在别的名字下的 `SecurityLog` 的 `append(`，也看不见对象字面量的参数；两种都要先用 `as never` 绕过类型
  （FU2，§12，复核的 B3-14）。

（r2 的 e2e 见 §10。）

## 10. r2：独立审查之后（2026-10-29）

审查结论“可以合入，没有阻断项”（快照目录 `budget3/REVIEW.md`），应修 2 条、建议 5 条，维护者定了每条怎么做。r1 的补丁另存为
`BUDGET3.r1.patch`，r1 → r2 的差在 `BUDGET3.r1-r2.interdiff`。

| 编号 | 审查说的 | r2 怎么改 | 守着它的 |
|---|---|---|---|
| B3-01（应修） | §5.2 的好几行没有测试，7 个变异体存活；§8.1 言过其实 | 并入审查人的 X1–X8（按本文件的写法，断言原意不变），另补“共享配置文件里拒绝开启”；§8.1 改准 | `budget3-pin-restart-record.test.ts` 最后一组；RC1–RC7 |
| B3-02（应修） | 恢复时去掉标记的写入，会把校验不过的授权记录放到一边、另起一份空的；没有要去掉的 ID 时也照样写 | `GrantStore.write` 加一个 `tidy` 选项（同一个写入，两行判断，不另开写入路径）：校验不过时什么也不写、不放到一边，返回 null；`change` 没改动什么时也不写。`unmarkTrashed` 用它 | trash-marks：审查人的 Y1、没有被标记的 ID、`tidy` 本身；T1–T3 |
| B3-03（建议） | 英文没有 “plugin”，插件可以叫自己 “you” | 英文改成 “Moved here by the plugin $1”，中文不变；重新生成 `_locales/`、`catalogs/`；§7 的表和理由、SDK §9.7、OWNER-CHECKLIST 51 跟着改 | dom、e2e 的文字 |
| B3-04（建议） | 恢复已写入、只是页面 reload 失败时，标记去不掉 | 改了，很小：去掉 `act()`，`restore` 在恢复的写入成功之后就去掉标记，再 reload；带 `dhlc` 的标记只写进 §4.3 / §9 的后续 | dom：reload 失败照样去掉；R1 |
| B3-05（建议） | “每个 `record("…")` 都在表里”漏掉模板字面量，也没管 `recordAction` | 收紧成：`record`、`["record"]`、`recordAction`、`guarding` 的第一个参数必须是引号里的名字，或规则点名的 9 个带类型参数之一（名单不会过期）；同步引擎的 `record:` 字段里的名字都要在表里 | rules；A10–A12 |
| B3-06（建议） | `security-kinds.ts` 两处引用、§5.1 漏了 `recordAction` | 改准 | — |
| B3-07（建议） | “清除”看全部条目，列表看有标签的条目 | 都按会显示出来的条目判断：只有不认识的种类时显示“没有记录”，也不给“清除”。理由：没列出来的是新版本的条目，留给写它的那个版本；没加文字 | dom；E1 |

审查人的其他观察（两页同时操作的窄竞态、`setPin` 第 2 步写失败时真记录已删却没有 off、设为共享时记录里只有一行“关闭了…”）都可以接受，
这次不改。

r2 的 e2e（原来那套换端口的副本）：`pin-restart.spec.ts` 和 `plugins-w2b.spec.ts` 整个文件 16/16 通过，包括回收站标记的新英文
“Moved here by the plugin Reader test plugin”。断言 `trashBy` 英文的 spec 只有 `plugins-w2b.spec.ts` 这一个。

## 11. 后续补丁 BUDGET3-FU（r2 复核的建议，2026-10-29）

r2 复核结论“可以合入，没有阻断项，也没有应修项”，另有 4 条建议，维护者定了做法。基线是 539e9f6 加 r2（已合入，本地提交 43de5e9，与之逐字节相同）。

| 编号 | 复核说的 | 怎么做的 | 守着它的 |
|---|---|---|---|
| B3-08 | `tidy` 写入有两条行为没测：清理未完成时照样拒绝（T4 把两行判断对调后存活）；没有记录时不写（T5） | 只补测试：“the store's tidying write itself”（FU r2 改名后是 “the store's book-keeping write itself”）里加两段：`cleanupPending` 为真、记录校验不过时，`tidy` 写入抛 `CleanupPendingError`、存储不动；没有 `sk_plugins` 时返回 null、不新建记录 | `budget3-trash-marks.test.ts`；T4、T5 |
| B3-09 | W2b 的 `markTrashed` 遇到校验不过的记录时怎么写，没有测试（T6 让它也走 `tidy`，存活） | 先补了测试钉住现状；维护者随后定了改（FU r2，见下）：`markTrashed` 也只在记录通过校验、并且确实有变化时才写。测试改成钉住新行为：校验不过时 `sk_plugins` 原样不动、`sk_plugins_unverified` 不变、会话 epoch 不变，什么都不写；记录重新校验通过后标记照常记上；W2b 的 Apply 照样完成、照样告诉插件 `{ trashed: 1 }`，诊断日志里没有东西 | `plugins-grants.test.ts`、`plugins-w2b-platform.test.ts`；T6r |
| B3-10 | 规则不看 `append(`（A13）；插件目录整个被跳过（A14） | 两件都纳入：正则加上 `security.append`（名单里补 `record()` 自己转给它的 `kind`）；不再跳过插件目录。原来跳过是因为插件平台有自己的日志 `PluginSession.record({ at, … })`，参数是对象字面量；现在只跳过对象字面量（和函数定义），理由写在规则的注释里 | `budget3-rules.test.ts`；A13、A14 |
| B3-11 | §5.1 的“13 → 174”是旧数；r1 → r2 少的 6–8 B 来自块名哈希 | §5.1 改成 183，§2 加了说明 | — |

**B3-09：`markTrashed` 改成记账性的写入（FU r2，维护者定的）。** W2b 的 `markTrashed` 原来是普通的带标签写入：Apply 之后、记标记之前，
如果授权记录恰好不再通过校验，这次写入会把记录放到一边、从空记录另起一份新的。这和 store.ts 页首“校验不过的记录原样留着，只有用户
重新批准插件时才另起新记录”的规则不一致；记标记只是记账，不是批准。现在它和恢复时去掉标记一样，用同一个选项：只在记录通过校验、并且
确实有变化时才写，校验不过时什么也不写、不放到一边。两种做法下标记都会丢（新记录里本来就没有这个插件的条目），所以结果不会更差，
这是一条只收紧的改动；窗口也很窄（Apply 前一刻刚在点击里校验过记录）。W2b 的调用方（`platform/plugins/changes.ts markTrashed`，
Apply 之后不等待地调用）不受影响：`GrantStore.markTrashed` 照样返回 `void`，照样只在清理未完成、写入出错时抛错；校验不过的情形
不抛错，所以诊断日志里也没有这一条，Apply 的结果和告诉插件的 `{ trashed: … }` 都不变（`plugins-w2b-platform.test.ts` 新加的一条钉住）。

**选项改名。** `tidy` 用在 `markTrashed` 上意思不对（记标记不是“整理”），改成按行为起的名字 `onlyVerifiedChange`。改动只有
store.ts 的重载和两处判断、两个调用、trash-marks 测试里的几处，没有别的调用方；§4.3 已经用新名字，§8.2、§10 和上面表里的 `tidy` 指的就是它。
`store.ts` 里 `write` 的注释改成如实描述两处用途，`markTrashed`、`unmarkTrashed` 的注释也跟着改了。SDK §9.7、PLUGINS-W2B-NOTES §3.8
跟着改准。

**体积（FU r2；解释在 FU2 改正，复核的 B3-13）。** 弹窗的静态部分 53,617 → 53,622 B（+5），侧边栏 55,846 → 55,852 B（+6），开门时
+3、+2；`sidepanel-check-dist` 填充测试的余量 183 → 177 B（§5.1 的 183 是 r2 合入时的数）；各个目录的数都不变（保险库页面 + 全部懒加载
目录仍是 15,258 B）。这些差都是块名哈希带来的 gzip 噪声，和 §2 说的 r1 → r2 是同一回事：`store.ts` 所在的 `store-*.js` 是懒加载块，
不在弹窗、侧边栏的静态闭包里；闭包里每个文件的原文字节数都和 r2 相同（check-dist 计入的弹窗 8 个、侧边栏 11 个文件），变的只是
其中 import 的块名。真正变大的只有 `store-*.js`：原文 +66 B（选项名是属性名，压缩时不会缩短：`tidy` 改成 `onlyVerifiedChange`
的三处，加上 `markTrashed` 新传的一次），gzip 后 +9 B，不计入任何页面。FU r2 交付时这里写成“选项名使弹窗、侧边栏变大”，不对。
FU r1 只改测试和文档，体积与 r2 相同。

变异体（`budget3/tools/mutants.py`，只认断言失败，超时不算；对照存活）：FU r1 里 T4、T5、T6、A13、A14 全部被杀死。FU r2：T6r（把 `markTrashed` 改回普通写入）、T1–T5、A13、A14 全部被杀死，对照存活；W2b 原有的 `markTrashed` 测试全部通过。

FU r2 的验证：针对性单元 13 个文件（`plugins-grants`、`fault/plugin-grants-crash`、W2b 的全部单元、budget3 的 4 个、
`security-log`，加上另外 2 个插件源码规则）280 条通过；门禁（`messages.py`、typecheck、prod / e2e / dev 构建各自的 check-dist、开门构建、
format:check、notices:check）全过；e2e 在换了端口的副本里：`plugins-w2b.spec.ts` 5/5，回收站有关的共 16 条（`plugins-w2b-r2.spec.ts`
整个文件 11 条，`flows`、`add-popup`、`quick-pin`、`export-selection` 里讲回收站的 5 条）全部通过。全量单元按维护者的要求没跑。


## 12. 最后一份补丁 BUDGET3-FU2（FU r2 复核的建议，2026-10-29）

FU r2 复核的结论是“可以合入，没有阻断项，也没有应修项”，另有 4 条建议，维护者定了做法。这份补丁只动测试、注释和说明，代码的行为
一点不改。基线是 43de5e9 加 FU r2。

| 编号 | 复核说的 | 怎么做的 | 守着它的 |
|---|---|---|---|
| B3-12 | 记账性写入遇到同一浏览器会话里被回滚的记录（标签对得上当前密钥，epoch 却比会话的旧），没有测试；T8（“校验不过”只看标签、不看 epoch）存活 | 补两段测试。plugins-grants 的 B3-09 用例后面加一段：放回一份更早的记录（之前放到一边的 `sk_plugins_unverified` 也在），`markTrashed`、`unmarkTrashed` 各调一次，每次之后 `sk_plugins` 仍是那份旧记录，`sk_plugins_unverified` 原样，会话 epoch 不变，读出来仍被拒绝。trash-marks 直接测写入本身的那条也加一段：同样回滚的记录上，一个连空记录也会改动的 `change` 照样什么都不写 | `plugins-grants.test.ts`、`budget3-trash-marks.test.ts`；T8、T3g |
| B3-13 | §11 对体积增减的解释不对 | §11 那段改正：差都是块名哈希带来的 gzip 噪声；真正变大的只有不计入任何页面的 `store-*.js` | — |
| B3-14 | 源码规则只认 `security.append(`，换个变量名就漏掉（A17） | 按维护者的意思不改规则，记作残余（见下） | — |
| B3-15 | “标记丢了，诊断日志会说”的总说法没有提到新的例外；SDK §6.6 第 6 项“写入遇到校验不过的记录，就把它放到一边”也没有 | 只补半句说明，不加诊断代码。PLUGINS-W2B-NOTES §3.8 和 `changes.ts` 的注释写明：Apply 之后记录不再通过校验时，标记会丢，诊断日志里没有这一条；这时记录本身就是提醒，设置 › 插件会说 Sixkey 无法核对插件的批准，请用户复核。SDK §6.6 第 6 项（R3-01 那一条）补上：§9.7 的两种记账性写入是例外，什么都不写，记录既不放到一边，也不被换掉 | — |

**T8 经由 `markTrashed`、`unmarkTrashed` 测不出来。** T8 下，回滚的记录越过了第一道判断，但 `good` 本身仍含 epoch 的检查，所以
写入的底稿是空记录。空记录里没有插件的条目，加标记、去标记都改不动它，第二道判断（没有变化就返回 null）照样把写入拦下，什么也
不写。所以单靠这两个调用杀不死 T8：同一个变异体只跑 plugins-grants（T8g）时存活。杀死它的是 trash-marks 里直接测写入本身的那段
（T8t），用的是一个连空记录也会改动的 `change`。复核说 T8 下“回滚之后的 `markTrashed` 或 `unmarkTrashed` 会把记录放到一边、另起
新记录”，对这两个调用不成立；对一个会改动空记录的记账性写入成立，所以这一段仍然值得补。plugins-grants 的那段钉住的是两个调用
在回滚时的行为本身：把 `unmarkTrashed` 改回普通写入（T3g，只跑 plugins-grants）会被它杀死；在这之前 plugins-grants 没有调用过
`unmarkTrashed`。

**残余（B3-14）。** 源码规则（`budget3-rules.test.ts` 的 `CALL`）认的是 `record(`、`["record"](`、`recordAction(`、`guarding(`
和 `security.append(` / `security?.append(`。安全记录的 `SecurityLog` 要是存在别的名字下（例如 `runtime-base.ts` 里本来就叫 `log`
的那个），`log.append("bogus_kind" as never)` 规则看不见（复核的 A17，存活）。对象字面量的写法
`this.record({ kind: "bogus_kind" } as never)` 规则也看不见（A18，存活）：规则有意跳过对象字面量，那是插件平台自己的日志
`PluginSession.record({ at, … })`；不过它在运行时无害，`isKind` 只认字符串，什么也写不进去。两种都要先用 `as never` 绕过类型：`append`、`record` 的参数类型是
`SecurityKind`，拼错的名字过不了 typecheck。规则不改。

变异体（`budget3/tools/mutants.py`，只认断言失败，超时不算）：T8 被杀死（trash-marks 直接测写入本身的那条）；T8t 被杀死；T8g 存活
（上面说的等价）；T3g 被杀死；对照 C01 存活。验证：针对性单元 10 个文件、155 条通过（plugins-grants、budget3 的 4 个、读文档的
`plugin-sdk-package` 和 `notices`、读 `changes.ts` 原文的 3 个插件源码规则）；门禁 typecheck、format:check、notices:check 全过。
按维护者的要求，没有构建，没有跑 e2e 和全量单元。
