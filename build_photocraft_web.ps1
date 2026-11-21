$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$source     = Join-Path $pluginRoot "photocraft\apps\photocraft-web"
$output     = Join-Path $pluginRoot "web\photocraft"

# ---------------------------------------------------------------
# 0) 已经有可用的前端包（web\photocraft\index.html 存在）就直接跳过编译
#    PhotoCraft 的 ComfyUI 插件加载的是 web\photocraft\index.html，
#    只有这个文件在，节点才认为“已构建”，才不会弹提示。
# ---------------------------------------------------------------
$entry = Join-Path $output "index.html"
if (Test-Path $entry) {
    Write-Host "[跳过] 已检测到已构建的前端包：$entry"
    Write-Host "        如需强制重新编译，请先删除 web\photocraft 目录。"
    exit 0
}

# ---------------------------------------------------------------
# 1) 定位 trunk（PATH 里没有就回退到 cargo 的 bin 目录）
# ---------------------------------------------------------------
$trunk = $null
$cmd = Get-Command trunk -ErrorAction SilentlyContinue
if ($cmd) {
    $trunk = $cmd.Source
} else {
    $candidate = Join-Path $env:USERPROFILE ".cargo\bin\trunk.exe"
    if (Test-Path $candidate) { $trunk = $candidate }
}

Write-Host "[信息] ComfyUI 插件已发布预构建前端包时，无需本地编译。"
if (-not $trunk) {
    Write-Host ""
    Write-Host "[提示] 未找到 trunk，无法执行源码编译。" -ForegroundColor Yellow
    Write-Host "       推荐做法：直接下载官方预构建包 photocraft-web-<版本>.zip"
    Write-Host "       解压后把里面的内容全部放到： web\photocraft\  （index.html 必须直接在 photocraft 下）"
    Write-Host "       下载地址： https://github.com/Storytold/photocraft/releases"
    exit 1
}

Write-Host "[信息] 使用 trunk：$trunk"
if (-not (Test-Path (Join-Path $source "Trunk.toml"))) {
    throw "找不到 $source\Trunk.toml，photocraft 源码不完整。请改用预构建包放到 web\photocraft\。"
}

# ---------------------------------------------------------------
# 2) 编译（Trunk.toml 所在目录才是正确的工作目录）
# ---------------------------------------------------------------
Push-Location $source
try {
    & $trunk build --release

    # trunk 默认输出在 workspace 根的 dist\web，这里做两层兜底
    $dist = Join-Path $source "..\..\dist\web"
    if (-not (Test-Path $dist)) { $dist = Join-Path $source "..\..\dist" }
    if (-not (Test-Path $dist)) {
        throw "编译完成但没有找到 dist 输出目录（已尝试 photocraft\dist\web 与 photocraft\dist）"
    }

    New-Item -ItemType Directory -Force -Path $output | Out-Null
    Copy-Item -Path (Join-Path $dist "*") -Destination $output -Recurse -Force
    Write-Host "[完成] 已输出到 $output"
} finally {
    Pop-Location
}
