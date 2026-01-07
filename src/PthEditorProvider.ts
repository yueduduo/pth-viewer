import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';           // <--- for 缓存
import * as crypto from 'crypto';   // <--- for 缓存
import { getPythonInterpreterPath } from './pythonApi';

/**
 * 定义一个简单的文档类，用于持有文件的 Uri
 */
class PthDocument implements vscode.CustomDocument {
    uri: vscode.Uri;

    constructor(uri: vscode.Uri) {
        this.uri = uri;
    }

    dispose(): void {
        // 如果有资源需要释放，在这里处理。目前我们不需要做任何事。
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

    constructor(private readonly context: vscode.ExtensionContext) { }

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
        webviewPanel.webview.onDidReceiveMessage(message => {
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
        });

        // 初始加载 (默认尝试全局)
        this.loadPthContent(document, webviewPanel);
    }

    // 抽离加载逻辑，方便刷新
    private async loadPthContent(document: PthDocument, panel: vscode.WebviewPanel) {
        // 1. 显示加载动画
        panel.webview.html = getWebviewContent(`
            <div class="loading">
                <div class="spinner"></div>
                <p>正在解析模型结构... ${this.forceLocal ? '(单文件模式)' : '(自动检测索引)'}</p>
                请确保你选择了正确的 Python 环境 (需包含 torch|safetensors|Jax&orbax 库)。
                <p style="font-size:0.8em; color:var(--vscode-descriptionForeground);">大型文件首次加载需要较长时间，后续将使用缓存秒开。</p>
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

                // 渲染缓存的数据
                const htmlTree = generatePageHtml(this.cacheJson, this.forceLocal);
                
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
        const scriptPath = path.join(this.context.extensionPath, 'python_scripts', 'reader.py');
        
        // python 
        // 动态获取当前选中的 Python 解释器路径
        // 传入当前文档的 uri，以处理多工作区的情况
        let pythonExecutable = await getPythonInterpreterPath(document.uri);
        
        // 为了处理路径中可能存在的空格（特别是在 Windows 上），给路径加上双引号
        // 如果已经是 'python' 系统命令则不需要加，这里做个简单判断
        if (pythonExecutable !== 'python') {
            pythonExecutable = `"${pythonExecutable}"`;
        }

        // 构建最终执行命令
        // 根据模式添加参数
        const args = this.forceLocal ? ' --force-local' : '';
        const command = `${pythonExecutable} "${scriptPath}" "${this.filePath}"${args}`;
        console.log("Executing command:", command);

        cp.exec(command, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
            if (err) {
                // ... 错误处理代码 ...
                // 可以在这里提示用户检查 Python 环境
                panel.webview.html = getWebviewContent(
                    `<h3>Python 运行错误:</h3>
                     <p>请检查 VS Code 右下角选择的 Python 环境是否已安装 PyTorch|safetensors|Jax&orbax。</p>
                     <p>当前尝试使用的 Python 路径: <code>${pythonExecutable}</code></p>
                     <pre>${err.message}</pre>
                     <h4>Stderr:</h4><pre>${stderr}</pre>`, 
                    panel.webview
                );
                return;
            }

            try {
                // 4. 解析 Python 返回的 JSON
                this.cacheJson = JSON.parse(stdout);
                
                if (this.cacheJson.error) {
                    panel.webview.html = getWebviewContent(
                        `<h3>数据读取错误:</h3><pre>${this.cacheJson.error}</pre>`, 
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

                    // 6. 生成 HTML 树状图并显示
                    const htmlTree = generatePageHtml(this.cacheJson, this.forceLocal);
                    panel.webview.html = getWebviewContent(htmlTree, panel.webview);
                }
            } catch (e: any) {
                panel.webview.html = getWebviewContent(
                    `<h3>JSON 解析失败 (Python 输出非标准JSON):</h3><pre>${stdout}</pre>`,
                    panel.webview
                );
            }
        });
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


        // 3. === 缓存未命中，请求 Python ===
        const scriptPath = path.join(this.context.extensionPath, 'python_scripts', 'reader.py');
        let pythonExecutable = await getPythonInterpreterPath(undefined);
        if (pythonExecutable !== 'python') pythonExecutable = `"${pythonExecutable}"`;

        // 注意：message.key 已经是 JSON 字符串了 '["policy", "net.0.weight"]'
        // 我们需要把这个字符串安全地放在命令行参数里。
        // 在 Windows Powershell/CMD 中，内部的双引号需要转义，或者外层用单引号（视情况而定）。
        // 最简单的方法：把 JSON 里的双引号转义一下，或者直接依靠 cp.exec 的自动处理(如果有的话，但通常没有)。
        
        // 简单粗暴但有效的转义：把双引号变成转义的双引号
        const escapedKey = key.replace(/"/g, '\\"'); 
        
        // 最终命令类似于: python reader.py file.pth --action data --key "[\"policy\", \"net.0.weight\"]"
        const command = `${pythonExecutable} "${scriptPath}" "${filePath}" --action data --key "${escapedKey}"`;
        
        cp.exec(command, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
            if (err) {
                // 发消息回 Webview 显示错误
                panel.webview.postMessage({ command: 'showData', id: elementId, error: err.message });
                return;
            }
            try {
                const result = JSON.parse(stdout);
                // 发消息回 Webview 显示数据
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
            } catch (e: any) {
                panel.webview.postMessage({ command: 'showData', id: elementId, error: "Parse Error" });
            }
        });
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

function generatePageHtml(result: any, isForceLocal: boolean): string {
    const isGlobal = result.is_global;
    const data = result.data;
    const indexFile = result.index_file || "";

    // 控制栏 HTML
    let controlBar = '';
    
    if (isGlobal) {
        controlBar = `
            <div class="status-bar global-mode">
                <span class="icon">🌐</span> 
                <span><strong>全局视图:</strong> 已加载索引 <code>${indexFile}</code></span>
                <button onclick="vscode.postMessage({command: 'switchMode', value: true})">切换为只看当前文件</button>
            </div>
        `;
    } else if (isForceLocal) {
        controlBar = `
            <div class="status-bar local-mode">
                <span class="icon">📄</span> 
                <span><strong>单文件视图:</strong> 仅显示当前文件内容</span>
                <button onclick="vscode.postMessage({command: 'switchMode', value: false})">尝试检测全局索引</button>
            </div>
        `;
    } else {
        controlBar = `
            <div class="status-bar local-mode">
                <span class="icon">📄</span> 
                <span>单文件视图 (未检测到索引)</span>
            </div>
        `;
    }

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
            .status-bar {
                padding: 8px 12px;
                margin-bottom: 15px;
                border-radius: 4px;
                display: flex;
                align-items: center;
                gap: 10px;
                font-size: 0.9em;
                border: 1px solid var(--vscode-widget-border);
            }
            .global-mode { background-color: var(--vscode-notebook-cellInsertedBackground); border-left: 4px solid var(--vscode-notebook-statusSuccessIcon-foreground); }
            .local-mode { background-color: var(--vscode-notebook-cellDeletedBackground); border-left: 4px solid var(--vscode-notebook-statusErrorIcon-foreground); }
            
            button {
                margin-left: auto;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 4px 8px;
                border-radius: 2px;
                cursor: pointer;
            }
            button:hover { background: var(--vscode-button-hoverBackground); }

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

        const detailStr = data._type === 'tensor' ? `${shapeStr} (${dtype})` : `(索引引用)`;
        
        // 注意：onclick 这里我们要传 safePath，后端拿到后再 decodeURIComponent
        // 但其实 postMessage 可以直接传对象，我们这里为了简单，传 safePath 字符串
        const inspectBtn = data._type === 'tensor' 
            ? `<span class="inspect-btn" title="查看/折叠" onclick="toggleInspect('${safePath}', '${btnId}')">🔍</span>` 
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
            listItems += `<li><span class="key-name">[${index}]: </span>${generateJsonHtml(item, currentPath)}</li>`;
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
            listItems += `<li><span class="key-name">"${key}": </span>${generateJsonHtml(data[key], currentPath)}</li>`;
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
        return `<span>${data}</span>`;
    }
}