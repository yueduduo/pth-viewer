<div align="center">
  <img src="assets/icon_pth_viewer.png" alt="Logo" width="128" height="128" />
</div>

<h1 align="center">PyTorch Structure Viewer</h1>

<p align="center">
  快速、清晰地查看 PyTorch / SafeTensor / Jax 模型权重和数据文件的内部层次结构、Tensor 形状和数据类型。
</p>
<p align="center">
  Fast and clear visualization of internal hierarchical structures, tensor shapes, and data types for PyTorch, SafeTensor, and Jax model files.
</p>

<p align="center">
  <a href="./README.md">
    <img alt="README 中文" src="https://img.shields.io/badge/README-中文-red.svg?style=flat-square" />
  </a>
  <a href="./README_en.md" style="margin-left: 10px;">
    <img alt="README English" src="https://img.shields.io/badge/README-English-blue.svg?style=flat-square" />
  </a>
  <a href="https://github.com/yueduduo/pth-viewer" style="margin-left: 10px;">
    <img alt="GitHub Repo" src="https://img.shields.io/badge/GitHub-Repo-black?logo=github&style=flat-square" />
  </a>
</p>

---

## ✨ 功能特性

* **树状结构展示**
    
    将复杂的 Python 字典、列表以及模型层级结构以可折叠的树状视图清晰展示，支持一键展开/折叠。

* **Tensor 元数据与数值查看**
    
    直观显示 Tensor 的关键元数据（形状 `Shape` 和数据类型 `Dtype`）。支持点击 "🔍" 按钮查看详细数值，包括 `min`、`max`、`mean`、`std` 等统计信息及多维数组预览。

* **编辑器无缝集成**
    
    无需编写加载脚本，点击目标文件即可直接在 VS Code 自定义视图中打开。目前支持的文件类型包括：

<div align="center">

| 依赖库 (Framework) | 支持的文件扩展名 |
| :--- | :--- |
| **PyTorch** | `.pt`, `.pth` |
| **SafeTensors** | `.safetensors` |
| **JAX / Orbax** | `.ocdbt` |

</div>

## 🚀 使用方法

### 1. 打开文件
查看目标文件的方法有两种：

* **点击打开**: 在 VS Code 资源管理器中，直接单击目标文件即可预览。
* **右键菜单**: 右键点击目标文件，选择 **Open with PyTorch Structure Viewer** 命令。

### 2. 环境配置
插件依赖于你本地的 Python 环境。

请首先在 VS Code 右下角的状态栏中，点击本插件图标 <img src="assets/status_icon.svg" height="16" style="vertical-align: middle;" /> ，选择包含相关依赖库（如 torch, safetensors 等）的 Python 解释器。

## ⚠️ 环境要求

本扩展依赖于你的本地环境，请确保你选择的 Python 环境中已安装以下库（根据你需要查看的文件类型而定）：

1.  **Python 环境**: 系统中必须有可执行的 python 命令。
2.  **依赖库**:
    * **PyTorch**: `pip install torch`
    * **SafeTensors**: `pip install safetensors`
    * **JAX & Orbax**: `pip install jax orbax-checkpoint`

    *> 注意：以上库安装 CPU 版本即可，无需 GPU 支持。*

如果缺少这些依赖，插件将无法调用 Python 脚本解析文件，并在视图中显示错误信息。

## 🔨 开发与贡献

如果你想参与贡献、提交 Bug 或修改此插件，请访问本插件的 [GitHub 仓库](https://github.com/yueduduo/pth-viewer)。

欢迎 Star 和 PR！