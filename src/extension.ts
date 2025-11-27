import * as vscode from 'vscode';
// 导入自定义编辑器类
import { PthEditorProvider } from './PthEditorProvider';

export function activate(context: vscode.ExtensionContext) {

    // 1. 注册自定义编辑器提供程序 (双击打开功能)
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            PthEditorProvider.viewType, // 在 package.json 中定义的 viewType: 'pth-viewer.pthEditor'
            new PthEditorProvider(context),
            {
                webviewOptions: {
                    retainContextWhenHidden: true // 隐藏后保留状态，提升性能
                }
            }
        )
    );

    // 2. 注册右键菜单命令 (右键菜单打开功能)
    let disposable = vscode.commands.registerCommand('pth-viewer.showPthStructure', (uri: vscode.Uri) => {
        // 如果是从右键菜单点击，uri 会自动传入
        if (uri && uri.fsPath) {
            // 使用 VS Code 内部命令，强制以我们的自定义编辑器类型打开文件
            vscode.commands.executeCommand('vscode.openWith', uri, PthEditorProvider.viewType);
        } else {
            vscode.window.showErrorMessage("请在资源管理器中右键点击 .pth 或 .pt 文件使用此功能");
        }
    });

    context.subscriptions.push(disposable);

    console.log('PyTorch Viewer Extension is now active!');
}

export function deactivate() {}