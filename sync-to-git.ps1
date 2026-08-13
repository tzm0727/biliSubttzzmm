# biliSub 开发工作流脚本：把源码从工作目录同步到 Git 仓库并（可选）提交推送
#
# 用法（在 PowerShell 中运行）：
#   .\sync-to-git.ps1                          # 仅同步文件到 Git 仓库目录，不提交
#   .\sync-to-git.ps1 -Message "更新说明"      # 同步 + git commit
#   .\sync-to-git.ps1 -Message "更新说明" -Push # 同步 + commit + push（触发 Render 自动部署）
#   .\sync-to-git.ps1 -NoCommit                # 明确只同步、不提交（默认行为）
#
# 同步规则：排除 node_modules / .npm-cache / .git / server-config.json / 日志 / 隧道工具，
#           与 .gitignore 保持一致，避免把密钥和依赖推到 GitHub。

param(
  [string]$Message = "",
  [switch]$Push,
  [switch]$NoCommit
)

$ErrorActionPreference = "Stop"

# 源目录 = 本脚本所在目录（即 biliSub-cloud-package）
$Src = $PSScriptRoot

# 目标 Git 仓库目录（按需修改）
$Dst = "D:\deepseek_h_pro\biliSubttzzmm"

if (-not (Test-Path $Dst)) {
  Write-Host "[错误] 目标 Git 仓库目录不存在：$Dst" -ForegroundColor Red
  Write-Host "       请修改脚本顶部的 `$Dst 变量为你的 Git 仓库实际路径。" -ForegroundColor Red
  exit 1
}

# 需要排除的目录与文件（与 .gitignore 保持一致）
$excludeDirs = @("node_modules", ".npm-cache", ".git")
$excludeFiles = @("server-config.json", "*.log", "cloudflared.exe", "当前手机链接.txt", "启动biliSub.bat", "start-server.bat", "start-tunnel.bat")

Write-Host "同步源码：" -ForegroundColor Cyan
Write-Host "  源：$Src"
Write-Host "  目标：$Dst"

$xd = ($excludeDirs | ForEach-Object { "/XD `"$_`"" }) -join " "
$xf = ($excludeFiles | ForEach-Object { "/XF `"$_`"" }) -join " "

$robocopyArgs = "`"$Src`" `"$Dst`" /E $xd $xf /NFL /NDL /NJH /NJS /NP"
$exit = 0
try {
  Invoke-Expression "robocopy $robocopyArgs" | Out-Null
  $exit = $LASTEXITCODE
} catch {
  Write-Host "[错误] robocopy 执行失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# robocopy 退出码：0=无变化 1=已复制 2=有额外 3=1+2 4=不匹配 5=4+1 6=4+2 7=4+1+2；>=8 为错误
if ($exit -ge 8) {
  Write-Host "[错误] robocopy 同步失败（退出码 $exit）。" -ForegroundColor Red
  exit 1
}
Write-Host "[完成] 文件已同步（robocopy 退出码 $exit）。" -ForegroundColor Green

if ($NoCommit) {
  Write-Host "已按 -NoCommit 跳过 git 提交。" -ForegroundColor Yellow
  exit 0
}
if ($Message -eq "") {
  Write-Host "未提供 -Message，仅同步、不提交。如需提交请加 -Message 参数。" -ForegroundColor Yellow
  exit 0
}

# 进入 Git 仓库目录执行提交
Push-Location $Dst
try {
  git add -A
  if ($LASTEXITCODE -ne 0) { throw "git add 失败" }

  git commit -m $Message
  if ($LASTEXITCODE -ne 0) {
    # 没有改动时会以非零退出，不算错误
    Write-Host "[提示] git commit 无改动或失败，请检查输出。" -ForegroundColor Yellow
    Pop-Location
    exit 0
  }

  Write-Host "[完成] 已提交：$Message" -ForegroundColor Green

  if ($Push) {
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw "git push 失败" }
    Write-Host "[完成] 已推送到 origin/main，Render 将自动重新部署（1~3 分钟）。" -ForegroundColor Green
  } else {
    Write-Host "未加 -Push，已提交但未推送。推送请加 -Push。" -ForegroundColor Yellow
  }
} catch {
  Write-Host "[错误] $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Pop-Location
}
