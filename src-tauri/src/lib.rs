use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

static TRAY_HINT_SHOWN: AtomicBool = AtomicBool::new(false);
static SHORTCUT_OK: AtomicBool = AtomicBool::new(false);
static QUICK_SEQ: AtomicU64 = AtomicU64::new(0);

const WRITE_PROBE: &str = ".nc-write-test";
const CASCADE_OFFSET: f64 = 30.0;

/// 默认数据目录（%APPDATA%/com.notecanvas.desktop）
fn default_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))
}

/// 用户自定义保存目录记录在默认目录的 settings.json 中
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(default_data_dir(app)?.join("settings.json"))
}

/// 当前生效的数据目录：优先用户自定义路径
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let raw = fs::read_to_string(settings_path(app)?).unwrap_or_default();
    let custom = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| {
            v.get("dataDir")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(PathBuf::from)
        });
    Ok(custom.unwrap_or(default_data_dir(app)?))
}

fn data_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("state.json"))
}

#[tauri::command]
fn get_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.to_string_lossy().into_owned())
}

/// 修改状态文件保存目录；path 为空表示恢复默认。
/// 旧 state.json 保留不删除；目标目录无 state.json 时复制一份过去。
#[tauri::command]
fn set_data_dir(app: tauri::AppHandle, path: Option<String>) -> Result<String, String> {
    let target = match path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => default_data_dir(&app)?,
    };
    fs::create_dir_all(&target).map_err(|e| format!("无法创建目录: {e}"))?;
    let probe = target.join(WRITE_PROBE);
    fs::write(&probe, b"ok").map_err(|e| format!("目录不可写: {e}"))?;
    let _ = fs::remove_file(&probe);

    let old = data_path(&app)?;
    let new = target.join("state.json");
    if old != new && old.exists() && !new.exists() {
        fs::copy(&old, &new).map_err(|e| format!("迁移状态文件失败: {e}"))?;
    }
    let settings = serde_json::json!({ "dataDir": target.to_string_lossy() });
    fs::write(settings_path(&app)?, serde_json::to_string_pretty(&settings).unwrap())
        .map_err(|e| format!("写入设置失败: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 读取全部持久化状态（JSON 字符串）。首次运行返回 "null"。
#[tauri::command]
fn load_state(app: tauri::AppHandle) -> Result<String, String> {
    let path = data_path(&app)?;
    if path.exists() {
        fs::read_to_string(&path).map_err(|e| format!("读取状态失败: {e}"))
    } else {
        Ok("null".to_string())
    }
}

/// 保存全部持久化状态，并广播给其它窗口（origin 为发起窗口 label，用于忽略自身回声）。
#[tauri::command]
fn save_state(app: tauri::AppHandle, data: String, origin: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&data).map_err(|e| format!("非法 JSON: {e}"))?;
    let path = data_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
    }
    // 先写临时文件再原子替换，避免写入中断导致状态损坏
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data.as_bytes()).map_err(|e| format!("写入状态失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换状态文件失败: {e}"))?;
    app.emit("state-sync", origin).map_err(|e| e.to_string())?;
    Ok(())
}

/// 全局快捷键是否注册成功（被其它程序占用时降级为按钮/托盘入口）
#[tauri::command]
fn shortcut_ok() -> bool {
    SHORTCUT_OK.load(Ordering::SeqCst)
}

/// 打开（或聚焦）快速便签窗口。id 为空时新建一张空白快速便签。
/// 必须为 async：同步命令在 WebView2 的 WebMessageReceived 回调（主线程）内执行，
/// 其中创建新 WebView2 环境会因 COM 回调重入而死锁，窗口将空白且无响应。
#[tauri::command]
async fn open_quick(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    open_quick_inner(&app, id)
}

/// 显示并聚焦窗口（还原最小化）
fn reveal(win: &tauri::WebviewWindow) -> Result<(), String> {
    win.show().map_err(|e| e.to_string())?;
    let _ = win.unminimize();
    win.set_focus().map_err(|e| e.to_string())
}

fn open_quick_inner(app: &tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    // 快速创建：每次生成全新空白便签；打开已有便签：复用其专属窗口
    let id = match id {
        Some(s) if !s.trim().is_empty() => s,
        _ => {
            let ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            format!("q{ms}-{}", QUICK_SEQ.fetch_add(1, Ordering::SeqCst))
        }
    };
    let label = format!("quick-{id}");
    if let Some(win) = app.get_webview_window(&label) {
        reveal(&win)?;
        let _ = app.emit_to(label.as_str(), "quick-focus", id);
        return Ok(());
    }
    let existing = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with("quick-"))
        .count();
    let url = format!("quick.html?id={id}");
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("快速便签")
        .inner_size(380.0, 480.0)
        .min_inner_size(320.0, 380.0)
        .always_on_top(true)
        .decorations(false)
        .resizable(true)
        .disable_drag_drop_handler()
        .center()
        .build()
        .map_err(|e| format!("创建快速便签窗口失败: {e}"))?;
    // 多窗口级联排布，避免完全重叠
    if existing > 0 {
        if let (Ok(pos), Ok(scale)) = (win.outer_position(), win.scale_factor()) {
            let off = (CASCADE_OFFSET * existing as f64 * scale) as i32;
            let _ = win.set_position(PhysicalPosition::new(pos.x + off, pos.y + off));
        }
    }
    Ok(())
}

/// 异步打开空白快速便签（快捷键 / 托盘入口共用）
fn spawn_quick(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = open_quick_inner(&handle, None);
    });
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = reveal(&win);
    }
}

pub fn run() {
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        spawn_quick(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // 全局快捷键 Ctrl+Alt+N → 快速便签；被占用时不致命，降级为按钮/托盘入口
            match app.global_shortcut().register(shortcut.clone()) {
                Ok(_) => SHORTCUT_OK.store(true, Ordering::SeqCst),
                Err(e) => eprintln!("全局快捷键 Ctrl+Alt+N 注册失败（可能被其它程序占用）: {e}"),
            }

            // 系统托盘
            let show = MenuItem::with_id(app, "show", "打开工作区", true, None::<&str>)?;
            let quick = MenuItem::with_id(app, "quick", "快速便签\tCtrl+Alt+N", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quick, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("便签板 · Ctrl+Alt+N 快速便签")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quick" => spawn_quick(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 主窗口关闭 = 收起到托盘；快速便签窗口直接销毁（内容已实时落盘）
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    if !TRAY_HINT_SHOWN.swap(true, Ordering::SeqCst) {
                        let _ = window.emit("tray-hint", ());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_state, save_state, open_quick, shortcut_ok, get_data_dir, set_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("启动便签板失败");
}