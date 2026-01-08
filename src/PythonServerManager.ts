import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import { getPythonInterpreterPath } from './pythonApi';

// 定义队列任务类型
type QueueTask = () => Promise<any>;

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
        return new Promise((resolve, reject) => {
            // 1. 将实际请求封装为一个 Task 函数
            const task: QueueTask = async () => {
                try {
                    // 打印当前使用的解释器 (需求)
                    console.log(`[Manager] Processing Request using Python: ${this.currentPythonPath}`);
                    

                    const port = await this.ensureServerStarted();
                    const result = await this.doHttpRequest(port, endpoint, payload);
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            };
            // 2. 加入队列
            this.requestQueue.push(task);
            // 3. 触发队列处理
            this.processQueue();
        });
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
                    await task(); // 等待任务完成
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
}