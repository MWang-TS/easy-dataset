mod commands;

use commands::backend::{self, BackendState};
use std::sync::Mutex;
use tauri::Manager;

/// 双重保险：即使发布包意外以 console 子系统构建，运行时也把控制台窗口隐藏掉。
/// （正常的 release 构建已通过 main.rs 的 windows_subsystem = "windows" 彻底不创建控制台）
#[cfg(all(windows, not(debug_assertions)))]
fn hide_console_window() {
    use core::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleWindow() -> *mut c_void;
    }
    #[link(name = "user32")]
    extern "system" {
        fn ShowWindow(hwnd: *mut c_void, n_cmd_show: i32) -> i32;
    }
    const SW_HIDE: i32 = 0;
    unsafe {
        let hwnd = GetConsoleWindow();
        if !hwnd.is_null() {
            ShowWindow(hwnd, SW_HIDE);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(windows, not(debug_assertions)))]
    hide_console_window();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(BackendState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            backend::list_conda_envs,
            backend::validate_conda_env,
            backend::start_backend,
            backend::stop_backend,
            backend::check_backend_alive,
            backend::get_backend_log,
            backend::backend_health,
            backend::get_backend_client_config,
            backend::get_app_dir,
            backend::write_text_file,
            backend::fetch_text,
            backend::platform_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<BackendState>();
                let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(mut child) = guard.take() {
                    backend::terminate_child(&mut child);
                }
            }
        });
}
