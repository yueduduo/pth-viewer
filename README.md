# PyTorch Structure Viewer

快速、清晰地查看 PyTorch/SafeTensor/Jax 模型权重和数据文件（.pth, .pt, .safetensor, .ocdbt）的内部层次结构、Tensor 形状和数据类型。

## ✨ 功能特性 (Features)

* 树状结构展示
 
    将复杂的 Python 字典和列表结构以可折叠的树状视图展示。

* Tensor 元数据与数值查看
    
    显示Tensor关键元数据（形状 Shape 和数据类型 Dtype）并支持查看详细数值，包括min、max、mean、std统计信息。

* 编辑器集成
  
    点击目标文件即可直接在自定义视图中打开。

    目前支持的目标文件类型包括: 

    | 依赖库|文件扩展名|
    |-|-|
    |torch|.pt/.pth|
    |safetensor|.safetensor|
    |Jax&orbax|.ocdbt|


## 🚀 使用方法 (Usage)

1. 首先需要在VS Code右下角选择插件使用的Python环境。

2. 查看目标文件的方法有两种：
   * 点击打开: 在资源管理器中，直接点击目标文件。

   * 右键菜单: 右键点击目标文件，选择 "View PTH Structure" 命令。

## ⚠️ 前置要求 (Requirements)

本扩展依赖于你的本地环境, 包括:

Python 环境: 你的系统环境变量中必须可以执行 python 命令。

    PyTorch 库: 你的 Python 环境中必须安装了 torch 库 (pip install torch)。

    safetensor、Jax&orbax库

    以上库使用cpu版本即可


如果缺少这些依赖，插件将无法调用 Python 脚本来解析文件，并会在视图中显示错误信息。

## 🔨 开发与贡献 (Development & Contribution)

如果你想参与贡献或修改此插件，请访问本插件的 [GitHub](https://github.com/yueduduo/pth-viewer) 仓库