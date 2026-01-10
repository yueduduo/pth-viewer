# Change Log

All notable changes to the "pth-viewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.1] - 2025-11-27

Added

* 初始发布。

* 支持 .pth 和 .pt 文件的树状结构可视化。

* Tensor 对象的形状和数据类型摘要显示。

* 自定义编辑器和右键菜单集成。

* 界面颜色适配 VS Code 主题。

## [0.0.2] - 2025-11-27

* 增加图标

* 实现了Python环境的自动检测和选择

## [0.0.3] - 2025-12-01

* 增加支持safetensor和index.json的自动检测，实现独立视图和全局视图

* 实现查看内部tensors数据
  
## [0.0.4] - 2025-12-03

* 增加对Jax生态的.ocdbt权重的支持

* 初步实现缓存机制

## [0.0.5] - 2026-01-08

* 完善对统计信息的缓存与折叠
  
* 增加licese文件，增加多语言支持(中文和英文)，增加底部状态栏图标

## [0.0.6] - 2026-01-08

* 将架构改为 前端 + 后端 模式，避免多次启动Python解释器，提高响应速度

* 增加显示权重文件大小的功能

## [0.0.7] - 2026-01-08

* 对长dict和list进行截断，避免产生过长的文本导致vscode无法正常显示

## [0.0.8] - 2026-01-10

* ui: 优化单文件模式的显示
  
* ui: 优化对空dict和list的显示

* client: 优化任务队列逻辑，避免反复load

* server: 修复linux下的超时无法自动退出问题
  