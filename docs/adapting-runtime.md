# uTools 升级后的分析与适配手册

这里记录可复现的调查方法、证据和实现决策，供后续维护者快速定位变化。不要仅修改版本号、文件后缀或放宽校验来让任务变绿。

## 先看哪几个文件

| 文件 | 职责 |
| --- | --- |
| [`format.md`](format.md) | 已确认的容器布局、样本哈希、验证边界 |
| [`src/runtime.mjs`](../src/runtime.mjs) | 固定客户端下载、DEB/ELF 哈希、地址映射及参数提取 |
| [`src/package.mjs`](../src/package.mjs) | 元数据认证、正文解密、ASAR 检查和打包 |
| [`test/official.test.mjs`](../test/official.test.mjs) | 官方样本、逐文件对照、逐字节重新封装、CLI 行为 |
| [`test/package.test.mjs`](../test/package.test.mjs) | 自有合成数据的往返及异常输入回归 |
| [`action.yml`](../action.yml) | 其他仓库调用的稳定接口 |

当前已知：容器参数来自 **uTools 8.0.2 Linux x64**；开发工具样本为 **2.7.0**，包中记录的导出程序版本为 **8.0.0-beta.7**。这说明这两个样本可互通，不能据此推出所有版本都兼容。

## 先确定变化在哪一层

| 症状 | 优先检查 | 不应直接得出的结论 |
| --- | --- | --- |
| DEB 或 addon SHA-256 变化 | 上游是否替换了同 URL 文件、架构是否一致 | 不能只更新哈希并继续沿用旧地址 |
| 元数据认证失败 | 头部长度布局、密钥/nonce 提取、AEAD 算法或 tag 布局 | 不能当作普通 JSON 编码问题 |
| `encrypt2` 失败 | 第二组参数、校验明文的字段/顺序/分隔符 | 不能跳过身份/时间戳绑定 |
| AES 解密或 gzip 失败 | key/iv 编码、算法模式、填充、正文起始位置 | 不能换后缀伪装成新格式 |
| ASAR 解析失败 | gzip 输出魔数、Pickle 头、文件边界、外置文件规则 | 不能假定每个版本都是同一档案格式 |
| 仅 `plugin.json` 哈希不同 | 官方导出是否修改了清单但保留旧哈希 | 不能把其他文件的哈希错误一起忽略 |
| 格式校验全过，客户端拒绝 | 项目 ID、登录/团队归属、版本、权限、安装限制和客户端提示 | 不能声称“格式通过 = 可以安装” |
| 只有 Windows 对照测试失败 | 给 `@electron/asar` 的路径是否用了平台分隔符 | 不一定是 UPXS 格式变化 |

## 本次如何建立证据

1. **先识别容器。** 官方 `.upxs` 没有 ZIP/gzip 魔数，开头四字节 `d2 01 00 00` 按 little endian 为 466。整个文件 481,558 bytes，元数据区后还剩 481,088 bytes，恰好为 16 的倍数。这为“长度 + 加密头 + 分组加密正文”提供了候选结构；仅靠长度还不能证实算法。
2. **找真正的实现边界。** 解开官方 Linux DEB，定位 Electron 的 `resources/app.asar` 与 `app.asar.unpacked/node_modules/addon/linux-x64.node`。`dist/main.js` 只加载 bytenode 的 `main.jsc`，所以没有把闭源主程序当作能直接阅读的 JavaScript。
3. **用字符串定位调用，再看原生导出。** 主程序字节码字符串包含 `readPluginInfoFromUpxs`、`unpackUpxsFile`、`buildPluginUpxsFile` 等。原生模块导出 `Encrypt`、`Decrypt`、`Encrypt2`、`Decrypt2`，反汇编显示它们调用 libsodium 的 XChaCha20-Poly1305。
4. **静态读取参数，并用认证结果确认。** 通过 ELF PT_LOAD 将虚拟地址映射到文件偏移；按官方小函数的 XOR 递增种子规则解码参数。使用独立标准加密实现成功验证 AEAD tag 并得到结构完整的 JSON。认证成功是比“输出看起来像文本”更强的证据。
5. **逐层打开正文。** 元数据中 `key`、`iv` 为 hex；AES-256-CBC + PKCS#7 解密后得到 gzip，再解压为 ASAR。读取清单确认是官方开发工具，版本与来源一致。
6. **确认第二组绑定。** `encrypt2` 解密得到 22 bytes；实测等于 9 字节的 `developer` 加 13 位时间戳。确认依据是字节比较，不只根据长度猜测。当前实现仍将其视为已验证样本的规则。
7. **核对开发工具调用。** 开发工具源码调用 `buildUpxsFile(directory, manifestOverrides, teamUid)`，通过 IPC 委托主程序；因此“解开开发工具就能直接复制一个独立导出函数”的方向不成立。
8. **验证实现，而不只验证猜想。** 初始分析用 Python/PyCryptodome 认证解密；仓库实现用 Node `@noble/ciphers` 和内置 AES/zlib。Actions 再将 Node 实现读取的每个文件与 `@electron/asar` 对照，并用原始元数据/压缩正文重新封装，要求整个官方文件逐字节相等。

整个过程中没有执行下载的原生模块、插件 JavaScript 或客户端主程序。只有正常的分析工具和本项目测试在运行。

## 可复用的静态分析步骤

产品构建、测试、分发包生成仍在 GitHub Actions 中运行。以下是 Linux 环境的静态检查命令，不会安装或启动 uTools；临时文件放 `.cache/`，不要提交或上传为构建附件。

### 1. 获取并固定新的输入

从 [官方下载页](https://www.u-tools.cn/download/) 确认实际 Linux x64 下载地址，不凭旧 URL 猜版本。另准备官方开发工具包和一个由你自己账户导出的最小插件包，以区分通用格式与官方内置插件特例。

```sh
mkdir -p .cache/upgrade
# 将新客户端下载到 .cache/upgrade/client.deb，将样本下载到同一目录。
# curl -fL --retry 2 --max-time 180 "$OFFICIAL_DEB_URL" -o .cache/upgrade/client.deb
sha256sum .cache/upgrade/client.deb
dpkg-deb -x .cache/upgrade/client.deb .cache/upgrade/client
sha256sum .cache/upgrade/client/opt/uTools/resources/app.asar.unpacked/node_modules/addon/linux-x64.node
```

`dpkg-deb -x` 只提取文件，不运行安装脚本。记录 URL、下载日期、客户端版本、系统架构和两个哈希。官方包内的账号/设备资料不能进入文档、测试断言失败输出或公共日志。

### 2. 看 JavaScript、字节码字符串和 IPC

在已安装本项目依赖的 Actions runner 中，用 ASAR 工具列目录，再有选择地提取 `dist/main.js`、`dist/main.jsc` 和相关 preload。提取不会执行代码。

```sh
npm exec -- asar list .cache/upgrade/client/opt/uTools/resources/app.asar
# extract-file 会把指定文件写到当前目录；先切换到 .cache/upgrade 下的独立工作目录。
# npm exec -- asar extract-file /absolute/path/to/app.asar dist/main.jsc
strings -td .cache/upgrade/main.jsc > .cache/upgrade/main-strings.txt
rg -n -B 25 -A 40 'readPluginInfoFromUpxs|unpackUpxsFile|buildUpxsFile|buildPluginUpxsFile|encrypt2|invalidOwner|invalidTeam' .cache/upgrade/main-strings.txt
```

如果旧版工具仍能解开新的开发者工具，直接用 `unpack` 检查其 preload 和前端；否则先定位客户端容器解析。压缩后的前端可以搜索上述函数名，输出邻近小段，不要执行 `eval` 或加载插件脚本来“试运行”。

主程序中曾见到的其他线索：`getPackageInfo`、`unpackUpxs`、`readUInt32LE`、`writeUInt32LE`、`createGzip`、`createGunzip`、`ownerId`、`developer plugin verify failed`。这些是定位线索，**字符串存在本身不证明运行时行为**。不要把本地账号数据库的 `localEncrypt`/`localDecrypt` 混同于包格式。

### 3. 定位原生加密边界

```sh
readelf -lW .cache/upgrade/client/opt/uTools/resources/app.asar.unpacked/node_modules/addon/linux-x64.node
nm -D -C .cache/upgrade/client/opt/uTools/resources/app.asar.unpacked/node_modules/addon/linux-x64.node > .cache/upgrade/addon-symbols.txt
rg 'Encrypt|Decrypt|crypto_aead|dF' .cache/upgrade/addon-symbols.txt
objdump -d -C .cache/upgrade/client/opt/uTools/resources/app.asar.unpacked/node_modules/addon/linux-x64.node > .cache/upgrade/addon-disassembly.txt
rg -n 'Decrypt\(|Encrypt\(|Decrypt2\(|Encrypt2\(|crypto_aead_xchacha20poly1305_ietf' .cache/upgrade/addon-disassembly.txt
```

跟踪解密函数中 key/nonce 参数的来源，辨别静态常量、堆栈重叠拷贝和解码函数；也要确认 associated data 是否为空、tag 是否追加在密文末尾。若新版本算法、nonce 构造或 AAD 改变，不能复用旧封装逻辑。

下面的地址仅作 **8.0.2 已固定哈希文件的导航记录**，不能直接套在新版本上：

| 定位点 | 8.0.2 Linux x64 虚拟地址/规则 |
| --- | --- |
| `Decrypt` / `Encrypt` | `0xa5f80` / `0xa5b00` |
| `Decrypt2` / `Encrypt2` | `0xa38c0` / `0xa6400` |
| 小型 XOR 解码函数 `dF(char*, int)` | `0x9e0a0`；第 i 字节 XOR `(seed + i) & 255`，原函数以解码后零字节终止 |
| 元数据 key 编码区 | `0x27b040`，32 bytes，种子 `0x38` |
| 元数据 nonce 编码区 | `0x27b060` 取 16 bytes 放到偏移 0；`0x27b070` 取 16 bytes 放到偏移 9；取前 24 bytes，种子 `0x18` |
| 第二组 key 编码区 | `0x27af20`，32 bytes，种子 `0x42` |
| 第二组 nonce 编码区 | `0x27af40` 与 `0x27af50`，同样以偏移 0/9 重叠；取前 24 bytes，种子 `0x24` |

ELF 中的虚拟地址不是文件偏移。找到 `PT_LOAD` 段，确认 `p_vaddr <= address` 且读取范围不超过 `p_vaddr + p_filesz`，再用 `p_offset + address - p_vaddr` 读取。nonce 第二次拷贝是覆盖偏移 9 开始的位置，不能简单拼接两个 16-byte 块。

官方原生模块还有自己的运行时保护；本项目只读取静态数据并使用标准算法，不修改保护逻辑或通过伪装加载模块来执行它。也不要在 CI 输出解码后的参数、完整明文元数据或开发者手机号。

### 4. 按认证结果验证假设

按 `format.md` 的层次逐步检查，每层先确认再进入下一层：

- 头部长度必须合理且在文件范围内；先验证 XChaCha20-Poly1305 tag，再解析 JSON。
- 只记录元数据字段名、类型、长度及非隐私版本号；确认新的可选归属字段是否需要原样保留。
- 解密第二组校验，使用布尔比较检查它与候选绑定值是否相等，不把明文身份打印出来。
- 解正文检查填充、gzip CRC、ASAR 边界和全部文件；显式记录任何完整性异常。
- 从**自己的**官方导出包提取身份，再用最小测试插件验证新包。不能拿官方 `developer` 的身份给自己的代码打包。

不要把格式层的检查改为忽略 `ownerId`、团队、账号或客户端限制。若新版本要求官方签名或服务端导出，应明确记录需要官方路径，不制造“兼容成功”的假象。

## 已踩过的坑

- **ZIP 改名 `.upx` 是错误包；旧 `gzip(ASAR)` `.upx` 也不能证明新客户端接受。** 新实现必须从真实 `.upxs` 的证据出发。
- **官方样本的清单哈希确实过期。** 仅允许读取时报告 `plugin.json` 的特定异常；`verify` 仍退出失败，自己生成的包必须全部哈希正确。不要把这个例外扩大到任意文件。
- **字节相等回归应保留原始压缩正文。** 不同 gzip 参数、ASAR 排序、时间戳、随机 key/iv 都会让合法新包与原包不同。`seal(originalMetadata, originalCompressed, profile)` 是验证封装布局；新包另做解包逐文件比较。
- **平台路径不同。** ASAR 内的逻辑路径统一 `/`；向 `@electron/asar.extractFile` 传入时用 `join(...name.split('/'))`。输出路径仍须拒绝穿越、Windows 设备名和大小写冲突。
- **ASAR 支持内容去重。** `@electron/asar` 4.3.1 的 `storeFileEntry` 会让内容相同的文件共享完全相同的 offset/size；FunCalc 的真实构建触发了这个布局。校验应允许完整区间相等，仍拒绝部分重叠、越界和数据空洞；回归必须包含重复内容的资源。
- **身份配置是私密数据。** 手机号、uid、mid 不进源码或附件；Secret 通过环境变量写入临时文件，任务结束清理。检查错误消息与断言是否会意外输出它们。
- **主程序并非全部源码可读。** 本次只有加载器和原生导出能直接定位，`main.jsc` 的字符串只能帮助寻找线索。没有反编译并验证所有客户端安装条件。

## 适配提交与发布清单

1. 保存新样本的来源、版本、哈希、字段变化及验证结论到文档，不保存官方原生模块、解密源码或私人身份。
2. 如果只是二进制布局改变，添加按精确哈希选择的运行时 profile；保留旧 profile 的测试。若主动结束旧版支持，在版本说明中明确写出，不静默替换旧行为。
3. 如果容器或绑定规则改变，分别补样本回归和错误输入测试；先写能暴露差异的测试，再修改读取/生成路径。
4. Actions 必须通过：三平台单元测试、固定官方样本认证、逐文件 ASAR 对照、逐字节重新封装、CLI 退出码以及可复用 Action 的产物/校验和。
5. 从已通过测试的同一提交创建新版本 tag，由 Actions 生成 CLI 分发包。不覆盖已发布 tag。消费仓库更新固定 SHA，保留上一版本方便回退。
6. 使用自己的项目身份，在实际目标 uTools 版本上安装、启动、执行功能并检查升级覆盖；记录操作系统、uTools 版本、插件版本和结果。未完成时继续标记技术预览，不能把 Actions 绿灯写成安装验收通过。

## 仍未验证的部分

当前实现没有真实登录账号的自动安装验收，没有证明所有账号/团队场景都可安装，也没有证明其他客户端版本使用同一格式。`ownerId` 会从自己的包原样保留，但所有归属规则尚未逐条还原。升级时最值得补充的是**自己的最小官方导出样本与目标客户端的实际安装结果**，而不是继续只增加合成数据的往返测试。
