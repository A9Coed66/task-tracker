(() => {
  const canvas = document.getElementById("canvas");
  const viewport = canvas.closest(".viewport");
  const canvasWorld = document.getElementById("canvas-world");
  const nodesLayer = document.getElementById("nodes");
  const svg = document.getElementById("connectors");
  const preview = document.getElementById("preview");

  const TW = 200;
  const TH = 88;

  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2;

  const AUTO_CHILD_DX = 142;
  const AUTO_CHILD_DY = 132;
  const AUTO_SIBLING_STEP_Y = 112;
  const SIBLING_SUBTREE_GAP = 48;
  /** Khoảng dọc giữa các con của task gốc (ví dụ Upgrade UX ngay dưới nhánh Setup UI). */
  const ROOT_CHILD_STACK_GAP = 8;
  const SIBLING_BRANCH_GAP_X = 260;
  const ROOT_SUBTREE_GAP = 56;
  const DRAG_EDGE_PX = 11;
  const NEW_SUBTASK_BELOW_GAP = 36;
  const BG_PAN_THRESHOLD_PX = 6;

  const STORAGE_KEY = "task-canvas-work-v1";
  const INSPECTOR_PREFS_KEY = "task-canvas-inspector-prefs";
  const DEFAULT_FONT_PREFS_KEY = "task-canvas-default-font-px";
  const DEFAULT_BORDER_PREFS_KEY = "task-canvas-default-border";
  const DEFAULT_BG_PREFS_KEY = "task-canvas-default-bg";
  const FONT_SIZE_MIN = 10;
  const FONT_SIZE_MAX = 40;
  let saveTimer = null;

  let baselineTaskFontPxCache = 0;
  function getBaselineTaskFontPx() {
    if (baselineTaskFontPxCache > 0) return baselineTaskFontPxCache;
    const probe = document.createElement("div");
    probe.className = "task-body";
    probe.style.cssText =
      "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;";
    probe.textContent = "M";
    document.body.appendChild(probe);
    const raw = parseFloat(getComputedStyle(probe).fontSize);
    document.body.removeChild(probe);
    baselineTaskFontPxCache = Math.round(raw) || 19;
    return baselineTaskFontPxCache;
  }

  function clampFontPx(n) {
    const fallback = getBaselineTaskFontPx();
    if (typeof n !== "number" || isNaN(n)) return fallback;
    return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
  }

  function loadPreferredDefaultFontPx() {
    try {
      const raw = localStorage.getItem(DEFAULT_FONT_PREFS_KEY);
      if (raw != null) {
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed)) return clampFontPx(parsed);
      }
    } catch (_) {
      /* ignore */
    }
    return getBaselineTaskFontPx();
  }

  function savePreferredDefaultFontPx(px) {
    try {
      localStorage.setItem(DEFAULT_FONT_PREFS_KEY, String(clampFontPx(px)));
    } catch (_) {
      /* ignore */
    }
  }

  function loadPreferredDefaultBorderHex() {
    try {
      const raw = localStorage.getItem(DEFAULT_BORDER_PREFS_KEY);
      if (raw) {
        const h = normalizeHexColor(raw.trim());
        if (h) return h;
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function savePreferredDefaultBorderHex(hex) {
    const h = normalizeHexColor(typeof hex === "string" ? hex.trim() : String(hex));
    if (!h) return;
    try {
      localStorage.setItem(DEFAULT_BORDER_PREFS_KEY, h);
    } catch (_) {
      /* ignore */
    }
  }

  function loadPreferredDefaultBgHex() {
    try {
      const raw = localStorage.getItem(DEFAULT_BG_PREFS_KEY);
      if (raw) {
        const h = normalizeHexColor(raw.trim());
        if (h) return h;
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function savePreferredDefaultBgHex(hex) {
    const h = normalizeHexColor(typeof hex === "string" ? hex.trim() : String(hex));
    if (!h) return;
    try {
      localStorage.setItem(DEFAULT_BG_PREFS_KEY, h);
    } catch (_) {
      /* ignore */
    }
  }

  function resolveInitialBorderColor(opts) {
    if (opts != null && Object.prototype.hasOwnProperty.call(opts, "borderColor")) {
      const bc = opts.borderColor;
      if (bc == null || bc === "") return null;
      return normalizeHexColor(String(bc));
    }
    return loadPreferredDefaultBorderHex();
  }

  function resolveInitialBgColor(opts) {
    if (opts != null && Object.prototype.hasOwnProperty.call(opts, "bgColor")) {
      const bc = opts.bgColor;
      if (bc == null || bc === "") return null;
      return normalizeHexColor(String(bc));
    }
    return loadPreferredDefaultBgHex();
  }

  /** @type {{ tx: number, ty: number, s: number }} */
  let view = { tx: 0, ty: 0, s: 1 };

  /** @type {string | null} */
  let selectedTaskId = null;
  let spacePanDown = false;

  /** @type {{ x: number, y: number, stx: number, sty: number } | null} */
  let viewPanDrag = null;

  /** @type {{ x: number, y: number, stx: number, sty: number, ptrId: number } | null} */
  let pendingBgPan = null;

  let idSeq = 1;
  const nextId = () => `t${idSeq++}`;

  /** @type {{ id: string, parentId: string | null, x: number, y: number, relX: number | null, relY: number | null, el: HTMLElement, path: SVGPathElement | null, done: boolean, doneCheckEl: HTMLElement | null, alignH: "center" | "right" | null, borderColor: string | null, bgColor: string | null, fontSizePx: number, collapsed: boolean, collapseToggleEl: HTMLElement | null }[]} */
  const tasks = [];

  function taskHasChildren(t) {
    return getChildren(t.id).length > 0;
  }

  function isHiddenByAncestorCollapse(t) {
    let pid = t.parentId;
    while (pid) {
      const p = tasks.find((x) => x.id === pid);
      if (!p) break;
      if (p.collapsed && taskHasChildren(p)) return true;
      pid = p.parentId;
    }
    return false;
  }

  function applyCollapseHiddenState() {
    for (const t of tasks) {
      const hidden = isHiddenByAncestorCollapse(t);
      if (hidden) {
        t.el.style.visibility = "hidden";
        t.el.style.pointerEvents = "none";
      } else {
        t.el.style.visibility = "";
        t.el.style.pointerEvents = "";
      }
      if (t.doneCheckEl) {
        t.doneCheckEl.style.visibility = hidden ? "hidden" : "";
      }
    }
    const sel = selectedTaskId ? tasks.find((x) => x.id === selectedTaskId) : null;
    if (sel && isHiddenByAncestorCollapse(sel)) selectTask(null);
  }

  function removeCollapseToggle(task) {
    if (!task.collapseToggleEl) return;
    task.collapseToggleEl.remove();
    task.collapseToggleEl = null;
  }

  /** @param {HTMLElement} btn @param {boolean} collapsed */
  function setCollapseToggleIcon(btn, collapsed) {
    if (collapsed) {
      btn.textContent = "+";
      btn.title = "Mở rộng nhánh con (đang thu gọn)";
      btn.setAttribute("aria-label", "Mở rộng nhánh con");
    } else {
      btn.textContent = "\u2212";
      btn.title = "Thu gọn nhánh con";
      btn.setAttribute("aria-label", "Thu gọn nhánh con");
    }
  }

  function makeCollapseToggleButton(task) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "task-collapse-toggle";
    btn.setAttribute("aria-expanded", "true");
    setCollapseToggleIcon(btn, !!task.collapsed);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!taskHasChildren(task)) return;
      task.collapsed = !task.collapsed;
      btn.classList.toggle("task-collapse-toggle--collapsed", task.collapsed);
      btn.setAttribute("aria-expanded", task.collapsed ? "false" : "true");
      setCollapseToggleIcon(btn, task.collapsed);
      applyCollapseHiddenState();
      redrawAllConnectors();
      scheduleSave();
    });
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    return btn;
  }

  function reconcileCollapseToggles() {
    for (const t of tasks) {
      if (!taskHasChildren(t)) {
        removeCollapseToggle(t);
        t.collapsed = false;
        continue;
      }
      if (!t.collapseToggleEl) {
        const btn = makeCollapseToggleButton(t);
        const node = t.el.querySelector(".task-node");
        if (node) node.insertBefore(btn, node.firstChild);
        t.collapseToggleEl = btn;
      }
      t.collapseToggleEl.classList.toggle("task-collapse-toggle--collapsed", t.collapsed);
      t.collapseToggleEl.setAttribute("aria-expanded", t.collapsed ? "false" : "true");
      setCollapseToggleIcon(t.collapseToggleEl, t.collapsed);
    }
    applyCollapseHiddenState();
    redrawAllConnectors();
  }

  /** @param {EventTarget | null} el */
  function isTypingContext(el) {
    if (!el) return false;
    if (el instanceof Element) {
      return (
        el.isContentEditable ||
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.closest("[contenteditable='true']") != null
      );
    }
    return "isContentEditable" in el && !!(/** @type {{ isContentEditable?: boolean }} */ (el).isContentEditable);
  }

  function getChildren(parentId) {
    return tasks.filter((t) => t.parentId === parentId);
  }

  /** Task gốc (parentId === null) chứa cây của `task`. */
  function getRootTask(task) {
    let cur = task;
    while (cur.parentId) {
      const p = tasks.find((x) => x.id === cur.parentId);
      if (!p) return cur;
      cur = p;
    }
    return cur;
  }

  function taskShowsCheckbox(t) {
    return t.parentId !== null && getChildren(t.id).length === 0;
  }

  function subtreeFullyDone(t) {
    const ch = getChildren(t.id);
    if (ch.length === 0) return t.done;
    return ch.every(subtreeFullyDone);
  }

  function refreshTaskDoneVisuals() {
    for (const t of tasks) {
      t.el.classList.toggle("task-wrap--done", subtreeFullyDone(t));
    }
  }

  function removeDoneCheckbox(task) {
    if (!task.doneCheckEl) return;
    task.doneCheckEl.remove();
    task.doneCheckEl = null;
    task.done = false;
  }

  function ensureDoneCheckbox(task) {
    if (!taskShowsCheckbox(task) || task.doneCheckEl) return;
    const btn = makeDoneCheckButton(task);
    btn.classList.add("done-check--floating");
    task.doneCheckEl = btn;
    nodesLayer.appendChild(btn);
  }

  function reconcileDoneControls() {
    for (const t of tasks) {
      if (taskShowsCheckbox(t)) ensureDoneCheckbox(t);
      else removeDoneCheckbox(t);
    }
    refreshTaskDoneVisuals();
    reconcileCollapseToggles();
  }

  function themeColorToHex(varName) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (!raw) return "#808080";
    if (raw.startsWith("#")) {
      if (raw.length >= 7) return raw.slice(0, 7).toLowerCase();
      if (raw.length === 4) {
        const r = raw[1],
          g = raw[2],
          b = raw[3];
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
      }
    }
    const m = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      const h = (n) =>
        Math.min(255, Math.max(0, parseInt(n, 10))).toString(16).padStart(2, "0");
      return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
    }
    return "#808080";
  }

  function normalizeHexColor(s) {
    if (typeof s !== "string") return null;
    let t = s.trim();
    if (/^#[0-9A-Fa-f]{3}$/.test(t)) {
      const r = t[1],
        g = t[2],
        b = t[3];
      t = `#${r}${r}${g}${g}${b}${b}`;
    }
    if (/^#[0-9A-Fa-f]{6}$/.test(t)) return t.toLowerCase();
    return null;
  }

  function coalesceAlignH(v) {
    if (v === "justify") return null;
    const n = v === "left" || v === "center" || v === "right" ? v : null;
    if (n === "left" || n == null) return null;
    return n;
  }

  function applyTaskVisualStyle(task) {
    const node = task.el.querySelector(".task-node");
    const body = task.el.querySelector(".task-body");
    if (!node || !body) return;

    const h = task.alignH || "left";
    body.style.textAlign = h === "left" ? "left" : h === "right" ? "right" : "center";
    body.style.alignItems = h === "left" ? "flex-start" : h === "right" ? "flex-end" : "center";
    body.style.justifyContent = "flex-start";

    if (task.borderColor) node.style.borderColor = task.borderColor;
    else node.style.removeProperty("border-color");

    if (task.bgColor) node.style.backgroundColor = task.bgColor;
    else node.style.removeProperty("background-color");

    const px =
      typeof task.fontSizePx === "number" && !isNaN(task.fontSizePx)
        ? clampFontPx(task.fontSizePx)
        : loadPreferredDefaultFontPx();
    task.fontSizePx = px;
    body.style.fontSize = `${px}px`;
  }

  function canvasLocalXY(clientX, clientY) {
    const cr = canvas.getBoundingClientRect();
    return {
      x: clientX - cr.left + viewport.scrollLeft,
      y: clientY - cr.top + viewport.scrollTop,
    };
  }

  function clientToWorld(clientX, clientY) {
    const L = canvasLocalXY(clientX, clientY);
    return {
      x: (L.x - view.tx) / view.s,
      y: (L.y - view.ty) / view.s,
    };
  }

  function clampViewScale() {
    view.s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.s));
    view.s = Math.round(view.s * 1000) / 1000;
  }

  function applyViewTransform() {
    clampViewScale();
    if (canvasWorld) {
      const tx = Math.round(view.tx * 100) / 100;
      const ty = Math.round(view.ty * 100) / 100;
      canvasWorld.style.transform = `translate(${tx}px, ${ty}px) scale(${view.s})`;
    }
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      const payload = {
        v: 2,
        idSeq,
        tasks: serializeTaskOrder().map((t) => ({
          id: t.id,
          parentId: t.parentId,
          x: t.x,
          y: t.y,
          relX: t.relX,
          relY: t.relY,
          done: t.done,
          text: t.el.querySelector(".task-body").innerHTML,
          isSub: t.el.classList.contains("task-wrap--sub"),
          alignH: t.alignH ?? null,
          borderColor: t.borderColor ?? null,
          bgColor: t.bgColor ?? null,
          fontSizePx: t.fontSizePx ?? getBaselineTaskFontPx(),
          collapsed: taskHasChildren(t) ? !!t.collapsed : false,
        })),
        view: { tx: view.tx, ty: view.ty, s: view.s },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {
      /* quota / private mode */
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
  }

  function natIdCmp(a, b) {
    const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    return na - nb;
  }

  function serializeTaskOrder() {
    const out = [];
    function walk(t) {
      out.push(t);
      getChildren(t.id)
        .sort((a, b) => natIdCmp(a.id, b.id))
        .forEach(walk);
    }
    tasks
      .filter((t) => !t.parentId)
      .sort((a, b) => natIdCmp(a.id, b.id))
      .forEach(walk);
    return out;
  }

  function syncIdSeqAfterRestore() {
    let m = 0;
    for (const t of tasks) {
      const n = parseInt(String(t.id).replace(/^t/, ""), 10);
      if (!isNaN(n)) m = Math.max(m, n);
    }
    idSeq = Math.max(idSeq, m + 1);
  }

  function seedDemoTasks() {
    const baseX = 520;
    const baseY = 240;
    createTaskNode("t1", null, baseX, baseY, false, {
      text: "Create the web",
      silent: true,
      skipRelayout: true,
      skipFocusTaskBody: true,
    });
    const p1 = tasks.find((t) => t.id === "t1");
    const t2x = p1 ? p1.x + AUTO_CHILD_DX : baseX + AUTO_CHILD_DX;
    const t2y = p1 ? p1.y + AUTO_CHILD_DY : baseY + AUTO_CHILD_DY;
    createTaskNode("t2", "t1", t2x, t2y, true, {
      text: "Setup UI",
      silent: true,
      skipRelayout: true,
      skipFocusTaskBody: true,
    });
    const p2 = tasks.find((t) => t.id === "t2");
    const t3x = p2 ? p2.x + AUTO_CHILD_DX : t2x + AUTO_CHILD_DX;
    const t3y = p2 ? p2.y + AUTO_CHILD_DY : t2y + AUTO_CHILD_DY;
    createTaskNode("t3", "t2", t3x, t3y, true, {
      text: "Create Simple UI",
      done: true,
      silent: true,
      skipRelayout: true,
      skipFocusTaskBody: true,
    });
    const t4x = p1 ? p1.x + AUTO_CHILD_DX : baseX + AUTO_CHILD_DX;
    const t4y = p1 ? p1.y + AUTO_CHILD_DY : baseY + AUTO_CHILD_DY;
    createTaskNode("t4", "t1", t4x, t4y, true, {
      text: "Upgrade UX",
      silent: true,
      skipRelayout: true,
      skipFocusTaskBody: true,
    });
    syncIdSeqAfterRestore();
    relayoutEntireForest();
    reconcileDoneControls();
    refreshTaskDoneVisuals();
    scheduleSave();
  }

  function restoreFromStorage() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || (data.v !== 1 && data.v !== 2) || !Array.isArray(data.tasks)) return;

    nodesLayer.replaceChildren();
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    tasks.length = 0;
    selectedTaskId = null;
    document.querySelectorAll(".task-wrap--selected").forEach((el) => el.classList.remove("task-wrap--selected"));

    idSeq = typeof data.idSeq === "number" ? data.idSeq : 1;
    if (data.view && typeof data.view.s === "number") {
      view = {
        tx: Number(data.view.tx) || 0,
        ty: Number(data.view.ty) || 0,
        s: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, data.view.s)),
      };
    } else view = { tx: 0, ty: 0, s: 1 };
    applyViewTransform();

    for (const row of data.tasks) {
      createTaskNode(row.id, row.parentId, row.x, row.y, !!row.isSub, {
        text: row.text || "",
        done: !!row.done,
        silent: true,
        skipRelayout: true,
        skipFocusTaskBody: true,
        alignH: row.alignH,
        restoreColorsExact: true,
        borderColor: row.borderColor ?? null,
        bgColor: row.bgColor ?? null,
        fontSizePx:
          typeof row.fontSizePx === "number" ? clampFontPx(row.fontSizePx) : getBaselineTaskFontPx(),
        collapsed: !!row.collapsed,
      });
    }
    syncIdSeqAfterRestore();
    reconcileDoneControls();
    for (const t of tasks) {
      if (t.done && t.doneCheckEl) {
        t.doneCheckEl.classList.add("done-check--on");
        t.doneCheckEl.setAttribute("aria-checked", "true");
      }
    }
    /* Tránh relayoutEntireForest() khi load — giữ nguyên x/y đã lưu (không reflow các cây gốc). */
    requestAnimationFrame(() => redrawAllConnectors());
    refreshTaskDoneVisuals();
  }

  function selectTask(id) {
    document.querySelectorAll(".task-wrap--selected").forEach((el) => {
      el.classList.remove("task-wrap--selected");
    });
    selectedTaskId = id;
    if (id) {
      const t = tasks.find((x) => x.id === id);
      t?.el.classList.add("task-wrap--selected");
    }
    refreshInspector();
  }

  function refreshInspector() {
    const panelEl = document.getElementById("inspector-panel");
    const labelEl = document.getElementById("inspector-task-label");
    const titleEl = document.getElementById("inspector-title");
    const headEl = document.querySelector(".inspector__head");
    if (!panelEl) return;

    const task = selectedTaskId ? tasks.find((x) => x.id === selectedTaskId) : null;
    if (!task) {
      panelEl.hidden = true;
      if (titleEl) titleEl.hidden = true;
      headEl?.classList.add("inspector__head--empty");
      return;
    }
    panelEl.hidden = false;
    if (titleEl) titleEl.hidden = false;
    headEl?.classList.remove("inspector__head--empty");
    if (labelEl) {
      labelEl.textContent = task.parentId ? `Subtask · ${task.id}` : `Task gốc · ${task.id}`;
    }

    const ah = task.alignH || "left";
    panelEl.querySelectorAll("[data-align-h]").forEach((btn) => {
      const v = btn.getAttribute("data-align-h");
      btn.setAttribute("aria-pressed", v === ah ? "true" : "false");
    });

    const borderIn = document.getElementById("inspector-border-color");
    const bgIn = document.getElementById("inspector-bg-color");
    const fontIn = /** @type {HTMLInputElement | null} */ (
      document.getElementById("inspector-font-size")
    );
    if (borderIn) borderIn.value = task.borderColor || themeColorToHex("--task-border");
    if (bgIn) bgIn.value = task.bgColor || themeColorToHex("--task-bg");
    if (fontIn) fontIn.value = String(clampFontPx(task.fontSizePx));
  }

  function bindInspector() {
    const panel = document.getElementById("inspector-panel");
    if (!panel) return;

    document.getElementById("inspector-delete-task")?.addEventListener("click", () => {
      const id = selectedTaskId;
      if (!id) return;
      if (!window.confirm("Xóa task này và toàn bộ nhánh con?")) return;
      deleteSubtree(id);
    });

    panel.addEventListener("click", (e) => {
      const hEl = /** @type {HTMLElement | null} */ (e.target).closest("[data-align-h]");
      if (hEl && panel.contains(hEl)) {
        const v = hEl.getAttribute("data-align-h");
        const t = selectedTaskId ? tasks.find((x) => x.id === selectedTaskId) : null;
        if (!t || !v) return;
        t.alignH = v === "left" ? null : v === "center" ? "center" : "right";
        applyTaskVisualStyle(t);
        refreshInspector();
        scheduleSave();
      }
    });

    document.getElementById("inspector-border-color")?.addEventListener("input", (e) => {
      const t = selectedTaskId ? tasks.find((x) => x.id === selectedTaskId) : null;
      const input = /** @type {HTMLInputElement} */ (e.target);
      if (!t) return;
      const h = normalizeHexColor(input.value);
      if (!h) return;
      t.borderColor = h;
      savePreferredDefaultBorderHex(h);
      applyTaskVisualStyle(t);
      scheduleSave();
    });
    document.getElementById("inspector-bg-color")?.addEventListener("input", (e) => {
      const t = selectedTaskId ? tasks.find((x) => x.id === selectedTaskId) : null;
      const input = /** @type {HTMLInputElement} */ (e.target);
      if (!t) return;
      const h = normalizeHexColor(input.value);
      if (!h) return;
      t.bgColor = h;
      savePreferredDefaultBgHex(h);
      applyTaskVisualStyle(t);
      scheduleSave();
    });

    document.getElementById("inspector-border-reset")?.addEventListener("click", () => {
      const t = selectedTaskId ? tasks.find((x) => x.id === selectedTaskId) : null;
      if (!t) return;
      t.borderColor = loadPreferredDefaultBorderHex();
      applyTaskVisualStyle(t);
      refreshInspector();
      scheduleSave();
    });
    document.getElementById("inspector-bg-reset")?.addEventListener("click", () => {
      const t = selectedTaskId ? tasks.find((x) => x.id === selectedTaskId) : null;
      if (!t) return;
      t.bgColor = loadPreferredDefaultBgHex();
      applyTaskVisualStyle(t);
      refreshInspector();
      scheduleSave();
    });

    document.getElementById("inspector-font-size")?.addEventListener("change", (e) => {
      const t = selectedTaskId ? tasks.find((x) => x.id === selectedTaskId) : null;
      const input = /** @type {HTMLInputElement} */ (e.target);
      if (!t) return;
      let v = parseInt(input.value, 10);
      if (isNaN(v)) v = loadPreferredDefaultFontPx();
      v = clampFontPx(v);
      input.value = String(v);
      t.fontSizePx = v;
      savePreferredDefaultFontPx(v);
      applyTaskVisualStyle(t);
      scheduleSave();
    });

    document.getElementById("inspector-font-size-reset")?.addEventListener("click", () => {
      const t = selectedTaskId ? tasks.find((x) => x.id === selectedTaskId) : null;
      if (!t) return;
      const d = loadPreferredDefaultFontPx();
      t.fontSizePx = d;
      applyTaskVisualStyle(t);
      refreshInspector();
      scheduleSave();
    });
  }

  function loadInspectorPrefs() {
    const d = { width: 272, collapsed: true };
    try {
      const raw = localStorage.getItem(INSPECTOR_PREFS_KEY);
      if (!raw) return d;
      const x = JSON.parse(raw);
      if (x && typeof x.width === "number") {
        d.width = Math.min(560, Math.max(200, Math.round(x.width)));
      }
      if (x && typeof x.collapsed === "boolean") d.collapsed = x.collapsed;
    } catch (_) {
      /* ignore */
    }
    return d;
  }

  function saveInspectorPrefs(prefs) {
    try {
      localStorage.setItem(INSPECTOR_PREFS_KEY, JSON.stringify(prefs));
    } catch (_) {
      /* ignore */
    }
  }

  function initInspectorChrome() {
    const root = document.getElementById("task-inspector");
    const handle = document.getElementById("inspector-resize-handle");
    const openTab = document.getElementById("inspector-open-tab");
    const collapseBtn = document.getElementById("inspector-collapse");
    const inner = document.getElementById("inspector-inner");
    if (!root || !inner) return;

    function applyPrefs() {
      const p = loadInspectorPrefs();
      const maxW = Math.min(560, Math.floor(window.innerWidth * 0.48));
      if (!p.collapsed) {
        const clamped = Math.min(maxW, Math.max(200, p.width));
        if (clamped !== p.width) {
          p.width = clamped;
          saveInspectorPrefs(p);
        }
      }
      root.style.setProperty("--inspector-width", `${p.width}px`);
      root.classList.toggle("inspector--collapsed", p.collapsed);
      inner.hidden = p.collapsed;
      if (openTab) {
        openTab.hidden = !p.collapsed;
        openTab.setAttribute("aria-expanded", String(!p.collapsed));
      }
      if (collapseBtn) {
        collapseBtn.hidden = p.collapsed;
        collapseBtn.setAttribute("aria-expanded", String(!p.collapsed));
      }
    }

    function setCollapsed(collapsed) {
      const p = loadInspectorPrefs();
      p.collapsed = collapsed;
      saveInspectorPrefs(p);
      applyPrefs();
    }

    openTab?.addEventListener("click", () => setCollapsed(false));
    collapseBtn?.addEventListener("click", () => setCollapsed(true));

    /** @type {{ x0: number, w0: number, id: number, lastW?: number } | null} */
    let drag = null;
    handle?.addEventListener("pointerdown", (e) => {
      if (root.classList.contains("inspector--collapsed")) return;
      if (e.button !== 0) return;
      e.preventDefault();
      const p = loadInspectorPrefs();
      drag = { x0: e.clientX, w0: p.width, id: e.pointerId };
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    });
    handle?.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const maxW = Math.min(560, Math.floor(window.innerWidth * 0.48));
      const w = Math.min(maxW, Math.max(200, drag.w0 + (drag.x0 - e.clientX)));
      root.style.setProperty("--inspector-width", `${w}px`);
      drag.lastW = w;
    });
    function endDrag(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      try {
        handle?.releasePointerCapture(drag.id);
      } catch (_) {
        /* ignore */
      }
      if (typeof drag.lastW === "number") {
        const p = loadInspectorPrefs();
        p.width = drag.lastW;
        saveInspectorPrefs(p);
      }
      drag = null;
    }
    handle?.addEventListener("pointerup", endDrag);
    handle?.addEventListener("pointercancel", endDrag);

    window.addEventListener("resize", () => {
      if (root.classList.contains("inspector--collapsed")) return;
      const maxW = Math.min(560, Math.floor(window.innerWidth * 0.48));
      const p = loadInspectorPrefs();
      if (p.width <= maxW) return;
      p.width = maxW;
      saveInspectorPrefs(p);
      root.style.setProperty("--inspector-width", `${p.width}px`);
    });

    applyPrefs();
  }

  function collectSubtreeIds(rootId) {
    const ids = [rootId];
    for (const c of getChildren(rootId)) {
      ids.push(...collectSubtreeIds(c.id));
    }
    return ids;
  }

  function deleteSubtree(rootId) {
    const all = collectSubtreeIds(rootId);
    const depth = (tid) => {
      let d = 0;
      let cur = tasks.find((x) => x.id === tid);
      while (cur?.parentId) {
        d++;
        cur = tasks.find((x) => x.id === cur.parentId);
      }
      return d;
    };
    all.sort((a, b) => depth(b) - depth(a));
    for (const tid of all) {
      const t = tasks.find((x) => x.id === tid);
      if (!t) continue;
      removeCollapseToggle(t);
      if (t.doneCheckEl) {
        t.doneCheckEl.remove();
        t.doneCheckEl = null;
      }
      if (t.path) {
        t.path.remove();
        t.path = null;
      }
      t.el.remove();
      const i = tasks.findIndex((x) => x.id === tid);
      if (i !== -1) tasks.splice(i, 1);
    }
    if (selectedTaskId && all.includes(selectedTaskId)) {
      selectTask(null);
    }
    redrawAllConnectors();
    scheduleSave();
  }

  /** @type {{ mode: 'root' } | null } */
  let placeMode = null;

  function setPreviewPos(el, cx, cy, w, h) {
    el.style.setProperty("--tw", `${w}px`);
    el.style.setProperty("--th", `${h}px`);
    el.style.left = `${cx}px`;
    el.style.top = `${cy}px`;
  }

  /** @param {{ skipCanvasFocus?: boolean }=} opts */
  function exitPlaceMode(opts) {
    placeMode = null;
    preview.hidden = true;
    document.body.classList.remove("placing");
    if (!opts?.skipCanvasFocus) {
      canvas.focus();
    }
  }

  function startRootPlacement() {
    placeMode = { mode: "root" };
    preview.hidden = false;
    document.body.classList.add("placing");
    canvas.focus();
  }

  function onCanvasMouseMove(e) {
    if (!placeMode || placeMode.mode !== "root") return;
    const p = clientToWorld(e.clientX, e.clientY);
    setPreviewPos(preview, p.x, p.y, TW, TH);
  }

  function applyDomPosition(task) {
    task.el.style.left = `${task.x}px`;
    task.el.style.top = `${task.y}px`;
  }

  function nodeCanvasBounds(task) {
    const c = canvas.getBoundingClientRect();
    const r = task.el.getBoundingClientRect();
    let minX = r.left - c.left;
    let maxX = r.right - c.left;
    let minY = r.top - c.top;
    let maxY = r.bottom - c.top;
    if (task.doneCheckEl) {
      const b = task.doneCheckEl.getBoundingClientRect();
      minX = Math.min(minX, b.left - c.left);
      maxX = Math.max(maxX, b.right - c.left);
      minY = Math.min(minY, b.top - c.top);
      maxY = Math.max(maxY, b.bottom - c.top);
    }
    return { minX, maxX, minY, maxY };
  }

  function subtreeBoundsPx(t) {
    let b = nodeCanvasBounds(t);
    for (const ch of getChildren(t.id)) {
      const cb = subtreeBoundsPx(ch);
      b.minX = Math.min(b.minX, cb.minX);
      b.maxX = Math.max(b.maxX, cb.maxX);
      b.minY = Math.min(b.minY, cb.minY);
      b.maxY = Math.max(b.maxY, cb.maxY);
    }
    return b;
  }

  function moveSubtreeByDelta(root, dx, dy) {
    if (dx === 0 && dy === 0) return;
    function walk(t) {
      t.x += dx;
      t.y += dy;
      applyDomPosition(t);
      getChildren(t.id).forEach(walk);
    }
    walk(root);
  }

  function taskHalfHeight(task) {
    const h = task.el.getBoundingClientRect().height;
    return Math.max(h / 2, 28);
  }

  function layoutTree(node) {
    const children = getChildren(node.id);
    for (const c of children) {
      layoutTree(c);
    }
    if (children.length === 0) return;

    const baseX = node.x + AUTO_CHILD_DX;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      let targetX;
      let targetY;
      if (i === 0) {
        targetX = baseX;
        targetY = node.y + AUTO_CHILD_DY;
      } else {
        const first = children[0];
        const prev = children[i - 1];
        const onlyTwo = children.length === 2;
        const secondIsLeaf = getChildren(c.id).length === 0;
        const firstHasNested = getChildren(first.id).length > 0;
        const branchBesideFirst =
          onlyTwo &&
          i === 1 &&
          secondIsLeaf &&
          firstHasNested &&
          node.parentId != null;
        if (branchBesideFirst) {
          targetX = first.x + SIBLING_BRANCH_GAP_X;
          targetY = first.y;
        } else {
          const b = subtreeBoundsPx(prev);
          const stackGap =
            node.parentId == null ? ROOT_CHILD_STACK_GAP : SIBLING_SUBTREE_GAP;
          targetX = children[0].x;
          targetY = b.maxY + stackGap + taskHalfHeight(c);
        }
      }
      const dx = targetX - c.x;
      const dy = targetY - c.y;
      if (dx !== 0 || dy !== 0) {
        moveSubtreeByDelta(c, dx, dy);
        const p = tasks.find((t) => t.id === c.parentId);
        if (p) {
          c.relX = c.x - p.x;
          c.relY = c.y - p.y;
        }
      }
    }
  }

  function relayoutEntireForest() {
    const roots = tasks.filter((t) => !t.parentId);
    for (const r of roots) {
      layoutTree(r);
    }
    reflowRootSubtrees();
    redrawAllConnectors();
  }

  /**
   * Chỉ áp thuật toán bố trí nhánh cho một task gốc — không chạy layoutTree trên
   * các cây khác, không reflow đẩy các task gốc khác (tránh lệch vị trí project khác).
   * @param {string} rootId id của task gốc (parentId === null)
   */
  function relayoutForestScopedToRoot(rootId) {
    const root = tasks.find((t) => t.id === rootId && t.parentId === null);
    if (!root) return;
    layoutTree(root);
    redrawAllConnectors();
  }

  function reflowRootSubtrees() {
    const roots = tasks.filter((t) => !t.parentId);
    if (roots.length <= 1) return;
    roots.sort((a, b) => subtreeBoundsPx(a).minY - subtreeBoundsPx(b).minY);
    let prevBottom = -Infinity;
    for (const root of roots) {
      let b = subtreeBoundsPx(root);
      if (b.minY < prevBottom + ROOT_SUBTREE_GAP) {
        const shift = prevBottom + ROOT_SUBTREE_GAP - b.minY;
        moveSubtreeByDelta(root, 0, shift);
      }
      b = subtreeBoundsPx(root);
      prevBottom = b.maxY;
    }
  }

  function refreshLayoutAfterChange() {
    redrawAllConnectors();
  }

  /** Cạnh dưới world (y + nửa chiều cao ô) của một task và toàn bộ cây con. */
  function subtreeMaxBottomEdgeY(t) {
    const h = t.el.offsetHeight || TH;
    let bottom = t.y + h / 2;
    for (const c of getChildren(t.id)) {
      bottom = Math.max(bottom, subtreeMaxBottomEdgeY(c));
    }
    return bottom;
  }

  function createSubtaskAutomatically(parentId) {
    const parent = tasks.find((t) => t.id === parentId);
    if (!parent) return;
    const siblings = getChildren(parentId);
    const absX = parent.x + AUTO_CHILD_DX;
    let absY;
    if (siblings.length === 0) {
      absY = parent.y + AUTO_CHILD_DY;
    } else {
      let maxBottom = -Infinity;
      for (const s of siblings) {
        maxBottom = Math.max(maxBottom, subtreeMaxBottomEdgeY(s));
      }
      absY = maxBottom + NEW_SUBTASK_BELOW_GAP + TH / 2;
    }
    createTaskNode(nextId(), parentId, absX, absY, true, { skipRelayout: true });
    requestAnimationFrame(redrawAllConnectors);
  }

  function attachDragHandlers(node, wrap, task) {
    let drag = null;

    function nearEdge(clientX, clientY) {
      const r = node.getBoundingClientRect();
      const x = clientX - r.left;
      const y = clientY - r.top;
      const E = DRAG_EDGE_PX;
      return x >= 0 && x <= r.width && y >= 0 && y <= r.height && (x < E || x > r.width - E || y < E || y > r.height - E);
    }

    node.addEventListener("pointermove", (e) => {
      if (drag && e.pointerId === drag.ptrId) {
        const p = clientToWorld(e.clientX, e.clientY);
        const nx = p.x + drag.grabDx;
        const ny = p.y + drag.grabDy;
        const dx = nx - drag.task.x;
        const dy = ny - drag.task.y;
        if (dx !== 0 || dy !== 0) {
          moveSubtreeByDelta(drag.task, dx, dy);
          redrawAllConnectors();
        }
        return;
      }
      if (placeMode || drag || e.target.closest(".add-sub")) {
        if (!drag) node.classList.remove("task-node--drag-edge");
        return;
      }
      if (nearEdge(e.clientX, e.clientY)) {
        node.classList.add("task-node--drag-edge");
      } else {
        node.classList.remove("task-node--drag-edge");
      }
    });

    node.addEventListener("pointerleave", () => {
      if (!drag) node.classList.remove("task-node--drag-edge");
    });

    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || placeMode) return;
      if (e.target.closest(".add-sub")) return;
      if (!nearEdge(e.clientX, e.clientY)) return;
      e.preventDefault();
      const p0 = clientToWorld(e.clientX, e.clientY);
      drag = {
        task,
        grabDx: task.x - p0.x,
        grabDy: task.y - p0.y,
        ptrId: e.pointerId,
      };
      try {
        node.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      node.classList.add("task-node--dragging");
    });

    function endDrag(e) {
      if (!drag || (e && e.pointerId !== drag.ptrId)) return;
      try {
        node.releasePointerCapture(drag.ptrId);
      } catch (_) {
        /* ignore */
      }
      const t = drag.task;
      if (t.parentId) {
        const p = tasks.find((x) => x.id === t.parentId);
        if (p) {
          t.relX = t.x - p.x;
          t.relY = t.y - p.y;
        }
      }
      drag = null;
      node.classList.remove("task-node--dragging");
      node.classList.remove("task-node--drag-edge");
      refreshLayoutAfterChange();
      refreshTaskDoneVisuals();
      scheduleSave();
    }

    node.addEventListener("pointerup", endDrag);
    node.addEventListener("pointercancel", endDrag);
  }

  function setLeafDone(task, done) {
    if (!task.doneCheckEl) return;
    task.done = done;
    task.doneCheckEl.classList.toggle("done-check--on", done);
    task.doneCheckEl.setAttribute("aria-checked", done ? "true" : "false");
    refreshTaskDoneVisuals();
    scheduleSave();
  }

  function makeDoneCheckButton(task) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "done-check";
    btn.title = "Đánh dấu hoàn thành";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("role", "checkbox");
    btn.setAttribute("aria-checked", "false");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      setLeafDone(task, !task.done);
    });
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    return btn;
  }

  /**
   * @param {number} edgeX cạnh trái hoặc phải của parent (world px)
   * @param {"left" | "right"} side
   */
  function computeSideRailPath(edgeX, edgeY, midY, childLeft, side) {
    const maxR = 16;
    const distV = Math.abs(midY - edgeY);
    const distH = Math.abs(childLeft - edgeX);
    let r = Math.min(maxR, distV / 2, distH / 2);
    if (r < 3) r = 0;
    if (r === 0) {
      return [`M ${edgeX} ${edgeY}`, `L ${edgeX} ${midY}`, `L ${childLeft} ${midY}`].join(" ");
    }
    if (side === "right") {
      if (midY >= edgeY) {
        return [
          `M ${edgeX} ${edgeY}`,
          `L ${edgeX} ${midY - r}`,
          `A ${r} ${r} 0 0 0 ${edgeX - r} ${midY}`,
          `L ${childLeft} ${midY}`,
        ].join(" ");
      }
      return [
        `M ${edgeX} ${edgeY}`,
        `L ${edgeX} ${midY + r}`,
        `A ${r} ${r} 0 0 1 ${edgeX - r} ${midY}`,
        `L ${childLeft} ${midY}`,
      ].join(" ");
    }
    if (midY >= edgeY) {
      return [
        `M ${edgeX} ${edgeY}`,
        `L ${edgeX} ${midY - r}`,
        `A ${r} ${r} 0 0 1 ${edgeX + r} ${midY}`,
        `L ${childLeft} ${midY}`,
      ].join(" ");
    }
    return [
      `M ${edgeX} ${edgeY}`,
      `L ${edgeX} ${midY + r}`,
      `A ${r} ${r} 0 0 0 ${edgeX + r} ${midY}`,
      `L ${childLeft} ${midY}`,
    ].join(" ");
  }

  /** @param {number} childCenterX tâm X của nút con — dùng cho hướng nhánh ngang */
  function computeConnectorPath(p1x, p1y, midY, childLeft, childCenterX) {
    const goRight = childCenterX >= p1x;
    const maxR = 20;
    let cornerR = Math.min(
      maxR,
      Math.abs(childLeft - p1x) / 2,
      Math.abs(midY - p1y) / 2,
    );
    if (cornerR < 3) cornerR = 0;

    let hingeX;
    if (cornerR === 0) {
      hingeX = p1x;
    } else if (midY >= p1y) {
      hingeX = goRight ? p1x + cornerR : p1x - cornerR;
    } else {
      hingeX = goRight ? p1x + cornerR : p1x - cornerR;
    }

    let d;
    if (cornerR === 0) {
      d = [`M ${p1x} ${p1y}`, `L ${p1x} ${midY}`, `L ${childLeft} ${midY}`].join(" ");
    } else if (midY >= p1y) {
      if (goRight) {
        d = [
          `M ${p1x} ${p1y}`,
          `L ${p1x} ${midY - cornerR}`,
          `A ${cornerR} ${cornerR} 0 0 0 ${p1x + cornerR} ${midY}`,
          `L ${childLeft} ${midY}`,
        ].join(" ");
      } else {
        d = [
          `M ${p1x} ${p1y}`,
          `L ${p1x} ${midY - cornerR}`,
          `A ${cornerR} ${cornerR} 0 0 1 ${p1x - cornerR} ${midY}`,
          `L ${childLeft} ${midY}`,
        ].join(" ");
      }
    } else {
      if (goRight) {
        d = [
          `M ${p1x} ${p1y}`,
          `L ${p1x} ${midY + cornerR}`,
          `A ${cornerR} ${cornerR} 0 0 1 ${p1x + cornerR} ${midY}`,
          `L ${childLeft} ${midY}`,
        ].join(" ");
      } else {
        d = [
          `M ${p1x} ${p1y}`,
          `L ${p1x} ${midY + cornerR}`,
          `A ${cornerR} ${cornerR} 0 0 0 ${p1x - cornerR} ${midY}`,
          `L ${childLeft} ${midY}`,
        ].join(" ");
      }
    }

    return { d, hingeX, midY, childLeft };
  }

  function makePathEl() {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.appendChild(path);
    return path;
  }

  function updateConnector(parentId, childId) {
    const parent = tasks.find((t) => t.id === parentId);
    const child = tasks.find((t) => t.id === childId);
    if (!parent || !child || !child.path) return;

    if (isHiddenByAncestorCollapse(child)) {
      child.path.style.visibility = "hidden";
      return;
    }
    child.path.style.visibility = "";

    const ph = parent.el.offsetHeight;
    const pw = parent.el.offsetWidth;
    const cw = child.el.offsetWidth;

    const parentLeft = parent.x - pw / 2;
    const parentRight = parent.x + pw / 2;
    const parentTop = parent.y - ph / 2;
    const parentBottom = parent.y + ph / 2;
    const p1x = parent.x;
    const p1y = parentBottom;
    const midY = child.y;
    const childLeft = child.x - cw / 2;

    function bottomExitHorizontalCrossesParent() {
      if (midY <= parentTop || midY >= parentBottom) return false;
      const xLo = Math.min(p1x, childLeft);
      const xHi = Math.max(p1x, childLeft);
      return xHi > parentLeft && xLo < parentRight;
    }

    let d;
    if (bottomExitHorizontalCrossesParent()) {
      if (child.x >= parent.x) {
        d = computeSideRailPath(parentRight, parent.y, midY, childLeft, "right");
      } else {
        d = computeSideRailPath(parentLeft, parent.y, midY, childLeft, "left");
      }
    } else {
      d = computeConnectorPath(p1x, p1y, midY, childLeft, child.x).d;
    }
    child.path.setAttribute("d", d);

    if (child.doneCheckEl) {
      child.doneCheckEl.style.left = `${childLeft}px`;
      child.doneCheckEl.style.top = `${midY}px`;
      child.doneCheckEl.style.transform = "translate(-50%, -50%)";
    }
  }

  function redrawAllConnectors() {
    for (const t of tasks) {
      if (t.parentId && t.path) updateConnector(t.parentId, t.id);
    }
  }

  const ro = new ResizeObserver(() => {
    requestAnimationFrame(redrawAllConnectors);
  });
  ro.observe(canvas);
  ro.observe(nodesLayer);

  function focusNewTaskEditor(taskId) {
    const t = tasks.find((x) => x.id === taskId);
    const body = /** @type {HTMLElement | null} */ (t?.el.querySelector(".task-body"));
    if (!body) return;
    selectTask(taskId);
    requestAnimationFrame(() => {
      body.focus();
      const sel = window.getSelection();
      if (!sel) return;
      try {
        const range = document.createRange();
        range.selectNodeContents(body);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {
        /* ignore */
      }
    });
  }

  /**
   * @param {{
   *   text?: string,
   *   done?: boolean,
   *   silent?: boolean,
   *   skipRelayout?: boolean,
   *   skipFocusTaskBody?: boolean,
   *   alignH?: string | null,
   *   borderColor?: string | null,
   *   bgColor?: string | null,
   *   restoreColorsExact?: boolean,
   *   fontSizePx?: number,
   *   collapsed?: boolean,
   * }=} opts
   */
  function createTaskNode(id, parentId, x, y, isSub, opts) {
    const wrap = document.createElement("div");
    wrap.className = "task-wrap" + (isSub ? " task-wrap--sub" : "");
    wrap.dataset.taskId = id;
    wrap.style.transform = "translate(-50%, -50%)";

    const node = document.createElement("div");
    node.className = "task-node";

    const body = document.createElement("div");
    body.className = "task-body";
    body.contentEditable = "true";
    body.spellcheck = true;
    body.dataset.placeholder = isSub ? "Nhập subtask…" : "Nhập nội dung task…";
    if (opts?.text) body.innerHTML = opts.text;

    const footer = document.createElement("div");
    footer.className = "task-footer";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "add-sub";
    addBtn.title = "Thêm subtask";
    addBtn.setAttribute("aria-label", "Thêm subtask");
    addBtn.textContent = "+";

    addBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      createSubtaskAutomatically(id);
    });

    footer.appendChild(addBtn);
    node.appendChild(body);
    node.appendChild(footer);

    const path = parentId ? makePathEl() : null;

    let relX = null;
    let relY = null;
    if (parentId) {
      const p = tasks.find((t) => t.id === parentId);
      if (p) {
        relX = x - p.x;
        relY = y - p.y;
      }
    }

    let borderParsed;
    let bgParsed;
    if (opts?.restoreColorsExact) {
      borderParsed =
        opts.borderColor != null && opts.borderColor !== ""
          ? normalizeHexColor(String(opts.borderColor))
          : null;
      bgParsed =
        opts.bgColor != null && opts.bgColor !== ""
          ? normalizeHexColor(String(opts.bgColor))
          : null;
    } else {
      borderParsed = resolveInitialBorderColor(opts);
      bgParsed = resolveInitialBgColor(opts);
    }

    const fontPx =
      opts != null && typeof opts.fontSizePx === "number"
        ? clampFontPx(opts.fontSizePx)
        : loadPreferredDefaultFontPx();

    const task = {
      id,
      parentId,
      x,
      y,
      relX,
      relY,
      el: wrap,
      path,
      done: !!opts?.done,
      doneCheckEl: null,
      alignH: coalesceAlignH(opts?.alignH),
      borderColor: borderParsed,
      bgColor: bgParsed,
      fontSizePx: fontPx,
      collapsed: !!opts?.collapsed,
      collapseToggleEl: null,
    };

    applyDomPosition(task);
    wrap.appendChild(node);
    nodesLayer.appendChild(wrap);

    tasks.push(task);
    applyTaskVisualStyle(task);
    ro.observe(wrap);
    reconcileDoneControls();

    if (opts?.done && task.doneCheckEl) {
      task.doneCheckEl.classList.add("done-check--on");
      task.doneCheckEl.setAttribute("aria-checked", "true");
    }

    attachDragHandlers(node, wrap, task);

    wrap.addEventListener(
      "pointerdown",
      (e) => {
        if (e.target.closest(".add-sub")) return;
        if (e.target.closest(".task-collapse-toggle")) return;
        selectTask(id);
      },
      true,
    );

    if (path && parentId) {
      requestAnimationFrame(() => updateConnector(parentId, id));
    }

    if (!opts?.skipRelayout) {
      const scopeRoot = getRootTask(task);
      requestAnimationFrame(() => relayoutForestScopedToRoot(scopeRoot.id));
    }
    if (!opts?.silent) scheduleSave();

    if (!opts?.skipFocusTaskBody) {
      focusNewTaskEditor(id);
    }

    body.addEventListener("input", () => {
      scheduleSave();
      requestAnimationFrame(redrawAllConnectors);
    });
    body.addEventListener("pointerdown", (e) => e.stopPropagation());

    return wrap;
  }

  function placeAt(clientX, clientY) {
    if (!placeMode || placeMode.mode !== "root") return;
    const p = clientToWorld(clientX, clientY);
    createTaskNode(nextId(), null, p.x, p.y, false);
    exitPlaceMode({ skipCanvasFocus: true });
  }

  canvas.addEventListener("dblclick", (e) => {
    if (placeMode) return;
    if (!canvas.contains(e.target)) return;
    if (e.target.closest(".task-wrap")) return;
    if (e.target.closest(".done-check")) return;
    if (e.target.closest(".task-collapse-toggle")) return;
    startRootPlacement();
    onCanvasMouseMove(e);
  });

  canvas.addEventListener("click", (e) => {
    if (!placeMode) return;
    if (e.target.closest(".task-wrap")) return;
    if (e.target.closest(".done-check")) return;
    placeAt(e.clientX, e.clientY);
  });

  canvas.addEventListener("mousemove", onCanvasMouseMove);

  function isCanvasBackgroundTarget(target) {
    return (
      target === canvas ||
      target === canvasWorld ||
      target === svg ||
      target === nodesLayer
    );
  }

  canvas.addEventListener("pointerdown", (e) => {
    const raw = e.target;
    if (isCanvasBackgroundTarget(raw)) {
      selectTask(null);
    }
    const canBgPan = e.button === 0 && !placeMode && isCanvasBackgroundTarget(raw);
    const canSpacePan = e.button === 0 && spacePanDown && canvas.contains(e.target);
    if (canSpacePan) {
      e.preventDefault();
      pendingBgPan = null;
      viewPanDrag = {
        x: e.clientX,
        y: e.clientY,
        stx: view.tx,
        sty: view.ty,
        ptrId: e.pointerId,
      };
      viewport?.classList.add("is-panning");
      try {
        viewport?.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    } else if (canBgPan) {
      pendingBgPan = {
        x: e.clientX,
        y: e.clientY,
        stx: view.tx,
        sty: view.ty,
        ptrId: e.pointerId,
      };
    }
  });

  viewport.addEventListener(
    "wheel",
    (e) => {
      if (!canvas.contains(e.target)) return;
      e.preventDefault();
      const local = canvasLocalXY(e.clientX, e.clientY);
      const worldX = (local.x - view.tx) / view.s;
      const worldY = (local.y - view.ty) / view.s;
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      view.s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.s * factor));
      view.tx = local.x - worldX * view.s;
      view.ty = local.y - worldY * view.s;
      applyViewTransform();
      requestAnimationFrame(redrawAllConnectors);
      scheduleSave();
    },
    { passive: false },
  );

  viewport.addEventListener("pointerdown", (e) => {
    if (e.button === 1 && canvas.contains(e.target)) {
      e.preventDefault();
      viewPanDrag = {
        x: e.clientX,
        y: e.clientY,
        stx: view.tx,
        sty: view.ty,
        ptrId: e.pointerId,
      };
      viewport.classList.add("is-panning");
      try {
        viewport.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
  });

  viewport.addEventListener("pointermove", (e) => {
    if (pendingBgPan && e.pointerId === pendingBgPan.ptrId) {
      const dx = e.clientX - pendingBgPan.x;
      const dy = e.clientY - pendingBgPan.y;
      if (dx * dx + dy * dy >= BG_PAN_THRESHOLD_PX * BG_PAN_THRESHOLD_PX) {
        viewPanDrag = {
          x: pendingBgPan.x,
          y: pendingBgPan.y,
          stx: pendingBgPan.stx,
          sty: pendingBgPan.sty,
          ptrId: pendingBgPan.ptrId,
        };
        pendingBgPan = null;
        viewport?.classList.add("is-panning");
        try {
          viewport.setPointerCapture(e.pointerId);
        } catch (_) {
          /* ignore */
        }
      }
    }
    if (!viewPanDrag) return;
    view.tx = viewPanDrag.stx + (e.clientX - viewPanDrag.x);
    view.ty = viewPanDrag.sty + (e.clientY - viewPanDrag.y);
    applyViewTransform();
    requestAnimationFrame(redrawAllConnectors);
  });

  function endViewPan(e) {
    if (pendingBgPan && (!e || e.pointerId === pendingBgPan.ptrId)) {
      pendingBgPan = null;
    }
    if (!viewPanDrag) return;
    if (e && e.pointerId !== viewPanDrag.ptrId) return;
    try {
      viewport.releasePointerCapture(viewPanDrag.ptrId);
    } catch (_) {
      /* ignore */
    }
    viewPanDrag = null;
    viewport?.classList.remove("is-panning");
    scheduleSave();
  }

  viewport.addEventListener("pointerup", endViewPan);
  viewport.addEventListener("pointercancel", endViewPan);

  canvas.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) return;
    if (isTypingContext(e.target) || isTypingContext(document.activeElement)) return;
    spacePanDown = true;
    e.preventDefault();
  });
  canvas.addEventListener("keyup", (e) => {
    if (e.code === "Space") spacePanDown = false;
  });

  document.addEventListener("keydown", (e) => {
    const typing = isTypingContext(document.activeElement);

    if (e.key === "Escape") {
      if (placeMode) {
        e.preventDefault();
        exitPlaceMode();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      flushSave();
      return;
    }

    if (!typing && e.code === "Delete" && selectedTaskId && !e.repeat) {
      const insp = document.getElementById("task-inspector");
      const ae = document.activeElement;
      const inInspector =
        insp &&
        ae instanceof Node &&
        insp.contains(ae) &&
        ae !== insp;
      if (!inInspector) {
        e.preventDefault();
        const id = selectedTaskId;
        if (!window.confirm("Xóa task này và toàn bộ nhánh con?")) return;
        deleteSubtree(id);
        return;
      }
    }

    if (
      !typing &&
      canvas === document.activeElement &&
      (e.key === "+" || e.key === "=")
    ) {
      e.preventDefault();
      const f = 1.1;
      view.s = Math.min(ZOOM_MAX, view.s * f);
      applyViewTransform();
      redrawAllConnectors();
      scheduleSave();
      return;
    }
    if (!typing && canvas === document.activeElement && e.key === "-") {
      e.preventDefault();
      const f = 0.9;
      view.s = Math.max(ZOOM_MIN, view.s * f);
      applyViewTransform();
      redrawAllConnectors();
      scheduleSave();
      return;
    }
    if (!typing && canvas === document.activeElement && e.key === "0") {
      e.preventDefault();
      view = { tx: 0, ty: 0, s: 1 };
      applyViewTransform();
      redrawAllConnectors();
      scheduleSave();
      return;
    }

    if (!typing && e.code === "Slash" && e.shiftKey) {
      e.preventDefault();
      window.alert(
        "Phím tắt:\n• Ctrl/⌘+S: lưu ngay vào trình duyệt\n• Bánh xe: zoom tại con trỏ (50%–200%)\n• Chuột trái trên nền canvas, chuột giữa, hoặc Space + kéo: pan\n• + / - khi ô canvas đang focus: zoom\n• 0 khi canvas focus: về 100%\n• ESC: hủy đặt task gốc\n• Delete: xóa task/subtask đang chọn và cả nhánh con (trừ khi đang gõ hoặc focus Inspector)\n• Shift+?: mở lại hộp này",
      );
    }
  });

  window.addEventListener("resize", refreshLayoutAfterChange);
  if (viewport) {
    viewport.addEventListener("scroll", redrawAllConnectors, { passive: true });
  }

  const THEME_KEY = "task-canvas-theme";
  const themeToggle = document.getElementById("theme-toggle");
  const rootEl = document.documentElement;

  function applyTheme(mode) {
    if (mode === "dark") rootEl.setAttribute("data-theme", "dark");
    else rootEl.removeAttribute("data-theme");
    if (themeToggle) {
      themeToggle.textContent = mode === "dark" ? "Light" : "Dark";
      themeToggle.setAttribute(
        "aria-label",
        mode === "dark" ? "Switch to light mode" : "Switch to dark mode",
      );
    }
    refreshInspector();
  }

  function getStoredOrSystemTheme() {
    const s = localStorage.getItem(THEME_KEY);
    if (s === "dark" || s === "light") return s;
    return "light";
  }

  applyTheme(getStoredOrSystemTheme());
  themeToggle?.addEventListener("click", () => {
    const next =
      rootEl.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  });

  bindInspector();
  initInspectorChrome();
  applyViewTransform();
  restoreFromStorage();
  if (tasks.length === 0) {
    seedDemoTasks();
  }
  refreshInspector();

  setPreviewPos(preview, 0, 0, TW, TH);
})();
