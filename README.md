# ⚖️ 两两决策台（Pairwise Decision Desk）

粘贴 3～12 个候选项，逐对比较并记录胜者或平局，系统按 **Schulze 最强路径法** 实时计算排名。

- 后端：FastAPI + SQLite（标准库 `sqlite3`，无额外依赖）
- 前端：原生 HTML / CSS / JavaScript（单页，无构建步骤）
- 进度持久化：评审记录存入 SQLite，浏览器刷新后自动恢复

## 🚀 启动（唯一命令）

```bash
docker compose up --build
```

该命令会自动完成：构建镜像 → 安装依赖 → 启动服务（首次启动时自动创建 SQLite 数据库与表结构）。

启动后访问：

| 项目 | 地址 |
| ---- | ---- |
| 网页 | <http://localhost:8000> |
| API 文档（Swagger） | <http://localhost:8000/docs> |

停止：`Ctrl + C`；删除持久化数据：`docker compose down -v`。

## ⚙️ 配置

| 配置项 | 默认值 | 说明 |
| ---- | ---- | ---- |
| 对外端口 | `8000` | 修改 `docker-compose.yml` 中 `ports` 左侧端口，如 `"9000:8000"` |
| `DECISION_DB` | `/app/data/decision.db` | 容器内 SQLite 数据库文件路径，在 `docker-compose.yml` 的 `environment` 中调整 |
| 数据卷 | `decision-data` | 挂载到容器 `/app/data`，用于持久化评审进度 |

## 🖱️ 使用说明

1. **录入候选项**：每行一个，3～12 个，名称不可重复，点击「开始评审」。
2. **逐对评审**：界面依次展示每一对组合，点击左侧 / 右侧按钮选择胜者，或点「平局」。
   快捷键：`←` 左边胜、`→` 右边胜、`↓` 平局、`Ctrl+Z` 撤销。
3. **实时排名**：按 Schulze 最强路径法计算，并列的候选项归入同一名次组（以「＝」连接，黄色徽标）。
4. **尚未比较的组合**：以标签形式列出所有待比较组合。
5. **胜负矩阵**：行 vs 列，`✓` 行胜、`✗` 行负、`＝` 平局、`·` 未比较。
6. **撤销 / 重置**：「撤销上一判断」回退最近一次判断；「重置本轮」清空本轮全部判断（保留候选项）；「新一轮」重新录入候选项。
7. 刷新页面后进度自动恢复（会话 ID 存于浏览器 localStorage，数据存于 SQLite）。

## 🧮 排名算法

Schulze 最强路径法：路径强度为路径上最弱一环，最强路径取各路径最大值。
计票约定：胜 = 1，平局 = 0.5（双向），未比较 = 0。
候选项 X 严格优于 Y 当且仅当 `p(X,Y) > p(Y,X)`，相等则并列，据此划分有序并列组。

## 📡 API 概览

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/api/sessions` | 创建评审会话（body: `{"candidates": [...]}`） |
| GET | `/api/sessions/{id}` | 获取完整状态（进度、当前对、排名、矩阵、待比较组合） |
| POST | `/api/sessions/{id}/judgments` | 记录当前对的判断（body: `{"a","b","result": "a"\|"b"\|"tie"}`） |
| POST | `/api/sessions/{id}/undo` | 撤销最近一次判断 |
| POST | `/api/sessions/{id}/reset` | 重置本轮全部判断 |

## 📁 项目结构

```
├── app/
│   ├── main.py          # FastAPI 应用、API、SQLite 持久化
│   ├── schulze.py       # Schulze 最强路径法排名
│   └── static/          # 前端（index.html / style.css / app.js）
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
└── README.md
```
