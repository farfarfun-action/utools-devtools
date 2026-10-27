提供独立 UPXS CLI 和可复用 GitHub Action：打包、解包、检查、校验及导出自己的打包身份配置。

仓库归属为 [`farfarfun-action/utools-devtools`](https://github.com/farfarfun-action/utools-devtools)。跨仓库调用使用 `farfarfun-action/utools-devtools@v0.1.3`。

CLI 默认读取项目根目录的 `identity.json`，插件 ID 可明文维护；`mid`、`uid`、`cellphone` 由组织 Secrets 在打包时注入。Action 支持默认项目文件、`identity-file` 路径，兼容旧的 `identity-json` 完整 Secret。打包排除身份配置文件，且不会将私密字段写回项目配置；目标插件 ID 留空时拒绝生成包。

附件 `.tgz` 是本工具的 npm 安装包，**不是 uTools 插件安装包**。下载后用 `npm install --global ./farfarfun-utools-devtools-0.1.3.tgz` 安装。

三平台测试覆盖官方开发工具样本的认证解密、ASAR 文件读取、逐字节重新封装及异常包拒绝；另有 Action 集成测试。

此为技术预览。给自己的插件打包需从自己的官方导出包提取身份，并作为 Actions Secret 提供。新生成包在真实 uTools 客户端的安装接受情况尚未验证。工具不分发官方二进制，不包含官方开发者身份，不绕过账号或团队限制。
