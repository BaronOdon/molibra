; Molibra Miner - Windows installer (Inno Setup 6).
;
; Built by installers\windows\build.ps1, which stages:
;   stage\runtime\   the OFFICIAL Node.js for Windows, hash-checked, untouched
;                    (node.exe keeps the OpenJS Foundation's own signature)
;   stage\app\       the Molibra source at one commit, with its dependencies
;   stage\molibra-miner.mjs   the supervisor
;
; ⛔ Antivirus is right to be wary of miners, so this does nothing clever:
; no hidden script host, no PowerShell, no second executable, no packing of
; our own. What runs is node.exe executing readable JavaScript. The scheduled
; task runs node.exe directly, as the user who installed it, never as SYSTEM.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define TaskName "Molibra Miner"

[Setup]
AppId={{6F0C3B2A-4D1E-4C8B-9E27-20226A11B0E1}
AppName=Molibra Miner
AppVersion={#AppVersion}
AppVerName=Molibra Miner {#AppVersion}
AppPublisher=Molibra
AppPublisherURL=https://molibra.org
AppSupportURL=https://molibra.org/download
DefaultDirName={localappdata}\Molibra
DisableDirPage=yes
DisableProgramGroupPage=yes
DefaultGroupName=Molibra Miner
; Administrator rights are needed ONCE: to register a task that starts at boot
; and keeps running after logoff (Task Scheduler "S4U" logon).
PrivilegesRequired=admin
UsedUserAreasWarning=no
OutputDir=..\dist
OutputBaseFilename=Molibra-Miner-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Molibra Miner
UninstallDisplayIcon={app}\Molibra Miner.exe
SetupIconFile=..\app\molibra.ico
CloseApplications=yes
SetupLogging=yes
VersionInfoCompany=Molibra
VersionInfoDescription=Molibra Miner installer
VersionInfoVersion={#AppVersion}
LicenseFile=..\..\LICENSE

[Files]
Source: "stage\runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs ignoreversion
Source: "stage\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs ignoreversion
Source: "stage\molibra-miner.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "stage\status.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "stage\Molibra Miner.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; "Molibra Miner" is the miner's own application window: native, not a browser.
; It starts the miner if it is not running, and shows why if it cannot.
Name: "{userdesktop}\Molibra Miner"; Filename: "{app}\Molibra Miner.exe"; WorkingDir: "{app}"; Comment: "Molibra Miner"
Name: "{group}\Molibra Miner"; Filename: "{app}\Molibra Miner.exe"; WorkingDir: "{app}"; Comment: "Molibra Miner"
Name: "{group}\Uninstall Molibra Miner"; Filename: "{uninstallexe}"

[Run]
; 1. the wallet: an address typed on the wallet page, or a new wallet
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\molibra-miner.mjs"" init {code:WalletArg}"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; StatusMsg: "Setting up your wallet..."
; 2. the always-on task (XML written by the supervisor, UTF-16 as schtasks wants), then start it now
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\molibra-miner.mjs"" taskxml"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated
Filename: "{sys}\schtasks.exe"; Parameters: "/Create /TN ""{#TaskName}"" /XML ""{app}\task.xml"" /F"; Flags: runhidden waituntilterminated; StatusMsg: "Registering Molibra Miner to start with Windows..."
Filename: "{sys}\schtasks.exe"; Parameters: "/Run /TN ""{#TaskName}"""; Flags: runhidden waituntilterminated
Filename: "{app}\Molibra Miner.exe"; WorkingDir: "{app}"; Description: "Open Molibra Miner"; Flags: postinstall nowait skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN ""{#TaskName}"" /F"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteTask"
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\molibra-miner.mjs"" stop"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "StopMiner"

[UninstallDelete]
; ⛔ MY-WALLET-KEEP-SECRET.txt and config.json are deliberately NOT removed:
; deleting a private key would destroy the MOLI it controls.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\app-new"
Type: filesandordirs; Name: "{app}\app-old"
Type: filesandordirs; Name: "{app}\data"
Type: filesandordirs; Name: "{app}\logs"
Type: files; Name: "{app}\task.xml"
Type: files; Name: "{app}\*.pid"
Type: files; Name: "{app}\install-summary.json"
Type: files; Name: "{app}\not-running.html"
; 1.0.0 put a browser shortcut on the desktop; remove it on upgrade or uninstall.
Type: files; Name: "{userdesktop}\Molibra Miner - Status.url"

[InstallDelete]
Type: files; Name: "{userdesktop}\Molibra Miner - Status.url"
Type: files; Name: "{group}\Molibra Miner - Status.url"

[Code]
var
  WalletPage: TInputQueryWizardPage;
  UpdatePage: TOutputMsgWizardPage;
  PrevVersion: String;
  ExistingWallet: String;

// The version already on this computer, if any: Inno records it under the
// app's uninstall key, which is the same key this setup will overwrite.
function InstalledVersion(): String;
var K: String;
begin
  Result := '';
  K := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F0C3B2A-4D1E-4C8B-9E27-20226A11B0E1}_is1';
  if not RegQueryStringValue(HKLM64, K, 'DisplayVersion', Result) then
    if not RegQueryStringValue(HKLM32, K, 'DisplayVersion', Result) then
      RegQueryStringValue(HKCU, K, 'DisplayVersion', Result);
end;

// The wallet an earlier install already mines to, read from its config.json.
function ReadExistingWallet(): String;
var S: AnsiString; P: Integer;
begin
  Result := '';
  if LoadStringFromFile(ExpandConstant('{localappdata}\Molibra\config.json'), S) then begin
    P := Pos('"miner": "', String(S));
    if P > 0 then Result := Copy(String(S), P + 10, 42);
    if Copy(Result, 1, 2) <> '0x' then Result := '';
  end;
end;

function IsHexChar(C: Char): Boolean;
begin
  Result := ((C >= '0') and (C <= '9')) or ((C >= 'a') and (C <= 'f')) or ((C >= 'A') and (C <= 'F'));
end;

function IsAddress(S: String): Boolean;
var I: Integer;
begin
  Result := (Length(S) = 42) and (Copy(S, 1, 2) = '0x');
  if Result then
    for I := 3 to 42 do
      if not IsHexChar(S[I]) then begin Result := False; Exit; end;
end;

procedure InitializeWizard;
begin
  PrevVersion := InstalledVersion();
  ExistingWallet := ReadExistingWallet();
  // ⛔ An update must SAY it is an update: the person already has a miner,
  //    and must not wonder whether they are installing a second one.
  if PrevVersion <> '' then
    UpdatePage := CreateOutputMsgPage(wpWelcome,
      'Update Molibra Miner',
      'Molibra Miner ' + PrevVersion + ' is already installed on this computer.',
      'Setup will UPDATE it from version ' + PrevVersion + ' to version {#AppVersion}.' + #13#10#13#10 +
      'Your wallet, your settings, your mined MOLI and the chain already downloaded are all kept.' + #13#10 +
      'The miner stops for a moment while it is updated, then starts again by itself.' + #13#10#13#10 +
      'From this version on, Molibra Miner updates itself automatically - you will not need to do this again.');
  WalletPage := CreateInputQueryPage(wpLicense,
    'Where should your MOLI go?',
    'Your mining rewards are paid to a wallet address.',
    'Paste a wallet address that starts with 0x (for example from MetaMask).' + #13#10#13#10 +
    'No wallet yet? Leave this empty and a new one will be created for you. Its secret key will be ' +
    'saved in a file on this computer, and you will be shown where.');
  WalletPage.Add('Wallet address (optional):', False);
  // A scripted or managed install can name the wallet: Molibra-Miner-Setup.exe /WALLET=0x...
  WalletPage.Values[0] := ExpandConstant('{param:WALLET|}');
end;

// A wallet already set is kept; asking again would only invite a mistake.
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = WalletPage.ID) and (ExistingWallet <> '');
end;

// ⛔ Stop the running miner BEFORE files are replaced: its node.exe is in use
//    and Windows would refuse to overwrite it halfway through the update.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer; App: String;
begin
  Result := '';
  App := ExpandConstant('{localappdata}\Molibra');
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN "{#TaskName}"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  if FileExists(App + '\runtime\node.exe') and FileExists(App + '\molibra-miner.mjs') then
    Exec(App + '\runtime\node.exe', '"' + App + '\molibra-miner.mjs" stop', App, SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(2000);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var A: String;
begin
  Result := True;
  if CurPageID = WalletPage.ID then begin
    A := Trim(WalletPage.Values[0]);
    WalletPage.Values[0] := A;
    if (A <> '') and not IsAddress(A) then begin
      MsgBox('That is not a wallet address. It should be 0x followed by 40 letters and numbers.' + #13#10 +
             'Leave the box empty to create a new wallet instead.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function WalletArg(Param: String): String;
begin
  Result := Trim(WalletPage.Values[0]);
  // ⛔ Checked again here, because a silent install never shows the page that
  //    validates it: a malformed /WALLET= must not reach the command line.
  if (Result <> '') and not IsAddress(Result) then Result := '';
end;

function JsonField(Json, Name: String): String;
var P: Integer; Rest: String;
begin
  Result := '';
  P := Pos('"' + Name + '":', Json);
  if P = 0 then Exit;
  Rest := Copy(Json, P + Length(Name) + 3, 400);
  if Copy(Rest, 1, 1) = '"' then begin
    Rest := Copy(Rest, 2, 400);
    Result := Copy(Rest, 1, Pos('"', Rest) - 1);
  end else
    Result := Copy(Rest, 1, 4);
  StringChangeEx(Result, '\\', '\', True);
end;

// Tell the person, on the last page, where their MOLI goes - and, if a wallet
// was created, where its key is. That is the one thing they must not miss.
procedure CurPageChanged(CurPageID: Integer);
var S: AnsiString; Miner, WalletFile: String;
begin
  if CurPageID = wpFinished then begin
    if LoadStringFromFile(ExpandConstant('{app}\install-summary.json'), S) then begin
      Miner := JsonField(String(S), 'miner');
      WalletFile := JsonField(String(S), 'walletFile');
      if Pos('true', JsonField(String(S), 'created')) = 1 then
        WizardForm.FinishedLabel.Caption :=
          'Molibra Miner is running in the background. It starts with Windows and keeps going after you log off.' + #13#10#13#10 +
          'A NEW WALLET was created for you:' + #13#10 + Miner + #13#10#13#10 +
          'Its secret key is saved in:' + #13#10 + WalletFile + #13#10 +
          'BACK UP THAT FILE. If it is lost, the MOLI in the wallet is lost with it.' + #13#10#13#10 +
          'The first start downloads the chain (about 30 to 60 minutes). Mining begins by itself after that. ' +
          'The Molibra Miner window opens now; the "Molibra Miner" icon on your desktop brings it back.'
      else if PrevVersion <> '' then
        WizardForm.FinishedLabel.Caption :=
          'Molibra Miner was UPDATED from version ' + PrevVersion + ' to version {#AppVersion}.' + #13#10#13#10 +
          'It is running again in the background, mining to the same wallet:' + #13#10 + Miner + #13#10#13#10 +
          'Nothing else changed: your wallet, settings and downloaded chain were kept. ' +
          'From now on it updates itself automatically.' + #13#10#13#10 +
          'The Molibra Miner window opens now; the "Molibra Miner" icon on your desktop brings it back.'
      else
        WizardForm.FinishedLabel.Caption :=
          'Molibra Miner is running in the background. It starts with Windows and keeps going after you log off.' + #13#10#13#10 +
          'Your MOLI goes to:' + #13#10 + Miner + #13#10#13#10 +
          'The first start downloads the chain (about 30 to 60 minutes). Mining begins by itself after that. ' +
          'The Molibra Miner window opens now; the "Molibra Miner" icon on your desktop brings it back.';
      WizardForm.FinishedLabel.AutoSize := False;
      WizardForm.FinishedLabel.Height := ScaleY(230);
    end;
  end;
end;
