/* QA 实测：Chrome headless + CDP，真实输入事件驱动全部核心交互并截图。
   运行：node scripts/qa.mjs */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, '.shots');
mkdirSync(shots, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9223;
const BASE = 'file:///' + root.replace(/\\/g, '/') + '/src/';
const profile = join(root, '.chrome-profile');
rmSync(profile, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('Chrome DevTools 未就绪');
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 15000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面脚本异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result.value;
}
const j = (expr) => evaluate('JSON.stringify(' + expr + ')').then((s) => JSON.parse(s));

async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
}
async function click(x, y) { await mouse('mousePressed', x, y); await sleep(40); await mouse('mouseReleased', x, y); await sleep(120); }
async function drag(x1, y1, x2, y2, steps = 8) {
  await mouse('mousePressed', x1, y1);
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
  await sleep(60);
  await mouse('mouseReleased', x2, y2);
  await sleep(150);
}
async function hover(x, y) { await mouse('mouseMoved', x, y); await sleep(120); }
async function typeText(text) { await send('Input.insertText', { text }); await sleep(120); }
async function key(k, code, vk, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(150);
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(r.data, 'base64'));
  console.log('SHOT ' + name);
}
async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(900);
}
const rect = (sel) => j(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const center = async (sel) => { const r = await rect(sel); if (!r) throw new Error('元素不存在: ' + sel); return [r.x + r.w / 2, r.y + r.h / 2]; };
const store = () => j(`JSON.parse(localStorage.getItem('notecanvas-state-v1') || 'null')`);

async function main() {
  const wsUrl = await getTarget();
  ws = new WebSocket(wsUrl);
  await new Promise((r, j2) => { ws.onopen = r; ws.onerror = j2; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');

  /* 1. 首屏 */
  await goto(BASE + 'index.html');
  await sleep(500);
  const init = await j(`({ notes: document.querySelectorAll('.note').length, ws: document.querySelectorAll('.ws-item').length, quick: document.querySelectorAll('.q-item').length, theme: document.documentElement.dataset.theme, title: document.getElementById('ws-title').textContent })`);
  check('首屏：种子数据渲染（3 便签 / 1 工作区 / 1 快速便签）', init.notes === 3 && init.ws === 1 && init.quick === 1, init);
  const overflow0 = await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
  check('首屏：无横向溢出', overflow0);
  const emptyHidden = await evaluate(`getComputedStyle(document.getElementById('canvas-empty')).display`);
  check('首屏：有便签时空态提示隐藏', emptyHidden === 'none', emptyHidden);
  const qScroll = await j(`(() => { const e = document.getElementById('quick-list'); return { sw: e.scrollWidth, cw: e.clientWidth }; })()`);
  check('首屏：快速列表无横向溢出', qScroll.sw <= qScroll.cw + 1, qScroll);
  await shot('01-light.png');

  /* 2. 点击画布空白新建便签 */
  const vp = await rect('#viewport');
  const cx = vp.x + vp.w * 0.72, cy = vp.y + vp.h * 0.62;
  const hit = await evaluate(`document.elementFromPoint(${cx}, ${cy}).id`);
  check('目标点为空白画布', hit === 'viewport', hit);
  await click(cx, cy);
  await sleep(300);
  const afterCreate = await j(`({ n: document.querySelectorAll('.note').length, focus: document.activeElement.className })`);
  check('空白单击 → 新建便签并聚焦标题', afterCreate.n === 4 && afterCreate.focus.includes('note-title'), afterCreate);
  await typeText('购物清单');
  const bodyPt = await j(`(() => { const el = document.activeElement.closest('.note').querySelector('.note-body'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 12 }; })()`);
  await click(bodyPt.x, bodyPt.y);
  await typeText('牛奶 × 2\n鸡蛋 × 1');
  await sleep(500);
  const st1 = await store();
  const newNote = st1.workspaces.find((w) => w.id === st1.activeId).notes.find((n) => n.title === '购物清单');
  check('标题与内容已编辑并持久化', !!newNote && newNote.content.includes('鸡蛋'), newNote && { title: newNote.title, content: newNote.content, x: newNote.x, y: newNote.y });
  const expectX = Math.round((cx - vp.x - 0) / 1 - 24), expectY = Math.round((cy - vp.y) / 1 - 14);
  check('便签落在点击位置', Math.abs(newNote.x - expectX) <= 2 && Math.abs(newNote.y - expectY) <= 2, { got: [newNote.x, newNote.y], expect: [expectX, expectY] });

  /* 3. 拖动标题栏移动（向左拖，保持便签完整可见） */
  const noteSel = `.note[data-id="${newNote.id}"]`;
  const nr = await rect(noteSel);
  const before = await j(`(() => { const e = document.querySelector('${noteSel}'); return { x: parseInt(e.style.left), y: parseInt(e.style.top) }; })()`);
  await drag(nr.x + 12, nr.y + 12, nr.x + 12 - 140, nr.y + 12 + 90);
  const after = await j(`(() => { const e = document.querySelector('${noteSel}'); return { x: parseInt(e.style.left), y: parseInt(e.style.top) }; })()`);
  check('拖动标题栏 → 便签移动 (-140,+90)', after.x - before.x === -140 && after.y - before.y === 90, { before, after });

  /* 4. 换色 */
  const swPt = await j(`(() => { const e = document.querySelector('${noteSel} .swatch[data-color="sky"]'); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await click(swPt.x, swPt.y);
  const colorNow = await evaluate(`document.querySelector('${noteSel}').dataset.color`);
  check('点击色点 → 便签换色 sky', colorNow === 'sky', colorNow);

  /* 5. 调整大小 */
  const hd = await j(`(() => { const e = document.querySelector('${noteSel} .resize-handle'); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await drag(hd.x, hd.y, hd.x + 70, hd.y + 60);
  const sized = await j(`(() => { const e = document.querySelector('${noteSel}'); return { w: parseInt(e.style.width), h: parseInt(e.style.height), fixed: e.classList.contains('fixed-h') }; })()`);
  check('拖动手柄 → 宽高增大并固定', sized.w >= 310 && sized.h >= 180 && sized.fixed, sized);

  /* 6. 删除 + 撤销 */
  const delPt = await center(`${noteSel} .note-del`);
  await click(delPt[0], delPt[1]);
  await sleep(250);
  const afterDel = await j(`({ n: document.querySelectorAll('.note').length, toast: !!document.querySelector('.toast-action') })`);
  check('删除便签 → 数量减少且出现撤销 Toast', afterDel.n === 3 && afterDel.toast, afterDel);
  const undoPt = await center('.toast-action');
  await click(undoPt[0], undoPt[1]);
  await sleep(250);
  const afterUndo = await evaluate(`document.querySelectorAll('.note').length`);
  check('撤销 → 便签恢复', afterUndo === 4, afterUndo);

  /* 7. 缩放与平移 */
  await click(...(await center('#zoom-in')));
  const z1 = await evaluate(`document.getElementById('zoom-label').textContent`);
  check('放大按钮 → 120%', z1 === '120%', z1);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vp.x + vp.w / 2, y: vp.y + vp.h / 2, deltaX: 0, deltaY: -240, modifiers: 2 });
  await sleep(200);
  const z2 = await evaluate(`parseInt(document.getElementById('zoom-label').textContent)`);
  check('Ctrl+滚轮 → 继续放大', z2 > 120, z2);
  await click(...(await center('#zoom-reset')));
  const z3 = await evaluate(`document.getElementById('zoom-label').textContent`);
  check('重置视图 → 100%', z3 === '100%', z3);
  const tf0 = await evaluate(`document.getElementById('world').style.transform`);
  const panStart = await j(`(() => { const vp = document.getElementById('viewport'); const r = vp.getBoundingClientRect(); for (let fy = 0.2; fy < 0.95; fy += 0.08) for (let fx = 0.4; fx < 0.98; fx += 0.05) { const x = r.left + r.width * fx, y = r.top + r.height * fy; if (document.elementFromPoint(x, y) === vp) return { x, y }; } return null; })()`);
  check('平移前找到空白起点', !!panStart, panStart);
  await drag(panStart.x, panStart.y, panStart.x - 120, panStart.y - 70);
  const tf1 = await evaluate(`document.getElementById('world').style.transform`);
  const nAfterPan = await evaluate(`document.querySelectorAll('.note').length`);
  check('拖拽空白 → 平移画布且不误建便签', tf0 !== tf1 && nAfterPan === 4, { tf0, tf1, nAfterPan });
  await click(...(await center('#zoom-reset')));

  /* 8. 新建工作区 + 重命名 */
  await click(...(await center('#btn-new-ws')));
  await sleep(250);
  const renameFocused = await evaluate(`document.activeElement.className`);
  check('新建工作区 → 自动进入重命名', renameFocused.includes('ws-rename'), renameFocused);
  await typeText('项目 A');
  await key('Enter', 'Enter', 13);
  await sleep(300);
  const wsState = await j(`({ n: document.querySelectorAll('.ws-item').length, title: document.getElementById('ws-title').textContent, empty: !document.getElementById('canvas-empty').hidden, notes: document.querySelectorAll('.note').length })`);
  check('新工作区命名生效且为空画布', wsState.n === 2 && wsState.title === '项目 A' && wsState.empty && wsState.notes === 0, wsState);
  await shot('02-new-workspace.png');

  /* 9. 切换工作区（新工作区已置顶，原工作区在第二位） */
  await click(...(await center('.ws-block:nth-child(2) .ws-item')));
  await sleep(250);
  const back = await j(`({ title: document.getElementById('ws-title').textContent, notes: document.querySelectorAll('.note').length })`);
  check('切回原工作区 → 4 张便签仍在', back.notes === 4 && back.title === '欢迎使用便签画布', back);

  /* 9b. 新增画布置顶 / 便签子列表 / 点击定位 / 拖拽排序 */
  const topName = await evaluate(`document.querySelector('.ws-block .ws-name').textContent`);
  check('新增画布置顶', topName === '项目 A', topName);
  const subRows = await evaluate(`document.querySelectorAll('.ws-block:nth-child(2) .ws-note-row').length`);
  check('工作区子列表显示全部便签', subRows === 4, subRows);
  await click(...(await center('.ws-block:nth-child(2) .ws-note-row:nth-child(3)')));
  await sleep(300);
  const loc = await j(`(() => { const el = document.querySelector('.note.locate-flash'); if (!el) return null; const r = el.getBoundingClientRect(); const vp = document.getElementById('viewport').getBoundingClientRect(); return { dx: Math.abs(r.left + r.width / 2 - (vp.left + vp.width / 2)), dy: Math.abs(r.top + r.height / 2 - (vp.top + vp.height / 2)) }; })()`);
  check('点击子列表 → 便签居中定位并高亮', !!loc && loc.dx < 40 && loc.dy < 60, loc);
  const reordered = await evaluate(`(() => {
    const blocks = document.querySelectorAll('.ws-block');
    const src = blocks[0].querySelector('.ws-item');
    const dst = blocks[1];
    const r = dst.querySelector('.ws-item').getBoundingClientRect();
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return document.querySelector('.ws-block .ws-name').textContent;
  })()`);
  check('拖拽调整工作区顺序', reordered === '欢迎使用便签画布', reordered);

  /* 9c. 点击当前画布 → 展开/收缩子便签目录 */
  const subVisible = () => evaluate(`(() => { const b = document.querySelector('.ws-block'); const sub = b.querySelector('.ws-notes'); return { expanded: b.classList.contains('expanded'), display: sub ? getComputedStyle(sub).display : 'none' }; })()`);
  const v0 = await subVisible();
  check('当前画布默认展开子列表', v0.expanded && v0.display !== 'none', v0);
  await click(...(await center('.ws-block .ws-item')));
  await sleep(200);
  const v1 = await subVisible();
  check('点击当前画布 → 收缩子列表', !v1.expanded && v1.display === 'none', v1);
  await click(...(await center('.ws-block .ws-item')));
  await sleep(200);
  const v2 = await subVisible();
  check('再次点击 → 重新展开子列表', v2.expanded && v2.display !== 'none', v2);

  /* 10. 深色主题 */
  await click(...(await center('[data-theme-opt="dark"]')));
  await sleep(400);
  const dark = await evaluate(`document.documentElement.dataset.theme`);
  check('切换深色主题', dark === 'dark', dark);
  await shot('03-dark.png');

  /* 11. 快速便签（页内浮窗降级 = Tauri 独立窗口同实现） */
  await click(...(await center('#btn-quick-open')));
  await sleep(500);
  const qOpen = await j(`({ float: !!document.querySelector('.quick-float'), focus: document.activeElement.className })`);
  check('快速便签按钮 → 独立编辑浮窗打开并聚焦', qOpen.float && qOpen.focus.includes('quick-title'), qOpen);
  const qStyle = await j(`({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.querySelector('.quick-float [data-act="done"]')).backgroundImage })`);
  check('深色快速便签：主按钮渐变生效、主题不回退', qStyle.theme === 'dark' && qStyle.bg.includes('linear-gradient'), qStyle);
  await typeText('会议要点');
  const qb = await center('.quick-float .quick-body-text');
  await click(qb[0], qb[1]);
  await typeText('周三 10:00 方案评审');
  await sleep(900);
  const qSaved = await j(`({ items: document.querySelectorAll('.q-item').length, status: document.querySelector('.quick-status').textContent })`);
  check('快速便签自动保存 → 侧栏列表 +1', qSaved.items === 2 && qSaved.status.includes('已自动保存'), qSaved);
  await shot('04-quick-note.png');
  await click(...(await center('.quick-float [data-act="canvas"]')));
  await sleep(1100);
  const toCanvas = await j(`({ float: !!document.querySelector('.quick-float'), notes: document.querySelectorAll('.note').length, quick: document.querySelectorAll('.q-item').length })`);
  check('存入画布 → 浮窗关闭、画布 +1、快速列表 -1', !toCanvas.float && toCanvas.notes === 5 && toCanvas.quick === 1, toCanvas);

  /* 12. 全局快捷键（浏览器降级路径）+ Esc 关闭不留垃圾 */
  await key('n', 'KeyN', 78, 3);
  await sleep(500);
  const hotkey = await evaluate(`!!document.querySelector('.quick-float')`);
  check('Ctrl+Alt+N → 快速便签打开', hotkey);
  await key('Escape', 'Escape', 27);
  await sleep(700);
  const escClose = await j(`({ float: !!document.querySelector('.quick-float'), quick: document.querySelectorAll('.q-item').length })`);
  check('Esc 收起空白草稿 → 不产生垃圾便签', !escClose.float && escClose.quick === 1, escClose);

  /* 13. 删除工作区 + 撤销 */
  const ws2 = await rect('.ws-block:nth-child(2) .ws-item');
  await hover(ws2.x + ws2.w / 2, ws2.y + ws2.h / 2);
  const wsDel = await rect('.ws-block:nth-child(2) .ws-item [data-act="del"]');
  check('悬停显示工作区删除按钮', !!wsDel && wsDel.w > 0);
  await click(wsDel.x + wsDel.w / 2, wsDel.y + wsDel.h / 2);
  await sleep(300);
  const wsDeleted = await evaluate(`document.querySelectorAll('.ws-item').length`);
  check('删除工作区 → 列表 -1', wsDeleted === 1, wsDeleted);
  await click(...(await center('.toast-action')));
  await sleep(300);
  const wsRestored = await evaluate(`document.querySelectorAll('.ws-item').length`);
  check('撤销 → 工作区恢复', wsRestored === 2, wsRestored);

  /* 14. 持久化：刷新后状态完整 */
  await goto(BASE + 'index.html');
  await sleep(700);
  const reload = await j(`({ ws: document.querySelectorAll('.ws-item').length, notes: document.querySelectorAll('.note').length, quick: document.querySelectorAll('.q-item').length, theme: document.documentElement.dataset.theme, title: document.getElementById('ws-title').textContent })`);
  check('刷新后持久化完整（2 工作区 / 5 便签 / 1 快速 / 深色）', reload.ws === 2 && reload.notes === 5 && reload.quick === 1 && reload.theme === 'dark', reload);

  /* 14b. 保存位置设置弹窗（浏览器模式：提示 localStorage、禁用目录操作） */
  await click(...(await center('#btn-settings')));
  await sleep(300);
  const modal = await j(`({ open: !!document.querySelector('.modal-mask'), text: document.querySelector('.modal-path code').textContent, disabled: document.querySelector('.modal [data-act="pick"]').disabled })`);
  check('保存位置设置弹窗打开（浏览器模式）', modal.open && modal.text.includes('localStorage') && modal.disabled, modal);
  await key('Escape', 'Escape', 27);
  await sleep(250);
  check('Esc 关闭设置弹窗', !(await evaluate(`!!document.querySelector('.modal-mask')`)));

  /* 15. quick.html 独立窗口页面 */
  const st2 = await store();
  const qid = st2.quickNotes[0].id;
  await goto(BASE + 'quick.html?id=' + qid);
  await sleep(700);
  const qPage = await j(`({ title: document.querySelector('.quick-title').value, body: document.querySelector('.quick-body-text').value, color: document.querySelector('.quick-card').dataset.color, theme: document.documentElement.dataset.theme })`);
  check('quick.html 按 id 加载便签且主题同步', qPage.title === '灵感速记' && qPage.body.length > 0 && qPage.theme === 'dark', qPage);
  await click(...(await center('.quick-body-text')));
  await key('End', 'End', 35);
  await typeText('（补充：周五前完成）');
  await sleep(900);
  await goto(BASE + 'index.html');
  await sleep(700);
  const snippet = await evaluate(`document.querySelector('.q-item .q-snippet').textContent`);
  check('独立窗口编辑 → 主窗口同步可见', snippet.includes('周五前完成'), snippet);
  await shot('05-final-dark.png');

  /* 16. 移动端布局 */
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  const mob = await j(`({ overflow: document.documentElement.scrollWidth > window.innerWidth + 1, sidebarH: document.querySelector('.sidebar').getBoundingClientRect().height, vpH: document.getElementById('viewport').getBoundingClientRect().height })`);
  check('移动端：无横向溢出，侧栏转为顶栏', !mob.overflow && mob.sidebarH < 120 && mob.vpH > 400, mob);
  await shot('06-mobile.png');
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  /* 17. 浅色收尾截图 + 错误汇总 */
  await click(...(await center('[data-theme-opt="light"]')));
  await sleep(450);
  await shot('07-final-light.png');
  check('运行期无页面 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 5));
  const realConsoleErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  check('运行期无控制台错误', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 5));

  const failed = results.filter((r) => !r.ok);
  console.log('\n==== QA 汇总: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
  if (failed.length) { console.log('失败项:'); failed.forEach((f) => console.log(' - ' + f.name + ' ' + JSON.stringify(f.extra))); }
  writeFileSync(join(shots, 'qa-results.json'), JSON.stringify(results, null, 2));
  ws.close();
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('QA 运行失败:', e); try { chrome.kill(); } catch (_) {} process.exit(2); });