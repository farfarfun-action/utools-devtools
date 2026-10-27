# UPXS 格式分析与证据

本说明针对下面两个固定样本，不声称所有历史或未来版本相同。

| 输入 | SHA-256 |
| --- | --- |
| [官方开发工具 2.7.0](https://res.u-tools.cn/plugins/9t97fzw4ihpnvmhmnhonuev3hpxoqji4.upxs) | `04cde14fb4b1b0fe40f4067d52b47b61906394e612fe5d1b23924a400a651a17` |
| [uTools 8.0.2 Linux DEB](https://open.u-tools.cn/download/utools_8.0.2_amd64.deb) | `3904b1081ae0562cd1ae4c3f3d33592521f3a9001f72392b5b0228cde3c23056` |
| DEB 内 Linux x64 addon | `b8f96f70e87d2f5c07f1fae9182d6d1472b66403d4ede8a73cd3bfdf1ae96086` |

## 容器

```text
uint32 little endian: 加密元数据的字节数 N
N bytes: XChaCha20-Poly1305(metadata JSON)，末尾带 16-byte tag
remaining bytes: AES-256-CBC(gzip(ASAR))，PKCS#7 填充
```

样本总长 481,558 bytes，N = 466；解密后 gzip 为 481,075 bytes，ASAR 为 1,399,813 bytes。ASAR 的主程序清单是 `developer`，版本 `2.7.0`。官方开发插件的 `buildUpxsFile(directory, manifestOverrides, teamUid)` 通过 IPC 委托主程序打包，不是浏览器端公开 npm API。

元数据包含 `os`、`app`、`developer`、`pluginId`、`key`、`iv`、`timestamp`、`encrypt2`。其中 `key` 为 32-byte AES key 的 hex，`iv` 为 16-byte IV 的 hex。`encrypt2` 是第二组参数的 XChaCha20-Poly1305 密文，其明文在此样本中为 `pluginId + String(timestamp)`，无分隔符。

官方原生模块的 `Decrypt`/`Decrypt2` 调用 libsodium 的 `crypto_aead_xchacha20poly1305_ietf_decrypt`。参数的静态解码通过 ELF 的 PT_LOAD 映射读取，算法为逐字节 XOR 递增种子。当前 `runtime.mjs` 中的偏移仅适用于哈希匹配的原生模块；不执行该模块，也不将解码后的常量写入仓库。

由于格式使用静态的元数据密钥/nonce，它不能作为作者身份的可信数字签名。正文为 CBC，gzip CRC 和 ASAR hash 是内容检查，不能替代来源验证。

## 回归与边界

1. 官方样本通过认证解密；额外绑定与 `pluginId + timestamp` 一致。
2. 读取每个 ASAR 文件，与 `@electron/asar` 独立读取结果比较。
3. 使用原始元数据和压缩正文重新封装，与官方文件逐字节相等。
4. 自己生成的测试插件完成打包/解包往返；测试篡改、截断、资源缺失、身份错配、路径穿越、软链接、重名、覆盖和 ASAR 完整性损坏。
5. Linux、Windows、macOS 均运行这些检查；Action 另做调用与输出校验。

这些检查验证了样本格式互通。**没有自动操作真实登录账号，也没有宣称新生成插件已被官方客户端安装接受。** 客户端仍可能检查账号、团队、安装权限、项目注册、资源内容或其他未覆盖条件。首个实际插件包应在目标客户端手动安装验证后再标记稳定版。
