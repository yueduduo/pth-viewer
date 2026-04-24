import json
import sqlite3
from typing import Any, Dict, List, Optional, Tuple


def _is_tensor_leaf(node: Any) -> bool:
    return isinstance(node, dict) and node.get("_type") in ("tensor", "tensor_ref")


def _classify_node(node: Any) -> Tuple[str, bool]:
    if _is_tensor_leaf(node):
        return node.get("_type", "tensor"), False
    if isinstance(node, dict):
        return "object", True
    if isinstance(node, list):
        return "array", True
    return "scalar", False


def _summary(node: Any, node_type: str) -> str:
    if node_type == "object":
        return f"Dict {{{len(node)}}}"
    if node_type == "array":
        return f"List [{len(node)}]"
    if node_type in ("tensor", "tensor_ref"):
        dtype = node.get("dtype", "?")
        shape = node.get("shape", [])
        return f"{node_type} shape={shape} dtype={dtype}"

    text = str(node)
    if len(text) > 200:
        return text[:200] + "..."
    return text


def build_index(db_path: str, root_data: Any) -> int:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL;")
        cur.execute("PRAGMA synchronous=NORMAL;")
        cur.execute("PRAGMA temp_store=MEMORY;")
        cur.execute("DROP TABLE IF EXISTS nodes;")
        cur.execute(
            """
            CREATE TABLE nodes (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER,
                node_key TEXT,
                display_path TEXT,
                node_type TEXT,
                is_expandable INTEGER,
                summary TEXT,
                dtype TEXT,
                shape_json TEXT
            );
            """
        )
        cur.execute("CREATE INDEX idx_nodes_parent ON nodes(parent_id);")
        cur.execute("CREATE INDEX idx_nodes_display_path ON nodes(display_path);")

        next_id = 1
        root_type, root_expandable = _classify_node(root_data)
        root_row = (
            next_id,
            None,
            "$",
            "$",
            root_type,
            1 if root_expandable else 0,
            _summary(root_data, root_type),
            root_data.get("dtype") if isinstance(root_data, dict) else None,
            json.dumps(root_data.get("shape")) if isinstance(root_data, dict) and "shape" in root_data else None,
        )
        cur.execute(
            "INSERT INTO nodes (id,parent_id,node_key,display_path,node_type,is_expandable,summary,dtype,shape_json) VALUES (?,?,?,?,?,?,?,?,?)",
            root_row,
        )

        stack: List[Tuple[int, Any, str]] = [(next_id, root_data, "$")]
        rows_buffer: List[Tuple[int, int, str, str, str, int, str, Optional[str], Optional[str]]] = []
        batch_size = 1000

        while stack:
            parent_id, node, parent_path = stack.pop()
            node_type, expandable = _classify_node(node)
            if not expandable:
                continue

            if isinstance(node, dict):
                children = list(node.items())
            else:
                children = [(str(i), v) for i, v in enumerate(node)]

            for key, child in children:
                next_id += 1
                child_type, child_expandable = _classify_node(child)
                if parent_path == "$":
                    # 根路径下应根据“父节点类型”而不是子节点类型决定路径格式
                    # - 根是对象: metadata
                    # - 根是数组: [0]
                    if isinstance(node, list):
                        display_path = f"[{key}]"
                    else:
                        display_path = key
                else:
                    if isinstance(node, list):
                        display_path = f"{parent_path}[{key}]"
                    else:
                        display_path = f"{parent_path}.{key}"

                dtype = child.get("dtype") if isinstance(child, dict) else None
                shape_json = json.dumps(child.get("shape")) if isinstance(child, dict) and "shape" in child else None
                rows_buffer.append(
                    (
                        next_id,
                        parent_id,
                        key,
                        display_path,
                        child_type,
                        1 if child_expandable else 0,
                        _summary(child, child_type),
                        dtype,
                        shape_json,
                    )
                )

                if child_expandable:
                    stack.append((next_id, child, display_path))

                if len(rows_buffer) >= batch_size:
                    cur.executemany(
                        "INSERT INTO nodes (id,parent_id,node_key,display_path,node_type,is_expandable,summary,dtype,shape_json) VALUES (?,?,?,?,?,?,?,?,?)",
                        rows_buffer,
                    )
                    rows_buffer = []

        if rows_buffer:
            cur.executemany(
                "INSERT INTO nodes (id,parent_id,node_key,display_path,node_type,is_expandable,summary,dtype,shape_json) VALUES (?,?,?,?,?,?,?,?,?)",
                rows_buffer,
            )

        conn.commit()
        return 1
    finally:
        conn.close()


def get_children(db_path: str, node_id: int, offset: int, limit: int) -> Dict[str, Any]:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id,parent_id,node_key,display_path,node_type,is_expandable,summary,dtype,shape_json FROM nodes WHERE id=?",
            (node_id,),
        )
        current = cur.fetchone()
        if not current:
            return {"error": f"Node not found: {node_id}"}

        cur.execute("SELECT COUNT(1) FROM nodes WHERE parent_id=?", (node_id,))
        total_children = cur.fetchone()[0]
        current_node_type = current[4]
        if current_node_type == "array":
            # 数组子节点必须按数值顺序排序，避免字符串排序导致 0,1,10,100...
            cur.execute(
                """
                SELECT id,parent_id,node_key,display_path,node_type,is_expandable,summary,dtype,shape_json
                FROM nodes
                WHERE parent_id=?
                ORDER BY CAST(node_key AS INTEGER)
                LIMIT ? OFFSET ?
                """,
                (node_id, limit, offset),
            )
        else:
            # 对象子节点必须保持原始插入顺序，不能按 key 字符串排序
            # 否则截断窗口会打乱“头/尾”的相对位置
            cur.execute(
                """
                SELECT id,parent_id,node_key,display_path,node_type,is_expandable,summary,dtype,shape_json
                FROM nodes
                WHERE parent_id=?
                ORDER BY id
                LIMIT ? OFFSET ?
                """,
                (node_id, limit, offset),
            )
        rows = cur.fetchall()

        def row_to_node(row):
            return {
                "id": row[0],
                "parent_id": row[1],
                "key": row[2],
                "display_path": row[3],
                "node_type": row[4],
                "is_expandable": bool(row[5]),
                "summary": row[6],
                "dtype": row[7],
                "shape": json.loads(row[8]) if row[8] else None,
            }

        return {
            "current": row_to_node(current),
            "children": [row_to_node(r) for r in rows],
            "offset": offset,
            "limit": limit,
            "total_children": total_children,
        }
    finally:
        conn.close()


def get_children_by_path(db_path: str, display_path: str, offset: int, limit: int) -> Dict[str, Any]:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        path_candidates = [display_path]

        # 兼容不同阶段的路径格式:
        # metadata <-> $.metadata, [0] <-> $[0]
        if display_path.startswith("$."):
            path_candidates.append(display_path[2:])
        elif display_path.startswith("$["):
            path_candidates.append(display_path[1:])
        elif not display_path.startswith("$"):
            if display_path.startswith("["):
                path_candidates.append(f"${display_path}")
            else:
                path_candidates.append(f"$.{display_path}")
                # 兼容旧版本错误索引写法: 根对象子节点被写成 [metadata]
                path_candidates.append(f"[{display_path}]")

        row = None
        for candidate in path_candidates:
            cur.execute(
                "SELECT id FROM nodes WHERE display_path=? LIMIT 1",
                (candidate,),
            )
            row = cur.fetchone()
            if row:
                break

        if not row:
            return {"error": f"Path not found: {display_path}"}
        node_id = row[0]
        return get_children(db_path, node_id, offset, limit)
    finally:
        conn.close()


def search_nodes(db_path: str, query: str, limit: int) -> Dict[str, Any]:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        like_query = f"%{query}%"
        cur.execute(
            """
            SELECT id,parent_id,node_key,display_path,node_type,is_expandable,summary,dtype,shape_json
            FROM nodes
            WHERE display_path LIKE ?
            ORDER BY LENGTH(display_path) ASC
            LIMIT ?
            """,
            (like_query, limit),
        )
        rows = cur.fetchall()
        return {
            "results": [
                {
                    "id": r[0],
                    "parent_id": r[1],
                    "key": r[2],
                    "display_path": r[3],
                    "node_type": r[4],
                    "is_expandable": bool(r[5]),
                    "summary": r[6],
                    "dtype": r[7],
                    "shape": json.loads(r[8]) if r[8] else None,
                }
                for r in rows
            ]
        }
    finally:
        conn.close()


def get_node(db_path: str, node_id: int) -> Dict[str, Any]:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id,parent_id,node_key,display_path,node_type,is_expandable,summary,dtype,shape_json FROM nodes WHERE id=?",
            (node_id,),
        )
        row = cur.fetchone()
        if not row:
            return {"error": f"Node not found: {node_id}"}
        return {
            "id": row[0],
            "parent_id": row[1],
            "key": row[2],
            "display_path": row[3],
            "node_type": row[4],
            "is_expandable": bool(row[5]),
            "summary": row[6],
            "dtype": row[7],
            "shape": json.loads(row[8]) if row[8] else None,
        }
    finally:
        conn.close()

