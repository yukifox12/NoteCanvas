/* 桥接层：Tauri 环境走 Rust 命令 + 事件；纯浏览器环境降级为 localStorage + 页内快速便签面板。
   前端逻辑对两种环境完全一致。 */
(function () {
  'use strict';
  const T = window.__TAURI__;
  const isTauri = !!(T && T.core && T.core.invoke);
  const LS_KEY = 'notecanvas-state-v1';
  const label = isTauri
    ? T.window.getCurrentWindow().label
    : (location.pathname.split('/').pop() === 'quick.html' ? 'quick' : 'main');

  let bc = null;
  try { bc = new BroadcastChannel('notecanvas-sync'); } catch (_) { /* file:// 下可能不可用 */ }

  const bridge = {
    isTauri,
    label,

    async load() {
      if (isTauri) {
        const raw = await T.core.invoke('load_state');
        return raw && raw !== 'null' ? JSON.parse(raw) : null;
      }
      try {
        const raw = localStorage.getItem(LS_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (_) { return null; }
    },

    async save(state) {
      const data = JSON.stringify(state);
      if (isTauri) {
        await T.core.invoke('save_state', { data, origin: label });
      } else {
        try { localStorage.setItem(LS_KEY, data); } catch (_) {}
        if (bc) { try { bc.postMessage({ origin: label }); } catch (_) {} }
        window.dispatchEvent(new CustomEvent('nc-local-sync', { detail: { origin: label } }));
      }
    },

    /* 其它窗口保存后回调（忽略自身回声）。返回注销函数。 */
    onSync(cb) {
      if (isTauri) {
        const un = T.event.listen('state-sync', (e) => { if (e.payload !== label) cb(); });
        return () => { un.then((f) => f()); };
      }
      const local = (e) => { if (e.detail.origin !== label) cb(); };
      const storage = (e) => { if (e.key === LS_KEY) cb(); };
      window.addEventListener('nc-local-sync', local);
      window.addEventListener('storage', storage);
      if (bc) bc.onmessage = (e) => { if (e.data && e.data.origin !== label) cb(); };
      return () => {
        window.removeEventListener('nc-local-sync', local);
        window.removeEventListener('storage', storage);
        if (bc) bc.onmessage = null;
      };
    },

    async openQuick(id) {
      if (isTauri) {
        await T.core.invoke('open_quick', { id: id || null });
      } else if (window.__quickFallback) {
        window.__quickFallback(id || null);
      }
    },

    /* 快速便签窗口：监听主窗口/快捷键发来的聚焦请求 */
    onQuickFocus(cb) {
      if (isTauri) T.event.listen('quick-focus', (e) => cb(e.payload || null));
    },

    /* 快速便签窗口：关闭并销毁（内容已落盘，支持多窗口并存） */
    async closeSelf() {
      if (isTauri) {
        await T.window.getCurrentWindow().close();
      } else if (window.__quickFallbackClose) {
        window.__quickFallbackClose();
      }
    },

    /* 状态文件保存目录 */
    async getDataDir() {
      if (isTauri) return await T.core.invoke('get_data_dir');
      return null;
    },
    async setDataDir(path) {
      if (isTauri) return await T.core.invoke('set_data_dir', { path: path || null });
      return null;
    },
    async pickDirectory() {
      if (isTauri) {
        return await T.core.invoke('plugin:dialog|open', {
          options: { directory: true, title: '选择状态文件保存目录' },
        });
      }
      return null;
    },

    onTrayHint(cb) {
      if (isTauri) T.event.listen('tray-hint', () => cb());
    },

    async shortcutOk() {
      if (isTauri) return await T.core.invoke('shortcut_ok');
      return true;
    },

    /* 主题缓存：供 quick.html 启动时同步取用，避免闪烁 */
    cacheTheme(theme) {
      try { localStorage.setItem('nc-theme', theme); } catch (_) {}
    },
  };

  window.NCBridge = bridge;
})();