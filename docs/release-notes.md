# SubBoost v1.0.5

## 中文

### 新增
- 为“故障切换”代理组新增独立的故障检测时间设置。
- 在“高级设置 → 代理组类型 → 故障切换”中新增二级选择项：
    - 1min
    - 2min
    - 3min
    - 4min
    - 5min
- 选择后会将对应检测间隔写入生成的 Mihomo 配置，例如：
    - 1min → `interval: 60`
    - 3min → `interval: 180`
    - 5min → `interval: 300`

### 兼容性
- 旧配置未设置独立故障检测时间时，仍继续使用原有全局检测间隔。
- 不影响“手动选择”“自动测速”“负载均衡”“直连优先”“拦截优先”等其他代理组类型。
- 不涉及数据库迁移。

### 说明
- 本版本主要增强故障切换代理组的检测频率控制。
- 内置代理组、自定义代理组及相关配置生成逻辑均支持该设置。
- 可从上一版本直接升级。

---

## English

### Features
- Added an independent health-check interval setting for fallback proxy groups.
- A secondary interval selector is now available under:
  `Advanced Settings → Proxy Group Type → Fallback`
- Available intervals:
    - 1min
    - 2min
    - 3min
    - 4min
    - 5min
- The selected value is written to the generated Mihomo configuration, for example:
    - 1min → `interval: 60`
    - 3min → `interval: 180`
    - 5min → `interval: 300`

### Compatibility
- Existing configurations without a dedicated fallback interval continue using the original global test interval.
- Other proxy group types remain unaffected.
- No database migration is required.

### Notes
- This release improves health-check interval control for fallback proxy groups.
- Built-in groups, custom groups, and related config generation paths support the new setting.
- Existing installations can upgrade directly.