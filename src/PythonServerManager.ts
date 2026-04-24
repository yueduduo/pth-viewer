import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import { getPythonInterpreterPath } from './pythonApi';

// 定义队列任务类型
// ===  定义更丰富的队列任务接口 ===
interface QueueTask {
    type: 'load' | 'release' | 'other';
    fileKey: string; // 用于识别是针对哪个文件的操作
    run: () => Promise<any>;
}

export class PythonServerManager {
    private static instance: PythonServerManager;
    private serverProcess: cp.ChildProcess | null = null;
    private port: number | null = null;
    private context: vscode.ExtensionContext | null = null;
    
    // 状态标志
    private isStarting: boolean = false;
    
    // 1. 维护当前使用的 Python 解释器路径
    private currentPythonPath: string | null = null;
    
    // 2. 环境切换的挂起状态
    private pendingPythonPath: string | null = null;

    // 3. 每个文件独立的任务队列尾指针
    private fileQueueTails: Map<string, Promise<void>> = new Map();
    // 已入队(含等待中+执行中)任务数，用于环境切换阻塞判断
    private scheduledTaskCount: number = 0;

    // 记录正在进行的 Load 任务 (Promise 复用) 
    // Key: filePath, Value: 该load任务的 Promise
    private loadingPromises: Map<string, Promise<any>> = new Map();

    private constructor() {}

    static getInstance(): PythonServerManager {
        if (!PythonServerManager.instance) {
            PythonServerManager.instance = new PythonServerManager();
        }
        return PythonServerManager.instance;
    }

    setContext(context: vscode.ExtensionContext) {
        this.context = context;
    }

    // 公开获取当前 Python 路径的方法，供 UI 显示错误时使用
    public getInterpreterPath(): string {
        return this.currentPythonPath || "Unknown";
    }

    /**
     * 外部调用的入口：切换 Python 环境
     * @param newPath 新的 Python 解释器路径
     */
    public async changePythonInterpreter(newPath: string) {
        const normalizedNew = path.normalize(newPath);
        const normalizedCurrent = this.currentPythonPath ? path.normalize(this.currentPythonPath) : null;

        if (normalizedNew === normalizedCurrent && this.serverProcess) {
            return;
        }

        console.log(`[Manager] Environment switched to: ${newPath}`);

        // 如果当前仍有任务在执行/排队，不要立即切换环境
        if (this.scheduledTaskCount > 0) {
            this.pendingPythonPath = newPath;
        } else {
            // 空闲状态，立即重启
            await this.restartServer(newPath);
        }
    }

    /**
     * 重启服务器逻辑 (惰性：只杀不启)
     */
    private async restartServer(pythonPath: string) {
        // 1. 关闭旧进程
        if (this.serverProcess) {
            console.log("[Manager] Stopping current server (Environment Changed)...");
            this.serverProcess.kill();
            this.serverProcess = null;
            this.port = null;
        }

        // 2. 更新路径变量
        this.currentPythonPath = pythonPath;
        this.pendingPythonPath = null;
        this.isStarting = false;
        // 清空所有状态
        this.loadingPromises.clear();
        this.fileQueueTails.clear();
        this.scheduledTaskCount = 0;

        // === 核心修改：移除 ensureServerStarted() ===
        // 只有当 PthEditorProvider 发起 sendRequest 时，才会去启动它
        // 实现了 "没有页面就不启动服务器" 的需求
        console.log(`[Manager] Server stopped. Ready to lazy-start with: ${pythonPath}`);
    }

    /**
     * 确保服务器已启动
     */
    private async ensureServerStarted(): Promise<number> {
        if (this.serverProcess && this.port) {
            return this.port;
        }

        if (this.isStarting) {
            return new Promise((resolve, reject) => {
                // 轮询等待+超时机制，防止无限轮询
                let count = 0;
                 const check = setInterval(() => {
                    if (this.port) {
                        clearInterval(check);
                        resolve(this.port);
                    }
                    count++;
                    if(count > 100) { // 10秒超时
                        clearInterval(check);
                        // 抛出特定的超时错误，供前端判断
                        reject(new Error("Timeout waiting for existing server start"));
                    }
                }, 100);
            });
        }

        this.isStarting = true;

        if (!this.currentPythonPath) {
            this.currentPythonPath = await getPythonInterpreterPath(undefined);
        }
        
        const scriptPath = path.join(this.context!.extensionPath, 'python_scripts', 'server.py');
        const pythonExe = this.currentPythonPath.replace(/^"|"$/g, '');  // 处理路径里的引号，spawn 不需要引号包裹可执行文件路径
        
        // 检查文件是否存在，如果不存在直接抛错 (不弹窗，由上层处理)
        if (!fs.existsSync(pythonExe) && pythonExe.toLowerCase() !== 'python') {
            this.isStarting = false;
            throw new Error(`Python Interpreter not found: ${pythonExe}`);
        }

        return new Promise((resolve, reject) => {
            let startupStderr = ""; // 累积启动时的错误日志

            const args = ['-X', 'utf8', '-u', scriptPath]; // -X utf8 : 强制 Python 使用 UTF-8 模式  -u : 强制标准输出不缓存 (Unbuffered)
           
            try {
                // 使用 spawn 的标准方式：exe, [args]
                this.serverProcess = cp.spawn(pythonExe, args, {
                    cwd: path.dirname(scriptPath),
                });
            } catch (spawnErr) {
                this.isStarting = false;
                reject(spawnErr);
                return;
            }

            this.serverProcess.stdout?.on('data', (data) => {
                const str = data.toString().trim();
                console.log("[Server Stdout]:", str);
                if (str.includes("SERVER_STARTED:")) {
                    const parts = str.split(':');
                    this.port = parseInt(parts[1]);
                    this.isStarting = false;
                    resolve(this.port);
                }
            });

            this.serverProcess.stderr?.on('data', (data) => {
                const str = data.toString();
                // 累积错误日志
                startupStderr += str; 
                console.error("[Server Stderr]:", str);
            });

            // 进程意外退出
            this.serverProcess.on('close', (code) => {
                console.log(`[Manager] Server exited with code ${code}`);
                this.serverProcess = null;
                this.port = null;
                this.isStarting = false;
                this.loadingPromises.clear(); // 进程挂了，所有 Promise 作废
                this.fileQueueTails.clear();
                this.scheduledTaskCount = 0;

                // 关键逻辑：如果 Promise 还没 resolve (端口没拿到) 就退出了
                // 说明是启动失败（缺库、语法错误等）
                if (code !== 0) {
                    const errorMsg = startupStderr || `Process exited with code ${code}`;
                    // === 核心修改：移除所有 vscode.window.showErrorMessage ===
                    // 直接 reject，把错误信息原样抛给 PthEditorProvider
                    reject(new Error(errorMsg)); 
                }
            });
            
            this.serverProcess.on('error', (err) => {
                this.isStarting = false;
                reject(err);
            });
        });
    }

    /**
     * API: 发送 POST 请求 (进入队列)
     */
    public async sendRequest(endpoint: string, payload: any): Promise<any> {

        const filePath = this.resolveQueueFilePath(endpoint, payload);
        // 1. 资源 Key: 仅用于识别文件 (用于 Release 匹配)
        const resourceKey = this.getFileKey(filePath); 
        
        // 2. 请求 Key: 用于 Promise 复用 (区分 force_local 参数)
        // 如果是 load 请求，必须把 force_local 加进去，否则会导致 自动模式/单文件模式 结果混淆
        let requestKey = resourceKey;
        if (endpoint === '/load') {
            const isForceLocal = payload.force_local ? 'true' : 'false';
            requestKey = `${resourceKey}::${isForceLocal}`;
        }

        // ---------------------------------------------------------
        // 场景 A: 收到 Load 请求 (打开文件)
        // ---------------------------------------------------------
        if (endpoint === '/load') {
            // Promise 复用：同一路径同一模式并发请求直接复用
            // 只有 路径 和 模式 都完全一样，才直接复用
            if (this.loadingPromises.has(requestKey)) {
                console.log(`[Manager] Optimization: Join existing load for ${path.basename(filePath)} (Mode: ${payload.force_local})`);
                return this.loadingPromises.get(requestKey);
            }
        }

        const taskPromise = this.enqueueFileTask(resourceKey, async () => {
            console.log(`[Manager] Processing ${endpoint} for ${path.basename(filePath)} using Python: ${this.currentPythonPath}`);
            const port = await this.ensureServerStarted();
            return this.doHttpRequest(port, endpoint, payload);
        }).finally(() => {
            if (endpoint === '/load') {
                this.loadingPromises.delete(requestKey);
            }
        });

        // 如果是 Load 任务，记录到 Map 中供后续复用 (使用 requestKey)
        if (endpoint === '/load') {
            this.loadingPromises.set(requestKey, taskPromise);
        }


        return taskPromise;
    }

    /**
     * 统一解析“该请求属于哪个文件队列”
     * 目标：首次加载/放大镜/动态树加载都落在同一 file queue。
     */
    private resolveQueueFilePath(endpoint: string, payload: any): string {
        if (!payload || typeof payload !== 'object') {
            return '__global__';
        }
        // sqlite 只读查询必须独立于文件加载队列，避免被 /load 卡住
        const sqliteEndpoints = new Set(['/tree_children_by_path', '/tree_children', '/tree_search', '/tree_node']);
        if (sqliteEndpoints.has(endpoint)) {
            const sqlitePath = payload.index_db_path;
            if (typeof sqlitePath === 'string' && sqlitePath.trim().length > 0) {
                return `__sqlite__:${sqlitePath}`;
            }
            return '__sqlite__';
        }
        const directPath =
            payload.file_path ||
            payload.source_file_path ||
            payload.filePath ||
            payload.sourceFilePath;
        if (typeof directPath === 'string' && directPath.trim().length > 0) {
            return directPath;
        }
        return '__global__';
    }

    /**
     * 每个文件独立队列：同文件串行，不同文件可并行
     */
    private enqueueFileTask<T>(fileKey: string, task: () => Promise<T>): Promise<T> {
        const previousTail = this.fileQueueTails.get(fileKey) ?? Promise.resolve();
        this.scheduledTaskCount++;

        const runPromise = previousTail
            .catch(() => undefined)
            .then(async () => {
                try {
                    return await task();
                } finally {
                    this.scheduledTaskCount--;
                    if (this.scheduledTaskCount === 0 && this.pendingPythonPath) {
                        const nextPath = this.pendingPythonPath;
                        this.pendingPythonPath = null;
                        await this.restartServer(nextPath);
                    }
                }
            });

        const newTail = runPromise.then(() => undefined, () => undefined);
        this.fileQueueTails.set(fileKey, newTail);
        newTail.finally(() => {
            if (this.fileQueueTails.get(fileKey) === newTail) {
                this.fileQueueTails.delete(fileKey);
            }
        });

        return runPromise;
    }

    /**
     * 底层 HTTP 请求实现
     */
    private doHttpRequest(port: number, endpoint: string, payload: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(payload);
            const options = {
                hostname: '127.0.0.1',
                port: port,
                path: endpoint,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            };

            const req = http.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        // 400/500 错误也算正常返回的 JSON Error，不由 catch 捕获
                        // 但这里我们抛错，让上层决定怎么显示
                        reject(new Error(`Server Error ${res.statusCode}: ${body}`));
                    } else {
                        try { 
                            resolve(JSON.parse(body)); 
                        } catch(e) { 
                            reject(e); 
                        }
                    }
                });
            });

            // 这里设置一个请求超时，区分 "连接不上" 和 "启动失败"
            req.on('timeout', () => {
                req.destroy();
                reject(new Error("Request Timeout"));
            });
            
            req.on('error', (e) => reject(e));
            req.write(data);
            req.end();
        });
    }

    /**
     * 辅助方法：标准化文件路径 (统一大小写和斜杠，作为 Map 的 Key)
     */
    private getFileKey(filePath: string): string {
        if (!filePath) return '__global__';
        return path.normalize(filePath).toLowerCase(); // Windows 不区分大小写
    }
}