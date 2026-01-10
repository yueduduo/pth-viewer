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
    private isProcessingQueue: boolean = false;
    
    // 1. 维护当前使用的 Python 解释器路径
    private currentPythonPath: string | null = null;
    
    // 2. 环境切换的挂起状态
    private pendingPythonPath: string | null = null;

    // 3. 请求队列
    private requestQueue: QueueTask[] = [];

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

        // 如果当前正在处理队列，不要立即杀死进程，而是挂起切换请求
        if (this.isProcessingQueue || this.requestQueue.length > 0) {
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
        this.requestQueue = [];

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
                this.requestQueue = [];

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

        const filePath = payload.file_path || ""; // 这里对大文件的safetensor 是否进行 全局加载 没有作处理，因为safetensor其实加载飞快
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
            // 1. 【队列优化】使用 resourceKey 检查队列
            // 不管是 Global 还是 Local 模式，只要是针对同一个文件，
            // 此时如果队列里有 "Release" 任务，说明用户想重新load这个文件，那就取消释放！
            const releaseTaskIndex = this.requestQueue.findIndex(t => t.type === 'release' && t.fileKey === resourceKey);
            if (releaseTaskIndex !== -1) {
                console.log(`[Manager] Optimization: Cancelled pending release for ${path.basename(filePath)}`);
                // 从队列中移除该 release 任务
                this.requestQueue.splice(releaseTaskIndex, 1);
            }

            // 2. 【Promise 复用】使用包含 force_local 的 requestKey 进行检查
            // 只有 路径 和 模式 都完全一样，才直接复用
            if (this.loadingPromises.has(requestKey)) {
                console.log(`[Manager] Optimization: Join existing load for ${path.basename(filePath)} (Mode: ${payload.force_local})`);
                return this.loadingPromises.get(requestKey);
            }
        }

         // ---------------------------------------------------------
        // 场景 B: 收到 Release 请求 (关闭文件)
        // ---------------------------------------------------------
        if (endpoint === '/release') {
            // 如果当前文件正在加载中 (Promise 还没 resolve)
            // 我们不能简单地不发送 release，因为如果用户真的关了，还是得释放
            // 但放入队列是安全的，配合上面的 "Load 逻辑"，如果用户秒开，这个 release 会被上面的逻辑删掉
        }

        // ---------------------------------------------------------
        // 构造任务、入队、触发队列处理
        // ---------------------------------------------------------
        const taskPromise = new Promise((resolve, reject) => {
            const taskObj: QueueTask = {
                type: endpoint === '/load' ? 'load' : (endpoint === '/release' ? 'release' : 'other'),
                // 注意：队列任务的 fileKey 我们依然使用 resourceKey，
                // 这样未来的 Release 请求可以找到并匹配它（虽然后面 Release 逻辑目前比较简单）
                fileKey: resourceKey, 
                run: async () => {
                    try {
                        console.log(`[Manager] Processing ${endpoint} for ${path.basename(filePath)} using Python: ${this.currentPythonPath}`);
                        const port = await this.ensureServerStarted();
                        const result = await this.doHttpRequest(port, endpoint, payload);
                        resolve(result);
                    } catch (error) {
                        reject(error);
                    } finally {
                        // 任务结束，如果是 load，从 loadingPromises 移除
                        // 必须移除对应的 requestKey
                        if (endpoint === '/load') {
                            this.loadingPromises.delete(requestKey);
                        }
                    }
                }
            };

            this.requestQueue.push(taskObj);
            this.processQueue();
        });

        // 如果是 Load 任务，记录到 Map 中供后续复用 (使用 requestKey)
        if (endpoint === '/load') {
            this.loadingPromises.set(requestKey, taskPromise);
        }


        return taskPromise;
    }

    /**
     * 队列处理器 (核心逻辑：串行执行 + 阻塞环境切换)
     */
    private async processQueue() {
        if (this.isProcessingQueue) return; // 已经在跑了
        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const task = this.requestQueue.shift(); // 取出第一个任务
            if (task) {
                try {
                    await task.run(); // 等待任务完成
                } catch (e) {
                    console.error("[Manager] Task failed:", e);
                }
            }
        }
        this.isProcessingQueue = false;

        // 队列处理完了，检查是否有挂起的时间切换请求
        if (this.pendingPythonPath) {
            const nextPath = this.pendingPythonPath;
            this.pendingPythonPath = null; // 立即置空，防止递归逻辑错误
            await this.restartServer(nextPath);
        }
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
        return path.normalize(filePath).toLowerCase(); // Windows 不区分大小写
    }
}