use super::*;
use super::super::browser_storage;

impl<E: Executor, V: Vault> Service<E, V> {
    pub async fn connect_browser(&self, profile_id: &str) -> Result<TsimStatus, AppError> {
        let submitted = self.lock().login_revocation;
        let profile_id = profile_id.to_owned();
        let (selected, token) = super::super::browser_work(move || {
            let selected = browser_storage::discover_profiles()?.into_iter()
                .find(|p| p.id == profile_id)
                .ok_or_else(|| invalid("browser profile is unavailable"))?;
            let token = browser_storage::read_token(&selected.directory)?
                .ok_or_else(|| not_logged_in("browser has no TSim session"))?;
            Ok((selected, token))
        }).await?;
        self.import_session_inner(token.expose().to_owned(), Some(selected), submitted).await
    }

    /// Bind to the chosen profile. Never silently switch browser identities.
    pub(super) async fn check_browser_binding(&self, epoch: u64) -> Result<(), AppError> {
        let profile = { let g = self.lock(); if g.epoch != epoch { return Err(not_logged_in("tsim identity changed")); } g.browser_profile.clone() };
        if let Some(profile) = profile {
            let read = super::super::browser_work(move || browser_storage::read_token(&profile.directory)).await;
            self.check_browser_binding_with(epoch, |_| read)
        } else { Ok(()) }
    }

    pub(super) fn check_browser_binding_with(&self, epoch: u64, read_token: impl FnOnce(&std::path::Path) -> Result<Option<SecretString>, AppError>) -> Result<(), AppError> {
        let bound = {
            let g = self.lock();
            if g.epoch != epoch { return Err(not_logged_in("tsim identity changed")); }
            g.browser_profile.clone().zip(g.session.as_ref().map(|s| s.access_token.clone()))
        };
        if let Some((profile, token)) = bound {
            let read = read_token(&profile.directory);
            if matches!(&read, Ok(Some(current)) if current == &token) { return Ok(()); }
            self.clear_if(epoch);
            return Err(read.err().unwrap_or_else(|| not_logged_in("browser session changed; reconnect required")));
        }
        Ok(())
    }
}
