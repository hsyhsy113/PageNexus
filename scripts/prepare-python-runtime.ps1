$ErrorActionPreference = "Stop"

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$PyDir = Join-Path $RootDir "python"
$VenvDir = Join-Path $PyDir "venv"
$ReqFile = Join-Path $PyDir "requirements.txt"

Write-Host "Preparing Python runtime at $VenvDir"
if (Test-Path $VenvDir) {
  Remove-Item -Path $VenvDir -Recurse -Force
}

python -m venv $VenvDir

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
& $VenvPython -m pip install --upgrade pip wheel
& $VenvPython -m pip install -r $ReqFile

Write-Host "Python runtime prepared."
