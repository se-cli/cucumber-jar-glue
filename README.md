# Cucumber Jar Glue Index

[简体中文](#chinese) | [English](#english)

<a id="chinese"></a>

## 简体中文

项目主页：https://se-cli.github.io/cucumber-jar-glue/

仓库：https://github.com/se-cli/cucumber-jar-glue

Marketplace：https://marketplace.visualstudio.com/items?itemName=se-cli.cucumber-jar-glue （扩展 ID `se-cli.cucumber-jar-glue`）

为 VSCode 的 Gherkin 步骤补齐「Jar 内 Glue 代码」索引：不解压依赖 JAR，直接读取包内 `.class` 的常量池与运行时注解，把 step definitions、hooks、ParameterType 与工作区 Java 源码索引合并，从而支持跳转定义、查找引用和补全。

### 能力

| 能力 | 说明 |
|---|---|
| 定义跳转 | Gherkin 步骤 → JAR 内 Glue 方法，或工作区 `.java` 源码 |
| 查找引用 | 从 Glue 定义反查所有使用它的 Gherkin 步骤 |
| 补全 | 输入步骤时提示 JAR + 源码中的 step pattern，标注来源 |
| 诊断 | 未定义步骤、等价多定义警告 |
| 兼容性 | Cucumber-JVM v1 (`cucumber.api.java.*`) 与 v2+ (`io.cucumber.java.*`)，含任意 locale 的本地化注解 |
| 编辑器兼容 | 同时绑定 `gherkin` 与 `cucumber` language id，并兜底 `**/*.feature`，兼容 Cucumber 官方扩展 |
| 匹配 | Java 正则 + Cucumber Expression 子集；支持发现的自定义 `ParameterType` |

跳转 JAR 内定义时打开的是 `cucumber-glue:` **只读声明视图**（注解、类名、方法签名），不是反编译后的源码。方法体仍需 Java 反编译器扩展。

### 安装

从 Marketplace 安装（推荐）：

```text
扩展 ID: se-cli.cucumber-jar-glue
```

或从 Release 下载 VSIX 离线安装：

```bash
code --install-extension cucumber-jar-glue-0.1.1.vsix --force
```

开发调试：

```bash
npm test
code --extensionDevelopmentPath=D:\code\cucumber-for-Java
```

### classpath 发现顺序

`auto`（默认）依次尝试：

1. Java 语言服务器：`java.execute.workspaceCommand('java.project.getAll')` 取项目 URI，再以项目 URI 调 `java.project.getClasspaths`（优先 `scope: 'test'`）。
2. Maven：`mvn dependency:build-classpath`。
3. Gradle：注入临时 init script 打印 runtimeClasspath（不改你的构建文件）。
4. `cucumberGlue.classpathRoots` 手动 glob。

`pom.xml`、`build.gradle*`、`.classpath`、`gradle.lockfile` 变更后自动增量刷新；JAR 用 `size + mtimeMs` 做身份校验，未变化直接命中磁盘缓存。

### 命令

| 命令 | 作用 |
|---|---|
| `Cucumber: Refresh Jar Glue Index` | 强制重建索引 |
| `Cucumber: Clear Jar Glue Cache` | 清空磁盘缓存并重建 |
| `Cucumber: Show Glue Index` | 列出当前索引的定义并跳转 |

### 主要配置

| 配置 | 默认值 | 说明 |
|---|---|---|
| `cucumberGlue.enabled` | `true` | 总开关 |
| `cucumberGlue.classpathProvider` | `auto` | `auto`/`java`/`maven`/`gradle`/`manual` |
| `cucumberGlue.buildClasspath` | `true` | 允许跑 mvn/gradle 解析 classpath |
| `cucumberGlue.maxJarSizeMb` | `80` | 超过则跳过该 JAR |
| `cucumberGlue.maxClassEntriesPerJar` | `8000` | 单 JAR 解析上限 |
| `cucumberGlue.maxWorkers` | `4` | 扫描线程上限 |
| `cucumberGlue.excludePackages` | 见 `package.json` | 不解析的包前缀 |
| `cucumberGlue.diagnostics.undefined` | `warning` | 未定义步骤级别 |

完整配置项见 `package.json` 的 `contributes.configuration`。

### 开发与发布

运行时零 npm 依赖，测试用 Node 内置 `node:test`。打包：`npm run package`。

- 仓库：`https://github.com/se-cli/cucumber-jar-glue.git`
- Marketplace publisher：`se-cli`（与 `se-cli/se-extension-vscode` 同一组织身份）
- 发布凭据：组织级 GitHub Secret `VSCE_TOKEN`
- 流程：`create-release.yml` 生成 Release 并附 VSIX → 发布 Release 触发 `publish.yml` → `vsce publish`

---

<a id="english"></a>

## English

Project homepage: https://se-cli.github.io/cucumber-jar-glue/

Repository: https://github.com/se-cli/cucumber-jar-glue

Marketplace: https://marketplace.visualstudio.com/items?itemName=se-cli.cucumber-jar-glue (extension ID `se-cli.cucumber-jar-glue`)

This extension fills the gap for Gherkin steps whose glue lives inside dependency JARs. It reads `.class` constant pools and runtime annotations directly from the archive — without extracting it — and merges those definitions with workspace Java sources to provide navigation, references and completion.

### Features

| Feature | Description |
|---|---|
| Go to Definition | Gherkin step → glue method inside a JAR, or a `.java` source file |
| Find References | Find every Gherkin step that uses a glue definition |
| Completion | Suggest step patterns from JARs and sources, labelled by origin |
| Diagnostics | Warnings for undefined steps and information for equally good matches |
| Compatibility | Cucumber-JVM v1 (`cucumber.api.java.*`) and v2+ (`io.cucumber.java.*`), including localized annotations in any locale |
| Editor compatibility | Binds both `gherkin` and `cucumber` language ids, with a `**/*.feature` fallback for the official Cucumber extension |
| Matching | Java regex plus a Cucumber Expression subset; discovers custom `ParameterType`s |

Navigating to a JAR definition opens a `cucumber-glue:` **read-only declaration view** (annotation, class name, method signature), not decompiled source. Method bodies still require a Java decompiler extension.

### Installation

Install from the Marketplace (recommended):

```text
Extension ID: se-cli.cucumber-jar-glue
```

Or download the VSIX from the release and install offline:

```bash
code --install-extension cucumber-jar-glue-0.1.1.vsix --force
```

For development:

```bash
npm test
code --extensionDevelopmentPath=D:\code\cucumber-for-Java
```

### Classpath discovery order

`auto` (the default) tries, in order:

1. Java language server: `java.execute.workspaceCommand('java.project.getAll')` for project URIs, then `java.project.getClasspaths` with the project URI (preferring `scope: 'test'`).
2. Maven: `mvn dependency:build-classpath`.
3. Gradle: a temporary init script prints runtimeClasspath (your build files are not modified).
4. Manual globs from `cucumberGlue.classpathRoots`.

Changes to `pom.xml`, `build.gradle*`, `.classpath` or `gradle.lockfile` trigger an incremental refresh. JARs are identified by `size + mtimeMs`, so unchanged archives hit the on-disk cache.

### Commands

| Command | Purpose |
|---|---|
| `Cucumber: Refresh Jar Glue Index` | Force a full index rebuild |
| `Cucumber: Clear Jar Glue Cache` | Clear the disk cache and rebuild |
| `Cucumber: Show Glue Index` | List indexed definitions and navigate to one |

### Key settings

| Setting | Default | Description |
|---|---|---|
| `cucumberGlue.enabled` | `true` | Master switch |
| `cucumberGlue.classpathProvider` | `auto` | `auto` / `java` / `maven` / `gradle` / `manual` |
| `cucumberGlue.buildClasspath` | `true` | Allow running mvn/gradle to resolve the classpath |
| `cucumberGlue.maxJarSizeMb` | `80` | Skip JARs larger than this |
| `cucumberGlue.maxClassEntriesPerJar` | `8000` | Per-JAR parsing cap |
| `cucumberGlue.maxWorkers` | `4` | Scan worker limit |
| `cucumberGlue.excludePackages` | see `package.json` | Package prefixes never parsed |
| `cucumberGlue.diagnostics.undefined` | `warning` | Severity for undefined steps |

See `contributes.configuration` in `package.json` for all settings.

### Development and publishing

Zero npm runtime dependencies; tests use the built-in `node:test` runner. Package with `npm run package`.

- Repository: `https://github.com/se-cli/cucumber-jar-glue.git`
- Marketplace publisher: `se-cli` (same organizational identity as `se-cli/se-extension-vscode`)
- Publishing credential: organization-level GitHub Secret `VSCE_TOKEN`
- Flow: `create-release.yml` creates a release with the VSIX → publishing the release triggers `publish.yml` → `vsce publish`
