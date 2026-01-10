import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';           // <--- for 缓存
import * as crypto from 'crypto';   // <--- for 缓存
import { t } from './i18n';         // <--- for 多语言
import { PythonServerManager } from './PythonServerManager'; // 引入 PythonServerManager
/**
 * 定义一个简单的文档类，用于持有文件的 Uri
 */
class PthDocument implements vscode.CustomDocument {
    uri: vscode.Uri;

    constructor(uri: vscode.Uri) {
        this.uri = uri;
    }

    dispose(): void {
        // 如果有资源需要释放，在这里处理。
        // === 关键：文件关闭时，通知后端释放内存 ===
        console.log(`[Document] Disposing ${this.uri.fsPath}`);
        PythonServerManager.getInstance().sendRequest('/release', {
            file_path: this.uri.fsPath
        }).then(response => {
            console.log(response.error)
            if (response?.status === 'released') {
                console.log(`[Document] Successfully released ${this.uri.fsPath}`);
            } else {
                console.error(`[Document] Failed to release ${this.uri.fsPath}`);
            }
        }).catch(err => console.error("Failed to release model:", err));

    }
}

/**
 * 核心编辑器提供程序
 */
export class PthEditorProvider implements vscode.CustomReadonlyEditorProvider<PthDocument> {

    public static readonly viewType = 'pth-viewer.pthEditor';
    
    private filePath: string = '';
    private forceLocal: boolean = false;
    // 缓存数据
    private cacheJson : Record<string, any> = {}; // 结构 { "is_global": False,  "data": structure}
    private cacheFilePath: string = '';
    private cacheHash: string | null = '';

    constructor(private readonly context: vscode.ExtensionContext) {
        // 初始化 Manager
        PythonServerManager.getInstance().setContext(context);
     }

    // ----------------------------------------------------
    //  方法 1 (必须): 打开文档
    //  这里我们不需要解析内容，只需要返回一个持有 Uri 的文档对象
    // ----------------------------------------------------
    openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): PthDocument {
        return new PthDocument(uri);
    }

    // ----------------------------------------------------
    //  方法 2 (必须): 解析编辑器 (渲染 Webview)
    // ----------------------------------------------------
    public async resolveCustomEditor(
        document: PthDocument, // 注意：这里类型变了，不是 TextDocument
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        // 保存文件路径到成员变量
        this.filePath = document.uri.fsPath;
        this.forceLocal = false; // 初始默认全局模式

        // Webview 
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        // 监听 Webview 发来的消息
        webviewPanel.webview.onDidReceiveMessage(async message => {
            // 监听 模式 切换
            if (message.command === 'switchMode') {
                this.forceLocal = message.value; // update: true = 强制局部, false = 自动全局
                this.loadPthContent(document, webviewPanel);
            }
            // 监听 查看数据请求
            if (message.command === 'inspect') {
                const key = message.key;
                const elementId = message.id;
                this.inspectTensorData(document.uri.fsPath, key, elementId, webviewPanel);
            }

            // 监听 reload 
            if (message.command === 'reload') {
                console.log("[Editor] Reloading...");
                
                // 1. 尝试删除物理缓存文件
                if (fs.existsSync(this.cacheFilePath)) {
                    try {
                        fs.unlinkSync(this.cacheFilePath); // 删除文件
                        console.log(`[Cache] Deleted stale cache: ${this.cacheFilePath}`);
                    } catch (e) {
                        console.error("[Cache] Failed to delete cache:", e);
                    }
                }

                // 2. 通知 Python 后端释放内存 (清除 LOADED_MODELS)
                try {
                    await PythonServerManager.getInstance().sendRequest('/release', {
                        file_path: this.filePath
                    });
                } catch (e) { console.warn("Failed to release backend memory:", e); }

                // 3. 清空前端内存对象
                this.cacheJson = {}; 
                
                // 4. 重新加载 (这会触发全新的 /load 请求并重新生成缓存)
                this.loadPthContent(document, webviewPanel);
            }
        });

        // 初始加载 (默认尝试全局)
        this.loadPthContent(document, webviewPanel);
    }

    // 抽离加载逻辑，方便刷新
    private async loadPthContent(document: PthDocument, panel: vscode.WebviewPanel) {
        // 计算文件大小
        let fileSizeStr = "0 B";
        try {
            const stats = fs.statSync(this.filePath);
            fileSizeStr = formatFileSize(stats.size);
        } catch (e) { console.error(e); }

        // 1. 显示加载动画 显示文件大小
        panel.webview.html = getWebviewContent(`
            <div class="loading">
                <div class="spinner"></div>
                <p>${t('loading_file_size')}: ${fileSizeStr}</p>
                <p>${t('loading_parsing')}... ${this.forceLocal ? t('loading_single_mode') : t('loading_auto_mode')}</p>
                ${t('loading_env_check')}
                <p style="font-size:0.8em; color:var(--vscode-descriptionForeground);">${t('loading_cache_tip')}</p>
            </div>
        `, panel.webview);
        
        // 2. === 尝试读取缓存 ===
        this.cacheHash = this.computeCacheKey(this.filePath, this.forceLocal);
        this.cacheFilePath = this.getCachePath(this.cacheHash!);
        if (fs.existsSync(this.cacheFilePath)) {
            try {
                console.log(`[Cache] Hit! Loading from ${this.cacheFilePath}`);
                const cacheRaw = fs.readFileSync(this.cacheFilePath, 'utf-8');                    
                this.cacheJson = JSON.parse(cacheRaw).data;

                let totalSizeBytes = 0;
                // 情况 1: Python 后端返回了计算好的总大小 (Global 模式)
                if (this.cacheJson && this.cacheJson.total_size) {
                    totalSizeBytes = this.cacheJson.total_size;
                    console.log(`[Size] Using size calculated by Python: ${totalSizeBytes}`);
                    fileSizeStr = formatFileSize(totalSizeBytes);
                } 
                // 情况 2: 单文件模式 (或者 Python 端没有返回 total_size)
                else {}
                // 渲染缓存的数据
                const htmlTree = generatePageHtml(this.cacheJson, this.forceLocal, fileSizeStr);
                
                // 可以在界面上加一个小标记提示是缓存内容 (可选)
                // 这里的 render 调用保持不变
                panel.webview.html = getWebviewContent(htmlTree, panel.webview);
                return; // 命中缓存，直接结束，不跑 Python
            } catch (e) {
                console.warn("[Cache] Read failed, falling back to python:", e);
                // 如果缓存读取失败（比如损坏），继续往下走运行 Python
            }
        }
        

        // 3. === 缓存未命中，运行 Python 解析 ===
        try {
            console.log("Requesting load from Python Server...");
            // 替代原来的 cp.exec
            const result = await PythonServerManager.getInstance().sendRequest('/load', {
                file_path: this.filePath,
                force_local: this.forceLocal
            });

            if (result.error) {
                // 这是 Python 服务器内部捕获的错误  Python 已经正常启动 但是 出错
                panel.webview.html = getWebviewContent(
                    `<h3>${t('err_parse_error')}</h3><pre>${result.error}</pre>`, 
                    panel.webview
                );
            } else {
                // 4. 解析 Python 返回的 JSON
                this.cacheJson = result; // 结果格式应该和原来一致

                if (this.cacheJson.error) {
                    panel.webview.html = getWebviewContent(
                        `<h3>${t('err_data_read')}:</h3><pre>${this.cacheJson.error}</pre>`, 
                        panel.webview
                    );
                } else {
                    // 5. === 解析成功，写入缓存 ===
                    try {
                        this.saveToCache(this.cacheJson)
                        console.log(`[Cache] Saved to: ${this.cacheFilePath}`);
                    } catch (e) {
                        console.error("[Cache] Write failed:", e);
                    }

                    let totalSizeBytes = 0;
                    // 情况 1: Python 后端返回了计算好的总大小 (Global 模式)
                    if (this.cacheJson && this.cacheJson.total_size) {
                        totalSizeBytes = this.cacheJson.total_size;
                        console.log(`[Size] Using size calculated by Python: ${totalSizeBytes}`);
                        fileSizeStr = formatFileSize(totalSizeBytes);
                    } 
                    // 情况 2: 单文件模式 (或者 Python 端没有返回 total_size)
                    else {}
                    // 6. 生成 HTML 树状图并显示
                    const htmlTree = generatePageHtml(this.cacheJson, this.forceLocal, fileSizeStr);
                    panel.webview.html = getWebviewContent(htmlTree, panel.webview);
                }
            }
        } catch (e: any) {
            // 捕获Python启动失败的异常
            console.error("Load failed:", e);
            const errorMsg = e.message || "Unknown error";

            // 区分错误类型
            // 情况 A: 超时错误 -> 显示在 Tooltip (Toast)
            if (errorMsg.includes("Timeout")) {
                vscode.window.showErrorMessage(`${t('loading_failed_overtime')}: ${errorMsg}. ${t('loading_failed_retry')}`);

                // 页面上可以显示一个重试按钮，而不是全屏报错
                panel.webview.html = getWebviewContent(`
                    <div style="padding: 20px; text-align: center;">
                        <h3>⏱️ Request Timeout</h3>
                        <p>Python ${t('loading_server_timeout')}</p>
                        <button onclick="location.reload()">Retry</button>
                    </div>
                `, panel.webview);
            }
            
            // 情况 B: 启动错误/环境错误 (含 9009, ModuleNotFound, UnicodeError 等) -> 显示在页面 (Webview)
            const manager = PythonServerManager.getInstance();
            // 获取当前使用的解释器路径，用于展示给用户
            const currentPyPath = manager.getInterpreterPath(); 

            // 渲染详细的错误页面 (恢复之前的经典报错样式)
            panel.webview.html = getWebviewContent(
                `
                <div style="padding: 10px; border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 5px;">
                    <h3 style="margin-top:0;">${t('err_python_run')}</h3>
                    
                    <p><strong>${t('err_python_env')}</strong></p>
                    
                    <p>${t('err_python_path')} <code style="background:var(--vscode-textBlockQuote-background); padding:2px 4px;">${currentPyPath}</code></p>
                    
                    <hr style="border: 0; border-top: 1px solid var(--vscode-textBlockQuote-border);">
                    
                    <h4>${t('err_stderr_output')}</h4>
                    <pre style="color:var(--vscode-errorForeground); overflow:auto; max-height:300px;">${errorMsg}</pre>
                </div>
                `, 
                panel.webview
            );
        }
       

    }

    

    // 新增：专门用于获取 Tensor 数据的函数
    private async inspectTensorData(filePath: string, key: string, elementId: string, panel: vscode.WebviewPanel) {
        // 1. 解析 Key 路径
        let keys: string[] = [];
        try {
            keys = JSON.parse(key);
        } catch (e) {
            panel.webview.postMessage({ command: 'showData', id: elementId, error: "Invalid Key format" });
            return;
        }

        // 2. === 尝试读取缓存 ===
        let targetNode: any = null;
        try {
            // 在缓存树中查找目标节点
            targetNode = this.findNodeByPath(this.cacheJson.data, keys);
                
            // ✅ 命中缓存：如果 __pth_overview_pth__ 字段里已经有 stats 了
            if (targetNode && targetNode.__pth_overview_pth__ && targetNode.__pth_overview_pth__.stats) {
                console.log(`[Cache] Tensor Data Hit: ${keys.join('.')}`);
                panel.webview.postMessage({ command: 'showData', id: elementId, data: targetNode.__pth_overview_pth__ });
                return; 
            }
        } catch (e) {
            console.warn("[Cache] Failed to read/parse cache for tensor inspection:", e);
        }

        // 3. === 缓存未命中，请求 Server ===
        try {
            const result = await PythonServerManager.getInstance().sendRequest('/inspect', {
                file_path: filePath,
                key: key // 直接传 JSON 字符串，Server 端会解析
            });
            if (result.error) {
                 panel.webview.postMessage({ command: 'showData', id: elementId, error: result.error });
            } else {
                panel.webview.postMessage({ command: 'showData', id: elementId, data: result });
                 // 显示从python获取了数据 console.log
                console.log(`[Python] Get overview data for ${keys.join('.')}`);
                
                // 4. === 异步写入缓存 (Update __pth_overview_pth__) ===
                // 只有当数据正常（不是 error），且我们之前成功定位到了缓存文件和节点时，才写入
                if (!result.error && targetNode && this.cacheFilePath) {
                    try {
                        // 初始化 __pth_overview_pth__ (如果 Python 没有返回 __pth_overview_pth__ 字段)
                        if (!targetNode.__pth_overview_pth__) {
                            targetNode.__pth_overview_pth__ = {};
                        }
                        // 将 Python 返回的 {type, stats, preview} 全部存入 __pth_overview_pth__
                        // 这样下次访问 targetNode.__pth_overview_pth__.stats 就有值了
                        const overview_data = {
                            type: "__pth_overview_type_pth__",
                            stats: result.stats,
                            preview: result.preview,
                        };
                        Object.assign(targetNode.__pth_overview_pth__, overview_data);
                        
                        // 写入磁盘
                        try {
                            this.saveToCache(this.cacheJson);
                            console.log(`[Cache] Updated to: ${this.cacheFilePath}`);
                        } catch (e) {
                            console.error("[Cache] Update failed:", e);
                        }
                    } catch (updateErr) {
                        console.error("[Cache] Error updating JSON structure:", updateErr);
                    }
                }
            } 
        } catch (e: any) {
            panel.webview.postMessage({ command: 'showData', id: elementId, error: "Server Error: " + e.message });
        }
    }

    // ----------------------------------------------------------------------
    // 新增：缓存相关的辅助方法
    // ----------------------------------------------------------------------

    /**
     * 计算缓存文件的唯一哈希 (Cache Key)
     * 规则: MD5(文件路径 + 修改时间 + 文件大小 + 是否强制单文件模式)
     * 这样只要文件变了，或者查看模式变了，缓存自动失效
     */
    private computeCacheKey(filePath: string, forceLocal: boolean): string | null {
        try {
            const stats = fs.statSync(filePath);
            const keyContent = `${filePath}-${stats.mtimeMs}-${stats.size}-${forceLocal}`;
            return crypto.createHash('md5').update(keyContent).digest('hex');
        } catch (e) {
            return null; // 文件可能不存在
        }
    }

    /**
     * 获取缓存文件的完整路径
     */
    private getCachePath(hash: string): string {
        const storagePath = this.context.globalStorageUri.fsPath;
        const cacheDir = path.join(storagePath, 'cache');
        // 确保存储目录存在
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        return path.join(cacheDir, `${hash}.json`);
    }

    /**
     * 将解析结果写入缓存
     */
    private saveToCache(resultData: any) {
        const stats = fs.statSync(this.filePath);
        
        // 构建缓存对象 (为未来扩展 Metadata 做准备)
        const cacheContent = {
            version: "1.0",
            source_hash: this.cacheHash,
            timestamp: Date.now(),
            meta: {
                file_path: this.filePath,
                file_size: stats.size,
                // TODO: 这里未来可以扩展 param_count, arch 等信息
            },
            data: resultData // Python 返回的原始结构
        };

        fs.writeFileSync(this.cacheFilePath, JSON.stringify(cacheContent), 'utf-8');
    }

    // ----------------------------------------------------------------------
    // 新增辅助方法：根据路径数组，在 JSON 树中找到对应的节点对象
    // ----------------------------------------------------------------------
    private findNodeByPath(root: any, keys: string[]): any {
        let current = root;
        try {
            for (const k of keys) {
                // 如果当前节点是数组
                if (Array.isArray(current)) {
                    const index = parseInt(k);
                    if (isNaN(index) || index >= current.length) return null;
                    current = current[index];
                } 
                // 如果当前节点是对象
                else if (typeof current === 'object' && current !== null) {
                    current = current[k];
                } else {
                    return null; // 路径中断
                }
            }
            return current;
        } catch (e) {
            return null;
        }
    }
}




// ----------------------------------------------------
//  辅助函数 (保持不变)
// ----------------------------------------------------

function generatePageHtml(result: any, isForceLocal: boolean, fileSizeStr: string): string {
    const isGlobal = result.is_global;
    const data = result.data;
    const indexFile = result.index_file || "";

    // 定义图标和标题文本
    let icon = isGlobal ? '🌐' : '📄';
    let title = isGlobal ? t('view_global_title') : t('view_single_title');
    let desc = '';
    let statusClass = isGlobal ? 'global-mode' : 'local-mode';
    let switchBtnText = isGlobal ? t('btn_switch_to_single') : t('btn_switch_to_global');
    let switchCmdValue = isGlobal ? 'true' : 'false'; // true=forceLocal

    if (isGlobal) {
        desc = `${t('view_global_loaded')} <code>${indexFile}</code>`;
    } else if (isForceLocal) {
        desc = t('view_single_only');
    } else {
        desc = t('view_single_no_index');
    }

    // === 核心修改：使用 Flex 布局的控制栏 ===
    // 结构：
    // <div class="status-bar ...">
    //    <div class="status-left"> 图标 | 标题 | 描述 | [文件大小Badge] </div>
    //    <div class="status-right"> [刷新按钮] [切换模式按钮] </div>
    // </div>

    let controlBar = `
        <div class="status-bar ${statusClass}">
            <div class="status-left">
                <span class="icon">${icon}</span> 
                <span class="status-title">${title}</span>
                <span class="status-desc">${desc}</span>
                <span class="size-badge">${fileSizeStr}</span>
            </div>
            <div class="status-right">
                <button class="icon-btn" onclick="vscode.postMessage({command: 'reload'})" title="${t('btn_reload')}">
                    <span class="codicon-symbol">↻</span> ${t('btn_reload')}
                </button>
                <button style="display:${isGlobal || isForceLocal ? 'inline-block' : 'none'}" onclick="vscode.postMessage({command: 'switchMode', value: ${switchCmdValue}})">
                    ${switchBtnText}
                </button>
            </div>
        </div>
    `;

    const treeHtml = generateJsonHtml(data);
    return controlBar + treeHtml;
}


export function getWebviewContent(bodyContent: string, webview?: vscode.Webview): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            :root {
                    --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                }
            /* 1. 全局样式：使用 VS Code 字体和基础颜色 */
            body { 
                font-family: var(--vscode-editor-font-family); /* 使用编辑器字体 */
                font-size: var(--vscode-editor-font-size);
                background-color: var(--vscode-editor-background); 
                color: var(--vscode-foreground); /* 前景文字颜色 */
                padding: 15px; 
            }

            /* 状态栏样式 */
            /* 1. 改造 status-bar 为 Flex 容器 */
            .status-bar {
                padding: 6px 10px; /*稍微减小padding更精致*/
                margin-bottom: 15px;
                border-radius: 4px;
                display: flex;
                align-items: center;
                justify-content: space-between; /* 左右推开 */
                font-size: 0.9em;
                border: 1px solid var(--vscode-widget-border);
                /* 保持原来的背景色逻辑 (.global-mode / .local-mode) */
            }

            /* 左侧区域：子元素紧凑排列 */
            .status-left {
                display: flex;
                align-items: center;
                gap: 8px;
                overflow: hidden; /* 防止文件名过长溢出 */
            }

            .status-title {
                font-weight: bold;
                white-space: nowrap;
            }

            .status-desc {
                opacity: 0.9;
                white-space: nowrap;
                text-overflow: ellipsis;
                overflow: hidden;
            }

            /* 右侧区域：按钮组 */
            .status-right {
                display: flex;
                gap: 8px;
                flex-shrink: 0; /* 防止按钮被压缩 */
            }

            /* 2. 文件大小 Badge 样式 (仿 VS Code Badge) */
            .size-badge {
                background-color: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                font-size: 0.85em;
                padding: 1px 6px;
                border-radius: 10px; /* 圆角 */
                font-family: var(--vscode-editor-font-family);
                min-width: 40px;
                text-align: center;
                border: 1px solid var(--vscode-contrastBorder, transparent); /* 高对比度模式支持 */
            }

            /* 3. 按钮样式优化 */
            button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 4px 10px;
                border-radius: 2px;
                cursor: pointer;
                font-family: inherit;
                display: flex;
                align-items: center;
                gap: 4px;
                transition: background 0.1s;
            }

            button:hover {
                background: var(--vscode-button-hoverBackground);
            }

            /* 特殊的图标按钮样式 (可选，让刷新按钮看起来稍微不同) */
            .icon-btn .codicon-symbol {
                font-weight: bold;
                font-size: 1.1em;
                line-height: 1;
            }

            /* 移动端适配 (如果窗口很窄) */
            @media (max-width: 600px) {
                .status-desc { display: none; } /* 窄屏隐藏描述文字 */
            }
            /* 2. 标题样式 */
            h2 {
                color: var(--vscode-editorWidget-foreground);
                border-bottom: 1px solid var(--vscode-editorWidget-border);
                padding-bottom: 5px;
                margin-top: 0;
            }

            /* 3. 列表/树状结构基础样式 */
            ul { 
                list-style-type: none; 
                padding-left: 20px; 
                margin: 0;
            }
            li { 
                margin: 0 0 5px 0;
                line-height: 1.4;
            }

            /* 4. 树状折叠/展开 (details/summary) 样式 */
            details {
                margin-top: 5px;
            }
            details > summary { 
                cursor: pointer; 
                font-weight: 500;
                /* 颜色使用 VS Code 控件的强调色 */
                color: var(--vscode-terminal-ansiBrightBlue);
                user-select: none;
                padding-left: 15px;
                position: relative;
            }
            
            /* 模拟 VS Code 的树形指示图标 */
            details > summary::before {
               
                position: absolute;
                left: 0;
                color: var(--vscode-editorGroupHeader-tabsBorder);
                transition: transform 0.1s;
            }
            details[open] > summary::before {
              
                transform: rotate(0deg);
            }

            /* 5. 数据类型高亮 */
            /* 字典 Key/列表 Index */
            .key-name { 
                color: var(--vscode-terminal-ansiYellow); 
                font-weight: bold;
            }
            /* Tensor 信息高亮 */
            .tensor-info { 
                color: var(--vscode-terminal-ansiBrightCyan); /* 使用亮青色作为信息色 */
                font-size: 0.9em; 
                font-family: Consolas, 'Courier New', monospace;
                padding: 1px 4px;
                background-color: var(--vscode-editorGroupHeader-tabsBackground);
                border-radius: 3px;
                white-space: nowrap;
            }
            
            /* 6. 错误信息 */
            h3 {
                color: var(--vscode-errorForeground);
            }
            pre {
                white-space: pre-wrap;
                word-break: break-all;
                background-color: var(--vscode-editorWidget-background);
                border: 1px solid var(--vscode-editorWidget-border);
                padding: 10px;
                border-radius: 4px;
            }

            /* 7. 截断项样式 */
            .truncated-item {
                color: var(--vscode-descriptionForeground);
                font-style: italic; /* 斜体可以进一步增加辨识度，暗示这是辅助信息 */
                font-size: 0.9em;
                padding: 2px 0;
                opacity: 0.8; /* 稍微降低透明度，使其不喧宾夺主 */
            }

            /* inspect 查看数据 新增样式 */
            .inspect-btn {
                cursor: pointer;
                border: 1px solid var(--vscode-button-border);
                border-radius: 3px;
                padding: 0 4px;
                margin-left: 5px;
                font-size: 0.8em;
            }
            .inspect-btn:hover {
                background-color: var(--vscode-button-secondaryHoverBackground);
            }
            .data-preview {
                margin-top: 5px;
                padding: 8px;
                background-color: var(--vscode-editor-inactiveSelectionBackground);
                border-left: 3px solid var(--vscode-charts-blue);
                font-family: 'Consolas', monospace;
                font-size: 0.85em;
                white-space: pre; /* 保持 PyTorch 的多维缩进格式 */
                overflow-x: auto;
            }
            .stats-row {
                margin-bottom: 5px;
                color: var(--vscode-descriptionForeground);
                border-bottom: 1px dashed var(--vscode-editorRuler-foreground);
                padding-bottom: 4px;
            }
            .stats-item { margin-right: 15px; }
        </style>
        <script>
            <!-- 实现点击按钮, 有vscode事件触发 -->
            const vscode = acquireVsCodeApi();

            // === 新增：辅助函数，用于解码并发送消息 ===
            // === 修改：智能切换函数 (Toggle) ===
            function toggleInspect(safePath, btnId) {
                const container = document.getElementById(btnId);
                if (!container) return;

                // 1. 如果当前是【显示】状态 -> 切换为【隐藏】
                if (container.style.display === 'block') {
                    container.style.display = 'none';
                    return;
                }

                // 2. 如果当前是【隐藏】状态
                // 检查里面是否有内容（是否已经加载过数据？）
                if (container.innerHTML.trim() !== "") {
                    // 有缓存数据 -> 直接显示 (秒开，无需请求 Python)
                    container.style.display = 'block';
                    return;
                }

                // 3. 如果是【空】的 -> 说明是第一次点击
                // 先显示一个 Loading 提示
                container.innerHTML = '<div style="padding:5px; color:var(--vscode-descriptionForeground); font-style:italic;">Loading data...</div>';
                container.style.display = 'block';

                // 发送请求给插件后台
                const jsonPath = decodeURIComponent(safePath);
                vscode.postMessage({
                    command: 'inspect',
                    key: jsonPath,
                    id: btnId
                });
            }

            // 监听插件发回来的数据
            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'showData') {
                    const container = document.getElementById(message.id);
                    if (!container) return;
                    
                    container.style.display = 'block';
                    
                    if (message.error) {
                        container.innerHTML = '<span style="color:red">Error: ' + message.error + '</span>';
                    } else if (message.data.error) {
                        container.innerHTML = '<span style="color:red">Error: ' + message.data.error + '</span>';
                    } else {
                        const stats = message.data.stats;
                        const preview = message.data.preview;
                        
                        // 渲染统计信息
                        const statsHtml = \`
                            <div class="stats-row">
                                <span class="stats-item">Min: <strong>\${stats.min}</strong></span>
                                <span class="stats-item">Max: <strong>\${stats.max}</strong></span>
                                <span class="stats-item">Mean: <strong>\${stats.mean}</strong></span>
                                <span class="stats-item">Std: <strong>\${stats.std}</strong></span>
                            </div>
                        \`;
                        
                        // 渲染多维数组内容
                        container.innerHTML = statsHtml + preview;
                    }
                }
            });
        </script>
    </head>
    <body>
        <h2>PyTorch Structure Viewer</h2>
        ${bodyContent}
    </body>
    </html>`;
}

// 1. 修改参数类型：keyPath 改为 string[]，默认是空数组
export function generateJsonHtml(data: any, keyPath: string[] = []): string {
    // 原来是: if (!data) return '';  <-- 这是错的，因为 0 会被当成 false
    if (data === null || data === undefined) return '';

    const isTensor = data._type === 'tensor' || data._type === 'tensor_ref';
    let tensorHtml = '';
    
    if (isTensor) {
        const dtype = data.dtype || '?';
        
        let shapeStr = '';
        if (data.shape) {
            if (data.shape.length === 0) {
                // 如果长度为0，说明是标量 (Scalar)
                shapeStr = '<span style="color:var(--vscode-textLink-foreground);">[Scalar]</span>';
            } else {
                // 否则显示维度
                shapeStr = `[ ${data.shape.join('×')} ]`;
            }
        }
        
        const loc = data.location ? `<span class="location-tag">${data.location}</span>` : '';
        
        let infoClass = "tensor-info";
        if (data._type === 'tensor_ref') infoClass += " ref";

        // === 核心修改：生成安全的路径 JSON ===
        // 1. 转成 JSON 字符串: ["policy", "net.0.weight"]
        const jsonPath = JSON.stringify(keyPath);
        // 2. 编码，防止 HTML 属性里的引号冲突: %5B%22policy%22...
        const safePath = encodeURIComponent(jsonPath);
        // 3. 生成唯一 ID (CSS ID 不能有特殊字符，这里简单的替换一下即可，或者用 safePath 做 ID 的一部分)
        const btnId = `btn-${safePath.replace(/[^a-zA-Z0-9]/g, '-')}`; 

        const detailStr = data._type === 'tensor' ? `${shapeStr} (${dtype})` : `${t('tag_ref')}`;
        
        // 注意：onclick 这里我们要传 safePath，后端拿到后再 decodeURIComponent
        // 但其实 postMessage 可以直接传对象，我们这里为了简单，传 safePath 字符串
        const inspectBtn = data._type === 'tensor' 
            ? `<span class="inspect-btn" title="${t('btn_inspect_title')}" onclick="toggleInspect('${safePath}', '${btnId}')">🔍</span>` 
            : '';

        tensorHtml = `<span class="${infoClass}">${detailStr}</span>${loc} ${inspectBtn} <div id="${btnId}" class="data-preview" style="display:none;"></div>`;
    }

    let childrenHtml = '';
    let hasChildren = false;

    if (Array.isArray(data)) {
        let listItems = '';
        data.forEach((item, index) => {
            // === 核心修改：路径追加 (Push) ===
            // 创建新数组，避免污染父级 path
            const currentPath = [...keyPath, index.toString()]; 
            const value = generateJsonHtml(item, currentPath)
            
            // 如果 item是string 并且 以__pth__truncated__ 开头以及结尾
            if (typeof item === 'string' && item.startsWith('__pth__truncated__') && item.endsWith('__pth__truncated__')) {
                listItems += `<li class="truncated-item"><span>[${index}]: </span>${value}</li>`;
            } else {
                listItems += `<li><span class="key-name">[${index}]: </span>${value}</li>`;
            }
            
        });
        if (listItems) { childrenHtml = `<ul>${listItems}</ul>`; hasChildren = true; }
    } else if (data.__pth_overview_pth__){
        // 包含 __pth_overview_pth__ 这个key
        hasChildren = false;
    } else if (typeof data === 'object' && data !== null) {
        let listItems = '';
        for (const key in data) {
            if (['_type', 'dtype', 'shape', 'location'].includes(key)) continue;
            // === 核心修改：路径追加 (Push) ===
            const currentPath = [...keyPath, key];
            const value = generateJsonHtml(data[key], currentPath)

            // 对 __pth__truncated__ 开头以及结尾的 key
            if (key.startsWith('__pth__truncated__') && key.endsWith('__pth__truncated__')) {
                listItems += `<li class="truncated-item"><span">"${key}": </span>${value}</li>`;
            } else {
                listItems += `<li><span class="key-name">"${key}": </span>${value}</li>`;
            }

            
        }
        if (listItems) { childrenHtml = `<ul>${listItems}</ul>`; hasChildren = true; }
    }

    // ... (后面的 return 逻辑保持不变)
    if (isTensor && hasChildren) {
        return `<details open><summary>${tensorHtml}</summary>${childrenHtml}</details>`;
    } else if (isTensor) {
        return tensorHtml;
    } else if (hasChildren) {
        const summary = Array.isArray(data) ? 'List []' : 'Dict {}';
        return `<details open><summary>${summary}</summary>${childrenHtml}</details>`;
    } else {
        // === 修复开始：针对空对象/空数组的显示优化 ===
        // 如果是对象且不为空 (null)，说明它是空字典或空列表
        if (typeof data === 'object' && data !== null) {
            // 使用灰色斜体显示，提示用户这是空的
            const emptyStyle = 'color:var(--vscode-descriptionForeground); font-style:italic;';
            
            if (Array.isArray(data)) {
                 return `<span style="${emptyStyle}">List [] (Empty)</span>`;
            } else {
                 return `<span style="${emptyStyle}">Dict {} (Empty)</span>`;
            }
        }
        // === 修复结束 ===

        // 普通基本类型 (数字、字符串等)
        return `<span>${data}</span>`;
    }
}


// 辅助函数
function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    // 保留2位小数
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}