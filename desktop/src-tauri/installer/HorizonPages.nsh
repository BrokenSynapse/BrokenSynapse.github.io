
Var HorizonSetupDialog
Var HorizonOptionsButton
Var HorizonDirectory
Var HorizonDirectoryError
Var HorizonBrowse
Var HorizonShortcut
Var HorizonLaunch
Var HorizonOptionsOpen
Var HorizonCreateShortcut
Var HorizonLaunchOnExit
Var HorizonInstalledVersion
Var HorizonUninstaller
Var HorizonPhaseWindow
Var HorizonProgressPanel
Var HorizonFinishDialog

Function HorizonChrome
  SetCtlColors $HWNDPARENT EFEAF2 242127
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 ${SW_HIDE}
FunctionEnd

Function HorizonSetup
  Call SkipIfPassive
  ReadRegStr $HorizonInstalledVersion SHCTX "${UNINSTKEY}" "DisplayVersion"
  nsDialogs::Create 1018
  Pop $HorizonSetupDialog
  ${IfThen} $HorizonSetupDialog == error ${|} Abort ${|}
  Call HorizonChrome
  SetCtlColors $HorizonSetupDialog EFEAF2 242127
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Install"
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}

  !insertmacro MUI_HEADER_TEXT "Horizon Chat ${VERSION}" "Windows x64"
  ${If} $HorizonInstalledVersion == ""
    StrCpy $1 "Install Horizon Chat for your Windows account."
  ${Else}
    StrCpy $1 "Horizon $HorizonInstalledVersion is installed. Your app data stays in place."
  ${EndIf}
  ${NSD_CreateLabel} 2u 8u -2u 22u "$1"
  Pop $0
  SetCtlColors $0 CFC6D1 242127

  ${NSD_CreateButton} 2u 38u 78u 14u "Installation options"
  Pop $HorizonOptionsButton
  ${NSD_OnClick} $HorizonOptionsButton HorizonToggleOptions
  ReadRegStr $HorizonUninstaller SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $HorizonInstalledVersion != ""
  ${AndIf} $HorizonUninstaller != ""
  ${AndIf} ${FileExists} "$HorizonUninstaller\uninstall.exe"
    ${NSD_CreateButton} 86u 38u 56u 14u "Uninstall"
    Pop $0
    ${NSD_OnClick} $0 HorizonOpenUninstaller
  ${EndIf}
  ${NSD_CreateText} 2u 60u -55u 14u "$INSTDIR"
  Pop $HorizonDirectory
  ${NSD_CreateButton} -53u 60u 51u 14u "Browse..."
  Pop $HorizonBrowse
  ${NSD_OnClick} $HorizonBrowse HorizonBrowseFolder
  ${NSD_CreateCheckbox} 2u 82u -2u 12u "Create a desktop shortcut"
  Pop $HorizonShortcut
  System::Call 'uxtheme::SetWindowTheme(p $HorizonShortcut,w "",w "")'
  SetCtlColors $HorizonShortcut EFEAF2 242127
  ${NSD_CreateCheckbox} 2u 100u -2u 12u "Launch Horizon after installation"
  Pop $HorizonLaunch
  System::Call 'uxtheme::SetWindowTheme(p $HorizonLaunch,w "",w "")'
  SetCtlColors $HorizonLaunch EFEAF2 242127
  ${NSD_Check} $HorizonLaunch
  ${If} $HorizonInstalledVersion != ""
    EnableWindow $HorizonDirectory 0
    EnableWindow $HorizonBrowse 0
  ${EndIf}
  StrCpy $HorizonOptionsOpen 1
  Call HorizonToggleOptions
  nsDialogs::Show
FunctionEnd

Function HorizonOpenUninstaller
  Pop $0 ; Clicked control handle.
  ClearErrors
  Exec '"$HorizonUninstaller\uninstall.exe"'
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Horizon could not open its uninstaller. Try Windows Settings under Installed apps."
    Return
  ${EndIf}
  Quit
FunctionEnd

Function HorizonToggleOptions
  ${If} $HorizonOptionsOpen = 1
    StrCpy $HorizonOptionsOpen 0
    StrCpy $0 ${SW_HIDE}
  ${Else}
    StrCpy $HorizonOptionsOpen 1
    StrCpy $0 ${SW_SHOW}
  ${EndIf}
  ShowWindow $HorizonDirectory $0
  ShowWindow $HorizonBrowse $0
  ShowWindow $HorizonShortcut $0
  ShowWindow $HorizonLaunch $0
FunctionEnd

Function HorizonBrowseFolder
  ${NSD_GetText} $HorizonDirectory $0
  nsDialogs::SelectFolderDialog "Choose Horizon's installation folder" "$0"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $HorizonDirectory "$0"
  ${EndIf}
FunctionEnd

Function HorizonValidateDirectory
  StrCpy $HorizonDirectoryError "Choose an absolute installation folder."
  ; Require a drive-qualified or UNC path before normalizing it.
  StrCpy $1 $0 2
  ${If} $1 != "\\"
    StrCpy $1 $0 2 1
    ${If} $1 != ":\"
    ${AndIf} $1 != ":/"
      Return
    ${EndIf}
  ${EndIf}

  ; Win32 normalization does not require the target folder to exist.
  System::Call 'kernel32::GetFullPathNameW(w r0,i ${NSIS_MAX_STRLEN},w .r2,p 0)i.r1'
  ${If} $1 = 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    Return
  ${EndIf}
  ${GetRoot} "$2" $1
  ${If} $1 == ""
    Return
  ${EndIf}
  ${If} $2 == "$1"
  ${OrIf} $2 == "$1\"
    StrCpy $HorizonDirectoryError "Choose a folder inside the drive."
    Return
  ${EndIf}
  StrCpy $0 $2
  StrCpy $HorizonDirectoryError ""
FunctionEnd

Function HorizonSetupLeave
  ${NSD_GetText} $HorizonDirectory $0
  Call HorizonValidateDirectory
  ${If} $HorizonDirectoryError != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "$HorizonDirectoryError"
    Abort
  ${EndIf}
  StrCpy $INSTDIR $0
  ${NSD_GetState} $HorizonShortcut $HorizonCreateShortcut
  ${NSD_GetState} $HorizonLaunch $HorizonLaunchOnExit
FunctionEnd

Function HorizonProgressShow
  Call HorizonChrome
  FindWindow $HorizonProgressPanel "#32770" "" $HWNDPARENT
  SetCtlColors $HorizonProgressPanel EFEAF2 242127
  GetDlgItem $HorizonPhaseWindow $HorizonProgressPanel 1006
  ${If} $HorizonPhaseWindow != 0
    SetCtlColors $HorizonPhaseWindow EFEAF2 242127
  ${EndIf}
  GetDlgItem $0 $HorizonProgressPanel 1004
  ${If} $0 != 0
    System::Call 'uxtheme::SetWindowTheme(p r0,w "",w "")'
    SendMessage $0 0x0409 0 0x005192EF
    SendMessage $0 0x2001 0 0x0039343C
    System::Call 'user32::GetDpiForWindow(p r0)i.r2'
    IntOp $2 $2 * 6
    IntOp $2 $2 / 96
    System::Call 'user32::GetWindowRect(p r0,*(i .r3,i .r4,i .r5,i .r6))i.r1'
    ${If} $1 != 0
      IntOp $5 $5 - $3
      System::Call 'user32::SetWindowPos(p r0,p 0,i 0,i 0,i r5,i r2,i 0x16)'
    ${EndIf}
  ${EndIf}
FunctionEnd

Function HorizonFinish
  Call SkipIfPassive
  nsDialogs::Create 1018
  Pop $HorizonFinishDialog
  ${IfThen} $HorizonFinishDialog == error ${|} Abort ${|}
  Call HorizonChrome
  SetCtlColors $HorizonFinishDialog EFEAF2 242127
  !insertmacro MUI_HEADER_TEXT "Horizon Chat is ready." "Installation complete"
  ${NSD_CreateLabel} 2u 34u -2u 14u "You can reopen Horizon from the Windows Start menu."
  Pop $0
  SetCtlColors $0 CFC6D1 242127
  ${NSD_CreateCheckbox} 2u 60u -2u 12u "Launch Horizon"
  Pop $HorizonLaunch
  System::Call 'uxtheme::SetWindowTheme(p $HorizonLaunch,w "",w "")'
  SetCtlColors $HorizonLaunch EFEAF2 242127
  ${NSD_SetState} $HorizonLaunch $HorizonLaunchOnExit
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Done"
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  nsDialogs::Show
FunctionEnd

Function HorizonFinishLeave
  ${NSD_GetState} $HorizonLaunch $0
  ${If} $0 == ${BST_CHECKED}
    Call RunMainBinary
  ${EndIf}
FunctionEnd
