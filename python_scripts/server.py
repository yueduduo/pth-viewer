import http.server
import json
import sys
import threading
import os
import urllib.parse

# === 导入现有的 Reader 逻辑 ===
# 请确保 reader.py 在同一目录下
try:
    import reader
except ImportError:
    # 如果找不到，尝试添加当前路径
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    import reader

# === 全局状态 ===
# 缓存已加载的 Reader 对象: { "file_path_str": reader_instance }
LOADED_MODELS = {} 
# 自动关闭定时器
SHUTDOWN_TIMER = None
# 超时时间 (秒): 如果 5 分钟没有任何请求，服务器自动退出
TIMEOUT_SECONDS = 300 

def reset_shutdown_timer():
    """重置自动关闭定时器"""
    global SHUTDOWN_TIMER
    if SHUTDOWN_TIMER:
        SHUTDOWN_TIMER.cancel()
    
    # 只有当没有模型加载时，或者即使有模型也强制倒计时？
    # 策略：只要有请求就重置。如果前端全都关闭了，会发送 release，
    # 我们可以选择: 只要有活动连接就不关，或者依靠前端的心跳。
    # 这里采用简单策略：每次请求都重置倒计时。
    SHUTDOWN_TIMER = threading.Timer(TIMEOUT_SECONDS, auto_shutdown)
    SHUTDOWN_TIMER.start()

def auto_shutdown():
    print("[Server] Timeout reached. Shutting down...", file=sys.stderr)
    os._exit(0)

class RequestHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        reset_shutdown_timer()
        
        # 1. 解析请求路径和 Body
        parsed_path = urllib.parse.urlparse(self.path)
        content_length = int(self.headers['Content-Length'])
        body = self.rfile.read(content_length)
        
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return

        response_data = {"error": "Unknown command"}
        status_code = 200

        try:
            # === API: /load (加载或获取结构) ===
            if parsed_path.path == '/load':
                file_path = payload.get('file_path')
                force_local = payload.get('force_local', False)
                
                # 如果已经在内存里，直接用；否则新建
                if file_path not in LOADED_MODELS:
                    # 使用 ReaderFactory (需要修改 reader.py 暴露它，或者直接实例化)
                    # 假设 reader.py 里有 ReaderFactory
                    r = reader.ReaderFactory.get_reader(file_path)
                    
                    #调用 get_structure 触发加载并缓存
                    structure = r.get_structure() 
                    
                    # 存入缓存
                    LOADED_MODELS[file_path] = r
                    
                    # 检查是否有全局索引 (这里复用 reader.py 的逻辑)
                    # 简单起见，我们假设 reader.get_structure() 返回的就是标准结构
                    response_data = {"is_global": False, "data": structure}
                    
                    # 尝试检测全局索引 (复用 reader.py 的逻辑片段)
                    if not force_local and not isinstance(r, reader.JaxReader):
                        dir_name = os.path.dirname(file_path)
                        base_name = os.path.basename(file_path)
                        possible = ["model.safetensors.index.json", "pytorch_model.bin.index.json", base_name + ".index.json"]
                        for idx in possible:
                            if os.path.exists(os.path.join(dir_name, idx)):
                                idx_res = reader.read_global_index(os.path.join(dir_name, idx), base_name)
                                response_data = idx_res
                                break
                else:
                    # 已存在缓存中，直接获取结构
                    # 注意：如果是大模型，get_structure 应该是极快的（因为 content 已在内存）
                    r = LOADED_MODELS[file_path]
                    response_data = {"is_global": False, "data": r.get_structure()}

            # === API: /inspect (查看数据) ===
            elif parsed_path.path == '/inspect':
                file_path = payload.get('file_path')
                key_json = payload.get('key') # String format of JSON list
                
                # 1. 检查是否在内存中
                r = LOADED_MODELS.get(file_path)
                
                # 2. 如果不在内存中（可能服务器刚重启，或者被释放了），尝试自动重载
                if r is None:
                    try:
                        print(f"[Server] Model not found in cache, auto-reloading: {file_path}", file=sys.stderr)
                        # 复用 ReaderFactory 创建实例
                        r = reader.ReaderFactory.get_reader(file_path)
                        # 调用 get_structure 触发底层的 self.load()
                        # (对于 Safetensors/Jax 等需要显式 open 的 Reader 很重要)
                        r.get_structure() 
                        # 存入全局缓存
                        LOADED_MODELS[file_path] = r
                    except Exception as e:
                        # 重载失败，这才是真正的错误
                        response_data = {"error": f"Model not loaded and auto-reload failed: {str(e)}"}
                        r = None # 确保后面不会执行
                
                # 3. 如果成功获取到了 Reader (无论是缓存的还是重载的)，执行查询
                if r is not None:
                    try:
                        response_data = r.get_tensor_data(key_json)
                    except Exception as e:
                        response_data = {"error": f"Inspect failed: {str(e)}"}

            # === API: /release (释放内存) ===
            elif parsed_path.path == '/release':
                file_path = payload.get('file_path')
                if file_path in LOADED_MODELS:
                    del LOADED_MODELS[file_path]
                    # 1. Python 层垃圾回收
                    import gc
                    gc.collect()
                    
                    # 2. 强制归还内存给操作系统 (OS 层面)
                    import ctypes
                    import platform
                    system_platform = platform.system()
                    

                    if system_platform == 'Linux':
                        try:
                            # Linux: 使用 malloc_trim 强制归还堆内存
                            ctypes.CDLL('libc.so.6').malloc_trim(0)
                        except:
                            pass
                            
                    elif system_platform == 'Windows':
                        try:
                            # === 修复：显式定义参数类型，确保 64 位兼容 ===
                            kernel32 = ctypes.windll.kernel32
                            
                            # 定义参数类型：Handle (void*), Size (size_t), Size (size_t)
                            kernel32.SetProcessWorkingSetSize.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t]
                            kernel32.SetProcessWorkingSetSize.restype = ctypes.c_int
                            
                            # 获取当前进程句柄
                            proc = kernel32.GetCurrentProcess()
                            
                            # 调用 API：使用 c_size_t(-1) 来表示最大值 (即 0xFFFFFFFFFFFFFFFF)
                            is_success = kernel32.SetProcessWorkingSetSize(proc, ctypes.c_size_t(-1), ctypes.c_size_t(-1))
                            
                            if is_success == 0:
                                print(f"[Server] Memory release warning: {ctypes.WinError()}", file=sys.stderr)
                            else:
                                print("[Server] Windows WorkingSet emptied.", file=sys.stderr)

                        except Exception as e:
                            # 打印错误而不是 pass，方便排查
                            print(f"[Server] Failed to release memory: {e}", file=sys.stderr)
                    
                    response_data = {"status": "released"}
                else:
                    response_data = {"status": "not_found"}

            else:
                status_code = 404

        except Exception as e:
            import traceback
            traceback.print_exc()
            response_data = {"error": str(e)}

        # 发送响应
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(response_data, ensure_ascii=False).encode('utf-8'))

    def log_message(self, format, *args):
        # 屏蔽默认的 HTTP 日志，保持 stdout 干净
        pass

if __name__ == "__main__":
    # 使用 ThreadingHTTPServer 支持并发 (虽然 JS 端是串行的，但防卡死)
    # Python 3.7+ 支持 ThreadingHTTPServer
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), RequestHandler)
    
    # 获取系统分配的随机端口
    port = server.server_address[1]
    
    # === 关键：打印端口号给 VS Code 读取 ===
    print(f"SERVER_STARTED:{port}")
    sys.stdout.flush()
    
    reset_shutdown_timer()
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass