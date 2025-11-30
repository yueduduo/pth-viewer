import torch
import sys
import json
import os

# 尝试导入 safetensors，如果用户没装，稍后会提示
try:
    from safetensors import safe_open
    HAS_SAFETENSORS = True
except ImportError:
    HAS_SAFETENSORS = False

# -------------------------------------------------
#  辅助函数：将扁平的 Key 路径插入到嵌套字典中
#  输入: parts=['model', 'layer', '0', 'weight'], info={...}
#  效果: tree['model']['layer']['0']['weight'] = info
# -------------------------------------------------
def insert_into_tree(tree, parts, info):
    key = parts[0]
    if len(parts) == 1:
        # 到达叶子节点
        tree[key] = info
    else:
        # 如果当前层级不存在，或者是个叶子节点（冲突了），初始化为字典
        if key not in tree or not isinstance(tree[key], dict):
            tree[key] = {}
        # 递归下一层
        insert_into_tree(tree[key], parts[1:], info)

# -------------------------------------------------
#  核心逻辑：处理常规对象 (torch.load 的结果)
# -------------------------------------------------
def summarize_data(data):
    if isinstance(data, dict):
        return {k: summarize_data(v) for k, v in data.items()}
    elif isinstance(data, (list, tuple)):
        return [summarize_data(v) for v in data]
    elif torch.is_tensor(data):
        return {
            "_type": "tensor",
            "dtype": str(data.dtype).split('.')[-1],
            "shape": list(data.shape)
        }
    elif isinstance(data, (int, float, str, bool, type(None))):
        return data
    else:
        return str(type(data))

# -------------------------------------------------
#  核心逻辑：处理 Safetensors 文件
# -------------------------------------------------
def read_safetensors_file(file_path):
    if not HAS_SAFETENSORS:
        return {"error": "缺少依赖: 请在当前 Python 环境中安装 safetensors 库。\n运行: pip install safetensors"}
    
    tree_structure = {}
    
    try:
        # framework="pt" 表示 PyTorch，device="cpu" 确保不占显存
        with safe_open(file_path, framework="pt", device="cpu") as f:
            keys = f.keys() # 获取所有扁平的键，如 "model.layers.0.weight"
            
            for key in keys:
                # 获取元数据 (不加载 Tensor 数据，速度极快)
                tensor_slice = f.get_slice(key)
                shape = tensor_slice.get_shape()
                dtype = str(tensor_slice.get_dtype()) # e.g. 'float32'
                
                # 构造符合前端标准的信息对象
                info = {
                    "_type": "tensor",
                    "dtype": dtype,
                    "shape": list(shape)
                }
                
                # 将扁平 Key 拆解并构建树
                # 假设分隔符是 "."
                parts = key.split('.')
                insert_into_tree(tree_structure, parts, info)
                
    except Exception as e:
        return {"error": f"读取 safetensors 文件失败: {str(e)}"}
        
    return tree_structure

if __name__ == "__main__":
    # 配置标准输出为 UTF-8 且无缓冲
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf8', buffering=1)
    
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided."}))
        sys.exit(1)

    file_path = sys.argv[1]
    
    try:
        if file_path.endswith('.safetensors'):
            # === 处理 Safetensors ===
            summary = read_safetensors_file(file_path)
        else:
            # === 处理 PTH / PT ===
            # 使用 map_location='cpu' 避免 GPU 错误
            content = torch.load(file_path, map_location='cpu')
            summary = summarize_data(content)
        
        # 输出 JSON
        print(json.dumps(summary, ensure_ascii=False, separators=(',', ':')))
        
    except Exception as e:
        # 顶层错误捕获
        error_msg = {"error": f"Failed to load file. Detail: {str(e)}"}
        print(json.dumps(error_msg, ensure_ascii=False))