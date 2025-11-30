import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
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
        
        // Webview 
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        // 监听 Webview 发来的消息 (用于切换模式)
        webviewPanel.webview.onDidReceiveMessage(message => {
            if (message.command === 'switchMode') {
                const forceLocal = message.value; // true = 强制局部, false = 自动全局
                this.loadPthContent(document, document.uri.fsPath, webviewPanel, forceLocal);
            }
            // === 处理查看数据请求 ===
            if (message.command === 'inspect') {
                const key = message.key;
                const elementId = message.id;
                this.inspectTensorData(document.uri.fsPath, key, elementId, webviewPanel);
            }
        });
        // 初始加载 (默认尝试全局)
        this.loadPthContent(document, document.uri.fsPath, webviewPanel, false);
    }
    // 抽离加载逻辑，方便刷新
    private async loadPthContent(document: PthDocument, filePath: string, panel: vscode.WebviewPanel, forceLocal: boolean) {
        panel.webview.html = getWebviewContent(`
            <div class="loading">
                <div class="spinner"></div>
                <p>正在解析模型结构... ${forceLocal ? '(单文件模式)' : '(自动检测索引)'}</p>
                请确保你选择了正确的 Python 环境 (需包含 torch/safetensors 库)。
            </div>
        `, panel.webview);
        

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
        const args = forceLocal ? ' --force-local' : '';
        const command = `${pythonExecutable} "${scriptPath}" "${filePath}"${args}`;
        console.log("Executing command:", command);

        cp.exec(command, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
            if (err) {
                // ... 错误处理代码 ...
                // 可以在这里提示用户检查 Python 环境
                panel.webview.html = getWebviewContent(
                    `<h3>Python 运行错误:</h3>
                     <p>请检查 VS Code 右下角选择的 Python 环境是否已安装 PyTorch。</p>
                     <p>当前尝试使用的 Python 路径: <code>${pythonExecutable}</code></p>
                     <pre>${err.message}</pre>
                     <h4>Stderr:</h4><pre>${stderr}</pre>`, 
                    panel.webview
                );
                return;
            }

            try {
                // 4. 解析 Python 返回的 JSON
                const data = JSON.parse(stdout);
                
                if (data.error) {
                    panel.webview.html = getWebviewContent(
                        `<h3>数据读取错误:</h3><pre>${data.error}</pre>`, 
                        panel.webview
                    );
                } else {
                    // 5. 生成 HTML 树状图并显示
                    const htmlTree = generatePageHtml(data, forceLocal);
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
            } catch (e: any) {
                panel.webview.postMessage({ command: 'showData', id: elementId, error: "Parse Error" });
            }
        });
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
            function postInspectMessage(safePath, btnId) {
                // 解码: %5B... -> ["policy", "net.0.weight"]
                const jsonPath = decodeURIComponent(safePath);
                vscode.postMessage({
                    command: 'inspect',
                    key: jsonPath, // 现在发给 extension 的是 JSON 字符串
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
            ? `<span class="inspect-btn" title="查看数值" onclick="postInspectMessage('${safePath}', '${btnId}')">🔍</span>` 
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