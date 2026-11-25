# Changelog / 更新日志

## 0.1.6

- **中文**：修复反编译视图跳转不定位的问题。此前 `cucumberGlue.jarDefinitionView` 设为 `decompiled` 后，`Ctrl/Cmd+click` 只打开反编译文件并停在第一行；现在会解析反编译源码，按方法名、参数个数和参数类型（含重载区分）定位到方法声明所在行并选中方法名。「Open Decompiled Source」命令同样会滚动并选中目标方法。
- **English**: Fixed decompiled navigation landing at the top of the file. With `cucumberGlue.jarDefinitionView` set to `decompiled`, `Ctrl/Cmd+click` used to open the decompiled file at line 1; it now parses the decompiled source and locates the method declaration by name, arity and parameter types (overloads included), then selects the method name. The `Open Decompiled Source` command also reveals and selects the target method.

## 0.1.5

- **中文**：新增 `cucumberGlue.jarDefinitionView` 设置，可直接控制 `Ctrl/Cmd+click`（转到定义）打开 JAR 内 Glue 时使用哪种视图，无需再手动执行命令。设为 `decompiled` 后，跳转直接打开反编译源码；没有可用反编译器时自动回退到声明视图，不会跳转失败。默认值仍为 `declaration`，需要时改为 `decompiled` 即可全局生效。
- **English**: Added the `cucumberGlue.jarDefinitionView` setting, which controls what `Ctrl/Cmd+click` (Go to Definition) opens for glue inside a JAR, so the command no longer has to be run by hand. With `decompiled`, navigation opens decompiled source directly and transparently falls back to the declaration view when no decompiler is available, instead of failing. The default remains `declaration`; switch it to `decompiled` to apply it workspace-wide.

## 0.1.4

- **中文**：新增 `Cucumber: Open Decompiled Source (JAR Glue)` 命令（`Ctrl/Cmd+Alt+D`）。在 Gherkin 步骤或声明视图方法上执行，即可从 JAR 提取对应 `.class`、调用 Java 语言服务器的 `java.decompile`，以只读虚拟文档打开反编译源码；无可用反编译器时回退打开 `.class` 并提示。
- **English**: Added the `Cucumber: Open Decompiled Source (JAR Glue)` command (`Ctrl/Cmd+Alt+D`). From a Gherkin step or a declaration-view method it extracts the matching `.class` from the JAR, calls the Java language server's `java.decompile`, and opens the decompiled source in a read-only virtual document. Without a decompiler it falls back to opening the `.class` file with a warning.

## 0.1.3

- **中文**：修复重复 Glue 定义与方法名误判。源码扫描统一排除 `.local-state/temporal/runs/` 等历史运行快照目录，刷新、枚举和文件监听使用同一规则，避免 31 份历史副本被当成 31 个定义。重写方法签名解析，正确处理参数中的 `@Transform(...)` 等嵌套括号，不再把方法体里的 `if (...)` 错认成方法，方法名恢复为 `assertVersionNotLessThanPersisted`。
- **English**: Fixed duplicate glue definitions and misidentified method names. Source scanning now consistently excludes historical run snapshots such as `.local-state/temporal/runs/` across refresh, enumeration and file watchers, so 31 archived copies no longer become 31 definitions. Method signature parsing was rewritten to handle nested parentheses in parameter annotations like `@Transform(...)`, instead of mistaking a body `if (...)` for the method; the method name is now correctly `assertVersionNotLessThanPersisted`.

## 0.1.2

- **中文**：修复多模块项目支持。Java 语言服务器现在聚合工作区内所有匹配子模块项目的 classpath，而不再只匹配工作区根目录或第一个项目；Maven 回退改为按模块分别写 classpath 输出再合并，避免最后一个模块覆盖先前结果。子模块 `pom.xml` 变化也会触发快照失效。
- **English**: Fixed multi-module project support. The Java language server now aggregates classpaths from every matching module project instead of only the workspace root or the first project. The Maven fallback writes one classpath output per module and merges them, so the last module no longer overwrites earlier ones. Changes to submodule `pom.xml` files now invalidate the cached snapshot.

## 0.1.1

- **中文**：修复 `cucumber` language id 兼容问题。官方 Cucumber 扩展把 `.feature` 注册为 `cucumber`，此前仅绑定 `gherkin` 导致跳转、引用、补全和诊断不触发；现在同时绑定 `gherkin`、`cucumber` 并以 `**/*.feature` 兜底。新增中英文双语 README 与 CHANGELOG。
- **English**: Fixed compatibility with the `cucumber` language id. The official Cucumber extension registers `.feature` as `cucumber`; binding only `gherkin` prevented navigation, references, completion and diagnostics from firing. The extension now binds both `gherkin` and `cucumber`, with a `**/*.feature` fallback. Added bilingual README and CHANGELOG.

## 0.1.0

- **中文**：首个版本。支持从 JAR 内 `.class` 元数据索引 Cucumber v1/v2+ Glue，提供定义跳转、查找引用、补全、诊断、磁盘缓存与 Maven/Gradle/Java LS 依赖发现。
- **English**: Initial release. Indexed Cucumber v1/v2+ glue from `.class` metadata inside JARs, with go-to-definition, find references, completion, diagnostics, disk caching and Maven/Gradle/Java LS classpath discovery.
