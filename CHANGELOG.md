# Changelog / 更新日志

## 0.1.1

- **中文**：修复 `cucumber` language id 兼容问题。官方 Cucumber 扩展把 `.feature` 注册为 `cucumber`，此前仅绑定 `gherkin` 导致跳转、引用、补全和诊断不触发；现在同时绑定 `gherkin`、`cucumber` 并以 `**/*.feature` 兜底。新增中英文双语 README 与 CHANGELOG。
- **English**: Fixed compatibility with the `cucumber` language id. The official Cucumber extension registers `.feature` as `cucumber`; binding only `gherkin` prevented navigation, references, completion and diagnostics from firing. The extension now binds both `gherkin` and `cucumber`, with a `**/*.feature` fallback. Added bilingual README and CHANGELOG.

## 0.1.0

- **中文**：首个版本。支持从 JAR 内 `.class` 元数据索引 Cucumber v1/v2+ Glue，提供定义跳转、查找引用、补全、诊断、磁盘缓存与 Maven/Gradle/Java LS 依赖发现。
- **English**: Initial release. Indexed Cucumber v1/v2+ glue from `.class` metadata inside JARs, with go-to-definition, find references, completion, diagnostics, disk caching and Maven/Gradle/Java LS classpath discovery.
