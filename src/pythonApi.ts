import * as vscode from 'vscode';
import * as path from 'path';

// 定义一个更健壮的 API 接口，同时包含新旧两套 API
interface PythonExtensionApi {
    // 方案 A: 新版 API (可能不稳定)
    environments?: {
        getActiveEnvironmentPath(resource?: vscode.Uri): Promise<{ path: string } | undefined>;
        readonly onDidChangeActiveEnvironmentPath: vscode.Event<vscode.Uri | undefined>;
    };
    // 方案 B: 旧版 API (非常稳定，兼容性好)
    settings?: {
        getExecutionDetails(resource?: vscode.Uri): { execCommand: string[] | undefined };
        readonly onDidChangeExecutionDetails: vscode.Event<vscode.Uri | undefined>;
    };
}

let pythonApi: PythonExtensionApi | undefined;

/**
 * 获取并激活官方 Python 扩展的 API
 */
async function getPythonExtensionApi(): Promise<PythonExtensionApi | undefined> {
    if (pythonApi) return pythonApi;

    const extension = vscode.extensions.getExtension('ms-python.python');
    if (!extension) return undefined;

    if (!extension.isActive) {
        await extension.activate();
    }

    pythonApi = extension.exports as PythonExtensionApi;
    return pythonApi;
}

/**
 * 获取当前工作区选中的 Python 解释器的绝对路径
 * @param resource 当前打开的文档 Uri
 */
export async function getPythonInterpreterPath(resource?: vscode.Uri): Promise<string> {
    const api = await getPythonExtensionApi();
    let pythonPath = 'python'; // 默认回退值

    if (!api) return pythonPath;

    // === 策略 1: 尝试使用新版 environments API ===
    // (你之前的代码就在这里报错，我们加上 try-catch 并忽略它的错误)
    if (api.environments) {
        try {
            const envPath = await api.environments.getActiveEnvironmentPath(resource);
            if (envPath && envPath.path) {
                console.log('[PythonApi] Found path via environments API:', envPath.path);
                return envPath.path;
            }
        } catch (error) {
            console.warn('[PythonApi] environments API failed (skipping):', error);
        }
    }

    // === 策略 2: 尝试使用旧版 settings API (稳定性备份) ===
    if (api.settings) {
        try {
            // 旧版 API 返回的是 execCommand 数组，例如 ["path/to/python"]
            const details = api.settings.getExecutionDetails(resource);
            if (details && details.execCommand && details.execCommand.length > 0) {
                const pathFromSettings = details.execCommand[0];
                console.log('[PythonApi] Found path via settings API:', pathFromSettings);
                return pathFromSettings;
            }
        } catch (error) {
            console.warn('[PythonApi] settings API failed:', error);
        }
    }


    console.warn("[PythonApi] All methods failed, falling back to system 'python'.");
    return pythonPath;
}

/**
 * 注册监听器：当 Python 环境发生变化时触发
 */
export async function onDidChangePythonInterpreter(
    callback: (newPath: string) => void, 
    context: vscode.ExtensionContext
) {
    const api = await getPythonExtensionApi();
    if (!api) return;

    // 监听新版 API 事件
    if (api.environments && api.environments.onDidChangeActiveEnvironmentPath) {
        const disposable = api.environments.onDidChangeActiveEnvironmentPath(async (resource) => {
            const newPath = await getPythonInterpreterPath(resource);
            callback(newPath);
        });
        context.subscriptions.push(disposable);
    }
    
    // 同时也监听旧版 API 事件 (以防万一)
    if (api.settings && api.settings.onDidChangeExecutionDetails) {
         const disposable = api.settings.onDidChangeExecutionDetails(async (resource) => {
            const newPath = await getPythonInterpreterPath(resource);
            callback(newPath);
        });
        context.subscriptions.push(disposable);
    }
}