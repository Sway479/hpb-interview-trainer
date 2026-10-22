# v0.1.0 验收记录与使用范围

日期：2026-10-21。所有病例及测试发言均为虚构教学内容。测试数据使用独立目录，未使用真实患者病历。

## 已核实的功能

| 验收内容 | 结果与证据 | 可以说明什么 |
|---|---|---|
| 核心业务、鉴权、状态保存、语音打断、迟到响应、最终转录、反馈引用与量规校验 | `npm test`：41/41通过；`artifacts/final-tests.txt` | 预设边界和本地HTTP/WebSocket协议回归通过；不是实际教学效果研究。 |
| TypeScript检查 | `npm run typecheck`通过，含mobile；`artifacts/final-typecheck.txt` | 当前源码通过静态类型检查。 |
| 实际千问接口 | `artifacts/qwen-text-audio-probe.json`、`qwen-audio-probe.json`、`qwen-flash-probe.json` | 指定实时模型和Flash实际鉴权、语音/HTTP接入成功。 |
| 浏览器真实音频链路 | `artifacts/ui/browser-audio-e2e.json`，8项检查通过、页面错误0 | 独立Edge浏览器采集合成中文语音，经历wavtools→网关→Qwen ASR→工具调用→Flash→患者音频；另完成4次文字追问、结束、独立总结与12项反馈。模型响应来自真实API。 |
| 最终评分界面及操作 | `artifacts/ui/feedback-ui-verification-receipt.json` | 同一真实模型反馈在最终UI显示两组参考分、覆盖率和原始来源；原文跳转、WAV音频对象、合成复核备注持久化和JSON导出通过；独立全null界面样本显示“未能评分”，未篡改服务端数据。此步骤未额外调用模型。 |
| MCP适配 | `artifacts/mcp-verification.json`，5项检查通过 | 从不同工作目录启动stdio客户端，列出6个工具；MCP与HTTP共享病例、持久会话及总结门控。尚未逐一配置所有第三方运行框架。 |
| Android构建与包内容 | `artifacts/android/build-receipt.json`、APK badging/permissions/signature及资源清单 | 最终调试APK能够编译、签名，包内前端与当前构建产物逐文件对应。APK身份以收据中的SHA-256为准。 |
| Android模拟器运行 | `artifacts/android/runtime-verification.json`及最终截图 | 对最终APK执行安装与启动，核对4个病例、WebView83、安全媒体API及16k/24k音频上下文和AudioWorklet帧。模拟器无音频硬件质量保证，见下述边界。 |
| 生产依赖审计 | `artifacts/production-audit.json`：0项已知漏洞 | 这是本次npm生产依赖扫描结果；不等于代码不存在缺陷。开发依赖仍有3项moderate记录，来自Capacitor CLI的iOS工具链，未采用强制降级修复。 |
| 分发包凭证检查 | `artifacts/delivery-secret-scan.json` | 检查Git忽略本地`.env`，在候选源码、解压后的APK和源码ZIP中逐项查找实际配置的API凭证。源码包不包含`.env`和训练数据。 |

最终原生截图的卡片间距约10 CSS像素、图标与正文间距15像素，旧WebView的flex间距回退已实际生效。运行日志保留了3条Capacitor SystemBars在DOM就绪前注入安全区样式时捕获的日志；本地上游源码会在页面可见后重新请求insets，最终CSS变量存在，截图未见遮挡，未记录Uncaught或FATAL异常。带刘海屏与手势导航的实际手机布局仍归入真机验收范围。

## 本次Flash观察

完整浏览器测试包含6次病例应答请求和1次反馈请求。病例应答HTTP耗时约2.3–4.7秒，反馈请求约18.6秒；这些数值来自一次合成测试，不代表不同网络、时段或长对话的性能分布，也不包含完整语音呈现耗时。

本次患者回答与固定病例内容相符，反馈具备有效原文引用。但过程评分出现了可能给高及漏用跨发言证据的情形，具体片段见 [首次反馈抽查](ASSESSMENT_SPOTCHECK.md)。当前证据支持将Flash用作首版病例内核及反馈草稿；自动评分仍需带教教师复核和后续校准。

## 当前可使用的范围

- Android App、本机教学服务、4例虚构病例、连续语音与文字补充、独立总结、形成性反馈、会话回看、录音回放、本机复核备注及导出。
- HTTP与MCP复用同一病例/会话内核。长期模型密钥保留在本机服务配置中。
- 改编量规参考Calgary–Cambridge可观察过程与GCRS分档思路；共5个病例信息项及7个过程项。两组只显示已评部分和覆盖率，不设置百分制总分或合格线。
- 独立总结被保存和展示。本版未实现单独的小结质量评分，也未实现教师逐项改分。

## 尚未由本次验收确认的范围

- 实际安卓手机的外放回声、环境噪声、耳机及蓝牙路由、长时运行、来电与后台恢复，以及医院Wi-Fi/代理条件。
- 病例专家审定、评分者校准、中文语音AI评分效度、不同病例/年级的公平性，以及教学效果。
- 医院身份系统、多用户权限隔离、正式考试发布和生产部署。本机教师备注用于单用户工作区。

首次手机试用时，先按README在同一Wi-Fi启动配对服务，佩戴耳机完成一个虚构病例，再由带教者核对病例回答、转录和自动反馈。这是原型的下一步使用验收，不是已完成的研究结果。
