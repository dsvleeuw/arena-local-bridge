# bootstrap-node.ps1 - get Node.js onto a Windows machine for install.bat.
#
# install.bat only calls this when it found no node.exe. Arguments never pass
# through this script: PowerShell treats "--" as an end-of-parameters marker and
# would strip the dashes from --email/--port, so the batch calls Node directly.
#
# Compatible with Windows PowerShell 5.1, which ships with Windows 10/11.
# Exit codes: 0 = a usable Node 20+ is available, 1 = it is not.

$ErrorActionPreference = "Stop"

function Find-Node {
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:ARENA_NODE_PATH) { $candidates.Add($env:ARENA_NODE_PATH) }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { $candidates.Add($command.Source) }
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles "nodejs\node.exe")) }
    if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")) }
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")) }
    $root = Split-Path -Parent $PSScriptRoot
    $candidates.Add((Join-Path $root "runtime\node.exe"))
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Get-NodeMajor([string]$Node) {
    try {
        $version = & $Node -p "process.versions.node.split('.')[0]" 2>$null
        return [int]$version
    } catch {
        return 0
    }
}

function Install-WithWinget {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { return }
    if ($env:ARENA_NO_PROMPT -ne "1") {
        try {
            $answer = Read-Host "    Install the current Node.js LTS with winget now? [Y/n]"
        } catch {
            # No console to ask on (a scheduled task, a pipe): do not install
            # software without an answer.
            return
        }
        if ($answer -match '^(n|no)$') { return }
    }
    & winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
    # winget's exit code is not the answer: "already installed" is also non-zero.
    # The paths Find-Node checks are. Refresh PATH for the install it just did.
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

$node = Find-Node
if (-not $node) {
    Write-Host "    Node.js 20 or newer was not found on this machine."
    Install-WithWinget
    $node = Find-Node
}
if (-not $node) {
    Write-Host "ERROR: Node.js 20 or newer is required."
    Write-Host "       Install it from https://nodejs.org/en/download (or run: winget install OpenJS.NodeJS.LTS)"
    Write-Host "       then run install.bat again."
    exit 1
}
$major = Get-NodeMajor $node
if ($major -lt 20) {
    Write-Host ("ERROR: Node.js 20 or newer is required; {0} is version {1}. Upgrade Node.js and run install.bat again." -f $node, $major)
    exit 1
}
Write-Host ("    node: {0} (major {1})" -f $node, $major)
exit 0
