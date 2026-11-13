# Windows 代码签名证书导入（CI 用）
#
# 作用：把仓库 Secrets 里的 .pfx 证书解码并导入 Windows 证书存储，再把指纹交给
# Tauri，由它调用 signtool 给 exe 与安装包签名。
#
# 关键约定：**没有配置证书时也照样产出一份配置，只是内容是空 patch**。
# 这样构建命令可以恒定写成 `--config $env:TAURI_SIGN_CONFIG`，
# 不必在「已签 / 未签」两种状态下走不同的分支——少一处分支就少一处出错的地方。
#
# 需要的 Secrets（全部可选；不配就是不出签名）：
#   WINDOWS_CERTIFICATE            base64 编码的 .pfx（含私钥）
#   WINDOWS_CERTIFICATE_PASSWORD   .pfx 的导出密码
#   WINDOWS_TIMESTAMP_URL          时间戳服务器，不填用 DigiCert 的公共地址

$ErrorActionPreference = "Stop"

$signConfig = "{}"

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE)) {
    Write-Host "未配置 WINDOWS_CERTIFICATE，跳过 Windows 签名：本次产出的安装包为未签名。"
    Write-Host "需要签名请按 README 的「代码签名」一节添加 Secrets。"
}
else {
    # 证书只在本次运行器上临时落盘，用完即删。
    $certDir = Join-Path $env:RUNNER_TEMP "octopuses-signing"
    New-Item -ItemType Directory -Path $certDir -Force | Out-Null
    $pfxPath = Join-Path $certDir "certificate.pfx"
    $b64Path = Join-Path $certDir "certificate.txt"

    Set-Content -Path $b64Path -Value $env:WINDOWS_CERTIFICATE -Encoding ascii
    certutil -decode $b64Path $pfxPath | Out-Null
    Remove-Item -Path $b64Path -Force

    $password = ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PASSWORD -Force -AsPlainText
    $imported = Import-PfxCertificate -FilePath $pfxPath -CertStoreLocation Cert:\CurrentUser\My -Password $password
    Remove-Item -Path $pfxPath -Force

    # 指纹从「刚导入的这张证书」上读，而不是扫整个证书存储挑一张——
    # 挑法（取最新、取某个名字）一旦换证书就会悄悄选错，这里不给它这个机会。
    $signing = $imported | Where-Object { $_.HasPrivateKey } | Select-Object -First 1
    if (-not $signing) {
        throw "证书已导入，但其中没有带私钥的条目——请确认导出的 .pfx 含私钥。"
    }

    $timestampUrl = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }

    $signConfig = [ordered]@{
        bundle = [ordered]@{
            windows = [ordered]@{
                certificateThumbprint = $signing.Thumbprint
                digestAlgorithm       = "sha256"
                timestampUrl          = $timestampUrl
            }
        }
    } | ConvertTo-Json -Depth 5 -Compress

    Write-Host "已导入 Windows 签名证书，指纹 $($signing.Thumbprint)，时间戳服务 $timestampUrl"
}

# 单个 Assert 保证这是单行——$GITHUB_ENV 每行一个 KEY=VALUE，值里带换行会被截断。
if ($signConfig.Contains("`n")) {
    throw "签名配置必须是单行 JSON，实际含换行。"
}

Add-Content -Path $env:GITHUB_ENV -Value "TAURI_SIGN_CONFIG=$signConfig" -Encoding utf8