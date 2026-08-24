# SubBoost v2.8.0

## 中文

### 更新重点

SubBoost v2.8.0 改进 VLESS、TLS、ECH 与 xHTTP 分享链接兼容性，并提升规则管理、预览和复制操作的一致性。本版本同时修复多项第三方依赖安全公告。

### 主要变化

- 改进 Shadowrocket 等来源的 VLESS TLS/ECH/xHTTP 参数解析，从有效复合 ECH 值中保留查询域名，不写入 Mihomo 不支持的解析器 URI，并继续拒绝格式错误的值。
- 优化规则目标、规则类型徽标、自定义代理组和规则集路径显示；禁用自定义代理组后会同步清理无效的规则顺序引用。
- 增强复制订阅链接的兼容性：现代剪贴板接口不可用时使用安全回退，并在复制失败时给出明确提示。
- 更新受安全公告影响的 `deepmerge-ts`、`nanoid`、`brace-expansion`、`fast-uri` 和 `js-yaml` 依赖。

### 升级说明

- 升级前仍建议备份 `/opt/subboost/.env` 和数据库。

## English

### Highlights

SubBoost v2.8.0 improves VLESS, TLS, ECH, and xHTTP share-link compatibility and refines rule management, previews, and copy interactions. It also fixes several third-party dependency advisories.

### Main Changes

- Improved parsing of VLESS TLS/ECH/xHTTP parameters from clients such as Shadowrocket, preserving the query name from valid compound ECH values without emitting unsupported resolver URIs, while continuing to reject malformed values.
- Refined rule targets, rule-type badges, custom proxy-group behavior, and rule-set path display. Disabling a custom proxy group now removes invalid rule-order references consistently.
- Improved subscription-link copy compatibility with a safe fallback when the modern Clipboard API is unavailable and clear feedback when copying fails.
- Updated `deepmerge-ts`, `nanoid`, `brace-expansion`, `fast-uri`, and `js-yaml` versions affected by security advisories.

### Upgrade Notes

- Back up `/opt/subboost/.env` and the database before upgrading.
