//! Existing browser session import; no login/logout/legacy migration is sent.
use super::*;
use core_assistant::session_import as wire;

impl<E: Executor, V: Vault> Service<E, V> {
    pub async fn import_session(&self, access_token: String) -> Result<TsimStatus, AppError> {
        let submitted = self.lock().login_revocation;
        self.import_session_inner(access_token, None, submitted)
            .await
    }

    pub(super) async fn import_session_inner(
        &self,
        access_token: String,
        browser_profile: Option<super::super::browser_storage::BrowserProfile>,
        submitted: u64,
    ) -> Result<TsimStatus, AppError> {
        wire::validate_access_token(&access_token)?;
        let token = SecretString::new(access_token);
        let _serial = self.login_lock.lock().await;
        let epoch = {
            let mut g = self.lock();
            if g.login_revocation != submitted {
                return Err(not_logged_in("queued session import was cancelled"));
            }
            self.reset_identity(&mut g);
            self.vault.clear()?;
            g.epoch
        };
        let current = || {
            let g = self.lock();
            if g.epoch != epoch || g.login_revocation != submitted {
                Err(not_logged_in("session import was cancelled"))
            } else {
                Ok(())
            }
        };
        let request = wire::profile_request(token.expose())?;
        let response = self.exec.execute(&request).await;
        drop(request);
        current()?;
        let response = response?;
        let verified = wire::parse_profile(response.status, &response.body)
            .map_err(|e| self.auth_error(epoch, e))?;
        let request = wire::status_request(token.expose())?;
        let response = self.exec.execute(&request).await;
        drop(request);
        current()?;
        let response = response?;
        let session_ref = wire::parse_session_ref(response.status, &response.body)
            .map_err(|e| self.auth_error(epoch, e))?;
        if let Some(ref selected) = browser_profile {
            let directory = selected.directory.clone();
            let current_token = super::super::browser_work(move || {
                super::super::browser_storage::read_token(&directory)
            })
            .await?;
            if current_token.as_ref().map(|v| v.expose()) != Some(token.expose()) {
                return Err(not_logged_in("browser session changed during verification"));
            }
        }
        let token = TokenData {
            access_token: token,
            token_type: "bearer".into(),
            session_ref,
            expires_at_ms: None,
        };
        let mut session = TsimSession::from_token(token, self.now_ms(), epoch);
        session.apply_profile(&verified.profile);
        {
            let mut g = self.lock();
            if g.epoch != epoch || g.login_revocation != submitted {
                return Err(not_logged_in("session import was cancelled"));
            }
            g.session = Some(session);
            g.user = Some(verified.username);
            g.profile_loaded = true;
            // The browser owns this server session. Local logout/replacement
            // must not invoke the server's session-revoking logout endpoint.
            g.borrowed_session = true;
            g.browser_profile = browser_profile;
        }
        self.persist_current(epoch, true)?;
        self.check_epoch(epoch).await?;
        Ok(self.status())
    }
}

#[cfg(test)]
#[path = "session_import_tests.rs"]
mod tests;
