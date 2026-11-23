$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

docker compose stop gateway app
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the containerized application.' }
docker compose -f compose.yaml -f compose.local.yaml up -d --wait database
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not become ready.' }

# Reuse the same database and encryption key; never print or copy secret values.
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '15432'
$env:PGUSER = 'mpu_runtime'
$env:PGDATABASE = 'mpu'
$env:DATABASE_PASSWORD_FILE = Join-Path (Get-Location) '.secrets/postgres_app_password'
$env:DATABASE_SCHEMA = 'desk'
$env:INDODAX_STOP_SCHEMA = 'indodax_stops'
$env:CREDENTIAL_MASTER_KEY_FILE = Join-Path (Get-Location) '.secrets/indodax_master_key'
$env:INDODAX_MASTER_KEY_FILE = $env:CREDENTIAL_MASTER_KEY_FILE
$env:DATABASE_URL = ''
$env:MPU_STATIC_WEB_DIR = ''
$env:HOST = '127.0.0.1'
$env:PORT = '8787'
$env:WEB_PORT = '5173'
$env:TRADING_MODE = 'PAPER'
$env:AUTO_TRADING = 'off'

Write-Host 'Trading Agent Mpu Gandring: local app, PostgreSQL 18 in Docker.'
Write-Host 'Office: http://127.0.0.1:5173 | API: http://127.0.0.1:8787/api/health'
Write-Host 'Codex CLI and Claude Code use the Windows user PATH and native sign-in.'
npm.cmd run dev
exit $LASTEXITCODE
