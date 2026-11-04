//! Attachment viewer: the system window `media-viewer` that shows an image
//! sequence, a video or a document. The main window names a message or saved
//! emoji; URLs are resolved here and stay bound to the active account visit,
//! so the viewer never receives an address from the UI and can only externally
//! open an item the host bound to it (it names an index, not a URL).
use crate::adapter::message_actions::{saved_emoji, SavedEmoji};
use crate::adapter::{self, display::UiMessageDto};
use crate::dto::{AccountContextDto, AppErrorDto};
use crate::shell::check_external_url;
use crate::state::HostState;
use crate::{views, windows};
use contracts::{AccountContext, AppError};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, Window};

type CmdResult<T> = Result<T, AppErrorDto>;
const CHANGED: &str = "media-viewer://changed";
/// Bounds the snapshot a long conversation hands to the viewer.
const MAX_GALLERY_ITEMS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ViewerAttachment {
    pub kind: String,
    pub url: String,
    pub name: String,
    pub thumbnail: Option<String>,
    /// Whether "另存" is offered: an image message whose original the host can
    /// re-resolve from its own cache. The identity itself never reaches the renderer.
    pub saveable: bool,
    #[serde(skip)]
    origin: Option<SaveOrigin>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SaveOrigin {
    gid: String,
    message_id: String,
}

/// What a save command may act on: resolved by the host from its own binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SaveSource {
    pub owner: AccountContext,
    pub gid: String,
    pub message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ViewerGallery {
    pub items: Vec<ViewerAttachment>,
    pub index: usize,
}

impl ViewerGallery {
    fn single(attachment: ViewerAttachment) -> Self {
        Self {
            items: vec![attachment],
            index: 0,
        }
    }
}

struct Binding {
    owner: AccountContext,
    visit_epoch: u64,
    gallery: ViewerGallery,
}

static BINDING: Mutex<Option<Binding>> = Mutex::new(None);
/// Keeps bind + window creation one step, so two quick clicks show the later one.
static OPENING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn invalid() -> AppError {
    AppError::new("im.invalid_attachment", "此消息没有可预览的附件")
}
fn stale() -> AppError {
    AppError::new("im.invalid_attachment", "账号已切换，附件预览已失效")
}

fn attachment_of_message(message: &UiMessageDto) -> Result<ViewerAttachment, AppError> {
    if !matches!(message.kind.as_str(), "image" | "video" | "file") {
        return Err(invalid());
    }
    let is_file = message.kind == "file";
    let source = message
        .media_url
        .as_deref()
        .filter(|url| !url.is_empty())
        .or((!is_file).then_some(message.text.as_str()))
        .ok_or_else(invalid)?;
    let url = check_external_url(source).map_err(|_| invalid())?;
    let name = message
        .media_filename
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .or(is_file.then_some(message.text.as_str()))
        .unwrap_or_default();
    let origin = (message.kind == "image")
        .then(|| {
            Some(SaveOrigin {
                gid: message.gid.clone(),
                message_id: message.message_id.clone()?,
            })
        })
        .flatten()
        .filter(|_| {
            message
                .media_url
                .as_deref()
                .is_some_and(|url| !url.is_empty())
        });
    Ok(ViewerAttachment {
        saveable: origin.is_some(),
        origin,
        kind: message.kind.clone(),
        url: url.to_string(),
        name: name.to_string(),
        thumbnail: message
            .media_thumbnail
            .as_deref()
            .and_then(|thumbnail| check_external_url(thumbnail).ok())
            .map(|thumbnail| thumbnail.to_string()),
    })
}

fn attachment_of_emoji(emoji: SavedEmoji) -> Result<ViewerAttachment, AppError> {
    Ok(ViewerAttachment {
        saveable: false,
        origin: None,
        kind: "image".into(),
        url: check_external_url(&emoji.url)
            .map_err(|_| invalid())?
            .to_string(),
        name: if emoji.name.trim().is_empty() {
            "自定义表情".into()
        } else {
            emoji.name
        },
        thumbnail: None,
    })
}

/// The conversation's images oldest first, around the selected one. Rows the
/// action path would refuse (recalled, ambiguous id, failing the origin policy)
/// are left out; a selection that is not among them stays on its own.
fn gallery_of_thread(
    thread: &[UiMessageDto],
    selected_id: &str,
    selected: ViewerAttachment,
) -> ViewerGallery {
    let recalled: HashSet<&str> = thread
        .iter()
        .filter_map(|row| row.recalled_message_id.as_deref())
        .collect();
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for id in thread.iter().filter_map(|row| row.message_id.as_deref()) {
        *seen.entry(id).or_default() += 1;
    }
    let mut rows: Vec<(&UiMessageDto, &str, ViewerAttachment)> = thread
        .iter()
        .filter(|row| row.kind == "image" && row.recalled_message_id.is_none())
        .filter_map(|row| {
            let id = row.message_id.as_deref()?;
            if recalled.contains(id) || seen.get(id) != Some(&1) {
                return None;
            }
            Some((row, id, attachment_of_message(row).ok()?))
        })
        .collect();
    rows.sort_by_key(|(row, _, _)| row.create_time_ms);
    let Some(position) = rows.iter().position(|(_, id, _)| *id == selected_id) else {
        return ViewerGallery::single(selected);
    };
    let start = position
        .saturating_sub(MAX_GALLERY_ITEMS / 2)
        .min(rows.len().saturating_sub(MAX_GALLERY_ITEMS));
    ViewerGallery {
        items: rows
            .into_iter()
            .skip(start)
            .take(MAX_GALLERY_ITEMS)
            .map(|(_, _, attachment)| attachment)
            .collect(),
        index: position - start,
    }
}

fn visit_matches(
    owner: &AccountContext,
    visit_epoch: u64,
    active: Option<&AccountContext>,
    active_epoch: Option<u64>,
) -> bool {
    active == Some(owner) && active_epoch == Some(visit_epoch)
}

fn still_active(app: &AppHandle, owner: &AccountContext, visit_epoch: u64) -> bool {
    visit_matches(
        owner,
        visit_epoch,
        crate::login::active_context(app).as_ref(),
        crate::login::active_visit_epoch(app),
    )
}

fn clear_binding() -> Option<Binding> {
    BINDING.lock().unwrap_or_else(|e| e.into_inner()).take()
}

fn close_window(app: &AppHandle) {
    if let Some(viewer) = app.get_webview_window(views::MEDIA_VIEWER) {
        let _ = viewer.close();
    }
}

fn begin_visit(
    app: &AppHandle,
    state: &State<'_, HostState>,
    account: &AccountContext,
) -> Result<u64, AppError> {
    let visit_epoch = crate::login::active_visit_epoch(app).ok_or_else(stale)?;
    state.lock().accounts.validate(account)?;
    Ok(visit_epoch)
}

async fn present(
    app: AppHandle,
    owner: AccountContext,
    visit_epoch: u64,
    gallery: ViewerGallery,
) -> CmdResult<()> {
    let _serial = OPENING.lock().await;
    if !still_active(&app, &owner, visit_epoch) {
        return Err(stale().into());
    }
    *BINDING.lock().unwrap_or_else(|e| e.into_inner()) = Some(Binding {
        owner: owner.clone(),
        visit_epoch,
        gallery,
    });
    if windows::open_media_viewer(&app).await.is_err() {
        clear_binding();
        return Err(AppError::new("im.viewer_unavailable", "无法打开附件预览窗口").into());
    }
    // Account switches may have landed while the window was being built.
    if !still_active(&app, &owner, visit_epoch) {
        clear_binding();
        close_window(&app);
        return Err(stale().into());
    }
    // A reused window is already loaded and refreshes on this; a new one reads on start.
    let _ = app.emit_to(views::MEDIA_VIEWER, CHANGED, ());
    Ok(())
}

fn bound(app: &AppHandle) -> Result<(AccountContext, ViewerGallery), AppError> {
    // Released before the login lock: BINDING never nests with account state.
    let (owner, visit_epoch, gallery) = {
        let binding = BINDING.lock().unwrap_or_else(|e| e.into_inner());
        let binding = binding.as_ref().ok_or_else(stale)?;
        (
            binding.owner.clone(),
            binding.visit_epoch,
            binding.gallery.clone(),
        )
    };
    if !still_active(app, &owner, visit_epoch) {
        return Err(stale());
    }
    Ok((owner, gallery))
}

fn current(app: &AppHandle) -> Result<ViewerGallery, AppError> {
    bound(app).map(|(_, gallery)| gallery)
}

/// The original behind gallery item `index`, from the host binding alone.
pub(crate) fn save_source(app: &AppHandle, index: usize) -> Result<SaveSource, AppError> {
    let (owner, gallery) = bound(app)?;
    let origin = gallery
        .items
        .get(index)
        .and_then(|item| item.origin.as_ref())
        .ok_or_else(invalid)?;
    Ok(SaveSource {
        owner,
        gid: origin.gid.clone(),
        message_id: origin.message_id.clone(),
    })
}

/// Fails when the visit ended or the gallery changed since `source` was taken.
pub(crate) fn save_source_still_bound(
    app: &AppHandle,
    index: usize,
    source: &SaveSource,
) -> Result<(), AppError> {
    if &save_source(app, index)? != source {
        return Err(stale());
    }
    Ok(())
}

/// ACCOUNT_CHANGED also fires for unread/remark refreshes; only a different
/// active visit ends the preview. Customer attachments never outlive it.
pub fn on_account_snapshot(app: &AppHandle) {
    let bound = BINDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|b| (b.owner.clone(), b.visit_epoch));
    let Some((owner, visit_epoch)) = bound else {
        return;
    };
    if !still_active(app, &owner, visit_epoch) {
        clear_binding();
        close_window(app);
    }
}

pub fn on_window_destroyed(label: &str) {
    if label == views::MEDIA_VIEWER {
        clear_binding();
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn media_viewer_open_message(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    message_id: String,
) -> CmdResult<()> {
    state
        .authorize(window.label(), "media_viewer_open_message")
        .map_err(AppErrorDto::from)?;
    let owner: AccountContext = account.into();
    let visit_epoch = begin_visit(&app, &state, &owner).map_err(AppErrorDto::from)?;
    let (message, _) =
        adapter::cached_message(&app, &owner, &gid, &message_id).map_err(AppErrorDto::from)?;
    let attachment = attachment_of_message(&message).map_err(AppErrorDto::from)?;
    // Only image messages browse their neighbours; video and documents stay single.
    let gallery = if message.kind == "image" {
        let thread = adapter::cached_thread(&app, &owner, &gid).map_err(AppErrorDto::from)?;
        gallery_of_thread(&thread, &message_id, attachment)
    } else {
        ViewerGallery::single(attachment)
    };
    present(app, owner, visit_epoch, gallery).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn media_viewer_open_emoji(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    id: String,
) -> CmdResult<()> {
    state
        .authorize(window.label(), "media_viewer_open_emoji")
        .map_err(AppErrorDto::from)?;
    let owner: AccountContext = account.into();
    let visit_epoch = begin_visit(&app, &state, &owner).map_err(AppErrorDto::from)?;
    if !still_active(&app, &owner, visit_epoch) {
        return Err(stale().into());
    }
    let emoji = saved_emoji(&app, &owner, &id).map_err(AppErrorDto::from)?;
    let attachment = attachment_of_emoji(emoji).map_err(AppErrorDto::from)?;
    present(app, owner, visit_epoch, ViewerGallery::single(attachment)).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn media_viewer_current(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
) -> CmdResult<ViewerGallery> {
    state
        .authorize(window.label(), "media_viewer_current")
        .map_err(AppErrorDto::from)?;
    current(&app).map_err(AppErrorDto::from)
}

#[tauri::command(rename_all = "snake_case")]
pub fn media_viewer_open_external(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    index: usize,
) -> CmdResult<()> {
    state
        .authorize(window.label(), "media_viewer_open_external")
        .map_err(AppErrorDto::from)?;
    let gallery = current(&app).map_err(AppErrorDto::from)?;
    let attachment = gallery
        .items
        .get(index)
        .ok_or_else(|| AppErrorDto::from(invalid()))?;
    let url = check_external_url(&attachment.url).map_err(AppErrorDto::from)?;
    crate::shell::open_in_browser(&url).map_err(AppErrorDto::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{AccountId, Environment};

    fn message(kind: &str, media_url: Option<&str>, text: &str) -> UiMessageDto {
        serde_json::from_value(serde_json::json!({
            "gid": "synthetic-room",
            "message_id": "1",
            "local_id": null,
            "create_time_ms": 1,
            "sender_role": "customer",
            "kind": kind,
            "text": text,
            "media_url": media_url,
        }))
        .unwrap()
    }
    fn account(generation: u64) -> AccountContext {
        AccountContext::new(
            AccountId::new("synthetic-account"),
            Environment::production(),
            generation,
        )
    }

    #[test]
    fn attachment_url_comes_from_the_message_and_must_pass_the_origin_policy() {
        let ok = attachment_of_message(&message(
            "image",
            Some("https://dimg04.tripcdn.com/a.png"),
            "",
        ))
        .unwrap();
        assert_eq!(ok.url, "https://dimg04.tripcdn.com/a.png");
        assert_eq!(
            attachment_of_message(&message("video", None, "https://dimg04.c-ctrip.com/v.mp4"))
                .unwrap()
                .url,
            "https://dimg04.c-ctrip.com/v.mp4"
        );
        for rejected in [
            message("image", Some("https://evil.example/a.png"), ""),
            message("image", Some("http://dimg04.tripcdn.com/a.png"), ""),
            message(
                "image",
                Some("https://user:pw@dimg04.tripcdn.com/a.png"),
                "",
            ),
            message("image", None, "not a url"),
            // A file's text is its display name, never a fallback address.
            message("file", None, "https://dimg04.tripcdn.com/report.pdf"),
            message("text", Some("https://dimg04.tripcdn.com/a.png"), ""),
            message("voice", Some("https://dimg04.tripcdn.com/a.m4a"), ""),
        ] {
            assert!(
                attachment_of_message(&rejected).is_err(),
                "{}",
                rejected.kind
            );
        }
    }

    #[test]
    fn file_name_falls_back_to_message_text_and_bad_thumbnails_are_dropped() {
        let mut file = message("file", Some("https://dimg04.tripcdn.com/x"), "report.pdf");
        file.media_thumbnail = Some("https://evil.example/t.png".into());
        let attachment = attachment_of_message(&file).unwrap();
        assert_eq!(attachment.name, "report.pdf");
        assert_eq!(attachment.thumbnail, None);
        file.media_filename = Some("named.pdf".into());
        assert_eq!(attachment_of_message(&file).unwrap().name, "named.pdf");
    }

    fn image(id: &str, time_ms: i64) -> UiMessageDto {
        let mut row = message(
            "image",
            Some(&format!("https://dimg04.tripcdn.com/{id}.png")),
            "",
        );
        row.message_id = Some(id.into());
        row.create_time_ms = time_ms;
        row
    }
    fn gallery(thread: &[UiMessageDto], selected: &str) -> ViewerGallery {
        let row = thread
            .iter()
            .find(|row| row.message_id.as_deref() == Some(selected))
            .unwrap();
        gallery_of_thread(thread, selected, attachment_of_message(row).unwrap())
    }
    fn names(gallery: &ViewerGallery) -> Vec<&str> {
        gallery
            .items
            .iter()
            .map(|item| item.url.rsplit('/').next().unwrap())
            .collect()
    }

    #[test]
    fn gallery_orders_the_conversation_images_around_the_selection() {
        let mut video = image("v", 15);
        video.kind = "video".into();
        let thread = [image("c", 30), image("a", 10), video, image("b", 20)];
        let result = gallery(&thread, "b");
        assert_eq!(names(&result), ["a.png", "b.png", "c.png"]);
        assert_eq!(result.index, 1);
    }

    #[test]
    fn gallery_leaves_out_rows_the_action_path_would_refuse() {
        let mut bad_origin = image("x", 2);
        bad_origin.media_url = Some("https://evil.example/x.png".into());
        let mut unconfirmed = image("y", 3);
        unconfirmed.message_id = None;
        let mut tombstone = message("system", None, "");
        tombstone.recalled_message_id = Some("r".into());
        let thread = [
            image("a", 1),
            bad_origin,
            unconfirmed,
            image("r", 4),
            tombstone,
            image("dup", 5),
            image("dup", 6),
            image("z", 7),
        ];
        let result = gallery(&thread, "z");
        assert_eq!(names(&result), ["a.png", "z.png"]);
        assert_eq!(result.index, 1);
    }

    #[test]
    fn a_selection_outside_the_sequence_stays_on_its_own() {
        let selected = attachment_of_message(&image("gone", 9)).unwrap();
        let result = gallery_of_thread(&[image("a", 1)], "gone", selected.clone());
        assert_eq!(result, ViewerGallery::single(selected));
    }

    #[test]
    fn gallery_is_bounded_and_keeps_the_selection_in_range() {
        let thread: Vec<_> = (0..500).map(|i| image(&format!("m{i}"), i)).collect();
        for (selected, expected_index) in [("m0", 0), ("m250", 100), ("m499", 199)] {
            let result = gallery(&thread, selected);
            assert_eq!(result.items.len(), MAX_GALLERY_ITEMS);
            assert_eq!(result.index, expected_index, "{selected}");
            assert_eq!(names(&result)[result.index], format!("{selected}.png"));
        }
    }

    #[test]
    fn a_preview_only_lives_for_its_own_account_visit() {
        let owner = account(3);
        assert!(visit_matches(&owner, 7, Some(&owner), Some(7)));
        assert!(!visit_matches(&owner, 7, None, Some(7)));
        assert!(!visit_matches(&owner, 7, Some(&account(4)), Some(7)));
        // A → B → A leaves the same context but a new visit.
        assert!(!visit_matches(&owner, 7, Some(&owner), Some(9)));
    }
}
