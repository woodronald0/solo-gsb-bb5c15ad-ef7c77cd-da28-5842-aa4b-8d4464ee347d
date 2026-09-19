"""两两决策台 —— FastAPI 后端。

逐对比较候选项，按 Schulze 最强路径法实时排名。
进度持久化在 SQLite 中，刷新页面不丢失。
"""
from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import asynccontextmanager
from itertools import combinations
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .schulze import rank_groups, shortest_strict_cycle, strongest_paths

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = os.environ.get("DECISION_DB", str(BASE_DIR / "data" / "decision.db"))

MIN_CANDIDATES = 3
MAX_CANDIDATES = 12
MAX_NAME_LEN = 80

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    candidates TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS judgments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('a', 'b', 'tie'))
);
CREATE INDEX IF NOT EXISTS idx_judgments_session ON judgments(session_id);
"""


def get_conn() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA)


init_db()  # 模块加载即建库建表（幂等），lifespan 中再执行一次以确保任意部署方式下可用


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="两两决策台", lifespan=lifespan)


# ---------- 请求模型 ----------

class SessionCreate(BaseModel):
    candidates: list[str] = Field(min_length=MIN_CANDIDATES, max_length=MAX_CANDIDATES)


class JudgmentCreate(BaseModel):
    a: str
    b: str
    result: Literal["a", "b", "tie"]


# ---------- 状态组装 ----------

def load_state(conn: sqlite3.Connection, session_id: str) -> dict:
    row = conn.execute("SELECT candidates FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="会话不存在或已被删除")
    candidates: list[str] = json.loads(row["candidates"])
    order = {name: i for i, name in enumerate(candidates)}

    history: list[dict] = []
    judged: dict[tuple[str, str], str] = {}
    for r in conn.execute(
        "SELECT a, b, result FROM judgments WHERE session_id = ? ORDER BY id", (session_id,)
    ):
        judged[(r["a"], r["b"])] = r["result"]
        history.append({"a": r["a"], "b": r["b"], "result": r["result"]})

    pairs, pending = [], []
    for a, b in combinations(candidates, 2):
        result = judged.get((a, b))
        pairs.append({"a": a, "b": b, "result": result})
        if result is None:
            pending.append({"a": a, "b": b})

    p = strongest_paths(candidates, history)
    groups = rank_groups(candidates, p)

    # 胜负矩阵：行 vs 列
    n = len(candidates)
    matrix: list[list[str]] = []
    for i in range(n):
        cells = []
        for j in range(n):
            if i == j:
                cells.append("self")
                continue
            a, b = (candidates[i], candidates[j]) if i < j else (candidates[j], candidates[i])
            result = judged.get((a, b))
            if result is None:
                cells.append("pending")
            elif result == "tie":
                cells.append("tie")
            elif (result == "a") == (i < j):
                cells.append("win")
            else:
                cells.append("lose")
        matrix.append(cells)

    # 循环冲突复核：只由严格胜负边构成的最短有向环（平局、未比较不成边）
    cycle = shortest_strict_cycle(candidates, history)
    conflict = None
    if cycle is not None:
        edges = []
        for i in range(len(cycle)):
            x, y = cycle[i], cycle[(i + 1) % len(cycle)]
            a, b = (x, y) if order[x] < order[y] else (y, x)
            result = judged[(a, b)]
            edges.append(
                {
                    "a": a,
                    "b": b,
                    "result": result,
                    "winner": a if result == "a" else b,
                }
            )
        conflict = {"cycle": cycle, "edges": edges}

    return {
        "session_id": session_id,
        "candidates": candidates,
        "progress": {"done": len(history), "total": len(pairs)},
        "current_pair": pending[0] if pending else None,
        "pending": pending,
        "ranking": groups,
        "matrix": matrix,
        "conflict": conflict,
        "can_undo": bool(history),
    }


# ---------- API ----------

@app.post("/api/sessions", status_code=201)
def create_session(payload: SessionCreate):
    names, seen = [], set()
    for raw in payload.candidates:
        name = " ".join(raw.split())
        if not name:
            continue
        if len(name) > MAX_NAME_LEN:
            raise HTTPException(422, f"候选项名称过长（>{MAX_NAME_LEN} 字符）：{name[:20]}…")
        if name in seen:
            raise HTTPException(422, f"候选项重复：{name}")
        seen.add(name)
        names.append(name)
    if not (MIN_CANDIDATES <= len(names) <= MAX_CANDIDATES):
        raise HTTPException(422, f"有效候选项数量须为 {MIN_CANDIDATES}～{MAX_CANDIDATES} 个")

    sid = uuid.uuid4().hex[:12]
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO sessions (id, candidates) VALUES (?, ?)",
            (sid, json.dumps(names, ensure_ascii=False)),
        )
        conn.commit()
        return load_state(conn, sid)
    finally:
        conn.close()


@app.get("/api/sessions/{sid}")
def get_session(sid: str):
    conn = get_conn()
    try:
        return load_state(conn, sid)
    finally:
        conn.close()


@app.post("/api/sessions/{sid}/judgments", status_code=201)
def judge(sid: str, payload: JudgmentCreate):
    conn = get_conn()
    try:
        state = load_state(conn, sid)
        current = state["current_pair"]
        if current is None:
            raise HTTPException(409, "本轮所有组合均已比较完毕")
        if payload.a != current["a"] or payload.b != current["b"]:
            raise HTTPException(409, f"当前应比较的组合是「{current['a']} vs {current['b']}」")
        conn.execute(
            "INSERT INTO judgments (session_id, a, b, result) VALUES (?, ?, ?, ?)",
            (sid, payload.a, payload.b, payload.result),
        )
        conn.commit()
        return load_state(conn, sid)
    finally:
        conn.close()


@app.post("/api/sessions/{sid}/rejudge")
def rejudge(sid: str, payload: JudgmentCreate):
    """循环冲突复核：原位替换环上某一已判断组合的记录。

    不新增、不删除记录（进度 done/total 不变），仅把该组合的结果改写为
    新选择，随后立即重算排名、待比较项与下一条冲突。
    """
    conn = get_conn()
    try:
        row = conn.execute("SELECT candidates FROM sessions WHERE id = ?", (sid,)).fetchone()
        if row is None:
            raise HTTPException(404, "会话不存在或已被删除")
        candidates: list[str] = json.loads(row["candidates"])
        order = {name: i for i, name in enumerate(candidates)}
        if payload.a not in order or payload.b not in order or payload.a == payload.b:
            raise HTTPException(409, "请选择有效的候选项组合")

        # 存储约定：a/b 始终按候选项录入顺序（序号小的在前）；
        # result 相对传入顺序表达胜者，顺序交换时需同步翻转 a/b。
        if order[payload.a] < order[payload.b]:
            lo, hi, result = payload.a, payload.b, payload.result
        else:
            lo, hi = payload.b, payload.a
            result = {"a": "b", "b": "a", "tie": "tie"}[payload.result]

        state = load_state(conn, sid)
        conflict = state["conflict"]
        if conflict is None or not any(
            e["a"] == lo and e["b"] == hi for e in conflict["edges"]
        ):
            raise HTTPException(409, "只能复核当前冲突环上的已判断组合")

        cur = conn.execute(
            "UPDATE judgments SET result = ? WHERE session_id = ? AND a = ? AND b = ?",
            (result, sid, lo, hi),
        )
        if cur.rowcount == 0:
            raise HTTPException(409, "该组合尚未判断，无法复核")
        conn.commit()
        return load_state(conn, sid)
    finally:
        conn.close()


@app.post("/api/sessions/{sid}/undo")
def undo(sid: str):
    conn = get_conn()
    try:
        if conn.execute("SELECT 1 FROM sessions WHERE id = ?", (sid,)).fetchone() is None:
            raise HTTPException(404, "会话不存在或已被删除")
        cur = conn.execute(
            "DELETE FROM judgments WHERE id = "
            "(SELECT MAX(id) FROM judgments WHERE session_id = ?)",
            (sid,),
        )
        if cur.rowcount == 0:
            raise HTTPException(409, "没有可撤销的判断")
        conn.commit()
        return load_state(conn, sid)
    finally:
        conn.close()


@app.post("/api/sessions/{sid}/reset")
def reset(sid: str):
    conn = get_conn()
    try:
        if conn.execute("SELECT 1 FROM sessions WHERE id = ?", (sid,)).fetchone() is None:
            raise HTTPException(404, "会话不存在或已被删除")
        conn.execute("DELETE FROM judgments WHERE session_id = ?", (sid,))
        conn.commit()
        return load_state(conn, sid)
    finally:
        conn.close()


# ---------- 静态页面 ----------

@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
