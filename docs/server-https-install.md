# 安装模式与 HTTPS

安装脚本首次运行（包括 `--restore backup.zip`）提供：

1. 本地安装：沿用原有地址、端口及 HTTP 行为，不创建 Caddy。
2. 服务器安装：输入域名，选择自动证书或导入证书。内部端口自动选择，应用仅绑定 127.0.0.1，公网仅发布 Caddy 的 TCP 443。

服务器模式要求 Compose >= 2.24.4。缺少 curl、OpenSSL、Python 3、timeout 时会尝试通过 apt/dnf/yum 安装。缺少 Docker/Compose 沿用现有安装流程；已安装但版本过旧的 Compose 会明确报错，不自动更换正在使用的 Docker 软件包。

## 自动申请

将 A/AAAA 正确解析到服务器，关闭 Cloudflare 橙云，放行 TCP 443。脚本配置 Caddy 使用 TLS-ALPN-01，自动申请和续期证书，不需要 80。后续续期同样需要域名直连。脚本只需域名，不需要邮箱、DNS API Token，也不需要手工创建证书。

若要一直开启橙云，请使用导入证书模式；本版本不实现 DNS API 验证。

## 导入证书

默认支持直接粘贴：先粘贴完整 PEM 证书/证书链（不是裸公钥），另起一行输入 `DONE` 回车；再粘贴完整未加密私钥，以相同方式结束。输入不回显；从 `/dev/tty` 读取，兼容 `curl | sudo bash`，不消耗脚本标准输入。也支持输入两个本地文件路径。

脚本检查 PEM 格式、生效时间、至少剩余 24 小时、域名匹配及证书/私钥匹配（RSA/EC）。不检查吊销状态，也不替代 CA 信任校验。公网验证不使用 `-k`。

Cloudflare Origin CA：橙云开启，SSL/TLS 为完全（严格）；Cloudflare 边缘证书也必须覆盖域名。普通浏览器不能直接信任源站证书。Cloudflare 会终止 TLS，可以接触请求内容。导入的证书不由 Caddy 自动续期；到期前替换 `https/origin.pem` 和 `https/origin.key`，通过 `subboost restart` 重启加载。

## 自动化参数

```bash
sudo env SUBBOOST_INSTALL_MODE=server SUBBOOST_DOMAIN=sub.example.com \
  SUBBOOST_TLS_MODE=auto bash install.sh
```

导入文件：增加 `SUBBOOST_TLS_MODE=import`、`SUBBOOST_TLS_CERT_FILE=/path/fullchain.pem`、`SUBBOOST_TLS_KEY_FILE=/path/key.pem`。非交互安装另设 `SUBBOOST_ASSUME_YES=1`；恢复安装仍按原有要求提供迁移管理员密码。不要将私钥内容放入命令行变量。

## 故障与恢复

- 443 占用：在写 HTTPS 配置、启动应用之前停止；不终止其他服务。
- 下载、镜像拉取：有限重试；HTTP 下载设连接和总超时；镜像下载仍受 Docker daemon 自身网络超时控制。
- DNS：有 20 秒超时；展示 A/AAAA 结果，无法仅从本机证明外网可达。云安全组不能在没有云账户授权的情况下自动修改。
- 本机 HTTPS 成功、公网 522：检查 DNS 指向、443 安全组、FORWARD/DOCKER-USER、Cloudflare 完全（严格）。不会为了通过检查清空防火墙。
- 525/526：检查证书、主机名和 Cloudflare 模式。
- TLS 初始化/公网检查失败：返回非零；保留应用和数据，HTTP 仍仅本机可用。修复后执行 `sudo subboost restart`、`sudo subboost doctor`；不要重新恢复数据库或重新生成 ENCRYPTION_KEY。
- 服务器安装配置提交前失败：清理本次生成的 HTTPS 文件；已存在的 HTTPS 文件不会被自动覆盖。
- 安装脚本第一次启动前 `curl` 不存在时，需先安装 curl 才能执行 curl 管道命令。

## 升级、备份、卸载

`https-compose.yml` 和 `https/` 是本机配置，不被发行版 Compose 覆盖。管理命令始终合并该文件，包括候选升级、回滚、重启、恢复和卸载。旧管理脚本不支持此文件时拒绝升级。服务器模式标记存在而文件丢失时拒绝启动，避免重新暴露 HTTP。

应用更新保留 HTTPS；Caddy 证书数据保存在独立命名卷。`subboost restart` 会重启 Caddy 以加载替换后的导入证书。

现有 ZIP 数据备份格式保持兼容，不包含 TLS 私钥或 Caddy 自动证书卷。迁移时重新选择服务器模式并自动申请或重新导入证书；数据 ENCRYPTION_KEY 保持原值。请另行安全保管导入证书和私钥。

卸载通过同一 Compose 项目删除本项目 Caddy、网络、证书卷和数据；不卸载系统 Docker/Nginx，不删除共享 Caddy 镜像。

## 发布与 CI

必须将本次 install.sh、subboost-manager 和 Compose 发行资产一起发布。仅替换 install.sh、仍下载旧管理脚本时，服务器模式会拒绝继续。

CI 保留原 lint/coverage/应用完整构建；新增 Docker/Caddy 实际 HTTPS 联通、loopback 端口合并、上游重建后的恢复及自动证书配置校验；新增生产 Dockerfile 构建（不推送镜像）。集成测试使用临时自签证书并指定信任，**不验证真实 ACME 签发、Cloudflare 或云安全组**。

本次开发基于用户提供的 subboost-main(8).zip。远程工作流是否运行成功应以 GitHub Actions 的实际结果为准。


## 安装中断后继续（无需重新恢复数据库）

应用和数据已经恢复、仅 HTTPS 失败时，不要再次 `--restore`，也不要卸载。
修复 DNS/443 网络后执行 `sudo subboost restart`；需要重新选择证书方式时：

```bash
curl -fsSL https://github.com/Iwithyou2025/subboost/releases/latest/download/install.sh | sudo bash -s -- --resume-https
```

此入口要求已有新版服务器模式安装记录，只修改 HTTPS 配置，保留数据库、
加密密钥及应用端口。可以从自动证书切换为导入证书；新配置验证失败会恢复旧配置。
执行该命令需要包含此修复的正式版安装脚本。

自动证书模式会在创建服务前检查 DNS。Cloudflare 官方代理地址段或非公网地址
将被拦截；可重新检查或更换证书方式。该检查不能证明公网入站 TCP 443 可达，
也无法识别所有第三方 CDN；仍需将全部 A/AAAA 指向本机并开放云安全组。
Cloudflare 地址段来自官方 ips-v4/ips-v6 列表，内置快照需随官方变更更新。

`subboost --help` 查看帮助；`subboost doctor` 会检查本机 HTTPS 和公网入口。
独立外部代理的安装也会检查公网 HTTPS；仅显示应用健康不会代表代理已启动。
公网验证通过只代表公网端证书可信，导入 Cloudflare Origin CA 时仍必须使用
Cloudflare 的完全（严格）模式确保回源证书校验。

## 卸载旧手动 HTTPS 部署

卸载会在删除数据库前检查项目网络的外部容器。若旧独立 Caddy 占用网络，
先执行以下命令移除旧代理容器（保留证书文件），然后重试 `sudo subboost delete`：

```bash
sudo docker compose -f /opt/subboost-https/compose.yml down
```

不自动删除未知项目，也不自动删除旧目录的证书。新版服务器模式的 Caddy
属于同一个 Compose 项目，会随 SubBoost 完整卸载。删除前请把备份保存到安装目录外。
