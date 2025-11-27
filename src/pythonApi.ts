import * as vscode from 'vscode';

// 定义一个简化版的 Python 扩展 API 接口
// 我们只需要获取环境路径的功能
interface PythonExtensionApi {
    environments: {
        getActiveEnvironmentPath(resource?: vscode.Uri): Promise<{ path: string } | undefined>;
        readonly onDidChangeActiveEnvironmentPath: vscode.Event<vscode.Uri | undefined>;
    };
}

let pythonApi: PythonExtensionApi | undefined;

/**
 * 获取并激活官方 Python 扩展的 API
 */
async function getPythonExtensionApi(): Promise<PythonExtensionApi | undefined> {
    // 如果已经获取过，直接返回
    if (pythonApi) {
        return pythonApi;
    }

    // 获取官方 Python 扩展
    const extension = vscode.extensions.getExtension('ms-python.python');
    if (!extension) {
        // 用户没装 Python 插件
        return undefined;
    }

    // 确保它已激活
    if (!extension.isActive) {
        await extension.activate();
    }

    // 获取其导出的 API 对象
    // 注意：这里假设用户安装的是较新的 Python 插件版本，提供了 environments API
    pythonApi = extension.exports as PythonExtensionApi;
    return pythonApi;
}

/**
 * 获取当前工作区选中的 Python 解释器的绝对路径
 * @param resource 当前打开的文档 Uri (用于确定是哪个工作区)
 */
export async function getPythonInterpreterPath(resource?: vscode.Uri): Promise<string> {
    const api = await getPythonExtensionApi();
    
    // 默认回退值：如果获取失败，尝试直接使用系统 PATH 中的 'python' 命令
    let pythonPath = 'python';

    if (api && api.environments) {
        try {
            // 调用 API 获取当前活动的 Python 环境路径
            const envPath = await api.environments.getActiveEnvironmentPath(resource);
            if (envPath && envPath.path) {
                pythonPath = envPath.path;
                console.log('Using Python Interpreter from MS-Python Extension:', pythonPath);
            }
        } catch (error) {
            console.warn("Failed to get python path from extension API, falling back to system 'python'.", error);
        }
    } else {
        console.warn("Python extension API not available, falling back to system 'python'.");
    }

    return pythonPath;
}

/**
 * 注册监听器，当 Python 环境发生变化时触发回调
 */
export async function onDidChangePythonInterpreter(callback: () => void, context: vscode.ExtensionContext) {
    const api = await getPythonExtensionApi();
    if (api && api.environments.onDidChangeActiveEnvironmentPath) {
        context.subscriptions.push(
            api.environments.onDidChangeActiveEnvironmentPath(() => {
                console.log('Python interpreter changed detected.');
                callback();
            })
        );
    }
}