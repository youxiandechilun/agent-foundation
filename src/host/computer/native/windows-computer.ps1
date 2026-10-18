param([string]$Payload)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $Payload) { $Payload = [Console]::In.ReadToEnd() }
$request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -Path (Join-Path $PSScriptRoot 'windows-computer.cs') -ReferencedAssemblies @('System.Windows.Forms','System.Drawing','UIAutomationClient','UIAutomationTypes','WindowsBase')
[FoundationDesktop]::SetProcessDPIAware() | Out-Null
$window = [IntPtr]::Zero
if ($request.windowId) { $window = [FoundationDesktop]::Target([string]$request.windowId,[int]$request.processId) }
$result = @{ ok=$true; action=$request.action }
switch ($request.action) {
 'windows' { $result.windows = @([FoundationDesktop]::Windows([int]$request.limits.maxElements,[int[]]@($request.allowedProcessIds))) }
 'tree' { $result.elements = @([FoundationDesktop]::Tree($window,[int]$request.limits.maxElements,[int]$request.limits.maxDepth)); $result.bounded=$true }
 'screenshot' { [FoundationDesktop]::Capture($window,[string]$request.output,[int]$request.limits.maxCapturePixels) }
 'focus' { [FoundationDesktop]::Focus($window) }
 { $_ -in @('set_value','invoke','toggle','select','expand','collapse') } { [FoundationDesktop]::Pattern($window,[string]$request.elementId,[string]$request.action,[string]$request.text,[int]$request.limits.maxElements,[int]$request.limits.maxDepth) }
 { $_ -in @('move','click','drag','scroll') } { [FoundationDesktop]::Pointer($window,[string]$request.action,[int]$request.x,[int]$request.y,[int]$request.toX,[int]$request.toY,[string]$request.button,[int]$request.delta) }
 'type' { [FoundationDesktop]::Text($window,[string]$request.text) }
 'key' { [FoundationDesktop]::Keys($window,[string]$request.key) }
 'inspect' { }
 default { throw 'Unsupported computer action' }
}
if ($window -ne [IntPtr]::Zero) { $result.window = [FoundationDesktop]::Window($window) }
$bounds=[System.Windows.Forms.SystemInformation]::VirtualScreen
$point=New-Object FoundationDesktop+POINT
[FoundationDesktop]::GetCursorPos([ref]$point) | Out-Null
$result.width=$bounds.Width; $result.height=$bounds.Height; $result.left=$bounds.Left; $result.top=$bounds.Top
$result.cursor=@{x=$point.X;y=$point.Y}
$result.foregroundTitle=[FoundationDesktop]::Title([FoundationDesktop]::GetForegroundWindow())
$result | ConvertTo-Json -Depth 15 -Compress
