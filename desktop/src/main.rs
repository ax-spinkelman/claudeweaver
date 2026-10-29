// A native window around the claudeweaver board. The board itself runs separately.
use tauri::webview::NewWindowResponse;
use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

// ponytail: fixed address, edit and rebuild if your board listens elsewhere
const BOARD: &str = "http://localhost:8091";

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let board: Url = BOARD.parse()?;
            let origin = board.origin();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(board))
                .title("Claudeweaver")
                .inner_size(1400.0, 900.0)
                // The board takes image drops itself. Tauri's handler would swallow them.
                .disable_drag_drop_handler()
                // Links that leave the board open in the default browser.
                .on_navigation(move |url| url.origin() == origin || !open_in_browser(url))
                .on_new_window(|url, _| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("claudeweaver window failed");
}

// Returns true when the URL went to the browser. Only http and https go out.
fn open_in_browser(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && std::process::Command::new("open").arg(url.as_str()).spawn().is_ok()
}
