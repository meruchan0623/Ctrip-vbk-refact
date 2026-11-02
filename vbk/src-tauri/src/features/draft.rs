//! Per-account drafts (I-09 / D10 "重启恢复"): `im_draft_load`, `im_draft_save`.
//!
//! The main window's `createIpcDraftPort` (`ui/apps/main/draft-book.ts`)
//! is the only caller. Contract:
//!
//! * `im_draft_load {account}` → `{drafts: [{gid, text, version}]}`
//! * `im_draft_save {account, gid, text, expected_version}` → `{version}`;
//!   a stale `expected_version` is `store.cas_conflict` (the port reloads
//!   and writes once more). Empty `text` deletes the draft (`version` 0).
//!
//! All judging lives in `core_store::DraftBook` (tested std-only); this
//! file only authorises, resolves the namespace and hands the `Arc<FileStore>`
//! over. The commit is synchronous (drafts are low-frequency user input and
//! `FileStore::commit` fsyncs), therefore the commands are *blocking* Tauri
//! commands (not `async`, so they run on the blocking pool) and the `Cores`
//! guard is dropped before any store call (`core_store::lock_order`:
//! `DiskSync` is forbidden under `Cores`).
//!
//! NOTE: not compiled in the cloud check environment; see `features/mod.rs`.

use std::sync::Arc;

use contracts::{codes, AppError};
use core_im::feature_rules::validate_gid;
use core_store::{DraftBook, FileStore, Namespace};
use serde_json::{json, Value};
use tauri::{State, Webview};

use super::{authorize, CmdResult};
use crate::dto::{AccountContextDto, AppErrorDto};
use crate::state::HostState;

/// The account store, cloned out from under the `Cores` lock. The guard is a
/// temporary of this expression and is released before the caller touches
/// the disk.
fn store_of(state: &HostState) -> CmdResult<Arc<FileStore>> {
    state.lock().store.clone().ok_or_else(|| {
        AppErrorDto::from(AppError::new(
            codes::HOST_UNSUPPORTED,
            "drafts are not persisted: the host runs without a store",
        ))
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn im_draft_load(
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
) -> CmdResult<Value> {
    let ctx = authorize(&state, &webview, "im_draft_load", account)?;
    let store = store_of(&state)?;
    let ns = Namespace::from_context(&ctx);
    let drafts: Vec<Value> = DraftBook::load(store.as_ref(), &ns)
        .map_err(AppErrorDto::from)?
        .into_iter()
        .map(|d| json!({ "gid": d.gid, "text": d.text, "version": d.version }))
        .collect();
    Ok(json!({ "drafts": drafts }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn im_draft_save(
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    text: String,
    expected_version: u64,
) -> CmdResult<Value> {
    let ctx = authorize(&state, &webview, "im_draft_save", account)?;
    validate_gid(&gid).map_err(AppErrorDto::from)?;
    let store = store_of(&state)?;
    let ns = Namespace::from_context(&ctx);
    let version = DraftBook::save(store.as_ref(), &ns, &gid, &text, expected_version)
        .map_err(AppErrorDto::from)?;
    Ok(json!({ "version": version }))
}
