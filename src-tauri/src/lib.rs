// Shared app setup for desktop and mobile (Android / iPadOS).
// The whole DAW runs in the web view (dist/index.html); the native side only adds
// file dialogs + file writing for Save Project / Bounce, and native (VST3/AU) plug-ins on desktop.

mod native;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            native::native_scan,
            native::native_hosting_available,
            native::native_render,
            native::native_params
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ozmix Studio");
}
