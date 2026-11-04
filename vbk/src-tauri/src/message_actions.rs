//! Forwarding and the account-scoped local custom emoji library.
//! Included under adapter so sends share the durable outbound admission boundary.
use super::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedEmoji {
    pub id: String,
    pub name: String,
    pub url: String,
    pub thumbnail: Option<String>,
    pub created_at_ms: i64,
    pub rank: u64,
}
fn library_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
fn invalid_action(message: &str) -> AppError {
    AppError::new("im.invalid_message_action", message)
}
fn library_path(app: &AppHandle, ctx: &AccountContext) -> Result<PathBuf, AppError> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| invalid_action("application data directory unavailable"))?;
    let key = serde_json::to_vec(&(&ctx.environment.0, &ctx.account_id.0))
        .map_err(|_| invalid_action("invalid account"))?;
    use sha2::{Digest, Sha256};
    Ok(root
        .join("saved-emojis")
        .join(format!("{:x}.json", Sha256::digest(&key))))
}
fn official_image(url: &str) -> bool {
    tauri::Url::parse(url).ok().is_some_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port_or_known_default() == Some(443)
            && u.host_str().is_some_and(|h| {
                ["ctrip.com", "tripcdn.com", "c-ctrip.com"]
                    .iter()
                    .any(|base| h == *base || h.ends_with(&format!(".{base}")))
            })
    })
}
fn read_library(path: &PathBuf) -> Result<Vec<SavedEmoji>, AppError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    if std::fs::metadata(path)
        .map_err(|_| invalid_action("cannot read custom emojis"))?
        .len()
        > 4 * 1024 * 1024
    {
        return Err(invalid_action("custom emoji library too large"));
    }
    let bytes = std::fs::read(path).map_err(|_| invalid_action("cannot read custom emojis"))?;
    let mut items: Vec<SavedEmoji> = serde_json::from_slice(&bytes)
        .map_err(|_| invalid_action("custom emoji library invalid"))?;
    if items.len() > 500
        || items.iter().any(|e| {
            !official_image(&e.url) || e.thumbnail.as_deref().is_some_and(|u| !official_image(u))
        })
    {
        return Err(invalid_action("custom emoji library invalid"));
    }
    items.sort_by(|a, b| {
        b.rank
            .cmp(&a.rank)
            .then_with(|| b.created_at_ms.cmp(&a.created_at_ms))
    });
    Ok(items)
}
fn write_library(path: &PathBuf, items: &[SavedEmoji]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid_action("invalid library path"))?;
    std::fs::create_dir_all(parent).map_err(|_| invalid_action("cannot save custom emojis"))?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|_| invalid_action("cannot save custom emojis"))?;
        file.write_all(
            &serde_json::to_vec(items)
                .map_err(|_| invalid_action("cannot encode custom emojis"))?,
        )
        .map_err(|_| invalid_action("cannot save custom emojis"))?;
        file.sync_all()
            .map_err(|_| invalid_action("cannot save custom emojis"))?;
        std::fs::rename(&temp, path).map_err(|_| invalid_action("cannot replace custom emojis"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}
fn mutate_library(
    app: &AppHandle,
    ctx: &AccountContext,
    change: impl FnOnce(&mut Vec<SavedEmoji>) -> Result<(), AppError>,
) -> Result<Vec<SavedEmoji>, AppError> {
    let _guard = lock(library_lock());
    let path = library_path(app, ctx)?;
    let mut items = read_library(&path)?;
    change(&mut items)?;
    items.sort_by(|a, b| b.rank.cmp(&a.rank));
    write_library(&path, &items)?;
    Ok(items)
}
fn target_revision(
    app: &AppHandle,
    ctx: &AccountContext,
    gid: &str,
    expected: Option<&str>,
) -> Result<Option<String>, AppError> {
    let m = module(app)?;
    let row = lock(&m.display)
        .conversation(ctx, gid)?
        .ok_or_else(|| invalid_action("target conversation unavailable"))?;
    if row.fact.status != "active" || !row.fact.agent_in_group {
        return Err(invalid_action("target conversation is not active"));
    }
    if expected.is_some_and(|e| row.assistant_context_revision.as_deref() != Some(e)) {
        return Err(invalid_action("target conversation changed"));
    }
    Ok(row.assistant_context_revision)
}
async fn send_action(
    app: &AppHandle,
    state: &HostState,
    ctx: &AccountContext,
    local_id: &str,
    gid: &str,
    op: &str,
    args: Value,
) -> CmdResult<SendDispositionDto> {
    if local_id.is_empty() || local_id.len() > 256 {
        return Err(e2dto(invalid_action("invalid local message id")));
    }
    state.persist_barrier().map_err(e2dto)?;
    let m = module(app).map_err(e2dto)?;
    let journal = m
        .outbound
        .as_ref()
        .ok_or_else(|| e2dto(invalid_action("outbound journal unavailable")))?;
    let payload = outbound_journal::SendPayload {
        gid: gid.to_owned(),
        text: serde_json::to_string(&(op, &args))
            .map_err(|_| e2dto(invalid_action("invalid send action")))?,
        original: None,
        quote_id: None,
    };
    outbound_journal::send_once(journal, ctx, local_id, &payload, || async {
        let result = request_inner(app, ctx, op, args, WRITE_TIMEOUT)
            .await
            .map(|v| v.get("disposition").cloned().unwrap_or(Value::Null));
        send_outcome(result)
    })
    .await
    .map_err(e2dto)
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn im_forward_message(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    source_gid: String,
    message_id: String,
    gid: String,
    local_id: String,
    target_context_revision: Option<String>,
) -> CmdResult<SendDispositionDto> {
    guard(&state, webview.label(), "im_forward_message")?;
    let ctx = ui_account(&app, &state, account)?;
    let (message, revision) =
        cached_message(&app, &ctx, &source_gid, &message_id).map_err(e2dto)?;
    if message
        .platform_type
        .is_some_and(|kind| ![0, 1, 2, 3, 5, 8, 9].contains(&kind))
        || !["text", "image", "video", "file", "order_card"].contains(&message.kind.as_str())
        || matches!(
            message.disposition,
            Some(SendDispositionDto::Unknown | SendDispositionDto::Rejected { .. })
        )
    {
        return Err(e2dto(invalid_action("message cannot be forwarded")));
    }
    let target =
        target_revision(&app, &ctx, &gid, target_context_revision.as_deref()).map_err(e2dto)?;
    let args = serde_json::json!({"gid":gid,"local_id":local_id,"source_gid":source_gid,"source_message_id":message_id,"source_create_time_ms":message.create_time_ms,"source_context_revision":revision,"target_context_revision":target});
    send_action(
        &app,
        &state,
        &ctx,
        &local_id,
        &gid,
        "im.forward_message",
        args,
    )
    .await
}
pub(crate) fn saved_emoji(
    app: &AppHandle,
    ctx: &AccountContext,
    id: &str,
) -> Result<SavedEmoji, AppError> {
    let _guard = lock(library_lock());
    read_library(&library_path(app, ctx)?)?
        .into_iter()
        .find(|emoji| emoji.id == id)
        .ok_or_else(|| invalid_action("custom emoji unavailable"))
}
#[tauri::command(rename_all = "snake_case")]
pub fn im_saved_emojis(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
) -> CmdResult<Vec<SavedEmoji>> {
    guard(&state, webview.label(), "im_saved_emojis")?;
    let ctx = read_account(&state, account)?;
    let _guard = lock(library_lock());
    read_library(&library_path(&app, &ctx).map_err(e2dto)?).map_err(e2dto)
}
#[tauri::command(rename_all = "snake_case")]
pub fn im_add_saved_emoji(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    message_id: String,
) -> CmdResult<Vec<SavedEmoji>> {
    guard(&state, webview.label(), "im_add_saved_emoji")?;
    let ctx = read_account(&state, account)?;
    let (message, _) = cached_message(&app, &ctx, &gid, &message_id).map_err(e2dto)?;
    let url = message
        .media_url
        .filter(|u| official_image(u))
        .ok_or_else(|| e2dto(invalid_action("image URL unavailable")))?;
    if message.kind != "image" {
        return Err(e2dto(invalid_action("message is not an image")));
    }
    mutate_library(&app, &ctx, |items| {
        let rank = items
            .iter()
            .map(|e| e.rank)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        if let Some(existing) = items.iter_mut().find(|e| e.url == url) {
            existing.rank = rank;
            return Ok(());
        }
        if items.len() >= 500 {
            return Err(invalid_action("custom emoji library is full"));
        }
        items.push(SavedEmoji {
            id: uuid::Uuid::new_v4().to_string(),
            name: message
                .media_filename
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "自定义表情".into())
                .chars()
                .take(80)
                .collect(),
            url,
            thumbnail: message.media_thumbnail.filter(|u| official_image(u)),
            created_at_ms: state.clock.wall_ms(),
            rank,
        });
        Ok(())
    })
    .map_err(e2dto)
}
#[tauri::command(rename_all = "snake_case")]
pub fn im_update_saved_emoji(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    id: String,
    action: String,
    name: Option<String>,
) -> CmdResult<Vec<SavedEmoji>> {
    guard(&state, webview.label(), "im_update_saved_emoji")?;
    let ctx = read_account(&state, account)?;
    mutate_library(&app, &ctx, |items| {
        let max_rank = items.iter().map(|e| e.rank).max().unwrap_or(0);
        let index = items
            .iter()
            .position(|e| e.id == id)
            .ok_or_else(|| invalid_action("custom emoji no longer exists"))?;
        match action.as_str() {
            "delete" => {
                items.remove(index);
            }
            "front" => items[index].rank = max_rank.saturating_add(1),
            "rename" => {
                let text = name.as_deref().unwrap_or("").trim();
                if text.is_empty() || text.chars().count() > 80 {
                    return Err(invalid_action("name must contain 1–80 characters"));
                }
                items[index].name = text.to_owned();
            }
            _ => return Err(invalid_action("unknown custom emoji action")),
        }
        Ok(())
    })
    .map_err(e2dto)
}
#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn im_send_saved_emoji(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    id: String,
    local_id: String,
    target_context_revision: Option<String>,
) -> CmdResult<SendDispositionDto> {
    guard(&state, webview.label(), "im_send_saved_emoji")?;
    let ctx = ui_account(&app, &state, account)?;
    let emoji = {
        let _guard = lock(library_lock());
        read_library(&library_path(&app, &ctx).map_err(e2dto)?)
            .map_err(e2dto)?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| e2dto(invalid_action("custom emoji no longer exists")))?
    };
    let revision =
        target_revision(&app, &ctx, &gid, target_context_revision.as_deref()).map_err(e2dto)?;
    send_action(&app,&state,&ctx,&local_id,&gid,"im.send_saved_image",serde_json::json!({"gid":gid,"local_id":local_id,"url":emoji.url,"thumbnail":emoji.thumbnail,"target_context_revision":revision})).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_urls_only_admit_official_https_hosts() {
        for url in [
            "https://images4.c-ctrip.com/a.png",
            "https://dimg04.tripcdn.com/a.gif",
            "https://pic.ctrip.com/a.jpg",
        ] {
            assert!(official_image(url));
        }
        for url in [
            "http://images4.c-ctrip.com/a.png",
            "https://ctrip.com.evil.test/a",
            "https://user@images4.c-ctrip.com/a",
            "https://127.0.0.1/a",
            "file:///tmp/a",
            "https://pic.ctrip.com:8443/a",
        ] {
            assert!(!official_image(url));
        }
    }
    #[test]
    fn local_library_roundtrip_and_atomic_replace() {
        let path = std::env::temp_dir().join(format!("vbk-emoji-{}.json", uuid::Uuid::new_v4()));
        let record = SavedEmoji {
            id: "one".into(),
            name: "测试".into(),
            url: "https://pic.ctrip.com/a.png".into(),
            thumbnail: None,
            created_at_ms: 1,
            rank: 1,
        };
        write_library(&path, &[record.clone()]).unwrap();
        assert_eq!(read_library(&path).unwrap()[0].name, "测试");
        write_library(&path, &[]).unwrap();
        assert!(read_library(&path).unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
    }
}
