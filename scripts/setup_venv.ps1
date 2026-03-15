# DEW Eco Warden - Create Python virtual environment and install dependencies
# Run from project root: .\scripts\setup_venv.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$venvPath = Join-Path $root "venv"

if (Test-Path $venvPath) {
    Write-Host "venv already exists at $venvPath"
} else {
    Write-Host "Creating virtual environment at $venvPath ..."
    python -m venv $venvPath
}

$activate = Join-Path $venvPath "Scripts\Activate.ps1"
if (-not (Test-Path $activate)) {
    $activate = Join-Path $venvPath "bin\activate"
}
Write-Host "Activate with: .\venv\Scripts\Activate.ps1 (Windows) or source venv/bin/activate (Linux/Mac)"
Write-Host "Installing dependencies from requirements.txt ..."
& (Join-Path $venvPath "Scripts\pip.exe") install -r (Join-Path $root "requirements.txt")
Write-Host "Done. Use '.\venv\Scripts\Activate.ps1' then run your Python scripts."
