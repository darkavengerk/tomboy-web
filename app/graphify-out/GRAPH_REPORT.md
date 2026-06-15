# Graph Report - app  (2026-06-15)

## Corpus Check
- 715 files · ~485,646 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2967 nodes · 4127 edges · 94 communities detected
- Extraction: 81% EXTRACTED · 19% INFERRED · 0% AMBIGUOUS · INFERRED: 768 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 90|Community 90]]
- [[_COMMUNITY_Community 92|Community 92]]
- [[_COMMUNITY_Community 94|Community 94]]
- [[_COMMUNITY_Community 97|Community 97]]
- [[_COMMUNITY_Community 98|Community 98]]
- [[_COMMUNITY_Community 99|Community 99]]
- [[_COMMUNITY_Community 100|Community 100]]
- [[_COMMUNITY_Community 101|Community 101]]
- [[_COMMUNITY_Community 104|Community 104]]
- [[_COMMUNITY_Community 115|Community 115]]
- [[_COMMUNITY_Community 125|Community 125]]
- [[_COMMUNITY_Community 129|Community 129]]
- [[_COMMUNITY_Community 130|Community 130]]
- [[_COMMUNITY_Community 131|Community 131]]
- [[_COMMUNITY_Community 133|Community 133]]
- [[_COMMUNITY_Community 153|Community 153]]
- [[_COMMUNITY_Community 172|Community 172]]
- [[_COMMUNITY_Community 175|Community 175]]
- [[_COMMUNITY_Community 176|Community 176]]
- [[_COMMUNITY_Community 177|Community 177]]
- [[_COMMUNITY_Community 198|Community 198]]

## God Nodes (most connected - your core abstractions)
1. `getDB()` - 32 edges
2. `setSetting()` - 30 edges
3. `createEmptyNote()` - 29 edges
4. `deserializeContent()` - 28 edges
5. `pushToast()` - 28 edges
6. `serializeContent()` - 22 edges
7. `addProseMirrorPlugins()` - 21 edges
8. `applyPlan()` - 20 edges
9. `formatTomboyDate()` - 19 edges
10. `getNote()` - 19 edges

## Surprising Connections (you probably didn't know these)
- `makeSlipNote()` --calls--> `createEmptyNote()`  [INFERRED]
  tests/unit/desktop/sessionReloadHooks.test.ts → src/lib/core/note.ts
- `docTitled()` --calls--> `deserializeContent()`  [INFERRED]
  tests/unit/core/rewriteBacklinksFlush.test.ts → src/lib/core/noteContentArchiver.ts
- `makeNote()` --calls--> `serializeContent()`  [INFERRED]
  tests/unit/schedule/dateNoteScheduleSeed.test.ts → src/lib/core/noteContentArchiver.ts
- `noteWithBody()` --calls--> `createEmptyNote()`  [INFERRED]
  tests/unit/core/backlinkIndexStoreIntegration.test.ts → src/lib/core/note.ts
- `makeNote()` --calls--> `createEmptyNote()`  [INFERRED]
  tests/unit/core/rewriteBacklinksForRename.test.ts → src/lib/core/note.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.03
Nodes (72): addInternalLinksForTitle(), note(), noteWithBody(), makeNote(), candidates(), countLinkSweep(), seed(), setNewNoteIntent() (+64 more)

### Community 1 - "Community 1"
Cohesion: 0.04
Nodes (92): roundTrip(), li(), makeNote(), noteDoc(), p(), ul(), applyLinkSweep(), deserializeContent() (+84 more)

### Community 2 - "Community 2"
Cohesion: 0.04
Nodes (87): for(), parseTomboyDate(), extractGuidFromUri(), extractTitleFromContent(), extractXmlContent(), guidFromFilename(), parseNote(), parseNoteFromFile() (+79 more)

### Community 3 - "Community 3"
Cohesion: 0.03
Nodes (58): onclose(), detachOpenNote(), centeredWindow(), clamp(), nextValidIndex(), windowWidth(), exitEdit(), flipWheel() (+50 more)

### Community 4 - "Community 4"
Cohesion: 0.03
Nodes (60): cancelRerun(), fetchTriggerStatus(), listDiaryPages(), normalizeBaseUrl(), pingTrigger(), requestRerun(), triggerPipelineRun(), uid() (+52 more)

### Community 5 - "Community 5"
Cohesion: 0.04
Nodes (63): resolveImageBlob(), bumpLastAccess(), clearAll(), getBlob(), getStats(), lookupOrFetch(), makeRoom(), prime() (+55 more)

### Community 6 - "Community 6"
Cohesion: 0.03
Nodes (42): collectListItemRewrites(), createAutoWeekdayPlugin(), findMonthForListItem(), findPrecedingMonth(), nodeFirstParagraphText(), backendOf(), createChatNotePlugin(), findSignature() (+34 more)

### Community 7 - "Community 7"
Cohesion: 0.04
Nodes (64): clearHomeNote(), getHomeNote(), getHomeNoteGuid(), setHomeNote(), clearScheduleNote(), getScheduleNoteGuid(), setScheduleNote(), clearWallpaper() (+56 more)

### Community 8 - "Community 8"
Cohesion: 0.04
Nodes (57): lineTexts(), baseType(), buildChartConfig(), isChartType(), applyToken(), num(), parseChartBlock(), parseChartHeader() (+49 more)

### Community 9 - "Community 9"
Cohesion: 0.04
Nodes (58): buildDecorations(), collectChecklistItems(), findChecklistItems(), findChecklistRegions(), isChecklistHeaderText(), applyChecklistMarkersOnParse(), applyListBoxMarkersOnParse(), applyProcessMarkersOnParse() (+50 more)

### Community 10 - "Community 10"
Cohesion: 0.05
Nodes (49): applyDataNoteCsv(), buildUpdatedDoc(), csvToParagraphs(), findDataBlockRegion(), paragraphText(), paragraphText(), parseDataNote(), applyEdit() (+41 more)

### Community 11 - "Community 11"
Cohesion: 0.05
Nodes (42): li(), para(), spec(), findLiPos(), li(), monthTexts(), para(), skip() (+34 more)

### Community 12 - "Community 12"
Cohesion: 0.04
Nodes (37): onClick(), getCurrentPositionAsync(), insertCurrentLocation(), toastForError(), if(), copyImageToClipboard(), copyImageUrlToClipboard(), isPlaylistHeader() (+29 more)

### Community 13 - "Community 13"
Cohesion: 0.06
Nodes (45): ClaudeChatError, sendClaude(), LlmChatError, RagSearchError, sendChat(), appendText(), buildClaudeMessages(), consolidateToSingleUser() (+37 more)

### Community 14 - "Community 14"
Cohesion: 0.05
Nodes (42): AutomationError, runAutomation(), fetchSunoPlaylist(), SunoError, enumeratePlaylist(), ExtractError, extractOne(), bytesToBase64() (+34 more)

### Community 15 - "Community 15"
Cohesion: 0.06
Nodes (34): clampAlpha(), clampChannel(), edgeStyle(), colorForLink(), haloRadiusFor(), handleCanvasClick(), linkEndpointId(), loop() (+26 more)

### Community 16 - "Community 16"
Cohesion: 0.07
Nodes (27): findPosAfter(), handleAltLeft(), handleAltRight(), selectRange(), insertTabAtCursor(), childAbsStart(), findOperationRange(), isInList() (+19 more)

### Community 17 - "Community 17"
Cohesion: 0.06
Nodes (29): defMatchOf(), appendDefinitionText(), buildFootnoteContext(), buildFootnoteMessages(), definitionsMatchingTrigger(), extractTrigger(), footnoteClaudeErrorMessage(), locateDefinition() (+21 more)

### Community 18 - "Community 18"
Cohesion: 0.06
Nodes (28): buildMetadataInit(), installMediaSession(), isMediaSessionSupported(), metaKey(), syncMediaSession(), meta(), installMusicAudio(), resumePlaybackFromGesture() (+20 more)

### Community 19 - "Community 19"
Cohesion: 0.08
Nodes (25): installImageFetchers(), registerFetcher(), getImageStorageToken(), getImagesPath(), classifyImageUrl(), loadImageInventory(), scanNotesForImages(), escapeUrlForXml() (+17 more)

### Community 20 - "Community 20"
Cohesion: 0.09
Nodes (24): noteToPlainText(), TomboySliceClipboardParser, buildClipboardHtml(), escapeAttr(), handleClipboardCopy(), handleClipboardCut(), sliceToDoc(), writeClipboard() (+16 more)

### Community 21 - "Community 21"
Cohesion: 0.08
Nodes (24): appendRunHistory(), applyChartNote(), buildChartNoteDoc(), listItem(), para(), getLocalCommand(), runMonthly(), runYearly() (+16 more)

### Community 22 - "Community 22"
Cohesion: 0.07
Nodes (12): openNoteByGuid(), centeredFor(), collectExistingGuids(), defaultGeometry(), emptyWorkspace(), ensurePersistFlushOnHide(), loadPersisted(), persistNow() (+4 more)

### Community 23 - "Community 23"
Cohesion: 0.09
Nodes (24): deriveName(), extractTrack(), firstUrlInNode(), listItemHead(), nestedListOf(), parseMusicNote(), trimTrailingPunct(), urls() (+16 more)

### Community 24 - "Community 24"
Cohesion: 0.09
Nodes (15): applyInRange(), expandToWordBoundary(), findTitleMatches(), isWordChar(), createTitleProvider(), doSharedRefresh(), ensureSubscribed(), ensureTitleIndexReady() (+7 more)

### Community 25 - "Community 25"
Cohesion: 0.09
Nodes (13): roles(), assignColumns(), computeGridStyles(), formatFr(), assignSections(), buildFoldDecorations(), createHrFoldPlugin(), reconcileFoldedAgainstDoc() (+5 more)

### Community 26 - "Community 26"
Cohesion: 0.08
Nodes (8): lastToastMessage(), BearerError, requireBearer(), requireBearerOrResponse(), GET(), list(), AuthError, DELETE()

### Community 27 - "Community 27"
Cohesion: 0.15
Nodes (17): paragraphText(), parseRemarkableUploadNote(), parseRemarkableUploadTitle(), buildDecorations(), createRemarkableNotePlugin(), docJson(), bodyInsertPos(), dateStamp() (+9 more)

### Community 28 - "Community 28"
Cohesion: 0.13
Nodes (4): KeysWsClient, appendWsPath(), bridgeToWsUrl(), TerminalWsClient

### Community 29 - "Community 29"
Cohesion: 0.14
Nodes (2): findPosAfter(), selectRange()

### Community 30 - "Community 30"
Cohesion: 0.15
Nodes (2): li(), link()

### Community 31 - "Community 31"
Cohesion: 0.21
Nodes (2): FpsControls, bindViewportHeight()

### Community 32 - "Community 32"
Cohesion: 0.17
Nodes (2): findPosAfter(), selectRange()

### Community 33 - "Community 33"
Cohesion: 0.21
Nodes (5): getLine(), decodeHex(), extractCommand(), Osc133State, parseOsc133Payload()

### Community 34 - "Community 34"
Cohesion: 0.17
Nodes (2): Dropbox, DropboxAuth

### Community 35 - "Community 35"
Cohesion: 0.24
Nodes (5): LI(), LI_NESTED(), NESTED_UL(), P(), richDoc()

### Community 36 - "Community 36"
Cohesion: 0.31
Nodes (7): CAT(), LI(), LI_NESTED(), makeEditor(), mk(), P(), UL()

### Community 37 - "Community 37"
Cohesion: 0.38
Nodes (7): coerceConfidence(), errorMessage(), isNonEmptyString(), isObject(), loadCodegraphData(), validateCommunityLabels(), validateMeta()

### Community 38 - "Community 38"
Cohesion: 0.33
Nodes (7): cmpKey(), findAdjacentDateNotes(), fmtDate(), isDateTitle(), parseDateTitle(), buildDecorations(), makeArrowRowFactory()

### Community 39 - "Community 39"
Cohesion: 0.22
Nodes (2): Dropbox, DropboxAuth

### Community 40 - "Community 40"
Cohesion: 0.22
Nodes (1): RO

### Community 41 - "Community 41"
Cohesion: 0.28
Nodes (4): li(), makeEditor(), makeEditorDisabled(), p()

### Community 43 - "Community 43"
Cohesion: 0.25
Nodes (2): LI(), P()

### Community 44 - "Community 44"
Cohesion: 0.28
Nodes (3): li(), para(), pli()

### Community 45 - "Community 45"
Cohesion: 0.22
Nodes (2): mount(), snapshot()

### Community 46 - "Community 46"
Cohesion: 0.43
Nodes (6): main(), normalizeRepoUrl(), parseCommunityLabels(), pathExists(), resolveBranch(), resolveRepoUrl()

### Community 47 - "Community 47"
Cohesion: 0.36
Nodes (5): packDense(), pickShrinkIndex(), selectDenseLayout(), packAt(), packMaxRects()

### Community 48 - "Community 48"
Cohesion: 0.54
Nodes (7): loadActiveOrdinals(), loadColumnWidths(), safeStorage(), saveActiveOrdinals(), saveColumnWidths(), storageKey(), widthsKey()

### Community 52 - "Community 52"
Cohesion: 0.32
Nodes (3): classDecos(), foldDecorations(), widgetDecos()

### Community 54 - "Community 54"
Cohesion: 0.25
Nodes (2): installCursorVisibility(), install()

### Community 55 - "Community 55"
Cohesion: 0.43
Nodes (7): checklistDoc(), li(), liChecked(), makeNote(), noteDoc(), p(), ul()

### Community 56 - "Community 56"
Cohesion: 0.29
Nodes (2): CB(), cbPara()

### Community 57 - "Community 57"
Cohesion: 0.33
Nodes (2): findQuotedParagraphs(), buildDecorations()

### Community 58 - "Community 58"
Cohesion: 0.52
Nodes (6): applyStickyToText(), computeStickyKeySequence(), ctrlByteForLetter(), isLetter(), isPrintable(), transformChar()

### Community 59 - "Community 59"
Cohesion: 0.38
Nodes (4): fetchGpuStatus(), GpuMonitorError, httpBase(), unloadModel()

### Community 60 - "Community 60"
Cohesion: 0.57
Nodes (5): LI(), LI_NESTED(), P(), processDoc(), UL()

### Community 62 - "Community 62"
Cohesion: 0.38
Nodes (3): liChecked(), liNested(), p()

### Community 63 - "Community 63"
Cohesion: 0.29
Nodes (2): Dropbox, DropboxAuth

### Community 64 - "Community 64"
Cohesion: 0.33
Nodes (2): CB(), cbPara()

### Community 66 - "Community 66"
Cohesion: 0.6
Nodes (5): buildDecorations(), makeActionsFactory(), makeArrowFactory(), parseLabeledLine(), parseSlipNeighbors()

### Community 67 - "Community 67"
Cohesion: 0.4
Nodes (2): transformFragment(), transformPastedSlice()

### Community 68 - "Community 68"
Cohesion: 0.4
Nodes (2): onModKeyup(), otherModHeld()

### Community 69 - "Community 69"
Cohesion: 0.4
Nodes (2): transformFragment(), transformPastedSlice()

### Community 70 - "Community 70"
Cohesion: 0.4
Nodes (2): collectLinkedTexts(), markedText()

### Community 74 - "Community 74"
Cohesion: 0.4
Nodes (2): LI(), P()

### Community 79 - "Community 79"
Cohesion: 0.8
Nodes (4): loadFoldedOrdinals(), safeStorage(), saveFoldedOrdinals(), storageKey()

### Community 80 - "Community 80"
Cohesion: 0.5
Nodes (2): getAudioContext(), playBeep()

### Community 81 - "Community 81"
Cohesion: 0.6
Nodes (3): emptySweep(), openResult(), reset()

### Community 82 - "Community 82"
Cohesion: 0.6
Nodes (3): persist(), resetCursorDebug(), setCursorDebug()

### Community 84 - "Community 84"
Cohesion: 0.4
Nodes (2): applyResize(), run()

### Community 85 - "Community 85"
Cohesion: 0.5
Nodes (2): LI(), P()

### Community 86 - "Community 86"
Cohesion: 0.5
Nodes (2): LI(), P()

### Community 88 - "Community 88"
Cohesion: 0.6
Nodes (3): findInlineHidden(), findWidgets(), getDecorations()

### Community 90 - "Community 90"
Cohesion: 0.6
Nodes (3): findWidget(), getState(), widgetDom()

### Community 92 - "Community 92"
Cohesion: 0.4
Nodes (1): RO

### Community 94 - "Community 94"
Cohesion: 0.4
Nodes (1): RO

### Community 97 - "Community 97"
Cohesion: 0.5
Nodes (2): docWith(), P()

### Community 98 - "Community 98"
Cohesion: 0.5
Nodes (2): li(), p()

### Community 99 - "Community 99"
Cohesion: 0.5
Nodes (2): li(), p()

### Community 100 - "Community 100"
Cohesion: 0.83
Nodes (3): formatLineHash(), githubLink(), normalizeRepoUrl()

### Community 101 - "Community 101"
Cohesion: 0.67
Nodes (2): suppressesSubtitle(), buildDecorations()

### Community 104 - "Community 104"
Cohesion: 0.83
Nodes (3): isBlock(), toPlainText(), walk()

### Community 115 - "Community 115"
Cohesion: 0.67
Nodes (2): decoCount(), getDecorations()

### Community 125 - "Community 125"
Cohesion: 0.67
Nodes (2): li(), p()

### Community 129 - "Community 129"
Cohesion: 0.67
Nodes (2): active, resizing

### Community 130 - "Community 130"
Cohesion: 1.0
Nodes (2): formatDate(), insertTodayDate()

### Community 131 - "Community 131"
Cohesion: 1.0
Nodes (2): paragraphText(), parseKeysNote()

### Community 133 - "Community 133"
Cohesion: 1.0
Nodes (2): searchNotes(), stripXmlTags()

### Community 153 - "Community 153"
Cohesion: 0.67
Nodes (1): FakeClipboardItem

### Community 172 - "Community 172"
Cohesion: 1.0
Nodes (2): docOf(), trackLi()

### Community 175 - "Community 175"
Cohesion: 1.0
Nodes (1): active

### Community 176 - "Community 176"
Cohesion: 1.0
Nodes (1): hidden

### Community 177 - "Community 177"
Cohesion: 1.0
Nodes (1): hidden

### Community 198 - "Community 198"
Cohesion: 1.0
Nodes (1): active

## Knowledge Gaps
- **10 isolated node(s):** `active`, `hidden`, `hidden`, `active`, `resizing` (+5 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 29`** (15 nodes): `doc()`, `findPosAfter()`, `li()`, `makeEditor()`, `makeFullEditor()`, `ol()`, `outline()`, `p()`, `placeCursorAt()`, `placeCursorAtMiddle()`, `placeCursorAtOffset0()`, `placeCursorAtStartOf()`, `selectRange()`, `ul()`, `listItemDepthOnly.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 30`** (14 nodes): `cb()`, `doc()`, `ent()`, `kw()`, `kwWith()`, `leaf()`, `li()`, `link()`, `liNodes()`, `list()`, `makeEditor()`, `titleLine()`, `txt()`, `parser.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 31`** (13 nodes): `FpsControls`, `.attach()`, `.constructor()`, `.detach()`, `.dispose()`, `.enabled()`, `.lock()`, `.locked()`, `.unlock()`, `.update()`, `FpsControls.ts`, `viewportHeight.ts`, `bindViewportHeight()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 32`** (13 nodes): `doc()`, `findPosAfter()`, `li()`, `makeEditor()`, `ol()`, `outline()`, `p()`, `pBold()`, `placeCursorAt()`, `placeCursorAtOffset()`, `selectRange()`, `ul()`, `listItemReorder.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 34`** (12 nodes): `dropboxClient.commit.test.ts`, `authenticate()`, `Dropbox`, `DropboxAuth`, `.setAccessToken()`, `.setRefreshToken()`, `findUpload()`, `findUploadIndex()`, `makeUploads()`, `parseManifest()`, `uploadDelayMs()`, `uploadRejector()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 39`** (9 nodes): `dropboxClient.commit.property.test.ts`, `Dropbox`, `DropboxAuth`, `.setAccessToken()`, `.setRefreshToken()`, `parseManifest()`, `resetState()`, `uploadDelayMs()`, `uploadRejector()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 40`** (9 nodes): `isOpen()`, `open()`, `RO`, `.disconnect()`, `.observe()`, `.unobserve()`, `toggle()`, `windows()`, `SpreadOverlay.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (9 nodes): `caretAtItemEnd()`, `caretAtItemStart()`, `firstLi()`, `LI()`, `makeEditor()`, `P()`, `typeText()`, `UL()`, `inputRules.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (9 nodes): `mount()`, `closeCard()`, `jumpTo()`, `measure()`, `onKey()`, `snapshot()`, `titleFor()`, `SpreadOverlay.svelte`, `noteTitleDropPlugin.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 54`** (8 nodes): `installCursorVisibility()`, `shouldDeferScrollToSelection()`, `install()`, `makeFakeEditor()`, `mkView()`, `vvFire()`, `keepCursorVisible.ts`, `keepCursorVisible.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 56`** (8 nodes): `CB()`, `cbPara()`, `decorationsOf()`, `li()`, `makeEditor()`, `textPara()`, `ul()`, `chartBlockPlugin.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 57`** (7 nodes): `findQuotedParagraphs()`, `isQuotedParagraphText()`, `buildDecorations()`, `createBlockquotePlugin()`, `blockquote.ts`, `index.ts`, `plugin.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 63`** (7 nodes): `authenticate()`, `Dropbox`, `DropboxAuth`, `.setAccessToken()`, `.setRefreshToken()`, `fakeFile()`, `imageUpload.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 64`** (7 nodes): `CB()`, `cbPara()`, `li()`, `makeDoc()`, `textPara()`, `ul()`, `findChartRegions.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 67`** (6 nodes): `insertInlineCheckbox()`, `createPasteTransformPlugin()`, `transformFragment()`, `transformPastedSlice()`, `index.ts`, `node.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 68`** (6 nodes): `stickyDoubleTap.ts`, `modKeyFromEventKey()`, `onModKeydown()`, `onModKeyup()`, `onNonModKeydown()`, `otherModHeld()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 69`** (6 nodes): `insertInlineRadio()`, `createPasteTransformPlugin()`, `transformFragment()`, `transformPastedSlice()`, `index.ts`, `node.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 70`** (6 nodes): `collectLinkedTexts()`, `entry()`, `findTextEnd()`, `makeEditor()`, `markedText()`, `autoLinkPasteEdit.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 74`** (6 nodes): `LI()`, `liPosAt()`, `makeEditor()`, `P()`, `UL()`, `plugin.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 80`** (5 nodes): `terminalBell.ts`, `createBellRinger()`, `getAudioContext()`, `playBeep()`, `shouldRing()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 84`** (5 nodes): `applyResize()`, `startPointerDrag()`, `run()`, `dragResize.ts`, `resizeGeometry.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 85`** (5 nodes): `LI()`, `makeEditor()`, `P()`, `UL()`, `checklistPlugin.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 86`** (5 nodes): `LI()`, `makeEditor()`, `P()`, `UL()`, `checklistRegions.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 92`** (5 nodes): `RO`, `.disconnect()`, `.observe()`, `.unobserve()`, `tomboyEditorTitleHide.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 94`** (5 nodes): `RO`, `.disconnect()`, `.observe()`, `.unobserve()`, `tomboyEditorReadOnly.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 97`** (5 nodes): `caretAfter()`, `docWith()`, `makeEditor()`, `P()`, `splitInheritance.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 98`** (5 nodes): `bulletList()`, `doc()`, `li()`, `p()`, `extractCurrentMonth.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 99`** (5 nodes): `doc()`, `li()`, `p()`, `ul()`, `parseScheduleNote.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 101`** (4 nodes): `suppressesSubtitle()`, `buildDecorations()`, `TomboySubtitlePlaceholder.ts`, `subtitleSlot.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 115`** (4 nodes): `decoCount()`, `getDecorations()`, `makeEditor()`, `imagePreviewPlugin.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 125`** (4 nodes): `li()`, `p()`, `ul()`, `noteManagerHook.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 129`** (3 nodes): `active`, `resizing`, `SidePanel.svelte`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 130`** (3 nodes): `formatDate()`, `insertTodayDate()`, `insertDate.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 131`** (3 nodes): `paragraphText()`, `parseKeysNote()`, `parseKeysNote.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 133`** (3 nodes): `searchNotes()`, `stripXmlTags()`, `noteSearch.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 153`** (3 nodes): `FakeClipboardItem`, `.constructor()`, `copyImage.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 172`** (3 nodes): `docOf()`, `trackLi()`, `playlistBlockRoundtrip.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 175`** (2 nodes): `active`, `TabBar.svelte`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 176`** (2 nodes): `hidden`, `SettingsWindow.svelte`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 177`** (2 nodes): `hidden`, `AdminWindow.svelte`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 198`** (2 nodes): `active`, `+page.svelte`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `pushToast()` connect `Community 12` to `Community 2`, `Community 4`, `Community 11`, `Community 13`, `Community 17`, `Community 21`, `Community 22`, `Community 23`, `Community 24`, `Community 27`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **Why does `addProseMirrorPlugins()` connect `Community 6` to `Community 3`, `Community 5`, `Community 8`, `Community 17`, `Community 21`, `Community 25`, `Community 27`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Why does `deserializeContent()` connect `Community 1` to `Community 0`, `Community 4`, `Community 7`, `Community 8`, `Community 9`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **Are the 30 inferred relationships involving `getDB()` (e.g. with `getImageRecord()` and `putImageRecord()`) actually correct?**
  _`getDB()` has 30 INFERRED edges - model-reasoned connections that need verification._
- **Are the 14 inferred relationships involving `setSetting()` (e.g. with `setHomeNote()` and `setScheduleNote()`) actually correct?**
  _`setSetting()` has 14 INFERRED edges - model-reasoned connections that need verification._
- **Are the 26 inferred relationships involving `createEmptyNote()` (e.g. with `createNotebook()` and `createNote()`) actually correct?**
  _`createEmptyNote()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **Are the 22 inferred relationships involving `deserializeContent()` (e.g. with `countLinkSweep()` and `applyLinkSweep()`) actually correct?**
  _`deserializeContent()` has 22 INFERRED edges - model-reasoned connections that need verification._