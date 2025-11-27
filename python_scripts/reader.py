import torch
import sys
import json
import io

def summarize_data(data):
    if isinstance(data, dict):
        return {k: summarize_data(v) for k, v in data.items()}
    elif isinstance(data, (list, tuple)):
        # 递归处理列表/元组
        return [summarize_data(v) for v in data]
    elif torch.is_tensor(data):
        # *** 关键修改：只返回元数据，不返回具体的 requires_grad=True 等信息 ***
        return {
            "_type": "tensor",
            "dtype": str(data.dtype).split('.')[-1], # e.g., float32
            "shape": list(data.shape)
            # 这里的 summary 字段可以去掉，因为 Webview 不需要展示数值，只看结构。
        }
    elif isinstance(data, (int, float, str, bool, type(None))):
        return data
    else:
        # 无法识别的对象，返回其类型字符串
        return str(type(data))

if __name__ == "__main__":
    # ** 关键修改：强制使用 UTF-8 编码，并禁用缓冲 **
    # 这有助于确保 Python 立即输出 JSON 且不被中间层干扰
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf8', buffering=1)
    
    # 确保至少传入一个参数
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided."}))
        sys.exit(1)

    file_path = sys.argv[1]
    
    try:
        # 使用 io.BytesIO 辅助 PyTorch 内部的 pickle 加载，避免某些文件系统问题
        with open(file_path, 'rb') as f:
             # 加载 pth 文件 (map_location='cpu' 避免没有显卡报错)
            content = torch.load(f, map_location='cpu')
        
        # 转换成摘要结构
        summary = summarize_data(content)
        
        # 打印 JSON 到标准输出
        # ensure_ascii=False 处理中文路径或键名，separators=(',', ':') 压缩输出，避免被 shell 截断
        print(json.dumps(summary, ensure_ascii=False, separators=(',', ':')))
        
    except Exception as e:
        # 报错也要打印成 JSON，方便插件捕获
        error_msg = {"error": f"Failed to load PyTorch file. Check if PyTorch is installed and the file is valid. Detail: {str(e)}"}
        print(json.dumps(error_msg, ensure_ascii=False, separators=(',', ':')))