# Computer Use for DSH

Windows 桌面截图、鼠标、键盘、启动程序。保留工具名 `computer`，兼容原有动作名。

## 人工急停与恢复

操作期间按物理 **ESC** 可取消正在执行的 type、drag、wait 等操作，并持续暂停所有后续调用。没有 90 秒自动恢复，也没有模型可调用的恢复参数。**仅本地用户在插件管理器重启此插件，或重启 DSH 应用，才能恢复。**目前没有独立恢复 UI。插件重载会清空本次生命周期的暂停状态。

ESC 使用低级键盘监听，不抢占应用的正常 ESC；忽略带 Windows 注入标记的按键，因此工具自身 `key: esc` 不触发人工急停。`showGlow: false` 仅隐藏光晕，不关闭急停。监听无法建立时拒绝执行操作。ESC 不能撤销已经送出的输入；系统调度及轮询会造成短暂取消延迟。外部强制杀进程、系统卡死、受保护桌面或驱动级输入不在可保证范围内。

## 参数

| action | 参数 |
|---|---|
| screenshot | region?、grid? |
| move | x、y |
| click | x?、y?、button?（left/right/middle）、count?（1/2） |
| drag | x、y、to_x、to_y |
| scroll | x?、y?、amount（-100～100） |
| type | text（非空字符串） |
| key | keys（如 ctrl+shift+s、enter、esc、plus） |
| launch | command、args? |
| wait | ms?（0～10000，默认 500） |

可省略 click/scroll 的整对坐标，使用当前鼠标位置；不能只传其中一项。所有坐标必须是整数，允许多屏负坐标，并校验实际显示器边界。

`observe: true` 完成操作后截图；`grid: false` 同样适用于 observe。region 必须完整提供 x、y、width、height，且处于虚拟桌面范围内。

截图返回物理像素尺寸、原点和网格标注；**不要按图片预览大小猜 DPI 或固定使用 125% 缩放**。使用 Per-Monitor V2 DPI 感知（旧系统回退），多显示器坐标可能为负。混合 DPI 真机仍需验证。

## 配置

保留 `showGlow`（默认 true）、`screenshotGrid`（true）、`glowThickness`（44）、`glowColorA`（#4FD1FF）、`glowColorB`（#B07BFF）、`glowIntensity`（0.92）、`screenshotTimeoutMs`（25000）、`actionTimeoutMs`（15000）。旧 `abortCooldownMs` 与 `glowDurationMs` 不再控制行为：暂停持续至本地重启，光晕覆盖完整操作并在结束后关闭。

截图先确认光晕窗口已隐藏并同步桌面合成，再捕获，不依赖固定延时淡出。取消会在循环/等待中检查，并通过 finally 释放本次按下的键和鼠标。超时先请求协作取消，150ms 后终止本插件 helper；不会终止任何用户应用。新请求等待该终止屏障，旧进程的迟到输出不会污染新请求。

整个工具调用按队列串行执行（包括光晕、截图和取消文件）；排队任务开始时重新检查 AbortSignal 和人工暂停。取消排队任务不会取消当前任务。stdin 通信错误与取消文件写入失败均安全拒绝并停止 helper，不产生未捕获异常。

## 开发验证（不触碰用户窗口）

```powershell
node --test computer-use/test/*.test.js
```

如 Node 不在 PATH，请使用 `load_workspace_dependencies` 返回的 Node 可执行文件。测试包含 mock ctx 参数校验、observe/grid、持续暂停、光晕生命周期、超时隔离，以及只执行 ping/info/wait 的 Windows helper 集成测试。不会向现有窗口发送按键、点击或输入，也不会关闭用户应用。

真实物理 ESC、键鼠 finally 释放及多屏混合 DPI 尚需独立测试窗口/人工验收；源码静态断言不能替代这些端到端验证。安装/重载由维护者统一进行，本目录修改本身不会更新正在运行的已安装插件。
