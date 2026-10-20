# dsh-think-autoexpand

DeepSeek Harness Web 客户端插件：让执行过程中的 Think 思考行始终可见并自动展开，并让 Agent 的思考语言跟随 Harness 界面语言。

## 功能

- 强制显示被 dsh-auto-collapse 等折叠插件隐藏的 `[data-variant="think"]` 思考行
- 思考行进入 `running`（流式输出中）状态时自动展开，完整思考过程实时可见
- 不干扰工具卡的折叠效果（保留 dsh-auto-collapse 对工具卡的行为）
- 每个回合注入中文语言规则（通过官方 agent/pre-step 机制）：始终强制中文思考（Think / reasoning）与回复
  - 规则本身用中文书写，避免自指矛盾
  - 兼容 minimal 等使用 complete persona 的预设（普通 system prompt 会被该预设丢弃）

## 安装

本插件作为 `AnJianhe/dsh-plugins` 仓库中的独立子目录发布。请先下载仓库，再按仓库根目录 README 的说明安装本目录。

安装后重启 dsh Web 服务生效。

## 卸载

```bash
dsh plugin --profile web-desktop remove dsh-think-autoexpand
```
