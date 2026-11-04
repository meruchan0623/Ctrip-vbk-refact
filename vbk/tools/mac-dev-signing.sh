#!/usr/bin/env bash
# 测试阶段 macOS 包的固定签名身份。
#
# 为什么需要：不签名时 `tauri build` 产出的是链接器 ad-hoc 签名，代码标识形如
# `vbk_host-<hash>`，每次构建都变。钥匙串条目（快速登录标记、TSim 助手登录）的
# 访问控制绑定在签名上，新构建会被当成另一个 App，读旧条目要弹窗或被拒，表现为
# 「装了新包就掉登录」。用同一张自签名证书签所有测试包后，designated requirement
# 固定为 `identifier "tech.tsim.vbk.client" and certificate leaf = H"<证书指纹>"`。
#
# 证书全组只生成一次，所有测试包（本地与 CI）都用它，换证书等于换 App。
# .p12 与密码不进仓库；CI 用 secret MAC_DEV_CERTIFICATE（base64）与
# MAC_DEV_CERTIFICATE_PASSWORD。这不是 Developer ID：Gatekeeper 照样拦，
# 对外分发仍需 Developer ID 签名与公证。
#
# 用法（在 vbk/ 下）：
#   tools/mac-dev-signing.sh create ~/secure/vbk-dev-signing.p12
#   VBK_DEV_P12_PASSWORD=... tools/mac-dev-signing.sh build ~/secure/vbk-dev-signing.p12 [tauri build 参数…]
set -euo pipefail

IDENTITY="VBK Dev Signing"

password() {
  if [[ -n "${VBK_DEV_P12_PASSWORD:-}" ]]; then
    printf '%s' "$VBK_DEV_P12_PASSWORD"
  else
    local pw
    read -r -s -p "p12 password: " pw
    echo >&2
    printf '%s' "$pw"
  fi
}

create() {
  local out="${1:?usage: create <out.p12>}"
  [[ -e "$out" ]] && { echo "$out already exists; refusing to overwrite" >&2; exit 1; }
  local pw tmp
  pw="$(password)"
  [[ -n "$pw" ]] || { echo "empty password" >&2; exit 1; }
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand now: `tmp` is local and gone by EXIT.
  trap "rm -rf '$tmp'" EXIT
  cat >"$tmp/cfg" <<EOF
[req]
distinguished_name=dn
prompt=no
x509_extensions=ext
[dn]
CN=$IDENTITY
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$tmp/cfg" \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
  # macOS `security import` 只认旧式 PKCS12 加密（OpenSSL 3+ 默认的 AES 会报 MAC 校验失败）。
  openssl pkcs12 -export -name "$IDENTITY" -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -passout "pass:$pw" -out "$out"
  chmod 600 "$out"
  echo "created $out"
  echo "certificate SHA-1: $(openssl x509 -in "$tmp/cert.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)"
  echo "CI secret MAC_DEV_CERTIFICATE: base64 -i \"$out\" | pbcopy"
}

# 用 .p12 重签已打好的 .app。Tauri 只认 `find-identity -v`（受信任）的身份，
# 自签名证书过不了，所以由这里签：证书导入一次性的临时钥匙串，`codesign
# --keychain` 直接用它，不进钥匙串搜索列表、不改登录钥匙串，签完即删。
sign() {
  local p12="${1:?usage: sign <p12> <app>}" app="${2:?usage: sign <p12> <app>}"
  [[ -f "$p12" ]] || { echo "$p12 not found" >&2; exit 1; }
  [[ -d "$app" ]] || { echo "$app not found" >&2; exit 1; }
  local pw tmp kc kcpw
  pw="$(password)"
  tmp="$(mktemp -d)"
  kc="$tmp/sign.keychain-db"
  kcpw="$(uuidgen)"
  # shellcheck disable=SC2064 # expand now: `tmp`/`kc` are local and gone by EXIT.
  trap "security delete-keychain '$kc' 2>/dev/null; rm -rf '$tmp'" EXIT
  security create-keychain -p "$kcpw" "$kc"
  security unlock-keychain -p "$kcpw" "$kc"
  security import "$p12" -k "$kc" -P "$pw" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k "$kcpw" "$kc" >/dev/null
  # 与 Tauri 签名一致：hardened runtime，entitlements 保持为空（release.yml 会检查）。
  codesign --force --deep --options runtime --timestamp=none \
    --keychain "$kc" --sign "$IDENTITY" "$app"
  codesign --verify --deep --strict "$app"
  local req
  req="$(codesign -dr - "$app" 2>&1)"
  grep -q 'identifier "tech.tsim.vbk.client" and certificate leaf' <<<"$req" \
    || { echo "unexpected designated requirement: $req" >&2; exit 1; }
  echo "signed $app"
  echo "$req" | tail -n1
}

# 测试用 dmg：.app + /Applications 快捷方式。
dmg() {
  local app="${1:?usage: dmg <app> <out.dmg>}" out="${2:?usage: dmg <app> <out.dmg>}"
  local stage
  stage="$(mktemp -d)"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  rm -f "$out"
  hdiutil create -quiet -volname "$(basename "$app" .app)" -srcfolder "$stage" -ov -format UDZO "$out"
  rm -rf "$stage"
  echo "dmg $out"
}

# tauri build（只出 .app，未签名）→ 用测试身份重签 → 打 dmg。
# 额外参数原样交给 tauri build，须含 --target <triple>。
build() {
  local p12="${1:?usage: build <p12> --target <triple> [tauri build args…]}"
  shift
  local target="" prev=""
  for a in "$@"; do
    [[ "$prev" == "--target" ]] && target="$a"
    prev="$a"
  done
  [[ -n "$target" ]] || { echo "build needs --target <triple>" >&2; exit 2; }
  # 先问密码，避免构建跑完才卡在提示上。
  VBK_DEV_P12_PASSWORD="$(password)"
  export VBK_DEV_P12_PASSWORD
  npx tauri build "$@" --bundles app
  local out="src-tauri/target/$target/release/bundle" app
  app="$(ls -d "$out"/macos/*.app | head -n1)"
  sign "$p12" "$app"
  mkdir -p "$out/dmg"
  dmg "$app" "$out/dmg/$(basename "$app" .app)_test_$(uname -m).dmg"
}

case "${1:-}" in
  create) shift; create "$@" ;;
  sign) shift; sign "$@" ;;
  dmg) shift; dmg "$@" ;;
  build) shift; build "$@" ;;
  *) echo "usage: $0 create <out.p12> | sign <p12> <app> | dmg <app> <out.dmg> | build <p12> --target <triple> [tauri build args…]" >&2; exit 2 ;;
esac
