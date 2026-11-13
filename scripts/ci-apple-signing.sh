#!/usr/bin/env bash
#
# macOS 代码签名证书导入（CI 用）
#
# 作用：把仓库 Secrets 里的 Developer ID Application 证书导入一个临时钥匙串，
# 并把签名身份与公证凭据写进后续步骤可见的环境变量，随后由 Tauri 自动完成
# 「签名 → 公证 → 装订（staple）」。
#
# 关键约定：**没有配置证书时什么都不做、且不算失败**。
# 因此仓库在「尚未买到证书」与「已配好证书」两种状态下，CI 都是绿的，
# 差别只是产物签没签名——这样接入证书这件事不需要改动任何构建命令。
#
# 需要的 Secrets（全部可选；缺哪个就少做哪一步）：
#   APPLE_CERTIFICATE            base64 编码的 .p12（Developer ID Application 证书 + 私钥）
#   APPLE_CERTIFICATE_PASSWORD   .p12 的导出密码
#   KEYCHAIN_PASSWORD            仅 CI 内使用的临时钥匙串密码，随便设一个强密码即可
#   APPLE_SIGNING_IDENTITY       签名身份；不填则从导入的钥匙串里自动取出
#   APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID
#                                Apple 账号邮箱 / App 专用密码 / Team ID，三者齐备才会公证

set -euo pipefail

if [ -z "${APPLE_CERTIFICATE:-}" ]; then
  echo "未配置 APPLE_CERTIFICATE，跳过 macOS 签名与公证：本次产出的 .app / .dmg 为未签名。"
  echo "需要签名请按 README 的「代码签名」一节添加 Secrets。"
  exit 0
fi

KEYCHAIN_NAME="octopuses-signing.keychain-db"
# 未提供钥匙串密码时随机生成：本钥匙串只存在于本次 CI 运行期间，用完即随运行器销毁，
# 不需要跨次复用，因此随机值不会带来任何额外要求。
KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-$(openssl rand -hex 24)}"
P12_PATH="$(mktemp -t octopuses-signing).p12"

# 先落盘成 .p12 再导入：security import 只认文件，不认标准输入。
# 用 openssl 而非 base64 解码：macOS 自带 base64 与 GNU 版的参数名不一致（-D / --decode），
# openssl 的行为在 macOS 与 Linux 上一致，且默认就会忽略换行。
printf '%s\n' "$APPLE_CERTIFICATE" | openssl base64 -d -out "$P12_PATH"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security set-keychain-settings -t 3600 -u "$KEYCHAIN_NAME"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security import "$P12_PATH" -k "$KEYCHAIN_NAME" -P "${APPLE_CERTIFICATE_PASSWORD:-}" -T /usr/bin/codesign
# 不加这一句，codesign 访问私钥时会弹图形授权框，在无头环境里直接失败。
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME" >/dev/null
rm -f "$P12_PATH"

# 把临时钥匙串并进搜索列表（保留原有的），否则 sign 工具找不到刚导入的身份。
EXISTING_KEYCHAINS="$(security list-keychains -d user | tr -d ' \"')"
# shellcheck disable=SC2086  # 这里需要按空白拆成多个钥匙串名，不能加引号
security list-keychains -d user -s "$KEYCHAIN_NAME" $EXISTING_KEYCHAINS

# 身份不写死在脚本里：要么用显式提供的，要么从刚导入的钥匙串里取第一个可用身份。
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  IDENTITY="$APPLE_SIGNING_IDENTITY"
else
  IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN_NAME" | awk -F'"' '/"/ { print $2; exit }')"
fi

if [ -z "$IDENTITY" ]; then
  echo "::error::证书已解码导入，但钥匙串里找不到可用的代码签名身份——请确认 .p12 里含私钥且是 Developer ID Application 证书。"
  exit 1
fi

echo "已导入签名身份：$IDENTITY"

# $GITHUB_ENV 的值会传给后续所有步骤，这是让下一段的构建步骤拿到签名身份的唯一途径。
# 只导出身份与公证凭据，**不导出 APPLE_CERTIFICATE**——证书已进钥匙串，
# 再导出会让 Tauri 以为自己还要建一个临时钥匙串，反而多绕一圈。
{
  echo "APPLE_SIGNING_IDENTITY=$IDENTITY"
  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    echo "APPLE_ID=$APPLE_ID"
    echo "APPLE_PASSWORD=$APPLE_PASSWORD"
    echo "APPLE_TEAM_ID=$APPLE_TEAM_ID"
    echo "公证凭据齐备，构建后将自动提交 Apple 公证。"
  else
    echo "仅有签名证书、缺少 APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID，本次只签名、不公证（分发时仍会被 Gatekeeper 拦）。"
  fi
} >> "$GITHUB_ENV"