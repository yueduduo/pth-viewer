import * as vscode from 'vscode';
import { PthEditorProvider } from './PthEditorProvider'; // 导入自定义编辑器类
import { getPythonInterpreterPath, onDidChangePythonInterpreter } from './pythonApi';
import * as path from 'path';
import { t } from './i18n';         // <--- for 多语言
import { PythonServerManager } from './PythonServerManager'; // 上一步写的 Manager

let myStatusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {

    // 1. 注册自定义编辑器提供程序 (双击打开功能)
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            PthEditorProvider.viewType, // 在 package.json 中定义的 viewType: 'pth-viewer.pthEditor'
            new PthEditorProvider(context),
            {
                webviewOptions: { retainContextWhenHidden: true } // 隐藏后保留状态，提升性能
            }
        )
    );

     // 2. 注册右键菜单命令 (右键菜单打开功能)
    let disposableCommand = vscode.commands.registerCommand('pth-viewer.showPthStructure', (uri: vscode.Uri) => {
        // 如果是从右键菜单点击，uri 会自动传入
        if (uri && uri.fsPath) {
            // 使用 VS Code 内部命令，强制以我们的自定义编辑器类型打开文件
            vscode.commands.executeCommand('vscode.openWith', uri, PthEditorProvider.viewType);
        } else {
            vscode.window.showErrorMessage(t('file_right_click_tip'));
        }
    });
    context.subscriptions.push(disposableCommand);

    // -------------------------------------------------
    // 新增：状态栏 Python 选择器
    // -------------------------------------------------

    // 3. 注册一个命令，用于打开官方 Python 扩展的解释器选择菜单
    let selectPythonCommand = vscode.commands.registerCommand('pth-viewer.selectPython', async () => {
        // 调用官方 Python 插件的命令
        await vscode.commands.executeCommand('python.setInterpreter');
    });
    context.subscriptions.push(selectPythonCommand);

    // 4. 创建状态栏项目
    myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    myStatusBarItem.command = 'pth-viewer.selectPython'; // 点击时执行上面的命令
    context.subscriptions.push(myStatusBarItem);

    // 5. 初始化状态栏显示，并注册环境变化监听
    // 初始化 Manager
    const manager = PythonServerManager.getInstance();
    manager.setContext(context);

    // === 核心修复开始: 启动时准确获取当前环境并同步给 Manager ===
    
    // 获取当前活跃的编辑器 URI (这样能拿到 Anaconda 的特定环境，而不是默认的 'python')
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    
    // 获取路径
    const initialPath = await getPythonInterpreterPath(activeUri);
    
    console.log("[Extension] Initializing Python path:", initialPath);
    // 立即告诉 Manager 使用这个路径，不要让它自己用 'python'
    await manager.changePythonInterpreter(initialPath);
    
    // 更新状态栏 UI
    updateStatusBarItem(initialPath);

    // === 核心修复结束 ===

    // 6. 监听环境变化
    onDidChangePythonInterpreter((newPath: string) => {
        console.log("[Extension] Python interpreter changed to:", newPath);
        manager.changePythonInterpreter(newPath);
        updateStatusBarItem(newPath);
    }, context);

    // 7. 监听当前打开的文件变化 (因为不同文件可能用不同环境)
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor) {
            const p = await getPythonInterpreterPath(editor.document.uri);
            updateStatusBarItem(p);

            // 策略：如果路径变了才重启 Server。Manager.changePythonInterpreter 内部有判断逻辑，重复路径会忽略，所以直接调没事。
            manager.changePythonInterpreter(p);
        }
    }));
    
    // 显示状态栏
    myStatusBarItem.show();

    console.log('PyTorch Structure Viewer Extension is now active!');
}

/**
 * 辅助函数：更新状态栏
 * 接收 path 参数，避免重复查询
 */
function updateStatusBarItem(pythonPath: string) {
    try {
        let displayName = 'System Python';
        
        // 简单的显示逻辑优化
        if (pythonPath !== 'python') {
            // 尝试提取环境名，例如: .../anaconda3/envs/myenv/python.exe -> myenv
            // 或者是 .../anaconda3/python.exe -> anaconda3
            const parentDir = path.dirname(pythonPath);
            const envName = path.basename(parentDir); 
            
            // 如果是在 Scripts 目录下 (Windows venv)，再往上一级找
            if (envName.toLowerCase() === 'scripts' || envName.toLowerCase() === 'bin') {
                 displayName = `Python (${path.basename(path.dirname(parentDir))})`;
            } else {
                 displayName = `Python (${envName})`;
            }
        }

        myStatusBarItem.text = `$(pth-status-icon) ${displayName}`; //  使用图标
        myStatusBarItem.tooltip = `${t('status_python_tooltip_front')} ${pythonPath} ${t('status_python_tooltip_back')}`;
    } catch (error) {
        myStatusBarItem.text = `$(alert) Python Error`;
    }
}

export function deactivate() {}