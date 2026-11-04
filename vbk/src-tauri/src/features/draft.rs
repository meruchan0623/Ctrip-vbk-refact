//! Draft text and attachment references share the existing outbound store.
//! Text and attachment revisions are independent field-level CAS operations.
use super::{authorize, CmdResult};
use crate::dto::{AccountContextDto, AppErrorDto};
use crate::state::HostState;
use contracts::{codes, AppError};
use core_im::feature_rules::validate_gid;
use core_store::FileStore;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, State, Webview};

fn store_of(state: &HostState) -> CmdResult<Arc<FileStore>> {
    // Login unlocks the legacy source through the persistence queue. Do not
    // import an empty/locked snapshot before that preceding unlock is durable.
    state.persist_barrier().map_err(AppErrorDto::from)?;
    state.lock().store.clone().ok_or_else(|| {
        AppErrorDto::from(AppError::new(
            codes::HOST_UNSUPPORTED,
            "draft storage unavailable",
        ))
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn im_draft_load(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
) -> CmdResult<Value> {
    let ctx = authorize(&state, &webview, "im_draft_load", account)?;
    let legacy = store_of(&state)?;
    let drafts = crate::adapter::with_outbound(&app, &ctx, |journal| {
        journal.load_drafts(&ctx, legacy.as_ref())
    })
    .map_err(AppErrorDto::from)?;
    Ok(json!({"drafts":drafts}))
}

#[tauri::command(rename_all = "snake_case")]
pub fn im_draft_save(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    text: String,
    expected_version: u64,
) -> CmdResult<Value> {
    let ctx = authorize(&state, &webview, "im_draft_save", account)?;
    validate_gid(&gid).map_err(AppErrorDto::from)?;
    let legacy = store_of(&state)?;
    let version = crate::adapter::with_outbound(&app, &ctx, |journal| {
        journal.save_draft_text(&ctx, &gid, &text, expected_version, legacy.as_ref())
    })
    .map_err(AppErrorDto::from)?;
    Ok(json!({"version":version}))
}

#[tauri::command(rename_all = "snake_case")]
pub fn im_draft_attachment_save(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    attachment_id: Value,
    expected_version: u64,
) -> CmdResult<Value> {
    let ctx = authorize(&state, &webview, "im_draft_attachment_save", account)?;
    validate_gid(&gid).map_err(AppErrorDto::from)?;
    let legacy = store_of(&state)?;
    let attachment_id = match attachment_id {
        Value::Null => None,
        Value::String(id) if !id.is_empty() && id.len() <= 512 => Some(id),
        _ => return Err(crate::media_outbound::invalid().into()),
    };
    let selected = attachment_id
        .as_deref()
        .map(|id| crate::shell::frozen_attachment(&app, id, &ctx, &gid))
        .transpose()
        .map_err(AppErrorDto::from)?;
    if selected
        .as_ref()
        .is_some_and(|frozen| frozen.dto.lease_id.is_none() || frozen.bytes.is_empty())
    {
        return Err(crate::media_outbound::invalid().into());
    }
    let lease_id = selected
        .as_ref()
        .and_then(|frozen| frozen.dto.lease_id.as_deref());
    crate::adapter::with_outbound(&app, &ctx, |journal| {
        let version = journal.set_draft_attachment(&ctx, &gid, lease_id, expected_version, legacy.as_ref())?;
        let current = journal.load_draft(&ctx, &gid, legacy.as_ref())?;
        Ok(json!({"attachment_version":current.as_ref().map_or(version, |draft| draft.attachment_version),
            "attachments":current.map(|draft| draft.attachments).unwrap_or_default()}))
    }).map_err(AppErrorDto::from)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_draft_attachment_restore(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    lease_id: String,
) -> CmdResult<crate::media_outbound::AttachmentDto> {
    let ctx = authorize(&state, &webview, "im_draft_attachment_restore", account)?;
    validate_gid(&gid).map_err(AppErrorDto::from)?;
    let target = crate::adapter::capture_media_target(&app, &ctx, &gid)
        .await
        .map_err(AppErrorDto::from)?;
    let read_app = app.clone();
    let read_ctx = ctx.clone();
    let read_gid = gid.clone();
    let read_target = target.clone();
    let restored = tauri::async_runtime::spawn_blocking(move || {
        crate::adapter::with_outbound(&read_app, &read_ctx, |journal| {
            journal.restore_attachment(&read_ctx, &read_gid, &lease_id, read_target)
        })
    })
    .await;
    let restored = match restored {
        Ok(Ok(frozen)) => frozen,
        _ => {
            crate::adapter::release_media_target(&app, &ctx, &gid, &target).await;
            return Err(AppError::new(
                "media.draft_attachment_unavailable",
                "草稿附件缺失、损坏或等待发送核验，请移除附件或先核验发送结果。",
            )
            .into());
        }
    };
    let current = state.lock().accounts.validate(&ctx);
    if let Err(error) = current {
        crate::adapter::release_media_target(&app, &ctx, &gid, &target).await;
        return Err(error.into());
    }
    if let Err(error) = crate::adapter::validate_media_target(&app, &ctx, &gid, &target).await {
        crate::adapter::release_media_target(&app, &ctx, &gid, &target).await;
        return Err(error.into());
    }
    match crate::shell::register_restored_attachment(&app, restored) {
        Ok(dto) => Ok(dto),
        Err(error) => {
            crate::adapter::release_media_target(&app, &ctx, &gid, &target).await;
            Err(error.into())
        }
    }
}
