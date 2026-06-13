# Tag 管理系统

一个基于 **Python (Flask) + SQLite + Vue 3** 的轻量级 Tag 管理系统，支持标签层级管理、文件关联、导入导出等功能。

## 功能特性

- 🔐 用户登录 / 修改账号密码（初始账号 `admin / admin123`）
- 🏷️ Tag 增 / 删 / 改 / 查，支持树形层级（父级删除级联子孙）
- 📁 文件管理，支持为文件打标签、批量操作
- ☁️ 标签云展示（云朵形状分布，悬停显示关联文件数，支持缩放/平移）
- 📝 文件名生成器，选择标签自动组合文件名
- 📊 文件统计面板
- 🔍 标签模糊搜索、可搜索标签选择器
- 📦 各功能卡片支持折叠/展开（文件名生成器、标签云、文件列表、文件统计）
- 📤 导出功能：支持选择标签、按标签分组、按名称/日期排序
- 📥 导入功能：支持解析 `[YYYYMMDD]` 格式的日期
- 前端使用 Vue 3 + Element Plus（CDN 引入，零构建）
- 后端使用 Flask + SQLite，并直接静态托管前端

## 目录结构

```
tags/
├── backend/
│   ├── app.py              # Flask 应用主入口
│   ├── requirements.txt    # Python 依赖
│   └── data.db             # 首次启动后自动生成（已 gitignore）
├── frontend/
│   ├── index.html          # 单页入口
│   ├── app.js              # Vue 应用代码
│   └── styles.css          # 样式
├── .gitignore
└── README.md
```

## 快速启动

### 1. 安装后端依赖

建议用虚拟环境：

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
```

### 2. 启动服务

```bash
python app.py
```

启动后会监听 `http://localhost:5050`，并自动：

- 在 `backend/data.db` 创建 SQLite 数据库
- 写入默认账号：`admin / admin123`（仅首次启动时）

### 3. 访问前端

直接在浏览器访问：

```
http://localhost:5050/
```

Flask 已经把 `frontend/` 目录作为静态资源托管，无需另起前端服务。

> 如果你想前端独立部署（例如用 nginx），把 `frontend/` 整个目录拷到任意静态服务器即可，并在 `frontend/app.js` 顶部把 `API_BASE` 改成后端实际地址。

## 默认账号 & 修改方式

- 默认：`admin / admin123`（登录页面不会预填，需手动输入）
- 登录后，点击右上角「修改账号/密码」即可修改
- 数据保存在 `backend/data.db`，删除该文件即可恢复初始状态

## 后端 API 一览

所有写接口都需要 `Authorization: Bearer <token>` 头。

| 方法   | 路径                       | 说明                       |
| ------ | -------------------------- | -------------------------- |
| POST   | `/api/login`               | 登录，返回 token           |
| POST   | `/api/change-password`     | 修改账号 / 密码            |
| GET    | `/api/me`                  | 获取当前用户信息           |
| GET    | `/api/tags`                | 列出所有 Tag（平铺）       |
| POST   | `/api/tags`                | 新增 Tag                   |
| PUT    | `/api/tags/<id>`           | 修改 Tag（名称 / 父级）    |
| DELETE | `/api/tags/<id>`           | 删除 Tag（级联子孙）       |
| POST   | `/api/tags/bulk`           | 批量操作 Tag               |
| GET    | `/api/tags/stats`          | 标签统计信息               |
| GET    | `/api/files`               | 文件列表                   |
| POST   | `/api/files`               | 新增文件                   |
| PUT    | `/api/files/<id>`          | 修改文件                   |
| DELETE | `/api/files/<id>`          | 删除文件                   |
| POST   | `/api/files/batch-delete`  | 批量删除文件               |
| POST   | `/api/files/import`        | 导入文件                   |
| GET    | `/api/files/export`        | 导出文件                   |

### 导出参数

| 参数       | 说明                                         |
| ---------- | -------------------------------------------- |
| `tag_ids`  | 逗号分隔的标签 ID，可选                      |
| `sort`     | 排序方式：`name`（文件名）或 `date`（日期）  |
| `group`    | 是否按标签分组：`1` 是 / `0` 否             |

导出文件名格式：`tag_YYYYMMDDHHmm.txt`

### 请求示例

```bash
# 登录
curl -X POST http://localhost:5050/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# 创建顶级 tag
curl -X POST http://localhost:5050/api/tags \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"前端"}'

# 创建子 tag
curl -X POST http://localhost:5050/api/tags \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Vue","parentId":1}'
```

## 数据模型

```sql
users(id, username UNIQUE, password_hash)
tags(id, name, parent_id -> tags.id ON DELETE CASCADE, created_at)
files(id, name, created_at, updated_at)
file_tags(file_id, tag_id, position)  -- 多对多关联
```

- 同一父级下不允许同名 tag
- 修改父级时会校验，不允许把父级设为自己或自己的子孙（防止环）
- 文件与标签通过 `file_tags` 表多对多关联，支持排序位置

## 安全说明

- 这是一个面向内部 / 个人使用的轻量项目：
  - 密码使用 SHA-256 哈希（无 salt），生产环境请换成 `bcrypt` / `argon2`
  - JWT 密钥写死在 `app.py` 的 `SECRET_KEY`，部署前请修改
  - 默认未启用 HTTPS，公网部署请放在反向代理（nginx / caddy）后
