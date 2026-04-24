import * as vscode from 'vscode';

/**
 * 插件所有中英文对照表
 */
const messages = {
    // --- 顶部标题 ---

    // --- 加载状态 (Loading) ---
    loading_parsing: {
        zh: "正在解析模型结构...",
        en: "Parsing model structure..."
    },
    loading_single_mode: {
        zh: "(单文件模式)",
        en: "(Single File Mode)"
    },
    loading_auto_mode: {
        zh: "(自动检测索引)",
        en: "(Auto Index Detection)"
    },
    btn_reload: {
        zh: "刷新",
        en: "Reload"
    },
    btn_collapse_all: {
        zh: "折叠",
        en: "Collapse"
    },
    btn_expand_all: {
        zh: "展开",
        en: "Expand"
    },
    loading_env_check: {
        zh: "请确保你选择了正确的 Python 环境 (需包含 torch|safetensors|Jax&orbax 库)。",
        en: "Ensure you've selected the correct Python environment (requires torch|safetensors|Jax&orbax)."
    },
    loading_cache_tip: {
        zh: "大型文件首次加载需要较长时间，后续将使用缓存秒开。",
        en: "Large files take time for initial loading; subsequent opens will use cache for instant access."
    },
    loading_data: {
        zh: "正在读取数据...",
        en: "Loading data..."
    },
    loading_file_size: {
        zh: "文件大小",
        en: "File Size"
    },

    loading_failed_overtime: {
        zh: "加载失败 (超时)",
        en: "Loading Failed (Timeout)"
    },

    loading_failed_retry: {
        zh: "请检查 Python 服务状态或重试。",
        en: "Check Python server status or retry."
    },

    loading_server_timeout: {
        zh: "服务器响应超时。",
        en: "Server response timeout."
    },

    


    // --- 状态栏与控制面板 (Status Bar / Control Panel) ---
    view_global_title: {
        zh: "全局视图",
        en: "Global View"
    },
    view_global_loaded: {
        zh: "已加载索引",
        en: "Index Loaded"
    },
    view_single_title: {
        zh: "单文件视图",
        en: "Single File View"
    },
    view_single_only: {
        zh: "仅显示当前文件内容",
        en: "Showing current file content only"
    },
    view_single_no_index: {
        zh: "",//"单文件视图 (未检测到索引)",
        en: "",//"Single File View (No Index Detected)"
    },
    btn_switch_to_single: {
        zh: "切换为只看当前文件",
        en: "Switch to Single File View"
    },
    btn_switch_to_global: {
        zh: "尝试检测全局索引",
        en: "Try Detecting Global Index"
    },

    // --- 数据展示相关 (Data Display) ---
    type_list: {
        zh: "列表 []",
        en: "List []"
    },
    type_dict: {
        zh: "字典 {}",
        en: "Dict {}"
    },
    tag_ref: {
        zh: "(索引引用)",
        en: "(Index Ref)"
    },
    btn_inspect_title: {
        zh: "查看/折叠",
        en: "Inspect/Toggle"
    },
    find_placeholder: {
        zh: "搜索当前页面...",
        en: "Search in this page..."
    },
    copy_key_success: {
        zh: "已复制",
        en: "Copied"
    },
    copy_key_failed: {
        zh: "复制失败",
        en: "Copy Failed"
    },

    // --- VS Code 底部状态栏 (Extension Status Bar) ---
    status_python_tooltip_front: {
        zh: "PyTorch Structure Viewer 正在使用的Python解释器。",
        en: "Python interpreter used by PyTorch Structure Viewer."
    },
    status_python_tooltip_back: {
        zh: "点击切换。",
        en: "Click to switch."
    },
    status_python_error: {
        zh: "Python 环境错误",
        en: "Python Env Error"
    },

    // --- VS Code 右键菜单命令 (右键菜单打开功能) ---
    file_right_click_tip: {
        zh: "请在资源管理器中右键点击 .pth|.pt|.safetensors|.ocdbt 文件使用此功能。",
        en: "Please right-click on .pth|.pt|.safetensors|.ocdbt files in the explorer to use this feature."
    },
    python_extension_missing: {
        zh: "未检测到 Python 扩展(ms-python.python)。请先安装后再选择解释器。",
        en: "Python extension (ms-python.python) is not installed. Install it before selecting an interpreter."
    },
    unsafe_load_confirm_title: {
        zh: "检测到该文件安全加载失败。是否仅对此文件启用不安全加载（weights_only=False）并重试？",
        en: "Safe loading failed for this file. Enable unsafe load (weights_only=False) for this file and retry?"
    },
    unsafe_load_confirm_detail: {
        zh: "仅对可信文件启用。该选择会记住到缓存，后续打开此文件会继续使用不安全模式。",
        en: "Enable only for trusted files. This choice is remembered in cache for future opens."
    },
    unsafe_load_enable_once: {
        zh: "启用并重试",
        en: "Enable and Retry"
    },
    open_unsafe_load_setting: {
        zh: "打开默认设置",
        en: "Open Default Setting"
    },
    unsafe_load_enabled_notice: {
        zh: "已记住此文件为不安全加载模式。你也可以在设置中修改 pthViewer.allowUnsafeLoad。",
        en: "Unsafe mode is remembered for this file. You can also change pthViewer.allowUnsafeLoad in settings."
    },
    unsafe_load_inline_hint: {
        zh: "你可以在下方直接操作，或在设置中修改默认策略。",
        en: "You can take action below, or change the default strategy in settings."
    },
    open_full_json_folder: {
        zh: "JSON",
        en: "JSON"
    },
    btn_find: {
        zh: "查找",
        en: "Find"
    },
    full_json_preview_load: {
        zh: "加载完整结构",
        en: "Load Full Structure"
    },
    full_json_preview_loading: {
        zh: "正在从 SQLite 索引加载截断内容...",
        en: "Loading truncated content from SQLite index..."
    },
    indexed_node_loading: {
        zh: "正在加载内容...",
        en: "Loading content..."
    },
    full_json_preview_failed: {
        zh: "完整结构加载失败",
        en: "Failed to load full structure"
    },
    full_json_preview_too_large: {
        zh: "当前软件设置限制了可打开的大文件大小，无法在内嵌窗口打开。请手动查看导出的JSON文件。",
        en: "Current editor settings limit large file opening. Cannot open inline preview. Please inspect the exported JSON file manually."
    },
    full_json_not_generated: {
        zh: "尚未生成完整结构JSON文件。",
        en: "Full structure JSON is not generated yet."
    },
    full_json_hint_generated: {
        zh: "该节点已触发截断。可展开查看完整结构预览。",
        en: "This node is truncated. Expand to preview the full structure."
    },
    dynamic_reloading_memory_notice: {
        zh: "内存中未命中该文件，正在从磁盘重新加载到内存...",
        en: "File not found in memory cache. Reloading from disk into memory..."
    },

    // --- 错误提示 (Errors) ---
    err_python_run: {
        zh: "Python 运行错误:",
        en: "Python Execution Error:"
    },
    err_python_env: {
        zh: "请检查 VS Code 右下角选择的 Python 环境是否已安装 PyTorch|safetensors|Jax&orbax。",
        en: "Please check if PyTorch|safetensors|Jax&orbax is installed in the selected Python environment."
    },
    err_python_path: {
        zh: "当前尝试使用的 Python 路径:",
        en: "Current Python Path:"
    },
    err_stderr_output: {
        zh: "标准错误输出 (Stderr):",
        en: "Stderr Output:"
    },
    err_data_read: {
        zh: "数据读取错误:",
        en: "Data Read Error:"
    },
    err_json_parse: {
        zh: "JSON 解析失败 (Python 输出非标准JSON):",
        en: "JSON Parse Failed (Non-standard JSON):"
    },
    err_invalid_key: {
        zh: "无效的关键路径格式",
        en: "Invalid Key Format"
    },
    err_parse_error: {
        zh: "解析错误",
        en: "Parse Error"
    }
};

/**
 * 核心翻译函数
 * 根据 VS Code 的界面语言环境返回对应文字
 */
export function t(key: keyof typeof messages): string {
    const lang = vscode.env.language.toLowerCase();
    
    // 如果是中文环境（包含简体、繁体、香港、新加坡等）
    if (lang.startsWith('zh')) {
        return messages[key].zh;
    } 
    // 其他情况默认显示英文
    else {
        return messages[key].en;
    }
}