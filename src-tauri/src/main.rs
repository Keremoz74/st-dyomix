// Desktop entry point (macOS / Windows / Linux). Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ozmix_studio_lib::run()
}
