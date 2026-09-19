"use strict";

const $ = (s) => document.querySelector(s);
const STORAGE_KEY = "decision-desk-session";

let state = null;
let busy = false;
let reviewPair = null; // 冲突复核弹窗当前选中的组合（规范化 a/b 顺序）

/* ---------- 工具 ---------- */

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let detail = `请求失败（${res.status}）`;
    try {
      const body = await res.json();
      if (body.detail) detail = body.detail;
    } catch (_) { /* 忽略非 JSON 响应 */ }
    throw new Error(detail);
  }
  return res.json();
}

/* ---------- 视图 ---------- */

function showSetup() {
  $("#setup-view").classList.remove("hidden");
  $("#review-view").classList.add("hidden");
}

function render() {
  $("#setup-view").classList.add("hidden");
  $("#review-view").classList.remove("hidden");

  const { done, total } = state.progress;
  $("#progress-bar").style.width = total ? `${(done / total) * 100}%` : "0%";
  $("#progress-text").textContent = `${done} / ${total}`;

  const cur = state.current_pair;
  $("#current-pair").classList.toggle("hidden", !cur);
  $("#done-banner").classList.toggle("hidden", !!cur);
  if (cur) {
    $("#btn-a").textContent = cur.a;
    $("#btn-b").textContent = cur.b;
  }
  $("#undo-btn").disabled = !state.can_undo;

  renderRanking();
  renderPending();
  renderConflict();
  renderMatrix();
}

function renderRanking() {
  const box = $("#ranking");
  box.innerHTML = "";
  let rank = 1; // 竞争排名：并列后跳名次
  for (const group of state.ranking) {
    const row = document.createElement("div");
    row.className = "rank-row" + (group.length > 1 ? " tied" : "");
    const badge = document.createElement("span");
    badge.className = "rank-badge";
    badge.textContent = `第 ${rank} 名`;
    const names = document.createElement("span");
    names.className = "rank-names";
    names.textContent = group.join(" ＝ ");
    row.append(badge, names);
    box.appendChild(row);
    rank += group.length;
  }
}

function renderPending() {
  const box = $("#pending-list");
  box.innerHTML = "";
  if (state.pending.length === 0) {
    const span = document.createElement("span");
    span.className = "empty";
    span.textContent = "✓ 全部组合均已比较";
    box.appendChild(span);
    return;
  }
  for (const p of state.pending) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `${p.a} ↔ ${p.b}`;
    box.appendChild(chip);
  }
}

const SYMBOLS = { win: "✓", lose: "✗", tie: "＝", pending: "·", self: "—" };

/* ---------- 循环冲突 ---------- */

// 组合键：按候选项录入顺序规范化，与后端存储约定一致
function pairKey(a, b) {
  const ia = state.candidates.indexOf(a);
  const ib = state.candidates.indexOf(b);
  return ia < ib ? `${a} ${b}` : `${b} ${a}`;
}

function conflictEdgeMap() {
  const map = new Map();
  if (state.conflict) {
    for (const e of state.conflict.edges) map.set(pairKey(e.a, e.b), e);
  }
  return map;
}

function renderConflict() {
  const card = $("#conflict-card");
  const c = state.conflict;
  if (!c) {
    card.classList.add("hidden");
    $("#matrix-conflict-hint").classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  $("#matrix-conflict-hint").classList.remove("hidden");

  const path = $("#conflict-path");
  path.innerHTML = "";
  c.cycle.forEach((name, i) => {
    const node = document.createElement("span");
    node.className = "conflict-node";
    node.textContent = name;
    path.appendChild(node);

    const arrow = document.createElement("span");
    arrow.className = "conflict-arrow";
    arrow.textContent = "→";
    path.appendChild(arrow);
  });
  const back = document.createElement("span");
  back.className = "conflict-node";
  back.textContent = c.cycle[0];
  path.appendChild(back);

  const chips = document.createElement("div");
  chips.className = "chips conflict-chips";
  for (const e of c.edges) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip conflict-chip";
    chip.textContent = `✎ ${e.winner} 胜 ${e.winner === e.a ? e.b : e.a}`;
    chip.title = `点击复核「${e.a} vs ${e.b}」`;
    chip.addEventListener("click", () => openReview(e.a, e.b));
    chips.appendChild(chip);
  }
  path.appendChild(chips);

  $("#conflict-next").textContent =
    "复核后系统会立即重算排名与待比较项；若仍有冲突，将继续提示下一条最短冲突环。";
}

function renderMatrix() {
  const wrap = $("#matrix-wrap");
  wrap.innerHTML = "";
  const table = document.createElement("table");
  table.className = "matrix";
  const edges = conflictEdgeMap();
  const conflictNodes = new Set(
    state.conflict ? state.conflict.cycle : []
  );

  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  for (const name of state.candidates) {
    const th = document.createElement("th");
    th.textContent = name;
    th.title = name;
    if (conflictNodes.has(name)) th.classList.add("conflict-head");
    headRow.appendChild(th);
  }
  const thead = document.createElement("thead");
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  state.matrix.forEach((cells, i) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = state.candidates[i];
    th.title = state.candidates[i];
    if (conflictNodes.has(state.candidates[i])) th.classList.add("conflict-head");
    tr.appendChild(th);
    cells.forEach((cell, j) => {
      const td = document.createElement("td");
      td.className = `cell-${cell}`;
      td.textContent = SYMBOLS[cell];
      if (i !== j) {
        const edge = edges.get(pairKey(state.candidates[i], state.candidates[j]));
        if (edge) {
          // 有向边所在格（胜者所在行）高亮为正向，反向格为虚线提示
          const winnerIsRow =
            (edge.winner === edge.a && i < j) ||
            (edge.winner === edge.b && i > j);
          td.classList.add(winnerIsRow ? "conflict-edge" : "conflict-edge-rev");
          td.title = `冲突环组合「${edge.a} vs ${edge.b}」，点击复核`;
          td.setAttribute("role", "button");
          td.addEventListener("click", () => openReview(edge.a, edge.b));
        }
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
}

/* ---------- 循环冲突复核 ---------- */

function openReview(a, b) {
  if (busy || !state || !state.conflict) return;
  // 按录入顺序规范化，与后端 a/b 语义保持一致
  const ia = state.candidates.indexOf(a);
  const ib = state.candidates.indexOf(b);
  reviewPair = ia < ib ? { a, b } : { a: b, b: a };
  $("#review-context").textContent =
    `当前最短冲突环：${state.conflict.cycle.join(" → ")} → ${state.conflict.cycle[0]}`;
  $("#review-btn-a").textContent = reviewPair.a;
  $("#review-btn-b").textContent = reviewPair.b;
  $("#review-modal").classList.remove("hidden");
}

function closeReview() {
  if (busy) return;
  reviewPair = null;
  $("#review-modal").classList.add("hidden");
}

async function submitReview(result) {
  if (busy || !reviewPair) return;
  busy = true;
  try {
    const { a, b } = reviewPair;
    state = await api(`/api/sessions/${state.session_id}/rejudge`, {
      method: "POST",
      body: JSON.stringify({ a, b, result }),
    });
    reviewPair = null;
    $("#review-modal").classList.add("hidden");
    render();
    toast(state.conflict ? "已替换该判断，仍存在冲突环，请继续复核" : "✓ 冲突已解除");
  } catch (e) {
    toast(e.message);
    await refresh();
    closeReview();
  } finally {
    busy = false;
  }
}

/* ---------- 数据操作 ---------- */

async function refresh() {
  const sid = localStorage.getItem(STORAGE_KEY);
  if (!sid) {
    showSetup();
    return;
  }
  try {
    state = await api(`/api/sessions/${sid}`);
    render();
  } catch (_) {
    localStorage.removeItem(STORAGE_KEY);
    showSetup();
  }
}

async function judge(result) {
  if (busy || !state || !state.current_pair) return;
  busy = true;
  try {
    const { a, b } = state.current_pair;
    state = await api(`/api/sessions/${state.session_id}/judgments`, {
      method: "POST",
      body: JSON.stringify({ a, b, result }),
    });
    render();
  } catch (e) {
    toast(e.message);
    await refresh();
  } finally {
    busy = false;
  }
}

async function undo() {
  if (busy || !state) return;
  busy = true;
  try {
    state = await api(`/api/sessions/${state.session_id}/undo`, { method: "POST" });
    render();
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
  }
}

async function resetRound() {
  if (busy || !state) return;
  if (!confirm("确定要清空本轮全部判断记录吗？")) return;
  busy = true;
  try {
    state = await api(`/api/sessions/${state.session_id}/reset`, { method: "POST" });
    render();
    toast("本轮已重置");
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
  }
}

async function startSession() {
  const names = $("#candidates-input").value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length < 3 || names.length > 12) {
    toast("请输入 3～12 个候选项（每行一个）");
    return;
  }
  if (new Set(names).size !== names.length) {
    toast("候选项名称不可重复");
    return;
  }
  try {
    state = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ candidates: names }),
    });
    localStorage.setItem(STORAGE_KEY, state.session_id);
    render();
  } catch (e) {
    toast(e.message);
  }
}

function newRound() {
  if (!confirm("开始新一轮评审？当前进度将从本浏览器中移除（服务器记录仍保留）。")) return;
  localStorage.removeItem(STORAGE_KEY);
  state = null;
  showSetup();
}

/* ---------- 事件绑定 ---------- */

function updateCount() {
  const n = $("#candidates-input").value.split("\n").map((s) => s.trim()).filter(Boolean).length;
  $("#setup-count").textContent = n ? `已录入 ${n} 项` : "";
}

$("#candidates-input").addEventListener("input", updateCount);
$("#start-btn").addEventListener("click", startSession);
$("#btn-a").addEventListener("click", () => judge("a"));
$("#btn-b").addEventListener("click", () => judge("b"));
$("#btn-tie").addEventListener("click", () => judge("tie"));
$("#undo-btn").addEventListener("click", undo);
$("#reset-btn").addEventListener("click", resetRound);
$("#new-btn").addEventListener("click", newRound);

$("#review-btn-a").addEventListener("click", () => submitReview("a"));
$("#review-btn-b").addEventListener("click", () => submitReview("b"));
$("#review-btn-tie").addEventListener("click", () => submitReview("tie"));
$("#review-cancel").addEventListener("click", closeReview);
$("#review-modal").addEventListener("click", (e) => {
  if (e.target === $("#review-modal")) closeReview();
});

document.addEventListener("keydown", (e) => {
  if ($("#review-view").classList.contains("hidden")) return;
  if (!$("#review-modal").classList.contains("hidden")) {
    // 复核弹窗打开时拦截快捷键：← 左边胜 · → 右边胜 · ↓ 平局 · Esc 取消
    if (e.key === "Escape") { e.preventDefault(); closeReview(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); submitReview("a"); }
    else if (e.key === "ArrowRight") { e.preventDefault(); submitReview("b"); }
    else if (e.key === "ArrowDown") { e.preventDefault(); submitReview("tie"); }
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
    return;
  }
  if (!state || !state.current_pair) return;
  if (e.key === "ArrowLeft") judge("a");
  else if (e.key === "ArrowRight") judge("b");
  else if (e.key === "ArrowDown") judge("tie");
});

/* ---------- 启动 ---------- */

refresh();
