# DSH Plugins

一组为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 写的 Cordis 插件。

A collection of Cordis plugins for DeepSeek Harness.

## 安装 / Install

每个子目录都是一个独立的插件包，用 `plugin_manager` 的 `install_bundle` 安装（参数为目标目录的绝对路径）：

```text
plugin_manager({
  action: "install_bundle",
  target: "<本仓库>/<插件目录>"
})
```

安装后重启 DSH（客户端插件改动需要重新加载页面或重启）。

## 插件列表 / Plugins

| 目录 | 包名 | 说明 |
|---|---|---|
| `account-watch` | `@local/dsh-account-watch` | DeepSeek 余额面板 + 低余额提醒；附带 ChatGPT / Codex 额度条、重置卡列表与「AI 判断是否该用重置卡」 |
| `computer-use` | `@local/dsh-computer-use` | 操作整个 Windows 桌面：截图、鼠标、键盘、启动程序，工作中带屏幕边缘光效 |
| `dsh-think-autoexpand` | `dsh-think-autoexpand` | 让 Think 思考行保持可见并自动展开，同时强制中文思考与回复 |
| `github-workflow` | `@local/dsh-github-workflow` | 通过 GitHub REST API 处理 PR / Issue / 分支 / 提交，带本地 git 工具和对话状态条 |
| `github-mcp` | `@local/dsh-github-mcp` | 接入官方 GitHub MCP server，工具以 `mcp__github__*` 出现在模型侧 |
| `prompt-optimizer` | `@local/dsh-prompt-optimizer` | 输入框「优化提示词」按钮；遇到关键歧义时用原生问题模块向用户澄清 |
| `ui-fixes` | `@local/dsh-ui-fixes` | Web UI 小修补：会话菜单删除入口、插件详情页返回按钮 |
| `codex-model-policy` | `@local/dsh-codex-model-policy` | Codex 模型默认思考档位与旧型号禁用策略 |
| `provider-handoff` | `@local/dsh-provider-handoff` | 从 DeepSeek 切到 ChatGPT 前，先用 DeepSeek 把对话压缩进目标模型上下文上限，再把压缩后的历史发过去；压不下去就阻断，不发原始长对话 |

## 结构约定 / Layout

每个插件目录包含：

```text
<plugin>/
├── package.json          # 含 dsh.bundle.patch / dsh.client 行
├── cordis.patch.yml      # Loader patch，插入插件行
├── index.js              # Host 半边（export function apply）
├── client.js             # （可选）浏览器半边
├── locale/{en,zh}.json   # 显示用标题与描述
└── icon.svg              # 插件图标
```

## 说明 / Notes

- 这些插件面向本地桌面 profile（`~/.dsh/profiles/desktop`），包名统一用 `@local/` 前缀。
- `github-mcp` 的 token 从 `GITHUB_TOKEN` / `GH_TOKEN` 环境变量读取，仓库里不含任何凭据。
- 代码按"能在当前 DSH 上跑起来"为目标编写，未针对公开发布做兼容性保证。

## License

MIT
