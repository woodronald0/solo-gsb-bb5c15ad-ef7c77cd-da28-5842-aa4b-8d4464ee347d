"""Schulze 最强路径法（Strongest Path / Beatpath）排名计算。

计票约定：
- 甲胜乙：d(甲, 乙) = 1.0，d(乙, 甲) = 0
- 平局：  d(甲, 乙) = d(乙, 甲) = 0.5
- 未比较：双向均为 0

路径强度 = 路径上最弱一环的强度；最强路径取所有路径中的最大值。
候选项 i 严格优于 j 当且仅当 p[i][j] > p[j][i]，相等则并列。
"""
from __future__ import annotations


def strongest_paths(candidates: list[str], judgments: list[dict]) -> list[list[float]]:
    """根据已记录的胜负关系计算最强路径强度矩阵 p。"""
    n = len(candidates)
    idx = {name: i for i, name in enumerate(candidates)}
    p = [[0.0] * n for _ in range(n)]
    for j in judgments:
        a, b, result = idx[j["a"]], idx[j["b"]], j["result"]
        if result == "a":
            p[a][b] = 1.0
        elif result == "b":
            p[b][a] = 1.0
        else:  # tie
            p[a][b] = p[b][a] = 0.5

    # Floyd–Warshall 变体：p[i][j] = max(p[i][j], min(p[i][k], p[k][j]))
    for k in range(n):
        for i in range(n):
            if i == k:
                continue
            pik = p[i][k]
            if pik == 0:
                continue
            row_i, row_k = p[i], p[k]
            for j in range(n):
                weakest = pik if pik < row_k[j] else row_k[j]
                if row_i[j] < weakest:
                    row_i[j] = weakest
    return p


def shortest_strict_cycle(
    candidates: list[str], judgments: list[dict]
) -> list[str] | None:
    """在严格胜负边构成的有向图中找出最短有向环。

    - 仅「严格胜」成边：result == 'a' 时 a -> b，result == 'b' 时 b -> a；
      平局与未比较均不成边。
    - 存在多个同长度环时按候选项录入顺序稳定选择：优先以最早录入的
      候选项为环起点，同起点下按 BFS 邻接点升序选出字典序最小的路径。
    返回起点不重复追加的环（如 ["A", "B", "C"] 表示 A→B→C→A），无环返回 None。
    """
    n = len(candidates)
    idx = {name: i for i, name in enumerate(candidates)}
    adj: list[list[int]] = [[] for _ in range(n)]
    for j in judgments:
        a, b, result = idx[j["a"]], idx[j["b"]], j["result"]
        if result == "a":
            adj[a].append(b)
        elif result == "b":
            adj[b].append(a)
    for neighbors in adj:
        neighbors.sort()

    # 以每个候选项为起点（按录入顺序），只经过序号不小于起点的顶点，
    # 这样每个环恰在其最早成员处被枚举一次，且天然实现稳定选择。
    for start in range(n):
        parent: dict[int, int] = {start: -1}
        frontier = [start]
        depth = 0
        while frontier:
            nxt: list[int] = []
            found: tuple[int, int] | None = None
            for u in frontier:  # 同层按父路径字典序（BFS 入队序）展开
                for v in adj[u]:
                    if v < start:
                        continue
                    if v == start and u != start:
                        found = (u, v)
                        break
                    if v not in parent:
                        parent[v] = u
                        nxt.append(v)
                if found:
                    break
            if found:
                u = found[0]
                cyc = []
                node = u
                while node != -1:
                    cyc.append(node)
                    node = parent[node]
                cyc.reverse()  # start → … → u
                return [candidates[i] for i in cyc]
            frontier = nxt
            depth += 1
            if depth > n:  # 防御性兜底，理论上路径不会超过 n-1
                break
    return None


def rank_groups(candidates: list[str], p: list[list[float]]) -> list[list[str]]:
    """按 Schulze 关系把候选项分成有序的并列组（名次最优的组在前）。"""
    n = len(candidates)
    wins = [sum(1 for j in range(n) if j != i and p[i][j] > p[j][i]) for i in range(n)]
    order = sorted(range(n), key=lambda i: -wins[i])
    groups: list[list[int]] = []
    for i in order:
        # Schulze 关系是全预序：与组内任一成员并列即与全组并列
        if groups and all(p[i][m] == p[m][i] for m in groups[-1]):
            groups[-1].append(i)
        else:
            groups.append([i])
    return [[candidates[i] for i in group] for group in groups]
