//! Native messaging entry point. stdout is exclusively framed protocol data.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    net::TcpStream,
    path::PathBuf,
    time::Duration,
};
const EXTENSION: &str = "dhfnfakligkclahdpejdeoocanjbmkco";
const MAX: usize = 128 * 1024;
#[derive(Deserialize)]
struct Session {
    port: u16,
    secret: String,
}
#[derive(Serialize)]
struct Reply {
    ok: bool,
    message: &'static str,
}
fn frame_read(r: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut n = [0; 4];
    r.read_exact(&mut n)?;
    let n = u32::from_le_bytes(n) as usize;
    if n == 0 || n > MAX {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut b = vec![0; n];
    r.read_exact(&mut b)?;
    Ok(b)
}
fn frame_write(w: &mut impl Write, b: &[u8]) -> io::Result<()> {
    w.write_all(&(b.len() as u32).to_le_bytes())?;
    w.write_all(b)?;
    w.flush()
}
fn path() -> io::Result<PathBuf> {
    #[cfg(target_os = "windows")]
    let root =
        PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or(io::ErrorKind::NotFound)?).join("VBK");
    #[cfg(not(target_os = "windows"))]
    let root = PathBuf::from(std::env::var_os("HOME").ok_or(io::ErrorKind::NotFound)?)
        .join("Library/Application Support/VBK");
    Ok(root.join("browser-bridge/session.json"))
}
fn relay(bytes: Vec<u8>) -> io::Result<Vec<u8>> {
    let mut request: serde_json::Value = serde_json::from_slice(&bytes)?;
    let map = request.as_object_mut().ok_or(io::ErrorKind::InvalidData)?;
    if map.contains_key("secret") || map.contains_key("extension") {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let p = path()?;
    let meta = fs::symlink_metadata(&p)?;
    if meta.file_type().is_symlink() || meta.len() > 1024 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    let session: Session = serde_json::from_slice(&fs::read(p)?)?;
    if session.secret.len() != 64 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    map.insert("secret".into(), session.secret.into());
    map.insert("extension".into(), EXTENSION.into());
    let mut socket = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], session.port)),
        Duration::from_secs(2),
    )?;
    socket.set_read_timeout(Some(Duration::from_secs(3)))?;
    socket.set_write_timeout(Some(Duration::from_secs(3)))?;
    frame_write(&mut socket, &serde_json::to_vec(&request)?)?;
    frame_read(&mut socket)
}
fn main() {
    let expected = format!("chrome-extension://{EXTENSION}/");
    if std::env::args().nth(1).as_deref() != Some(expected.as_str()) {
        return;
    }
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    while let Ok(bytes) = frame_read(&mut input) {
        let reply = relay(bytes).unwrap_or_else(|_| {
            serde_json::to_vec(&Reply {
                ok: false,
                message: "无法连接 VBK。请打开客户端添加账号窗口，并检查本机桥接是否安装。",
            })
            .unwrap()
        });
        if frame_write(&mut output, &reply).is_err() {
            break;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_frames() {
        assert!(frame_read(&mut &((MAX + 1) as u32).to_le_bytes()[..]).is_err());
        let mut out = vec![];
        frame_write(&mut out, b"{}").unwrap();
        assert_eq!(frame_read(&mut &out[..]).unwrap(), b"{}");
    }
}
