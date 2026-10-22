# 在 Mac mini 的 Codex 接续开发

## 1. 接续范围

本次迁移将 Android v0.2 项目的源代码、固定依赖清单、病例与量规、原生桥、测试、设计和历史验收资料交给 Mac。Mac 作为新的开发机，产物仍是安卓 App；这项迁移不生成 iOS App。已安装手机的 App 数据留在手机中，项目目录搬迁不会自动读取或迁移手机私有资料。

跨平台复用模式为 `generalize`：增加 macOS 开发和构建入口、参数化可选 QA 工具路径。病例、评分逻辑、模型协议和原生 Java 不因迁移修改。Windows 的 PowerShell 入口保留。原始 Windows 验收结果按其原始时间与 APK 哈希保留，Mac 的新记录单独写入。

## 2. 开发机依赖

| 工具 | 项目要求 | Apple Silicon 注意事项 |
| --- | --- | --- |
| Node.js / npm | Node.js 22.12 以上，建议 24；用 `npm ci` 安装 lockfile 中的版本 | 安装 macOS arm64 版本，重新安装依赖 |
| JDK | 21 | 使用 arm64 JDK 21，`JAVA_HOME` 指向 `Contents/Home` |
| Android SDK | platform-tools、platforms;android-36、build-tools;36.0.0 | Android Studio 或 command-line tools 均可；不要复制 Windows SDK |
| Python | Python 3，标准库即可 | 可由 `HPB_PYTHON` 指定绝对路径 |
| Gradle / AGP | Wrapper 固定 Gradle 8.14.3、AGP 8.13.0 | Wrapper 由源码提供，首次构建按官方地址下载；无需全局 Gradle |
| 可选 QA | Playwright、Chrome/Edge 或 Playwright Chromium | 只在运行浏览器/设备脚本时需要；不影响正常构建 |

不要复用 Windows 的 `node_modules`、JDK、Android SDK、`.gradle` 或构建输出。它们含有宿主相关的可执行文件和缓存。源码里的 `apps/mobile/android/local.properties` 是忽略的本机配置，构建入口会重新写入 Mac SDK 路径。

## 3. 从源码恢复开发环境

在 Codex 打开本项目根目录后执行：

```bash
node --version
npm --version
uname -m
npm ci
npm run typecheck
npm test
npm run build
```

依赖安装或上述命令失败时先修复错误，不以旧 `dist` 或旧 APK 代替这台 Mac 的结果。最初的源代码包中不应夹带 `node_modules`。

只预览独立版界面：

```bash
bash tools/start.sh
```

预览监听 `http://127.0.0.1:5173`。浏览器预览支持界面和本地登记演练；加密 Key、原生网络、真实语音与安卓 ZIP 分享需在安卓 App 中验证。预览不需要读取 `.env`。

可选的旧电脑教学网关和 MCP 入口分别为 `bash tools/start.sh legacy`、`bash tools/start.sh mcp`，使用其原有本地配置。它们不构成手机独立使用的必要服务。

## 4. Android 构建

典型 Mac 配置：

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
bash tools/build-android.sh
```

脚本将执行当前 web 构建、Capacitor Android sync、Gradle debug 打包、逐文件比较 APK 内 web 资产与当前 `dist`、逐份核对许可证，并检查签名和原生策略。它不读取服务商 Key。

非标准安装目录可显式传入：

```bash
HPB_PYTHON=/absolute/path/to/python3 bash tools/build-android.sh \
  --sdk-root /absolute/path/to/android-sdk \
  --java-home /absolute/path/to/jdk-21/Contents/Home
```

默认新增产物位于 `artifacts/android-macos/`，包括 APK、web 资产哈希清单、构建回执和 `.inspection.json`，不会覆盖 `artifacts/v0.2.0` 的历史交付。`GRADLE_USER_HOME` 未配置时使用项目 `.cache/gradle-macos`。

独立检查已有 APK：

```bash
bash tools/inspect-android.sh artifacts/android-macos/hpb-voice-standalone-debug.apk
```

`--preliminary` 创建单独命名的初步构建。`--skip-web-build`、`--skip-sync` 仅供已单独核对当前产物的开发迭代使用，完整交付仍应使用默认全流程。构建或包检查通过不等于设备语音链路、录音完整性或教育效果通过。

## 5. 保持现有手机的更新签名

同包名覆盖安装还需要兼容的签名证书。Mac 自行生成的默认 debug key 通常与原 Windows 证书不同。不要为解决安装签名冲突而卸载带有科研记录的 App。

原开发机的 debug keystore 应独立、安全传输，不放入公开源码包或 Git。Mac 可将其存入项目私有目录 `.private-signing/debug.keystore`；该目录已被 Git 排除。构建脚本的选择顺序为：

1. 命令行 `--debug-keystore /absolute/private/path/debug.keystore`。
2. `HPB_DEBUG_KEYSTORE` 环境变量。
3. 项目 `.private-signing/debug.keystore`。
4. 未配置以上路径时，使用这台 Mac 的普通 debug key，并输出签名提醒。

脚本通过 `-PhpbDebugKeystore=...` 交给 Gradle；只有明确配置此属性时才改变 `debug` 签名路径，Windows 默认配置保持原样。此入口只支持标准 Android debug 密码和别名，不用于 release 发布签名。

构建后比较新 `.inspection.json` 的 `signatureCertificateSha256` 与历史 v0.2 `.inspection.json`。一致才有证据支持沿用同一证书；实际安装仍以 Android 安装器结果为准。覆盖更新前在手机导出需要保留的完整研究 ZIP，另存并核对。

## 6. 安卓设备、模拟器和可选 QA

物理安卓设备可从 Mac 通过 USB 使用：

```bash
"$ANDROID_HOME/platform-tools/adb" devices
"$ANDROID_HOME/platform-tools/adb" -s DEVICE_SERIAL install -r \
  artifacts/android-macos/hpb-voice-standalone-debug.apk
```

如果使用 Mac mini 的模拟器，应新建适合该主机的 ARM64 AVD。Windows x86_64 模拟器及其快照不作为 Apple Silicon 的可用执行环境。不得在已有个人模拟器上执行清数据操作来满足验收。

QA 脚本的工具路径已经参数化：

| 环境变量 | 作用 |
| --- | --- |
| `HPB_ADB` | 指定 adb；否则根据 `ANDROID_HOME` 或 Mac 默认 SDK 路径解析 |
| `HPB_ANDROID_SERIAL` | 明确测试设备序列号，默认 `emulator-5554` |
| `PLAYWRIGHT_MODULE` | 指定已安装 Playwright 模块的绝对目录；否则尝试项目依赖或 Codex bundled runtime |
| `HPB_BROWSER_EXECUTABLE` | 浏览器 QA 的 Chrome/Edge 可执行文件；否则查找 Mac 应用，找不到时由 Playwright 使用自己的 Chromium |
| `HPB_PYTHON` | 指定 Python；Mac 默认 `python3` |

这些是开发与验收工具，不属于 App 安装依赖。历史 `verify-browser.cjs` 是旧网关媒体验收，不能拿它的旧流程说明 v0.2 独立版在 Mac 已验收。`verify-standalone-final.cjs` 依赖先前专用模拟器中的已保存会话，不能在空白新设备上直接复用其结论。

先做不调用云模型的检查，再按授权安排真实语音/文字请求。`verify-standalone-android.cjs` 会读取本机 `.env`，调用付费千问并创建带有 `SIMULATED_ONLY` 标识的测试资料；运行它前必须确认 Key、专用设备、测试数据和输出路径。旧脚本默认会写 `artifacts/standalone`；需要重跑时先另存历史验收，再记录本次输出及 APK 哈希。任何调试输出都不得回显 Key。

## 7. Codex 接续时要保留的判断

- 主目标是手机独立的临床问诊教学训练，安卓 App 直连配置的 HTTPS/WSS API。
- 多服务商按协议适配；目前只有 Qwen 的真实完整链路有历史验收，其他适配的模拟测试不等于真实账号通过。
- 原始模型预评与教师记录分开保留；自动反馈还存在给分偏高及漏评，正式研究结局需独立教师评分和量规校准。
- 案例是编写的虚构案例。软件的 `SIMULATED_ONLY` QA 不得作为真实研究受试者数据。
- 科研登记、UUID 关联、训练时快照、原始 AI 反馈、教师复核及录音边界继续沿用 v0.2 数据契约。
- 原始文件、Windows 历史交付和验收资料保留版本；Mac 的新构建和新验收单独记录。

具体历史能力与不足以 [VERIFICATION_STANDALONE.md](VERIFICATION_STANDALONE.md)、[ASSESSMENT_SPOTCHECK.md](ASSESSMENT_SPOTCHECK.md) 和 [STANDALONE_MIGRATION.md](STANDALONE_MIGRATION.md) 为依据。

## 8. 跨环境复用记录

| 材料 | 角色 | 修改 | 接受标准 |
| --- | --- | --- | --- |
| `package.json` / lockfile | 依赖与标准执行入口 | 无 | Mac `npm ci`、typecheck、现有测试与 web build |
| `tools/*.ps1` | Windows 原入口 | 无 | 保留原文件 |
| `tools/build-android.sh`、`inspect-android.sh`、`android_artifact.py` | Mac 构建与产物核对 | 新增 | Bash 语法、资产与许可证逐字节核对、Mac 真机构建与包检查 |
| `tools/start.sh` | 界面预览/可选旧入口 | 新增 | 无 Key 的浏览器预览可启动 |
| `scripts/platform-tools.cjs` 及 QA 导入点 | 开发机工具路径 | 参数化 | JS 解析、环境变量覆盖、原测试行为保留 |
| Android debug 签名配置 | 可选私有签名迁移 | 仅指定属性时生效 | 原 Windows 构建可解析，Mac 新 APK 证书指纹比对 |
| `artifacts/v0.1.0`、`v0.2.0`、历史验收 | 历史依据 | 无 | 原哈希和时间不改，新的 Mac 验收另写 |

调用链仍为：`固定源码与 lockfile → 本机依赖恢复 → TypeScript/Vite → Capacitor sync → Gradle/SDK → APK → 包检查 → 单独的设备验收`。本次允许变更宿主路径、脚本包装及机器配置，不改教学和评分算法。仅静态检查或 Windows 运行不支持“Mac 已构建通过”；根任务的实际 Mac 回执补齐后才可给出对应结论。
