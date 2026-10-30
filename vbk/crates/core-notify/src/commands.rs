//! Alarm-window / settings / tray commands (strong-alert §6).
//!
//! Every round-bound command carries the round id and version it acts on;
//! a stale click cannot hide, snooze or navigate to a newer round. Nothing
//! here sends a message, finishes a conversation or opens a URL.

use contracts::{codes, AccountContext, AlarmCommand, AlarmSnapshot, AppError, ReminderSettings};

use crate::effects::Effect;
use crate::engine::{codes as local_codes, NotifyCore};
use crate::now::Now;

/// Which window issued the command. The host validates the source view;
/// the core only enforces which commands each source may issue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CommandSource {
    /// The `alarm` window: all commands.
    Alarm,
    /// The settings page: `Snapshot` and the three settings commands.
    Setting,
    /// Tray menu: `Snapshot`, `SetEnabled`, `SetSoundEnabled`.
    Tray,
}

/// Result of a successfully handled command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandAck {
    Snapshot(AlarmSnapshot),
    /// Activate main and locate the conversation through the existing
    /// account/session identity. No URL, no send, no ack of the round.
    Navigate {
        account: AccountContext,
        gid: String,
    },
    /// Number of rounds hidden by `HideRound` / `HideAll`.
    Hidden {
        count: usize,
    },
    /// Snoozed until this server time.
    Snoozed {
        until_ms: i64,
    },
    Settings(ReminderSettings),
}

impl NotifyCore {
    /// Handles one command. Returns the acknowledgement plus the effects it
    /// caused (window hide/update, sound stop, re-evaluation).
    pub fn handle_command(
        &mut self,
        command: AlarmCommand,
        source: CommandSource,
        now: &Now,
    ) -> Result<(CommandAck, Vec<Effect>), AppError> {
        check_source(&command, source)?;
        match command {
            AlarmCommand::Snapshot => Ok((CommandAck::Snapshot(self.snapshot(now)), Vec::new())),
            AlarmCommand::OpenConversation {
                account,
                gid,
                round_id,
                version,
            } => {
                self.validate_round(&account, &gid, &round_id, version)?;
                Ok((CommandAck::Navigate { account, gid }, Vec::new()))
            }
            AlarmCommand::HideRound {
                account,
                gid,
                round_id,
                version,
            } => {
                let idx = self.validate_round(&account, &gid, &round_id, version)?;
                self.round_mut(idx).hide();
                let mut effects = self.silence();
                effects.extend(self.evaluate(now));
                Ok((CommandAck::Hidden { count: 1 }, effects))
            }
            AlarmCommand::HideAll { seen } => {
                let mut count = 0usize;
                for (gid, round_id, version) in &seen {
                    for r in self.rounds_mut() {
                        if r.round.gid == *gid
                            && r.round.round_id == *round_id
                            && r.round.version == *version
                            && !r.is_hidden()
                        {
                            r.hide();
                            count += 1;
                        }
                    }
                }
                let mut effects = Vec::new();
                if count > 0 {
                    effects.extend(self.silence());
                }
                effects.extend(self.evaluate(now));
                Ok((CommandAck::Hidden { count }, effects))
            }
            AlarmCommand::Snooze {
                account,
                gid,
                round_id,
                version,
                minutes,
            } => {
                let idx = self.validate_round(&account, &gid, &round_id, version)?;
                let until_ms = self.round_mut(idx).snooze(now, minutes);
                let mut effects = self.silence();
                effects.extend(self.evaluate(now));
                Ok((CommandAck::Snoozed { until_ms }, effects))
            }
            AlarmCommand::SetEnabled(enabled) => {
                let effects = self.apply_settings_patch(|s| s.enabled = enabled, now)?;
                Ok((CommandAck::Settings(self.settings().clone()), effects))
            }
            AlarmCommand::SetThreshold { t1_seconds } => {
                let effects = self.apply_settings_patch(|s| s.t1_seconds = t1_seconds, now)?;
                Ok((CommandAck::Settings(self.settings().clone()), effects))
            }
            AlarmCommand::SetSoundEnabled(enabled) => {
                let effects = self.apply_settings_patch(|s| s.timeout_sound = enabled, now)?;
                Ok((CommandAck::Settings(self.settings().clone()), effects))
            }
        }
    }

    /// Finds the round and checks identity generation and version.
    fn validate_round(
        &self,
        account: &AccountContext,
        gid: &str,
        round_id: &str,
        version: u64,
    ) -> Result<usize, AppError> {
        if self.is_stale_generation(account) {
            return Err(AppError::new(
                codes::ACCOUNT_STALE_GENERATION,
                "command carries an older session generation",
            ));
        }
        let idx = self.find(account, gid, round_id).ok_or_else(|| {
            AppError::new(local_codes::NOTIFY_ROUND_NOT_FOUND, "round is not tracked")
                .with_detail(format!("round_id={round_id}"))
        })?;
        let current = self.rounds()[idx].round.version;
        if current != version {
            return Err(AppError::new(
                codes::NOTIFY_ROUND_VERSION_MISMATCH,
                "round version does not match the current one",
            )
            .with_detail(format!("expected={current} got={version}")));
        }
        Ok(idx)
    }
}

fn check_source(command: &AlarmCommand, source: CommandSource) -> Result<(), AppError> {
    let allowed = match source {
        CommandSource::Alarm => true,
        CommandSource::Setting => matches!(
            command,
            AlarmCommand::Snapshot
                | AlarmCommand::SetEnabled(_)
                | AlarmCommand::SetThreshold { .. }
                | AlarmCommand::SetSoundEnabled(_)
        ),
        CommandSource::Tray => matches!(
            command,
            AlarmCommand::Snapshot | AlarmCommand::SetEnabled(_) | AlarmCommand::SetSoundEnabled(_)
        ),
    };
    if allowed {
        Ok(())
    } else {
        Err(AppError::new(
            local_codes::NOTIFY_COMMAND_NOT_ALLOWED,
            "command is not permitted from this source",
        )
        .with_detail(format!("source={source:?}")))
    }
}
