# SubBoost v1.0.2

## 中文

### 修复
- 修复更新过程中 Release manifest 获取失败时仍继续使用旧镜像的问题。
- 当 `release.json` 下载失败时，更新流程现在会直接终止并报告错误，避免出现“版本已更新但实际仍运行旧镜像”的情况。
- 更新应用容器时增加 `--force-recreate`，确保新版本镜像被重新创建并实际运行。
- 更新完成后增加 `SUBBOOST_IMAGE` 校验，确认 `.env` 中的镜像地址已经成功切换到当前 Release 对应的镜像 digest。
- 改进更新失败时的错误检测，降低更新状态与实际运行版本不一致的风险。

### 说明
- 本版本主要提升 SubBoost 自托管更新流程的可靠性。
- 不涉及数据库迁移。
- 不影响现有订阅、节点、规则、二维码及其他管理后台功能。
- 已安装 v1.0.1 的用户可以直接升级到 v1.0.2。

---

## English

### Fixes
- Fixed an issue where the updater could continue using the old image when the Release manifest could not be downloaded.
- The update process now stops with an explicit error if `release.json` cannot be retrieved, preventing cases where the displayed version is updated while the application is still running the previous image.
- Added `--force-recreate` when updating the application container to ensure the new release image is actually recreated and started.
- Added post-update validation for `SUBBOOST_IMAGE` to verify that `.env` has been switched to the image digest specified by the current Release.
- Improved update failure detection to reduce the risk of version metadata becoming inconsistent with the image actually running.

### Notes
- This release primarily improves the reliability of the SubBoost self-hosted update process.
- No database migration is required.
- Existing subscriptions, nodes, rules, QR code functionality, and other dashboard features are unaffected.
- Users running v1.0.1 can upgrade directly to v1.0.2.