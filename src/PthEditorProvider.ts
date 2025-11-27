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
        webviewPanel.webview.html = getWebviewContent("正在加载 PyTorch 数据结构...<br>请确保你选择了正确的 Python 环境 (需包含 torch 库)。", webviewPanel.webview);
        
        // file path
        const filePath = document.uri.fsPath; // 从我们自定义的 document 中获取路径
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
        const command = `${pythonExecutable} "${scriptPath}" "${filePath}"`;
        console.log("Executing command:", command);

        cp.exec(command, (err, stdout, stderr) => {
            if (err) {
                // ... 错误处理代码 ...
                // 可以在这里提示用户检查 Python 环境
                webviewPanel.webview.html = getWebviewContent(
                    `<h3>Python 运行错误:</h3>
                     <p>请检查 VS Code 右下角选择的 Python 环境是否已安装 PyTorch。</p>
                     <p>当前尝试使用的 Python 路径: <code>${pythonExecutable}</code></p>
                     <pre>${err.message}</pre>
                     <h4>Stderr:</h4><pre>${stderr}</pre>`, 
                    webviewPanel.webview
                );
                return;
            }

            try {
                // 4. 解析 Python 返回的 JSON
                const data = JSON.parse(stdout);
                
                if (data.error) {
                    webviewPanel.webview.html = getWebviewContent(
                        `<h3>数据读取错误:</h3><pre>${data.error}</pre>`, 
                        webviewPanel.webview
                    );
                } else {
                    // 5. 生成 HTML 树状图并显示
                    const htmlTree = generateJsonHtml(data);
                    webviewPanel.webview.html = getWebviewContent(htmlTree, webviewPanel.webview);
                }
            } catch (e: any) {
                webviewPanel.webview.html = getWebviewContent(
                    `<h3>JSON 解析失败 (Python 输出非标准JSON):</h3><pre>${stdout}</pre>`,
                    webviewPanel.webview
                );
            }
        });
    }
}


// ----------------------------------------------------
//  辅助函数 (保持不变)
// ----------------------------------------------------

export function getWebviewContent(bodyContent: string, webview?: vscode.Webview): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            /* 1. 全局样式：使用 VS Code 字体和基础颜色 */
            body { 
                font-family: var(--vscode-editor-font-family); /* 使用编辑器字体 */
                font-size: var(--vscode-editor-font-size);
                background-color: var(--vscode-editor-background); 
                color: var(--vscode-foreground); /* 前景文字颜色 */
                padding: 15px; 
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
        </style>
    </head>
    <body>
        <h2>PyTorch Structure Viewer</h2>
        ${bodyContent}
    </body>
    </html>`;
}

export function generateJsonHtml(data: any): string {
    if (data && data._type === 'tensor') {
        const dtype = data.dtype || 'unknown';
        const shape = data.shape ? data.shape.join(' × ') : 'scalar';
        return `<span class="tensor-info">Tensor [ ${shape} ] (${dtype})</span>`;
    } else if (Array.isArray(data)) {
        let html = '<details open><summary>List []</summary><ul>';
        data.forEach((item, index) => {
            html += `<li><span class="key-name">[${index}]: </span>${generateJsonHtml(item)}</li>`;
        });
        html += '</ul></details>';
        return html;
    } else if (typeof data === 'object' && data !== null) {
        let html = '<details open><summary>Dict {}</summary><ul>';
        for (const key in data) {
            if (key === '_type') continue;
            html += `<li><span class="key-name">"${key}": </span>${generateJsonHtml(data[key])}</li>`;
        }
        html += '</ul></details>';
        return html;
    } else {
        return `<span>${data}</span>`;
    }
}