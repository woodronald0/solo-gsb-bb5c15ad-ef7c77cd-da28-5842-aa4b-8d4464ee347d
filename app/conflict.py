"""循环冲突检测：在严格胜负边中寻找最短有向环。

仅严格的胜负判断构成有向边（胜者 → 败者）；
平局与未比较的组合均不成边。每条判断记录只产生单向边，
因此正常数据下不存在自环与 2-环，最短环长至少为 3。
"""
from __future__ import annotations

from collections import deque


def _win_graph(candidates: list[str], judgments: list[dict]) -> list[list[int]]:
    """构建「胜者 → 败者」的有向邻接表，邻居按候选录入顺序排列。"""
    n = len(candidates)
    idx = {name: i for i, name in enumerate(candidates)}
    edges: list[set[int]] = [set() for _ in range(n)]
    for j in judgments:
        a, b = idx[j["a"]], idx[j["b"]]
        if j["result"] == "a":
            edges[a].add(b)
        elif j["result"] == "b":
            edges[b].add(a)
        # tie：平局不成边
    return [sorted(e) for e in edges]


def shortest_cycle(candidates: list[str], judgments: list[dict]) -> list[str] | None:
    """返回最短有向环上的候选项名称（按环的走向排列），无环时返回 None。

    例如 ["甲", "乙", "丙"] 表示 甲→乙→丙→甲。
    存在多个同长度环时，把每个环规范化为「以其最小录入序成员开头」
    的下标序列，取字典序最小者，保证选择稳定且只依赖候选录入顺序。
    """
    n = len(candidates)
    adj = _win_graph(candidates, judgments)

    # 全源 BFS 距离，用于 DFS 剪枝（无法回到起点的分支直接跳过）
    dist: list[list[int]] = []
    for src in range(n):
        d = [-1] * n
        d[src] = 0
        q = deque([src])
        while q:
            u = q.popleft()
            for v in adj[u]:
                if d[v] == -1:
                    d[v] = d[u] + 1
                    q.append(v)
        dist.append(d)

    best_len = n + 1
    best: tuple[int, ...] | None = None

    def dfs(s: int, u: int, path: list[int], on_path: set[int]) -> None:
        nonlocal best_len, best
        for v in adj[u]:
            if v == s and len(path) >= 2:
                # 闭环：环长 = 路径节点数；path 已以环上最小下标 s 开头
                if len(path) < best_len or (len(path) == best_len and tuple(path) < best):
                    best_len = len(path)
                    best = tuple(path)
            elif v not in on_path and v > s:
                back = dist[v][s]
                # 经 v 的环长至少为 len(path) + back，无望更优则剪枝
                if back >= 1 and len(path) + back <= best_len:
                    path.append(v)
                    on_path.add(v)
                    dfs(s, v, path, on_path)
                    path.pop()
                    on_path.discard(v)

    # 只枚举「以 s 为最小录入序节点」的环，每个环恰好被枚举一次
    for s in range(n):
        if best_len == 2:  # 理论最短（正常数据最短为 3）
            break
        dfs(s, s, [s], {s})

    if best is None:
        return None
    return [candidates[i] for i in best]
