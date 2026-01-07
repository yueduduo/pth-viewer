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

## ✨ Features

* **Tree Structure Display**
    
    Visualizes complex Python dictionaries, lists, and model hierarchies in a collapsible tree view.

* **Tensor Metadata & Value Inspection**
    
    Displays key Tensor metadata (`Shape` and `Dtype`) at a glance. Supports inspecting detailed values, including `min`, `max`, `mean`, and `std` statistics via the "🔍" button.

* **Seamless Editor Integration**
    
    Open model files directly in a custom VS Code view without writing loading scripts. Supported file types include:

<div align="center">

| Framework | Extensions |
| :--- | :--- |
| **PyTorch** | `.pt`, `.pth` |
| **SafeTensors** | `.safetensors` |
| **JAX / Orbax** | `.ocdbt`|

</div>

## 🚀 Usage

### 1. Opening Files
There are two ways to view a target file:

* **Click to Open**: Simply click on the target file in the VS Code Explorer.
* **Context Menu**: Right-click the target file and select the **Open with PyTorch Structure Viewer** command.

### 2. Environment Setup
The extension relies on your local Python environment. 

Please click the extension icon <img src="assets/status_icon.png" height="14" style="vertical-align: middle;" /> in the VS Code status bar (bottom right) to select a Python interpreter that includes the necessary libraries (e.g., torch, safetensors).

## ⚠️ Requirements

This extension depends on your local Python environment. Please ensure the following libraries are installed in your selected environment:

1.  **Python**: A valid python executable in your system path.
2.  **Libraries**:
    * **PyTorch**: `pip install torch`
    * **SafeTensors**: `pip install safetensors`
    * **JAX & Orbax**: `pip install jax orbax-checkpoint`

    *> Note: CPU versions of these libraries are sufficient.*

If dependencies are missing, the extension will fail to parse files and will display an error message in the webview.

## 🔨 Development & Contribution

If you would like to contribute, report bugs, or modify this extension, please visit the [GitHub Repository](https://github.com/yueduduo/pth-viewer).

Stars and PRs are welcome!