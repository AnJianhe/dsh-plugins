import { buildParameters } from '../index.js'
const beforeDescription=['操作这台 Windows 电脑的任意界面：截屏、移动/点击鼠标、拖拽、滚动、键盘输入、启动程序。','开始任务时先用 action=screenshot 看清屏幕再决定坐标；坐标是屏幕像素，原点在左上角。','每次调用都会让屏幕边缘亮起色光晕，表示电脑正被接管。','点击后界面可能需要时间响应，必要时用 observe=true 直接看结果，或用 action=wait 等待。'].join('')
const afterDescription='操作 Windows 桌面：截图、鼠标、键盘、启动程序。先截图再定位，使用物理像素与网格坐标，不按预览尺寸猜测 DPI。ESC 取消当前操作并持续暂停，只能由本地用户重启插件恢复。'
const after={name:'computer',description:afterDescription,parameters:buildParameters()}
const before=structuredClone(after);before.description=beforeDescription;before.parameters.properties.x.description='屏幕像素横坐标，0 在最左边。';before.parameters.properties.y.description='屏幕像素纵坐标，0 在最上边。'
delete before.parameters.properties.region.required
for(const key of ['x','y','to_x','to_y'])before.parameters.properties[key].type='number';before.parameters.properties.to_x.description='拖拽终点横坐标。';before.parameters.properties.to_y.description='拖拽终点纵坐标。'
console.log(JSON.stringify({metric:'JSON 字符数（非精确 token）',before:JSON.stringify(before).length,after:JSON.stringify(after).length,descriptionBefore:beforeDescription.length,descriptionAfter:afterDescription.length}))
