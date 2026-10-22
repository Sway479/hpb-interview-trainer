# 公开源码开发

源码对应 Android 手机独立版；电脑网关可选。Node.js >=22.12，建议24；JDK21，Android SDK platform36及build-tools36.0.0。不要复制其他操作系统的node_modules或SDK。

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev -w @hpb/mobile
```

Mac/Unix：设置 ANDROID_HOME 和 JAVA_HOME 后运行 `bash tools/build-android.sh`。
Windows：运行 `./tools/build-android.ps1`。Gradle Wrapper 已随源码提供。
构建使用开发者自己的 debug 签名；公开仓库不提供原开发签名私钥。
包检查参见 tools/inspect-android.sh、docs/ANDROID_BUILD.md、docs/MACOS_DEVELOPMENT.md。

本仓库不带node_modules、SDK、APK构建输出、真实密钥或本地历史验收目录。
旧文档中 artifacts/ 路径指向开发时的私有证据，公开状态摘要见 OPEN_SOURCE_STATUS.md；文件引用不代表公开提供了原始档案。

浏览器可操作离线登记与JSON备份；原生网络、Key和语音必须另在安卓验证。
`npm test`是本地测试；`probe:*`及部分scripts/verify-*为人工联调工具，会读取本地配置或发起收费请求，不应作为无密钥CI自动运行。
独立App无需.env。只有人工使用旧网关或联调脚本时才按.env.example建立自己的本地配置，不能提交。

API/联网测试前阅读脚本，指定专用设备与新的输出目录，保留旧证据。
不得为获得通过而清除个人设备或真实科研记录。
