import torch
import sys
import json
import os
import argparse
import math

# 尝试导入 safetensors
try:
    from safetensors import safe_open
    HAS_SAFETENSORS = True
except ImportError:
    HAS_SAFETENSORS = False

# ==========================================
# 0. 通用辅助函数
# ==========================================


#  辅助函数：将扁平的 Key 路径插入到嵌套字典中
#  输入: parts=['model', 'layer', '0', 'weight'], info={...}
#  效果: tree['model']['layer']['0']['weight'] = info
def insert_into_tree(tree, parts, info):
    """递归构建树状结构"""
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

def format_tensor_stats(tensor_obj):
    """统一生成 Tensor 的统计信息和预览"""
    
    # 辅助函数：将 NaN/Inf 转换为 None (JSON null)
    def clean_float(val):
        try:
            f = float(val)
            # 如果是 NaN (Not a Number) 或 Inf (无穷大)
            if math.isnan(f) or math.isinf(f):
                return None # <--- 关键修改：返回 None，JSON 会变成 null
            return f
        except:
            return None

    # 1. 基础数据准备
    t_float = tensor_obj.to(dtype=torch.float32)
    
    # 2. 计算统计量
    if t_float.numel() == 0:
        # 空 Tensor 处理
        stats = {
            "min": None, "max": None, "mean": None, "std": None,
            "shape": list(tensor_obj.shape),
            "dtype": str(tensor_obj.dtype).split('.')[-1]
        }

    else:
        # 即使只有 1 个元素，PyTorch 计算 std 会返回 nan，
        # clean_float 会捕获它并变成 None
        stats = {
            "min": clean_float(t_float.min().item()),
            "max": clean_float(t_float.max().item()),
            "mean": clean_float(t_float.mean().item()),
            "std": clean_float(t_float.std().item()), # 这里会自动处理 1 个元素导致的 nan
            "shape": list(tensor_obj.shape),
            "dtype": str(tensor_obj.dtype).split('.')[-1]
        }
        
    torch.set_printoptions(edgeitems=3, threshold=50, linewidth=120)
    preview_str = str(tensor_obj)

    return {
        "type": "tensor_data",
        "stats": stats,
        "preview": preview_str
    }

# ==========================================
# 1. 抽象基类 (Interface)
# ==========================================

class BaseReader:
    def __init__(self, file_path):
        self.file_path = file_path
        self.content = None

    def get_structure(self):
        """返回文件的层级结构 (Metadata)"""
        raise NotImplementedError

    def get_tensor_data(self, key_path_json):
        """根据 Key 获取 Tensor 的数值 (Data)"""
        raise NotImplementedError

# ==========================================
# 2. PyTorch Reader (.pth / .pt)
# ==========================================

class TorchReader(BaseReader):
    """专门处理 .pt / .pth"""
    def load(self):
        # map_location='cpu' 防止无 GPU 报错
        self.content = torch.load(self.file_path, map_location='cpu')

    def _recursive_summary(self, data):
        if isinstance(data, dict):
            return {k: self._recursive_summary(v) for k, v in data.items()}
        elif isinstance(data, (list, tuple)):
            return [self._recursive_summary(v) for v in data]
        elif torch.is_tensor(data):
            return {
                "_type": "tensor",
                "dtype": str(data.dtype).split('.')[-1],
                "shape": list(data.shape)
            }
        # === 核心修复：把基本类型的处理加回来 ===
        elif isinstance(data, (int, float, str, bool)):
            return data
        elif data is None:
            return "None"
        # ======================================
        
        else:
            return str(type(data))

    def get_structure(self):
        if self.content is None: self.load()
        return self._recursive_summary(self.content)

    def get_tensor_data(self, key_path_json):
        """
        根据 key_path_json 查找 Tensor
        key_path_json: JSON 字符串，例如 '["policy", "net.0.weight"]'
        """
        if self.content is None: self.load()
        
        # === 核心修改：解析 JSON 列表，而不是 split 字符串 ===
        try:
            keys = json.loads(key_path_json)
        except json.JSONDecodeError:
            # 兼容旧逻辑（防守性编程）
            keys = key_path_json.split('.')
            
        obj = self.content
        try:
            for k in keys:
                # === 情况 1: 对象是列表/元组 ===
                # 尝试处理列表索引 (e.g., "0")
                if isinstance(obj, (list, tuple)):
                    # 如果 k 是字符串形式的数字，转成 int
                    if isinstance(k, str) and k.isdigit():
                        obj = obj[int(k)]
                    else:
                        # 可能是极其罕见的非数字索引，或者路径错误
                         obj = obj[k]
                
                # === 情况 2: 对象是字典 (核心修改) ===
                else:
                    # 字典查找，直接使用 k (即使 k 里面有点，也没关系)
                    try:
                        # 1 优先尝试直接用 key (通常是字符串)
                        obj = obj[k]
                    except KeyError:
                        # 2 如果失败，且 key 是数字字符串，尝试转成 int 再查
                        # (专门处理 optimizer['state'][0] 这种情况)
                        if isinstance(k, str) and k.isdigit():
                            int_k = int(k)
                            if int_k in obj:
                                obj = obj[int_k]
                            else:
                                raise # 真的找不到了，抛出异常
                        else:
                            raise # 真的找不到了，抛出异常
        except (KeyError, IndexError, TypeError) as e:
            return {"error": f"Key not found: {keys} (Error: {str(e)})"}

        # 2. 检查是否是 Tensor
        if not torch.is_tensor(obj):
            return {"error": "Target is not a Tensor", "value": str(obj)}

        return format_tensor_stats(obj)

# ==========================================
# 3. Safetensors Reader (.safetensors)
# ==========================================

class SafetensorsReader(BaseReader):
    def get_structure(self):
        if not HAS_SAFETENSORS:
            return {"error": "Missing library: safetensors"}
        
        tree = {}
        try:
            with safe_open(self.file_path, framework="pt", device="cpu") as f:
                for key in f.keys():
                    slice_info = f.get_slice(key)
                    info = {
                        "_type": "tensor",
                        "dtype": str(slice_info.get_dtype()),
                        "shape": list(slice_info.get_shape()),
                        "location": "Current File"
                    }
                    # Safetensors 总是扁平 Key，需要构建树
                    insert_into_tree(tree, key.split('.'), info)
        except Exception as e:
            return {"error": str(e)}
        return tree

    def get_tensor_data(self, key_path_json):
        if not HAS_SAFETENSORS:
            return {"error": "Missing library: safetensors"}
        
        try:
            keys = json.loads(key_path_json)
            # Safetensors 存储的是扁平 Key。
            # 我们之前构建树时是用 split('.') 拆分的，现在需要用 join('.') 还原
            flat_key = ".".join(keys)
        except:
            return {"error": "Invalid JSON key path"}

        try:
            with safe_open(self.file_path, framework="pt", device="cpu") as f:
                # safe_open 不支持直接随机读取，但 get_tensor 很快！！！！！TODO
                # 注意：这会把 Tensor 加载到内存
                tensor = f.get_tensor(flat_key)
                return format_tensor_stats(tensor)
        except Exception as e:
             return {"error": f"Failed to retrieve tensor: {flat_key} ({str(e)})"}

# ==========================================
# 4. Reader Factory
# ==========================================

class ReaderFactory:
    @staticmethod
    def get_reader(file_path):
        if file_path.endswith('.safetensors'):
            return SafetensorsReader(file_path)
        else:
            # 默认为 PyTorch，涵盖 .pth, .pt, .bin
            return TorchReader(file_path)

# ==========================================
# 5. Global Index Logic (Independent)
# ==========================================

def read_global_index(index_path, current_file_name):
    try:
        with open(index_path, 'r', encoding='utf-8') as f:
            index_data = json.load(f)
        
        weight_map = index_data.get("weight_map", {})
        tree = {}
        for key, filename in weight_map.items():
            loc_str = "Current File" if filename == current_file_name else f"File: {filename}"
            info = {
                "_type": "tensor_ref",
                "location": loc_str
            }
            insert_into_tree(tree, key.split('.'), info)
            
        return {"is_global": True, "index_file": os.path.basename(index_path), "data": tree}
    except Exception as e:
        return {"error": f"Index read failed: {str(e)}"}

# ==========================================
# 6. Main Entry Point
# ==========================================

if __name__ == "__main__":
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf8', buffering=1)
    
    parser = argparse.ArgumentParser()
    parser.add_argument("file_path", help="Path to file")
    parser.add_argument("--action", default="structure", choices=["structure", "data"])
    parser.add_argument("--key", help="JSON list key path for data retrieval")
    parser.add_argument("--force-local", action="store_true", help="Ignore global index")
    
    args = parser.parse_args()
    file_path = args.file_path
    
    try:
        # 1. 实例化具体的 Reader
        reader = ReaderFactory.get_reader(file_path)

        if args.action == "data":
            # === 获取数据模式 ===
            # 直接使用 Reader 获取数据，因为 Index 文件里没有数据
            if not args.key:
                print(json.dumps({"error": "Missing --key argument"}))
            else:
                result = reader.get_tensor_data(args.key)
                print(json.dumps(result, ensure_ascii=False))

        else:
            # === 获取结构模式 ===
            # 检查是否有 Global Index
            dir_name = os.path.dirname(file_path)
            base_name = os.path.basename(file_path)
            possible_indexes = [
                "model.safetensors.index.json",
                "pytorch_model.bin.index.json",
                base_name + ".index.json"
            ]
            
            found_index = None
            if not args.force_local:
                for idx in possible_indexes:
                    idx_path = os.path.join(dir_name, idx)
                    if os.path.exists(idx_path):
                        found_index = idx_path
                        break
            
            if found_index:
                # 使用全局索引逻辑
                result = read_global_index(found_index, base_name)
                print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
            else:
                # 使用 Reader 的本地读取逻辑
                structure = reader.get_structure()
                # 包装一下以符合前端格式
                result = {
                    "is_global": False,
                    "data": structure
                }
                print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))

    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))