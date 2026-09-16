## v1.2.0

### 备份与迁移改进

* 完整备份现包含数据库及全部运行配置。
* 保留“仅恢复数据”模式，不影响当前端口、地址和服务配置。
* 新增已有环境“完整迁移”，支持替换数据库、密钥、端口及全部配置，并在失败时自动回滚。
* 支持全新服务器直接迁移：

```bash
sudo bash install.sh --restore /path/to/backup.zip
```

* 已有环境也可通过网页或命令完整迁移：

```bash
sudo subboost migrate /path/to/backup.zip
```
