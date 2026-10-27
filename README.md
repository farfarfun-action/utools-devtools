# uTools DevTools

独立的 uTools `.upxs` 开发工具：**打包、解包、检查、校验、导出自己的打包身份配置**。其他插件仓库通过 CLI 或 GitHub Action 复用，不需要各自维护打包脚本。

这是社区工具，与 uTools 官方无隶属关系。当前适配固定的 uTools **8.0.2 Linux x64** 格式参数，CLI 和 Action 在 Linux、Windows、macOS 上执行。下载的 Linux 原生模块仅作为数据读取，**不安装、不加载、不执行**；本仓库和 Release 不分发官方二进制或开发者身份。

> 当前为技术预览。官方开发工具样本的认证解密、ASAR 内容读取和逐字节重新封装都有回归测试。**这些测试不等于新包已通过 uTools 客户端安装或商店审核。** 输出也明确标记 `clientInstallVerified: false`。

## 使用 CLI

需要 Node.js 22.12+，以及能解压 xz 的 `tar`（三平台 Actions 环境均有）。安装 GitHub Release 的 `.tgz`，或安装固定 Git tag：

```sh
npm install --global github:farfarfun-action/utools-devtools#v0.1.4
utools-devtools prepare-runtime --out .cache/linux-x64.node
utools-devtools inspect plugin.upxs --runtime .cache/linux-x64.node
utools-devtools verify plugin.upxs --runtime .cache/linux-x64.node
utools-devtools unpack plugin.upxs --out extracted --runtime .cache/linux-x64.node
```

`prepare-runtime` 从官方地址下载约 89 MiB 的固定客户端包，校验 DEB 和模块的 SHA-256，仅提取格式参数所在模块。上游包变更会明确失败，不猜测新格式。下载需要网络；后续命令可离线运行。

## 给自己的插件打包

从自己通过官方开发者工具导出的 `.upxs` 提取打包身份。**必须使用自己的包，不能使用官方开发工具或其他作者的身份。** 同一开发者的其他项目可提供开发者和环境信息，但每个插件有独立的 `pluginId`；用于新项目时，必须填写新项目的官方 ID，不能沿用来源插件的 ID。

```sh
utools-devtools identity my-official-export.upxs --out identity.private.json --runtime .cache/linux-x64.node
# 配置下面的组织 Secrets，并从私密导出中移除三个敏感字段，另存为 identity.json。
utools-devtools pack ./utools --out ./release/my-plugin.upxs --runtime .cache/linux-x64.node
```

命令默认读取当前项目根目录的 `identity.json`；`--out`（导出）和 `--identity`（打包）可指定其他位置。`identity` 导出的是包含敏感值的完整配置，应将 `identity.private*.json` 加入 `.gitignore`。移除 `os.mid`、`developer.uid`、`developer.cellphone` 后，项目的公开配置可提交 Git，例如：

```json
{
  "os": {},
  "app": { "name": "uTools", "version": "8.0.2" },
  "developer": { "country": "86" },
  "pluginId": ""
}
```

填写目标项目的真实 `pluginId`；空 ID 会被拒绝。不要把配置放进 Web 构建的 public 目录。CLI 从 `UTOOLS_MID`、`UTOOLS_UID`、`UTOOLS_CELLPHONE` 环境变量注入对应字段，不会改写公开文件。

原始身份信息包括官方导出包的 `os`、`app`、`developer`、`pluginId` 及可选的 `ownerId`，完整的私密导出**不要提交 Git**。不要修改、伪造或移除归属字段来改变安装权限。打包不登录、不注册插件、不调用商店发布接口，也不能绕过账号、团队、安装数量或客户端的其他限制。

输入必须是已经构建的插件目录，包括 `plugin.json` 和它引用的文件。工具复制到临时目录，排除 `identity.json` 和本次显式指定的身份文件，在副本中补入身份配置里的插件 `name`，生成新随机 AES 密钥和 IV，构造 UPXS，立即重新解密验证后再写出。身份字段仍按格式写入 UPXS 加密元数据，只是不把配置文件作为插件资源分发。源目录不被修改。输出必须在源目录外；已有文件和解包目录不覆盖。

## 其他仓库的 GitHub Actions

将三个敏感字段分别放入组织 Actions Secrets，并为需要打包的插件仓库授权访问：

| Secret | 原始字段 |
| --- | --- |
| `UTOOLS_MID` | `os.mid` |
| `UTOOLS_UID` | `developer.uid` |
| `UTOOLS_CELLPHONE` | `developer.cellphone` |

项目根目录的公开 `identity.json` 保存各自的 `pluginId` 和其余配置。Secret 不应出现在工作流源码、日志或构建附件中。

Action 默认读取调用仓库根目录的 `identity.json`，可用 `identity-file` 指定其他路径。兼容旧的 `identity-json` 完整 Secret 输入；若提供则代替文件。三个独立 Secret 输入会覆盖配置中的对应字段，不修改项目文件。

```yaml
steps:
  - uses: actions/checkout@v4
  # 先用自己的步骤构建 ./utools，含 plugin.json 和 dist 等资源
  - name: Package UPXS
    id: upxs
    uses: farfarfun-action/utools-devtools@v0.1.4
    with:
      source: utools
      output: release/my-plugin.upxs
      mid: ${{ secrets.UTOOLS_MID }}
      uid: ${{ secrets.UTOOLS_UID }}
      cellphone: ${{ secrets.UTOOLS_CELLPHONE }}
  - uses: actions/upload-artifact@v4
    with:
      name: plugin-upxs
      path: ${{ steps.upxs.outputs.package-file }}
```

Action 返回 `package-file` 和 `sha256`。固定 tag 用于版本管理，生产工作流可以进一步固定到 tag 对应的 commit SHA。Action 安装 Node 22；若构建依赖其他 Node 版本，将此步骤安排在构建之后。它只负责打包，不主动创建 Release、不发送消息、不发布商店。

## 格式与校验范围

详见 [格式分析](docs/format.md) 与 [升级分析和适配手册](docs/adapting-runtime.md)。后者记录证据链、静态分析命令、已知函数/地址、踩坑记录和升级验证清单。工具检查元数据认证、插件 ID/时间戳绑定、AES 填充、gzip CRC、ASAR 边界和已有的文件完整性哈希，以及清单资源是否存在。拒绝路径穿越、大小写冲突、Windows 特殊路径、软链接、外置 ASAR 文件和已有输出目录。

官方开发工具样本的 `plugin.json` 内容与 ASAR 中保存的哈希不一致。`inspect`、`unpack`、`identity` 允许读取这类包，但明确返回警告和 `integrityVerified: false`；`verify` 对此以非零状态退出。其他文件的哈希不匹配直接拒绝。我们生成的新包重新计算全部哈希，必须通过严格检查。

当前限制为输入包 128 MiB、解压 ASAR 256 MiB、头部 8 MiB、50,000 个条目、64 层目录。不支持旧 `.upx` 的安装兼容承诺，不自动修改后缀，不生成账号身份。正文采用官方格式的 AES-CBC，**本格式不是发行者的数字签名，也不保证插件代码可信**。

## 开发与验证

本项目通过 GitHub Actions 执行依赖安装、单元测试、三平台官方样本回归、Action 集成测试和 CLI 分发包生成。Release 仅包含本项目源代码的 npm `.tgz` 和校验和；无官方原生模块、解密后的插件代码或身份信息。

MIT 许可证仅覆盖本项目代码，不改变 uTools 及其他插件的许可。
