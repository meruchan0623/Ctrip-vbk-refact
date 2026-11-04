//! Verify-before-install pipeline as an explicit state machine:
//!
//! ```text
//! Planned -> Downloaded -> MinisignVerified -> PlatformVerified -> InstallerHandedOff
//!    |           |                |                    |
//!    +-----------+----------------+--------------------+--> Rejected
//! ```
//!
//! * `launch_installer` is reachable only from `PlatformVerified`;
//! * failures before installer launch discard the download and end in `Rejected`;
//!   launch errors retain it because the installer may already be using it.
//!   All rejection states are terminal; further events are refused;
//! * `InstallerHandedOff` means only that `launch_installer` returned `Ok`.
//!   Installer completion and successful startup of the target version require
//!   future host integration; this in-memory flow has no persisted receipt;
//! * platform signature verification follows minisign and precedes executing
//!   the installer or replacing the installed application. For an archive,
//!   the host must first isolate extraction of the minisign-verified archive
//!   so the actual executable/application payload can be verified. Extraction
//!   and platform I/O are host responsibilities, not implemented here.
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
    /// Handoff was not confirmed; an installer may already be running.
    InstallLaunchFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Planned,
    Downloaded,
    MinisignVerified,
    PlatformVerified,
    /// The verified artifact was handed to the installer, not confirmed installed.
    InstallerHandedOff,
    Rejected(RejectReason),
}

impl Stage {
    pub fn is_terminal(self) -> bool {
        matches!(self, Stage::InstallerHandedOff | Stage::Rejected(_))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Download(bool),
    Minisign(bool),
    Platform(bool),
    /// Whether the host confirmed handing the artifact to its installer.
    InstallerLaunch(bool),
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
        (PlatformVerified, InstallerLaunch(true)) => InstallerHandedOff,
        (PlatformVerified, InstallerLaunch(false)) => Rejected(InstallLaunchFailed),
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
    /// Verify the platform signature of the actual executable/application
    /// payload that will be executed or replace the installed application.
    /// For archives, the host must isolate extraction after minisign succeeds
    /// and before this check, without executing or replacing anything. This
    /// trait neither implements extraction nor proves that host I/O ordering.
    fn verify_platform(&mut self) -> bool;
    /// Delete the downloaded file (idempotent, best effort).
    fn discard_download(&mut self);
    /// Hand over to the installer. Only ever called after both checks.
    /// `Ok` confirms this handoff only; it must not be treated as an installer
    /// exit status or evidence that the target version has started.
    /// `Err` may still follow process creation or other side effects; it does
    /// not prove that no installer is running. Reconcile before cleanup or retry.
    fn launch_installer(&mut self) -> Result<(), OpFailed>;
}

/// Run verification and installer handoff; returns the terminal stage.
/// No installer completion, rollback, or target-version startup is observed.
/// A launch error does not establish that an installer made no changes;
/// the host must determine the installed version separately before any retry.
pub fn run(plan: &UpdatePlan, ops: &mut dyn FlowOps) -> Stage {
    let mut stage = Stage::Planned;
    while !stage.is_terminal() {
        let ev = match stage {
            Stage::Planned => Event::Download(ops.download(&plan.artifact_url).is_ok()),
            Stage::Downloaded => Event::Minisign(ops.verify_minisign(&plan.key_id)),
            Stage::MinisignVerified => Event::Platform(ops.verify_platform()),
            Stage::PlatformVerified => Event::InstallerLaunch(ops.launch_installer().is_ok()),
            // Unreachable: loop guard excludes terminal stages.
            Stage::InstallerHandedOff | Stage::Rejected(_) => break,
        };
        match advance(stage, ev) {
            Ok(next) => stage = next,
            Err(_) => break,
        }
    }
    if matches!(
        stage,
        Stage::Rejected(
            RejectReason::DownloadFailed
                | RejectReason::MinisignInvalid
                | RejectReason::PlatformSignatureInvalid
        )
    ) {
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
            self.log.push("launch_installer");
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
    fn successful_launch_confirms_only_terminal_installer_handoff() {
        let mut f = fake(true, true, true, true);
        assert_eq!(run(&plan(), &mut f), Stage::InstallerHandedOff);
        assert_eq!(
            f.log,
            ["download", "minisign", "platform", "launch_installer"]
        );
        assert!(Stage::InstallerHandedOff.is_terminal());
        assert!(
            !f.log.contains(&"discard"),
            "handoff must retain the artifact for the installer"
        );
        assert!(
            advance(Stage::InstallerHandedOff, Event::InstallerLaunch(true)).is_err(),
            "a handed-off installer must not be launched again"
        );
    }

    #[test]
    fn failures_discard_only_before_launch_and_never_report_handoff() {
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
            let expected: &[&str] = match why {
                RejectReason::DownloadFailed => &["download", "discard"],
                RejectReason::MinisignInvalid => &["download", "minisign", "discard"],
                RejectReason::PlatformSignatureInvalid => {
                    &["download", "minisign", "platform", "discard"]
                }
                RejectReason::InstallLaunchFailed => {
                    &["download", "minisign", "platform", "launch_installer"]
                }
            };
            assert_eq!(f.log, expected, "{why:?}");
        }
    }

    #[test]
    fn platform_check_skipped_when_minisign_fails() {
        let mut f = fake(true, false, true, true);
        run(&plan(), &mut f);
        assert_eq!(f.log, ["download", "minisign", "discard"]);
    }

    #[test]
    fn installer_handoff_requires_both_verifications_in_the_machine() {
        let stages = [
            Stage::Planned,
            Stage::Downloaded,
            Stage::MinisignVerified,
            Stage::InstallerHandedOff,
            Stage::Rejected(RejectReason::MinisignInvalid),
        ];
        for s in stages {
            assert!(advance(s, Event::InstallerLaunch(true)).is_err(), "{s:?}");
        }
        assert!(advance(Stage::PlatformVerified, Event::InstallerLaunch(true)).is_ok());
    }

    #[test]
    fn terminal_stages_accept_nothing() {
        let events = [
            Event::Download(true),
            Event::Minisign(true),
            Event::Platform(true),
            Event::InstallerLaunch(true),
        ];
        for s in [
            Stage::InstallerHandedOff,
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
        assert!(advance(Stage::Downloaded, Event::InstallerLaunch(true)).is_err());
    }
    #[test]
    fn launch_error_is_rejected_after_both_checks_and_is_not_a_handoff_receipt() {
        let mut f = fake(true, true, true, false);
        let result = run(&plan(), &mut f);
        assert_eq!(result, Stage::Rejected(RejectReason::InstallLaunchFailed));
        assert_ne!(result, Stage::InstallerHandedOff);
        assert!(result.is_terminal());
        assert_eq!(
            f.log,
            ["download", "minisign", "platform", "launch_installer"]
        );
        assert!(
            !f.log.contains(&"discard"),
            "uncertain handoff retains the artifact until the host reconciles the installer"
        );
        assert!(advance(result, Event::InstallerLaunch(true)).is_err());
    }
}
