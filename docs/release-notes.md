# SubBoost v1.1.0

## 新增

* 网页端备份与恢复功能
* 支持导出完整 ZIP 备份
* 支持通过 ZIP 或 `.dump + .env` 恢复数据
* 恢复前自动创建安全备份
* 恢复失败时自动回滚
* 新增备份管理服务

## 升级

```bash
sudo subboost update
```

如果网页提示备份管理服务未运行：

```bash
sudo subboost agent-install
```

> 恢复会覆盖当前数据库，请提前保管好备份文件。
