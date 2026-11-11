# Profile 配置守护

DSH 的 profile 配置（`cordis.patch.yml`）曾在运行时不匹配、启动反复崩溃后被重置成空数组，导致 `llm-pi-ai.providers.openai-codex` 等条目整体丢失、模型列表里的 ChatGPT/Codex 模型消失。本插件用于兜住这类事故。

## 行为

- 启动约 8 秒后检查一次，之后每 60 秒检查一次 `$DSH_PROFILE_DIR/cordis.patch.yml`。
- 健康时把内容存成快照：`$DSH_PROFILE_DIR/.profile-guard/snapshots/patch-<时间>.yml`，最多保留 20 份，内容没变就不重复写。
- 判定异常的条件（任一命中）：
  - 文件为空、或只剩 `[]`、或解析不出任何条目；
  - 条目少于 6 个；
  - `agent-default-model`、`permission`、`llm-deepseek`、`agent-loop`、`subagent`、`llm-pi-ai` 中有 3 个及以上缺失。
- 异常时先把坏文件另存为 `.profile-guard/broken-<时间>-cordis.patch.yml`，再从最新健康快照恢复，并追加一行日志到 `.profile-guard/guard.log`。
- 恢复写盘后需要重启 DSH 才会被 Loader 重新组合，插件不会擅自重启进程。

只缺一两个关键条目（例如用户主动删掉 `subagent`）不会触发恢复，避免跟正常的手工精简打架。

## 注意

- 快照目录在 profile 下，不影响 Loader 组合（隐藏目录）。
- 插件本身只读写 `cordis.patch.yml` 与 `.profile-guard/`，不碰 `package.json` 与其他插件。
