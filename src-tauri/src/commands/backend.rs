use serde::{Deserialize, Serialize};
use std::process::Child;
use std::sync::Mutex;
use tauri::{Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn apply_no_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

pub struct BackendState(pub Mutex<Option<Child>>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CondaEnv {
    pub name: String,
    pub path: String,
    pub python_version: String,
    pub missing_packages: Vec<String>,
    pub is_valid: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackendStatus {
    pub running: bool,
    pub healthy: bool,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackendClientConfig {
    pub api_token: String,
}

fn read_backend_env_value(app_dir: &str, key: &str) -> String {
    if let Ok(value) = std::env::var(key) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let env_path = std::path::Path::new(app_dir).join(".env");
    let content = match std::fs::read_to_string(env_path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { continue; }
        let Some((k, v)) = trimmed.split_once('=') else { continue; };
        if k.trim() == key {
            return v.trim().trim_matches('"').trim_matches('\'').to_string();
        }
    }
    String::new()
}

#[tauri::command]
pub async fn list_conda_envs() -> Result<Vec<CondaEnv>, String> {
    let output = tokio::task::spawn_blocking(|| {
        let mut command = std::process::Command::new("conda");
        command.args(["env", "list", "--json"]);
        apply_no_window(&mut command);
        command.output()
    })
    .await
    .map_err(|e| format!("执行 conda 扫描任务失败: {}", e))?
    .map_err(|e| format!("无法执行 conda 命令: {}", e))?;

    if !output.status.success() {
        return Err("conda 命令执行失败，请确认 conda 已安装并在 PATH 中".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("解析 conda 输出失败: {}", e))?;

    let env_paths: Vec<String> = json["envs"]
        .as_array()
        .ok_or("无法读取环境列表")?
        .iter()
        .filter_map(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    Ok(env_paths.into_iter().map(|p| check_conda_env_fs(&p)).collect())
}

fn check_conda_env_fs(path: &str) -> CondaEnv {
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("base")
        .to_string();

    let conda_meta = if cfg!(target_os = "windows") {
        format!("{}\\conda-meta", path)
    } else {
        format!("{}/conda-meta", path)
    };

    let py_version = std::fs::read_dir(&conda_meta)
        .ok()
        .and_then(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .find(|name| name.starts_with("python-") && name.ends_with(".json"))
                .and_then(|fname| {
                    fname.strip_prefix("python-")?.split('-').next().map(|s| s.to_string())
                })
        })
        .unwrap_or_else(|| "unknown".to_string());

    // (conda-meta prefix, site-packages dir, display name)
    let required: &[(&str, &str, &str)] = &[
        ("flask",         "flask",          "Flask"),
        ("flask-socketio","flask_socketio", "Flask-SocketIO"),
        ("",              "flask_cors",     "Flask-Cors"),
        ("",              "cv2",            "opencv-python"),
        ("pillow",        "PIL",            "Pillow"),
    ];

    let mut missing: Vec<String> = Vec::new();
    for (conda_name, site_name, display) in required {
        let found = (!conda_name.is_empty() && pkg_in_conda_meta(&conda_meta, conda_name))
            || pkg_in_site_packages(path, site_name);
        if !found { missing.push(display.to_string()); }
    }

    CondaEnv { is_valid: missing.is_empty(), missing_packages: missing, name, path: path.to_string(), python_version: py_version }
}

fn pkg_in_conda_meta(conda_meta: &str, pkg_name: &str) -> bool {
    let prefix = format!("{}-", pkg_name);
    std::fs::read_dir(conda_meta)
        .map(|entries| entries.filter_map(|e| e.ok())
            .any(|e| { let f = e.file_name().to_string_lossy().to_string(); f.starts_with(&prefix) && f.ends_with(".json") }))
        .unwrap_or(false)
}

fn pkg_in_site_packages(env_path: &str, pkg_name: &str) -> bool {
    let win_path = format!("{}\\Lib\\site-packages\\{}", env_path, pkg_name);
    if std::path::Path::new(&win_path).exists() { return true; }
    let lib_dir = format!("{}/lib", env_path);
    if let Ok(entries) = std::fs::read_dir(&lib_dir) {
        for entry in entries.flatten() {
            if entry.path().join("site-packages").join(pkg_name).exists() { return true; }
        }
    }
    false
}

#[tauri::command]
pub async fn validate_conda_env(env_path: String) -> Result<CondaEnv, String> {
    Ok(check_conda_env_fs(&env_path))
}

#[tauri::command]
pub async fn start_backend(
    state: State<'_, BackendState>,
    python_exe: String,
    app_dir: String,
    port: u16,
) -> Result<(), String> {
    let log_path = std::env::temp_dir().join("easy_dataset_backend.log");
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if guard.is_some() { return Err("后端已在运行".to_string()); }

        let log_file = std::fs::File::create(&log_path)
            .map_err(|e| format!("创建日志文件失败: {}", e))?;
        let log_clone = log_file.try_clone().map_err(|e| e.to_string())?;

        let mut command = std::process::Command::new(&python_exe);

        // 把 conda env 的 Library\bin / Scripts / env root 加入子进程 PATH
        // 这样 shutil.which("ffmpeg") 等系统工具才能被找到
        let env_root = std::path::Path::new(&python_exe)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let extra_paths: Vec<String> = if cfg!(target_os = "windows") {
            vec![
                format!("{}\\Library\\bin", env_root),
                format!("{}\\Library\\usr\\bin", env_root),
                format!("{}\\Scripts", env_root),
                env_root.clone(),
            ]
        } else {
            vec![format!("{}/bin", env_root)]
        };
        let current_path = std::env::var("PATH").unwrap_or_default();
        let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
        let new_path = format!("{}{}{}", extra_paths.join(sep), sep, current_path);

        command
            .args(["-u", "app.py"])
            .env("PORT", port.to_string())
            .env("DEBUG", "false")
            .env("FLASK_DEBUG", "0")
            .env("EASY_DATASET_EMBEDDED", "1")
            .env("PYTHONUNBUFFERED", "1")
            .env("PATH", new_path)
            .env("PARENT_PID", std::process::id().to_string())
            .current_dir(&app_dir)
            .stdout(log_file)
            .stderr(log_clone);
        apply_no_window(&mut command);

        let child = command.spawn()
            .map_err(|e| format!("启动 Python 失败（python={}, dir={}）: {}", python_exe, app_dir, e))?;
        *guard = Some(child);
    }

    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = *guard {
        if let Ok(Some(status)) = child.try_wait() {
            *guard = None;
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            return Err(format!(
                "Python 进程启动后立即退出（exit code: {:?}）\n\n输出:\n{}",
                status.code(),
                if log.is_empty() { "（无输出，可能是 DLL 缺失或路径错误）".to_string() } else { log }
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_backend(state: State<'_, BackendState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        child.kill().map_err(|e| format!("停止后端失败: {}", e))?;
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn check_backend_alive(state: State<'_, BackendState>) -> bool {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => { *guard = None; false }
            Ok(None) => true,
            Err(_) => false,
        }
    } else {
        false
    }
}

#[tauri::command]
pub fn get_backend_log() -> String {
    let log_path = std::env::temp_dir().join("easy_dataset_backend.log");
    std::fs::read_to_string(log_path).unwrap_or_else(|_| "(日志文件不存在)".to_string())
}

#[tauri::command]
pub async fn backend_health(port: u16) -> BackendStatus {
    let url = format!("http://127.0.0.1:{}/health", port);
    match reqwest::get(&url).await {
        Ok(resp) if resp.status().is_success() => BackendStatus { running: true, healthy: true, message: "后端运行正常".to_string() },
        Ok(resp) => BackendStatus { running: true, healthy: false, message: format!("后端响应异常: {}", resp.status()) },
        Err(_) => BackendStatus { running: false, healthy: false, message: "无法连接到后端".to_string() },
    }
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_backend_client_config(app_dir: String) -> BackendClientConfig {
    BackendClientConfig { api_token: read_backend_env_value(&app_dir, "API_TOKEN") }
}

#[cfg(not(debug_assertions))]
fn sync_backend_runtime_dir(
    resource_dir: &std::path::Path,
    runtime_dir: &std::path::Path,
) -> Result<(), String> {
    std::fs::create_dir_all(runtime_dir)
        .map_err(|e| format!("创建运行时目录失败: {}", e))?;
    copy_dir_recursive(resource_dir, runtime_dir)
        .map_err(|e| format!("同步后端文件失败: {}", e))
}

#[cfg(not(debug_assertions))]
fn copy_dir_recursive(
    src: &std::path::Path,
    dst: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

/// 从 exe 所在目录出发，BFS 搜索同时含有 app.py + config.py 的目录（最深 6 层）。
/// 这样不管 NSIS 把资源放在哪个子目录，都能自动找到。
#[cfg(not(debug_assertions))]
fn find_backend_src_dir() -> Result<std::path::PathBuf, String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("获取程序路径失败: {}", e))?;
    let exe_dir = exe_path.parent()
        .ok_or_else(|| "无法获取程序目录".to_string())?
        .to_path_buf();

    let mut queue: std::collections::VecDeque<(std::path::PathBuf, usize)> =
        std::collections::VecDeque::new();
    queue.push_back((exe_dir.clone(), 0));

    while let Some((dir, depth)) = queue.pop_front() {
        // 同时检查 app.py 和 config.py，避免误匹配无关目录
        if dir.join("app.py").exists() && dir.join("config.py").exists() {
            return Ok(dir);
        }
        if depth < 6 {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        queue.push_back((entry.path(), depth + 1));
                    }
                }
            }
        }
    }

    Err(format!(
        "在安装目录中找不到后端文件（app.py + config.py）。\n已从以下目录递归搜索 6 层：\n  {}",
        exe_dir.display()
    ))
}

#[tauri::command]
#[allow(unused_variables)]
pub fn get_app_dir(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "找不到项目根目录".to_string())?
            .to_string_lossy()
            .to_string();
        return Ok(path);
    }
    #[cfg(not(debug_assertions))]
    {
        let src_dir = find_backend_src_dir()?;

        let runtime_dir = app.path().app_local_data_dir()
            .map_err(|e| format!("找不到本地数据目录: {}", e))?
            .join("backend_runtime");
        sync_backend_runtime_dir(&src_dir, &runtime_dir)?;
        Ok(runtime_dir.to_string_lossy().to_string())
    }
}

// ─── 通用 HTTP GET（版本检查等）──────────────────────────────

/// 抓取指定 URL 的响应文本，用于前端版本检查（绕过 CORS 限制）
#[tauri::command]
pub async fn fetch_text(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (compatible; easy-dataset-version-check/1.0)")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    resp.text().await.map_err(|e| e.to_string())
}
