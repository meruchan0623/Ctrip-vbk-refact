//! Explicit live diagnostic: credentials arrive on stdin, never argv or disk.
//! Uses an isolated credential slot and removes it on completion.
use std::io::{self, Read};
use contracts::AppError;
use vbk_host::assistant::{http::ReqwestExecutor, service::{Service, Vault}};

struct ProbeVault(keyring::Entry);
impl Vault for ProbeVault {
    fn load(&self) -> Result<Option<String>, AppError> { Ok(None) }
    fn save(&self, value: &str) -> Result<(), AppError> {
        self.0.set_password(value).map_err(|_| AppError::new("store.io", "probe write failed"))?;
        let readback = self.0.get_password().map_err(|_| AppError::new("store.io", "probe read failed"))?;
        if readback != value { return Err(AppError::new("store.io", "probe mismatch")); }
        println!("credential_roundtrip=ok");
        Ok(())
    }
    fn clear(&self) -> Result<(), AppError> {
        match self.0.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AppError::new("store.io", "probe clear failed")),
        }
    }
}
impl Drop for ProbeVault { fn drop(&mut self) { let _ = self.clear(); } }
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("stdin");
    let mut data: serde_json::Value = serde_json::from_str(&input).expect("credential JSON");
    input.clear();
    let user = data["user"].take().as_str().unwrap_or_default().to_owned();
    let password = data["password"].take().as_str().unwrap_or_default().to_owned();
    let vault = ProbeVault(keyring::Entry::new("tech.tsim.vbk.login-probe", &uuid::Uuid::new_v4().to_string()).expect("probe entry"));
    let service = Service::new(ReqwestExecutor::new(), vault, Box::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64));
    tauri::async_runtime::block_on(async {
        match service.login(&user, password).await {
            Ok(status) => println!("login_confirmed={}", status.logged_in),
            Err(error) => println!("login_error={}", error.code),
        }
        // This probe owns its session; browser sessions are not touched.
        println!("probe_logout_ok={}", service.logout().await.is_ok());
    });
}
