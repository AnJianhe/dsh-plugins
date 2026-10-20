# Codex 模型策略

作用范围：本 DSH profile 的 `openai-codex` 路由，不影响 DeepSeek 或其他提供商。

默认档位：GPT-6 Astra=low；GPT-6.1 Sol=medium；GPT-6 Sol=low；GPT-6 Luna=max。在 agent/request 阶段补齐未指定的 effort，进入模型能力校验之前生效并写入正常请求日志。显式指定的合法档位保留，不强制锁档。无显式档位的辅助调用通过 llm 正规入口补齐。

禁用 GPT-5.6 Sol/Terra/Luna 和 GPT-5.5，包括带后缀的相应快照：从 Codex 模型目录删除，并在 agent/request 和 llm/stream 阻止直接调用。不把请求静默换到其他型号。仅当部署默认模型是已禁用型号时，部署默认改为 GPT-6.1 Sol/medium；其他提供商默认不变。

启动后使用 configEditor 的正规接口保存 provider 配置，保留其他提供商、路由参数和未禁用的其他目录项，不读取或复制认证凭据。仅为四个目标型号声明 low/medium/high/xhigh/max；本机 pi-ai 不支持 Codex 多代理 Ultra，不将它伪装成 API 参数。

`applied-status.json` 是脱敏的应用结果和本地能力解析核对结果，不包含密钥，不会为了验证发送付费推理请求。模型选择器元数据没有按型号默认值的现成扩展接口，因此“提供商默认”实际进入请求时由此策略补齐，界面不会伪造为官方默认。用户手动选择其他档位优先。既有会话已明确保存的档位也保留；要采用新默认，请在模型选择器选择默认档或新建会话。

卸载插件后，已通过 configEditor 保存的目录限制不会自动撤销。修改前后的提供商配置不写入报告，避免泄漏部署信息；重新允许旧型号须在模型设置中主动调整目录。
