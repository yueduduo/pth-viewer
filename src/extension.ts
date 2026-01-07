import * as vscode from 'vscode';
import { PthEditorProvider } from './PthEditorProvider'; // 导入自定义编辑器类
import { getPythonInterpreterPath, onDidChangePythonInterpreter } from './pythonApi';
import * as path from 'path';

let myStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {

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
            vscode.window.showErrorMessage("请在资源管理器中右键点击 .pth 或 .pt 文件使用此功能");
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

    // 5. 初始化状态栏显示，并监听环境变化
    updateStatusBarItem();
    // 当 Python 官方插件通知我们环境变了，我们更新状态栏
    // 注意：这里只是更新状态栏文字显示，实际解析时 PthEditorProvider 会实时获取最新路径
    onDidChangePythonInterpreter(() => {
        updateStatusBarItem();
    }, context);
    
    // 显示状态栏
    myStatusBarItem.show();

    console.log('PyTorch Structure Viewer Extension is now active!');
}

/**
 * 更新状态栏显示的文字
 */
async function updateStatusBarItem() {
    try {
        // 获取当前活动的编辑器资源，用于确定工作区
        const activeEditor = vscode.window.activeTextEditor;
        const resource = activeEditor?.document.uri;

        const pythonPath = await getPythonInterpreterPath(resource);
        
        // 尝试从路径中提取版本号或环境名称，让显示更友好
        // 这里做一个简单的处理，显示 python 可执行文件的父目录名（通常是环境名）
        let displayName = 'System Python';
        if (pythonPath !== 'python') {
            const dirName = path.basename(path.dirname(pythonPath));
             // 如果是 venv/conda 环境，目录名通常有意义
            displayName = `Python (${dirName})`;
        }

        myStatusBarItem.text = `$(python) ${displayName}`; // 使用 VS Code 内置的 python 图标
        myStatusBarItem.tooltip = `PyTorch Viewer正在使用的Python解释器: ${pythonPath}。点击切换。`;

    } catch (error) {
        myStatusBarItem.text = `$(alert) Python Error`;
    }
}

export function deactivate() {}