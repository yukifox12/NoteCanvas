/* 快速便签模块：同一实现服务于 Tauri 独立窗口（quick.html）与浏览器降级页内浮窗。
   无需画布工作区即可编辑；自动保存到 quickNotes；可一键存入当前画布。 */
(function () {
  'use strict';
  const B = window.NCBridge;
  const COLORS = ['yellow', 'mint', 'sky', 'rose', 'lavender', 'peach'];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9));
  const hhmm = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SVG = {
    bolt: '<svg viewBox="0 0 16 16" width="15" height="15"><path d="M8.8 1.5 3.6 9h3.2l-.8 5.5L11.6 7H8.2l.6-5.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="m3.5 3.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    inbox: '<svg viewBox="0 0 16 16"><path d="M2 9.5 3.6 3.4c.1-.5.6-.9 1.1-.9h6.6c.5 0 1 .4 1.1.9L14 9.5v3c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1v-3Zm0 0h3.6l.8 1.6h3.2l.8-1.6H14" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/></svg>',
    trash: '<svg viewBox="0 0 16 16"><path d="M2.8 4.2h10.4M6.2 4.2V2.9c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.3M4.2 4.2l.6 8.6c0 .7.6 1.2 1.3 1.2h3.8c.7 0 1.3-.5 1.3-1.2l.6-8.6M6.6 7v4M9.4 7v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="m2.8 8.4 3.4 3.4 7-7.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  };

  function defaultState() {
    return { theme: 'light', activeId: null, zTop: 10, workspaces: [], quickNotes: [] };
  }

  /* 读取最新落盘状态并补齐数组字段，避免覆盖其它窗口的修改 */
  async function freshState() {
    const s = (await B.load()) || defaultState();
    if (!Array.isArray(s.quickNotes)) s.quickNotes = [];
    if (!Array.isArray(s.workspaces)) s.workspaces = [];
    return s;
  }

  /* 挂载一张快速便签。opts: { standalone, dragEl, onClose } */
  async function mount(root, opts) {
    opts = opts || {};
    let state = await freshState();

    const params = new URLSearchParams(location.search);
    let noteId = opts.noteId !== undefined ? opts.noteId : (params.get('id') || null);
    let note = noteId ? state.quickNotes.find((n) => n.id === noteId) : null;
    let isNew = !note;
    if (!note) {
      // 新窗口携带 Rust 预生成的 id：保证窗口 label 与便签 id 一致，供侧栏定位复用
      note = { id: noteId || uid(), title: '', content: '', color: 'yellow', created: Date.now(), updated: Date.now() };
      noteId = note.id;
    }

    // 主题以当前文档为准（主窗口可能刚切换、尚未落盘）；仅独立窗口首帧采用持久化主题
    if (opts.standalone) document.documentElement.dataset.theme = state.theme || 'light';

    root.innerHTML =
      '<div class="quick-card" data-color="' + esc(note.color) + '">' +
      '  <div class="quick-head"' + (B.isTauri && opts.standalone ? ' data-tauri-drag-region' : '') + '>' +
      '    <span class="quick-badge"' + (B.isTauri && opts.standalone ? ' data-tauri-drag-region' : '') + '>' + SVG.bolt + '快速便签</span>' +
      '    <span class="quick-status"></span>' +
      '    <button class="quick-close" title="关闭此快速便签窗口">' + SVG.close + '</button>' +
      '  </div>' +
      '  <input class="quick-title" placeholder="标题" maxlength="120" />' +
      '  <textarea class="quick-body-text" placeholder="此刻的想法，先记下来…"></textarea>' +
      '  <div class="quick-swatches">' +
      COLORS.map((c) => '<button class="swatch" data-color="' + c + '" title="便签颜色"></button>').join('') +
      '  </div>' +
      '  <div class="quick-foot">' +
      '    <button class="qbtn" data-act="canvas" title="把这张便签放入当前画布工作区">' + SVG.inbox + '存入画布</button>' +
      '    <button class="qbtn danger" data-act="del">' + SVG.trash + '删除</button>' +
      '    <button class="qbtn primary" data-act="done">' + SVG.check + '完成</button>' +
      '  </div>' +
      '</div>';

    const card = root.querySelector('.quick-card');
    const head = root.querySelector('.quick-head');
    const titleEl = root.querySelector('.quick-title');
    const bodyEl = root.querySelector('.quick-body-text');
    const statusEl = root.querySelector('.quick-status');
    const swatchEls = Array.from(root.querySelectorAll('.swatch'));
    let saveTimer = null;
    let destroyed = false;

    showNote();

    function markSwatch() {
      swatchEls.forEach((s) => s.classList.toggle('on', s.dataset.color === note.color));
    }
    function setStatus(t) { statusEl.textContent = t; }
    /* 把当前 note 渲染到各控件（初始化与切换便签共用） */
    function showNote() {
      titleEl.value = note.title || '';
      bodyEl.value = note.content || '';
      card.dataset.color = note.color;
      markSwatch();
      setStatus(isNew ? '新便签 · 输入即自动保存' : '已保存 · ' + hhmm(note.updated));
    }
    /* 提示后延时关闭窗口 */
    function finish(msg, delay) {
      setStatus(msg);
      setTimeout(() => { if (opts.onClose) opts.onClose(); else B.closeSelf(); }, delay);
    }

    async function persist() {
      if (destroyed) return;
      // 空白草稿不落盘：打开后未输入任何内容就关闭，不产生垃圾便签
      if (isNew && !note.title.trim() && !note.content.trim()) return;
      // 重新读取最新状态，避免覆盖其它窗口的修改
      const fresh = await freshState();
      fresh.theme = document.documentElement.dataset.theme || fresh.theme;
      const idx = fresh.quickNotes.findIndex((n) => n.id === note.id);
      const record = { id: note.id, title: note.title, content: note.content, color: note.color, created: note.created, updated: note.updated };
      if (idx >= 0) fresh.quickNotes[idx] = record; else fresh.quickNotes.unshift(record);
      state = fresh;
      await B.save(fresh);
      isNew = false;
      setStatus('已自动保存 · ' + hhmm(note.updated));
      if (opts.onSaved) opts.onSaved();
    }
    function scheduleSave() {
      note.updated = Date.now();
      setStatus('编辑中…');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 500);
    }
    async function flush() { clearTimeout(saveTimer); await persist(); }

    titleEl.addEventListener('input', () => { note.title = titleEl.value; scheduleSave(); });
    bodyEl.addEventListener('input', () => { note.content = bodyEl.value; scheduleSave(); });

    swatchEls.forEach((s) => s.addEventListener('click', () => {
      note.color = s.dataset.color;
      card.dataset.color = note.color;
      markSwatch();
      scheduleSave();
    }));

    async function close() {
      await flush();
      if (opts.onClose) opts.onClose();
      else await B.closeSelf();
    }

    async function toCanvas() {
      await flush();
      const fresh = await freshState();
      let ws = fresh.workspaces.find((w) => w.id === fresh.activeId) || fresh.workspaces[0];
      if (!ws) {
        ws = { id: uid(), name: '收集箱', notes: [], view: { x: 0, y: 0, z: 1 }, created: Date.now() };
        fresh.workspaces.push(ws);
        fresh.activeId = ws.id;
      }
      const view = ws.view || { x: 0, y: 0, z: 1 };
      const z = view.z || 1;
      fresh.zTop = (fresh.zTop || 10) + 1;
      ws.notes.push({
        id: note.id, title: note.title, content: note.content, color: note.color,
        x: Math.round((520 - view.x) / z + (Math.random() * 60 - 30)),
        y: Math.round((280 - view.y) / z + (Math.random() * 60 - 30)),
        w: 248, h: null, z: fresh.zTop, created: note.created, updated: Date.now(),
      });
      fresh.quickNotes = fresh.quickNotes.filter((n) => n.id !== note.id);
      await B.save(fresh);
      if (opts.onSaved) opts.onSaved();
      finish('已存入「' + ws.name + '」', 650);
    }

    async function del() {
      clearTimeout(saveTimer);
      const fresh = await freshState();
      fresh.quickNotes = fresh.quickNotes.filter((n) => n.id !== note.id);
      await B.save(fresh);
      if (opts.onSaved) opts.onSaved();
      destroyed = true; // 防止 close 时再次写回
      finish('已删除', 350);
    }

    root.querySelector('[data-act="canvas"]').addEventListener('click', toCanvas);
    root.querySelector('[data-act="del"]').addEventListener('click', del);
    root.querySelector('[data-act="done"]').addEventListener('click', close);
    root.querySelector('.quick-close').addEventListener('click', close);

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); }
    });

    /* 浏览器降级：页内浮窗拖动 */
    if (!B.isTauri && opts.dragEl) {
      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        const rect = opts.dragEl.getBoundingClientRect();
        const sx = e.clientX, sy = e.clientY, ox = rect.left, oy = rect.top;
        try { head.setPointerCapture(e.pointerId); } catch (_) {}
        const move = (ev) => {
          const nx = Math.min(window.innerWidth - 80, Math.max(-rect.width + 80, ox + ev.clientX - sx));
          const ny = Math.min(window.innerHeight - 40, Math.max(0, oy + ev.clientY - sy));
          opts.dragEl.style.left = nx + 'px';
          opts.dragEl.style.top = ny + 'px';
          opts.dragEl.style.right = 'auto';
        };
        const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
        head.addEventListener('pointermove', move);
        head.addEventListener('pointerup', up);
      });
    }

    /* Tauri：快捷键再次按下时切换/新建便签 */
    B.onQuickFocus((id) => {
      if (destroyed) return;
      flush().then(async () => {
        const fresh = await freshState();
        state = fresh;
        const target = id ? fresh.quickNotes.find((n) => n.id === id) : null;
        note = target || { id: uid(), title: '', content: '', color: 'yellow', created: Date.now(), updated: Date.now() };
        noteId = note.id;
        isNew = !target;
        showNote();
        titleEl.focus();
      });
    });

    /* 其它窗口变更：同步主题（不打断正在输入的内容） */
    const offSync = B.onSync(async () => {
      const fresh = await B.load();
      if (fresh && fresh.theme && opts.standalone) document.documentElement.dataset.theme = fresh.theme;
    });

    setTimeout(() => titleEl.focus(), 60);

    return {
      destroy() { destroyed = true; clearTimeout(saveTimer); if (offSync) offSync(); root.innerHTML = ''; },
      flush,
    };
  }

  window.QuickNote = { mount };

  /* quick.html 独立窗口自动初始化 */
  if (document.body && document.body.hasAttribute('data-quick-standalone')) {
    mount(document.getElementById('quick-root'), { standalone: true });
  }
})();