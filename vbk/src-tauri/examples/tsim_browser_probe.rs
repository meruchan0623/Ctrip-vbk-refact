//! Explicit read-only browser reuse diagnostic. Never prints session credentials.
use contracts::AppError;
use vbk_host::assistant::{
    browser_storage,
    http::{Executor, ReqwestExecutor},
    service::{Service, Vault},
};
struct MemoryOnly;
impl Vault for MemoryOnly {
    fn load(&self) -> Result<Option<String>, AppError> {
        Ok(None)
    }
    fn save(&self, _: &str) -> Result<(), AppError> {
        panic!("browser token must not be saved")
    }
    fn clear(&self) -> Result<(), AppError> {
        Ok(())
    }
}
fn main() {
    let profiles = browser_storage::discover_profiles().expect("profile discovery");
    let mut selected = None;
    for p in profiles {
        match browser_storage::read_token(&p.directory) {
            Ok(Some(token)) => {
                println!("profile={} session_present=true", p.id);
                if selected.is_none() {
                    selected = Some((p, token));
                }
            }
            Ok(None) => println!("profile={} session_present=false", p.id),
            Err(e) => println!("profile={} error={}", p.id, e.code),
        }
    }
    let Some((profile, token)) = selected else {
        std::process::exit(2);
    };
    let service = Service::new(
        ReqwestExecutor::new(),
        MemoryOnly,
        Box::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64
        }),
    );
    tauri::async_runtime::block_on(async {
        match service.connect_browser(&profile.id).await {
            Ok(status) => println!("browser_login_confirmed={}", status.logged_in),
            Err(e) => {
                println!("connect_error={}", e.code);
                std::process::exit(3);
            }
        }
        println!("local_disconnect_ok={}", service.logout().await.is_ok());
        let request = core_assistant::session_import::status_request(token.expose()).unwrap();
        match ReqwestExecutor::new().execute(&request).await {
            Ok(response) => println!(
                "browser_session_still_active={}",
                core_assistant::session_import::parse_session_ref(response.status, &response.body)
                    .is_ok()
            ),
            Err(e) => println!("readback_error={}", e.code),
        }
    });
}
