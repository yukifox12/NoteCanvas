/* 真机冒烟测试：启动编译产物 exe（WebView2 远程调试），验证
   种子渲染 / 点击建签 / Rust open_quick 命令 / 跨窗口主题同步 / 磁盘持久化。
   运行：node scripts/smoke-tauri.mjs [exe路径]
   注意：wry 总是显式设置 AdditionalBrowserArguments，环境变量
   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 会被忽略。测试前需临时在
   tauri.conf.json 主窗口加 "additionalBrowserArgs":
   "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9228"
   并重新编译；正式产物不应包含调试端口。 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.argv[2] || join(root, 'src-tauri', 'target', 'debug', 'notecanvas.exe');
const PORT = 9228;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (n, c, x) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); if (!c) fails.push(n); };

const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: 'ignore',
});

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch (_) { return []; }
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const pend = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
    ws.onopen = () => resolve({
      send(method, params = {}) { return new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); }); },
      close() { ws.close(); },
    });
    ws.onerror = reject;
  });
}
async function ev(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function click(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(40);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(200);
}

async function main() {
  let list = [];
  for (let i = 0; i < 60; i++) { list = await targets(); if (list.some((t) => t.type === 'page' && /tauri\.localhost|index\.html/.test(t.url))) break; await sleep(400); }
  const mainTarget = list.find((t) => t.type === 'page' && /tauri\.localhost|index\.html/.test(t.url));
  check('应用启动且主窗口 WebView2 就绪', !!mainTarget, mainTarget && mainTarget.url);
  if (!mainTarget) throw new Error('主窗口未就绪');
  const m = await connect(mainTarget.webSocketDebuggerUrl);
  await m.send('Runtime.enable');
  await sleep(1500);

  check('Tauri API 注入存在', await ev(m, `!!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)`));
  const init = JSON.parse(await ev(m, `JSON.stringify({ notes: document.querySelectorAll('.note').length, ws: document.querySelectorAll('.ws-item').length, quick: document.querySelectorAll('.q-item').length })`));
  check('真机首屏种子渲染', init.notes === 3 && init.ws === 1 && init.quick === 1, init);

  const vp = JSON.parse(await ev(m, `JSON.stringify((() => { const r = document.getElementById('viewport').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })())`));
  await click(m, vp.x + vp.w * 0.7, vp.y + vp.h * 0.65);
  await sleep(400);
  check('真机点击空白新建便签', (await ev(m, `document.querySelectorAll('.note').length`)) === 4);

  /* 真实 OS 级拖拽：侧栏画布排序 + 持久化（走 WebView2 原生 HTML5 DnD 管线） */
  const wsNames = () => ev(m, `JSON.stringify(Array.from(document.querySelectorAll('.ws-block .ws-name')).map(e => e.textContent))`).then(JSON.parse);
  await ev(m, `document.getElementById('btn-new-ws').click()`);
  await sleep(400);
  await ev(m, `(() => { const i = document.querySelector('.ws-rename'); i.value = '拖拽测试'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(500);
  const names0 = await wsNames();
  check('拖拽前：新画布置顶', names0[0] === '拖拽测试', names0);
  const dp = JSON.parse(await ev(m, `JSON.stringify((() => { const a = document.querySelector('.ws-block:nth-child(1) .ws-item').getBoundingClientRect(); const b = document.querySelector('.ws-block:nth-child(2) .ws-item').getBoundingClientRect(); return { x1: a.left + a.width / 2, y1: a.top + a.height / 2, x2: b.left + b.width / 2, y2: b.bottom - 4, dpr: window.devicePixelRatio }; })())`));
  const ps1 = join(root, '.tmp-os-drag.ps1');
  writeFileSync(ps1, `param($s,$x1,$y1,$x2,$y2)
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32 { [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; } [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'
$h = (Get-Process notecanvas | Select-Object -First 1).MainWindowHandle
[Win32]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
$p = New-Object Win32+POINT
[Win32]::ClientToScreen($h, [ref]$p) | Out-Null
$ax = $p.X + [int]($x1 * $s); $ay = $p.Y + [int]($y1 * $s)
$bx = $p.X + [int]($x2 * $s); $by = $p.Y + [int]($y2 * $s)
[Win32]::SetCursorPos($ax, $ay) | Out-Null
Start-Sleep -Milliseconds 150
[Win32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
for ($i = 1; $i -le 14; $i++) {
  [Win32]::SetCursorPos($ax + ($bx - $ax) * $i / 14, $ay + ($by - $ay) * $i / 14) | Out-Null
  Start-Sleep -Milliseconds 45
}
Start-Sleep -Milliseconds 150
[Win32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 250
`);
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, String(dp.dpr), String(dp.x1), String(dp.y1), String(dp.x2), String(dp.y2)], { encoding: 'utf8' });
  unlinkSync(ps1);
  await sleep(700);
  const names1 = await wsNames();
  check('真实鼠标拖拽 → 画布顺序交换', names1[0] === '欢迎使用便签画布' && names1[1] === '拖拽测试', names1);
  await ev(m, `location.reload()`);
  await sleep(1800);
  const names2 = await wsNames();
  check('拖拽排序已持久化（刷新后保持）', names2[0] === '欢迎使用便签画布' && names2[1] === '拖拽测试', names2);

  /* Rust 命令：打开快速便签独立窗口 */
  await ev(m, `window.__TAURI__.core.invoke('open_quick', { id: null })`);
  let quickTarget = null;
  for (let i = 0; i < 30; i++) { list = await targets(); quickTarget = list.find((t) => t.type === 'page' && /quick\.html/.test(t.url)); if (quickTarget) break; await sleep(300); }
  check('Rust open_quick → 独立快速便签窗口创建', !!quickTarget, quickTarget && quickTarget.url);
  if (quickTarget) {
    const q = await connect(quickTarget.webSocketDebuggerUrl);
    await q.send('Runtime.enable');
    await sleep(900);
    check('快速窗渲染编辑框', await ev(q, `!!document.querySelector('.quick-title') && !!document.querySelector('.quick-body-text')`));
    /* 跨窗口事件同步：主窗口切深色 → 快速窗跟随 */
    await ev(m, `document.querySelector('[data-theme-opt="dark"]').click()`);
    await sleep(1200);
    const qTheme = await ev(q, `document.documentElement.dataset.theme`);
    check('跨窗口 state-sync 事件 → 快速窗主题同步为 dark', qTheme === 'dark', qTheme);
    /* 快速窗输入 → 自动保存 → 主窗口侧栏同步 */
    await ev(q, `(() => { const t = document.querySelector('.quick-title'); t.focus(); t.value = '真机速记'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(1200);
    const mQuick = await ev(m, `Array.from(document.querySelectorAll('.q-item .q-title')).some(e => e.textContent === '真机速记')`);
    check('快速窗保存 → 主窗口侧栏实时同步', mQuick === true);
    q.close();
  }

  /* 磁盘持久化 */
  const statePath = join(process.env.APPDATA || '', 'com.notecanvas.desktop', 'state.json');
  check('状态落盘 %APPDATA%/com.notecanvas.desktop/state.json', existsSync(statePath), statePath);
  let savedQuickId = null;
  if (existsSync(statePath)) {
    const st = JSON.parse(readFileSync(statePath, 'utf8'));
    check('落盘内容含真机新建便签与快速便签', st.workspaces.some((w) => w.notes.length === 4) && st.quickNotes.some((n) => n.title === '真机速记') && st.theme === 'dark');
    const sn = st.quickNotes.find((n) => n.title === '真机速记');
    savedQuickId = sn && sn.id;
  }

  /* 多快速窗口：再次快速创建 → 全新空白窗口（每次打开重置内容） */
  await ev(m, `window.__TAURI__.core.invoke('open_quick', { id: null })`);
  let q2Target = null;
  for (let i = 0; i < 30; i++) {
    list = await targets();
    q2Target = list.find((t) => t.type === 'page' && /quick\.html/.test(t.url) && t.url !== quickTarget.url);
    if (q2Target) break;
    await sleep(300);
  }
  check('第二次快速创建 → 独立新窗口并存', !!q2Target, q2Target && q2Target.url);
  if (q2Target) {
    const q2 = await connect(q2Target.webSocketDebuggerUrl);
    await q2.send('Runtime.enable');
    await sleep(800);
    check('新快速窗口内容为空白（重置）', await ev(q2, `document.querySelector('.quick-title').value === '' && document.querySelector('.quick-body-text').value === ''`));

    /* 按 id 打开已有快速便签 → 复用其窗口，不新建 */
    if (savedQuickId) {
      const before = (await targets()).filter((t) => t.type === 'page' && /quick\.html/.test(t.url)).length;
      await ev(m, `window.__TAURI__.core.invoke('open_quick', { id: ${JSON.stringify(savedQuickId)} })`);
      await sleep(900);
      const after = (await targets()).filter((t) => t.type === 'page' && /quick\.html/.test(t.url)).length;
      check('按 id 打开已有快速便签 → 复用窗口不新建', after === before, { before, after });
    }

    /* 关闭按钮 → 窗口销毁 */
    await ev(q2, `document.querySelector('.quick-close').click()`);
    let gone = false;
    for (let i = 0; i < 25; i++) {
      await sleep(300);
      list = await targets();
      if (!list.some((t) => t.url === q2Target.url)) { gone = true; break; }
    }
    check('关闭快速窗口 → 销毁（多窗口各自独立关闭）', gone);
    q2.close();
  }

  /* 保存路径：更改 → 迁移 → 新目录读写 → 恢复默认 */
  const dir0 = await ev(m, `window.__TAURI__.core.invoke('get_data_dir')`);
  const tmpDir = join(root, '.tmp-data-dir');
  const dir1 = await ev(m, `window.__TAURI__.core.invoke('set_data_dir', { path: ${JSON.stringify(tmpDir)} })`);
  check('修改保存路径生效', dir1.replace(/\\/g, '/') === tmpDir.replace(/\\/g, '/'), dir1);
  check('state.json 迁移至新目录', existsSync(join(tmpDir, 'state.json')));
  const loadedNew = JSON.parse(await ev(m, `window.__TAURI__.core.invoke('load_state')`));
  check('更改后从新目录读取状态', loadedNew.quickNotes.some((n) => n.title === '真机速记'));
  const dir2 = await ev(m, `window.__TAURI__.core.invoke('set_data_dir', { path: null })`);
  check('恢复默认保存路径', dir2 === dir0, dir2);
  rmSync(tmpDir, { recursive: true, force: true });

  /* 更改目录按钮：真实调用 plugin:dialog|open（options 包装），原生目录选择器应弹出且无 invoke 报错 */
  await ev(m, `document.getElementById('btn-settings').click()`);
  await sleep(600);
  const setModal = JSON.parse(await ev(m, `JSON.stringify({ open: !!document.querySelector('.modal-mask'), pickDisabled: document.querySelector('.modal [data-act="pick"]').disabled, path: document.querySelector('.modal-path code').textContent })`));
  check('设置弹窗（真机）：显示当前目录且更改按钮可用', setModal.open && !setModal.pickDisabled && setModal.path.length > 0, setModal);
  await ev(m, `document.querySelector('.modal [data-act="pick"]').click()`);
  await sleep(1800);
  const failToast = await ev(m, `Array.from(document.querySelectorAll('.toast')).map(t => t.textContent).filter(s => s.includes('失败')).join('|')`);
  check('点击更改目录 → 无 invoke 报错（options 参数形态正确）', failToast === '', failToast);
  const ps = (cmd) => (spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).stdout || '').trim();
  const dlgUp = ps(`$w = New-Object -ComObject WScript.Shell; $w.AppActivate('选择状态文件保存目录')`);
  check('原生目录选择器已弹出并前置', dlgUp === 'True', dlgUp);
  ps(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys('{ESC}')`);
  await sleep(1200);
  const dlgGone = ps(`$w = New-Object -ComObject WScript.Shell; $w.AppActivate('选择状态文件保存目录')`);
  const afterCancel = JSON.parse(await ev(m, `JSON.stringify({ modal: !!document.querySelector('.modal-mask'), fail: Array.from(document.querySelectorAll('.toast')).map(t => t.textContent).filter(s => s.includes('失败')).join('|') })`));
  check('取消选择器 → 正常返回、设置弹窗仍在、无报错', dlgGone === 'False' && afterCancel.modal && afterCancel.fail === '', { dlgGone, afterCancel });
  await ev(m, `document.querySelector('.modal [data-act="close"]').click()`);
  await sleep(300);

  /* 单实例：再次启动应退出并唤起已有主窗口 */
  const second = spawn(exe, [], { stdio: 'ignore' });
  await sleep(2500);
  const tl = spawnSync('tasklist', ['/FI', 'IMAGENAME eq notecanvas.exe', '/FO', 'CSV'], { encoding: 'utf8' }).stdout || '';
  const procCount = (tl.match(/notecanvas\.exe/g) || []).length;
  check('再次启动不产生新进程（单实例）', procCount === 1, procCount);
  check('再次启动唤起并聚焦已有主窗口', (await ev(m, `document.hasFocus()`)) === true);
  second.kill();

  m.close();
  console.log(fails.length ? 'SMOKE FAILS: ' + fails.join('; ') : 'ALL SMOKE PASS');
  spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error('SMOKE ERROR:', e.message); spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); process.exit(2); });