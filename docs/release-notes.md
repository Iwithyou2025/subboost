
本次更新重点改进备份、恢复与完整迁移功能。

## 新增功能

* 支持在全新服务器直接恢复完整备份：

```bash
sudo bash install.sh --restore /root/subboost-backup.zip
```


* 恢复数据库、密钥、端口、访问地址及完整环境配置。
* 支持已有环境通过网页或 `subboost migrate` 执行完整迁移。
* 迁移失败时自动恢复原有环境。
* 新增彻底卸载命令：

```bash
sudo subboost delete
```

## 改进与修复

* 修复 PostgreSQL 初始化期间可能导致恢复失败的问题。
* 全新安装后自动启动备份管理服务。
* 备份文件名优化为：

```text
subboost-backup-年-月-日-时-分-秒.zip
```

* 加强备份文件、配置完整性及迁移结果检查。
* 优化迁移、回滚和资源清理流程。
