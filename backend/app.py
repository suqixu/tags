"""
Tag 管理系统后端
- Flask + SQLite
- JWT 鉴权
- 用户登录 / 修改密码
- Tag CRUD（含 parent_id，支持层级）
"""
import os
import sqlite3
import hashlib
import datetime
import threading
import uuid
from functools import wraps
from typing import Optional, List

import jwt
from flask import Flask, request, jsonify, g, send_from_directory
from flask_cors import CORS

# --------- 配置 ---------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data.db")
FRONTEND_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "frontend"))

SECRET_KEY = "change-me-in-production-please"
TOKEN_EXPIRE_HOURS = 12

# 初始账号密码（首次启动写入数据库；之后用户可以自行修改）
INITIAL_USERNAME = "admin"
INITIAL_PASSWORD = "admin123"

app = Flask(__name__, static_folder=None)
CORS(app, supports_credentials=True)

# --------- 异步导入任务状态 ---------
# task_id -> { status: "running"|"done"|"error", total: int, created: int, msg: str }
import_tasks = {}


# --------- 数据库工具 ---------
def get_db():
    db = getattr(g, "_database", None)
    if db is None:
        db = g._database = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON;")
    return db


@app.teardown_appcontext
def close_db(exc):
    db = getattr(g, "_database", None)
    if db is not None:
        db.close()


def hash_password(pwd: str) -> str:
    return hashlib.sha256(pwd.encode("utf-8")).hexdigest()


def init_db():
    """初始化数据库结构与默认账号"""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        );
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER,
            priority INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            FOREIGN KEY(parent_id) REFERENCES tags(id) ON DELETE CASCADE
        );
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        """
    )
    # 兼容旧库：如果 files 表已存在但没有 updated_at 字段，做一次迁移
    cols = [r[1] for r in cur.execute("PRAGMA table_info(files)").fetchall()]
    if "updated_at" not in cols:
        cur.execute("ALTER TABLE files ADD COLUMN updated_at TEXT")
        cur.execute("UPDATE files SET updated_at = created_at WHERE updated_at IS NULL")
    # 兼容旧库：如果 tags 表没有 priority 字段，做一次迁移
    tag_cols = [r[1] for r in cur.execute("PRAGMA table_info(tags)").fetchall()]
    if "priority" not in tag_cols:
        cur.execute("ALTER TABLE tags ADD COLUMN priority INTEGER NOT NULL DEFAULT 0")
    # 兼容旧库：将已有的 [xxx] 格式标签名去掉中括号，统一为普通标签
    import re as _re_init
    bracket_rows = cur.execute("SELECT id, name FROM tags WHERE name LIKE '[%]'").fetchall()
    for br in bracket_rows:
        old_name = br[1]
        m = _re_init.match(r"^\[(.+)\]$", old_name)
        if m:
            new_name = m.group(1)
            # 检查去掉中括号后是否与同级已有标签重名
            dup = cur.execute(
                "SELECT id FROM tags WHERE name=? AND id<>?", (new_name, br[0])
            ).fetchone()
            if not dup:
                cur.execute("UPDATE tags SET name=? WHERE id=?", (new_name, br[0]))
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS file_tags (
            file_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(file_id, tag_id),
            FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
            FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);")

    # 写入初始管理员（仅当 users 表为空）
    cur.execute("SELECT COUNT(*) FROM users")
    if cur.fetchone()[0] == 0:
        cur.execute(
            "INSERT INTO users(username, password_hash) VALUES(?, ?)",
            (INITIAL_USERNAME, hash_password(INITIAL_PASSWORD)),
        )
        print(f"[init] 默认账号已创建: {INITIAL_USERNAME} / {INITIAL_PASSWORD}")

    conn.commit()
    conn.close()


# --------- 鉴权 ---------
def make_token(user_id: int, username: str) -> str:
    payload = {
        "uid": user_id,
        "username": username,
        "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=TOKEN_EXPIRE_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def auth_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        token = request.headers.get("Authorization", "")
        if token.startswith("Bearer "):
            token = token[7:]
        if not token:
            return jsonify({"code": 401, "msg": "未登录"}), 401
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            return jsonify({"code": 401, "msg": "登录已过期"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"code": 401, "msg": "无效的 token"}), 401
        g.current_user = payload
        return f(*args, **kwargs)

    return wrapper


# --------- 用户接口 ---------
@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not username or not password:
        return jsonify({"code": 400, "msg": "用户名或密码不能为空"}), 400

    db = get_db()
    row = db.execute(
        "SELECT id, username, password_hash FROM users WHERE username=?",
        (username,),
    ).fetchone()
    if not row or row["password_hash"] != hash_password(password):
        return jsonify({"code": 401, "msg": "用户名或密码错误"}), 401

    token = make_token(row["id"], row["username"])
    return jsonify(
        {"code": 0, "msg": "ok", "data": {"token": token, "username": row["username"]}}
    )


@app.post("/api/change-password")
@auth_required
def change_password():
    data = request.get_json(silent=True) or {}
    old_pwd = data.get("oldPassword") or ""
    new_pwd = data.get("newPassword") or ""
    new_username = (data.get("newUsername") or "").strip()

    if not new_pwd or len(new_pwd) < 4:
        return jsonify({"code": 400, "msg": "新密码长度至少 4 位"}), 400

    db = get_db()
    uid = g.current_user["uid"]
    row = db.execute(
        "SELECT id, username, password_hash FROM users WHERE id=?", (uid,)
    ).fetchone()
    if not row:
        return jsonify({"code": 404, "msg": "用户不存在"}), 404
    if row["password_hash"] != hash_password(old_pwd):
        return jsonify({"code": 401, "msg": "原密码错误"}), 401

    final_username = new_username or row["username"]
    # 校验用户名唯一
    if final_username != row["username"]:
        exist = db.execute(
            "SELECT 1 FROM users WHERE username=? AND id<>?", (final_username, uid)
        ).fetchone()
        if exist:
            return jsonify({"code": 400, "msg": "新用户名已被占用"}), 400

    db.execute(
        "UPDATE users SET username=?, password_hash=? WHERE id=?",
        (final_username, hash_password(new_pwd), uid),
    )
    db.commit()

    token = make_token(uid, final_username)
    return jsonify(
        {
            "code": 0,
            "msg": "修改成功",
            "data": {"token": token, "username": final_username},
        }
    )


@app.get("/api/me")
@auth_required
def me():
    return jsonify(
        {
            "code": 0,
            "data": {"username": g.current_user["username"], "uid": g.current_user["uid"]},
        }
    )


# --------- Tag 接口 ---------
def serialize_tag(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "parentId": row["parent_id"],
        "priority": row["priority"] if "priority" in row.keys() else 0,
        "createdAt": row["created_at"],
    }


@app.get("/api/tags")
@auth_required
def list_tags():
    db = get_db()
    rows = db.execute(
        "SELECT id, name, parent_id, priority, created_at FROM tags ORDER BY parent_id IS NOT NULL, parent_id, id"
    ).fetchall()
    return jsonify({"code": 0, "data": [serialize_tag(r) for r in rows]})


@app.post("/api/tags")
@auth_required
def create_tag():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    parent_id = data.get("parentId")
    priority = data.get("priority", 0)
    if not name:
        return jsonify({"code": 400, "msg": "Tag 名称不能为空"}), 400

    db = get_db()
    if parent_id:
        parent = db.execute("SELECT id FROM tags WHERE id=?", (parent_id,)).fetchone()
        if not parent:
            return jsonify({"code": 400, "msg": "父级 tag 不存在"}), 400

    # 同一父级下不允许重名
    dup = db.execute(
        "SELECT 1 FROM tags WHERE name=? AND IFNULL(parent_id,0)=IFNULL(?,0)",
        (name, parent_id),
    ).fetchone()
    if dup:
        return jsonify({"code": 400, "msg": "同级下已存在同名 tag"}), 400

    cur = db.execute(
        "INSERT INTO tags(name, parent_id, priority) VALUES(?, ?, ?)",
        (name, parent_id if parent_id else None, int(priority) if priority else 0),
    )
    db.commit()
    new_id = cur.lastrowid
    row = db.execute(
        "SELECT id, name, parent_id, priority, created_at FROM tags WHERE id=?", (new_id,)
    ).fetchone()
    return jsonify({"code": 0, "data": serialize_tag(row)})


def is_descendant(db, candidate_parent_id: int, tag_id: int) -> bool:
    """判断 candidate_parent_id 是否是 tag_id 的后代（防止形成环）"""
    cur_id = candidate_parent_id
    visited = set()
    while cur_id is not None:
        if cur_id in visited:
            return True  # 已经有环，安全起见返回 True
        visited.add(cur_id)
        if cur_id == tag_id:
            return True
        row = db.execute("SELECT parent_id FROM tags WHERE id=?", (cur_id,)).fetchone()
        if not row:
            return False
        cur_id = row["parent_id"]
    return False


@app.put("/api/tags/<int:tag_id>")
@auth_required
def update_tag(tag_id):
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    parent_id = data.get("parentId", "__no_change__")
    priority = data.get("priority", "__no_change__")

    db = get_db()
    row = db.execute("SELECT id, name, parent_id, priority FROM tags WHERE id=?", (tag_id,)).fetchone()
    if not row:
        return jsonify({"code": 404, "msg": "tag 不存在"}), 404

    new_name = name or row["name"]
    new_priority = int(priority) if priority != "__no_change__" else row["priority"]
    if parent_id == "__no_change__":
        new_parent = row["parent_id"]
    else:
        new_parent = parent_id if parent_id else None

    if new_parent == tag_id:
        return jsonify({"code": 400, "msg": "父级不能是自己"}), 400

    if new_parent is not None:
        parent_row = db.execute("SELECT id FROM tags WHERE id=?", (new_parent,)).fetchone()
        if not parent_row:
            return jsonify({"code": 400, "msg": "父级 tag 不存在"}), 400
        # 防止把自己的父级设为自己的后代，造成环
        if is_descendant(db, new_parent, tag_id):
            return jsonify({"code": 400, "msg": "不能将子孙节点设为父级"}), 400

    # 同级重名校验
    dup = db.execute(
        "SELECT 1 FROM tags WHERE name=? AND IFNULL(parent_id,0)=IFNULL(?,0) AND id<>?",
        (new_name, new_parent, tag_id),
    ).fetchone()
    if dup:
        return jsonify({"code": 400, "msg": "同级下已存在同名 tag"}), 400

    db.execute(
        "UPDATE tags SET name=?, parent_id=?, priority=? WHERE id=?",
        (new_name, new_parent, new_priority, tag_id),
    )
    db.commit()
    row = db.execute(
        "SELECT id, name, parent_id, priority, created_at FROM tags WHERE id=?", (tag_id,)
    ).fetchone()
    return jsonify({"code": 0, "data": serialize_tag(row)})


@app.post("/api/tags/bulk")
@auth_required
def bulk_create_tags():
    """批量导入 tag（同级去重、已存在则跳过）。
    入参: { names: [str], parentId?: int|null }
    返回: { created: [tag], skipped: [{name, reason}] }
    """
    data = request.get_json(silent=True) or {}
    names = data.get("names") or []
    parent_id = data.get("parentId") or None
    if not isinstance(names, list):
        return jsonify({"code": 400, "msg": "names 必须为数组"}), 400

    # 清洗
    cleaned = []
    seen = set()
    for raw in names:
        if not isinstance(raw, str):
            continue
        n = raw.strip()
        if not n:
            continue
        if n in seen:
            continue
        seen.add(n)
        cleaned.append(n)
    if not cleaned:
        return jsonify({"code": 400, "msg": "没有可导入的标签名称"}), 400

    db = get_db()
    if parent_id:
        parent = db.execute("SELECT id FROM tags WHERE id=?", (parent_id,)).fetchone()
        if not parent:
            return jsonify({"code": 400, "msg": "父级 tag 不存在"}), 400

    # 同级已有的名称
    rows = db.execute(
        "SELECT name FROM tags WHERE IFNULL(parent_id,0)=IFNULL(?,0)",
        (parent_id,),
    ).fetchall()
    existing = {r["name"] for r in rows}

    created = []
    skipped = []
    for n in cleaned:
        if n in existing:
            skipped.append({"name": n, "reason": "同级已存在"})
            continue
        cur = db.execute(
            "INSERT INTO tags(name, parent_id) VALUES(?, ?)",
            (n, parent_id),
        )
        new_id = cur.lastrowid
        row = db.execute(
            "SELECT id, name, parent_id, priority, created_at FROM tags WHERE id=?", (new_id,)
        ).fetchone()
        created.append(serialize_tag(row))
        existing.add(n)
    db.commit()
    return jsonify(
        {
            "code": 0,
            "msg": f"成功导入 {len(created)} 个，跳过 {len(skipped)} 个",
            "data": {"created": created, "skipped": skipped},
        }
    )


@app.post("/api/tags/batch-move")
@auth_required
def batch_move_tags():
    """批量移动标签到指定父级。
    入参: { ids: [int], targetParentId: int|null }
    """
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    target_parent_id = data.get("targetParentId")  # null 表示移动到顶级

    if not isinstance(ids, list) or not ids:
        return jsonify({"code": 400, "msg": "请选择要移动的标签"}), 400

    db = get_db()

    # 验证目标父级存在
    if target_parent_id:
        parent_row = db.execute("SELECT id FROM tags WHERE id=?", (target_parent_id,)).fetchone()
        if not parent_row:
            return jsonify({"code": 400, "msg": "目标父级标签不存在"}), 400
        # 不允许移动到自己的子孙下面
        for tag_id in ids:
            if tag_id == target_parent_id:
                return jsonify({"code": 400, "msg": "不能将标签移动到自身下"}), 400
            if is_descendant(db, target_parent_id, tag_id):
                tag_row = db.execute("SELECT name FROM tags WHERE id=?", (tag_id,)).fetchone()
                tag_name = tag_row["name"] if tag_row else str(tag_id)
                return jsonify({"code": 400, "msg": f"不能将 \"{tag_name}\" 移动到它自己的子孙下"}), 400

    # 获取目标级已有的标签名（用于重名检测）
    existing_rows = db.execute(
        "SELECT name FROM tags WHERE IFNULL(parent_id,0)=IFNULL(?,0) AND id NOT IN ({})".format(
            ",".join("?" * len(ids))
        ),
        [target_parent_id] + ids,
    ).fetchall()
    existing_names = {r["name"] for r in existing_rows}

    moved = 0
    skipped = []
    for tag_id in ids:
        row = db.execute("SELECT id, name FROM tags WHERE id=?", (tag_id,)).fetchone()
        if not row:
            continue
        if row["name"] in existing_names:
            skipped.append(row["name"])
            continue
        db.execute("UPDATE tags SET parent_id=? WHERE id=?", (target_parent_id if target_parent_id else None, tag_id))
        existing_names.add(row["name"])
        moved += 1

    db.commit()
    msg = f"已移动 {moved} 个标签"
    if skipped:
        msg += f"，跳过 {len(skipped)} 个（目标级下已有同名）"
    return jsonify({"code": 0, "msg": msg})


@app.get("/api/tags/stats")
@auth_required
def tag_stats():
    """返回每个标签关联的文件数量"""
    db = get_db()
    rows = db.execute(
        """
        SELECT t.id, t.name, COUNT(ft.file_id) AS file_count
        FROM tags t
        LEFT JOIN file_tags ft ON ft.tag_id = t.id
        GROUP BY t.id
        ORDER BY file_count DESC, t.id ASC
        """
    ).fetchall()
    return jsonify({
        "code": 0,
        "data": [{"id": r["id"], "name": r["name"], "count": r["file_count"]} for r in rows],
    })


@app.delete("/api/tags/<int:tag_id>")
@auth_required
def delete_tag(tag_id):
    db = get_db()
    row = db.execute("SELECT id FROM tags WHERE id=?", (tag_id,)).fetchone()
    if not row:
        return jsonify({"code": 404, "msg": "tag 不存在"}), 404
    # 检查是否有子标签
    child = db.execute("SELECT id FROM tags WHERE parent_id=?", (tag_id,)).fetchone()
    if child:
        return jsonify({"code": 400, "msg": "该标签下还有子标签，无法删除"}), 400
    # 检查是否有关联文件
    file_link = db.execute("SELECT file_id FROM file_tags WHERE tag_id=?", (tag_id,)).fetchone()
    if file_link:
        return jsonify({"code": 400, "msg": "该标签还有关联文件，无法删除"}), 400
    db.execute("DELETE FROM tags WHERE id=?", (tag_id,))
    db.commit()
    return jsonify({"code": 0, "msg": "已删除"})


# --------- 文件接口 ---------
def fetch_file_with_tags(db, file_id: int) -> Optional[dict]:
    f = db.execute(
        "SELECT id, name, created_at, updated_at FROM files WHERE id=?", (file_id,)
    ).fetchone()
    if not f:
        return None
    tag_rows = db.execute(
        """
        SELECT t.id, t.name, t.parent_id, ft.position
        FROM file_tags ft
        JOIN tags t ON t.id = ft.tag_id
        WHERE ft.file_id=?
        ORDER BY ft.position ASC, t.id ASC
        """,
        (file_id,),
    ).fetchall()
    return {
        "id": f["id"],
        "name": f["name"],
        "createdAt": f["created_at"],
        "updatedAt": f["updated_at"],
        "tags": [
            {"id": r["id"], "name": r["name"], "parentId": r["parent_id"]}
            for r in tag_rows
        ],
    }


def _validate_tag_ids(db, tag_ids) -> List[int]:
    valid = []
    seen = set()
    for tid in tag_ids or []:
        if not isinstance(tid, int) or tid in seen:
            continue
        seen.add(tid)
        if db.execute("SELECT id FROM tags WHERE id=?", (tid,)).fetchone():
            valid.append(tid)
    return valid


@app.post("/api/files")
@auth_required
def create_file():
    """保存文件名 + 关联标签
    入参: { name: str, tagIds: [int] }（tagIds 顺序代表展示顺序）
    """
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    tag_ids = data.get("tagIds") or []
    if not name:
        return jsonify({"code": 400, "msg": "文件名不能为空"}), 400
    if not isinstance(tag_ids, list):
        return jsonify({"code": 400, "msg": "tagIds 必须为数组"}), 400

    db = get_db()
    valid_tag_ids = _validate_tag_ids(db, tag_ids)

    cur = db.execute(
        "INSERT INTO files(name, created_at, updated_at) "
        "VALUES(?, datetime('now','localtime'), datetime('now','localtime'))",
        (name,),
    )
    file_id = cur.lastrowid
    for pos, tid in enumerate(valid_tag_ids):
        db.execute(
            "INSERT INTO file_tags(file_id, tag_id, position) VALUES(?, ?, ?)",
            (file_id, tid, pos),
        )
    db.commit()
    return jsonify({"code": 0, "msg": "保存成功", "data": fetch_file_with_tags(db, file_id)})


@app.put("/api/files/<int:file_id>")
@auth_required
def update_file(file_id):
    """更新已有文件的名称 / 标签，并刷新 updated_at"""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    tag_ids = data.get("tagIds")
    if not name:
        return jsonify({"code": 400, "msg": "文件名不能为空"}), 400

    db = get_db()
    row = db.execute("SELECT id FROM files WHERE id=?", (file_id,)).fetchone()
    if not row:
        return jsonify({"code": 404, "msg": "文件不存在"}), 404

    db.execute(
        "UPDATE files SET name=?, updated_at=datetime('now','localtime') WHERE id=?",
        (name, file_id),
    )
    if isinstance(tag_ids, list):
        valid_tag_ids = _validate_tag_ids(db, tag_ids)
        db.execute("DELETE FROM file_tags WHERE file_id=?", (file_id,))
        for pos, tid in enumerate(valid_tag_ids):
            db.execute(
                "INSERT INTO file_tags(file_id, tag_id, position) VALUES(?, ?, ?)",
                (file_id, tid, pos),
            )
    db.commit()
    return jsonify({"code": 0, "msg": "更新成功", "data": fetch_file_with_tags(db, file_id)})


@app.get("/api/files")
@auth_required
def list_files():
    """文件列表
    支持参数:
      - keyword: 文件名模糊搜索
      - tagIds:  逗号分隔的 tag id 列表，按 AND 过滤（同时包含全部）
      - mode:    "all"（默认，AND） | "any"（OR）
      - dateFrom: 保存时间起始（含），格式 YYYY-MM-DD
      - dateTo:   保存时间截止（含），格式 YYYY-MM-DD
    """
    db = get_db()
    keyword = (request.args.get("keyword") or "").strip()
    tag_ids_raw = (request.args.get("tagIds") or "").strip()
    mode = (request.args.get("mode") or "all").strip().lower()
    date_from = (request.args.get("dateFrom") or "").strip()
    date_to = (request.args.get("dateTo") or "").strip()

    tag_ids = []
    if tag_ids_raw:
        for s in tag_ids_raw.split(","):
            s = s.strip()
            if s.isdigit():
                tag_ids.append(int(s))

    sql = "SELECT f.id FROM files f WHERE 1=1"
    params: list = []
    if keyword:
        sql += " AND f.name LIKE ?"
        params.append(f"%{keyword}%")

    # 按保存时间范围过滤（基于 created_at 字段）
    if date_from:
        sql += " AND f.created_at >= ?"
        params.append(f"{date_from} 00:00:00")
    if date_to:
        sql += " AND f.created_at <= ?"
        params.append(f"{date_to} 23:59:59")

    if tag_ids:
        placeholders = ",".join("?" * len(tag_ids))
        if mode == "any":
            sql += f" AND f.id IN (SELECT file_id FROM file_tags WHERE tag_id IN ({placeholders}))"
            params.extend(tag_ids)
        else:
            # AND：必须包含全部 tag
            sql += (
                f" AND f.id IN ("
                f"SELECT file_id FROM file_tags WHERE tag_id IN ({placeholders}) "
                f"GROUP BY file_id HAVING COUNT(DISTINCT tag_id)=?"
                f")"
            )
            params.extend(tag_ids)
            params.append(len(tag_ids))

    sql += " ORDER BY f.updated_at DESC, f.id DESC"

    # 分页
    page = request.args.get("page", "1")
    page_size = request.args.get("pageSize", "20")
    try:
        page = max(1, int(page))
    except (ValueError, TypeError):
        page = 1
    try:
        page_size = max(1, min(200, int(page_size)))
    except (ValueError, TypeError):
        page_size = 20

    # 先查总数
    count_sql = f"SELECT COUNT(*) FROM ({sql})"
    total = db.execute(count_sql, params).fetchone()[0]

    # 分页取数据
    sql += " LIMIT ? OFFSET ?"
    params.append(page_size)
    params.append((page - 1) * page_size)

    rows = db.execute(sql, params).fetchall()
    files = [fetch_file_with_tags(db, r["id"]) for r in rows]
    return jsonify({
        "code": 0,
        "data": files,
        "total": total,
        "page": page,
        "pageSize": page_size,
    })


def _do_import_in_background(task_id: str, lines: list):
    """后台线程执行导入"""
    import re as _re

    task = import_tasks[task_id]
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row

    created_count = 0
    failed_count = 0
    current_category = None
    tag_cache = {}
    BATCH_SIZE = 500

    try:
        for line in lines:
            # 解析行首所有 [xxx] 方括号内容
            file_date = None
            bracket_tags = []  # 方括号内的标签（去掉[]作为普通标签存储）
            rest = line
            while True:
                bm = _re.match(r"^\[([^\]]*)\](.*)$", rest)
                if not bm:
                    break
                bracket_content = bm.group(1).strip()
                rest = bm.group(2)
                if _re.match(r"^\d{8}$", bracket_content):
                    # 日期
                    file_date = f"{bracket_content[:4]}-{bracket_content[4:6]}-{bracket_content[6:8]}"
                else:
                    # 非日期的方括号内容作为普通标签（不带[]存储）
                    if bracket_content:
                        bracket_tags.append(bracket_content)

            # 如果整行只有一个非日期的方括号且后面没有内容，视为分类标题
            if not rest.strip() and not bracket_tags and not file_date:
                # 原始行只有一个方括号且不是日期 -> 分类
                bm2 = _re.match(r"^\[([^\]]*)\]$", line.strip())
                if bm2:
                    current_category = bm2.group(1).strip()
                    continue
                else:
                    continue
            if not rest.strip() and bracket_tags and not file_date:
                # 整行只有 [非日期方括号]，没有文件名部分 -> 视为分类标题
                if len(bracket_tags) == 1 and not _re.match(r"^\[([^\]]*)\](.+)$", line.strip()):
                    current_category = bracket_tags[0]
                    continue

            body = rest

            idx = body.rfind("_")
            if idx == -1:
                file_name = body.strip()
                tag_names = []
            else:
                file_name = body[:idx].strip()
                tag_part = body[idx + 1:]
                tag_names = [t.strip() for t in tag_part.split(".") if t.strip()]

            if not file_name:
                continue

            # 将方括号内解析出的标签加入 tag_names（已去掉[]）
            for bt in bracket_tags:
                if bt not in tag_names:
                    tag_names.append(bt)

            if current_category and current_category not in tag_names:
                tag_names.append(current_category)

            # 标签名去重（保持原顺序），避免 file_tags 复合主键冲突
            _seen = set()
            tag_names = [t for t in tag_names if not (t in _seen or _seen.add(t))]

            # 查找/创建标签（使用缓存）
            tag_ids = []
            for tname in tag_names:
                if tname in tag_cache:
                    tag_ids.append(tag_cache[tname])
                else:
                    row = conn.execute("SELECT id FROM tags WHERE name=?", (tname,)).fetchone()
                    if row:
                        tag_cache[tname] = row["id"]
                        tag_ids.append(row["id"])
                    else:
                        cur_tag = conn.execute(
                            "INSERT INTO tags(name, parent_id) VALUES(?, NULL)", (tname,)
                        )
                        tag_cache[tname] = cur_tag.lastrowid
                        tag_ids.append(cur_tag.lastrowid)

            if file_date:
                created_at = f"{file_date} 00:00:00"
            else:
                created_at = None

            # tag_ids 再次去重，防御性处理
            seen_tid = set()
            unique_tag_ids = [t for t in tag_ids if not (t in seen_tid or seen_tid.add(t))]

            try:
                cur = conn.execute(
                    "INSERT INTO files(name, created_at, updated_at) "
                    "VALUES(?, COALESCE(?, datetime('now','localtime')), datetime('now','localtime'))",
                    (file_name, created_at),
                )
                file_id = cur.lastrowid
                for pos, tid in enumerate(unique_tag_ids):
                    # 使用 OR IGNORE 避免极端情况下的复合主键冲突导致整批失败
                    conn.execute(
                        "INSERT OR IGNORE INTO file_tags(file_id, tag_id, position) VALUES(?, ?, ?)",
                        (file_id, tid, pos),
                    )
                created_count += 1
            except Exception as ex:
                # 单条失败不影响整批：回滚当前未提交事务，记录失败
                failed_count += 1
                try:
                    conn.rollback()
                except Exception:
                    pass
                task["msg"] = f"导入中... (已跳过 {failed_count} 条异常: {str(ex)[:80]})"

            # 分批提交
            if created_count % BATCH_SIZE == 0 and created_count > 0:
                conn.commit()
                task["created"] = created_count

        conn.commit()
        task["created"] = created_count
        task["status"] = "done"
        if failed_count:
            task["msg"] = f"导入完成，成功 {created_count} 条，跳过 {failed_count} 条异常"
        else:
            task["msg"] = f"导入完成，共 {created_count} 条"
    except Exception as e:
        task["status"] = "error"
        task["msg"] = f"导入失败: {str(e)}"
    finally:
        conn.close()


@app.post("/api/files/import")
@auth_required
def import_files():
    """批量导入文件（异步）
    入参: { text: str }
    立即返回 task_id，后台线程执行导入，前端轮询 /api/files/import/status 获取进度。
    """
    data = request.get_json(silent=True) or {}
    text = data.get("text") or ""
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if not lines:
        return jsonify({"code": 400, "msg": "内容为空"}), 400

    task_id = uuid.uuid4().hex[:12]
    import_tasks[task_id] = {
        "status": "running",
        "total": len(lines),
        "created": 0,
        "msg": "导入中...",
    }

    t = threading.Thread(target=_do_import_in_background, args=(task_id, lines), daemon=True)
    t.start()

    return jsonify({"code": 0, "msg": "导入任务已启动", "data": {"taskId": task_id}})


@app.get("/api/files/import/status")
@auth_required
def import_status():
    """查询导入任务进度"""
    task_id = request.args.get("taskId") or ""
    task = import_tasks.get(task_id)
    if not task:
        return jsonify({"code": 404, "msg": "任务不存在"}), 404

    resp = {
        "code": 0,
        "data": {
            "taskId": task_id,
            "status": task["status"],
            "total": task["total"],
            "created": task["created"],
            "msg": task["msg"],
        },
    }

    # 任务结束后清理（延迟清理，让前端有机会拿到最终状态）
    if task["status"] in ("done", "error"):
        # 标记待清理，下次查询时删除
        if task.get("_queried_final"):
            del import_tasks[task_id]
        else:
            task["_queried_final"] = True

    return jsonify(resp)


@app.get("/api/files/export")
@auth_required
def export_files():
    """导出文件，支持按标签分组。
    查询参数:
      tag_ids: 逗号分隔的标签 id，为空则导出所有
      sort: name(默认按文件名) | date(按日期)
      group: 1(按标签分组) | 0(不分组，默认)
    """
    from flask import Response
    db = get_db()

    tag_ids_str = request.args.get("tag_ids", "").strip()
    sort_by = request.args.get("sort", "name").strip()
    group_mode = request.args.get("group", "0").strip()

    tag_ids = [int(x) for x in tag_ids_str.split(",") if x.strip().isdigit()] if tag_ids_str else []

    # 查询文件
    if tag_ids:
        placeholders = ",".join("?" * len(tag_ids))
        file_rows = db.execute(
            f"""SELECT DISTINCT f.id, f.name, f.created_at
                FROM files f
                JOIN file_tags ft ON ft.file_id = f.id
                WHERE ft.tag_id IN ({placeholders})
                ORDER BY f.id DESC""",
            tag_ids,
        ).fetchall()
    else:
        file_rows = db.execute(
            "SELECT id, name, created_at FROM files ORDER BY id DESC"
        ).fetchall()

    # 为每个文件获取标签
    file_data = []
    for r in file_rows:
        file_id = r["id"]
        name = r["name"]
        date_str = (r["created_at"] or "")[:10].replace("-", "")
        tag_rows = db.execute(
            "SELECT t.id, t.name, t.priority FROM file_tags ft JOIN tags t ON t.id=ft.tag_id "
            "WHERE ft.file_id=? ORDER BY ft.position ASC",
            (file_id,),
        ).fetchall()
        tag_id_list = [t["id"] for t in tag_rows]

        # 所有标签按 priority 升序排列（数字越小优先级越高，排越前面）
        sorted_tags = sorted(tag_rows, key=lambda t: t["priority"])
        all_tag_names = [t["name"] for t in sorted_tags]

        # 构建显示行：[日期]文件名_标签1.标签2
        tag_part = ".".join(all_tag_names)
        if tag_part:
            display = f"[{date_str}]{name}_{tag_part}"
        else:
            display = f"[{date_str}]{name}"

        file_data.append({
            "id": file_id,
            "name": name,
            "date_str": date_str,
            "display": display,
            "tag_ids": tag_id_list,
            "tag_names": all_tag_names,
        })

    # 排序
    if sort_by == "date":
        file_data.sort(key=lambda x: (x["date_str"], x["name"].lower()))
    else:
        file_data.sort(key=lambda x: x["name"].lower())

    # 分组输出
    if group_mode == "1" and tag_ids:
        # 按标签分组 —— 每个文件归入它拥有的每个被选中的标签组
        group_tag_rows = db.execute(
            f"SELECT id, name FROM tags WHERE id IN ({','.join('?' * len(tag_ids))})",
            tag_ids,
        ).fetchall()

        groups = {}
        for gt in group_tag_rows:
            groups[gt["id"]] = {"name": gt["name"], "files": []}

        ungrouped = []
        for fd in file_data:
            placed = False
            for tid in fd["tag_ids"]:
                if tid in groups:
                    groups[tid]["files"].append(fd["display"])
                    placed = True
            if not placed:
                ungrouped.append(fd["display"])

        lines = []
        for tid, g in groups.items():
            if g["files"]:
                lines.append(f"[{g['name']}]")
                for f in g["files"]:
                    lines.append(f)
                lines.append("")  # 空行分隔

        if ungrouped:
            lines.append("[未分类]")
            for f in ungrouped:
                lines.append(f)
            lines.append("")

        content = "\n".join(lines).strip()
    else:
        content = "\n".join(fd["display"] for fd in file_data)

    return Response(
        content,
        mimetype="text/plain; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=files_export.txt"},
    )


@app.get("/api/files/stats")
@auth_required
def file_stats():
    """文件统计
    支持参数:
      - groupBy: "tag"（按标签统计） | "date"（按日期统计，默认）
      - dateFrom: 起始日期（含），格式 YYYY-MM-DD
      - dateTo:   截止日期（含），格式 YYYY-MM-DD
      - tagIds:   逗号分隔的 tag id，限定范围
    """
    db = get_db()
    group_by = (request.args.get("groupBy") or "date").strip().lower()
    date_from = (request.args.get("dateFrom") or "").strip()
    date_to = (request.args.get("dateTo") or "").strip()
    tag_ids_raw = (request.args.get("tagIds") or "").strip()

    tag_ids = []
    if tag_ids_raw:
        for s in tag_ids_raw.split(","):
            s = s.strip()
            if s.isdigit():
                tag_ids.append(int(s))

    if group_by == "tag":
        # 按标签统计：每个标签关联多少文件
        sql = """
            SELECT t.id AS tag_id, t.name AS tag_name, COUNT(DISTINCT ft.file_id) AS file_count
            FROM tags t
            LEFT JOIN file_tags ft ON ft.tag_id = t.id
            LEFT JOIN files f ON f.id = ft.file_id
            WHERE 1=1
        """
        params = []
        if date_from:
            sql += " AND f.created_at >= ?"
            params.append(f"{date_from} 00:00:00")
        if date_to:
            sql += " AND f.created_at <= ?"
            params.append(f"{date_to} 23:59:59")
        if tag_ids:
            placeholders = ",".join("?" * len(tag_ids))
            sql += f" AND t.id IN ({placeholders})"
            params.extend(tag_ids)
        sql += " GROUP BY t.id ORDER BY file_count DESC, t.id ASC"
        rows = db.execute(sql, params).fetchall()
        data = [{"label": r["tag_name"], "id": r["tag_id"], "count": r["file_count"]} for r in rows if r["file_count"] > 0]
    else:
        # 按日期统计：每天有多少文件
        sql = """
            SELECT DATE(f.created_at) AS day, COUNT(*) AS file_count
            FROM files f
            WHERE 1=1
        """
        params = []
        if date_from:
            sql += " AND f.created_at >= ?"
            params.append(f"{date_from} 00:00:00")
        if date_to:
            sql += " AND f.created_at <= ?"
            params.append(f"{date_to} 23:59:59")
        if tag_ids:
            placeholders = ",".join("?" * len(tag_ids))
            sql += f" AND f.id IN (SELECT file_id FROM file_tags WHERE tag_id IN ({placeholders}))"
            params.extend(tag_ids)
        sql += " GROUP BY day ORDER BY day DESC"
        rows = db.execute(sql, params).fetchall()
        data = [{"label": r["day"], "count": r["file_count"]} for r in rows]

    total = sum(item["count"] for item in data)
    return jsonify({"code": 0, "data": data, "total": total})


@app.delete("/api/files/<int:file_id>")
@auth_required
def delete_file(file_id):
    db = get_db()
    row = db.execute("SELECT id FROM files WHERE id=?", (file_id,)).fetchone()
    if not row:
        return jsonify({"code": 404, "msg": "文件不存在"}), 404
    db.execute("DELETE FROM files WHERE id=?", (file_id,))
    db.commit()
    return jsonify({"code": 0, "msg": "已删除"})


@app.post("/api/files/batch-add-tags")
@auth_required
def batch_add_tags():
    """批量为文件添加标签，入参: { fileIds: [int], tagIds: [int] }"""
    data = request.get_json(silent=True) or {}
    file_ids = data.get("fileIds") or []
    tag_ids = data.get("tagIds") or []
    if not file_ids or not tag_ids:
        return jsonify({"code": 400, "msg": "fileIds 和 tagIds 不能为空"}), 400
    db = get_db()
    valid_tag_ids = _validate_tag_ids(db, tag_ids)
    if not valid_tag_ids:
        return jsonify({"code": 400, "msg": "所选标签不存在"}), 400
    count = 0
    for fid in file_ids:
        # 获取当前文件已有的最大 position
        max_pos_row = db.execute(
            "SELECT MAX(position) FROM file_tags WHERE file_id=?", (fid,)
        ).fetchone()
        pos = (max_pos_row[0] or 0) + 1
        for tid in valid_tag_ids:
            # 如果已存在则跳过
            exists = db.execute(
                "SELECT 1 FROM file_tags WHERE file_id=? AND tag_id=?", (fid, tid)
            ).fetchone()
            if not exists:
                db.execute(
                    "INSERT INTO file_tags(file_id, tag_id, position) VALUES(?, ?, ?)",
                    (fid, tid, pos),
                )
                pos += 1
                count += 1
        db.execute(
            "UPDATE files SET updated_at=datetime('now','localtime') WHERE id=?", (fid,)
        )
    db.commit()
    return jsonify({"code": 0, "msg": f"已为 {len(file_ids)} 个文件添加标签（新增 {count} 条关联）"})


@app.post("/api/files/batch-remove-tags")
@auth_required
def batch_remove_tags():
    """批量移除文件的标签，入参: { fileIds: [int], tagIds: [int] }"""
    data = request.get_json(silent=True) or {}
    file_ids = data.get("fileIds") or []
    tag_ids = data.get("tagIds") or []
    if not file_ids or not tag_ids:
        return jsonify({"code": 400, "msg": "fileIds 和 tagIds 不能为空"}), 400
    db = get_db()
    f_placeholders = ",".join("?" * len(file_ids))
    t_placeholders = ",".join("?" * len(tag_ids))
    db.execute(
        f"DELETE FROM file_tags WHERE file_id IN ({f_placeholders}) AND tag_id IN ({t_placeholders})",
        file_ids + tag_ids,
    )
    for fid in file_ids:
        db.execute(
            "UPDATE files SET updated_at=datetime('now','localtime') WHERE id=?", (fid,)
        )
    db.commit()
    return jsonify({"code": 0, "msg": f"已从 {len(file_ids)} 个文件移除所选标签"})


@app.post("/api/files/batch-rename")
@auth_required
def batch_rename_files():
    """批量重命名文件（查找替换，支持正则表达式）
    入参: { fileIds: [int], search: str, replace: str, useRegex: bool }
    将每个文件名中的 search 替换为 replace
    当 useRegex 为 true 时，search 作为正则表达式使用，replace 中可使用 \\1 等反向引用
    """
    import re as _re

    data = request.get_json(silent=True) or {}
    file_ids = data.get("fileIds") or []
    search = data.get("search", "")
    replace_str = data.get("replace", "")
    use_regex = data.get("useRegex", False)
    if not file_ids:
        return jsonify({"code": 400, "msg": "fileIds 不能为空"}), 400
    if not search:
        return jsonify({"code": 400, "msg": "查找内容不能为空"}), 400

    # 如果使用正则表达式，先验证语法
    regex_pattern = None
    if use_regex:
        try:
            regex_pattern = _re.compile(search)
        except _re.error as e:
            return jsonify({"code": 400, "msg": f"正则表达式语法错误：{str(e)}"}), 400
        # 将前端 JS 风格的替换引用 ($1, $2, $&) 转换为 Python re.sub 风格 (\1, \2, \g<0>)
        replace_str = _re.sub(r'\$&', r'\\g<0>', replace_str)  # $& -> 整个匹配
        replace_str = _re.sub(r'\$(\d+)', lambda m: '\\' + m.group(1), replace_str)  # $1 -> \1

    db = get_db()
    renamed_count = 0
    for fid in file_ids:
        row = db.execute("SELECT id, name FROM files WHERE id=?", (fid,)).fetchone()
        if not row:
            continue
        old_name = row["name"]
        if use_regex:
            new_name = regex_pattern.sub(replace_str, old_name)
        else:
            new_name = old_name.replace(search, replace_str)
        if new_name != old_name:
            if not new_name.strip():
                continue  # 替换后为空则跳过
            db.execute(
                "UPDATE files SET name=?, updated_at=datetime('now','localtime') WHERE id=?",
                (new_name.strip(), fid),
            )
            renamed_count += 1
    db.commit()
    return jsonify({"code": 0, "msg": f"已重命名 {renamed_count} 个文件"})


@app.post("/api/files/<int:file_id>/rename")
@auth_required
def rename_file(file_id):
    """单个文件重命名
    入参: { name: str }
    """
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"code": 400, "msg": "文件名不能为空"}), 400

    db = get_db()
    row = db.execute("SELECT id FROM files WHERE id=?", (file_id,)).fetchone()
    if not row:
        return jsonify({"code": 404, "msg": "文件不存在"}), 404

    db.execute(
        "UPDATE files SET name=?, updated_at=datetime('now','localtime') WHERE id=?",
        (name, file_id),
    )
    db.commit()
    return jsonify({"code": 0, "msg": "重命名成功", "data": fetch_file_with_tags(db, file_id)})


@app.post("/api/files/batch-delete")
@auth_required
def batch_delete_files():
    """批量删除文件，入参: { ids: [int] }"""
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"code": 400, "msg": "ids 不能为空"}), 400
    db = get_db()
    placeholders = ",".join("?" * len(ids))
    db.execute(f"DELETE FROM file_tags WHERE file_id IN ({placeholders})", ids)
    db.execute(f"DELETE FROM files WHERE id IN ({placeholders})", ids)
    db.commit()
    return jsonify({"code": 0, "msg": f"已删除 {len(ids)} 条"})


# --------- 静态文件托管（前端） ---------
@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    # 仅服务 frontend 目录下的文件
    target = os.path.join(FRONTEND_DIR, filename)
    if os.path.isfile(target):
        return send_from_directory(FRONTEND_DIR, filename)
    # SPA 兜底
    return send_from_directory(FRONTEND_DIR, "index.html")


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5051, debug=True)
