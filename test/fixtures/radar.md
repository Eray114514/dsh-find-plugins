# PLUGINS.md — 插件登记清单（分类版）

> 想更快被收录？在对应类别的表格追加一行并提 PR。未登记的仓库只要打 `dsh-plugin` / `dsh-external` topic，会在每日 02:00 全量扫描时自动收录。
>
> 分类体系参考 dsh-external/hub（catalog v0.1）：🔌 单插件 / 🧰 插件集 / 🎓 技能 / 📡 远程渠道 / 🛠 基础设施 / 💬 社区 / 🔬 研究 / ❓ 未分类。
>
> 约定：插件名与 repo 名一致；scope 使用 `@dsh-external/*`（勿占用 `@deepseek-ai/*` 保留命名空间）；repo 打 `dsh-plugin` topic。

## 🔌 单插件

| 插件 | 仓库 | 说明 | 运行级 |
|---|---|---|---|
| dsh-xiaomi-tts | [ppy-web/dsh-plugin-xiaomi-mimo-tts](https://github.com/ppy-web/dsh-plugin-xiaomi-mimo-tts) | Xiaomi MiMo TTS 语音朗读：预置/自定义音色、PCM 流式播放、MP3/WAV 完整音频与浏览器语音双向兜底；支持 MiMo 优先/本地优先/关闭本地语音 | 待测 |
| dsh-wps | [zhengjy01/dsh-wps](https://github.com/zhengjy01/dsh-wps) | WPS / 金山文档云文档集成（官方 SkillHub MCP，mcp__wps__* 工具） | agent |
| dsh-vercel-mcp | [zhengjy01/dsh-vercel-mcp](https://github.com/zhengjy01/dsh-vercel-mcp) | Vercel MCP connection for DSH: official OAuth 2.0 client flow against mcp.vercel.com; Vercel platform tools under mcp__vercel__* | 待测 |
| dsh-worktree | [alpacachen/dsh-worktree](https://github.com/alpacachen/dsh-worktree) | DSH Web 极简 Git worktree 管理：一个按钮和一个对话框创建任务分支 worktree，并直接打开为 DSH Workspace；npm `@alpacachen/dsh-simple-worktree` 1.0.2 | 待测 |
| dsh-session-pin | [PerryLink/dsh-session-pin](https://github.com/PerryLink/dsh-session-pin) | 会话与工作区置顶（双面 host+client）：行级图钉与换色、会话头开关、已置顶面板、持久化 settings 命名空间；0.4.0 再加会话导航组织器——Pin 分组（boards）、标签与保存视图、会话健康摘要（只读脱敏）与 /goto 模糊跳转；全部浏览器本地零网络 | 待测 |
| dsh-session-explorer | [Zn-Dk/dsh-session-explorer](https://github.com/Zn-Dk/dsh-session-explorer) | 会话消息级全文检索浏览器：FTS5 trigram 按消息检索（用户/助手/系统注入/工具，可按类型筛选），fork/续接会话结果自动去重，只读上下文预览自动滚动定位、一键跳转真实会话，增量/全量重建索引 + 健康检查，中英双语跟随 Host locale | 待测 |
| dsh-zhipu-toolkit | [Zn-Dk/dsh-zhipu-toolkit](https://github.com/Zn-Dk/dsh-zhipu-toolkit) | 智谱 BigModel GLM 双端点模型目录（Coding Plan 与普通 API），实时模型发现、实测思考档位映射，可视化设置卡片管理 Key/端点/默认推理档，本地 API Key 支持存入 DSH 凭证库；npm `dsh-zhipu-toolkit`@0.1.0 | 待测 |
| dsh-agentfuse-plugin | [MkaliezZ/dsh-agentfuse-plugin](https://github.com/MkaliezZ/dsh-agentfuse-plugin) | 确定性 fail-closed 工具调用授权门：allow/block/ask 策略门 + 审批链延后 + agentfuse-evidence-schema 证据；配 dsh-policy-test 闭环回归；已获本雷达运行级 [可用] 判定 | ✅ |
