/* 便签画布 · 主窗口逻辑
   画布工作区 / 点击空白新建便签 / 拖动移动 / 编辑 / 删除撤销 / 缩放平移 / 双主题 / 快速便签入口 */
(function () {
  'use strict';
  const B = window.NCBridge;
  const $ = (s) => document.querySelector(s);
  const COLORS = ['yellow', 'mint', 'sky', 'rose', 'lavender', 'peach'];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const capture = (el, id) => { try { el.setPointerCapture(id); } catch (_) {} };
  const hhmm = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const stamp = (t) => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hhmm(t); };
  const icon = (id, cls) => '<svg class="' + (cls || '') + '"><use href="#' + id + '"/></svg>';
  const sideEmpty = (text) => {
    const d = document.createElement('div');
    d.className = 'side-empty';
    d.textContent = text;
    return d;
  };

  /* 行内重命名输入框：Enter/失焦提交、Esc 取消；commit 收到trim后的新名或 null */
  function renameInput(value, commit) {
    const input = document.createElement('input');
    input.maxLength = 40;
    input.value = value;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      commit(ok && input.value.trim() ? input.value.trim() : null);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    return input;
  }

  /* 指针拖拽会话：抬起/取消时自动解绑并回调 onEnd */
  function pointerDrag(el, e, onMove, onEnd) {
    capture(el, e.pointerId);
    const up = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (onEnd) onEnd();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  const viewport = $('#viewport'), world = $('#world'), emptyHint = $('#canvas-empty');
  const mainArea = $('#main-area'), toolbar = $('#toolbar');
  const wsListEl = $('#ws-list'), quickListEl = $('#quick-list');
  const wsTitleEl = $('#ws-title'), wsMetaEl = $('#ws-meta'), wsTotalEl = $('#ws-total');
  const zoomLabel = $('#zoom-label');
  const toastZone = $('#toast-zone');
  const noteEl = (id) => world.querySelector('.note[data-id="' + CSS.escape(id) + '"]');

  let state = null;
  let saveTimer = null;
  let noWsEl = null;
  let dragWsId = null;
  const expandedWs = new Set();

  /* ---------------- 状态 ---------------- */
  function defaultState() {
    return { theme: 'light', activeId: null, zTop: 10, workspaces: [], quickNotes: [] };
  }
  function normalize(s) {
    s = s || defaultState();
    if (!Array.isArray(s.workspaces)) s.workspaces = [];
    if (!Array.isArray(s.quickNotes)) s.quickNotes = [];
    if (typeof s.zTop !== 'number') s.zTop = 10;
    if (!s.theme) s.theme = 'light';
    s.workspaces.forEach((w) => {
      if (!Array.isArray(w.notes)) w.notes = [];
      if (!w.view) w.view = { x: 0, y: 0, z: 1 };
    });
    if (s.activeId && !s.workspaces.some((w) => w.id === s.activeId)) s.activeId = s.workspaces[0] ? s.workspaces[0].id : null;
    if (!s.activeId && s.workspaces[0]) s.activeId = s.workspaces[0].id;
    return s;
  }
  function seedState() {
    const t = Date.now();
    const ws = {
      id: uid(), name: '欢迎使用便签画布', created: t, view: { x: 0, y: 0, z: 1 },
      notes: [
        { id: uid(), x: 64, y: 64, w: 292, h: null, z: 3, color: 'yellow', created: t, updated: t, title: '欢迎使用便签画布', content: '单击画布空白处，即可在当前位置落下一张新便签。\n\n拖动便签标题栏可以随意移动；悬停右下角手柄可调整大小；底部圆点可以换颜色。' },
        { id: uid(), x: 412, y: 108, w: 268, h: null, z: 2, color: 'sky', created: t, updated: t, title: '快捷键速览', content: 'Ctrl + Alt + N　随时打开快速便签\nCtrl + 滚轮　缩放画布\n拖拽空白处　平移画布\nEsc　关闭快速便签窗口' },
        { id: uid(), x: 210, y: 352, w: 260, h: null, z: 1, color: 'mint', created: t, updated: t, title: '今日待办', content: '□ 整理桌面便签\n□ 给妈妈回电话\n□ 读完《设计中的设计》第 3 章' },
      ],
    };
    return {
      theme: 'light', activeId: ws.id, zTop: 10, workspaces: [ws],
      quickNotes: [{ id: uid(), title: '灵感速记', content: '好记性不如烂笔头 —— 想到什么，Ctrl + Alt + N 先记下来。', color: 'rose', created: t, updated: t }],
    };
  }
  const activeWs = () => state.workspaces.find((w) => w.id === state.activeId) || null;

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => B.save(state), 250);
  }
  function flushSave() { clearTimeout(saveTimer); B.save(state); }

  /* ---------------- 主题 ---------------- */
  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    B.cacheTheme(state.theme);
    document.querySelectorAll('[data-theme-opt]').forEach((b) => b.classList.toggle('on', b.dataset.themeOpt === state.theme));
  }

  /* ---------------- Toast ---------------- */
  function showToast(msg, opts) {
    opts = opts || {};
    const duration = opts.duration || 5200;
    const el = document.createElement('div');
    el.className = 'toast';
    const type = opts.type || 'ok';
    const iconId = type === 'ok' ? 'i-check' : type === 'info' ? 'i-info' : 'i-trash';
    el.innerHTML = icon(iconId, 'toast-icon ' + type) + '<span class="toast-msg"></span>';
    el.querySelector('.toast-msg').textContent = msg;
    if (opts.actionLabel) {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = opts.actionLabel;
      btn.addEventListener('click', () => { dismiss(); opts.onAction && opts.onAction(); });
      el.appendChild(btn);
    }
    const bar = document.createElement('span');
    bar.className = 'toast-bar';
    bar.style.animationDuration = duration + 'ms';
    el.appendChild(bar);
    toastZone.appendChild(el);
    while (toastZone.children.length > 3) toastZone.firstChild.remove();
    let timer = setTimeout(dismiss, duration);
    function dismiss() {
      clearTimeout(timer);
      if (!el.isConnected) return;
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    }
    el.addEventListener('pointerenter', () => { clearTimeout(timer); bar.style.animationPlayState = 'paused'; });
    el.addEventListener('pointerleave', () => { bar.style.animationPlayState = 'running'; timer = setTimeout(dismiss, 1800); });
  }

  /* ---------------- 侧栏 ---------------- */
  function renderSidebar() {
    wsTotalEl.textContent = state.workspaces.length ? state.workspaces.length + ' 个' : '';
    wsListEl.innerHTML = '';
    if (!state.workspaces.length) wsListEl.appendChild(sideEmpty('还没有画布工作区，点击上方按钮创建第一块画布。'));
    state.workspaces.forEach((ws, i) => wsListEl.appendChild(buildWsBlock(ws, i)));

    quickListEl.innerHTML = '';
    const quicks = state.quickNotes.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (!quicks.length) quickListEl.appendChild(sideEmpty('Ctrl + Alt + N 随时速记，无需打开画布。'));
    quicks.forEach((n, i) => quickListEl.appendChild(buildQuickItem(n, i)));
  }

  /* 工作区块：头部行（点击展开/收缩、拖拽排序）+ 便签子列表（点击定位） */
  function buildWsBlock(ws, i) {
    const block = document.createElement('div');
    block.className = 'ws-block' + (expandedWs.has(ws.id) ? ' expanded' : '');
    block.dataset.id = ws.id;
    const item = document.createElement('div');
    item.className = 'ws-item' + (ws.id === state.activeId ? ' active' : '');
    item.style.animationDelay = Math.min(i * 40, 240) + 'ms';
    item.draggable = true;
    item.title = '点击展开/收缩便签列表 · 拖动调整顺序';
    item.innerHTML =
      '<span class="ws-caret">' + icon('i-chevron') + '</span>' +
      icon('i-canvas', 'ws-icon') +
      '<span class="ws-name"></span>' +
      '<span class="ws-count">' + ws.notes.length + '</span>' +
      '<span class="ws-actions">' +
      '  <button class="icon-btn" data-act="rename" title="重命名">' + icon('i-pencil') + '</button>' +
      '  <button class="icon-btn danger" data-act="del" title="删除工作区">' + icon('i-trash') + '</button>' +
      '</span>';
    item.querySelector('.ws-name').textContent = ws.name;
    item.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) {
        e.stopPropagation();
        if (act.dataset.act === 'rename') startRename(ws, item.querySelector('.ws-name'));
        else deleteWorkspace(ws.id);
        return;
      }
      if (ws.id !== state.activeId) {
        state.activeId = ws.id;
        expandedWs.add(ws.id);
        renderAll();
        scheduleSave();
      } else if (expandedWs.has(ws.id)) {
        expandedWs.delete(ws.id);
        renderSidebar();
      } else {
        expandedWs.add(ws.id);
        renderSidebar();
      }
    });

    /* 拖拽排序 */
    item.addEventListener('dragstart', (e) => {
      dragWsId = ws.id;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', ws.id); } catch (_) {}
      requestAnimationFrame(() => block.classList.add('dragging'));
    });
    item.addEventListener('dragend', () => {
      dragWsId = null;
      block.classList.remove('dragging');
      clearDropMarks();
    });
    block.addEventListener('dragover', (e) => {
      if (!dragWsId || dragWsId === ws.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = item.getBoundingClientRect();
      clearDropMarks();
      block.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    block.addEventListener('dragleave', (e) => {
      if (!block.contains(e.relatedTarget)) block.classList.remove('drop-before', 'drop-after');
    });
    block.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragWsId || dragWsId === ws.id) return;
      const before = block.classList.contains('drop-before');
      moveWorkspace(dragWsId, ws.id, before);
      dragWsId = null;
      clearDropMarks();
    });
    block.appendChild(item);

    if (ws.notes.length) {
      const sub = document.createElement('div');
      sub.className = 'ws-notes';
      ws.notes.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0)).forEach((n) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ws-note-row';
        row.dataset.id = n.id;
        row.title = '点击定位到这张便签';
        row.innerHTML =
          '<span class="qdot" data-color="' + (COLORS.includes(n.color) ? n.color : 'yellow') + '"></span>' +
          '<span class="ws-note-title"></span>';
        row.querySelector('.ws-note-title').textContent = n.title || '无标题便签';
        row.addEventListener('click', (e) => { e.stopPropagation(); locateNote(ws, n); });
        sub.appendChild(row);
      });
      block.appendChild(sub);
    }
    return block;
  }

  function buildQuickItem(n, i) {
    const item = document.createElement('div');
    item.className = 'q-item';
    item.style.animationDelay = Math.min(i * 40, 240) + 'ms';
    item.innerHTML =
      '<span class="qdot" data-color="' + (COLORS.includes(n.color) ? n.color : 'yellow') + '"></span>' +
      '<span class="q-text"><span class="q-title"></span><span class="q-snippet"></span></span>' +
      '<button class="icon-btn danger" title="删除快速便签">' + icon('i-trash') + '</button>';
    item.querySelector('.q-title').textContent = n.title || '无标题便签';
    item.querySelector('.q-snippet').textContent = (n.content || '').split('\n')[0] || '空白便签';
    item.addEventListener('click', (e) => {
      if (e.target.closest('.icon-btn')) { e.stopPropagation(); deleteQuick(n.id); return; }
      B.openQuick(n.id);
    });
    return item;
  }

  function clearDropMarks() {
    wsListEl.querySelectorAll('.drop-before,.drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  }

  function moveWorkspace(srcId, targetId, before) {
    const arr = state.workspaces;
    const si = arr.findIndex((w) => w.id === srcId);
    if (si < 0) return;
    const [ws] = arr.splice(si, 1);
    const ti = arr.findIndex((w) => w.id === targetId);
    if (ti < 0) { arr.splice(si, 0, ws); return; }
    arr.splice(before ? ti : ti + 1, 0, ws);
    renderAll();
    scheduleSave();
  }

  /* 子列表点击：切换工作区并居中定位便签 */
  function locateNote(ws, note) {
    if (state.activeId !== ws.id) { state.activeId = ws.id; renderAll(); }
    expandedWs.add(ws.id);
    const v = ws.view;
    const r = viewport.getBoundingClientRect();
    const el = noteEl(note.id);
    const w = note.w || 248;
    const h = el ? el.offsetHeight : 180;
    v.x = Math.round(r.width / 2 - (note.x + w / 2) * v.z);
    v.y = Math.round(r.height / 2 - (note.y + h / 2) * v.z);
    note.z = ++state.zTop;
    if (el) {
      el.style.zIndex = note.z;
      el.classList.remove('locate-flash');
      void el.offsetWidth;
      el.classList.add('locate-flash');
      setTimeout(() => el.classList.remove('locate-flash'), 1500);
    }
    applyView();
    scheduleSave();
  }

  /* 编辑时就地更新子列表行，避免整表重绘闪烁 */
  function syncNoteRow(note) {
    const row = wsListEl.querySelector('.ws-note-row[data-id="' + CSS.escape(note.id) + '"]');
    if (!row) return;
    row.querySelector('.ws-note-title').textContent = note.title || '无标题便签';
    row.querySelector('.qdot').dataset.color = COLORS.includes(note.color) ? note.color : 'yellow';
  }

  function startRename(ws, nameEl) {
    const item = nameEl.closest('.ws-item');
    if (item) item.draggable = false;
    const input = renameInput(ws.name, (name) => {
      if (name) { ws.name = name; scheduleSave(); }
      renderAll();
    });
    input.className = 'ws-rename';
    nameEl.replaceWith(input);
    input.focus();
    input.select();
  }

  function newWorkspace() {
    let n = state.workspaces.length + 1;
    let name = '画布 ' + n;
    while (state.workspaces.some((w) => w.name === name)) name = '画布 ' + (++n);
    const ws = { id: uid(), name, notes: [], view: { x: 0, y: 0, z: 1 }, created: Date.now() };
    state.workspaces.unshift(ws);
    state.activeId = ws.id;
    expandedWs.add(ws.id);
    renderAll();
    scheduleSave();
    const nameEl = wsListEl.querySelector('.ws-item .ws-name');
    if (nameEl) startRename(ws, nameEl);
    showToast('已创建「' + name + '」，点击画布空白处落下第一张便签', { type: 'info' });
  }

  function deleteWorkspace(id) {
    const idx = state.workspaces.findIndex((w) => w.id === id);
    if (idx < 0) return;
    const wasActive = state.activeId === id;
    const [ws] = state.workspaces.splice(idx, 1);
    if (wasActive) state.activeId = state.workspaces[0] ? state.workspaces[0].id : null;
    renderAll();
    scheduleSave();
    showToast('已删除工作区「' + ws.name + '」（' + ws.notes.length + ' 张便签）', {
      type: 'warn', actionLabel: '撤销', duration: 6500,
      onAction() {
        state.workspaces.splice(Math.min(idx, state.workspaces.length), 0, ws);
        if (wasActive || !state.activeId) state.activeId = ws.id;
        renderAll(); scheduleSave();
      },
    });
  }

  function deleteQuick(id) {
    const idx = state.quickNotes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const [n] = state.quickNotes.splice(idx, 1);
    renderSidebar();
    scheduleSave();
    showToast('已删除快速便签「' + (n.title || '无标题便签') + '」', {
      type: 'warn', actionLabel: '撤销', duration: 6500,
      onAction() { state.quickNotes.splice(Math.min(idx, state.quickNotes.length), 0, n); renderSidebar(); scheduleSave(); },
    });
  }

  /* ---------------- 主区 / 画布 ---------------- */
  function renderMain() {
    const ws = activeWs();
    if (!ws) {
      toolbar.style.display = 'none';
      viewport.style.display = 'none';
      if (!noWsEl) {
        noWsEl = document.createElement('div');
        noWsEl.className = 'no-workspace';
        noWsEl.innerHTML =
          icon('i-empty-note') +
          '<h2>从一个画布工作区开始</h2>' +
          '<p>每个工作区是一块无限画布，可以容纳任意多张便签</p>' +
          '<div style="display:flex;gap:10px">' +
          '  <button class="btn btn-primary" data-act="new-ws">' + icon('i-plus') + '新建画布工作区</button>' +
          '  <button class="btn btn-ghost" data-act="quick">' + icon('i-bolt') + '先记一张快速便签</button>' +
          '</div>';
        noWsEl.querySelector('[data-act="new-ws"]').addEventListener('click', newWorkspace);
        noWsEl.querySelector('[data-act="quick"]').addEventListener('click', () => B.openQuick(null));
        mainArea.appendChild(noWsEl);
      }
      noWsEl.style.display = 'flex';
      return;
    }
    if (noWsEl) noWsEl.style.display = 'none';
    toolbar.style.display = 'flex';
    viewport.style.display = 'block';
    wsTitleEl.textContent = ws.name;
    wsMetaEl.textContent = ws.notes.length + ' 张便签';
    renderNotes();
    applyView();
  }

  function captureFocus() {
    const a = document.activeElement;
    if (!a || !a.closest) return null;
    const noteEl = a.closest('.note');
    if (!noteEl) return null;
    return { id: noteEl.dataset.id, field: a.classList.contains('note-title') ? 'title' : 'body', s: a.selectionStart, e: a.selectionEnd };
  }
  function restoreFocus(f) {
    if (!f) return;
    const el = noteEl(f.id);
    if (!el) return;
    const input = el.querySelector(f.field === 'title' ? '.note-title' : '.note-body');
    if (input) { input.focus(); try { input.setSelectionRange(f.s, f.e); } catch (_) {} }
  }

  function renderNotes() {
    const ws = activeWs();
    const focus = captureFocus();
    world.innerHTML = '';
    if (!ws) return;
    ws.notes.slice().sort((a, b) => (a.z || 0) - (b.z || 0)).forEach((n) => world.appendChild(createNoteEl(n)));
    emptyHint.hidden = ws.notes.length > 0;
    restoreFocus(focus);
  }

  function fitBody(ta, note) {
    if (note.h) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 420) + 'px';
  }

  function createNoteEl(note) {
    const el = document.createElement('article');
    el.className = 'note';
    el.dataset.id = note.id;
    el.dataset.color = COLORS.includes(note.color) ? note.color : 'yellow';
    el.style.left = note.x + 'px';
    el.style.top = note.y + 'px';
    el.style.width = (note.w || 248) + 'px';
    el.style.zIndex = note.z || 1;
    if (note.h) { el.classList.add('fixed-h'); el.style.height = note.h + 'px'; }
    el.innerHTML =
      '<header class="note-head">' +
      '  <span class="grip">' + icon('i-grip') + '</span>' +
      '  <input class="note-title" placeholder="标题" maxlength="120" />' +
      '  <button class="note-del" title="删除便签">' + icon('i-close') + '</button>' +
      '</header>' +
      '<textarea class="note-body" placeholder="写点什么…"></textarea>' +
      '<footer class="note-foot">' +
      '  <span class="swatches">' + COLORS.map((c) => '<button class="swatch" data-color="' + c + '" title="换颜色"></button>').join('') + '</span>' +
      '  <span class="note-time"></span>' +
      '  <span class="resize-handle" title="拖动调整大小">' + icon('i-resize') + '</span>' +
      '</footer>';

    const head = el.querySelector('.note-head');
    const titleEl = el.querySelector('.note-title');
    const bodyEl = el.querySelector('.note-body');
    const timeEl = el.querySelector('.note-time');
    titleEl.value = note.title || '';
    bodyEl.value = note.content || '';
    timeEl.textContent = stamp(note.updated || note.created || Date.now());
    const markSwatch = () => el.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.color === note.color));
    const touch = () => { note.updated = Date.now(); timeEl.textContent = stamp(note.updated); };
    markSwatch();
    requestAnimationFrame(() => fitBody(bodyEl, note));

    /* 点击便签任意处置顶 */
    el.addEventListener('pointerdown', () => {
      note.z = ++state.zTop;
      el.style.zIndex = note.z;
      scheduleSave();
    });

    /* 拖动标题栏移动便签 */
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('input,button')) return;
      e.preventDefault();
      const view = activeWs().view;
      const sx = e.clientX, sy = e.clientY, ox = note.x, oy = note.y;
      el.classList.add('dragging');
      pointerDrag(head, e, (ev) => {
        note.x = Math.round(ox + (ev.clientX - sx) / view.z);
        note.y = Math.round(oy + (ev.clientY - sy) / view.z);
        el.style.left = note.x + 'px';
        el.style.top = note.y + 'px';
      }, () => {
        el.classList.remove('dragging');
        scheduleSave();
      });
    });

    /* 编辑 */
    titleEl.addEventListener('input', () => {
      note.title = titleEl.value;
      touch();
      syncNoteRow(note);
      scheduleSave();
    });
    bodyEl.addEventListener('input', () => {
      note.content = bodyEl.value;
      touch();
      fitBody(bodyEl, note);
      scheduleSave();
    });
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); bodyEl.focus(); }
      e.stopPropagation();
    });
    bodyEl.addEventListener('keydown', (e) => e.stopPropagation());

    /* 删除 */
    el.querySelector('.note-del').addEventListener('click', () => deleteNote(note.id));

    /* 颜色 */
    el.querySelectorAll('.swatch').forEach((s) => s.addEventListener('click', () => {
      note.color = s.dataset.color;
      el.dataset.color = note.color;
      touch();
      markSwatch();
      syncNoteRow(note);
      scheduleSave();
    }));

    /* 调整大小 */
    const handle = el.querySelector('.resize-handle');
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const view = activeWs().view;
      const sx = e.clientX, sy = e.clientY;
      const ow = note.w || 248, oh = note.h || el.offsetHeight;
      pointerDrag(handle, e, (ev) => {
        note.w = Math.round(clamp(ow + (ev.clientX - sx) / view.z, 200, 620));
        note.h = Math.round(clamp(oh + (ev.clientY - sy) / view.z, 150, 700));
        el.style.width = note.w + 'px';
        el.style.height = note.h + 'px';
        el.classList.add('fixed-h');
      }, scheduleSave);
    });

    return el;
  }

  function addNote(wx, wy, focusIt) {
    const ws = activeWs();
    if (!ws) { newWorkspace(); return addNote(wx, wy, focusIt); }
    const note = {
      id: uid(), title: '', content: '',
      color: COLORS[ws.notes.length % COLORS.length],
      x: Math.round(wx), y: Math.round(wy), w: 248, h: null,
      z: ++state.zTop, created: Date.now(), updated: Date.now(),
    };
    ws.notes.push(note);
    renderNotes();
    wsMetaEl.textContent = ws.notes.length + ' 张便签';
    renderSidebar();
    scheduleSave();
    if (focusIt !== false) {
      const el = noteEl(note.id);
      if (el) el.querySelector('.note-title').focus();
    }
    return note;
  }

  function deleteNote(id) {
    const ws = activeWs();
    if (!ws) return;
    const idx = ws.notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const [note] = ws.notes.splice(idx, 1);
    renderNotes();
    wsMetaEl.textContent = ws.notes.length + ' 张便签';
    renderSidebar();
    scheduleSave();
    showToast('已删除便签「' + (note.title || '无标题便签') + '」', {
      type: 'warn', actionLabel: '撤销', duration: 6500,
      onAction() {
        const cur = activeWs();
        if (!cur || cur.id !== ws.id) { state.activeId = ws.id; }
        ws.notes.splice(Math.min(idx, ws.notes.length), 0, note);
        renderAll(); scheduleSave();
      },
    });
  }

  /* ---------------- 视图：平移 / 缩放 ---------------- */
  function applyView() {
    const ws = activeWs();
    if (!ws) return;
    const v = ws.view;
    world.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.z + ')';
    viewport.style.backgroundSize = 24 * v.z + 'px ' + 24 * v.z + 'px';
    viewport.style.backgroundPosition = v.x + 'px ' + v.y + 'px';
    zoomLabel.textContent = Math.round(v.z * 100) + '%';
  }
  function zoomAt(cx, cy, factor) {
    const ws = activeWs();
    if (!ws) return;
    const v = ws.view;
    const rect = viewport.getBoundingClientRect();
    const nz = clamp(v.z * factor, 0.4, 2.5);
    const px = (cx - rect.left - v.x) / v.z;
    const py = (cy - rect.top - v.y) / v.z;
    v.x = cx - rect.left - px * nz;
    v.y = cy - rect.top - py * nz;
    v.z = nz;
    applyView();
    scheduleSave();
  }
  function zoomCenter(factor) {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }
  function resetView() {
    const ws = activeWs();
    if (!ws) return;
    ws.view = { x: 0, y: 0, z: 1 };
    applyView();
    scheduleSave();
  }

  /* 画布指针：空白单击新建 / 拖拽平移 */
  let panSession = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target !== viewport) return;
    const ws = activeWs();
    if (!ws) return;
    panSession = { sx: e.clientX, sy: e.clientY, ox: ws.view.x, oy: ws.view.y, panned: false };
    capture(viewport, e.pointerId);
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!panSession) return;
    const ws = activeWs();
    if (!ws) return;
    const dx = e.clientX - panSession.sx, dy = e.clientY - panSession.sy;
    if (!panSession.panned && Math.hypot(dx, dy) > 4) {
      panSession.panned = true;
      viewport.classList.add('panning');
    }
    if (panSession.panned) {
      ws.view.x = panSession.ox + dx;
      ws.view.y = panSession.oy + dy;
      applyView();
    }
  });
  function endPan(e) {
    if (!panSession) return;
    const s = panSession;
    panSession = null;
    viewport.classList.remove('panning');
    if (!s.panned && e.type === 'pointerup') {
      const ws = activeWs();
      if (!ws) return;
      const rect = viewport.getBoundingClientRect();
      const wx = (e.clientX - rect.left - ws.view.x) / ws.view.z - 24;
      const wy = (e.clientY - rect.top - ws.view.y) / ws.view.z - 14;
      addNote(wx, wy);
    } else if (s.panned) {
      scheduleSave();
    }
  }
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);

  viewport.addEventListener('wheel', (e) => {
    const ws = activeWs();
    if (!ws) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    } else {
      ws.view.x -= e.deltaX;
      ws.view.y -= e.deltaY;
      applyView();
      scheduleSave();
    }
  }, { passive: false });

  /* ---------------- 快速便签：浏览器降级浮窗 ---------------- */
  let quickPanel = null;
  function closeQuickPanel() {
    if (!quickPanel) return;
    const p = quickPanel;
    quickPanel = null;
    p.mask.remove();
    p.float.remove();
    p.controller.destroy();
  }
  window.__quickFallbackClose = closeQuickPanel;
  window.__quickFallback = (id) => {
    if (quickPanel) closeQuickPanel();
    const mask = document.createElement('div');
    mask.className = 'quick-float-mask';
    const float = document.createElement('div');
    float.className = 'quick-float';
    document.body.appendChild(mask);
    document.body.appendChild(float);
    quickPanel = { mask, float, controller: null };
    mask.addEventListener('click', () => {
      if (quickPanel && quickPanel.controller) quickPanel.controller.flush().then(closeQuickPanel);
      else closeQuickPanel();
    });
    QuickNote.mount(float, {
      standalone: false,
      noteId: id || null,
      dragEl: float,
      onClose: closeQuickPanel,
      onSaved: refreshFromStore,
    }).then((ctrl) => { if (quickPanel) quickPanel.controller = ctrl; });
  };

  /* ---------------- 设置：数据保存位置 ---------------- */
  let settingsMask = null;
  async function openSettings() {
    if (settingsMask) return;
    const dir = await B.getDataDir();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal" role="dialog" aria-label="数据保存位置">' +
      '  <div class="modal-head"><h3>数据保存位置</h3><button class="icon-btn" data-act="close" title="关闭">' + icon('i-close') + '</button></div>' +
      '  <p class="modal-desc">所有便签板、便签与快速便签实时保存在该目录的 state.json 文件中。更改目录后，原文件保留不删除。</p>' +
      '  <div class="modal-path"><code></code></div>' +
      '  <div class="modal-actions">' +
      '    <button class="btn btn-ghost" data-act="reset">恢复默认</button>' +
      '    <button class="btn btn-primary" data-act="pick">' + icon('i-folder') + '更改目录</button>' +
      '  </div>' +
      '</div>';
    const pathEl = mask.querySelector('.modal-path code');
    pathEl.textContent = dir || '浏览器本地存储（localStorage）· 桌面版可自定义保存目录';
    const pickBtn = mask.querySelector('[data-act="pick"]');
    const resetBtn = mask.querySelector('[data-act="reset"]');
    if (!B.isTauri) { pickBtn.disabled = true; resetBtn.disabled = true; }
    const close = () => { mask.remove(); settingsMask = null; document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    mask.querySelector('[data-act="close"]').addEventListener('click', close);
    async function apply(p) {
      try {
        const nd = await B.setDataDir(p);
        pathEl.textContent = nd;
        await refreshFromStore();
        showToast(p ? '保存位置已更新' : '已恢复默认保存位置', { type: 'ok' });
      } catch (err) {
        showToast('更改保存位置失败：' + err, { type: 'warn' });
      }
    }
    pickBtn.addEventListener('click', async () => {
      try {
        const p = await B.pickDirectory();
        if (p) await apply(p);
      } catch (err) {
        showToast('打开目录选择器失败：' + err, { type: 'warn' });
      }
    });
    resetBtn.addEventListener('click', () => apply(null));
    document.body.appendChild(mask);
    settingsMask = mask;
  }

  /* ---------------- 同步 ---------------- */
  async function refreshFromStore() {
    const fresh = await B.load();
    if (!fresh) return;
    const focus = captureFocus();
    state = normalize(fresh);
    applyTheme();
    renderAll();
    restoreFocus(focus);
  }

  /* ---------------- 渲染入口 ---------------- */
  function renderAll() { renderSidebar(); renderMain(); }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $('#btn-new-ws').addEventListener('click', newWorkspace);
    $('#btn-new-quick').addEventListener('click', () => B.openQuick(null));
    $('#btn-quick-open').addEventListener('click', () => B.openQuick(null));
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-new-note').addEventListener('click', () => {
      const ws = activeWs();
      if (!ws) { newWorkspace(); return; }
      const r = viewport.getBoundingClientRect();
      const wx = (r.width / 2 - ws.view.x) / ws.view.z - 124 + (Math.random() * 48 - 24);
      const wy = (r.height / 2 - ws.view.y) / ws.view.z - 70 + (Math.random() * 48 - 24);
      addNote(wx, wy);
    });
    $('#zoom-in').addEventListener('click', () => zoomCenter(1.2));
    $('#zoom-out').addEventListener('click', () => zoomCenter(1 / 1.2));
    $('#zoom-reset').addEventListener('click', resetView);
    zoomLabel.addEventListener('click', resetView);

    wsTitleEl.addEventListener('click', () => {
      const ws = activeWs();
      if (!ws) return;
      const input = renameInput(ws.name, (name) => {
        if (name) { ws.name = name; scheduleSave(); }
        input.replaceWith(wsTitleEl);
        renderAll();
      });
      input.className = 'ws-title-input';
      wsTitleEl.replaceWith(input);
      input.focus();
      input.select();
    });

    document.querySelectorAll('[data-theme-opt]').forEach((btn) => btn.addEventListener('click', () => {
      state.theme = btn.dataset.themeOpt;
      applyTheme();
      scheduleSave();
    }));

    /* 浏览器环境的全局快捷键（Tauri 中由 Rust 全局快捷键插件处理） */
    window.addEventListener('keydown', (e) => {
      if (!B.isTauri && e.ctrlKey && e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        window.__quickFallback(null);
      }
    });

    B.onSync(refreshFromStore);
    B.onTrayHint(() => showToast('已收起至系统托盘 · 单击托盘图标恢复工作区，Ctrl + Alt + N 随时速记', { type: 'info', duration: 6500 }));

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
    window.addEventListener('beforeunload', flushSave);
    window.addEventListener('resize', () => applyView());
  }

  /* ---------------- 启动 ---------------- */
  async function init() {
    const loaded = await B.load();
    const firstRun = !loaded;
    state = normalize(loaded || seedState());
    if (state.activeId) expandedWs.add(state.activeId);
    applyTheme();
    renderAll();
    bind();
    if (firstRun) flushSave();
    if (!(await B.shortcutOk())) {
      showToast('Ctrl + Alt + N 已被其它程序占用 · 可用侧栏「快速便签」按钮或托盘菜单速记', { type: 'info', duration: 8000 });
    }
  }
  init();
})();