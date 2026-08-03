!macro customRemoveFiles
  StrCpy $R8 "0"

  IfFileExists "$INSTDIR.__trade_watch_data_preserved\*.*" 0 tw_no_stale_data
    Abort "检测到上次未完成的数据保护目录：$INSTDIR.__trade_watch_data_preserved。请先保留该目录并联系支持。"

  tw_no_stale_data:
  IfFileExists "$INSTDIR\data\*.*" 0 tw_data_moved
    ClearErrors
    Rename "$INSTDIR\data" "$INSTDIR.__trade_watch_data_preserved"
    IfErrors 0 +2
      Abort "无法保护本地数据目录，已停止更新或卸载。"
    StrCpy $R8 "1"

  tw_data_moved:
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"
      Push ""
      Call un.restoreFiles
      Pop $R0
      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}
  ${endif}

  RMDir /r "$INSTDIR"

  StrCmp $R8 "1" 0 tw_data_restored
    CreateDirectory "$INSTDIR"
    ClearErrors
    Rename "$INSTDIR.__trade_watch_data_preserved" "$INSTDIR\data"
    IfErrors 0 tw_data_restored
      Abort "程序文件已处理，但本地数据仍安全保存在：$INSTDIR.__trade_watch_data_preserved"

  tw_data_restored:
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
        "是否同时删除本地数据库、配置和备份？默认选择“否”以保留数据。" \
        IDNO tw_keep_local_data
      RMDir /r "$INSTDIR\data"
      RMDir "$INSTDIR"
      tw_keep_local_data:
    ${endif}
  ${endif}
!macroend

