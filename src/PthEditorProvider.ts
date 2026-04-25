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

    private panelStates = new WeakMap<vscode.WebviewPanel, {
        filePath: string;
        forceLocal: boolean;
        cacheJson: Record<string, any>;
        cacheFilePath: string;
        cacheHash: string | null;
        allowUnsafeLoadForCurrentFile: boolean;
    }>();

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
        const state = this.getOrCreateState(webviewPanel, document.uri.fsPath);
        state.forceLocal = false; // 初始默认全局模式

        // Webview 
        webviewPanel.webview.options = {
            enableScripts: true,
        };
        webviewPanel.onDidDispose(() => {
            this.panelStates.delete(webviewPanel);
        });

        // 监听 Webview 发来的消息
        webviewPanel.webview.onDidReceiveMessage(async message => {
            // 监听 模式 切换
            if (message.command === 'switchMode') {
                state.forceLocal = message.value; // update: true = 强制局部, false = 自动全局
                this.loadPthContent(document, webviewPanel, state);
            }
            // 监听 查看数据请求
            if (message.command === 'inspect') {
                const key = message.key;
                const elementId = message.id;
                this.inspectTensorData(document, document.uri.fsPath, key, elementId, webviewPanel, state);
            }

            // 监听 reload 
            if (message.command === 'reload') {
                console.log("[Editor] Reloading...");
                
                // 1. 尝试删除物理缓存文件
                if (fs.existsSync(state.cacheFilePath)) {
                    try {
                        fs.unlinkSync(state.cacheFilePath); // 删除文件
                        console.log(`[Cache] Deleted stale cache: ${state.cacheFilePath}`);
                    } catch (e) {
                        console.error("[Cache] Failed to delete cache:", e);
                    }
                }

                // 2. 通知 Python 后端释放内存 (清除 LOADED_MODELS)
                try {
                    await PythonServerManager.getInstance().sendRequest('/release', {
                        file_path: state.filePath
                    });
                } catch (e) { console.warn("Failed to release backend memory:", e); }

                // 3. 清空前端内存对象
                state.cacheJson = {}; 
                
                // 4. 重新加载 (这会触发全新的 /load 请求并重新生成缓存)
                this.loadPthContent(document, webviewPanel, state);
            }

            if (message.command === 'enableUnsafeLoad') {
                state.allowUnsafeLoadForCurrentFile = true;
                this.markFileAsUnsafeTrusted(state.filePath);
                vscode.window.showInformationMessage(t('unsafe_load_enabled_notice'));
                this.loadPthContent(document, webviewPanel, state);
            }

            if (message.command === 'openUnsafeLoadSetting') {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'pthViewer.allowUnsafeLoad');
            }

            if (message.command === 'openFullStructureFolder') {
                const fullPath = decodeURIComponent(message.fullPath as string);
                await this.openFullStructureFolder(fullPath);
            }

            if (message.command === 'openFind') {
                webviewPanel.webview.postMessage({ command: 'showCustomFind' });
            }

            if (message.command === 'copyKey') {
                const keyText = typeof message.keyText === 'string' ? message.keyText : '';
                const requestId = typeof message.requestId === 'string' ? message.requestId : '';
                if (!keyText) {
                    webviewPanel.webview.postMessage({ command: 'copyKeyResult', success: false, requestId });
                    return;
                }
                try {
                    await vscode.env.clipboard.writeText(keyText);
                    webviewPanel.webview.postMessage({ command: 'copyKeyResult', success: true, requestId });
                } catch (_e) {
                    webviewPanel.webview.postMessage({ command: 'copyKeyResult', success: false, requestId });
                }
            }

            if (message.command === 'loadIndexedTruncatedPane') {
                const indexDbPath = decodeURIComponent(message.indexDbPath as string);
                const rawSourceFilePath = typeof message.sourceFilePath === 'string' ? message.sourceFilePath : '';
                const decodedSourceFilePath = rawSourceFilePath ? decodeURIComponent(rawSourceFilePath) : '';
                const sourceFilePath = decodedSourceFilePath && decodedSourceFilePath !== 'undefined'
                    ? decodedSourceFilePath
                    : state.filePath;
                const displayPath = decodeURIComponent(message.displayPath as string);
                const containerId = message.containerId as string;
                const offset = Number(message.offset ?? 0);
                const limit = Number(message.limit ?? 200);
                let result: any;
                const canUseSqlite = !!indexDbPath;
                if (canUseSqlite) {
                    result = await PythonServerManager.getInstance().sendRequest('/tree_children_by_path', {
                        file_path: sourceFilePath,
                        index_db_path: indexDbPath,
                        display_path: displayPath,
                        offset,
                        limit,
                    });
                }

                const sqliteErrorText = String(result?.error || '').toLowerCase();
                const sqliteUnavailable =
                    !canUseSqlite ||
                    !!result?.error && (
                        sqliteErrorText.includes('no such table: nodes') ||
                        sqliteErrorText.includes('unable to open database file') ||
                        sqliteErrorText.includes('no such file') ||
                        sqliteErrorText.includes('database disk image is malformed') ||
                        sqliteErrorText.includes('not a database') ||
                        sqliteErrorText.includes('path not found')
                    );

                if (sqliteUnavailable) {
                    const modelStatus = await PythonServerManager.getInstance().sendRequest('/model_status', {
                        file_path: sourceFilePath,
                    });
                    if (!modelStatus?.loaded_in_memory) {
                        vscode.window.showInformationMessage(t('dynamic_reloading_memory_notice'));
                    }
                    result = await PythonServerManager.getInstance().sendRequest('/tree_children_dynamic', {
                        file_path: sourceFilePath,
                        display_path: displayPath,
                        offset,
                        limit,
                        allow_unsafe: state.allowUnsafeLoadForCurrentFile,
                    });
                    if (result?.error && this.isUnsafeLoadRelatedError(result.error)) {
                        const shouldRetryUnsafe = await this.handleUnsafeLoadPrompt(result.error, document, webviewPanel, state);
                        if (shouldRetryUnsafe) {
                            return;
                        }
                    }
                }
                webviewPanel.webview.postMessage({
                    command: 'indexedTruncatedPaneData',
                    payload: { containerId, displayPath, offset, limit, result }
                });
            }
        });

        // 初始加载 (默认尝试全局)
        this.loadPthContent(document, webviewPanel, state);
    }

    // 抽离加载逻辑，方便刷新
    private async loadPthContent(document: PthDocument, panel: vscode.WebviewPanel, state: { filePath: string; forceLocal: boolean; cacheJson: Record<string, any>; cacheFilePath: string; cacheHash: string | null; allowUnsafeLoadForCurrentFile: boolean; }) {
        const defaultAllowUnsafeLoad = this.getDefaultAllowUnsafeLoad();
        state.allowUnsafeLoadForCurrentFile = defaultAllowUnsafeLoad;
        if (!defaultAllowUnsafeLoad) {
            state.allowUnsafeLoadForCurrentFile = this.isUnsafeTrustedFile(state.filePath);
        }

        // 计算文件大小
        let fileSizeStr = "0 B";
        try {
            const stats = fs.statSync(state.filePath);
            fileSizeStr = formatFileSize(stats.size);
        } catch (e) { console.error(e); }

        // 1. 显示加载动画 显示文件大小
        panel.webview.html = getWebviewContent(`
            <div class="loading">
                <div class="spinner"></div>
                <p>${t('loading_file_size')}: ${fileSizeStr}</p>
                <p>${t('loading_parsing')}... ${state.forceLocal ? t('loading_single_mode') : t('loading_auto_mode')}</p>
                ${t('loading_env_check')}
                <p style="font-size:0.8em; color:var(--vscode-descriptionForeground);">${t('loading_cache_tip')}</p>
            </div>
        `, panel.webview);
        
        // 2. === 尝试读取缓存 ===
        state.cacheHash = this.computeCacheKey(state.filePath, state.forceLocal);
        state.cacheFilePath = this.getCachePath(state.cacheHash!);
        if (fs.existsSync(state.cacheFilePath)) {
            try {
                console.log(`[Cache] Hit! Loading from ${state.cacheFilePath}`);
                const cacheRaw = fs.readFileSync(state.cacheFilePath, 'utf-8');
                const cacheContent = JSON.parse(cacheRaw);
                state.cacheJson = cacheContent.data;
                if (cacheContent?.meta?.allow_unsafe_load === true) {
                    state.allowUnsafeLoadForCurrentFile = true;
                    this.markFileAsUnsafeTrusted(state.filePath);
                }

                let totalSizeBytes = 0;
                // 情况 1: Python 后端返回了计算好的总大小 (Global 模式)
                if (state.cacheJson && state.cacheJson.total_size) {
                    totalSizeBytes = state.cacheJson.total_size;
                    console.log(`[Size] Using size calculated by Python: ${totalSizeBytes}`);
                    fileSizeStr = formatFileSize(totalSizeBytes);
                } 
                // 情况 2: 单文件模式 (或者 Python 端没有返回 total_size)
                else {}
                // 渲染缓存的数据
                const htmlTree = generatePageHtml(state.cacheJson, state.forceLocal, fileSizeStr, state.filePath);
                
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
                file_path: state.filePath,
                force_local: state.forceLocal,
                allow_unsafe: state.allowUnsafeLoadForCurrentFile,
                cache_dir: this.getCacheDirPath(),
                cache_key: state.cacheHash
            });

            if (result.error) {
                const shouldRetryUnsafe = await this.handleUnsafeLoadPrompt(result.error, document, panel, state);
                if (shouldRetryUnsafe) {
                    return;
                }
                if (this.isUnsafeLoadRelatedError(result.error)) {
                    this.renderUnsafeLoadError(panel, result.error);
                    return;
                }
                // 这是 Python 服务器内部捕获的错误  Python 已经正常启动 但是 出错
                panel.webview.html = getWebviewContent(
                    `<h3>${t('err_parse_error')}</h3><pre>${result.error}</pre>`, 
                    panel.webview
                );
            } else {
                // 4. 解析 Python 返回的 JSON
                state.cacheJson = result; // 结果格式应该和原来一致

                if (state.cacheJson.error) {
                    panel.webview.html = getWebviewContent(
                        `<h3>${t('err_data_read')}:</h3><pre>${state.cacheJson.error}</pre>`, 
                        panel.webview
                    );
                } else {
                    // 5. === 解析成功，写入缓存 ===
                    try {
                        this.saveToCache(state.cacheJson, state)
                        console.log(`[Cache] Saved to: ${state.cacheFilePath}`);
                    } catch (e) {
                        console.error("[Cache] Write failed:", e);
                    }

                    let totalSizeBytes = 0;
                    // 情况 1: Python 后端返回了计算好的总大小 (Global 模式)
                    if (state.cacheJson && state.cacheJson.total_size) {
                        totalSizeBytes = state.cacheJson.total_size;
                        console.log(`[Size] Using size calculated by Python: ${totalSizeBytes}`);
                        fileSizeStr = formatFileSize(totalSizeBytes);
                    } 
                    // 情况 2: 单文件模式 (或者 Python 端没有返回 total_size)
                    else {}
                    // 6. 生成 HTML 树状图并显示
                    const htmlTree = generatePageHtml(state.cacheJson, state.forceLocal, fileSizeStr, state.filePath);
                    panel.webview.html = getWebviewContent(htmlTree, panel.webview);
                }
            }
        } catch (e: any) {
            // 捕获Python启动失败的异常
            console.error("Load failed:", e);
            const errorMsg = e.message || "Unknown error";
            const shouldRetryUnsafe = await this.handleUnsafeLoadPrompt(errorMsg, document, panel, state);
            if (shouldRetryUnsafe) {
                return;
            }
            if (this.isUnsafeLoadRelatedError(errorMsg)) {
                this.renderUnsafeLoadError(panel, errorMsg);
                return;
            }

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
    private async inspectTensorData(document: PthDocument, filePath: string, key: string, elementId: string, panel: vscode.WebviewPanel, state: { filePath: string; forceLocal: boolean; cacheJson: Record<string, any>; cacheFilePath: string; cacheHash: string | null; allowUnsafeLoadForCurrentFile: boolean; }) {
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
            targetNode = this.findNodeByPath(state.cacheJson.data, keys);
                
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
            const modelStatus = await PythonServerManager.getInstance().sendRequest('/model_status', {
                file_path: filePath,
            });
            if (!modelStatus?.loaded_in_memory) {
                vscode.window.showInformationMessage(t('dynamic_reloading_memory_notice'));
            }
            const result = await PythonServerManager.getInstance().sendRequest('/inspect', {
                file_path: filePath,
                key: key, // 直接传 JSON 字符串，Server 端会解析
                allow_unsafe: state.allowUnsafeLoadForCurrentFile,
            });
            if (result.error) {
                 if (this.isUnsafeLoadRelatedError(result.error)) {
                    const shouldRetryUnsafe = await this.handleUnsafeLoadPrompt(result.error, document, panel, state);
                    if (shouldRetryUnsafe) {
                        return;
                    }
                 }
                 panel.webview.postMessage({ command: 'showData', id: elementId, error: result.error });
            } else {
                panel.webview.postMessage({ command: 'showData', id: elementId, data: result });
                 // 显示从python获取了数据 console.log
                console.log(`[Python] Get overview data for ${keys.join('.')}`);
                
                // 4. === 异步写入缓存 (Update __pth_overview_pth__) ===
                // 只有当数据正常（不是 error），且我们之前成功定位到了缓存文件和节点时，才写入
                if (!result.error && targetNode && state.cacheFilePath) {
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
                            this.saveToCache(state.cacheJson, state);
                            console.log(`[Cache] Updated to: ${state.cacheFilePath}`);
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
        const cacheDir = this.getCacheDirPath();
        // 确保存储目录存在
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        return path.join(cacheDir, `${hash}.json`);
    }

    private getCacheDirPath(): string {
        const storagePath = this.context.globalStorageUri.fsPath;
        return path.join(storagePath, 'cache');
    }

    /**
     * 将解析结果写入缓存
     */
    private saveToCache(resultData: any, state: { filePath: string; forceLocal: boolean; cacheJson: Record<string, any>; cacheFilePath: string; cacheHash: string | null; allowUnsafeLoadForCurrentFile: boolean; }) {
        const stats = fs.statSync(state.filePath);
        
        // 构建缓存对象 (为未来扩展 Metadata 做准备)
        const cacheContent = {
            version: "1.0",
            source_hash: state.cacheHash,
            timestamp: Date.now(),
            meta: {
                file_path: state.filePath,
                file_size: stats.size,
                allow_unsafe_load: state.allowUnsafeLoadForCurrentFile,
                // TODO: 这里未来可以扩展 param_count, arch 等信息
            },
            data: resultData // Python 返回的原始结构
        };

        fs.writeFileSync(state.cacheFilePath, JSON.stringify(cacheContent), 'utf-8');
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

    private getDefaultAllowUnsafeLoad(): boolean {
        const config = vscode.workspace.getConfiguration('pthViewer');
        return config.get<boolean>('allowUnsafeLoad', false);
    }

    private getUnsafeTrustStorePath(): string {
        const storagePath = this.context.globalStorageUri.fsPath;
        if (!fs.existsSync(storagePath)) {
            fs.mkdirSync(storagePath, { recursive: true });
        }
        return path.join(storagePath, 'unsafe-load-trusted-files.json');
    }

    private normalizeFileKey(filePath: string): string {
        return path.normalize(filePath).toLowerCase();
    }

    private readUnsafeTrustStore(): Record<string, boolean> {
        const trustFilePath = this.getUnsafeTrustStorePath();
        if (!fs.existsSync(trustFilePath)) {
            return {};
        }

        try {
            const raw = fs.readFileSync(trustFilePath, 'utf-8');
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    private writeUnsafeTrustStore(content: Record<string, boolean>) {
        const trustFilePath = this.getUnsafeTrustStorePath();
        fs.writeFileSync(trustFilePath, JSON.stringify(content), 'utf-8');
    }

    private isUnsafeTrustedFile(filePath: string): boolean {
        const trustMap = this.readUnsafeTrustStore();
        const key = this.normalizeFileKey(filePath);
        return trustMap[key] === true;
    }

    private markFileAsUnsafeTrusted(filePath: string) {
        const trustMap = this.readUnsafeTrustStore();
        const key = this.normalizeFileKey(filePath);
        trustMap[key] = true;
        this.writeUnsafeTrustStore(trustMap);
    }

    private async handleUnsafeLoadPrompt(errorText: string, document: PthDocument, panel: vscode.WebviewPanel, state: { filePath: string; forceLocal: boolean; cacheJson: Record<string, any>; cacheFilePath: string; cacheHash: string | null; allowUnsafeLoadForCurrentFile: boolean; }): Promise<boolean> {
        const defaultAllowUnsafeLoad = this.getDefaultAllowUnsafeLoad();
        if (defaultAllowUnsafeLoad) {
            return false;
        }

        if (state.allowUnsafeLoadForCurrentFile) {
            return false;
        }

        if (!this.isUnsafeLoadRelatedError(errorText)) {
            return false;
        }

        const actionEnable = t('unsafe_load_enable_once');
        const actionOpenSettings = t('open_unsafe_load_setting');
        const picked = await vscode.window.showWarningMessage(
            `${t('unsafe_load_confirm_title')}\n${t('unsafe_load_confirm_detail')}`,
            { modal: true },
            actionEnable,
            actionOpenSettings
        );

        if (picked === actionOpenSettings) {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'pthViewer.allowUnsafeLoad');
            return false;
        }

        if (picked !== actionEnable) {
            return false;
        }

        state.allowUnsafeLoadForCurrentFile = true;
        this.markFileAsUnsafeTrusted(state.filePath);
        vscode.window.showInformationMessage(t('unsafe_load_enabled_notice'));
        this.loadPthContent(document, panel, state);
        return true;
    }

    private getOrCreateState(panel: vscode.WebviewPanel, filePath: string) {
        const existing = this.panelStates.get(panel);
        if (existing) {
            return existing;
        }
        const state = {
            filePath,
            forceLocal: false,
            cacheJson: {},
            cacheFilePath: '',
            cacheHash: '' as string | null,
            allowUnsafeLoadForCurrentFile: false,
        };
        this.panelStates.set(panel, state);
        return state;
    }

    private isUnsafeLoadRelatedError(errorText: string): boolean {
        const lower = errorText.toLowerCase();
        return (
            lower.includes('weights_only') ||
            lower.includes('weights only') ||
            lower.includes('unsupported global') ||
            lower.includes('pickle')
        );
    }

    private renderUnsafeLoadError(panel: vscode.WebviewPanel, errorText: string) {
        const manager = PythonServerManager.getInstance();
        const currentPyPath = manager.getInterpreterPath();
        panel.webview.html = getWebviewContent(
            `
            <div style="padding: 10px; border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 5px;">
                <h3 style="margin-top:0;">${t('err_python_run')}</h3>
                <p><strong>${t('unsafe_load_confirm_title')}</strong></p>
                <p>${t('unsafe_load_inline_hint')}</p>
                <div style="display:flex; gap:10px; margin: 8px 0 12px 0;">
                    <button onclick="vscode.postMessage({command: 'enableUnsafeLoad'})">${t('unsafe_load_enable_once')}</button>
                    <button onclick="vscode.postMessage({command: 'openUnsafeLoadSetting'})">${t('open_unsafe_load_setting')}</button>
                </div>
                <p>${t('err_python_path')} <code style="background:var(--vscode-textBlockQuote-background); padding:2px 4px;">${currentPyPath}</code></p>
                <hr style="border: 0; border-top: 1px solid var(--vscode-textBlockQuote-border);">
                <h4>${t('err_stderr_output')}</h4>
                <pre style="color:var(--vscode-errorForeground); overflow:auto; max-height:300px;">${errorText}</pre>
            </div>
            `,
            panel.webview
        );
    }

    private async openFullStructureFolder(fullPath: string) {
        if (!fullPath || !fs.existsSync(fullPath)) {
            vscode.window.showWarningMessage(t('full_json_not_generated'));
            return;
        }
        try {
            await vscode.env.clipboard.writeText(fullPath);
            vscode.window.showInformationMessage(t('json_path_copied'));
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`${t('json_path_copy_failed')}: ${detail}`);
        }
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fullPath));
    }
}




// ----------------------------------------------------
//  辅助函数 (保持不变)
// ----------------------------------------------------

function escapeHtmlAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/\r?\n/g, ' ');
}

/** 顶栏与截断面板中的「JSON」按钮：悬浮显示路径，点击复制路径并在系统中显示文件 */
function fullJsonRevealButtonHtml(fullStructurePath: string): string {
    const pathRaw = fullStructurePath || '';
    const titleText = pathRaw.length > 0 ? pathRaw : t('full_json_not_generated');
    const titleAttr = escapeHtmlAttr(titleText);
    const encoded = encodeURIComponent(pathRaw);
    const label = t('open_full_json_folder');
    return `<button type="button" title="${titleAttr}" onclick="vscode.postMessage({command: 'openFullStructureFolder', fullPath: '${encoded}'})">${label}</button>`;
}

function generatePageHtml(result: any, isForceLocal: boolean, fileSizeStr: string, fallbackSourceFilePath: string = ''): string {
    const isGlobal = result.is_global;
    const data = result.data;
    const indexFile = result.index_file || "";
    const fullStructurePath = result.full_structure_path || "";

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

    const openFullJsonFolderButton = fullJsonRevealButtonHtml(fullStructurePath);

    let controlBar = `
        <div class="status-bar ${statusClass}">
            <div class="status-left">
                <span class="icon">${icon}</span> 
                <span class="status-title">${title}</span>
                <span class="status-desc">${desc}</span>
                <span class="size-badge">${fileSizeStr}</span>
            </div>
            <div class="status-right">
                ${openFullJsonFolderButton}
                <button class="icon-btn" onclick="vscode.postMessage({command: 'openFind'})" title="${t('btn_find')}">
                    <span class="codicon-symbol icon-find">⌕</span> ${t('btn_find')}
                </button>
                <button class="icon-btn" onclick="vscode.postMessage({command: 'reload'})" title="${t('btn_reload')}">
                    <span class="codicon-symbol">↻</span> ${t('btn_reload')}
                </button>
                <button
                    id="collapse-toggle-btn"
                    class="icon-btn"
                    onclick="toggleCollapseAllState()"
                    title="${t('btn_collapse_all')}"
                    data-collapse-text="${t('btn_collapse_all')}"
                    data-expand-text="${t('btn_expand_all')}"
                >
                    <span class="codicon-symbol icon-collapse">▸</span> <span class="btn-label">${t('btn_collapse_all')}</span>
                </button>
                <button style="display:${isGlobal || isForceLocal ? 'inline-block' : 'none'}" onclick="vscode.postMessage({command: 'switchMode', value: ${switchCmdValue}})">
                    ${switchBtnText}
                </button>
            </div>
        </div>
    `;

    const sourceFilePath = (typeof result?.source_file_path === 'string' && result.source_file_path && result.source_file_path !== 'undefined')
        ? result.source_file_path
        : fallbackSourceFilePath;
    const treeHtml = generateJsonHtml(data, [], fullStructurePath, result.full_structure_index_path || "", sourceFilePath, "$");
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
                    --tree-line-color: color-mix(in srgb, var(--vscode-descriptionForeground) 40%, transparent);
                    --tree-line-width: 1px;
                    --tree-branch-length: 10px;
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
            .icon-btn .icon-find {
                display: inline-block;
                transform: translateY(-1px);
                font-size: 1.18em;
            }
            .icon-btn .icon-collapse {
                display: inline-block;
                transform: translateY(-1px);
                font-size: 1.28em;
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
                padding-left: 18px; 
                margin: 2px 0 0 0;
            }
            li { 
                margin: 0 0 4px 0;
                line-height: 1.4;
                position: relative;
                padding-left: 12px;
            }
            li::before {
                content: '';
                position: absolute;
                left: 0;
                top: 11px;
                width: var(--tree-branch-length);
                border-top: var(--tree-line-width) solid var(--tree-line-color);
            }
            li.has-details::before,
            li.has-toggle::before {
                display: none;
            }
            li.truncated-item::before {
                display: none;
            }
            li::after {
                content: '';
                position: absolute;
                left: 0;
                top: 0;
                bottom: 0;
                border-left: var(--tree-line-width) solid var(--tree-line-color);
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
                padding-left: 14px;
                position: relative;
                display: inline-flex;
                align-items: center;
                gap: 4px;
                list-style: none;
            }
            details > summary::-webkit-details-marker {
                display: none;
            }
            details > summary::marker {
                content: '';
            }
            details > summary::before {
                content: '▸';
                position: absolute;
                left: 0;
                top: 50%;
                transform: translateY(-50%);
                color: var(--vscode-descriptionForeground);
                font-size: 20px;
                line-height: 1;
                transition: transform 0.1s;
            }
            details[open] > summary::before {
                content: '▾';
                transform: translateY(-62%);
            }

            /* 5. 数据类型高亮 */
            /* 字典 Key/列表 Index */
            .key-name { 
                color: var(--vscode-terminal-ansiYellow); 
                font-weight: 600;
            }
            .node-key-chip {
                display: inline-flex;
                align-items: center;
                color: var(--vscode-terminal-ansiYellow);
                font-weight: 600;
                margin-right: 6px;
            }
            .node-sep {
                color: var(--vscode-descriptionForeground);
                margin-right: 6px;
            }
            .node-inline {
                display: flex;
                align-items: flex-start;
                gap: 6px;
                flex-wrap: wrap;
            }
            .copy-key-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                margin-left: 4px;
                padding: 0 5px;
                border: 1px solid var(--vscode-widget-border);
                border-radius: 3px;
                color: var(--vscode-descriptionForeground);
                background: transparent;
                cursor: pointer;
                font-size: 0.75em;
                line-height: 1.2;
            }
            .copy-key-btn:hover {
                background: var(--vscode-editor-inactiveSelectionBackground);
            }
            .copy-key-btn.copy-pending {
                border-color: var(--vscode-descriptionForeground);
                color: var(--vscode-descriptionForeground);
                opacity: 0.85;
            }
            .copy-key-btn.copy-ok {
                border-color: var(--vscode-testing-iconPassed);
                color: var(--vscode-testing-iconPassed);
                background: color-mix(in srgb, var(--vscode-testing-iconPassed) 18%, transparent);
            }
            .copy-key-btn.copy-fail {
                border-color: var(--vscode-errorForeground);
                color: var(--vscode-errorForeground);
                background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent);
            }
            .node-inline .node-key-chip {
                align-self: flex-start;
                line-height: 1.4;
                margin-top: 1px;
            }
            .node-inline .node-value {
                display: inline-block;
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
                margin-top: 1px;
                padding: 1px 8px 6px;
                background-color: var(--vscode-editor-inactiveSelectionBackground);
                border: 1px solid var(--vscode-editorWidget-border);
                font-family: 'Consolas', monospace;
                font-size: 0.85em;
                white-space: normal;
            }
            li > .data-preview,
            .indexed-node > .data-preview {
                margin-top: 2px;
            }
            .stats-row {
                margin-bottom: 2px;
                color: var(--vscode-descriptionForeground);
                border-bottom: 1px dashed var(--vscode-editorRuler-foreground);
                padding-bottom: 2px;
                display: flex;
                flex-wrap: nowrap;
                gap: 12px;
                white-space: nowrap;
                overflow-x: auto;
            }
            .stats-item { margin-right: 0; }
            .tensor-preview-text {
                margin: 2px 0 0;
                white-space: pre;
                overflow-x: auto;
                font-family: 'Consolas', monospace;
                font-size: 0.85em;
                line-height: 1.35;
                background: transparent;
                border: none;
                padding: 0;
            }

            .truncated-toggle {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                cursor: pointer;
                user-select: none;
            }
            .truncated-toggle .arrow {
                display: inline-block;
                width: 12px;
                text-align: center;
                color: var(--vscode-descriptionForeground);
                font-size: 10px;
                line-height: 1;
            }
            .full-structure-pane {
                display: none;
                margin: 6px 0 8px 22px;
                border: 1px solid var(--vscode-widget-border);
                border-radius: 4px;
                background: var(--vscode-editor-background);
                min-height: 120px;
                max-height: 320px;
                height: 200px;
                resize: vertical;
                overflow: auto;
                padding: 8px 8px 8px 12px;
                border-left: var(--tree-line-width) solid var(--tree-line-color);
            }
            .full-structure-pane .hint {
                color: var(--vscode-descriptionForeground);
                margin-bottom: 8px;
            }
            .indexed-tree {
                margin: 0;
                padding-left: 18px;
            }
            .webview-find {
                position: fixed;
                top: 10px;
                right: 12px;
                z-index: 9999;
                display: none;
                align-items: center;
                gap: 8px;
                padding: 4px 8px;
                border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border));
                border-radius: 4px;
                background: var(--vscode-editorWidget-background);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
            }
            .webview-find-input-wrap {
                display: inline-flex;
                align-items: center;
                min-width: 240px;
                max-width: 280px;
                border: 1px solid var(--vscode-focusBorder, #0078d4);
                border-radius: 4px;
                background: var(--vscode-input-background);
                overflow: hidden;
            }
            .webview-find input {
                min-width: 0;
                width: 100%;
                padding: 3px 6px;
                border: none;
                outline: none;
                background: transparent;
                color: var(--vscode-input-foreground);
            }
            .webview-find-inline-tools {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding-right: 8px;
                white-space: nowrap;
            }
            .webview-find .toggle-btn {
                border: none;
                background: transparent;
                color: var(--vscode-descriptionForeground);
                padding: 0;
                border-radius: 0;
                cursor: pointer;
                font-size: 0.95em;
                line-height: 1;
            }
            .webview-find .toggle-btn.active {
                color: var(--vscode-foreground);
            }
            .webview-find .toggle-btn[aria-disabled="true"] {
                color: var(--vscode-descriptionForeground);
                opacity: 0.85;
                cursor: default;
            }
            .webview-find .result-count {
                color: var(--vscode-foreground);
                min-width: 70px;
                text-align: left;
                font-size: 0.92em;
            }
            .toggle-word-label {
                position: relative;
                display: inline-block;
                line-height: 1;
                padding-bottom: 1px;
            }
            .toggle-word-label::after {
                content: '';
                position: absolute;
                left: -1px;
                right: -1px;
                bottom: 0;
                border-bottom: 1px solid currentColor;
                border-left: 1px solid currentColor;
                border-right: 1px solid currentColor;
                height: 2px;
                border-bottom-left-radius: 1px;
                border-bottom-right-radius: 1px;
                opacity: 0.95;
            }
            .webview-find .result-count.warning {
                color: var(--vscode-editorWarning-foreground, #d18616);
            }
            .webview-find .nav-btn {
                border: none;
                background: transparent;
                color: var(--vscode-foreground);
                padding: 0 2px;
                cursor: pointer;
                font-size: 15px;
                line-height: 1;
            }
            .webview-find .nav-btn:disabled {
                color: var(--vscode-disabledForeground);
                cursor: default;
            }
            .webview-find .close-btn {
                border: none;
                background: transparent;
                color: var(--vscode-descriptionForeground);
                padding: 0 2px;
                cursor: pointer;
                font-size: 14px;
                line-height: 1;
            }
            mark.webview-find-hit {
                background: var(--vscode-editor-findMatchBackground);
                color: var(--vscode-editor-findMatchForeground);
                border: 1px solid var(--vscode-editor-findMatchBorder, transparent);
                border-radius: 2px;
                padding: 0;
            }
            mark.webview-find-hit.active {
                background: var(--vscode-editor-findMatchHighlightBackground);
                border-color: var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder));
            }
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

            let collapsedByToolbar = false;
            let initialRenderSnapshot = null;

            const pendingCopyButtons = {};

            function setCopyButtonFeedback(btn, success) {
                if (!btn) return;
                const originalText = btn.dataset.originalText || 'copy';
                btn.classList.remove('copy-pending', 'copy-ok', 'copy-fail');
                btn.classList.add(success ? 'copy-ok' : 'copy-fail');
                btn.textContent = success ? '${t('copy_key_success')}' : '${t('copy_key_failed')}';
                setTimeout(() => {
                    btn.classList.remove('copy-pending', 'copy-ok', 'copy-fail');
                    btn.textContent = originalText;
                }, 900);
            }

            function copyKeyName(btnEl) {
                if (!btnEl) return;
                const text = decodeURIComponent(btnEl.dataset.keyText || '');
                if (!text) return;
                const requestId = 'copy-' + Date.now() + '-' + Math.random().toString(16).slice(2);
                if (btnEl) {
                    btnEl.dataset.originalText = btnEl.dataset.originalText || btnEl.textContent || 'copy';
                    btnEl.classList.remove('copy-ok', 'copy-fail');
                    btnEl.classList.add('copy-pending');
                    btnEl.textContent = '...';
                    pendingCopyButtons[requestId] = btnEl;
                }
                vscode.postMessage({
                    command: 'copyKey',
                    keyText: text,
                    requestId,
                });
            }

            function captureInitialTreeState() {
                const details = Array.from(document.querySelectorAll('details')).map(el => ({
                    el,
                    isOpen: el.hasAttribute('open'),
                }));
                const panes = Array.from(document.querySelectorAll('.full-structure-pane')).map(el => ({
                    el,
                    display: window.getComputedStyle(el).display,
                }));
                const arrows = Array.from(document.querySelectorAll('.truncated-toggle .arrow')).map(el => ({
                    el,
                    text: el.textContent || '▸',
                }));
                initialRenderSnapshot = { details, panes, arrows };
            }

            function updateCollapseButtonState(isCollapsed) {
                const btn = document.getElementById('collapse-toggle-btn');
                if (!btn) return;
                const collapseText = btn.dataset.collapseText || '${t('btn_collapse_all')}';
                const expandText = btn.dataset.expandText || '${t('btn_expand_all')}';
                const text = isCollapsed ? expandText : collapseText;
                const icon = btn.querySelector('.codicon-symbol');
                const label = btn.querySelector('.btn-label');
                if (icon) icon.textContent = isCollapsed ? '▾' : '▸';
                if (label) label.textContent = text;
                btn.title = text;
            }

            function collapseAllTreeNodes() {
                // 折叠原始 JSON 树 (details/summary)
                document.querySelectorAll('details[open]').forEach(el => {
                    el.removeAttribute('open');
                });

                // 折叠截断面板及其内部子面板
                document.querySelectorAll('.full-structure-pane').forEach(el => {
                    el.style.display = 'none';
                });

                // 重置所有展开箭头
                document.querySelectorAll('.truncated-toggle .arrow').forEach(el => {
                    el.textContent = '▸';
                });

                // 放大镜预览不参与折叠/展开恢复，统一关闭
                document.querySelectorAll('.data-preview').forEach(el => {
                    el.style.display = 'none';
                });
            }

            function restoreInitialTreeState() {
                if (!initialRenderSnapshot) return;
                (initialRenderSnapshot.details || []).forEach(item => {
                    if (!item?.el) return;
                    if (item.isOpen) item.el.setAttribute('open', '');
                    else item.el.removeAttribute('open');
                });
                (initialRenderSnapshot.panes || []).forEach(item => {
                    if (!item?.el) return;
                    item.el.style.display = item.display || 'none';
                });
                (initialRenderSnapshot.arrows || []).forEach(item => {
                    if (!item?.el) return;
                    item.el.textContent = item.text || '▸';
                });

                // 恢复树结构时，不自动恢复放大镜预览
                document.querySelectorAll('.data-preview').forEach(el => {
                    el.style.display = 'none';
                });
            }

            function toggleCollapseAllState() {
                if (!collapsedByToolbar) {
                    collapseAllTreeNodes();
                    collapsedByToolbar = true;
                } else {
                    restoreInitialTreeState();
                    collapsedByToolbar = false;
                }
                updateCollapseButtonState(collapsedByToolbar);
            }

            function setupWebviewFind() {
                const box = document.getElementById('webview-find-box');
                const input = document.getElementById('webview-find-input');
                const count = document.getElementById('webview-find-count');
                const prevBtn = document.getElementById('webview-find-prev');
                const nextBtn = document.getElementById('webview-find-next');
                const closeBtn = document.getElementById('webview-find-close');
                const caseBtn = document.getElementById('webview-find-case');
                const wholeBtn = document.getElementById('webview-find-word');
                const root = document.getElementById('webview-content-root');
                if (!box || !input || !count || !prevBtn || !nextBtn || !closeBtn || !caseBtn || !wholeBtn || !root) return;

                const state = {
                    markGroups: [],
                    current: -1,
                    history: [],
                    historyCursor: -1,
                    matchCase: false,
                    wholeWord: false,
                    hasSearched: false,
                };

                // 字面量搜索仍用 RegExp 实现；必须把 [ ] ^ $ 等全部转义，否则 [2000] 会变成“字符类”匹配单字
                const escapeRegExp = (text) => {
                    const s = String(text);
                    const z = String.fromCharCode(92);
                    return s
                        .split(z).join(z + z)
                        .split('[').join(z + '[')
                        .split(']').join(z + ']')
                        .split('^').join(z + '^')
                        .split('$').join(z + '$')
                        .split('.').join(z + '.')
                        .split('|').join(z + '|')
                        .split('?').join(z + '?')
                        .split('*').join(z + '*')
                        .split('+').join(z + '+')
                        .split('(').join(z + '(')
                        .split(')').join(z + ')')
                        .split('{').join(z + '{')
                        .split('}').join(z + '}');
                };

                const saveHistory = (term) => {
                    const value = String(term || '').trim();
                    if (!value) return;
                    state.history = [value, ...state.history.filter(item => item !== value)].slice(0, 20);
                    state.historyCursor = -1;
                };

                const clearHighlights = () => {
                    root.querySelectorAll('mark.webview-find-hit').forEach(mark => {
                        const parent = mark.parentNode;
                        if (!parent) return;
                        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
                        parent.normalize();
                    });
                    state.markGroups = [];
                    state.current = -1;
                };

                const buildTextSegments = () => {
                    const segments = [];
                    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                        acceptNode(node) {
                            if (!node || node.nodeValue === null) return NodeFilter.FILTER_REJECT;
                            const parent = node.parentElement;
                            if (!parent) return NodeFilter.FILTER_REJECT;
                            if (parent.closest('.webview-find')) return NodeFilter.FILTER_REJECT;
                            if (parent.closest('script,style,mark')) return NodeFilter.FILTER_REJECT;
                            return NodeFilter.FILTER_ACCEPT;
                        }
                    });
                    let node;
                    while ((node = walker.nextNode())) {
                        segments.push({ node, text: String(node.nodeValue || '') });
                    }
                    return segments;
                };

                const collectGlobalMatchRanges = (term, segments) => {
                    const needle = String(term || '');
                    if (!needle.length) return [];
                    let flat = '';
                    segments.forEach(seg => { flat += seg.text; });
                    const ranges = [];
                    if (state.wholeWord) {
                        const pattern = '\\\\b' + escapeRegExp(needle) + '\\\\b';
                        const flags = state.matchCase ? 'g' : 'gi';
                        const regex = new RegExp(pattern, flags);
                        let m;
                        while ((m = regex.exec(flat)) !== null) {
                            ranges.push([m.index, m.index + m[0].length]);
                            if (m[0].length === 0) regex.lastIndex += 1;
                        }
                        return ranges;
                    }
                    const hay = state.matchCase ? flat : flat.toLowerCase();
                    const ndl = state.matchCase ? needle : needle.toLowerCase();
                    let pos = 0;
                    while (pos <= hay.length) {
                        const idx = hay.indexOf(ndl, pos);
                        if (idx < 0) break;
                        ranges.push([idx, idx + needle.length]);
                        pos = idx + needle.length;
                    }
                    return ranges;
                };

                const mapGlobalRangeToSegments = (segments, gs, ge) => {
                    const ops = [];
                    let offset = 0;
                    for (let si = 0; si < segments.length; si++) {
                        const len = segments[si].text.length;
                        const segStart = offset;
                        const segEnd = offset + len;
                        offset = segEnd;
                        if (ge <= segStart || gs >= segEnd) continue;
                        ops.push({
                            si,
                            start: Math.max(0, gs - segStart),
                            end: Math.min(len, ge - segStart),
                        });
                    }
                    return ops;
                };

                const applyHighlightsFromGlobal = (segments, globalRanges) => {
                    const occOps = [];
                    globalRanges.forEach(([gs, ge], occId) => {
                        mapGlobalRangeToSegments(segments, gs, ge).forEach(op => {
                            occOps.push({ occId, si: op.si, start: op.start, end: op.end });
                        });
                    });
                    occOps.sort((a, b) => (a.si === b.si ? b.start - a.start : b.si - a.si));
                    const groups = globalRanges.map(() => []);
                    occOps.forEach(op => {
                        const seg = segments[op.si];
                        if (!seg || !seg.node || !seg.node.parentNode) return;
                        let live = seg.node;
                        live.splitText(op.end);
                        const middle = live.splitText(op.start);
                        const mark = document.createElement('mark');
                        mark.className = 'webview-find-hit';
                        mark.setAttribute('data-find-occ', String(op.occId));
                        mark.textContent = middle.nodeValue || '';
                        middle.parentNode.replaceChild(mark, middle);
                        seg.node = live;
                        groups[op.occId].push(mark);
                    });
                    state.markGroups = groups.filter(g => g.length > 0);
                };

                const updateCounter = () => {
                    if (state.markGroups.length === 0) {
                        count.textContent = '${t('find_no_results')}';
                        const searchActive = state.hasSearched && String(input.value || '').trim().length > 0;
                        count.classList.toggle('warning', searchActive);
                        prevBtn.disabled = true;
                        nextBtn.disabled = true;
                        return;
                    }
                    count.classList.remove('warning');
                    prevBtn.disabled = false;
                    nextBtn.disabled = false;
                    count.textContent = String(state.current + 1) + '/' + String(state.markGroups.length);
                };

                const focusMatch = (index, scrollMode) => {
                    if (state.markGroups.length === 0) {
                        state.current = -1;
                        updateCounter();
                        return;
                    }
                    document.querySelectorAll('mark.webview-find-hit').forEach(m => m.classList.remove('active'));
                    state.current = (index + state.markGroups.length) % state.markGroups.length;
                    const group = state.markGroups[state.current] || [];
                    group.forEach(m => m.classList.add('active'));
                    const anchor = group[0];
                    if (anchor) {
                        anchor.scrollIntoView({ block: scrollMode || 'center', behavior: 'smooth' });
                    }
                    updateCounter();
                };

                const runSearch = (keepIndex) => {
                    const term = String(input.value || '');
                    const trimmed = term.trim();
                    const prevIndex = state.current;
                    state.hasSearched = trimmed.length > 0;
                    clearHighlights();
                    if (!trimmed) {
                        updateCounter();
                        return;
                    }
                    const segments = buildTextSegments();
                    const globalRanges = collectGlobalMatchRanges(trimmed, segments);
                    if (globalRanges.length === 0) {
                        updateCounter();
                        return;
                    }
                    applyHighlightsFromGlobal(segments, globalRanges);
                    if (keepIndex && prevIndex >= 0 && prevIndex < state.markGroups.length) {
                        focusMatch(prevIndex, 'nearest');
                    } else {
                        focusMatch(0, 'center');
                    }
                };

                const openFind = () => {
                    box.style.display = 'inline-flex';
                    input.focus();
                    input.select();
                };

                const closeFind = () => {
                    box.style.display = 'none';
                };

                const runFind = (forward) => {
                    const term = String(input.value || '').trim();
                    if (!term) return;
                    saveHistory(term);
                    if (state.markGroups.length === 0) {
                        runSearch(false);
                        return;
                    }
                    focusMatch(state.current + (forward ? 1 : -1), 'center');
                };

                prevBtn.addEventListener('click', () => runFind(false));
                nextBtn.addEventListener('click', () => runFind(true));

                closeBtn.addEventListener('click', () => {
                    clearHighlights();
                    state.hasSearched = false;
                    updateCounter();
                    closeFind();
                });

                caseBtn.addEventListener('click', () => {
                    state.matchCase = !state.matchCase;
                    caseBtn.classList.toggle('active', state.matchCase);
                    runSearch(false);
                });

                wholeBtn.addEventListener('click', () => {
                    state.wholeWord = !state.wholeWord;
                    wholeBtn.classList.toggle('active', state.wholeWord);
                    runSearch(false);
                });

                input.addEventListener('input', () => runSearch(false));

                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        saveHistory(input.value);
                        runFind(!e.shiftKey);
                        return;
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        closeFind();
                        return;
                    }
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        if (state.history.length === 0) return;
                        e.preventDefault();
                        if (state.historyCursor === -1) {
                            state.historyCursor = e.key === 'ArrowUp' ? 0 : state.history.length - 1;
                        } else {
                            const delta = e.key === 'ArrowUp' ? 1 : -1;
                            state.historyCursor = (state.historyCursor + delta + state.history.length) % state.history.length;
                        }
                        input.value = state.history[state.historyCursor] || '';
                        runSearch(false);
                    }
                });

                document.addEventListener('keydown', (e) => {
                    const isFind = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f';
                    if (isFind) {
                        e.preventDefault();
                        e.stopPropagation();
                        openFind();
                        return;
                    }
                    if (e.key === 'F3') {
                        e.preventDefault();
                        e.stopPropagation();
                        runFind(!e.shiftKey);
                    }
                }, true);

                window.addEventListener('message', event => {
                    const message = event.data || {};
                    if (message.command === 'showCustomFind') {
                        openFind();
                    }
                });

                updateCounter();
            }

            window.addEventListener('DOMContentLoaded', () => {
                captureInitialTreeState();
                updateCollapseButtonState(false);
                normalizePreviewLayout(document);
                setupWebviewFind();
            });

            function displayPathToPathArray(displayPath) {
                let p = displayPath || '';
                if (!p || p === '$') return [];
                if (p.startsWith('$.')) p = p.slice(2);
                else if (p.startsWith('$')) p = p.slice(1);

                const tokens = [];
                const re = /([^.\\[\\]]+)|\\[(\\d+)\\]/g;
                let m;
                while ((m = re.exec(p)) !== null) {
                    if (m[1] !== undefined) tokens.push(m[1]);
                    else if (m[2] !== undefined) tokens.push(m[2]);
                }
                return tokens;
            }

            function normalizePreviewLayout(root) {
                const scope = root || document;
                scope.querySelectorAll('.node-inline .data-preview').forEach(preview => {
                    const row = preview.closest('.node-inline');
                    if (!row) return;
                    const host = row.closest('li') || row.closest('.indexed-node');
                    if (!host) return;
                    if (preview.parentElement === host) return;
                    host.appendChild(preview);
                });
            }

            function formatIndexedKeyLabel(parentNodeType, key) {
                if (parentNodeType === 'array') return '[' + key + ']';
                return '"' + key + '"';
            }

            function renderIndexedValue(c) {
                const type = c.node_type ?? '';
                if (type === 'tensor' || type === 'tensor_ref') {
                    const dtype = c.dtype || '?';
                    const shape = Array.isArray(c.shape) ? c.shape : [];
                    const shapeStr = shape.length === 0
                        ? '<span style="color:var(--vscode-textLink-foreground);">[Scalar]</span>'
                        : '[ ' + shape.join('×') + ' ]';
                    const detailStr = type === 'tensor' ? (shapeStr + ' (' + dtype + ')') : '${t('tag_ref')}';
                    let infoClass = 'tensor-info';
                    if (type === 'tensor_ref') infoClass += ' ref';
                    return '<span class="' + infoClass + '">' + detailStr + '</span>';
                }
                if (type === 'object' || type === 'array') {
                    // 索引树直接复用后端 summary，其中已包含元素总数 (例如 Dict {5} / List [128])
                    return '<span>' + String(c.summary ?? (type === 'object' ? 'Dict {}' : 'List []')) + '</span>';
                }
                return '<span>' + String(c.summary ?? '') + '</span>';
            }

            function renderIndexedChildren(container, children, append, parentNodeType) {
                let tree = container.querySelector(':scope > ul.indexed-tree');
                if (!append || !tree) {
                    container.innerHTML = '';
                    tree = document.createElement('ul');
                    tree.className = 'indexed-tree';
                    container.appendChild(tree);
                }

                (children || []).forEach(c => {
                    const key = c.key ?? '';
                    const rowId = 'idx-node-' + String(c.id ?? key).replace(/[^a-zA-Z0-9_-]/g, '-');
                    const childContainerId = rowId + '-children';
                    const keyLabel = formatIndexedKeyLabel(parentNodeType, key);
                    const keyPrefix = '<span class="key-name">' + keyLabel + ': </span>';
                    const valueHtml = renderIndexedValue(c);

                    let expandHtml = '';
                    if (c.is_expandable) {
                        expandHtml =
                            '<span class="truncated-toggle" id="' + rowId + '-toggle" onclick="toggleIndexedNode(\\'' + childContainerId + '\\', \\'' + rowId + '-toggle\\', \\'' + encodeURIComponent(c.display_path || '') + '\\')">'
                            + '<span class="arrow">▸</span>'
                            + '</span>';
                    } else {
                        expandHtml = '<span class="truncated-toggle"><span class="arrow"></span></span>';
                    }

                    let inspectHtml = '';
                    if ((c.node_type ?? '') === 'tensor') {
                        const pathArray = displayPathToPathArray(c.display_path || '');
                        const safePath = encodeURIComponent(JSON.stringify(pathArray));
                        const inspectId = 'idx-inspect-' + String(c.id ?? key).replace(/[^a-zA-Z0-9_-]/g, '-');
                        inspectHtml =
                            '<span class="inspect-btn" title="${t('btn_inspect_title')}" onclick="toggleInspect(\\'' + safePath + '\\', \\'' + inspectId + '\\')">🔍</span>'
                            + '<div id="' + inspectId + '" class="data-preview" style="display:none;"></div>';
                    }

                    const li = document.createElement('li');
                    if (c.is_expandable) li.classList.add('has-toggle');
                    li.innerHTML =
                        '<div class="node-inline">'
                        + expandHtml
                        + keyPrefix
                        + ' <span class="node-value">' + valueHtml + '</span>'
                        + inspectHtml
                        + '</div>'
                        + '<div id="' + childContainerId + '" class="full-structure-pane indexed-children" style="display:none; margin-left:20px;"></div>';
                    tree.appendChild(li);
                });
                normalizePreviewLayout(container);
            }

            function requestIndexedPanePage(containerId, indexDbPath, sourceFilePath, displayPath, offset, limit) {
                const container = document.getElementById(containerId);
                if (!container) return;
                if (container.dataset.loading === '1') return;
                container.dataset.loading = '1';
                vscode.postMessage({
                    command: 'loadIndexedTruncatedPane',
                    indexDbPath,
                    sourceFilePath,
                    displayPath,
                    containerId,
                    offset,
                    limit
                });
            }

            function setupIndexedPaneScroll(container, containerId, indexDbPath, sourceFilePath, displayPath) {
                if (container.dataset.scrollBound === '1') return;
                container.dataset.scrollBound = '1';
                container.addEventListener('scroll', () => {
                    const total = Number(container.dataset.total || '0');
                    const offset = Number(container.dataset.offset || '0');
                    const limit = Number(container.dataset.limit || '200');
                    if (offset >= total) return;
                    const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
                    if (nearBottom) {
                        requestIndexedPanePage(containerId, indexDbPath, sourceFilePath, displayPath, offset, limit);
                    }
                });
            }

            function toggleFullStructurePanel(containerId, toggleId, indexDbPath, sourceFilePath, displayPath, startOffset, endOffsetExclusive) {
                const container = document.getElementById(containerId);
                const toggle = document.getElementById(toggleId);
                if (!container || !toggle) return;

                const arrow = toggle.querySelector('.arrow');
                const isOpen = container.style.display === 'block';

                if (isOpen) {
                    container.style.display = 'none';
                    if (arrow) arrow.textContent = '▸';
                    return;
                }

                container.style.display = 'block';
                if (arrow) arrow.textContent = '▾';

                if (container.dataset.inited === '1') return;

                container.dataset.inited = '1';
                container.dataset.offset = '0';
                container.dataset.limit = '200';
                container.dataset.total = '0';
                container.dataset.indexDbPath = indexDbPath;
                container.dataset.sourceFilePath = sourceFilePath;
                container.dataset.displayPath = displayPath;
                const start = Number(startOffset || 0);
                const endRaw = endOffsetExclusive === undefined || endOffsetExclusive === null || endOffsetExclusive === '' ? '' : String(endOffsetExclusive);
                container.dataset.startOffset = String(Number.isFinite(start) && start > 0 ? start : 0);
                container.dataset.endOffset = endRaw;
                container.innerHTML = '<div class="hint">${t('full_json_preview_loading')}</div>';
                const firstOffset = Number(container.dataset.startOffset || '0');
                requestIndexedPanePage(containerId, indexDbPath, sourceFilePath, displayPath, firstOffset, 200);
                setupIndexedPaneScroll(container, containerId, indexDbPath, sourceFilePath, displayPath);
            }

            function toggleIndexedNode(containerId, toggleId, encodedDisplayPath) {
                const container = document.getElementById(containerId);
                const toggle = document.getElementById(toggleId);
                if (!container || !toggle) return;
                const parentPane = container.closest('.full-structure-pane');
                if (!parentPane) return;

                const indexDbPath = parentPane.dataset.indexDbPath || '';
                const sourceFilePath = parentPane.dataset.sourceFilePath || '';
                const displayPath = decodeURIComponent(encodedDisplayPath || '');
                const arrow = toggle.querySelector('.arrow');
                const isOpen = container.style.display === 'block';

                if (isOpen) {
                    container.style.display = 'none';
                    if (arrow) arrow.textContent = '▸';
                    return;
                }

                container.style.display = 'block';
                if (arrow) arrow.textContent = '▾';

                if (container.dataset.inited === '1') return;

                container.dataset.inited = '1';
                container.dataset.offset = '0';
                container.dataset.limit = '200';
                container.dataset.total = '0';
                container.dataset.indexDbPath = indexDbPath;
                container.dataset.sourceFilePath = sourceFilePath;
                container.dataset.displayPath = displayPath;
                container.dataset.startOffset = '0';
                container.dataset.endOffset = '';
                container.innerHTML = '<div class="hint">${t('indexed_node_loading')}</div>';
                requestIndexedPanePage(containerId, indexDbPath, sourceFilePath, displayPath, 0, 200);
                setupIndexedPaneScroll(container, containerId, indexDbPath, sourceFilePath, displayPath);
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
                        const preview = String(message.data.preview ?? '').trimStart();
                        
                        // 渲染统计信息
                        const statsHtml = '<div class="stats-row">'
                            + '<span class="stats-item">Min: <strong>' + stats.min + '</strong></span>'
                            + '<span class="stats-item">Max: <strong>' + stats.max + '</strong></span>'
                            + '<span class="stats-item">Mean: <strong>' + stats.mean + '</strong></span>'
                            + '<span class="stats-item">Std: <strong>' + stats.std + '</strong></span>'
                            + '</div>';
                        
                        // 渲染多维数组内容
                        container.innerHTML = statsHtml + '<pre class="tensor-preview-text">' + preview + '</pre>';
                    }
                }

                if (message.command === 'indexedTruncatedPaneData') {
                    const payload = message.payload || {};
                    const container = document.getElementById(payload.containerId);
                    if (!container) return;

                    container.dataset.loading = '0';
                    const result = payload.result || {};
                    if (result.error) {
                        container.innerHTML = '<div style="color:var(--vscode-errorForeground)">' + result.error + '</div>';
                        return;
                    }
                    const children = result.children || [];
                    const total = Number(result.total_children || 0);
                    const currentOffset = Number(payload.offset || 0);
                    const limit = Number(payload.limit || 200);
                    const startOffset = Number(container.dataset.startOffset || '0');
                    const endOffsetRaw = container.dataset.endOffset || '';
                    const endOffsetExclusive = endOffsetRaw !== '' ? Number(endOffsetRaw) : null;
                    const append = currentOffset > startOffset;
                    container.querySelectorAll('.load-more-hint').forEach(el => el.remove());
                    if (result.current && result.current.node_type) {
                        container.dataset.parentNodeType = String(result.current.node_type);
                    }
                    const parentNodeType = container.dataset.parentNodeType || 'object';
                    renderIndexedChildren(container, children, append, parentNodeType);
                    const indexDbPath = container.dataset.indexDbPath || '';
                    const sourceFilePath = container.dataset.sourceFilePath || '';
                    const displayPath = container.dataset.displayPath || '';
                    setupIndexedPaneScroll(container, payload.containerId, indexDbPath, sourceFilePath, displayPath);
                    const effectiveTotal = endOffsetExclusive !== null ? Math.min(total, endOffsetExclusive) : total;
                    const nextOffset = currentOffset + children.length;
                    container.dataset.total = String(effectiveTotal);
                    container.dataset.offset = String(nextOffset);
                    container.dataset.limit = String(limit);
                    if (nextOffset < effectiveTotal) {
                        container.innerHTML += '<div class="load-more-hint" style="padding:6px 0; color:var(--vscode-descriptionForeground);">...滚动加载更多...</div>';
                    }
                }

                if (message.command === 'copyKeyResult') {
                    const requestId = message.requestId || '';
                    const btn = pendingCopyButtons[requestId];
                    if (btn) {
                        setCopyButtonFeedback(btn, !!message.success);
                        delete pendingCopyButtons[requestId];
                    }
                }
            });
        </script>
    </head>
    <body>
        <div id="webview-find-box" class="webview-find">
            <div class="webview-find-input-wrap">
                <input id="webview-find-input" autocomplete="off" placeholder="${t('btn_find')}" />
                <div class="webview-find-inline-tools">
                    <button id="webview-find-case" type="button" class="toggle-btn" title="${t('find_match_case')}">Aa</button>
                    <button id="webview-find-word" type="button" class="toggle-btn" title="${t('find_whole_word')}"><span class="toggle-word-label">ab</span></button>
                </div>
            </div>
            <span id="webview-find-count" class="result-count">${t('find_no_results')}</span>
            <button id="webview-find-prev" type="button" class="nav-btn" aria-label="Previous match">↑</button>
            <button id="webview-find-next" type="button" class="nav-btn" aria-label="Next match">↓</button>
            <button id="webview-find-close" type="button" class="close-btn" aria-label="Close find">✕</button>
        </div>
        <h2>PyTorch Structure Viewer</h2>
        <div id="webview-content-root">${bodyContent}</div>
    </body>
    </html>`;
}

// 1. 修改参数类型：keyPath 改为 string[]，默认是空数组
export function generateJsonHtml(data: any, keyPath: string[] = [], fullStructurePath: string = '', fullStructureIndexPath: string = '', sourceFilePath: string = '', currentDisplayPath: string = '$'): string {
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
    let truncatedTotalCount: number | null = null;
    const parseTruncatedTotal = (text: string): number | null => {
        if (!text) return null;
        const m = text.match(/total\s+([0-9,]+)/i);
        if (!m) return null;
        const raw = (m[1] || '').replace(/,/g, '');
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    };
    const inlineKeyIntoDetailsSummary = (valueHtml: string, keyLabel: string): string => {
        const isDetails = /^\s*<details[\s>]/.test(valueHtml);
        if (!isDetails) return valueHtml;
        const encodedKey = encodeURIComponent(keyLabel);
        return valueHtml.replace(
            '<summary>',
            `<summary><span class="node-key-chip">${keyLabel}</span><button class="copy-key-btn" data-key-text="${encodedKey}" title="Copy key" onclick="event.preventDefault(); event.stopPropagation(); copyKeyName(this)">copy</button><span class="node-sep">·</span>`
        );
    };

    if (Array.isArray(data)) {
        let listItems = '';
        const truncationMarkerIndex = data.findIndex(
            (item) => typeof item === 'string' && item.startsWith('__pth__truncated__') && item.endsWith('__pth__truncated__')
        );
        const truncationTotalFromMarker = truncationMarkerIndex >= 0
            ? parseTruncatedTotal(String(data[truncationMarkerIndex] || ''))
            : null;
        const trailingVisibleCount = truncationMarkerIndex >= 0
            ? (data.length - truncationMarkerIndex - 1)
            : 0;
        const mapToActualIndex = (renderIndex: number): number => {
            if (
                truncationMarkerIndex >= 0 &&
                truncationTotalFromMarker !== null &&
                renderIndex > truncationMarkerIndex
            ) {
                const trailingStart = truncationTotalFromMarker - trailingVisibleCount;
                return trailingStart + (renderIndex - truncationMarkerIndex - 1);
            }
            return renderIndex;
        };
        data.forEach((item, index) => {
            const actualIndex = mapToActualIndex(index);
            // === 核心修改：路径追加 (Push) ===
            // 创建新数组，避免污染父级 path
            const currentPath = [...keyPath, actualIndex.toString()]; 
            const childDisplayPath = currentDisplayPath === '$' ? `[${actualIndex}]` : `${currentDisplayPath}[${actualIndex}]`;
            const value = generateJsonHtml(item, currentPath, fullStructurePath, fullStructureIndexPath, sourceFilePath, childDisplayPath)
            
            // 如果 item是string 并且 以__pth__truncated__ 开头以及结尾
            if (typeof item === 'string' && item.startsWith('__pth__truncated__') && item.endsWith('__pth__truncated__')) {
                const parsedTotal = parseTruncatedTotal(item);
                if (parsedTotal !== null) {
                    truncatedTotalCount = parsedTotal;
                }
                const truncatedStartOffset = actualIndex;
                const truncatedEndOffsetExclusive = parsedTotal !== null
                    ? Math.max(truncatedStartOffset, parsedTotal - trailingVisibleCount)
                    : '';
                if (fullStructureIndexPath) {
                    const safePath = encodeURIComponent(JSON.stringify(currentPath));
                    const containerId = `full-structure-${safePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
                    const toggleId = `full-structure-toggle-${safePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
                    listItems += `
                        <li class="truncated-item">
                            <div class="truncated-toggle" id="${toggleId}" onclick="toggleFullStructurePanel('${containerId}', '${toggleId}', '${encodeURIComponent(fullStructureIndexPath)}', '${encodeURIComponent(sourceFilePath)}', '${encodeURIComponent(currentDisplayPath)}', '${truncatedStartOffset}', '${truncatedEndOffsetExclusive}')">
                                <span class="arrow">▸</span>
                                <span>[${actualIndex}]: ${value}</span>
                            </div>
                            <div class="full-structure-pane" id="${containerId}">
                                <div class="hint">${t('full_json_hint_generated')}</div>
                                ${fullJsonRevealButtonHtml(fullStructurePath)}
                            </div>
                        </li>
                    `;
                } else {
                    listItems += `<li class="truncated-item"><span>[${actualIndex}]: </span>${value}</li>`;
                }
            } else {
                const keyLabel = `[${actualIndex}]`;
                if (/^\s*<details[\s>]/.test(value)) {
                    listItems += `<li class="has-details">${inlineKeyIntoDetailsSummary(value, keyLabel)}</li>`;
                } else {
                    listItems += `<li><div class="node-inline"><span class="node-key-chip">${keyLabel}</span> <span class="node-value">${value}</span></div></li>`;
                }
            }
            
        });
        if (listItems) { childrenHtml = `<ul>${listItems}</ul>`; hasChildren = true; }
    } else if (data.__pth_overview_pth__){
        // 包含 __pth_overview_pth__ 这个key
        hasChildren = false;
    } else if (typeof data === 'object' && data !== null) {
        let listItems = '';
        const objectKeys = Object.keys(data).filter(k => !['_type', 'dtype', 'shape', 'location'].includes(k));
        const dictMarkerIndex = objectKeys.findIndex(
            k => k.startsWith('__pth__truncated__') && k.endsWith('__pth__truncated__')
        );
        const dictTotalFromMarker = dictMarkerIndex >= 0
            ? parseTruncatedTotal(typeof data[objectKeys[dictMarkerIndex]] === 'string' ? data[objectKeys[dictMarkerIndex]] : objectKeys[dictMarkerIndex])
            : null;
        const dictTrailingVisibleCount = dictMarkerIndex >= 0 ? (objectKeys.length - dictMarkerIndex - 1) : 0;

        for (const key of objectKeys) {
            // === 核心修改：路径追加 (Push) ===
            const currentPath = [...keyPath, key];
            const childDisplayPath = currentDisplayPath === '$' ? key : `${currentDisplayPath}.${key}`;
            const value = generateJsonHtml(data[key], currentPath, fullStructurePath, fullStructureIndexPath, sourceFilePath, childDisplayPath)

            // 对 __pth__truncated__ 开头以及结尾的 key
            if (key.startsWith('__pth__truncated__') && key.endsWith('__pth__truncated__')) {
                if (typeof data[key] === 'string') {
                    const parsedTotal = parseTruncatedTotal(data[key]);
                    if (parsedTotal !== null) {
                        truncatedTotalCount = parsedTotal;
                    }
                } else {
                    const parsedTotal = parseTruncatedTotal(key);
                    if (parsedTotal !== null) {
                        truncatedTotalCount = parsedTotal;
                    }
                }
                if (fullStructureIndexPath) {
                    const safePath = encodeURIComponent(JSON.stringify(currentPath));
                    const containerId = `full-structure-${safePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
                    const toggleId = `full-structure-toggle-${safePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
                    const dictTruncatedStartOffset = dictMarkerIndex >= 0 ? dictMarkerIndex : 0;
                    const dictTruncatedEndOffsetExclusive = dictTotalFromMarker !== null
                        ? Math.max(dictTruncatedStartOffset, dictTotalFromMarker - dictTrailingVisibleCount)
                        : '';
                    listItems += `
                        <li class="truncated-item">
                            <div class="truncated-toggle" id="${toggleId}" onclick="toggleFullStructurePanel('${containerId}', '${toggleId}', '${encodeURIComponent(fullStructureIndexPath)}', '${encodeURIComponent(sourceFilePath)}', '${encodeURIComponent(currentDisplayPath)}', '${dictTruncatedStartOffset}', '${dictTruncatedEndOffsetExclusive}')">
                                <span class="arrow">▸</span>
                                <span>"${key}": ${value}</span>
                            </div>
                            <div class="full-structure-pane" id="${containerId}">
                                <div class="hint">${t('full_json_hint_generated')}</div>
                                ${fullJsonRevealButtonHtml(fullStructurePath)}
                            </div>
                        </li>
                    `;
                } else {
                    listItems += `<li class="truncated-item"><span">"${key}": </span>${value}</li>`;
                }
            } else {
                const keyLabel = `"${key}"`;
                if (/^\s*<details[\s>]/.test(value)) {
                    listItems += `<li class="has-details">${inlineKeyIntoDetailsSummary(value, keyLabel)}</li>`;
                } else {
                    listItems += `<li><div class="node-inline"><span class="node-key-chip">${keyLabel}</span> <span class="node-value">${value}</span></div></li>`;
                }
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
        const summary = Array.isArray(data)
            ? `List [${truncatedTotalCount ?? data.length}]`
            : `Dict {${truncatedTotalCount ?? Object.keys(data).length}}`;
        return `<details open><summary>${summary}</summary>${childrenHtml}</details>`;
    } else {
        // === 修复开始：针对空对象/空数组的显示优化 ===
        // 如果是对象且不为空 (null)，说明它是空字典或空列表
        if (typeof data === 'object' && data !== null) {
            // 使用灰色斜体显示，提示用户这是空的
            const emptyStyle = 'color:var(--vscode-descriptionForeground); font-style:italic;';
            
            if (Array.isArray(data)) {
                 return `<span style="${emptyStyle}">List [0] (Empty)</span>`;
            } else {
                 return `<span style="${emptyStyle}">Dict {0} (Empty)</span>`;
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