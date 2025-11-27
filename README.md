# PyTorch Structure Viewer

快速、清晰地查看 PyTorch 模型权重和数据文件（.pth, .pt）的内部层次结构、Tensor 形状和数据类型。

## ✨ 功能特性 (Features)

树状结构展示: 将复杂的 Python 字典和列表结构以可折叠的树状视图展示。

Tensor 元数据: 对于 PyTorch Tensor 对象，仅显示其关键元数据（形状 Shape 和数据类型 Dtype），避免加载大量数值导致的卡顿。

自定义编辑器集成: 双击 .pth 或 .pt 文件即可直接在自定义视图中打开。

主题自适应: 界面完美适配 VS Code 的深色和浅色主题。

## 🚀 使用方法 (Usage)

安装扩展后，有两种方法可以打开文件：

双击打开: 在资源管理器中，直接双击任何 .pth 或 .pt 文件。

右键菜单: 右键点击 .pth 或 .pt 文件，选择 "View PTH Structure" 命令。

## ⚠️ 前置要求 (Requirements)

由于 PyTorch 文件是 Python 特有的序列化格式，本扩展依赖于你的本地环境：

Python 环境: 你的系统环境变量中必须可以执行 python 命令。

PyTorch 库: 你的 Python 环境中必须安装了 torch 库 (pip install torch)。

如果缺少这些依赖，插件将无法调用 Python 脚本来解析文件，并会在视图中显示错误信息。

## 🔨 开发与贡献 (Development & Contribution)

如果你想参与贡献或修改此插件，请访问我们的 GitHub 仓库