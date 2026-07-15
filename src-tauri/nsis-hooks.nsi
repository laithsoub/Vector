; Tauri NSIS installer hooks
; ${__FILEDIR__} = src-tauri/ at NSIS compile time

!macro NSIS_HOOK_PREINSTALL
  ; WebView2Loader.dll is not auto-bundled by Tauri with the GNU toolchain
  SetOutPath "$INSTDIR"
  File "${__FILEDIR__}\..\..\WebView2Loader.dll"
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\WebView2Loader.dll"
!macroend
