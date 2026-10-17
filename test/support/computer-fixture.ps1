param([string]$Directory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class FoundationFixtureForm : Form {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 public struct POINT { public int X,Y; }
 protected override bool ShowWithoutActivation { get { return true; } }
}
'@ -ReferencedAssemblies System.Windows.Forms
$previous=[FoundationFixtureForm]::GetForegroundWindow()
$point=New-Object FoundationFixtureForm+POINT
[FoundationFixtureForm]::GetCursorPos([ref]$point) | Out-Null
$form=New-Object FoundationFixtureForm
$form.Text='Agent Foundation isolated control test';$form.Name='foundation_fixture'
$form.StartPosition='Manual';$form.Location=New-Object System.Drawing.Point(80,80);$form.Size=New-Object System.Drawing.Size(460,450)
$editor=New-Object System.Windows.Forms.TextBox
$editor.Name='fixture_editor';$editor.AccessibleName='Fixture editor';$editor.Location=New-Object System.Drawing.Point(20,25);$editor.Width=350
$password=New-Object System.Windows.Forms.TextBox
$password.Name='fixture_password';$password.AccessibleName='Fixture password';$password.UseSystemPasswordChar=$true;$password.Text='fixture-secret'
$password.Location=New-Object System.Drawing.Point(20,65);$password.Width=350
$button=New-Object System.Windows.Forms.Button
$button.Name='fixture_commit';$button.Text='Commit fixture';$button.Location=New-Object System.Drawing.Point(20,110);$button.Width=150
$check=New-Object System.Windows.Forms.CheckBox
$check.Name='fixture_check';$check.Text='Fixture option';$check.Location=New-Object System.Drawing.Point(190,110);$check.Width=150
$list=New-Object System.Windows.Forms.ListBox
$list.Name='fixture_list';$list.Location=New-Object System.Drawing.Point(20,155);$list.Size=New-Object System.Drawing.Size(150,100)
$list.Items.AddRange(@('Choice Alpha','Choice Beta'))
$tree=New-Object System.Windows.Forms.TreeView
$tree.Name='fixture_tree';$tree.Location=New-Object System.Drawing.Point(190,155);$tree.Size=New-Object System.Drawing.Size(180,100)
$root=$tree.Nodes.Add('Fixture branch');$root.Nodes.Add('Fixture child') | Out-Null
$panel=New-Object System.Windows.Forms.Panel
$panel.Name='fixture_panel';$panel.Location=New-Object System.Drawing.Point(20,280);$panel.Size=New-Object System.Drawing.Size(380,100)
$panel.BorderStyle='FixedSingle';$panel.AutoScroll=$true;$panel.AutoScrollMinSize=New-Object System.Drawing.Size(0,800)
$script:clicks=0;$script:downs=0;$script:ups=0;$script:wheel=0
function Save-State {
 $state=@{text=$editor.Text;clicks=$script:clicks;checked=$check.Checked;selected=$list.SelectedIndex;expanded=$root.IsExpanded;downs=$script:downs;ups=$script:ups;wheel=$script:wheel}
 [IO.File]::WriteAllText((Join-Path $Directory 'state.json'),($state|ConvertTo-Json -Compress))
}
$editor.Add_TextChanged({Save-State})
$button.Add_Click({$script:clicks++;Save-State})
$check.Add_CheckedChanged({Save-State})
$list.Add_SelectedIndexChanged({Save-State})
$tree.Add_AfterExpand({Save-State});$tree.Add_AfterCollapse({Save-State})
$panel.Add_MouseDown({$script:downs++;Save-State});$panel.Add_MouseUp({$script:ups++;Save-State})
$panel.Add_MouseWheel({param($sender,$eventArgs) $script:wheel+=$eventArgs.Delta;Save-State})
$form.Controls.AddRange(@($editor,$password,$button,$check,$list,$tree,$panel))
$form.Add_Shown({
 [IO.File]::WriteAllText((Join-Path $Directory 'ready.json'),(@{windowId=$form.Handle.ToInt64().ToString();processId=$PID}|ConvertTo-Json -Compress))
 Save-State
})
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=100
$timer.Add_Tick({if(Test-Path -LiteralPath (Join-Path $Directory 'close')){$form.Close()}else{Save-State}})
$timer.Start()
try { [System.Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose();$form.Dispose();[FoundationFixtureForm]::SetForegroundWindow($previous)|Out-Null;[FoundationFixtureForm]::SetCursorPos($point.X,$point.Y)|Out-Null }
