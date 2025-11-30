import torch
import sys
import json
import argparse
import io

# ==========================================
# 1. 抽象基类与工厂 (保证扩展性)
# ==========================================

class BaseReader:
    """所有格式读取器的基类"""
    def __init__(self, file_path):
        self.file_path = file_path
        self.content = None

    def load(self):
        """加载文件到内存（或建立句柄）"""
        raise NotImplementedError

    def get_structure(self):
        """返回树状结构元数据"""
        raise NotImplementedError

    def get_tensor_data(self, key_path):
        """获取特定 Key 的 Tensor 数值与统计"""
        raise NotImplementedError

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
                # 尝试处理列表索引 (e.g., "0")
                if isinstance(obj, (list, tuple)):
                    # 如果 k 是字符串形式的数字，转成 int
                    if isinstance(k, str) and k.isdigit():
                        obj = obj[int(k)]
                    else:
                        # 可能是极其罕见的非数字索引，或者路径错误
                         obj = obj[k]
                else:
                    # 字典查找，直接使用 k (即使 k 里面有点，也没关系)
                    obj = obj[k]
        except (KeyError, IndexError, TypeError) as e:
            return {"error": f"Key not found: {keys} (Error: {str(e)})"}

        # 2. 检查是否是 Tensor
        if not torch.is_tensor(obj):
            return {"error": "Target is not a Tensor", "value": str(obj)}

        # 3. 计算统计信息和预览
        # 处理多维显示：直接使用 PyTorch 的 string formatting，但限制长度防止卡死
        # 设置 print options 让输出紧凑
        torch.set_printoptions(edgeitems=3, threshold=50, linewidth=120)
        
        stats = {
            "min": float(obj.min()),
            "max": float(obj.max()),
            "mean": float(obj.mean().float()), # 转 float 防止半精度报错
            "std": float(obj.std().float()),
            "shape": list(obj.shape),
            "dtype": str(obj.dtype).split('.')[-1]
        }
        
        # 获取格式化的字符串表示 (保留多维结构)
        tensor_str = str(obj)
        
        return {
            "type": "tensor_data",
            "stats": stats,
            "preview": tensor_str
        }

class ReaderFactory:
    @staticmethod
    def get_reader(file_path):
        if file_path.endswith('.pth') or file_path.endswith('.pt'):
            return TorchReader(file_path)
        # 未来可以在这里加:
        # elif file_path.endswith('.safetensors'): return SafetensorsReader(file_path)
        else:
            raise ValueError("Unsupported file format")

# ==========================================
# 2. 主入口逻辑
# ==========================================

if __name__ == "__main__":
    # 设置输出编码
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf8', buffering=1)
    
    parser = argparse.ArgumentParser()
    parser.add_argument("file_path", help="Path to file")
    # 新增 action 参数，区分是看结构还是看数据
    parser.add_argument("--action", default="structure", choices=["structure", "data"])
    parser.add_argument("--key", help="Key path for data retrieval (e.g. layer1.weight)")
    
    args = parser.parse_args()

    try:
        reader = ReaderFactory.get_reader(args.file_path)
        
        result = {}
        if args.action == "structure":
            result = {"data": reader.get_structure()}
        elif args.action == "data":
            if not args.key:
                result = {"error": "Missing --key argument"}
            else:
                result = reader.get_tensor_data(args.key)
        
        print(json.dumps(result, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))