"use strict";

const $ = (s) => document.querySelector(s);
const STORAGE_KEY = "decision-desk-session";

let state = null;
let busy = false;
let selectedPair = null; // 冲突环上待重新判定的组合 {a, b}

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
  renderMatrix();
  renderConflict();
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

function conflictCells() {
  // 冲突环上每个组合对应的两个矩阵格（i:j 与 j:i）
  const cells = new Set();
  if (state.conflict) {
    const pos = new Map(state.candidates.map((name, i) => [name, i]));
    for (const e of state.conflict.edges) {
      const i = pos.get(e.a);
      const j = pos.get(e.b);
      cells.add(`${i}:${j}`).add(`${j}:${i}`);
    }
  }
  return cells;
}

function renderMatrix() {
  const wrap = $("#matrix-wrap");
  wrap.innerHTML = "";
  const conflicts = conflictCells();
  const table = document.createElement("table");
  table.className = "matrix";

  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  for (const name of state.candidates) {
    const th = document.createElement("th");
    th.textContent = name;
    th.title = name;
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
    tr.appendChild(th);
    cells.forEach((cell, j) => {
      const td = document.createElement("td");
      td.className = `cell-${cell}`;
      td.textContent = SYMBOLS[cell];
      if (conflicts.has(`${i}:${j}`)) {
        td.classList.add("cell-conflict");
        td.title = "循环冲突组合，点击重新判定";
        td.addEventListener("click", () => {
          selectConflictPair({
            a: state.candidates[Math.min(i, j)],
            b: state.candidates[Math.max(i, j)],
          });
        });
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
}

/* ---------- 循环冲突复核 ---------- */

function renderConflict() {
  const card = $("#conflict-card");
  const conflict = state.conflict;
  if (!conflict) {
    selectedPair = null;
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  $("#conflict-path").textContent = [...conflict.cycle, conflict.cycle[0]].join(" → ");

  // 选中组合已不在当前环上（如经撤销/重判）时收起面板
  if (selectedPair && !conflict.edges.some((e) => e.a === selectedPair.a && e.b === selectedPair.b)) {
    selectedPair = null;
  }

  const box = $("#conflict-pairs");
  box.innerHTML = "";
  for (const e of conflict.edges) {
    const chip = document.createElement("button");
    const winner = e.result === "a" ? e.a : e.b;
    const loser = e.result === "a" ? e.b : e.a;
    chip.className =
      "chip conflict-chip" +
      (selectedPair && selectedPair.a === e.a && selectedPair.b === e.b ? " selected" : "");
    chip.textContent = `${winner} 胜 ${loser}`;
    chip.title = "点击重新判定该组合";
    chip.addEventListener("click", () => selectConflictPair(e));
    box.appendChild(chip);
  }

  const panel = $("#revise-panel");
  panel.classList.toggle("hidden", !selectedPair);
  if (selectedPair) {
    $("#revise-title").textContent = `重新判定：${selectedPair.a} ↔ ${selectedPair.b}`;
    $("#revise-a").textContent = `「${selectedPair.a}」胜`;
    $("#revise-b").textContent = `「${selectedPair.b}」胜`;
  }
}

function selectConflictPair(pair) {
  selectedPair = { a: pair.a, b: pair.b };
  renderConflict();
  $("#conflict-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
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

async function revise(result) {
  if (busy || !state || !selectedPair) return;
  busy = true;
  try {
    state = await api(`/api/sessions/${state.session_id}/judgments`, {
      method: "PUT",
      body: JSON.stringify({ a: selectedPair.a, b: selectedPair.b, result }),
    });
    selectedPair = null;
    render();
    toast("判定已更新，排名与冲突已重算");
  } catch (e) {
    toast(e.message);
    await refresh();
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
    selectedPair = null;
    render();
  } catch (e) {
    toast(e.message);
  }
}

function newRound() {
  if (!confirm("开始新一轮评审？当前进度将从本浏览器中移除（服务器记录仍保留）。")) return;
  localStorage.removeItem(STORAGE_KEY);
  state = null;
  selectedPair = null;
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
$("#revise-a").addEventListener("click", () => revise("a"));
$("#revise-tie").addEventListener("click", () => revise("tie"));
$("#revise-b").addEventListener("click", () => revise("b"));
$("#revise-cancel").addEventListener("click", () => {
  selectedPair = null;
  renderConflict();
});

document.addEventListener("keydown", (e) => {
  if ($("#review-view").classList.contains("hidden")) return;
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
