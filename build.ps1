# build.ps1
# Builds MoonlightNaCl.wgt with Docker and copies it into this folder.
# Requirement: Docker Desktop is installed and running.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Building Docker image (first build takes a while)..."
docker build -t moonlight-tizen-nacl-build .
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

$id = docker create moonlight-tizen-nacl-build
try {
    docker cp "${id}:/home/moonlight/MoonlightNaCl.wgt" ".\MoonlightNaCl.wgt"
    if ($LASTEXITCODE -ne 0) { throw "could not copy MoonlightNaCl.wgt out of the image" }
} finally {
    docker rm $id | Out-Null
}

Write-Host ""
Write-Host "Done: $PSScriptRoot\MoonlightNaCl.wgt"
Write-Host "Install it with Apps2Samsung -> Custom WGT File."
