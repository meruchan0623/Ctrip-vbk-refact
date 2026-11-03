//! Verify-before-install pipeline as an explicit state machine:
//!
//! ```text
//! Planned -> Downloaded -> MinisignVerified -> PlatformVerified -> Installed
//!               |               |                    |                |
//!               +---------------+--------------------+----------------+--> Rejected
//! ```
//!
//! * `launch_installer` is reachable only from `PlatformVerified`;
//! * every failure deletes the downloaded file and ends in `Rejected`
//!   (terminal, further events are refused);
//! * the platform signature check (WinVerifyTrust / `codesign --verify
//!   --deep --strict`) happens after minisign and **before** anything is
//!   unpacked or executed.
//!
//! The cryptography is behind [`FlowOps`]; this module only enforces order.
//! Real-world evidence that the host's platform check really precedes
//! process creation is the I-19 first-step prototype (C class), not this
//! module.

use crate::manifest::UpdatePlan;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    DownloadFailed,
    MinisignInvalid,
    PlatformSignatureInvalid,
    InstallLaunchFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Planned,
    Downloaded,
    MinisignVerified,
    PlatformVerified,
    Installed,
    Rejected(RejectReason),
}

impl Stage {
    pub fn is_terminal(self) -> bool {
        matches!(self, Stage::Installed | Stage::Rejected(_))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Download(bool),
    Minisign(bool),
    Platform(bool),
    Install(bool),
}

/// The event is not valid in the current stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutOfOrder {
    pub stage: Stage,
    pub event: Event,
}

/// Pure transition function.
pub fn advance(stage: Stage, event: Event) -> Result<Stage, OutOfOrder> {
    use Event::*;
    use RejectReason::*;
    use Stage::*;
    Ok(match (stage, event) {
        (Planned, Download(true)) => Downloaded,
        (Planned, Download(false)) => Rejected(DownloadFailed),
        (Downloaded, Minisign(true)) => MinisignVerified,
        (Downloaded, Minisign(false)) => Rejected(MinisignInvalid),
        (MinisignVerified, Platform(true)) => PlatformVerified,
        (MinisignVerified, Platform(false)) => Rejected(PlatformSignatureInvalid),
        (PlatformVerified, Install(true)) => Installed,
        (PlatformVerified, Install(false)) => Rejected(InstallLaunchFailed),
        (stage, event) => return Err(OutOfOrder { stage, event }),
    })
}

/// An injected operation failed (details stay in the host log).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpFailed;

/// Side effects, implemented by the host (and by fakes in tests).
pub trait FlowOps {
    /// Download `url` to a private temp location. `Ok` only if complete.
    fn download(&mut self, url: &str) -> Result<(), OpFailed>;
    /// minisign verification of the downloaded file with the embedded key
    /// `key_id`.
    fn verify_minisign(&mut self, key_id: &str) -> bool;
    /// Platform signature verification of the downloaded file.
    fn verify_platform(&mut self) -> bool;
    /// Delete the downloaded file (idempotent, best effort).
    fn discard_download(&mut self);
    /// Hand over to the installer. Only ever called after both checks.
    fn launch_installer(&mut self) -> Result<(), OpFailed>;
}

/// Run the whole pipeline; returns the terminal stage. The old version is
/// untouched on every `Rejected` outcome.
pub fn run(plan: &UpdatePlan, ops: &mut dyn FlowOps) -> Stage {
    let mut stage = Stage::Planned;
    while !stage.is_terminal() {
        let ev = match stage {
            Stage::Planned => Event::Download(ops.download(&plan.artifact_url).is_ok()),
            Stage::Downloaded => Event::Minisign(ops.verify_minisign(&plan.key_id)),
            Stage::MinisignVerified => Event::Platform(ops.verify_platform()),
            Stage::PlatformVerified => Event::Install(ops.launch_installer().is_ok()),
            // Unreachable: loop guard excludes terminal stages.
            Stage::Installed | Stage::Rejected(_) => break,
        };
        match advance(stage, ev) {
            Ok(next) => stage = next,
            Err(_) => break,
        }
    }
    if matches!(stage, Stage::Rejected(_)) {
        ops.discard_download();
    }
    stage
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::KeySlot;
    use crate::version::Version;

    #[derive(Default)]
    struct Fake {
        log: Vec<&'static str>,
        dl_ok: bool,
        mini_ok: bool,
        plat_ok: bool,
        inst_ok: bool,
    }

    impl FlowOps for Fake {
        fn download(&mut self, _: &str) -> Result<(), OpFailed> {
            self.log.push("download");
            if self.dl_ok {
                Ok(())
            } else {
                Err(OpFailed)
            }
        }
        fn verify_minisign(&mut self, _: &str) -> bool {
            self.log.push("minisign");
            self.mini_ok
        }
        fn verify_platform(&mut self) -> bool {
            self.log.push("platform");
            self.plat_ok
        }
        fn discard_download(&mut self) {
            self.log.push("discard");
        }
        fn launch_installer(&mut self) -> Result<(), OpFailed> {
            self.log.push("install");
            if self.inst_ok {
                Ok(())
            } else {
                Err(OpFailed)
            }
        }
    }

    fn plan() -> UpdatePlan {
        UpdatePlan {
            target: Version::new(1, 2, 0),
            artifact_url: "https://cdn.example.com/x".into(),
            key_id: "KA".into(),
            slot: KeySlot::Current,
        }
    }

    fn fake(dl: bool, mini: bool, plat: bool, inst: bool) -> Fake {
        Fake {
            dl_ok: dl,
            mini_ok: mini,
            plat_ok: plat,
            inst_ok: inst,
            ..Fake::default()
        }
    }

    #[test]
    fn happy_path_order_is_download_minisign_platform_install() {
        let mut f = fake(true, true, true, true);
        assert_eq!(run(&plan(), &mut f), Stage::Installed);
        assert_eq!(f.log, ["download", "minisign", "platform", "install"]);
    }

    #[test]
    fn every_failure_discards_and_never_installs() {
        let cases = [
            (fake(false, true, true, true), RejectReason::DownloadFailed),
            (fake(true, false, true, true), RejectReason::MinisignInvalid),
            (
                fake(true, true, false, true),
                RejectReason::PlatformSignatureInvalid,
            ),
            (
                fake(true, true, true, false),
                RejectReason::InstallLaunchFailed,
            ),
        ];
        for (mut f, why) in cases {
            assert_eq!(run(&plan(), &mut f), Stage::Rejected(why));
            assert_eq!(f.log.last(), Some(&"discard"), "{why:?}");
            if why != RejectReason::InstallLaunchFailed {
                assert!(!f.log.contains(&"install"), "{why:?}");
            }
        }
    }

    #[test]
    fn platform_check_skipped_when_minisign_fails() {
        let mut f = fake(true, false, true, true);
        run(&plan(), &mut f);
        assert_eq!(f.log, ["download", "minisign", "discard"]);
    }

    #[test]
    fn install_requires_both_verifications_in_the_machine() {
        let stages = [
            Stage::Planned,
            Stage::Downloaded,
            Stage::MinisignVerified,
            Stage::Installed,
            Stage::Rejected(RejectReason::MinisignInvalid),
        ];
        for s in stages {
            assert!(advance(s, Event::Install(true)).is_err(), "{s:?}");
        }
        assert!(advance(Stage::PlatformVerified, Event::Install(true)).is_ok());
    }

    #[test]
    fn terminal_stages_accept_nothing() {
        let events = [
            Event::Download(true),
            Event::Minisign(true),
            Event::Platform(true),
            Event::Install(true),
        ];
        for s in [
            Stage::Installed,
            Stage::Rejected(RejectReason::DownloadFailed),
        ] {
            for e in events {
                assert!(advance(s, e).is_err());
            }
        }
    }

    #[test]
    fn steps_cannot_be_skipped_or_reordered() {
        assert!(advance(Stage::Planned, Event::Minisign(true)).is_err());
        assert!(advance(Stage::Planned, Event::Platform(true)).is_err());
        assert!(advance(Stage::Downloaded, Event::Platform(true)).is_err());
        assert!(advance(Stage::Downloaded, Event::Install(true)).is_err());
    }
}
