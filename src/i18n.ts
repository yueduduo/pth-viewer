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
        zh: "重新加载",
        en: "Reload"
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
        zh: "全局视图:",
        en: "Global View:"
    },
    view_global_loaded: {
        zh: "已加载索引",
        en: "Index Loaded"
    },
    view_single_title: {
        zh: "单文件视图:",
        en: "Single File View:"
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