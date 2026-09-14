# Genshin Build Checker CLI wrapper.
#   .\gbc.ps1 characters
#   .\gbc.ps1 guide furina
#   .\gbc.ps1 enka 815634265
#   .\gbc.ps1 check 815634265 xiao --er faruzan
#   .\gbc.ps1 check-manual hu-tao --cr 70 --cd 200 --er 110 --em 100
#   .\gbc.ps1 assess 815634265 xiao --llm
#   .\gbc.ps1 damage 815634265 xiao --team furina,faruzan,xianyun [--no-llm] [--reaction vaporize]

$ErrorActionPreference = "Stop"

# pastikan docker di PATH (Docker Desktop per-user install)
$dockerBin = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin"
if ((Test-Path $dockerBin) -and ($env:Path -notlike "*$dockerBin*")) {
  $env:Path += ";$dockerBin"
}

Push-Location $PSScriptRoot
try {
  # nyalain container kalau belum jalan
  $running = docker compose ps --status running --services 2>$null
  if ($running -notcontains "backend") {
    Write-Host "[gbc] menyalakan container..." -ForegroundColor Yellow
    docker compose up -d | Out-Null
    Start-Sleep -Seconds 3
  }
  docker compose exec -T backend npm run cli --silent -- @args
}
finally {
  Pop-Location
}
