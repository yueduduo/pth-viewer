import torch
import sys
import json
import os
import argparse

# 尝试导入 safetensors
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

# === 1. 读取单个 Safetensors 文件的 Header ===
def read_local_safetensors(file_path):
    if not HAS_SAFETENSORS:
        return {"error": "缺少 safetensors 库，请运行 pip install safetensors"}
    
    tree = {}
    try:
        with safe_open(file_path, framework="pt", device="cpu") as f:
            for key in f.keys():
                slice_info = f.get_slice(key)
                info = {
                    "_type": "tensor",
                    "dtype": str(slice_info.get_dtype()),
                    "shape": list(slice_info.get_shape()),
                    "location": "Current File" # 标记来源
                }
                insert_into_tree(tree, key.split('.'), info)
    except Exception as e:
        return {"error": str(e)}
    return tree

# === 2. 读取单个 PyTorch 文件的内容 ===
def read_local_torch(file_path):
    try:
        data = torch.load(file_path, map_location='cpu')
        return summarize_torch_data(data)
    except Exception as e:
        return {"error": str(e)}

def summarize_torch_data(data):
    if isinstance(data, dict):
        # 处理 State Dict 这种扁平结构，尝试构建树
        # 这是一个简单的 heuristic：如果 key 包含 "."，我们尝试把它变成树
        is_flat_state_dict = all(isinstance(k, str) for k in data.keys())
        if is_flat_state_dict and any("." in k for k in data.keys()):
            tree = {}
            for k, v in data.items():
                info = summarize_torch_data(v)
                insert_into_tree(tree, k.split('.'), info)
            return tree
        else:
            return {k: summarize_data_recursive(v) for k, v in data.items()}
    return summarize_data_recursive(data)

def summarize_data_recursive(data):
    if isinstance(data, dict):
        return {k: summarize_data_recursive(v) for k, v in data.items()}
    elif isinstance(data, (list, tuple)):
        return [summarize_data_recursive(v) for v in data]
    elif torch.is_tensor(data):
        return {
            "_type": "tensor",
            "dtype": str(data.dtype).split('.')[-1],
            "shape": list(data.shape),
            "location": "Current File"
        }
    else:
        return str(type(data))

# === 3. 读取 Index JSON 构建全局视图 ===
def read_global_index(index_path, current_file_name):
    try:
        with open(index_path, 'r', encoding='utf-8') as f:
            index_data = json.load(f)
        
        weight_map = index_data.get("weight_map", {})
        tree = {}
        
        for key, filename in weight_map.items():
            # 标记这个参数是在当前文件，还是在其他分片
            loc_str = "Current File" if filename == current_file_name else f"File: {filename}"
            
            info = {
                "_type": "tensor_ref", # 这是一个引用，可能读不到 shape
                "location": loc_str
            }
            insert_into_tree(tree, key.split('.'), info)
            
        return {
            "is_global": True,
            "index_file": os.path.basename(index_path),
            "data": tree
        }
    except Exception as e:
        return {"error": f"Index read failed: {str(e)}"}

# === 主逻辑 ===
if __name__ == "__main__":
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf8', buffering=1)
    
    parser = argparse.ArgumentParser()
    parser.add_argument("file_path", help="Path to the model file")
    parser.add_argument("--force-local", action="store_true", help="Force read only local file")
    args = parser.parse_args()

    file_path = args.file_path
    force_local = args.force_local
    
    dir_name = os.path.dirname(file_path)
    base_name = os.path.basename(file_path)
    
    # 定义可能的索引文件名
    # 1. model.safetensors.index.json (Huggingface 通用)
    # 2. pytorch_model.bin.index.json
    # 3. [filename].index.json
    possible_indexes = [
        "model.safetensors.index.json",
        "pytorch_model.bin.index.json",
        base_name + ".index.json"
    ]
    
    found_index = None
    if not force_local:
        for idx in possible_indexes:
            idx_path = os.path.join(dir_name, idx)
            if os.path.exists(idx_path):
                found_index = idx_path
                break
    
    result = {}
    
    if found_index:
        # --> 进入全局模式
        result = read_global_index(found_index, base_name)
    else:
        # --> 进入局部模式 (Fallback)
        is_safetensors = file_path.endswith('.safetensors')
        data = None
        if is_safetensors:
            data = read_local_safetensors(file_path)
        else:
            data = read_local_torch(file_path)
            
        result = {
            "is_global": False,
            "data": data
        }

    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))