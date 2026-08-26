/**
 * popup.js
 * Renders the popup UI from chrome.storage.local state and drives the
 * content script via messaging. The content script owns the actual
 * element-picking interaction (the popup closes as soon as the user clicks
 * on the page, which is normal browser behavior), so this file:
 *   - reads/writes the current column configuration (V1.1 behavior,
 *     unchanged: content/*.js is never touched by V1.2)
 *   - manages Saved Scrapers (utils/recipes.js) — configuration only
 *   - runs a small in-memory results pipeline (utils/results.js) over
 *     whatever RUN_EXTRACTION last returned: filter -> dedupe -> sort ->
 *     display/export. Result rows are NEVER written to chrome.storage —
 *     only scraper *configuration* is persisted (see recipes.js).
 */
(function () {
  'use strict';

  var els = {
    unsupportedNotice: document.getElementById('unsupported-notice'),
    mainContent: document.getElementById('main-content'),

    headerTrialBadge: document.getElementById('header-trial-badge'),
    settingsOpenBtn: document.getElementById('settings-open-btn'),
    settingsCloseBtn: document.getElementById('settings-close-btn'),
    settingsPanel: document.getElementById('settings-panel'),
    settingsLicenseText: document.getElementById('settings-license-text'),
    settingsLicenseSummary: document.getElementById('settings-license-summary'),
    settingsLicenseVerificationNote: document.getElementById('settings-license-verification-note'),
    settingsUnlockBtn: document.getElementById('settings-unlock-btn'),
    settingsRecoverBtn: document.getElementById('settings-recover-btn'),
    settingsRecoverPanel: document.getElementById('settings-recover-panel'),
    settingsRecoverEmail: document.getElementById('settings-recover-email'),
    settingsRecoverSubmitBtn: document.getElementById('settings-recover-submit-btn'),
    settingsRecoverCancelBtn: document.getElementById('settings-recover-cancel-btn'),
    settingsDevSwitcher: document.getElementById('settings-dev-switcher'),
    settingsLanguageSelect: document.getElementById('settings-language-select'),
    qaTrialStateABtn: document.getElementById('qa-trial-state-a-btn'),
    qaTrialStateBBtn: document.getElementById('qa-trial-state-b-btn'),
    qaTrialStateCBtn: document.getElementById('qa-trial-state-c-btn'),
    qaTrialStateDBtn: document.getElementById('qa-trial-state-d-btn'),
    qaTrialStateEBtn: document.getElementById('qa-trial-state-e-btn'),
    qaTrialResetBtn: document.getElementById('qa-trial-reset-btn'),
    settingsRbCsv: document.getElementById('settings-rb-csv'),
    settingsRbXlsx: document.getElementById('settings-rb-xlsx'),
    settingsRbJson: document.getElementById('settings-rb-json'),
    settingsRbImages: document.getElementById('settings-rb-images'),
    settingsRbFiles: document.getElementById('settings-rb-files'),
    settingsVersionText: document.getElementById('settings-version-text'),

    trialModalOverlay: document.getElementById('trial-modal-overlay'),
    trialModalTitle: document.getElementById('trial-modal-title'),
    trialModalBody: document.getElementById('trial-modal-body'),
    trialModalUnlockBtn: document.getElementById('trial-modal-unlock-btn'),
    trialModalDismissBtn: document.getElementById('trial-modal-dismiss-btn'),

    tabNav: document.getElementById('tab-nav'),
    resultsEmptyWrap: document.getElementById('results-empty-wrap'),
    resultsEmpty: document.getElementById('results-empty'),
    resultsStatusText: document.getElementById('results-status-text'),
    resultsGoScrapeBtn: document.getElementById('results-go-scrape-btn'),
    resultsGoResearchBtn: document.getElementById('results-go-research-btn'),
    resultsGoMonitorBtn: document.getElementById('results-go-monitor-btn'),
    researchStatusText: document.getElementById('research-status-text'),
    researchEmptyWrap: document.getElementById('research-empty-wrap'),
    researchTabEmpty: document.getElementById('research-tab-empty'),
    researchGoScrapeBtn: document.getElementById('research-go-scrape-btn'),

    scrapeWorkflowSteps: document.getElementById('scrape-workflow-steps'),
    scrapeStatusText: document.getElementById('scrape-status-text'),
    scrapeViewResultsBtn: document.getElementById('scrape-view-results-btn'),
    firstRunHelp: document.getElementById('first-run-help'),
    scraperLoadStatus: document.getElementById('scraper-load-status'),

    scrapersList: document.getElementById('scrapers-list'),
    scrapersEmpty: document.getElementById('scrapers-empty'),

    monitoringList: document.getElementById('monitoring-list'),
    monitoringEmpty: document.getElementById('monitoring-empty'),
    monitoringSummary: document.getElementById('monitoring-summary'),
    monitoringFilters: document.getElementById('monitoring-filters'),
    monitoringFilterEmpty: document.getElementById('monitoring-filter-empty'),

    columnsList: document.getElementById('columns-list'),
    columnsEmpty: document.getElementById('columns-empty'),
    addColumnBtn: document.getElementById('add-column-btn'),
    autoDetectBtn: document.getElementById('auto-detect-btn'),
    saveScraperBtn: document.getElementById('save-scraper-btn'),
    updateScraperBtn: document.getElementById('update-scraper-btn'),

    structuredDataBtn: document.getElementById('structured-data-btn'),
    structuredDataPanel: document.getElementById('structured-data-panel'),
    sdSummaryBadge: document.getElementById('sd-summary-badge'),
    sdEmptyNote: document.getElementById('sd-empty-note'),
    sdErrorsNote: document.getElementById('sd-errors-note'),
    sdFieldsList: document.getElementById('sd-fields-list'),
    sdCancelBtn: document.getElementById('sd-cancel-btn'),
    sdAddBtn: document.getElementById('sd-add-btn'),

    templatesBtn: document.getElementById('templates-btn'),
    templatesPanel: document.getElementById('templates-panel'),
    tplCloseBtn: document.getElementById('tpl-close-btn'),
    tplListView: document.getElementById('tpl-list-view'),
    tplSuggestionNote: document.getElementById('tpl-suggestion-note'),
    tplList: document.getElementById('tpl-list'),
    tplImportBtn: document.getElementById('tpl-import-btn'),
    tplImportFile: document.getElementById('tpl-import-file'),
    tplSaveCurrentBtn: document.getElementById('tpl-save-current-btn'),
    tplPreviewView: document.getElementById('tpl-preview-view'),
    tplPreviewName: document.getElementById('tpl-preview-name'),
    tplPreviewBackBtn: document.getElementById('tpl-preview-back-btn'),
    tplPreviewDesc: document.getElementById('tpl-preview-desc'),
    tplPreviewNote: document.getElementById('tpl-preview-note'),
    tplPreviewFields: document.getElementById('tpl-preview-fields'),
    tplPreviewUnmatched: document.getElementById('tpl-preview-unmatched'),
    tplCancelBtn: document.getElementById('tpl-cancel-btn'),
    tplApplyBtn: document.getElementById('tpl-apply-btn'),

    // V1 WORKFLOW REORG
    scrapeModeSwitch: document.getElementById('scrape-mode-switch'),
    modeAutoBtn: document.getElementById('mode-auto-btn'),
    modeManualBtn: document.getElementById('mode-manual-btn'),
    autoModePanel: document.getElementById('auto-mode-panel'),
    manualModeContent: document.getElementById('manual-mode-content'),
    scanPageBtn: document.getElementById('scan-page-btn'),
    autoScanStatus: document.getElementById('auto-scan-status'),
    autoScanResult: document.getElementById('auto-scan-result'),
    autoScanSummary: document.getElementById('auto-scan-summary'),
    autoScanLowConfidenceNote: document.getElementById('auto-scan-low-confidence-note'),
    autoScanCandidates: document.getElementById('auto-scan-candidates'),
    autoScanCandidatesList: document.getElementById('auto-scan-candidates-list'),
    autoScanFieldsList: document.getElementById('auto-scan-fields-list'),
    autoScanPreviewTable: document.getElementById('auto-scan-preview-table'),
    autoExtractBtn: document.getElementById('auto-extract-btn'),
    autoSwitchToManualBtn: document.getElementById('auto-switch-to-manual-btn'),
    autoDiagPanel: document.getElementById('auto-diag-panel'),
    autoDiagCopyBtn: document.getElementById('auto-diag-copy-btn'),
    autoDiagStatus: document.getElementById('auto-diag-status'),
    autoDiagTextarea: document.getElementById('auto-diag-textarea'),
    sessionDiagPanel: document.getElementById('session-diag-panel'),
    sessionDiagCopyBtn: document.getElementById('session-diag-copy-btn'),
    sessionDiagStatus: document.getElementById('session-diag-status'),
    sessionDiagTextarea: document.getElementById('session-diag-textarea'),
    resultsNextActions: document.getElementById('results-next-actions'),
    resultsExportDataBtn: document.getElementById('results-export-data-btn'),
    monitorBackToResultsBtn: document.getElementById('monitor-back-to-results-btn'),
    researchBackToResultsBtn: document.getElementById('research-back-to-results-btn'),

    autoDetectPanel: document.getElementById('auto-detect-panel'),
    adConfidenceBadge: document.getElementById('ad-confidence-badge'),
    adStructureSelect: document.getElementById('ad-structure-select'),
    adStructureMeta: document.getElementById('ad-structure-meta'),
    adFieldsList: document.getElementById('ad-fields-list'),
    adPreviewTable: document.getElementById('ad-preview-table'),
    adCancelBtn: document.getElementById('ad-cancel-btn'),
    adUseBtn: document.getElementById('ad-use-btn'),

    previewBtn: document.getElementById('preview-btn'),
    resetBtn: document.getElementById('reset-btn'),
    statusMsg: document.getElementById('status-msg'),

    previewSection: document.getElementById('preview-section'),
    previewTable: document.getElementById('preview-table'),
    rowCount: document.getElementById('row-count'),
    previewNote: document.getElementById('preview-note'),
    anomalyLegend: document.getElementById('anomaly-legend'),

    // V1 SIMPLIFIED SESSION WORKFLOW
    baslaBtn: document.getElementById('basla-btn'),
    setupPreviewWrap: document.getElementById('setup-preview-wrap'),
    setupPreviewTable: document.getElementById('setup-preview-table'),
    liveSessionStatus: document.getElementById('live-session-status'),
    bitirBtn: document.getElementById('bitir-btn'),
    exportGate: document.getElementById('export-gate'),

    // NEW FEATURE — AUTOMATIC PAGINATION (Auto Next)
    autoNextToggle: document.getElementById('auto-next-toggle'),
    autoPaginateStatus: document.getElementById('auto-paginate-status'),
    durdurBtn: document.getElementById('durdur-btn'),

    // AUTOMATIC DISCOVERY STATUS + PROCESSING CHOICE (data-integrity/UX mission)
    discoveryPanel: document.getElementById('discovery-panel'),
    discoveryStatusLine1: document.getElementById('discovery-status-line1'),
    discoveryStatusLine2: document.getElementById('discovery-status-line2'),
    discoveryStatusLine3: document.getElementById('discovery-status-line3'),
    discoveryChoicePanel: document.getElementById('discovery-choice-panel'),
    discoveryChoiceHeading: document.getElementById('discovery-choice-heading'),
    discoveryProcessAllBtn: document.getElementById('discovery-process-all-btn'),
    discoveryFirstNInput: document.getElementById('discovery-first-n-input'),
    discoveryProcessFirstBtn: document.getElementById('discovery-process-first-btn'),
    discoveryChoiceError: document.getElementById('discovery-choice-error'),
    discoverySummaryPanel: document.getElementById('discovery-summary-panel'),
    discoverySummaryFound: document.getElementById('discovery-summary-found'),
    discoverySummaryProcessed: document.getElementById('discovery-summary-processed'),
    discoverySummaryDuplicates: document.getElementById('discovery-summary-duplicates'),
    discoverySummaryInvalid: document.getElementById('discovery-summary-invalid'),

    // NEW FEATURE — INFINITE SCROLL (Auto Scroll)
    autoScrollToggle: document.getElementById('auto-scroll-toggle'),
    autoScrollStatus: document.getElementById('auto-scroll-status'),

    toggleFilterBtn: document.getElementById('toggle-filter-btn'),
    toggleSortBtn: document.getElementById('toggle-sort-btn'),
    toggleDedupeBtn: document.getElementById('toggle-dedupe-btn'),
    copyBtn: document.getElementById('copy-btn'),
    resetResultsBtn: document.getElementById('reset-results-btn'),

    filterPanel: document.getElementById('filter-panel'),
    filterColumn: document.getElementById('filter-column'),
    filterCondition: document.getElementById('filter-condition'),
    filterValue: document.getElementById('filter-value'),
    filterValueLabel: document.getElementById('filter-value-label'),
    filterApplyBtn: document.getElementById('filter-apply-btn'),
    filterClearBtn: document.getElementById('filter-clear-btn'),

    sortPanel: document.getElementById('sort-panel'),
    sortColumn: document.getElementById('sort-column'),
    sortApplyBtn: document.getElementById('sort-apply-btn'),
    sortClearBtn: document.getElementById('sort-clear-btn'),

    dedupePanel: document.getElementById('dedupe-panel'),
    dedupeColumn: document.getElementById('dedupe-column'),
    dedupeApplyBtn: document.getElementById('dedupe-apply-btn'),

    exportCsvBtn: document.getElementById('export-csv-btn'),
    exportXlsxBtn: document.getElementById('export-xlsx-btn'),
    exportJsonBtn: document.getElementById('export-json-btn'),
    exportNdjsonBtn: document.getElementById('export-ndjson-btn'),
    exportSheetsBtn: document.getElementById('export-sheets-btn'),
    copyFormatSelect: document.getElementById('copy-format-select'),
    toggleExportOptionsBtn: document.getElementById('toggle-export-options-btn'),
    exportOptionsPanel: document.getElementById('export-options-panel'),
    exportColumnList: document.getElementById('export-column-list'),
    exportColumnsAllBtn: document.getElementById('export-columns-all-btn'),
    exportColumnsNoneBtn: document.getElementById('export-columns-none-btn'),
    exportIncludeRaw: document.getElementById('export-include-raw'),
    exportCsvDelimiter: document.getElementById('export-csv-delimiter'),
    exportFilenameTemplate: document.getElementById('export-filename-template'),
    exportPreviewText: document.getElementById('export-preview-text'),
    exportOptionsCloseBtn: document.getElementById('export-options-close-btn'),

    downloadActionsRow: document.getElementById('download-actions-row'),
    downloadImagesBtn: document.getElementById('download-images-btn'),
    downloadFilesBtn: document.getElementById('download-files-btn'),

    downloadSetupPanel: document.getElementById('download-setup-panel'),
    dlColumnSelect: document.getElementById('dl-column-select'),
    dlTypeFilterWrap: document.getElementById('dl-type-filter-wrap'),
    dlTypeFilterList: document.getElementById('dl-type-filter-list'),
    dlFilenameTemplate: document.getElementById('dl-filename-template'),
    dlFolderName: document.getElementById('dl-folder-name'),
    dlScopeWrap: document.getElementById('dl-scope-wrap'),
    dlPreviewSummary: document.getElementById('dl-preview-summary'),
    dlCancelBtn: document.getElementById('dl-cancel-btn'),
    dlStartBtn: document.getElementById('dl-start-btn'),

    downloadProgressSection: document.getElementById('download-progress-section'),
    dlStatusBadge: document.getElementById('dl-status-badge'),
    dlProgressText: document.getElementById('dl-progress-text'),
    dlFolderNote: document.getElementById('dl-folder-note'),
    dlStopBtn: document.getElementById('dl-stop-btn'),
    dlRetryBtn: document.getElementById('dl-retry-btn'),
    dlDoneBtn: document.getElementById('dl-done-btn'),

    researchBundleBtn: document.getElementById('research-bundle-btn'),
    researchSetupPanel: document.getElementById('research-setup-panel'),
    rbDatasetName: document.getElementById('rb-dataset-name'),
    rbIncludeCsv: document.getElementById('rb-include-csv'),
    rbIncludeXlsx: document.getElementById('rb-include-xlsx'),
    rbIncludeJson: document.getElementById('rb-include-json'),
    rbIncludeImages: document.getElementById('rb-include-images'),
    rbIncludeFiles: document.getElementById('rb-include-files'),
    rbImageColumnWrap: document.getElementById('rb-image-column-wrap'),
    rbImageColumnSelect: document.getElementById('rb-image-column-select'),
    rbFileColumnWrap: document.getElementById('rb-file-column-wrap'),
    rbFileColumnSelect: document.getElementById('rb-file-column-select'),
    rbScopeWrap: document.getElementById('rb-scope-wrap'),
    rbPreviewSummary: document.getElementById('rb-preview-summary'),
    rbCancelBtn: document.getElementById('rb-cancel-btn'),
    rbStartBtn: document.getElementById('rb-start-btn'),

    researchProgressSection: document.getElementById('research-progress-section'),
    rbProgressTitle: document.getElementById('rb-progress-title'),
    rbStatusBadge: document.getElementById('rb-status-badge'),
    rbProgressText: document.getElementById('rb-progress-text'),
    rbFolderNote: document.getElementById('rb-folder-note'),
    rbStopBtn: document.getElementById('rb-stop-btn'),
    rbRetryBtn: document.getElementById('rb-retry-btn'),
    rbDoneBtn: document.getElementById('rb-done-btn'),

    toggleTransformBtn: document.getElementById('toggle-transform-btn'),
    transformPanel: document.getElementById('transform-panel'),
    transformsHistoryList: document.getElementById('transforms-history-list'),
    transformsHistoryEmpty: document.getElementById('transforms-history-empty'),
    undoLastTransformBtn: document.getElementById('undo-last-transform-btn'),
    resetTransformsBtn: document.getElementById('reset-transforms-btn'),
    tfAutoApplySaved: document.getElementById('tf-auto-apply-saved'),
    tfPresetSelect: document.getElementById('tf-preset-select'),
    tfAddPresetBtn: document.getElementById('tf-add-preset-btn'),
    tfTargetColumnWrap: document.getElementById('tf-target-column-wrap'),
    tfColumnSelect: document.getElementById('tf-column-select'),
    tfOperationSelect: document.getElementById('tf-operation-select'),
    tfFindReplaceFields: document.getElementById('tf-find-replace-fields'),
    tfFindValue: document.getElementById('tf-find-value'),
    tfReplaceValue: document.getElementById('tf-replace-value'),
    tfCaseSensitive: document.getElementById('tf-case-sensitive'),
    tfFindOccurrenceAll: document.getElementById('tf-find-occurrence-all'),
    tfFindOccurrenceFirst: document.getElementById('tf-find-occurrence-first'),
    tfRegexReplaceFields: document.getElementById('tf-regex-replace-fields'),
    tfRegexPattern: document.getElementById('tf-regex-pattern'),
    tfRegexFlags: document.getElementById('tf-regex-flags'),
    tfRegexReplacement: document.getElementById('tf-regex-replacement'),
    tfRegexExtractFields: document.getElementById('tf-regex-extract-fields'),
    tfExtractPattern: document.getElementById('tf-extract-pattern'),
    tfExtractFlags: document.getElementById('tf-extract-flags'),
    tfExtractGroup: document.getElementById('tf-extract-group'),
    tfExtractFallback: document.getElementById('tf-extract-fallback'),
    tfExtractAll: document.getElementById('tf-extract-all'),
    tfExtractJoinWrap: document.getElementById('tf-extract-join-wrap'),
    tfExtractJoin: document.getElementById('tf-extract-join'),
    tfCaseFields: document.getElementById('tf-case-fields'),
    tfCaseMode: document.getElementById('tf-case-mode'),
    tfPrefixSuffixFields: document.getElementById('tf-prefix-suffix-fields'),
    tfPrefixValue: document.getElementById('tf-prefix-value'),
    tfSuffixValue: document.getElementById('tf-suffix-value'),
    tfRemovePrefixFields: document.getElementById('tf-remove-prefix-fields'),
    tfRemovePrefixValue: document.getElementById('tf-remove-prefix-value'),
    tfRemovePrefixCaseSensitive: document.getElementById('tf-remove-prefix-case-sensitive'),
    tfRemoveSuffixFields: document.getElementById('tf-remove-suffix-fields'),
    tfRemoveSuffixValue: document.getElementById('tf-remove-suffix-value'),
    tfRemoveSuffixCaseSensitive: document.getElementById('tf-remove-suffix-case-sensitive'),
    tfFillEmptyFields: document.getElementById('tf-fill-empty-fields'),
    tfFillValue: document.getElementById('tf-fill-value'),
    tfFillMode: document.getElementById('tf-fill-mode'),
    tfFillMatchValues: document.getElementById('tf-fill-match-values'),
    tfNormalizeNumberFields: document.getElementById('tf-normalize-number-fields'),
    tfNumberMode: document.getElementById('tf-number-mode'),
    tfNumberCustomWrap: document.getElementById('tf-number-custom-wrap'),
    tfNumberDecimalSep: document.getElementById('tf-number-decimal-sep'),
    tfNumberThousandsSep: document.getElementById('tf-number-thousands-sep'),
    tfNormalizeCurrencyFields: document.getElementById('tf-normalize-currency-fields'),
    tfCurrencyMode: document.getElementById('tf-currency-mode'),
    tfNormalizePercentageFields: document.getElementById('tf-normalize-percentage-fields'),
    tfPercentageMode: document.getElementById('tf-percentage-mode'),
    tfNormalizeDateFields: document.getElementById('tf-normalize-date-fields'),
    tfDateOrder: document.getElementById('tf-date-order'),
    tfDateOutputFormat: document.getElementById('tf-date-output-format'),
    tfNormalizeBooleanFields: document.getElementById('tf-normalize-boolean-fields'),
    tfBoolTrueValues: document.getElementById('tf-bool-true-values'),
    tfBoolFalseValues: document.getElementById('tf-bool-false-values'),
    tfBoolOutputTrue: document.getElementById('tf-bool-output-true'),
    tfBoolOutputFalse: document.getElementById('tf-bool-output-false'),
    tfBoolUnmatchedMode: document.getElementById('tf-bool-unmatched-mode'),
    tfBoolUnmatchedValueWrap: document.getElementById('tf-bool-unmatched-value-wrap'),
    tfBoolUnmatchedValue: document.getElementById('tf-bool-unmatched-value'),
    tfExtractDomainFields: document.getElementById('tf-extract-domain-fields'),
    tfDomainPart: document.getElementById('tf-domain-part'),
    tfNormalizeUrlFields: document.getElementById('tf-normalize-url-fields'),
    tfRemoveFragment: document.getElementById('tf-remove-fragment'),
    tfSubstringFields: document.getElementById('tf-substring-fields'),
    tfSubstringMode: document.getElementById('tf-substring-mode'),
    tfSubstringNWrap: document.getElementById('tf-substring-n-wrap'),
    tfSubstringN: document.getElementById('tf-substring-n'),
    tfSubstringRangeWrap: document.getElementById('tf-substring-range-wrap'),
    tfSubstringStart: document.getElementById('tf-substring-start'),
    tfSubstringEnd: document.getElementById('tf-substring-end'),
    tfSplitFields: document.getElementById('tf-split-fields'),
    tfSplitDelimiterWrap: document.getElementById('tf-split-delimiter-wrap'),
    tfSplitDelimiter: document.getElementById('tf-split-delimiter'),
    tfSplitRegexWrap: document.getElementById('tf-split-regex-wrap'),
    tfSplitPattern: document.getElementById('tf-split-pattern'),
    tfSplitFlags: document.getElementById('tf-split-flags'),
    tfSplitOutputMode: document.getElementById('tf-split-output-mode'),
    tfSplitColumnsWrap: document.getElementById('tf-split-columns-wrap'),
    tfSplitOutputNames: document.getElementById('tf-split-output-names'),
    tfSplitKeepOriginal: document.getElementById('tf-split-keep-original'),
    tfSplitPartIndexWrap: document.getElementById('tf-split-part-index-wrap'),
    tfSplitPartIndex: document.getElementById('tf-split-part-index'),
    tfSplitJoinWithWrap: document.getElementById('tf-split-join-with-wrap'),
    tfSplitJoinWith: document.getElementById('tf-split-join-with'),
    tfCombineFields: document.getElementById('tf-combine-fields'),
    tfCombineSourceList: document.getElementById('tf-combine-source-list'),
    tfCombineTemplate: document.getElementById('tf-combine-template'),
    tfCombineOutputName: document.getElementById('tf-combine-output-name'),
    tfCombineKeepOriginal: document.getElementById('tf-combine-keep-original'),
    tfScopeWrap: document.getElementById('tf-scope-wrap'),
    tfDestinationWrap: document.getElementById('tf-destination-wrap'),
    tfNewColumnNameWrap: document.getElementById('tf-new-column-name-wrap'),
    tfNewColumnName: document.getElementById('tf-new-column-name'),
    tfPreviewText: document.getElementById('tf-preview-text'),
    tfErrorText: document.getElementById('tf-error-text'),
    tfCancelBtn: document.getElementById('tf-cancel-btn'),
    tfApplyBtn: document.getElementById('tf-apply-btn'),

    toggleSnapshotsBtn: document.getElementById('toggle-snapshots-btn'),
    snapshotsPanel: document.getElementById('snapshots-panel'),
    compareKeySelect: document.getElementById('compare-key-select'),
    snapshotDuplicateNote: document.getElementById('snapshot-duplicate-note'),
    snapshotInfoText: document.getElementById('snapshot-info-text'),
    saveSnapshotBtn: document.getElementById('save-snapshot-btn'),
    compareSnapshotBtn: document.getElementById('compare-snapshot-btn'),

    toggleDeepScrapeBtn: document.getElementById('toggle-deepscrape-btn'),
    deepScrapePanel: document.getElementById('deepscrape-panel'),
    dsEnabled: document.getElementById('ds-enabled'),
    dsConfigBody: document.getElementById('ds-config-body'),
    dsSourceColumn: document.getElementById('ds-source-column'),
    dsFieldsList: document.getElementById('ds-fields-list'),
    dsFieldsEmpty: document.getElementById('ds-fields-empty'),
    dsAddFieldBtn: document.getElementById('ds-add-field-btn'),
    dsPickFieldsBtn: document.getElementById('ds-pick-fields-btn'),
    dsAddFieldForm: document.getElementById('ds-add-field-form'),
    dsFieldName: document.getElementById('ds-field-name'),
    dsFieldSelector: document.getElementById('ds-field-selector'),
    dsFieldAttribute: document.getElementById('ds-field-attribute'),
    dsFieldAttrNameRow: document.getElementById('ds-field-attrname-row'),
    dsFieldAttrName: document.getElementById('ds-field-attrname'),
    dsFieldMultiple: document.getElementById('ds-field-multiple'),
    dsFieldSaveBtn: document.getElementById('ds-field-save-btn'),
    dsFieldCancelBtn: document.getElementById('ds-field-cancel-btn'),
    dsConcurrency: document.getElementById('ds-concurrency'),
    dsDelayMode: document.getElementById('ds-delay-mode'),
    dsCustomDelayRow: document.getElementById('ds-custom-delay-row'),
    dsCustomDelay: document.getElementById('ds-custom-delay'),
    dsRetryLimit: document.getElementById('ds-retry-limit'),
    dsWorkloadSummary: document.getElementById('ds-workload-summary'),
    dsTestBtn: document.getElementById('ds-test-btn'),
    dsStartBtn: document.getElementById('ds-start-btn'),
    dsTestResults: document.getElementById('ds-test-results'),
    dsProgressSection: document.getElementById('ds-progress-section'),
    dsProgressBadge: document.getElementById('ds-progress-badge'),
    dsProgressText: document.getElementById('ds-progress-text'),
    dsProgressCurrent: document.getElementById('ds-progress-current'),
    dsRetryStatus: document.getElementById('ds-retry-status'),
    dsStopBtn: document.getElementById('ds-stop-btn'),
    dsRetryFailedBtn: document.getElementById('ds-retry-failed-btn'),
    dsSummaryText: document.getElementById('ds-summary-text'),

    changesSection: document.getElementById('changes-section'),
    changesBackBtn: document.getElementById('changes-back-btn'),
    changesSummaryText: document.getElementById('changes-summary-text'),
    changesDuplicateNote: document.getElementById('changes-duplicate-note'),
    changesFilterAll: document.getElementById('changes-filter-all'),
    changesFilterNew: document.getElementById('changes-filter-new'),
    changesFilterRemoved: document.getElementById('changes-filter-removed'),
    changesFilterChanged: document.getElementById('changes-filter-changed'),
    changesFilterPrice: document.getElementById('changes-filter-price'),
    changesList: document.getElementById('changes-list'),
    changesEmptyNote: document.getElementById('changes-empty-note'),
    changesTruncatedNote: document.getElementById('changes-truncated-note'),
    exportChangesCsvBtn: document.getElementById('export-changes-csv-btn'),
    exportChangesXlsxBtn: document.getElementById('export-changes-xlsx-btn'),
    exportChangesJsonBtn: document.getElementById('export-changes-json-btn'),
    saveSnapshotAfterCompare: document.getElementById('save-snapshot-after-compare'),
    saveAfterCompareBtn: document.getElementById('save-after-compare-btn'),

    runSection: document.getElementById('run-section'),
    runSectionAdvanced: document.getElementById('run-section-advanced'),
    scrapeAdvancedPanel: document.getElementById('scrape-advanced-panel'),
    autoScrollOptions: document.getElementById('auto-scroll-options'),
    asMaxRows: document.getElementById('as-max-rows'),
    asMaxScrolls: document.getElementById('as-max-scrolls'),
    multiPageOptions: document.getElementById('multi-page-options'),
    mpMethod: document.getElementById('mp-method'),
    mpNextButtonConfig: document.getElementById('mp-next-button-config'),
    mpUrlPatternConfig: document.getElementById('mp-url-pattern-config'),
    nextButtonStatus: document.getElementById('next-button-status'),
    selectNextBtn: document.getElementById('select-next-btn'),
    urlPatternStatus: document.getElementById('url-pattern-status'),
    urlPatternKey: document.getElementById('url-pattern-key'),
    urlPatternStart: document.getElementById('url-pattern-start'),
    urlPatternStep: document.getElementById('url-pattern-step'),
    mpMaxPages: document.getElementById('mp-max-pages'),
    mpMaxRows: document.getElementById('mp-max-rows'),
    mpDelayMs: document.getElementById('mp-delay-ms'),
    mpRetryCount: document.getElementById('mp-retry-count'),
    loadMoreOptions: document.getElementById('load-more-options'),
    lmButtonStatus: document.getElementById('lm-button-status'),
    selectLoadMoreBtn: document.getElementById('select-load-more-btn'),
    lmMaxClicks: document.getElementById('lm-max-clicks'),
    lmMaxRows: document.getElementById('lm-max-rows'),
    lmDelayMs: document.getElementById('lm-delay-ms'),
    lmRetryCount: document.getElementById('lm-retry-count'),
    paginationDetectWrap: document.getElementById('pagination-detect-wrap'),
    detectPaginationBtn: document.getElementById('detect-pagination-btn'),
    paginationDetectResult: document.getElementById('pagination-detect-result'),
    pdSummaryText: document.getElementById('pd-summary-text'),
    pdConfidenceBadge: document.getElementById('pd-confidence-badge'),
    pdUseBtn: document.getElementById('pd-use-btn'),
    pdDismissBtn: document.getElementById('pd-dismiss-btn'),
    runDedupeOptions: document.getElementById('run-dedupe-options'),
    runDedupeKey: document.getElementById('run-dedupe-key'),
    startRunBtn: document.getElementById('start-run-btn'),

    runProgressSection: document.getElementById('run-progress-section'),
    runStatusBadge: document.getElementById('run-status-badge'),
    runProgressText: document.getElementById('run-progress-text'),
    runRetryStatus: document.getElementById('run-retry-status'),
    pauseRunBtn: document.getElementById('pause-run-btn'),
    stopRunBtn: document.getElementById('stop-run-btn'),
    resumeRunBtn: document.getElementById('resume-run-btn'),
    viewRunResultsBtn: document.getElementById('view-run-results-btn')
  };

  // Order matters: later files depend on earlier ones (selector.js before
  // scraper.js before content.js/autodetect.js; runstate.js/domwait.js
  // before pagination.js). content.js, pagination.js, and autodetect.js
  // each register their own separate chrome.runtime.onMessage listener,
  // so injecting all of them is safe — V1.1/V1.2's picking/extraction
  // messages stay untouched by V1.3/V1.4.
  var CONTENT_FILES = [
    'utils/storage.js',
    'utils/runstate.js',
    'content/selector.js',
    'content/structureddata.js',
    'content/scraper.js',
    'content/domwait.js',
    'content/content.js',
    'content/pagination.js',
    'content/autodetect.js',
    'content/livewatch.js',
    'content/nextdetect.js',
    'content/autoscroll.js',
    'content/autopaginate.js',
    'utils/discovery.js',
    'content/loadmore.js',
    'content/discovery.js'
  ];
  // NEW FEATURE — AUTOMATIC PAGINATION (Auto Next): content/nextdetect.js
  // + content/autopaginate.js. See background.js's identical addition/
  // comment for why these are always safe to inject (inert unless a
  // session has an explicit autoPaginate field) and why this comment
  // deliberately sits outside the array literal.
  // NEW FEATURE — INFINITE SCROLL (Auto Scroll): content/autoscroll.js —
  // same complete-no-op guarantee, gated on an explicit autoScroll
  // field. See content/autoscroll.js's own header comment for how it
  // coexists with Auto Next when both are enabled.
  // NEW FEATURE — AUTOMATIC DATA DISCOVERY ENGINE: utils/discovery.js
  // (pure selection/bookkeeping core, also loaded below in popup.html for
  // processAll()/processFirst(n)) + content/loadmore.js (generic Load
  // More detection/click-to-exhaustion) + content/discovery.js (the
  // orchestrator — see that file's own header for the full design). Same
  // complete-no-op guarantee as the two features above: nothing here is
  // ever invoked unless a session has an explicit `discovery` field,
  // which only handleStartLiveSession's own BAŞLA flow below ever sets.

  var PREVIEW_LIMIT = 30;
  // V1.25 spec #3-4: the Results table has always been windowed at
  // PREVIEW_LIMIT rendered rows regardless of dataset size — the ONE
  // other unbounded per-row DOM render found during this version's
  // performance audit was the Changes/comparison list (renderChangesList),
  // which built one full DOM subtree (+ a click listener) per changed
  // row with no cap at all. This mirrors that same windowing pattern.
  // Set more generously than PREVIEW_LIMIT since a "changes" entry is
  // usually the reason someone opened this view at all.
  var CHANGES_LIST_LIMIT = 300;

  var FILTER_CONDITIONS = [
    { value: 'contains', label: 'Contains' },
    { value: 'not-contains', label: 'Does not contain' },
    { value: 'equals', label: 'Equals' },
    { value: 'not-equals', label: 'Not equals' },
    { value: 'gt', label: 'Greater than' },
    { value: 'lt', label: 'Less than' },
    { value: 'empty', label: 'Is empty' },
    { value: 'not-empty', label: 'Is not empty' }
  ];
  var NO_VALUE_CONDITIONS = ['empty', 'not-empty'];

  var tabId = null;
  var hostname = null;
  var pathname = null;
  var pageUrl = null;
  var state = WSStorage.emptyState();

  var loadedScraperId = null;
  var loadedScraperName = null;
  var loadedScraperResearch = null; // V1.12: the loaded Saved Scraper's saved Research Bundle prefs, if any

  // In-memory results pipeline state — never persisted.
  var rawRows = [];
  var activeFilter = null;   // {columnId, condition, value}
  var activeDedupe = null;   // {mode} — 'entire-row' or a column id
  var activeSort = null;     // {columnId, direction}

  // V1.3 run state (Auto Scroll / Multi-page). Populated from a
  // "Select Next Button" pick or a loaded scraper's saved config; the
  // authoritative run progress itself lives in chrome.storage.session
  // (content/pagination.js), not here — this popup instance just reflects
  // whatever's there and can be closed/reopened freely mid-run.
  var pendingNextButtonConfig = null;
  // V1.19: {kind, key, style, start, step} — reused for BOTH the URL-
  // pattern method's saved config and the pending-detection result the
  // Auto-Detect panel is currently showing (they share the same shape).
  var pendingUrlPatternConfig = null;
  // V1.19: the raw response from the last RUN_PAGINATION_AUTO_DETECT
  // call, kept only long enough for "Use Detected"/"Pick Manually" to
  // act on it — never persisted, mirrors autoDetectResult's own
  // session-only lifetime.
  var lastPaginationDetection = null;
  var storageListenerAttached = false;
  // V1 SIMPLIFIED SESSION WORKFLOW: the current BAŞLA/BİTİR live-collect
  // session for this hostname, mirrored from chrome.storage.session (see
  // ws_live_session::<hostname> below) — null when no session exists yet.
  var activeLiveSession = null;
  var liveSessionListenerAttached = false;
  // Populated once per BAŞLA click by handleStartLiveSession(), read by
  // formatSessionDiagnosticReport()'s "SESSION STORAGE" section. Exists
  // purely so the dev diagnostic can prove the write actually happened
  // (and under which exact key/backend) without re-deriving it later.
  var lastSessionWriteDiagnostic = null;

  // V1.4 Auto Detect: the full detection result is kept in memory for the
  // popup session so switching between candidate structures ("Try Another
  // Structure") is instant, with no extra content-script round trip.
  var autoDetectResult = null;
  var autoDetectSelectedIndex = 0;

  // ---- V1 WORKFLOW REORG: AUTO/MANUAL mode ----
  // 'auto' | 'manual'. Purely a presentation switch (which of
  // #auto-mode-panel / #manual-mode-content is shown) — never clears
  // state.columns/state.containerSelector, so switching back and forth
  // never loses configuration either mode has built. See
  // decideInitialScrapeMode() for how the initial value is chosen.
  // UI SIMPLIFICATION (real regression fix): the #scrape-mode-switch UI
  // control (#mode-auto-btn/#mode-manual-btn) has been removed from
  // popup.html — 'manual' is now the only value this is ever set to
  // (see decideInitialScrapeMode() below), so #manual-mode-content
  // (Auto Detect/Structured Data/Templates/Verileri Çek/Sütunları
  // Sıfırla) is always what's shown. Default changed from 'auto' to
  // 'manual' purely so there's no brief flash of #auto-mode-panel before
  // init() resolves; the AUTO scanning machinery itself is untouched,
  // simply unreachable via UI now.
  var scrapeMode = 'manual';
  // Combined RUN_AUTO_DETECT + SCAN_STRUCTURED_DATA result for the
  // simplified "Scan Page" flow — deliberately a SEPARATE variable from
  // autoDetectResult/structuredDataFields (Manual Mode's own panels)
  // even though it reuses the exact same content-script messages, so
  // switching modes can never leave one panel showing stale data
  // computed for the other. Never persisted (session-only, same
  // lifetime convention as autoDetectResult).
  var autoScanCandidate = null; // { source: 'auto'|'structured', containerSelector, fields: [...] }
  // V1 AUTO RESULT CLEANUP — result of the most recent applyAutoRowQualityFilter()
  // call, session-only, surfaced by "Copy AUTO Diagnostic" (spec #21) so a
  // developer can verify row-cleanup behavior on the real page alongside
  // the detection diagnostic. null until an AUTO extraction has actually run.
  var lastAutoRowQualitySummary = null;

  // V1.5 Bulk Download: which mode the setup panel is currently showing
  // ('image' | 'file'), and whether the download-storage change listener
  // has been attached yet. Actual queue execution lives entirely in
  // background.js — this popup only sends Start/Stop/Retry messages and
  // reflects chrome.storage.session, exactly like V1.3's run progress.
  var downloadKind = null;
  var downloadListenerAttached = false;
  // Research Bundle assets reuse this EXACT SAME zip-run pipeline (V1.12
  // spec #13 — no second downloader; V1.13.2 replaced its actual
  // mechanics with fetch()+zip, see background.js, but the "one shared
  // run slot" design is unchanged), so both features' onChanged
  // listeners share one storage key (ws_zip_run). This flag says which
  // UI currently owns rendering it, so a research-bundle-triggered run
  // never paints over (or gets painted over by) the plain Bulk Download
  // panel, and vice versa — only one of the two can be running at a time
  // anyway (there has only ever been one run slot, since V1.5).
  var activeDownloadPurpose = null; // 'bulk' | 'research' | null

  // V1.6 Change Detection: which unique-key preference a loaded Saved
  // Scraper carries (mirrors loadedDownloadColumn's pattern), and the
  // in-memory result of the last comparison run — never persisted itself,
  // only the snapshots it was built from are (see utils/snapshots.js).
  var loadedCompareKey = null;
  var lastComparisonResult = null;
  var changesActiveFilter = 'all';

  // V1.7 Transform pipeline: ordered CONFIG list only (never transformed
  // data itself) — see utils/transforms.js's header for the full
  // non-destructive rationale. rawRows is never touched; every render
  // re-derives the transformed (rows, columns) pair from scratch, cached
  // until something invalidates it.
  var activeTransforms = [];       // [{id, type, column, options, rowIndices?}]
  var transformResultCache = null; // {rows, columns} | null
  var loadedAutoApplyTransforms = null;

  function isSupportedUrl(url) {
    if (!url) return false;
    return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
  }

  /**
   * V1.13: `type` is an optional third argument ('success'|'warning'|
   * 'error'|'running') that standardizes the visual feedback pattern
   * (spec #11) — but is entirely additive: every pre-V1.13 call site
   * still passes just (msg, isError) and renders EXACTLY as before
   * (isError true -> red "error" styling, false -> plain neutral, same
   * as always). New/updated call sites can opt into the fuller
   * vocabulary by passing a type explicitly. Text is always shown
   * regardless of type — color is never the only signal.
   */
  function setStatus(msg, isError, type) {
    if (!msg) {
      els.statusMsg.hidden = true;
      return;
    }
    els.statusMsg.hidden = false;
    els.statusMsg.textContent = msg;
    var resolvedType = type || (isError ? 'error' : null);
    els.statusMsg.classList.toggle('ws-status-error', resolvedType === 'error');
    els.statusMsg.classList.toggle('ws-status-success', resolvedType === 'success');
    els.statusMsg.classList.toggle('ws-status-warning', resolvedType === 'warning');
    els.statusMsg.classList.toggle('ws-status-running', resolvedType === 'running');
  }

  /** V1.14 spec #7 error-message audit: a handful of catch blocks show
   * `e.message` directly to the user (transform validation, background
   * message round-trips). Most of the time that message is already
   * clean, app-authored text (e.g. WSTransforms' own validation errors),
   * but a genuinely unexpected exception can surface a raw, developer-
   * looking message (a TypeError, "message port closed", etc.) — this
   * filters those out to `fallback` while the ORIGINAL message always
   * still goes to console.error for real debugging. Deliberately a small
   * denylist of technical-looking patterns rather than an allowlist, so
   * a genuinely useful app-authored message (most of them) still reaches
   * the user unchanged. */
  function friendlyErrorMessage(e, fallback) {
    var raw = (e && e.message) || String(e);
    console.error('[Web Scraper]', raw, e && e.stack);
    var looksTechnical = /^(TypeError|ReferenceError|RangeError|SyntaxError)\b/.test(raw) ||
      /Cannot read propert(y|ies)|is not a function|is not defined|undefined is not|null is not|Extension context invalidated|message port closed|Receiving end does not exist/i.test(raw);
    return looksTechnical ? fallback : raw;
  }

  // Sends a message to the content script, injecting it on demand the
  // first time (activeTab grants us permission for the current tab
  // because the popup was opened via the toolbar icon).
  //
  // Also retries with a fresh injection when the FIRST attempt resolves
  // with no response at all (falsy), not just when it throws. A thrown
  // error only covers "no content script is present in this tab yet" —
  // but a tab can also already have an OLDER content-script instance
  // resident (injected earlier in this same tab's lifetime, before this
  // build added a given message type, e.g. across a "Reload extension"
  // where the page itself was never refreshed). That stale listener
  // still answers messages it recognizes, so chrome.tabs.sendMessage
  // never rejects — it just resolves with `undefined` for any message
  // type the stale script doesn't know about, which looks identical to
  // "delivered successfully" unless the response is checked. Every
  // content-script handler in this codebase always replies with a
  // truthy {ok:true/false, ...} object (never a legitimate falsy
  // response — see scripts/release-check.js's own audit of this), so a
  // falsy result here is always exactly "nobody actually handled this" —
  // safe to treat identically to a thrown "no receiver" error and retry
  // once against a freshly-injected, definitely-current copy.
  async function sendToContent(message) {
    var res;
    try {
      res = await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      res = undefined;
    }
    if (!res) {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: CONTENT_FILES });
      res = await chrome.tabs.sendMessage(tabId, message);
    }
    return res;
  }

  // NEW FEATURE — DATA CLEANING ENGINE: the 5 selectable column types
  // (mission spec #2), in the exact order the mission's own example UI
  // mockup lists them. 'raw' is always first/default — matches every
  // other "off by default" control in this popup (Auto Next/Auto Scroll
  // toggles, etc.).
  var CLEANER_TYPE_OPTIONS = [
    { value: 'raw', label: 'Raw' },
    { value: 'text', label: 'Text' },
    { value: 'price', label: 'Price' },
    { value: 'number', label: 'Number' },
    { value: 'url', label: 'URL' }
  ];

  function attrLabel(attr) {
    if (attr === 'href') return 'Link';
    if (attr === 'src') return 'Image';
    if (attr === 'alt') return 'Alt';
    if (attr === 'html') return 'HTML';
    if (attr === 'attr') return 'Attribute';
    if (attr === 'structured') return 'Structured'; // V1.21
    return 'Text';
  }

  // V1.21: a structured column (attribute:'structured') carries its own
  // `structuredKind` ('image'|'url'|'text', set when the field was
  // added from the Structured Data inspector) rather than the DOM
  // engine's attribute enum — these two predicates let every existing
  // "is this an image/link column?" call site recognize a structured
  // image/URL field too, without needing to touch every call site's own
  // logic individually. Never treats a plain-text structured field
  // (kind:'text' or unset) as an image/link — only an honest, explicit
  // kind counts.
  function isImageLikeColumn(c) {
    return c.attribute === 'src' || (c.attribute === 'structured' && c.structuredKind === 'image');
  }
  function isLinkLikeColumn(c) {
    return c.attribute === 'href' || (c.attribute === 'structured' && c.structuredKind === 'url');
  }

  // V1.17 #6: display label for WSSelector.detectFieldType()'s output —
  // metadata only, shown next to a detected field so a mis-guessed type
  // is obvious before running a large scrape (spec #11).
  function fieldTypeLabel(fieldType) {
    if (fieldType === 'currency') return 'Currency-like';
    if (fieldType === 'number') return 'Number-like';
    if (fieldType === 'url') return 'URL';
    if (fieldType === 'date') return 'Date-like';
    if (fieldType === 'image') return 'Image';
    return '';
  }

  function safeHostForFilename() {
    return (hostname || 'export').replace(/[^a-z0-9.-]/gi, '_');
  }

  function persistState() {
    return WSStorage.setState(hostname, state);
  }

  function clearResults() {
    rawRows = [];
    activeFilter = null;
    activeDedupe = null;
    activeSort = null;
    activeTransforms = [];
    transformResultCache = null;
    loadedAutoApplyTransforms = null;
    // V1.18: a fresh scrape means fresh rows with no merged detail data
    // yet — previously-merged deep-scrape columns would otherwise
    // silently linger with stale/misaligned values.
    deepScrapeColumns = [];
    if (els.dsProgressSection) els.dsProgressSection.hidden = true;
    els.previewSection.hidden = true;
    els.filterPanel.hidden = true;
    els.sortPanel.hidden = true;
    els.dedupePanel.hidden = true;
    els.snapshotsPanel.hidden = true;
    els.transformPanel.hidden = true;
    els.exportOptionsPanel.hidden = true;
    els.changesSection.hidden = true;
    lastComparisonResult = null;
    updateScrapeWorkflowStatus();
    updateResultsEmptyState();
    updateResearchTabState();
  }

  // =====================================================================
  // Columns (V1.1 rename/delete preserved as-is; reorder is new in V1.2
  // and only ever moves entries within state.columns — it never touches a
  // column's relativeSelector/attribute, so Preview/CSV/XLSX/JSON/Copy all
  // automatically pick up the new order since they all iterate
  // state.columns directly.)
  // =====================================================================

  function moveColumn(index, delta) {
    var newIndex = index + delta;
    if (newIndex < 0 || newIndex >= state.columns.length) return;
    var cols = state.columns;
    var tmp = cols[index];
    cols[index] = cols[newIndex];
    cols[newIndex] = tmp;
    persistState();
    renderColumns();
  }

  /** V1.13.1: also keeps the small "Editing: X" / "Unsaved configuration"
   * status line in sync, and makes whichever of Update/Save is the
   * current primary action LOOK primary (spec #2/#7) — a scraper loaded
   * for editing should never leave the user guessing whether they're
   * working on a saved recipe or a throwaway configuration. */
  function updateScraperButtonsVisibility() {
    var hasColumns = state.columns.length > 0;
    els.saveScraperBtn.hidden = !hasColumns;
    els.saveScraperBtn.textContent = loadedScraperId ? '💾 Save as New Scraper' : '💾 Save Scraper';
    if (loadedScraperId && hasColumns) {
      els.updateScraperBtn.hidden = false;
      els.updateScraperBtn.textContent = '🔄 Update "' + (loadedScraperName || '') + '"';
    } else {
      els.updateScraperBtn.hidden = true;
    }
    setButtonVariant(els.updateScraperBtn, !!loadedScraperId);
    setButtonVariant(els.saveScraperBtn, !loadedScraperId);
    if (els.scraperLoadStatus) {
      els.scraperLoadStatus.textContent = loadedScraperId
        ? 'Editing: "' + (loadedScraperName || '') + '"'
        : 'Unsaved configuration';
    }
  }

  /** Swaps a button between primary/secondary styling — both classes are
   * toggled explicitly (never just adding ws-btn-primary on top of an
   * existing ws-btn-secondary) since CSS source order would otherwise
   * let the secondary rule silently win. */
  function setButtonVariant(btn, isPrimary) {
    if (!btn) return;
    btn.classList.toggle('ws-btn-primary', isPrimary);
    btn.classList.toggle('ws-btn-secondary', !isPrimary);
  }

  function renderColumns() {
    els.columnsList.innerHTML = '';
    els.columnsEmpty.hidden = state.columns.length > 0;

    state.columns.forEach(function (col, index) {
      var li = document.createElement('li');
      li.className = 'ws-column-row';

      var reorderGroup = document.createElement('div');
      reorderGroup.className = 'ws-reorder-group';
      var upBtn = document.createElement('button');
      upBtn.className = 'ws-column-reorder';
      upBtn.textContent = '▲';
      upBtn.title = 'Move up'; upBtn.setAttribute('aria-label', 'Move up');
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', function () { moveColumn(index, -1); });
      var downBtn = document.createElement('button');
      downBtn.className = 'ws-column-reorder';
      downBtn.textContent = '▼';
      downBtn.title = 'Move down'; downBtn.setAttribute('aria-label', 'Move down');
      downBtn.disabled = index === state.columns.length - 1;
      downBtn.addEventListener('click', function () { moveColumn(index, 1); });
      reorderGroup.appendChild(upBtn);
      reorderGroup.appendChild(downBtn);

      var nameInput = document.createElement('input');
      nameInput.className = 'ws-column-name';
      nameInput.value = col.name;
      nameInput.addEventListener('change', function () {
        // Renaming only ever touches display/export name — the selector
        // and attribute that make extraction work are untouched.
        var newName = nameInput.value.trim() || col.name;
        col.name = newName;
        nameInput.value = newName;
        persistState();
      });

      var tag = document.createElement('span');
      tag.className = 'ws-column-tag';
      tag.textContent = attrLabel(col.attribute);

      // NEW FEATURE — DATA CLEANING ENGINE: optional per-column cleaner
      // type, OFF (RAW) by default. Purely additive to the existing
      // attribute tag above — selectors/extraction are never touched by
      // this control, only col.cleanerType (mission spec #2: "reuse the
      // existing attribute/type area cleanly... do not create
      // unnecessary new screens" — this IS that reuse: one more small
      // control on the same existing column row).
      var cleanSelect = document.createElement('select');
      cleanSelect.className = 'ws-column-clean-select';
      cleanSelect.title = 'How should this column’s value be cleaned?';
      CLEANER_TYPE_OPTIONS.forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        cleanSelect.appendChild(o);
      });
      cleanSelect.value = col.cleanerType || 'raw';
      cleanSelect.addEventListener('change', function () {
        col.cleanerType = cleanSelect.value;
        persistState();
        invalidateTransformCache();
        renderSetupPreviewTable();
        renderResults();
      });

      var delBtn = document.createElement('button');
      delBtn.className = 'ws-column-delete';
      delBtn.textContent = '×';
      delBtn.title = 'Delete column'; delBtn.setAttribute('aria-label', 'Delete column');
      delBtn.addEventListener('click', function () {
        state.columns = state.columns.filter(function (c) { return c.id !== col.id; });
        if (state.columns.length === 0) state.containerSelector = null;
        persistState();
        renderColumns();
        clearResults();
      });

      li.appendChild(reorderGroup);
      li.appendChild(nameInput);
      li.appendChild(tag);
      li.appendChild(cleanSelect);
      li.appendChild(delBtn);
      els.columnsList.appendChild(li);
    });

    updateScraperButtonsVisibility();
    updateScrapeWorkflowStatus();
    renderSetupPreviewTable();
  }

  /** V1 SIMPLIFIED SESSION WORKFLOW: "Did I connect each column to the
   * correct data?" — a ONE-ROW preview built ENTIRELY from each column's
   * own sampleValue (captured on the page at the exact moment the user
   * clicked that example — see content/content.js's Add Column save
   * path), never a fresh page query. Deliberately does not re-scan the
   * page: a column with no sampleValue yet (an older saved scraper from
   * before this field existed, or a column added via Auto Detect/
   * Templates/Structured Data rather than a page click) simply shows a
   * placeholder dash, never a fabricated or re-derived value. */
  function renderSetupPreviewTable() {
    if (!els.setupPreviewWrap || !els.setupPreviewTable) return;
    if (!state.columns.length) { els.setupPreviewWrap.hidden = true; return; }
    els.setupPreviewWrap.hidden = false;
    var table = els.setupPreviewTable;
    table.innerHTML = '';
    var headRow = document.createElement('tr');
    state.columns.forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = c.name;
      headRow.appendChild(th);
    });
    var bodyRow = document.createElement('tr');
    state.columns.forEach(function (c) {
      var td = document.createElement('td');
      // NEW FEATURE — DATA CLEANING ENGINE: this one-row setup preview
      // reflects the selected cleaner type too (mission spec #19:
      // "Preview should reflect the selected cleaning type... changing
      // type should update preview without requiring the user to
      // redefine the selector") — same typeof guard as
      // applyColumnCleaners, same "never fabricate" contract; an absent
      // sampleValue still shows the placeholder dash, never a cleaned
      // guess derived from nothing.
      var type = effectiveCleanerType(c);
      var display = c.sampleValue;
      if (display && type !== 'raw' && typeof WSCleaners !== 'undefined') {
        try { display = WSCleaners.applyCleaner(type, display, { baseUrl: pageUrl }); }
        catch (e) { /* fall back to the raw sample value */ }
      }
      td.textContent = display || '—';
      td.title = display || '';
      bodyRow.appendChild(td);
    });
    table.appendChild(headRow);
    table.appendChild(bodyRow);
  }

  async function loadState() {
    state = await WSStorage.getState(hostname);
    renderColumns();
  }

  async function handleAddColumn() {
    setStatus('Preparing selection mode…', false);
    try {
      await sendToContent({ type: 'START_PICK' });
      setStatus('Click an element on the page to select it (Esc to cancel).', false);
    } catch (e) {
      setStatus("Couldn't start selection on this page.", true);
    }
  }

  async function handleResetColumns() {
    if (!confirm('Remove all columns saved for this site?')) return;
    await WSStorage.clearState(hostname);
    state = WSStorage.emptyState();
    loadedScraperId = null;
    loadedScraperName = null;
    loadedDownloadColumn = null;
    loadedCompareKey = null;
    loadedScraperResearch = null;
    deepScrapeConfig = WSRecipes.emptyDeepScrape();
    renderDeepScrapePanel();
    await WSRecipes.setLoadedScraperId(hostname, null);
    renderColumns();
    clearResults();
    setStatus('Columns cleared.', false);
  }

  // =====================================================================
  // Auto Detect (V1.4): a second, optional entry point alongside manual
  // Add Column. Detection runs entirely in content/autodetect.js using
  // classical DOM heuristics — no AI, no site-specific code. Nothing here
  // touches state.columns until the user explicitly clicks
  // "Use Selected Fields"; Cancel leaves the current configuration
  // completely untouched. Once applied, the resulting columns are
  // ordinary columns — rename/delete/reorder/Filter/Sort/exports all
  // already work on them with zero additional code.
  // =====================================================================

  function currentAutoDetectStructure() {
    return autoDetectResult && autoDetectResult.structures[autoDetectSelectedIndex];
  }

  async function handleAutoDetect() {
    setStatus('Analyzing page… finding repeating structures…', false);
    var res;
    try {
      res = await sendToContent({ type: 'RUN_AUTO_DETECT' });
    } catch (e) {
      setStatus("Couldn't analyze this page.", true);
      return;
    }
    if (!res || !res.ok || !res.structures || !res.structures.length) {
      setStatus('No strong repeating structure detected. Use "+ Add Column" to select fields manually.', true);
      return;
    }
    autoDetectResult = res;
    autoDetectSelectedIndex = 0;
    els.previewSection.hidden = true;
    renderAutoDetectPanel();
    setStatus(res.scannedTruncated ? 'Analysis stopped early on this large page — results may be partial.' : '', !!res.scannedTruncated);
  }

  function renderAutoDetectPanel() {
    var structure = currentAutoDetectStructure();
    if (!structure) return;
    els.autoDetectPanel.hidden = false;

    els.adConfidenceBadge.textContent = structure.confidence;
    els.adConfidenceBadge.className = 'ws-status-badge ws-conf-' + structure.confidence.toLowerCase();

    els.adStructureSelect.innerHTML = '';
    autoDetectResult.structures.forEach(function (s, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = s.label + ' — ' + s.itemCount + ' item' + (s.itemCount === 1 ? '' : 's') + ' (' + s.confidence + ')';
      if (i === autoDetectSelectedIndex) opt.selected = true;
      els.adStructureSelect.appendChild(opt);
    });
    // V1.17 #11: "Detected dataset: N rows, M columns" — makes the shape
    // of what's about to be scraped obvious before the user commits,
    // same spirit as spec's own worked example.
    els.adStructureMeta.textContent = 'Detected dataset: ' + structure.itemCount + ' row' + (structure.itemCount === 1 ? '' : 's') +
      ', ' + structure.fields.length + ' column' + (structure.fields.length === 1 ? '' : 's');

    els.adFieldsList.innerHTML = '';
    structure.fields.forEach(function (field, idx) {
      var row = document.createElement('label');
      row.className = 'ws-ad-field-row';

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.fieldIndex = String(idx);
      checkbox.addEventListener('change', runAutoDetectPreview);

      var main = document.createElement('div');
      main.className = 'ws-ad-field-main';

      var nameRow = document.createElement('div');
      nameRow.className = 'ws-ad-field-name-row';
      var nameEl = document.createElement('span');
      nameEl.className = 'ws-ad-field-name';
      nameEl.textContent = field.name;
      var coverageEl = document.createElement('span');
      coverageEl.className = 'ws-ad-field-coverage';
      coverageEl.textContent = Math.round(field.coverage * 100) + '% coverage';
      nameRow.appendChild(nameEl);
      nameRow.appendChild(coverageEl);
      // V1.17 #6/#12: informational-only field-type + selector-quality
      // tags — never affect what's extracted, just help the user spot a
      // mis-detected field before running a large scrape (spec #11).
      if (field.fieldType && field.fieldType !== 'text' && field.fieldType !== 'empty') {
        var typeEl = document.createElement('span');
        typeEl.className = 'ws-ad-field-type';
        typeEl.textContent = fieldTypeLabel(field.fieldType);
        nameRow.appendChild(typeEl);
      }
      if (field.quality && field.quality.label === 'Fragile') {
        var qualityEl = document.createElement('span');
        qualityEl.className = 'ws-ad-field-quality-warn';
        qualityEl.textContent = 'Fragile selector';
        qualityEl.title = (field.quality.reasons || []).join('; ');
        nameRow.appendChild(qualityEl);
      }

      var sampleEl = document.createElement('div');
      sampleEl.className = 'ws-ad-field-sample';
      sampleEl.textContent = field.samples && field.samples[0] ? 'Sample: ' + field.samples[0] : '(no sample value)';
      sampleEl.title = sampleEl.textContent;

      main.appendChild(nameRow);
      main.appendChild(sampleEl);
      row.appendChild(checkbox);
      row.appendChild(main);
      els.adFieldsList.appendChild(row);
    });

    runAutoDetectPreview();
  }

  function getCheckedAutoDetectFields() {
    var structure = currentAutoDetectStructure();
    if (!structure) return [];
    var checkboxes = els.adFieldsList.querySelectorAll('input[type="checkbox"]');
    var checked = [];
    checkboxes.forEach(function (cb) {
      if (cb.checked) checked.push(structure.fields[parseInt(cb.dataset.fieldIndex, 10)]);
    });
    return checked;
  }

  async function runAutoDetectPreview() {
    var structure = currentAutoDetectStructure();
    var fields = getCheckedAutoDetectFields();
    if (!structure || !fields.length) {
      els.adPreviewTable.innerHTML = '';
      return;
    }
    var columns = fields.map(function (f, i) { return { id: 'ad_' + i, name: f.name, relativeSelector: f.relativeSelector, attribute: f.attribute }; });
    var res;
    try {
      res = await sendToContent({ type: 'PREVIEW_STRUCTURE', containerSelector: structure.containerSelector, columns: columns });
    } catch (e) {
      return;
    }
    if (!res || !res.ok) return;
    buildPreviewTable(columns, res.rows, 5, els.adPreviewTable);
  }

  function handleCancelAutoDetect() {
    autoDetectResult = null;
    els.autoDetectPanel.hidden = true;
    setStatus('');
  }

  async function handleUseAutoDetectFields() {
    var structure = currentAutoDetectStructure();
    var fields = getCheckedAutoDetectFields();
    if (!structure || !fields.length) {
      setStatus('Select at least one field first.', true);
      return;
    }
    state = {
      containerSelector: structure.containerSelector,
      columns: fields.map(function (f) {
        return { id: WSStorage.makeColumnId(), name: f.name, relativeSelector: f.relativeSelector, attribute: f.attribute };
      })
    };
    await persistState();
    loadedScraperId = null;
    loadedScraperName = null;
    deepScrapeConfig = WSRecipes.emptyDeepScrape();
    renderDeepScrapePanel();
    await WSRecipes.setLoadedScraperId(hostname, null);
    renderColumns();
    clearResults();
    autoDetectResult = null;
    els.autoDetectPanel.hidden = true;
    setStatus(fields.length + ' column' + (fields.length === 1 ? '' : 's') + ' applied from Auto Detect.', false);
  }

  // =====================================================================
  // V1 WORKFLOW REORG — AUTO mode ("Scan Page" -> "Extract Data").
  // Deliberately NOT a second scraping engine: "Scan Page" reuses the
  // exact same RUN_AUTO_DETECT / SCAN_STRUCTURED_DATA content-script
  // messages Manual Mode's Auto Detect / Structured Data panels already
  // use, and "Extract Data" reuses the exact same handlePreview() (trial
  // gate -> RUN_EXTRACTION -> chargeRunCredit -> renderResults) Manual
  // Mode's own Preview button already uses. This is what guarantees AUTO
  // and MANUAL share one trial counter and one scraping pipeline (spec
  // #13): scanning never calls chargeRunCredit at all, and Extract Data
  // charges through literally the same function call Manual Mode does.
  // =====================================================================

  function renderScrapeMode() {
    var isAuto = scrapeMode === 'auto';
    if (els.autoModePanel) els.autoModePanel.hidden = !isAuto;
    if (els.manualModeContent) els.manualModeContent.hidden = isAuto;
    if (els.modeAutoBtn) els.modeAutoBtn.setAttribute('aria-pressed', isAuto ? 'true' : 'false');
    if (els.modeManualBtn) els.modeManualBtn.setAttribute('aria-pressed', isAuto ? 'false' : 'true');
  }

  /** Switches the visible panel and (unless this is a session-only,
   * automatic switch — see decideInitialScrapeMode()) persists the
   * choice as the user's explicit future default via WSSettings, exactly
   * mirroring how WSI18n.setLanguage()/the language selector work. Never
   * touches state.columns/state.containerSelector/rawRows — purely a
   * presentation switch (spec #8: "both modes ultimately use the same
   * proven scraping pipeline"). */
  async function setScrapeModeUi(mode, opts) {
    opts = opts || {};
    if (mode !== 'auto' && mode !== 'manual') return;
    scrapeMode = mode;
    renderScrapeMode();
    if (!opts.sessionOnly) {
      try { await WSSettings.setScrapeMode(mode); } catch (e) { /* best-effort — the in-memory mode for THIS session already switched */ }
    }
  }

  /** spec #11: "if a saved scraper is opened, Manual Mode may
   * automatically become active." Interpreted as: if THIS host already
   * has a loaded saved scraper or any manually-built columns (restored
   * by loadState() before init() calls this), open straight into Manual
   * so nothing already configured is ever hidden behind AUTO. This is a
   * SESSION-ONLY decision (setScrapeModeUi(..., {sessionOnly:true})) —
   * it never overwrites the user's stored default, so a brand-new
   * tab/host still opens in whatever they last explicitly chose.
   *
   * UI SIMPLIFICATION (real regression fix): the #scrape-mode-switch UI
   * control that let a user choose AUTO has been removed from
   * popup.html entirely — this now always resolves 'manual' regardless
   * of a stored WSSettings.scrapeMode value from before this change
   * (which could still say 'auto' for an existing install), so
   * #manual-mode-content is always what's shown under "Gelişmiş". The
   * AUTO scanning machinery itself (#auto-mode-panel, RUN_AUTO_DETECT,
   * handleScanPage/handleAutoExtract) is untouched — simply unreachable
   * via UI now that its entry-point buttons are gone, exactly like every
   * other "hidden, not deleted" advanced control. */
  async function decideInitialScrapeMode() {
    return 'manual';
  }

  function setAutoScanStatus(msg, isError) {
    if (!els.autoScanStatus) return;
    els.autoScanStatus.textContent = msg || '';
    els.autoScanStatus.classList.toggle('ws-tf-error', !!isError);
  }

  /** "Scan Page" — combines the two EXISTING detection signals (spec
   * #15: "combine the useful signals already implemented"), preferring
   * a genuine repeating DOM structure (the common listing/search-
   * results/table/directory case) and falling back to page-level
   * structured data (JSON-LD/meta — the common single-product/article
   * detail-page case) only when no strong repeating structure was
   * found. Never fabricates a result: if neither signal finds anything,
   * this says so plainly (spec #15: "never pretend detection succeeded
   * when it did not") rather than showing an empty/misleading panel. */
  /** V1 AUTO DETECTION IMPROVEMENT spec #17-18's fixtures / spec #10:
   * a structure only counts as a genuine candidate when it both repeats
   * (itemCount >= 2) AND clears a low score floor — a 2-element fluke
   * match with a near-zero score is exactly the "no meaningful dataset"
   * case spec #10 wants named honestly, not silently offered as if it
   * were real data. `structures` is already sorted by score (desc) by
   * content/autodetect.js's own runAutoDetect(). */
  function viableAutoDetectStructures(structures) {
    return (structures || []).filter(function (s) { return s.itemCount >= 2 && (typeof s.score !== 'number' || s.score >= 20); });
  }

  function buildAutoScanCandidateFromStructure(structure) {
    return {
      source: 'auto',
      containerSelector: structure.containerSelector,
      itemCount: structure.itemCount,
      confidence: structure.confidence,
      label: structure.label,
      // V1 AUTO RESULT CLEANUP spec #13: row-quality classification is
      // never applied to table-detected structures (existing table row/
      // header logic already handles those correctly) — tracked here,
      // read by handleAutoExtract() before it gets cleared.
      isTable: structure.label === 'Table Rows',
      fields: structure.fields.map(function (f) {
        // A field is unchecked by default only when the detector's OWN
        // metadata already flags it as unreliable — never a hardcoded
        // field-name allowlist/denylist (spec #12 "Automatically
        // preselect only strong/high-value fields... do not preselect
        // junk fields merely to show more data").
        // spec #12 "Automatically preselect only strong/high-value
        // fields... do not preselect junk fields merely to show more
        // data" — combines selector fragility, low coverage, AND (spec
        // #5) a field whose value barely varies row-to-row (uniqueness
        // near 0 across 3+ sampled rows is a repeated badge/boilerplate
        // label, not real per-item data). Every signal comes from the
        // detector's own measurements — never a field-name check.
        var lowUniqueness = typeof f.uniqueness === 'number' && f.uniqueness < 0.2 && (f.samples || []).length >= 3;
        var lowConfidenceField = (f.quality && f.quality.label === 'Fragile') || (typeof f.coverage === 'number' && f.coverage < 0.5) || lowUniqueness;
        return { name: f.name, relativeSelector: f.relativeSelector, attribute: f.attribute, sampleText: (f.samples && f.samples[0]) || '', defaultChecked: !lowConfidenceField };
      })
    };
  }

  async function handleScanPage() {
    els.autoScanResult.hidden = true;
    if (els.autoScanCandidates) els.autoScanCandidates.hidden = true;
    autoScanCandidate = null;
    setAutoScanStatus(WSI18n.t('autoMode.scanning'), false);
    if (els.scanPageBtn) els.scanPageBtn.disabled = true;
    var alternateStructure = null;
    try {
      var adRes = null, sdRes = null;
      try { adRes = await sendToContent({ type: 'RUN_AUTO_DETECT' }); } catch (e) { adRes = null; }
      var viable = viableAutoDetectStructures(adRes && adRes.ok ? adRes.structures : null);
      if (viable.length) {
        autoScanCandidate = buildAutoScanCandidateFromStructure(viable[0]);
        // spec #3/#11: only offer a second candidate when the top two are
        // a genuinely close call — never for a clear winner, so the
        // common case stays a single click with nothing extra to read.
        if (viable.length > 1 && typeof viable[0].score === 'number' && typeof viable[1].score === 'number' && (viable[0].score - viable[1].score) <= 15) {
          alternateStructure = viable[1];
        }
        renderAutoScanCandidatePicker(viable[0], alternateStructure);
      } else {
        try { sdRes = await sendToContent({ type: 'SCAN_STRUCTURED_DATA' }); } catch (e) { sdRes = null; }
        if (sdRes && sdRes.ok && sdRes.fields && sdRes.fields.length) {
          autoScanCandidate = {
            source: 'structured',
            containerSelector: null,
            itemCount: 1,
            confidence: 'Medium',
            label: null,
            fields: sdRes.fields.map(function (f) {
              return { name: f.label, structuredPath: f.path, structuredKind: f.kind || 'text', sampleText: f.sampleValue || '', defaultChecked: true };
            })
          };
        }
      }
    } finally {
      if (els.scanPageBtn) els.scanPageBtn.disabled = false;
    }

    if (!autoScanCandidate || !autoScanCandidate.fields.length) {
      setAutoScanStatus(WSI18n.t('autoMode.noneDetected'), true);
      return;
    }
    setAutoScanStatus('', false);
    renderAutoScanResult();
  }

  /** spec #3/#11 — a small, optional picker shown ONLY when two datasets
   * are close enough in score to be a genuine judgment call. Selecting a
   * different candidate re-renders the field checklist/preview for it
   * (no re-scan needed — both structures were already returned by the
   * one RUN_AUTO_DETECT call). Defaults to the strongest candidate. */
  function renderAutoScanCandidatePicker(topStructure, alternateStructure) {
    if (!els.autoScanCandidates || !els.autoScanCandidatesList) return;
    if (!alternateStructure) {
      els.autoScanCandidates.hidden = true;
      els.autoScanCandidatesList.innerHTML = '';
      return;
    }
    els.autoScanCandidates.hidden = false;
    els.autoScanCandidatesList.innerHTML = '';
    [topStructure, alternateStructure].forEach(function (structure, idx) {
      var row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;font-weight:400;text-transform:none;font-size:12.5px;color:#374151;';
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'auto-scan-candidate';
      radio.checked = idx === 0;
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        autoScanCandidate = buildAutoScanCandidateFromStructure(structure);
        renderAutoScanResult();
      });
      var text = document.createElement('span');
      text.textContent = (structure.label || 'Items') + ' — ' + structure.itemCount + (structure.itemCount === 1 ? ' item' : ' items');
      row.appendChild(radio);
      row.appendChild(text);
      els.autoScanCandidatesList.appendChild(row);
    });
  }

  function getCheckedAutoScanFields() {
    if (!autoScanCandidate || !els.autoScanFieldsList) return [];
    var checkboxes = els.autoScanFieldsList.querySelectorAll('input[type="checkbox"]');
    var checked = [];
    checkboxes.forEach(function (cb) {
      if (cb.checked) checked.push(autoScanCandidate.fields[parseInt(cb.dataset.fieldIndex, 10)]);
    });
    return checked;
  }

  function buildAutoScanColumns(fields) {
    if (autoScanCandidate.source === 'auto') {
      return fields.map(function (f) { return { id: WSStorage.makeColumnId(), name: f.name, relativeSelector: f.relativeSelector, attribute: f.attribute }; });
    }
    return fields.map(function (f) { return { id: WSStorage.makeColumnId(), name: f.name, relativeSelector: null, attribute: 'structured', structuredPath: f.structuredPath, structuredKind: f.structuredKind }; });
  }

  function renderAutoScanResult() {
    var candidate = autoScanCandidate;
    if (!candidate) return;
    els.autoScanResult.hidden = false;
    // spec #10: "If confidence is low, tell the user" — shown whenever
    // the detector's own confidence is Low (content/autodetect.js's
    // scoreToConfidence returns 'High'/'Medium'/'Low', capitalized — a
    // previous version of this check compared against lowercase 'low'
    // and could never actually match a real DOM structure's confidence;
    // fixed here), OR this came from the structured-data fallback
    // (inherently less certain than a genuine repeating-structure match,
    // since it's a single inferred record rather than N observed,
    // cross-checked repetitions).
    var confidenceIsLow = typeof candidate.confidence === 'string' && candidate.confidence.toLowerCase() === 'low';
    els.autoScanLowConfidenceNote.hidden = !(confidenceIsLow || candidate.source === 'structured');
    els.autoScanSummary.textContent = WSI18n.t('autoMode.itemsDetected', { count: candidate.itemCount });

    els.autoScanFieldsList.innerHTML = '';
    candidate.fields.forEach(function (field, idx) {
      var row = document.createElement('label');
      row.className = 'ws-ad-field-row';

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = field.defaultChecked !== false;
      checkbox.dataset.fieldIndex = String(idx);
      checkbox.addEventListener('change', function () {
        updateAutoExtractButtonState();
        renderAutoScanPreview();
      });

      var main = document.createElement('div');
      main.className = 'ws-ad-field-main';
      var nameRow = document.createElement('div');
      nameRow.className = 'ws-ad-field-name-row';
      var nameEl = document.createElement('span');
      nameEl.className = 'ws-ad-field-name';
      nameEl.textContent = field.name;
      nameRow.appendChild(nameEl);
      var sampleEl = document.createElement('div');
      sampleEl.className = 'ws-ad-field-sample';
      sampleEl.textContent = field.sampleText ? 'Sample: ' + field.sampleText : '(no sample value)';
      sampleEl.title = sampleEl.textContent;

      main.appendChild(nameRow);
      main.appendChild(sampleEl);
      row.appendChild(checkbox);
      row.appendChild(main);
      els.autoScanFieldsList.appendChild(row);
    });

    updateAutoExtractButtonState();
    renderAutoScanPreview();
    revealAutoDiagPanelIfDev();
  }

  /** V1 AUTO DETECTION DIAGNOSTICS — reveals the dev-only "Copy AUTO
   * Diagnostic" control after a scan, but ONLY on an unpacked/development
   * install (chrome.management.getSelf().installType==='development'),
   * exactly the same real-time check + gate every other dev/QA-only
   * control in this project already uses (see handleOpenSettings()'s
   * settings-dev-switcher reveal). Never cached at init — checked fresh
   * each time a scan completes, same as the Settings panel's own check
   * every time it opens. Fire-and-forget (not awaited by the synchronous
   * renderAutoScanResult() that calls this) — a one-tick-later reveal of
   * a debugging control is invisible in practice and keeps the render
   * path itself synchronous. */
  async function revealAutoDiagPanelIfDev() {
    if (!els.autoDiagPanel) return;
    var isDev = false;
    try { isDev = await WSLicense.isDevelopmentInstall(); } catch (e) { isDev = false; }
    els.autoDiagPanel.hidden = !isDev;
  }

  function formatAutoDiagnosticReport(report) {
    var lines = [];
    lines.push('=== AUTO Detection Diagnostic ===');
    lines.push('Generated: ' + report.generatedAt);
    lines.push('URL: ' + report.url);
    lines.push('document.readyState: ' + report.documentReadyState);
    lines.push('Extension version: ' + (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '?'));
    lines.push('');
    // V1 AUTO RESULT CLEANUP spec #21: only present once an AUTO
    // extraction has actually run in this popup session (Scan Page alone
    // never populates this) — a null section here just means Extract
    // Data hasn't been clicked yet in this session.
    lines.push('--- Row Quality (most recent AUTO extraction in this session) ---');
    if (lastAutoRowQualitySummary) {
      var rq = lastAutoRowQualitySummary;
      lines.push('Raw extracted row count: ' + rq.rawCount);
      lines.push('Accepted row count: ' + (rq.rawCount - rq.excludedCount));
      lines.push('Excluded row count: ' + rq.excludedCount);
      lines.push('Flagged row count: ' + rq.flaggedCount);
      lines.push('Dominant row-shape summary: ' + JSON.stringify(rq.dominantShape));
      lines.push('Excluded rows (reasons): ' + JSON.stringify(rq.excludedDetail));
      lines.push('Flagged rows (reasons): ' + JSON.stringify(rq.flaggedDetail));
    } else {
      lines.push('(no AUTO extraction has run yet in this popup session — click Extract Data, then re-copy this diagnostic)');
    }
    lines.push('');
    lines.push('--- Scan ---');
    lines.push('Total DOM elements on page: ' + report.totalDomElements);
    lines.push('Elements actually scanned: ' + report.scannedElements + ' (MAX_SCAN_ELEMENTS=' + report.constants.MAX_SCAN_ELEMENTS + ')');
    lines.push('Scan truncated: ' + report.scannedTruncated);
    lines.push('Candidate generation duration: ' + report.candidateGenerationDurationMs + 'ms');
    lines.push('Ranking duration: ' + report.rankingDurationMs + 'ms');
    lines.push('Total diagnostic duration: ' + report.totalDurationMs + 'ms');
    lines.push('Time budget exceeded during field detection: ' + report.timeBudgetExceededDuringFieldDetection + ' (MAX_TIME_MS=' + report.constants.MAX_TIME_MS + ')');
    lines.push('');
    lines.push('--- Candidate counts through the pipeline ---');
    lines.push('Raw candidate groups discovered: ' + report.rawCandidateGroupCount);
    lines.push('After dedup: ' + report.candidateCountAfterDedup);
    lines.push('After table-filter: ' + report.candidateCountAfterTableFilter);
    lines.push('After top-' + report.constants.MAX_CANDIDATES + ' cutoff: ' + report.candidateCountAfterTopNCutoff);
    lines.push('Final structures (incl. table-detected): ' + report.finalStructureCount);
    lines.push('Rejected candidates (total): ' + report.rejectedCandidateCount);
    lines.push('');
    lines.push('--- Winner ---');
    lines.push(report.winner ? JSON.stringify(report.winner, null, 1) : '(none — no structure survived the pipeline)');
    lines.push('Why: ' + report.winnerReason);
    lines.push('');
    lines.push('--- Top candidates AFTER ranking (up to 10) ---');
    lines.push(JSON.stringify(report.topCandidatesAfterRanking, null, 1));
    lines.push('');
    lines.push('--- Top candidates BEFORE ranking (up to 10) ---');
    lines.push(JSON.stringify(report.topCandidatesBeforeRanking, null, 1));
    lines.push('');
    lines.push('--- Raw candidates with product-like signals (links + images + price-like, regardless of outcome) ---');
    lines.push(JSON.stringify(report.rawCandidatesWithProductLikeSignals, null, 1));
    lines.push('');
    lines.push('--- Rejected candidates + reasons (largest item count first, up to 40) ---');
    lines.push(JSON.stringify(report.rejectedCandidates, null, 1));
    if (report.rejectedCandidatesNoteTruncated) lines.push(report.rejectedCandidatesNoteTruncated);
    lines.push('');
    lines.push('--- Full raw JSON (everything above, machine-readable) ---');
    lines.push(JSON.stringify(report));
    return lines.join('\n');
  }

  /** DEV ONLY. Sends RUN_AUTO_DETECT_DIAGNOSTIC to the content script,
   * formats the response, and copies it to the clipboard — falling back
   * to a visible, pre-selected <textarea> if clipboard access fails for
   * any reason (spec's explicit fallback requirement). Never consumes a
   * trial credit, never touches state.columns/rawRows/license state —
   * read-only reporting. */
  async function handleCopyAutoDiagnostic() {
    if (els.autoDiagStatus) els.autoDiagStatus.textContent = 'Running diagnostic…';
    if (els.autoDiagTextarea) els.autoDiagTextarea.hidden = true;
    var res;
    try {
      res = await sendToContent({ type: 'RUN_AUTO_DETECT_DIAGNOSTIC' });
    } catch (e) {
      if (els.autoDiagStatus) els.autoDiagStatus.textContent = 'Diagnostic failed: ' + (e && e.message || e);
      return;
    }
    if (!res || !res.ok) {
      if (els.autoDiagStatus) els.autoDiagStatus.textContent = 'Diagnostic failed: ' + (res && res.error || 'no response from the page');
      return;
    }
    var text = formatAutoDiagnosticReport(res.report);
    try {
      await navigator.clipboard.writeText(text);
      if (els.autoDiagStatus) els.autoDiagStatus.textContent = 'Copied to clipboard (' + text.length + ' characters). Paste it back.';
    } catch (e) {
      if (els.autoDiagStatus) els.autoDiagStatus.textContent = 'Clipboard unavailable — select all the text below and copy it manually.';
      if (els.autoDiagTextarea) {
        els.autoDiagTextarea.hidden = false;
        els.autoDiagTextarea.value = text;
        els.autoDiagTextarea.focus();
        els.autoDiagTextarea.select();
      }
    }
  }

  /** DEV ONLY — same reachability contract as revealAutoDiagPanelIfDev()
   * above. Called once BAŞLA has actually created a session (so there is
   * real data to inspect), same "reveal after the relevant action, not
   * eagerly" timing revealAutoDiagPanelIfDev() already uses. */
  async function revealSessionDiagPanelIfDev() {
    if (!els.sessionDiagPanel) return;
    var isDev = false;
    try { isDev = await WSLicense.isDevelopmentInstall(); } catch (e) { isDev = false; }
    els.sessionDiagPanel.hidden = !isDev;
  }

  /** Formats the exact 12 fields requested for real-Chrome debugging of
   * the active-session watcher: activeSessionId, current page URL,
   * page-change detected?, rescan triggered?, raw/accepted/duplicate/new
   * row counts, dataset size before/after merge, APPEND-vs-REPLACE, and
   * whether the session is still active — for the current state AND the
   * last up-to-20 passes (session.diagnostics), so a "page 2 didn't grow
   * the count" report is answerable from ONE paste: either no pass ever
   * ran after the navigation (mode A — no rescan), or a pass ran and its
   * own before/after/operation fields prove whether it appended or
   * (structurally impossible, but verifiable here regardless) replaced. */
  function formatSessionDiagnosticReport(diag) {
    var lines = [];
    lines.push('=== Active Session Diagnostic ===');
    lines.push('Generated: ' + new Date().toISOString());
    lines.push('Extension version: ' + (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '?'));
    lines.push('');
    // Proves/disproves each of the 5 named failure modes directly:
    // A) never written -> keyExists=false AND no BAŞLA write diagnostic below
    // B) written under another key -> keyExists=false but allMatchingSessionKeys is non-empty
    // C) written into another storage backend -> storageBackend here disagrees
    //    with the "BAŞLA write" storageArea line below
    // D) deleted during navigation -> keyExists was true at BAŞLA (see write
    //    diagnostic) but false here on a later read
    // E) reader uses wrong key/backend -> expectedStorageKey here disagrees
    //    with the BAŞLA write's storageKey line below
    lines.push('--- SESSION STORAGE ---');
    var sd = diag.storageDiagnostic;
    if (sd) {
      lines.push('normalized hostname: ' + sd.normalizedDomain);
      lines.push('expected storage key: ' + sd.expectedStorageKey);
      lines.push('storage backend (reader, this page, right now): ' + sd.storageBackend);
      lines.push('key exists (fresh read, right now): ' + sd.keyExists);
      lines.push('all matching ws_live_session:: keys currently present: ' + JSON.stringify(sd.allMatchingSessionKeys));
      lines.push('active session id (fresh read): ' + sd.activeSessionId);
      lines.push('row count (fresh read): ' + sd.rowCount);
    } else {
      lines.push('(content script did not return a storageDiagnostic — unexpected, treat as a bug in the diagnostic itself)');
    }
    if (lastSessionWriteDiagnostic) {
      var wd = lastSessionWriteDiagnostic;
      lines.push('');
      lines.push('--- BAŞLA write diagnostic (from THIS popup instance, may be stale/from a previous popup open) ---');
      lines.push('normalized domain key written: ' + wd.normalizedDomain);
      lines.push('exact storage key written: ' + wd.storageKey);
      lines.push('storage area used (writer): ' + wd.storageArea);
      lines.push('write success/failure: ' + wd.writeSuccess);
      lines.push('session id: ' + wd.sessionId);
      lines.push('row count after initial extraction: ' + wd.rowCountAfterInitialExtraction);
      lines.push('immediate read-back after write — found: ' + wd.readBackFound + ', rows: ' + wd.readBackRowCount);
      lines.push('');
      lines.push('--- Legacy-template migration (this BAŞLA) ---');
      var cm = wd.containerMigration;
      if (cm) {
        lines.push('stored container selector before validation: ' + cm.storedContainerSelector);
        lines.push('match count before: ' + cm.matchCountBefore);
        lines.push('migrated container selector: ' + (cm.migratedContainerSelector || '(none — not stale, or no live anchor found)'));
        lines.push('match count after: ' + cm.matchCountAfter);
        lines.push('template migration performed: ' + cm.templateMigrationPerformed);
      } else {
        lines.push('(no containerMigration reported by content.js — unexpected, treat as a bug in the diagnostic itself)');
      }
    } else {
      lines.push('');
      lines.push('(no BAŞLA write diagnostic recorded in this popup instance — either BAŞLA has not been clicked since the popup was last opened, or this is a fresh popup that reconnected to an existing session)');
    }
    lines.push('');
    if (!diag.session) {
      lines.push('(no active or finished session for this hostname — click BAŞLA first, then re-copy this diagnostic)');
      lines.push('Current page URL (from content script): ' + diag.currentUrl);
      return lines.join('\n');
    }
    var s = diag.session;
    lines.push('--- Session ---');
    lines.push('activeSessionId: ' + s.sessionId);
    lines.push('status (session still active?): ' + s.status);
    lines.push('hostname: ' + s.hostname);
    lines.push('Current page URL (from content script, right now): ' + diag.currentUrl);
    lines.push('Content-script observer currently attached: ' + diag.observing);
    lines.push('Cross-navigation persistence registered (registerContentScript succeeded at BAŞLA): ' + s.crossNavRegistered);
    lines.push('Dataset size RIGHT NOW: ' + s.rows.length);
    lines.push('lastPassNewRows: ' + s.lastPassNewRows + '   lastCheckAt: ' + (s.lastCheckAt ? new Date(s.lastCheckAt).toISOString() : '(never)'));
    lines.push('');
    // Explicit proof (not just implied by the pass list below) that a
    // cross-navigation rescan actually happened for each page the user
    // visited — the exact thing "Pass History contains scans only for
    // page=1" reports were missing. A resume-on-load entry with a page 2
    // or page 3 URL here can ONLY exist if registerContentScripts()
    // actually re-injected the watcher on that page.
    var resumeEntries = (s.diagnostics || []).filter(function (d) { return d.changeReason === 'resume-on-load'; });
    var distinctPageUrls = [];
    (s.diagnostics || []).forEach(function (d) { if (d.pageUrl && distinctPageUrls.indexOf(d.pageUrl) === -1) distinctPageUrls.push(d.pageUrl); });
    lines.push('--- Cross-navigation rescan proof ---');
    lines.push('resume-on-load passes recorded (one per fresh content-script injection after a full navigation): ' + resumeEntries.length);
    lines.push('distinct page URLs scanned this session: ' + distinctPageUrls.length + (distinctPageUrls.length ? (' -> ' + JSON.stringify(distinctPageUrls)) : ''));
    lines.push('');
    lines.push('--- Pass history (oldest to newest, last 20) — each entry proves whether a rescan happened and whether it appended or replaced ---');
    (s.diagnostics || []).forEach(function (d, i) {
      lines.push(
        '[' + i + '] at=' + new Date(d.at).toISOString() +
        ' changeReason=' + d.changeReason +
        ' pageUrl=' + d.pageUrl +
        ' pageChangeDetected=' + d.pageChangeDetected +
        ' rescanTriggered=' + d.rescanTriggered + (d.skipReason ? (' (skipped: ' + d.skipReason + ')') : '') +
        ' raw=' + d.raw + ' accepted=' + d.accepted + ' excluded=' + d.excluded +
        ' duplicates=' + d.duplicates + ' newUnique=' + d.newRows +
        ' datasetBefore=' + d.datasetBefore + ' datasetAfter=' + d.datasetAfter +
        ' operation=' + d.operation +
        ' sessionStillActive=' + d.sessionStillActive
      );
    });
    if (!s.diagnostics || !s.diagnostics.length) lines.push('(no passes recorded yet)');
    lines.push('');
    lines.push('--- Full raw JSON (everything above, machine-readable) ---');
    lines.push(JSON.stringify(diag));
    return lines.join('\n');
  }

  /** DEV ONLY. Reads the live session + pass history straight from the
   * content script (GET_LIVE_SESSION_DIAGNOSTIC — read-only, touches
   * nothing) and copies a formatted report to the clipboard, falling
   * back to a visible textarea exactly like Copy AUTO Diagnostic. Never
   * consumes a trial credit. */
  async function handleCopySessionDiagnostic() {
    if (els.sessionDiagStatus) els.sessionDiagStatus.textContent = 'Reading session…';
    if (els.sessionDiagTextarea) els.sessionDiagTextarea.hidden = true;
    var res;
    try {
      res = await sendToContent({ type: 'GET_LIVE_SESSION_DIAGNOSTIC' });
    } catch (e) {
      if (els.sessionDiagStatus) els.sessionDiagStatus.textContent = 'Diagnostic failed: ' + (e && e.message || e);
      return;
    }
    if (!res || !res.ok) {
      if (els.sessionDiagStatus) els.sessionDiagStatus.textContent = 'Diagnostic failed: ' + (res && res.error || 'no response from the page');
      return;
    }
    var text = formatSessionDiagnosticReport(res);
    try {
      await navigator.clipboard.writeText(text);
      if (els.sessionDiagStatus) els.sessionDiagStatus.textContent = 'Copied to clipboard (' + text.length + ' characters). Paste it back.';
    } catch (e) {
      if (els.sessionDiagStatus) els.sessionDiagStatus.textContent = 'Clipboard unavailable — select all the text below and copy it manually.';
      if (els.sessionDiagTextarea) {
        els.sessionDiagTextarea.hidden = false;
        els.sessionDiagTextarea.value = text;
        els.sessionDiagTextarea.focus();
        els.sessionDiagTextarea.select();
      }
    }
  }

  /** V1 UX WORKFLOW SIMPLIFICATION spec: the Extract button shows the live
   * accepted item count ("60 Items") instead of a generic "Extract Data"
   * label, so the primary CTA itself communicates what it's about to do.
   * Falls back to the static label when there's nothing to count yet
   * (no candidate, or the user unchecked every field) — never shows
   * "0 Items" as if that were the real outcome. */
  function updateAutoExtractButtonState() {
    if (!els.autoExtractBtn) return;
    var checkedCount = getCheckedAutoScanFields().length;
    els.autoExtractBtn.disabled = checkedCount === 0;
    var itemCount = autoScanCandidate && typeof autoScanCandidate.itemCount === 'number' ? autoScanCandidate.itemCount : 0;
    els.autoExtractBtn.textContent = (checkedCount > 0 && itemCount > 0)
      ? WSI18n.t('autoMode.extractDataCount', { count: itemCount })
      : WSI18n.t('autoMode.extractData');
  }

  async function renderAutoScanPreview() {
    var candidate = autoScanCandidate;
    if (!candidate || !els.autoScanPreviewTable) return;
    var checked = getCheckedAutoScanFields();
    if (!checked.length) { els.autoScanPreviewTable.innerHTML = ''; return; }
    var columns = buildAutoScanColumns(checked);
    var res;
    try {
      res = await sendToContent({ type: 'PREVIEW_STRUCTURE', containerSelector: candidate.containerSelector, columns: columns });
    } catch (e) { return; }
    if (!res || !res.ok) return;
    buildPreviewTable(columns, res.rows, 5, els.autoScanPreviewTable);
  }

  /** "Extract Data" — applies the checked fields as an ordinary
   * state.columns configuration (same shape "Use Selected Fields"/"Add
   * Selected Fields" already produce in Manual Mode) and then runs the
   * EXACT SAME handlePreview() Manual Mode's own Preview button calls —
   * same trial gate, same idempotent chargeRunCredit(), same results
   * pipeline. The AUTO user never has to know Preview/Run exist; this is
   * simply what happens internally (spec: "The extension should
   * internally handle the necessary preview/run process"). */
  async function handleAutoExtract() {
    var checked = getCheckedAutoScanFields();
    if (!checked.length || !autoScanCandidate) return;
    var wasTable = !!autoScanCandidate.isTable; // captured before autoScanCandidate is cleared below

    state = { containerSelector: autoScanCandidate.containerSelector, columns: buildAutoScanColumns(checked) };
    await persistState();
    loadedScraperId = null;
    loadedScraperName = null;
    deepScrapeConfig = WSRecipes.emptyDeepScrape();
    renderDeepScrapePanel();
    await WSRecipes.setLoadedScraperId(hostname, null);
    renderColumns();
    clearResults();
    els.autoScanResult.hidden = true;
    autoScanCandidate = null;

    await handlePreview(); // charges exactly 1 trial credit on success, same as Manual Preview — see handlePreviewInner()

    // If handlePreview() was blocked by the trial gate, showTrialCompleteModal()
    // already opened the paywall — stay on the Scrape tab so the user sees it
    // rather than silently jumping to an unrelated tab.
    if (!els.trialModalOverlay || els.trialModalOverlay.hidden) {
      if (!wasTable) await applyAutoRowQualityFilter();
      switchTab('results');
    }
  }

  /** V1 AUTO RESULT CLEANUP — AUTO-ONLY post-processing: excludes HIGH-
   * confidence non-data rows (spec's "Shop on eBay"-shaped promotional/
   * utility inserts that share the same repeating-group structural role
   * as real rows) from the just-extracted rawRows, and flags MEDIUM-
   * confidence ones using the EXISTING, non-destructive `_wsAnomaly`
   * mismatch system (spec #6/#17 — reused, not reinvented; same hover/
   * legend UI Manual Mode's own flagged rows already use).
   *
   * Deliberately NEVER called from Manual Mode's own Preview/Start Run
   * path — content/scraper.js's runExtraction()/flagAnomalies() are
   * completely untouched by this feature, so a Manual user's explicitly
   * configured selectors are never second-guessed or had rows silently
   * removed (spec #20). Best-effort: any failure (message error,
   * verdict-count mismatch) leaves rawRows exactly as handlePreview()
   * produced them — this can only ever REMOVE rows on high-confidence
   * evidence, never fabricate or corrupt data. */
  async function applyAutoRowQualityFilter() {
    if (!rawRows.length || !state.columns.length) return;
    var res;
    try {
      res = await sendToContent({ type: 'CLASSIFY_AUTO_ROWS', columns: state.columns, rows: rawRows });
    } catch (e) { return; }
    if (!res || !res.ok || !Array.isArray(res.verdicts) || res.verdicts.length !== rawRows.length) return;

    var excludedCount = 0, flaggedCount = 0;
    var kept = [];
    var excludedDetail = [], flaggedDetail = [];
    rawRows.forEach(function (row, idx) {
      var v = res.verdicts[idx];
      if (v && v.verdict === 'exclude') {
        excludedCount++;
        excludedDetail.push({ rowIndex: idx, reasons: v.reasons, weight: v.weight });
        return;
      }
      if (v && v.verdict === 'flag') {
        if (!row._wsAnomaly) row._wsAnomaly = v.reasons.join(', ');
        flaggedCount++;
        flaggedDetail.push({ rowIndex: idx, reasons: v.reasons, weight: v.weight });
      }
      kept.push(row);
    });
    // spec #21: "reason for each excluded/flagged row" — capped to keep
    // the diagnostic pasteable on a large dataset; counts above are
    // always exact regardless of this cap.
    lastAutoRowQualitySummary = {
      excludedCount: excludedCount, flaggedCount: flaggedCount, rawCount: rawRows.length,
      dominantShape: res.dominantShape || null,
      excludedDetail: excludedDetail.slice(0, 20), flaggedDetail: flaggedDetail.slice(0, 20)
    };
    if (excludedCount > 0) {
      rawRows = kept;
      invalidateTransformCache();
      renderResults();
      setStatus(WSI18n.t('autoMode.nonDataRowsExcluded', { count: excludedCount }), false);
    } else if (flaggedCount > 0) {
      renderResults(); // re-render so the newly-set _wsAnomaly flags/legend show up immediately
    }
  }

  // =====================================================================
  // V1 SIMPLIFIED SESSION WORKFLOW — BAŞLA / BİTİR.
  //
  // One primary action per tab, built ENTIRELY on top of already-existing
  // primitives: BAŞLA is a Current-Page-equivalent extraction (same
  // RUN_EXTRACTION message, same CLASSIFY_AUTO_ROWS ad/promo/nav
  // rejection classifyExtractedRows already does for AUTO mode, same
  // charge-once-per-click chargeRunCredit model handlePreviewInner
  // already uses), followed by persisting a session object to
  // chrome.storage.session (mirroring content/pagination.js's own
  // ws_run::<hostname> pattern exactly) and starting content/livewatch.js's
  // passive MutationObserver so the SAME deduplicated dataset keeps
  // growing as the user keeps browsing (their own pagination/scroll/Load
  // More clicks — the extension never drives navigation itself) — until
  // BİTİR freezes it and reveals the existing, unchanged export UI.
  //
  // Trial-credit safety: chargeRunCredit is called from EXACTLY ONE place
  // in this whole feature — synchronously inside handleStartLiveSession,
  // right after the FIRST extraction succeeds. Every other code path
  // (the passive watcher's own merge/persist loop, the popup-reopen
  // restore path, the storage.onChanged listener) never references
  // chargeRunCredit at all, so continuing an already-active session can
  // never double-charge — not merely idempotent, but structurally
  // impossible.
  // =====================================================================

  var LIVE_SESSION_KEY_PREFIX = 'ws_live_session::';
  // Real-Chrome fix: normalize at the KEY level (not at every call site)
  // — see WSRunState.normalizeHostname's own header comment
  // (utils/runstate.js) for the exact www.<site> vs <site> mismatch this
  // closes. The SAME normalizeHostname function, from the SAME shared
  // file, is used by content/livewatch.js's own sessionKey() — a popup-
  // side BAŞLA and a later content-script page's resume-on-load are
  // therefore GUARANTEED to compute the identical storage key for the
  // same site, regardless of which "www." variant either side happened
  // to observe.
  function liveSessionKey(host) { return LIVE_SESSION_KEY_PREFIX + WSRunState.normalizeHostname(host); }

  // REAL-CHROME ROOT CAUSE #3: chrome.storage.session defaults to
  // TRUSTED_CONTEXTS-only access — content scripts are NOT granted
  // access unless the background service worker explicitly calls
  // chrome.storage.session.setAccessLevel(), which this codebase never
  // did. The popup (a trusted context) could write the session
  // successfully every time; a content script's read never threw or
  // errored, it simply resolved with an empty result — indistinguishable
  // from "no session" without inspecting chrome.runtime.lastError, which
  // neither side's original code did. Fixed by moving off
  // chrome.storage.session entirely onto chrome.storage.local — already
  // proven working from THIS extension's content scripts (content.js's
  // column-picker save path has used chrome.storage.local directly from
  // a content script since V1.2, real-Chrome-verified), and a genuinely
  // persistent, extension-owned location regardless of which context
  // reads or writes it.
  var LIVE_SESSION_STORAGE_AREA = 'local';

  function liveSessionGet(host) {
    return new Promise(function (resolve) {
      chrome.storage.local.get([liveSessionKey(host)], function (result) {
        resolve((result && result[liveSessionKey(host)]) || null);
      });
    });
  }
  function liveSessionSet(host, session) {
    return new Promise(function (resolve) {
      var data = {};
      data[liveSessionKey(host)] = session;
      chrome.storage.local.set(data, resolve);
    });
  }

  /** DEV-ONLY: every ws_live_session::* key currently present, for the
   * same "never written vs. wrong key vs. wrong backend" diagnosis the
   * content-script side's listAllSessionKeys() provides. */
  function liveSessionListAllKeys() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(null, function (all) {
        resolve(Object.keys(all || {}).filter(function (k) { return k.indexOf(LIVE_SESSION_KEY_PREFIX) === 0; }));
      });
    });
  }

  /** Structural inference only (never by column NAME, matching this
   * project's established i18n-safe convention — see
   * classifyExtractedRows' own column-role inference): prefer a link-
   * like column as the dedup identity, the closest available proxy for
   * "canonical/product URL" spec's own priority order asks for first —
   * else fall back to the existing 'entire-row' (every selected field
   * combined), never a single weak field on its own that could delete
   * legitimate distinct rows sharing one value (e.g. two different
   * products with the same title). */
  function pickDedupeKeyForColumns(columns) {
    var linkCol = columns.find(function (c) { return c.attribute === 'href'; });
    return linkCol ? linkCol.id : 'entire-row';
  }

  /** Same ad/promo/nav/malformed-row rejection AUTO mode already applies
   * (applyAutoRowQualityFilter above), reused as-is for a MANUALLY-built
   * column set — classifyExtractedRows infers column roles structurally
   * from `attribute`, never from column names, so it works identically
   * here. Best-effort: any failure just keeps every row (never silently
   * drops data because a classification call happened to fail). */
  async function classifyAndAccept(columns, rows) {
    if (!rows.length) return { accepted: rows, excludedCount: 0 };
    var res;
    try {
      res = await sendToContent({ type: 'CLASSIFY_AUTO_ROWS', columns: columns, rows: rows });
    } catch (e) { return { accepted: rows, excludedCount: 0 }; }
    if (!res || !res.ok || !Array.isArray(res.verdicts) || res.verdicts.length !== rows.length) {
      return { accepted: rows, excludedCount: 0 };
    }
    var excludedCount = 0;
    var accepted = rows.filter(function (row, idx) {
      var v = res.verdicts[idx];
      if (v && v.verdict === 'exclude') { excludedCount++; return false; }
      if (v && v.verdict === 'flag' && !row._wsAnomaly) row._wsAnomaly = v.reasons.join(', ');
      return true;
    });
    return { accepted: accepted, excludedCount: excludedCount };
  }

  function originPatternForLiveWatch(host) {
    return '*://' + host + '/*';
  }

  /** BAŞLA — the single primary action on the setup tab. */
  /** REAL-CHROME ROOT CAUSE (found by instrumenting, not guessing — see
   * "Copy Session Diagnostic", dev-only): chrome.permissions.request()
   * requires an unexpired transient user-activation token tied to the
   * BAŞLA click. The previous ordering ran it AFTER several awaited
   * round-trips (RUN_EXTRACTION message, multiple chrome.storage writes)
   * — by the time execution reached it, the activation window had likely
   * already lapsed, so the grant silently failed (no prompt, `granted`
   * false) and registerContentScript() never ran. Etsy's own pagination
   * is a REAL page navigation, which destroys the content script
   * entirely — with no persistent registration, NOTHING re-injects into
   * page 2 at all, so content/livewatch.js's own "resume an active
   * session on load" logic never gets a chance to run. This is failure
   * mode A ("no rescan"), not B ("rescan replaces") — WSRunState.
   * mergeNewRows() always concatenates onto the EXISTING persisted
   * rows.length, structurally incapable of replacing.
   *
   * Fix: request the permission as the very FIRST async step, as close
   * to the click as physically possible — everything else (extraction,
   * classification, charging, session creation) follows only after. */
  async function handleStartLiveSession() {
    if (runTriggerInFlight) return;
    runTriggerInFlight = true;
    try {
      if (!state.columns.length) {
        setStatus(WSI18n.t('liveSession.noColumns'), true);
        return;
      }

      // FIRST, before anything else awaits: request cross-navigation
      // persistence while the click's user-activation is definitely
      // still valid. crossNavRegistered is recorded on the session for
      // the dev diagnostic — it does not gate anything below; same-page
      // watching (infinite-scroll/Load More/SPA route changes) works
      // regardless of whether this succeeds.
      var crossNavRegistered = false;
      var origin = originPatternForLiveWatch(hostname);
      try {
        var granted = await chrome.permissions.request({ origins: [origin] });
        if (granted) {
          // REAL-CHROME ROOT CAUSE (found via "Cross-navigation persistence
          // registered: false" in the dev diagnostic, on a real Etsy
          // page1->page2->page3 navigation): chrome.scripting has NO
          // method named registerContentScript (singular) — the real MV3
          // API is registerContentScripts (plural), which takes an ARRAY
          // of script objects. Calling the singular name throws
          // synchronously ("...is not a function"), silently caught by
          // the try/catch below every single time, so crossNavRegistered
          // was ALWAYS false regardless of the permission grant — nothing
          // ever re-injected into page 2/3, so content/livewatch.js's own
          // resume-on-load logic never got a chance to run at all. This
          // was invisible to the test suite because its own bootPopup()
          // mock also (wrongly) implemented the singular name, so the
          // mock and the bug matched each other — see the test-harness
          // fix alongside this one.
          try {
            await chrome.scripting.registerContentScripts([{ id: 'ws-livewatch-' + hostname, matches: [origin], js: CONTENT_FILES, runAt: 'document_idle', persistAcrossSessions: false }]);
            crossNavRegistered = true;
          } catch (e) {
            try {
              await chrome.scripting.unregisterContentScripts({ ids: ['ws-livewatch-' + hostname] });
              await chrome.scripting.registerContentScripts([{ id: 'ws-livewatch-' + hostname, matches: [origin], js: CONTENT_FILES, runAt: 'document_idle', persistAcrossSessions: false }]);
              crossNavRegistered = true;
            } catch (e2) { crossNavRegistered = false; }
          }
        }
      } catch (e) { crossNavRegistered = false; }

      if (!(await trialAllowsNewRun())) { showTrialCompleteModal(); return; }
      setStatus(WSI18n.t('liveSession.starting'), false, 'running');

      var res;
      try {
        res = await sendToContent({ type: 'RUN_EXTRACTION' });
      } catch (e) { res = null; }
      if (!res || !res.ok) {
        setStatus(WSI18n.t('liveSession.readError'), true);
        return;
      }

      // REAL REGRESSION FIX: content.js's RUN_EXTRACTION handler
      // auto-migrates a stale, over-specific persisted containerSelector
      // BEFORE running this extraction (see migrateContainerSelectorIfStale
      // in content/content.js) and already persisted the corrected
      // selector to chrome.storage.local — but this popup's own in-memory
      // `state` was read earlier and still holds the OLD selector. Without
      // this, the extraction above would correctly return ~64 rows just
      // this once, while session.scraperConfig.containerSelector below
      // (which the live-session watcher re-uses for every later
      // page/scroll pass) would silently persist the STALE selector,
      // reverting every subsequent pass back to ~2 rows.
      var containerMigration = res.containerMigration || null;
      if (containerMigration && containerMigration.templateMigrationPerformed) {
        state.containerSelector = containerMigration.migratedContainerSelector;
      }

      var classifyResult = await classifyAndAccept(state.columns, res.rows);
      rawRows = classifyResult.accepted;

      // The one and only chargeRunCredit call in this entire feature —
      // see the header comment above for why that makes double-charging
      // structurally impossible for everything that follows.
      await chargeRunCredit('livesession_' + hostname + '_' + Date.now() + '_' + Math.random().toString(36).slice(2));

      var dedupeKey = pickDedupeKeyForColumns(state.columns);
      // AUTOMATIC DATA DISCOVERY ENGINE (mission's own central product
      // rule): the user is never asked to choose pagination vs. infinite
      // scroll vs. Load More vs. a hybrid of them — ClickScrape decides
      // automatically (content/discovery.js) and always runs it. The
      // legacy `auto-next-toggle`/`auto-scroll-toggle` checkboxes are
      // deliberately left in the DOM (a later, purely-UI mission removes/
      // hides them — see CLAUDE.md's own scope note for this mission) but
      // their checked state is no longer read here: reading it would
      // reintroduce exactly the "user must decide how the site exposes
      // more results" choice this engine exists to remove. The legacy
      // `session.autoPaginate`/`session.autoScroll` fields (still read by
      // content/autopaginate.js's/content/autoscroll.js's OWN independent
      // standalone message handlers and bootstraps) are deliberately never
      // populated by this flow either — content/discovery.js owns its own,
      // internally-seeded equivalents (session.autoScroll is, confusingly
      // by name only, ALSO the field discovery.js's orchestrator seeds and
      // drives directly, exactly mirroring content/autopaginate.js's own
      // established combined-mode reuse of that same engine — see content/
      // discovery.js's own header comment for the full reasoning) so there
      // is never more than one driver of any given engine on a session.
      // Stored NORMALIZED (see WSRunState.normalizeHostname) so the
      // session's own record of "which site this is" always matches the
      // key it's actually filed under — a diagnostic reading s.hostname
      // must never show a value that disagrees with how the record was
      // actually looked up.
      var session = {
        sessionId: 'livesess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        hostname: WSRunState.normalizeHostname(hostname), tabId: tabId, status: 'active',
        startedAt: Date.now(), updatedAt: Date.now(),
        scraperConfig: { containerSelector: state.containerSelector, columns: state.columns },
        dedupeKey: dedupeKey, rows: [], seenKeys: {}, lastPassNewRows: 0, lastCheckAt: null,
        crossNavRegistered: crossNavRegistered,
        // WSRunState.mergeNewRows() (reused as-is, see content/livewatch.js)
        // unconditionally writes progress.rowsCollected — this minimal stub
        // is the only WSRunState-shaped field this deliberately-simpler
        // session object needs to stay compatible with that shared function.
        progress: { rowsCollected: 0 },
        discovery: (typeof WSDiscoveryCore !== 'undefined')
          ? WSDiscoveryCore.createDiscoveryState({ startUrl: pageUrl })
          // typeof-guarded exactly like every other optional-module check
          // in this file (e.g. WSCleaners) — a context where
          // utils/discovery.js somehow failed to load degrades to "no
          // automatic discovery" rather than throwing; BAŞLA's own
          // extraction/session/export path above is completely unaffected
          // either way.
          : null
      };
      // Seed rows/seenKeys via the EXACT SAME dedup function
      // content/livewatch.js's passive watcher will use for every later
      // pass — guarantees identical identity logic for this first batch
      // and every batch appended after it.
      var datasetBefore = session.rows.length;
      var seedMerge = WSRunState.mergeNewRows(session, rawRows, state.columns, { baseUrl: pageUrl });
      session = seedMerge.runState;
      // Diagnostics (dev-only "Copy Session Diagnostic" reads this) —
      // never trust a count just because extraction completed: the exact
      // raw/accepted/excluded/duplicate/new breakdown, plus an explicit
      // BEFORE/AFTER dataset size and operation label proving this is
      // always an append, never a replace.
      session.diagnostics = [{
        at: Date.now(), pageUrl: null, changeReason: 'initial-basla',
        pageChangeDetected: false, rescanTriggered: true,
        raw: res.rows.length, accepted: classifyResult.accepted.length, excluded: classifyResult.excludedCount,
        duplicates: classifyResult.accepted.length - seedMerge.newUniqueCount, newRows: seedMerge.newUniqueCount,
        datasetBefore: datasetBefore, datasetAfter: session.rows.length, operation: 'APPEND'
      }];

      var writeKey = liveSessionKey(hostname);
      var writeOk = false;
      try { await liveSessionSet(hostname, session); writeOk = true; } catch (e) { writeOk = false; }
      // Explicit write/read-back diagnostic (dev-only): read the SAME key
      // right back from the SAME storage area used to write it, so a
      // silently-blocked/failed write (e.g. a storage access-level
      // restriction) is provably distinguishable from "worked fine" —
      // never trust the write call's own resolve, always verify by re-read.
      var readBack = null;
      try { readBack = await liveSessionGet(hostname); } catch (e) { readBack = null; }
      lastSessionWriteDiagnostic = {
        normalizedDomain: session.hostname,
        storageKey: writeKey,
        storageArea: 'chrome.storage.' + LIVE_SESSION_STORAGE_AREA,
        writeSuccess: writeOk,
        sessionAfterWrite: session,
        sessionId: session.sessionId,
        rowCountAfterInitialExtraction: session.rows.length,
        readBackFound: !!(readBack && readBack.sessionId === session.sessionId),
        readBackRowCount: readBack ? readBack.rows.length : null,
        // Legacy-template migration (see content.js's
        // migrateContainerSelectorIfStale): proves whether a stale,
        // over-specific persisted containerSelector was detected and
        // auto-corrected at this exact BAŞLA, and with what before/after
        // match counts.
        containerMigration: containerMigration
      };
      try {
        if (typeof WSLicense !== 'undefined' && WSLicense.isDevelopmentInstall && (await WSLicense.isDevelopmentInstall())) {
          console.log('[WebScraper][LiveSession] BAŞLA write diagnostic:', lastSessionWriteDiagnostic);
        }
      } catch (e) { /* dev-only logging, never let this block BAŞLA */ }
      activeLiveSession = session;

      invalidateTransformCache();
      activeFilter = null;
      activeDedupe = null;
      activeSort = null;
      els.transformPanel.hidden = true;
      els.filterPanel.hidden = true;
      els.sortPanel.hidden = true;
      els.dedupePanel.hidden = true;
      if (els.snapshotsPanel) els.snapshotsPanel.hidden = true;
      els.previewSection.hidden = false;
      renderResults();

      var watchStarted = false;
      try {
        var watchRes = await sendToContent({ type: 'START_LIVE_WATCH' });
        watchStarted = !!(watchRes && watchRes.ok);
      } catch (e) { watchStarted = false; }

      // AUTOMATIC DATA DISCOVERY ENGINE: always started, unconditionally
      // — see the session-seeding comment above for why no toggle gates
      // this. Best-effort, same non-blocking-warning treatment as
      // START_LIVE_WATCH above — the session/initial results already
      // succeeded regardless. A no-op if utils/discovery.js failed to
      // load (session.discovery is null in that case, and content/
      // discovery.js's own message handler is simply never reached
      // meaningfully — same degrade-safely contract as every other
      // typeof-guarded optional module in this file).
      if (session.discovery) {
        try { await sendToContent({ type: 'START_DISCOVERY' }); }
        catch (e) { console.error('[Web Scraper] START_DISCOVERY did not confirm — automatic discovery may not be active for this session.'); }
      }

      attachLiveSessionStorageListener();
      switchTab('results');
      setStatus('');
      revealSessionDiagPanelIfDev();
      if (!watchStarted) {
        // Surfaced as a non-blocking warning, not an error — the initial
        // extraction/results/credit above all succeeded regardless; this
        // only means auto-append while browsing may not be active yet.
        console.error('[Web Scraper] START_LIVE_WATCH did not confirm — auto-append may not be active for this session.');
      }
    } finally {
      runTriggerInFlight = false;
    }
  }

  /** BİTİR — stops the passive watcher, freezes the dataset, reveals
   * export. Reversible only by starting a brand-new session (BAŞLA
   * again), never by re-opening this one — matches the spec's "session
   * remains open until BİTİR, then present the export workflow". */
  async function handleFinishLiveSession() {
    if (!activeLiveSession) return;
    try { await sendToContent({ type: 'STOP_LIVE_WATCH' }); } catch (e) { /* best-effort */ }
    // NEW FEATURE — AUTOMATIC PAGINATION: BİTİR must stop the auto-next
    // navigation loop too, not just the passive watcher — a no-op,
    // harmless message if this session never had autoPaginate on.
    // session.status is set to 'finished' below regardless, which the
    // loop's own stillRunning() check would eventually notice on its
    // own, but this makes the stop immediate rather than waiting out an
    // in-flight navigation wait.
    try { await sendToContent({ type: 'STOP_AUTO_PAGINATE' }); } catch (e) { /* best-effort */ }
    // NEW FEATURE — INFINITE SCROLL: same treatment — BİTİR must stop
    // Auto Scroll too (spec section 13: "If the user presses Finish...
    // stop Auto Scroll immediately, stop Auto Next too if both are
    // running"). Harmless no-op if this session never had autoScroll on.
    try { await sendToContent({ type: 'STOP_AUTO_SCROLL' }); } catch (e) { /* best-effort */ }
    // AUTOMATIC DATA DISCOVERY ENGINE: BİTİR must stop discovery too
    // (mission section 23: Stop/Finish always preserves whatever was
    // discovered so far) — harmless no-op if this session never had
    // discovery on (pre-feature session, or utils/discovery.js failed to
    // load at BAŞLA).
    try { await sendToContent({ type: 'STOP_DISCOVERY' }); } catch (e) { /* best-effort */ }
    try { await chrome.scripting.unregisterContentScripts({ ids: ['ws-livewatch-' + hostname] }); } catch (e) { /* ignore — may never have been registered (permission declined, or same-page-only session) */ }
    activeLiveSession.status = 'finished';
    activeLiveSession.updatedAt = Date.now();
    await liveSessionSet(hostname, activeLiveSession);
    renderLiveSessionUI();
  }

  /** DURDUR — the ONE shared Stop control for Auto Next and/or Auto
   * Scroll. A genuinely distinct action from BİTİR (spec: "stops future
   * automatic navigation/scrolling, keeps all already collected rows,
   * does NOT delete session") — the session itself stays 'active'
   * (manual browsing/live-watching keeps working, BİTİR is still
   * available afterward exactly as if neither feature had ever been
   * used). Stops WHICHEVER of the two is actually active — either
   * message is a harmless no-op if that particular sub-feature was
   * never on for this session. Only ever reachable while at least one
   * of them exists and is running (see renderLiveSessionUI's
   * durdurBtn.hidden gating), so the guards below are defensive, not
   * load-bearing. */
  async function handleStopAutoPaginate() {
    var discoveryActive = !!(activeLiveSession && activeLiveSession.discovery && activeLiveSession.discovery.status === 'discovering');
    if (!activeLiveSession || !(activeLiveSession.autoPaginate || activeLiveSession.autoScroll || discoveryActive)) return;
    try { await sendToContent({ type: 'STOP_AUTO_PAGINATE' }); } catch (e) { /* best-effort */ }
    try { await sendToContent({ type: 'STOP_AUTO_SCROLL' }); } catch (e) { /* best-effort */ }
    // AUTOMATIC DATA DISCOVERY ENGINE: DURDUR is now discovery's own Stop
    // control too (mission section 23) — a harmless no-op message if this
    // session never had discovery on.
    try { await sendToContent({ type: 'STOP_DISCOVERY' }); } catch (e) { /* best-effort */ }
    // The content script's own write(s) (status:'stopped') will arrive
    // via the existing storage.onChanged listener and re-render — this
    // local update just makes the button/status feel instant rather
    // than waiting on that round-trip.
    if (activeLiveSession.autoPaginate) {
      activeLiveSession.autoPaginate.status = 'stopped';
      activeLiveSession.autoPaginate.stopReason = 'user';
    }
    if (activeLiveSession.autoScroll) {
      activeLiveSession.autoScroll.status = 'stopped';
      activeLiveSession.autoScroll.stopReason = 'user';
    }
    if (discoveryActive) {
      activeLiveSession.discovery.status = 'discovery_stopped';
      activeLiveSession.discovery.discoveryComplete = false;
      activeLiveSession.discovery.stopReason = 'user';
    }
    renderLiveSessionUI();
  }

  /** Keeps the Results tab's live-session UI (status line, BİTİR button,
   * export gate) in sync with `activeLiveSession` — called after every
   * renderResults() and after every storage.onChanged update, so it can
   * never drift from what rawRows/the table are actually showing. */
  function renderLiveSessionUI() {
    if (!els.liveSessionStatus) return;
    if (!activeLiveSession) {
      els.liveSessionStatus.hidden = true;
      if (els.bitirBtn) els.bitirBtn.hidden = true;
      if (els.exportGate) els.exportGate.hidden = false;
      if (els.autoPaginateStatus) els.autoPaginateStatus.hidden = true;
      if (els.durdurBtn) els.durdurBtn.hidden = true;
      return;
    }
    els.liveSessionStatus.hidden = false;
    if (activeLiveSession.status === 'active') {
      els.liveSessionStatus.textContent = activeLiveSession.lastPassNewRows === 0 && activeLiveSession.lastCheckAt
        ? WSI18n.t('liveSession.noNewData')
        : WSI18n.t('liveSession.processed', { count: activeLiveSession.rows.length });
      if (els.bitirBtn) els.bitirBtn.hidden = false;
      if (els.exportGate) els.exportGate.hidden = true;
    } else {
      els.liveSessionStatus.textContent = WSI18n.t('liveSession.processed', { count: activeLiveSession.rows.length });
      if (els.bitirBtn) els.bitirBtn.hidden = true;
      if (els.exportGate) els.exportGate.hidden = false;
    }

    // NEW FEATURE — AUTOMATIC PAGINATION: its own status line, shown
    // only for a session that actually has autoPaginate — every other
    // session (the toggle was OFF, or it's a pre-feature session)
    // leaves it permanently hidden, identical to before this feature
    // existed.
    var discovery = activeLiveSession.discovery;
    var discovering = !!(discovery && discovery.status === 'discovering');

    // Legacy explicit-toggle sessions (autoPaginate/autoScroll set by the
    // OLD checkbox-gated flow) keep their own original status-line
    // behavior exactly. Only ever true for a pre-this-mission session —
    // handleStartLiveSession no longer produces one — so this branch is
    // dead code for every session created going forward, kept only so an
    // already-open, in-flight legacy session (popup closed/reopened mid-
    // session, right as this mission shipped) still renders correctly
    // rather than going silent.
    var ap = activeLiveSession.autoPaginate;
    var apRunning = !!(ap && (ap.status === 'running' || ap.status === 'navigating'));
    if (els.autoPaginateStatus) {
      // AUTOMATIC DATA DISCOVERY ENGINE: reuses this SAME existing status
      // line/translation key ("Scanning page {page}…" — already fits a
      // page-count display regardless of pagination/scroll/hybrid) for
      // the new engine's own pagesVisited counter, rather than adding a
      // new UI string this mission's scope deliberately avoids (see
      // CLAUDE.md's own "do not perform the large final popup redesign
      // yet"). `discovering` and legacy `apRunning` can never both be
      // true for the same session (discovery.js never populates
      // session.autoPaginate), so this is never ambiguous about which
      // count is actually being shown.
      els.autoPaginateStatus.hidden = !(apRunning || discovering);
      if (apRunning) els.autoPaginateStatus.textContent = WSI18n.t('liveSession.scanningPage', { page: ap.pageCount });
      else if (discovering) els.autoPaginateStatus.textContent = WSI18n.t('liveSession.scanningPage', { page: discovery.pagesVisited });
    }

    // NEW FEATURE — INFINITE SCROLL (legacy explicit toggle only): same
    // dead-code-for-new-sessions caveat as apRunning above. Discovery's
    // OWN internally-seeded session.autoScroll (see content/discovery.js)
    // is deliberately EXCLUDED here (`!discovery` guard) — without it,
    // this status line would flicker on/off as discovery's orchestrator
    // internally arms/exhausts scrolling on each page, which is an
    // implementation detail the mission's own status model (session.
    // discovery.*) is what the future UI is meant to read instead.
    var as = activeLiveSession.autoScroll;
    var asRunning = !!(as && as.status === 'running' && !discovery);
    if (els.autoScrollStatus) {
      els.autoScrollStatus.hidden = !asRunning;
      if (asRunning) els.autoScrollStatus.textContent = WSI18n.t('liveSession.scrollingRows', { count: activeLiveSession.rows.length });
    }

    // DURDUR is the ONE shared Stop control for legacy Auto Next/Auto
    // Scroll AND (now) automatic discovery — shown whenever any of them
    // is actively running. Only reachable while the session itself is
    // still 'active' — a finished session (BİTİR) already hides
    // bitirBtn/shows exportGate above, and DURDUR would be meaningless
    // once the dataset is frozen.
    if (els.durdurBtn) els.durdurBtn.hidden = !((apRunning || asRunning || discovering) && activeLiveSession.status === 'active');

    renderDiscoveryUI();
  }

  /** AUTOMATIC DISCOVERY STATUS + PROCESSING CHOICE UI (data-integrity/UX
   * mission, sections 8-9/14): the single user-facing surface for the
   * automatic discovery engine. Never mentions pagination/scroll/load-more
   * by name (mission section 14 — "communicate WHAT, not HOW"). Reads
   * purely from activeLiveSession.discovery, which content/discovery.js
   * and utils/discovery.js already populate/keep current; this function
   * only ever displays state, it never mutates it (mutation happens in
   * processAll()/processFirst() below, triggered by the two buttons this
   * function wires up once).
   *
   * Three mutually-exclusive phases, driven by discovery.status:
   *   - 'discovering'                      -> live status lines only
   *   - 'discovery_stopped'/'_complete'    -> live status lines + choice
   *                                            panel (ALL / FIRST N), IF
   *                                            processingSelection not
   *                                            made yet
   *   - processingSelection already set    -> summary panel (found /
   *     (i.e. status 'processing_complete')   processed / duplicates /
   *                                            invalid), choice panel
   *                                            hidden
   * No discovery object at all (pre-mission session, or a session that
   * never used automatic discovery) -> the whole panel stays hidden,
   * identical to before this feature existed. */
  function renderDiscoveryUI() {
    if (!els.discoveryPanel) return;
    var discovery = activeLiveSession && activeLiveSession.discovery;
    if (!discovery) {
      els.discoveryPanel.hidden = true;
      return;
    }
    els.discoveryPanel.hidden = false;

    var isDiscovering = discovery.status === 'discovering';
    var isDone = discovery.status === 'discovery_stopped' || discovery.status === 'discovery_complete';
    var hasSelection = !!discovery.processingSelection;

    if (els.discoveryStatusLine1) {
      els.discoveryStatusLine1.textContent = WSI18n.t('discovery.uniqueDiscovered', { count: discovery.discoveredUnique || 0 });
    }
    if (els.discoveryStatusLine2) {
      els.discoveryStatusLine2.textContent = WSI18n.t('discovery.pagesScanned', { count: discovery.pagesVisited || 1 });
    }
    if (els.discoveryStatusLine3) {
      // Hide the status-line3 sentence entirely once a processing
      // selection exists — the summary panel below takes over saying
      // what happened, and showing both is redundant clutter (mission
      // section 9: "do not clutter the UI").
      els.discoveryStatusLine3.hidden = hasSelection;
      if (!hasSelection) {
        els.discoveryStatusLine3.textContent = isDiscovering
          ? WSI18n.t('discovery.statusDiscovering')
          : (discovery.status === 'discovery_stopped' ? WSI18n.t('discovery.statusStopped') : WSI18n.t('discovery.statusComplete'));
      }
    }

    // Choice panel: only once discovery has actually stopped/completed,
    // and only until a selection has been made.
    var showChoice = isDone && !hasSelection;
    if (els.discoveryChoicePanel) els.discoveryChoicePanel.hidden = !showChoice;
    if (showChoice) {
      if (els.discoveryChoiceHeading) els.discoveryChoiceHeading.textContent = WSI18n.t('discovery.howManyToProcess');
      if (els.discoveryProcessAllBtn) els.discoveryProcessAllBtn.textContent = WSI18n.t('discovery.processAllBtn', { count: discovery.discoveredUnique || 0 });
      if (els.discoveryFirstNInput) {
        els.discoveryFirstNInput.max = String(discovery.discoveredUnique || 0);
        // This project's other free-text inputs all use a plain hardcoded
        // English `placeholder` attribute (no i18n) — this one instead
        // goes through the real WSI18n.t() the same way every other
        // dynamic string on this panel does, since it already has a
        // translated `discovery.firstNPlaceholder` key with 100% locale
        // coverage (see utils/i18n-data.js) and setting it here (rather
        // than a static HTML attribute) keeps it correctly localized if
        // the user ever switches locale mid-session.
        els.discoveryFirstNInput.placeholder = WSI18n.t('discovery.firstNPlaceholder');
      }
    }

    // Summary panel: only once a selection has actually been applied.
    if (els.discoverySummaryPanel) els.discoverySummaryPanel.hidden = !hasSelection;
    if (hasSelection) {
      var sel = discovery.processingSelection;
      if (els.discoverySummaryFound) els.discoverySummaryFound.textContent = WSI18n.t('discovery.uniqueDiscovered', { count: discovery.discoveredUnique || 0 });
      if (els.discoverySummaryProcessed) els.discoverySummaryProcessed.textContent = WSI18n.t('discovery.summaryProcessed', { count: sel.processedCount || 0 });
      if (els.discoverySummaryDuplicates) els.discoverySummaryDuplicates.textContent = WSI18n.t('discovery.summaryDuplicates', { count: discovery.duplicateEncounters || 0 });
      if (els.discoverySummaryInvalid) els.discoverySummaryInvalid.textContent = WSI18n.t('discovery.summaryInvalid', { count: discovery.invalidSkipped || 0 });
    }
  }

  /** Click handler for the "ALL — {count}" button in the discovery choice
   * panel. Delegates to the real processAll() (same function the test-only
   * seam above calls), then re-renders to swap the choice panel for the
   * summary panel. */
  function handleDiscoveryProcessAll() {
    processAll();
    renderDiscoveryUI();
  }

  /** Click handler for "FIRST [n] Process" in the discovery choice panel.
   * Validates via the real processFirst(n) (which itself delegates to
   * WSDiscoveryCore.validateSelection — the same pure validation logic
   * used everywhere else), surfacing a translated inline error rather than
   * silently doing nothing on bad input (mission section 50: 0, -5, 2.5,
   * "abc", oversized N). */
  function handleDiscoveryProcessFirst() {
    if (!els.discoveryFirstNInput) return;
    var raw = els.discoveryFirstNInput.value;
    var n = parseInt(raw, 10);
    var result = processFirst(n);
    if (!result || !result.ok) {
      if (els.discoveryChoiceError) {
        var discovery = activeLiveSession && activeLiveSession.discovery;
        els.discoveryChoiceError.textContent = WSI18n.t('discovery.invalidFirstN', { max: (discovery && discovery.discoveredUnique) || 0 });
        els.discoveryChoiceError.hidden = false;
      }
      return;
    }
    if (els.discoveryChoiceError) els.discoveryChoiceError.hidden = true;
    renderDiscoveryUI();
  }

  /** Mirrors attachRunStorageListener's exact existing pattern: a live
   * chrome.storage.onChanged listener so the popup reflects new rows the
   * passive watcher appends while it stays open, with no polling. */
  function attachLiveSessionStorageListener() {
    if (liveSessionListenerAttached) return;
    liveSessionListenerAttached = true;
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== LIVE_SESSION_STORAGE_AREA) return;
      var change = changes[liveSessionKey(hostname)];
      if (!change || !change.newValue) return;
      activeLiveSession = change.newValue;
      // AUTOMATIC DATA DISCOVERY ENGINE / PROCESSING boundary: once the
      // user has chosen ALL or FIRST N (processAll()/processFirst(n)
      // below), `rawRows` is a deliberate, possibly-smaller SELECTION of
      // activeLiveSession.rows, not a mirror of it — a defensive guard
      // here (discovery itself always stops writing before processing
      // can begin, per the mission's own "only after discovery completes"
      // flow, so this should never actually fire in practice) against a
      // stray late storage write silently re-expanding an already-chosen
      // FIRST N selection back to the full discovered set.
      var alreadyProcessed = !!(activeLiveSession.discovery && activeLiveSession.discovery.status &&
        activeLiveSession.discovery.status.indexOf('processing') === 0);
      if (!alreadyProcessed) rawRows = activeLiveSession.rows;
      invalidateTransformCache();
      renderResults();
    });
  }

  // =====================================================================
  // AUTOMATIC DATA DISCOVERY ENGINE — PROCESSING API (mission section 27).
  // Discovery (content/discovery.js) already accumulated the full,
  // deduplicated, stably-ordered dataset directly into
  // activeLiveSession.rows — the exact same session.rows/mergeNewRows
  // mechanism BAŞLA/Auto Next/Auto Scroll always used before this
  // mission. Processing is therefore never a second extraction pass
  // (mission section 9): it is purely "select ALL or the FIRST N of the
  // already-fully-extracted registry, in stable discovery order" (pure
  // logic lives in utils/discovery.js, loaded here too), then hand that
  // selection to the completely unmodified existing pipeline (rawRows ->
  // computeTransformedResult -> Data Cleaning -> preview/export).
  //
  // No dedicated UI wires these yet (that's the next, UI-focused
  // mission per CLAUDE.md's own explicit scope note) — exposed instead
  // through window.__wsDiscoveryTestHooks below, mirroring this file's
  // own established "exposed for targeted testing only" convention
  // (e.g. WSAutoPaginate.runAutoPaginateLoop, WSLiveWatch.runDetectionPass).
  // =====================================================================

  /** Shared tail for processAll()/processFirst(): applies the selection
   * to the real, unmodified pipeline exactly like every other
   * rawRows-populating code path in this file, marks discovery's own
   * status model (mission section 25/27), and persists it. */
  function applyProcessingSelection(selectedRows, mode, requested, effective, normalized) {
    rawRows = selectedRows;
    invalidateTransformCache();
    if (activeLiveSession) {
      activeLiveSession.discovery = activeLiveSession.discovery || {};
      activeLiveSession.discovery.status = 'processing_complete';
      activeLiveSession.discovery.processingSelection = { mode: mode, requested: requested, effective: effective, processedCount: selectedRows.length };
      activeLiveSession.discovery.updatedAt = Date.now();
      liveSessionSet(hostname, activeLiveSession);
    }
    renderResults();
    return { ok: true, mode: mode, requested: requested, effective: effective, normalized: !!normalized, processedCount: selectedRows.length };
  }

  /** processAll() — mission section 27/49: selects every discovered
   * unique record for processing. */
  function processAll() {
    if (!activeLiveSession) return { ok: false, error: 'no-active-session' };
    if (typeof WSDiscoveryCore === 'undefined') return { ok: false, error: 'discovery-core-unavailable' };
    var selected = WSDiscoveryCore.selectRows(activeLiveSession.rows, 'all', null);
    return applyProcessingSelection(selected, 'all', activeLiveSession.rows.length, activeLiveSession.rows.length, false);
  }

  /** processFirst(n) — mission section 27/48/50: selects exactly the
   * first N unique discovery entries in stable discovery order. Never
   * fails catastrophically on bad input (mission section 50: 0, -5, 2.5,
   * "abc", or an N larger than what was actually discovered) — returns a
   * structured `{ok:false, error}` for a genuinely invalid N, and safely
   * normalizes (clamps) an over-large N down to whatever was actually
   * discovered rather than fabricating rows past that (mission section
   * 36/27). */
  function processFirst(n) {
    if (!activeLiveSession) return { ok: false, error: 'no-active-session' };
    if (typeof WSDiscoveryCore === 'undefined') return { ok: false, error: 'discovery-core-unavailable' };
    var validation = WSDiscoveryCore.validateSelection(activeLiveSession.rows.length, 'first', n);
    if (!validation.ok) return validation;
    var selected = WSDiscoveryCore.selectRows(activeLiveSession.rows, 'first', validation.effective);
    return applyProcessingSelection(selected, 'first', validation.requested, validation.effective, validation.normalized);
  }

  // TEST-ONLY SEAM — never referenced by any real user-facing control.
  // Exists solely so an external harness can invoke the real
  // processAll()/processFirst(n) selection logic against the real
  // activeLiveSession: this project's own JSDOM popup-integration
  // convention, AND this project's real-browser harness, where the
  // native toolbar popup itself cannot be driven at all (see
  // e2e/run.js's own header comment) — exactly the same reachability
  // gap "Use internal/test command if necessary" (mission section 59)
  // anticipates. Carries no security/licensing implications (it only
  // reaches the same data-selection/export pipeline every real BAŞLA
  // session already fully exposes) — not the same risk category as the
  // QA trial/license bypass controls, which stay behind their own
  // separate isDevelopmentInstall() gate untouched by this.
  if (typeof window !== 'undefined') {
    window.__wsDiscoveryTestHooks = {
      processAll: processAll,
      processFirst: processFirst,
      getActiveLiveSession: function () { return activeLiveSession; },
      getRawRows: function () { return rawRows; }
    };
  }

  /** Called once from init(): if a live-collect session already exists
   * for this hostname (active OR finished, not yet exported) — e.g. the
   * popup was closed mid-session and reopened — restore it immediately
   * instead of showing the empty setup screen, and land straight on
   * Sonuçlar. Never charges anything (see the feature header comment). */
  async function restoreLiveSessionIfAny() {
    var session = await liveSessionGet(hostname);
    if (!session || !session.rows || !session.rows.length) return false;
    activeLiveSession = session;
    rawRows = session.rows;
    invalidateTransformCache();
    activeFilter = null;
    activeDedupe = null;
    activeSort = null;
    els.previewSection.hidden = false;
    renderResults();
    if (session.status === 'active') {
      attachLiveSessionStorageListener();
    }
    revealSessionDiagPanelIfDev();
    switchTab('results');
    return true;
  }

  // =====================================================================
  // V1.21 — Structured Data inspector (JSON-LD + common page metadata).
  // Unlike Auto Detect (which REPLACES the whole working configuration
  // with a freshly detected structure), Add Selected Fields here APPENDS
  // to whatever columns already exist — spec #7's explicit "DOM +
  // structured-data coexistence... must work together in the same
  // scraper", so an existing selector-based scraper is never reset by
  // using this panel. Detection itself never touches state at all;
  // "Add Selected Fields" is a fully separate, explicit action, same
  // inspect-first-commit-second pattern as Auto Detect and Deep
  // Scraping's field picker.
  // =====================================================================

  var structuredDataFields = []; // last SCAN_STRUCTURED_DATA result, session-only (never persisted)

  async function handleStructuredDataClick() {
    setStatus('Scanning the page for structured data…', false);
    var res;
    try {
      res = await sendToContent({ type: 'SCAN_STRUCTURED_DATA' });
    } catch (e) {
      setStatus("Couldn't scan this page for structured data.", true);
      return;
    }
    if (!res || !res.ok) {
      setStatus("Couldn't scan this page for structured data.", true);
      return;
    }
    structuredDataFields = res.fields || [];
    els.previewSection.hidden = true;
    renderStructuredDataPanel(res);
    setStatus('');
  }

  function renderStructuredDataPanel(res) {
    els.structuredDataPanel.hidden = false;
    var count = structuredDataFields.length;
    els.sdSummaryBadge.textContent = count + ' field' + (count === 1 ? '' : 's') + ' found';
    els.sdEmptyNote.hidden = count > 0;
    els.sdAddBtn.hidden = count === 0;

    var errors = (res.snapshot && res.snapshot.jsonLd && res.snapshot.jsonLd.errors) || [];
    if (errors.length) {
      // Spec: never crash on malformed JSON-LD — surfaced here as a
      // plain, non-alarming note (other valid data on the page, if any,
      // is still shown normally above/below this).
      els.sdErrorsNote.hidden = false;
      els.sdErrorsNote.textContent = errors.length + ' structured-data block' + (errors.length === 1 ? ' was' : 's were') + ' malformed and skipped (the rest of the page was scanned normally).';
    } else {
      els.sdErrorsNote.hidden = true;
    }

    els.sdFieldsList.innerHTML = '';
    var groups = {};
    var order = [];
    structuredDataFields.forEach(function (field, idx) {
      var g = field.group || 'Other';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push({ field: field, idx: idx });
    });

    order.forEach(function (groupLabel) {
      var heading = document.createElement('div');
      heading.className = 'ws-ad-field-name-row';
      heading.style.margin = '6px 0 2px';
      var headingText = document.createElement('span');
      headingText.className = 'ws-ad-field-name';
      headingText.textContent = groupLabel;
      heading.appendChild(headingText);
      els.sdFieldsList.appendChild(heading);

      groups[groupLabel].forEach(function (entry) {
        var field = entry.field;
        var row = document.createElement('label');
        row.className = 'ws-ad-field-row';

        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.dataset.fieldIndex = String(entry.idx);

        var main = document.createElement('div');
        main.className = 'ws-ad-field-main';

        var nameRow = document.createElement('div');
        nameRow.className = 'ws-ad-field-name-row';
        var nameEl = document.createElement('span');
        nameEl.className = 'ws-ad-field-name';
        nameEl.textContent = field.label;
        nameRow.appendChild(nameEl);
        if (field.kind && field.kind !== 'text') {
          var kindEl = document.createElement('span');
          kindEl.className = 'ws-ad-field-type';
          kindEl.textContent = field.kind === 'image' ? 'Image' : 'URL';
          nameRow.appendChild(kindEl);
        }

        var sampleEl = document.createElement('div');
        sampleEl.className = 'ws-ad-field-sample';
        sampleEl.textContent = field.sampleValue ? 'Sample: ' + field.sampleValue : '(no sample value)';
        sampleEl.title = sampleEl.textContent;

        main.appendChild(nameRow);
        main.appendChild(sampleEl);
        row.appendChild(checkbox);
        row.appendChild(main);
        els.sdFieldsList.appendChild(row);
      });
    });
  }

  function getCheckedStructuredDataFields() {
    var checkboxes = els.sdFieldsList.querySelectorAll('input[type="checkbox"]');
    var checked = [];
    checkboxes.forEach(function (cb) {
      if (cb.checked) checked.push(structuredDataFields[parseInt(cb.dataset.fieldIndex, 10)]);
    });
    return checked;
  }

  function handleStructuredDataCancel() {
    structuredDataFields = [];
    els.structuredDataPanel.hidden = true;
    setStatus('');
  }

  /** Appends the checked fields as new columns (attribute:'structured')
   * onto whatever's already in state.columns — never replaces existing
   * selector-based columns (spec #7). Column names are deduplicated
   * against every existing column exactly like V1.18's Deep Scrape merge
   * does, so adding "Name" when a "Name" column already exists produces
   * "Name (structured)" rather than a silent collision. */
  function handleStructuredDataAdd() {
    var fields = getCheckedStructuredDataFields();
    if (!fields.length) { setStatus('Select at least one field first.', true); return; }

    var existingNames = {};
    state.columns.forEach(function (c) { existingNames[c.name.trim().toLowerCase()] = true; });

    fields.forEach(function (field) {
      var name = field.label;
      if (existingNames[name.trim().toLowerCase()]) {
        var n = 2;
        var candidate = name + ' (structured)';
        while (existingNames[candidate.trim().toLowerCase()]) { candidate = name + ' (structured ' + n + ')'; n++; }
        name = candidate;
      }
      existingNames[name.trim().toLowerCase()] = true;
      state.columns.push({
        id: WSStorage.makeColumnId(), name: name, relativeSelector: null,
        attribute: 'structured', structuredPath: field.path, structuredKind: field.kind || 'text'
      });
    });

    persistState();
    renderColumns();
    structuredDataFields = [];
    els.structuredDataPanel.hidden = true;
    setStatus(fields.length + ' structured field' + (fields.length === 1 ? '' : 's') + ' added.', false);
  }

  // =====================================================================
  // V1.22 — Templates: reusable STARTING configurations. Never locks the
  // user in (spec's own explicit requirement) — everything a template
  // adds is an ordinary, fully editable column/setting afterward, same
  // as Auto Detect/Structured Data before it. Built-in templates are
  // matched against whatever V1.17 Auto Detect / V1.21 Structured Data
  // already found on the CURRENT page (scanned once per popup session,
  // cached, never re-scanned just for browsing templates — spec #26
  // performance); custom templates are a direct, literal copy of an
  // already-working configuration.
  // =====================================================================

  var lastTemplateScan = null; // {autoDetectResult, structuredScanResult} — cached for this popup session only
  var templatePreviewContext = null; // whatever openTemplatePreview last computed, consumed by handleTemplateApply

  // V1.23 spec #27: informational-only tips shown in a built-in template's
  // preview, never applied automatically — see openTemplatePreview.
  var CATEGORY_TRANSFORM_TIP = {
    ecommerce: 'Tip: after applying, consider adding a Normalize Price transform to the Price column (Transform panel → Presets).',
    realestate: 'Tip: after applying, consider adding a Normalize Price transform to the Price column (Transform panel → Presets).',
    jobs: 'Tip: after applying, consider adding a Normalize Date transform to the Published Date column (Transform panel).',
    article: 'Tip: after applying, consider adding a Normalize Date transform to the Published Date column (Transform panel).'
  };

  function closeTemplatesPanel() {
    els.templatesPanel.hidden = true;
    els.tplListView.hidden = false;
    els.tplPreviewView.hidden = true;
    templatePreviewContext = null;
  }

  async function ensureTemplateScan() {
    if (lastTemplateScan) return lastTemplateScan;
    setStatus('Scanning the page for template suggestions…', false);
    var autoDetectResult = { structures: [] };
    var structuredScanResult = { ok: true, snapshot: { jsonLd: { entities: [], errors: [] }, meta: {} }, fields: [] };
    try {
      var adRes = await sendToContent({ type: 'RUN_AUTO_DETECT' });
      if (adRes && adRes.ok) autoDetectResult = adRes;
    } catch (e) { /* no structures found — templates still usable via custom/direct-columns ones */ }
    try {
      var sdRes = await sendToContent({ type: 'SCAN_STRUCTURED_DATA' });
      if (sdRes && sdRes.ok) structuredScanResult = sdRes;
    } catch (e) { /* no structured data found — same fallback */ }
    lastTemplateScan = { autoDetectResult: autoDetectResult, structuredScanResult: structuredScanResult };
    setStatus('');
    return lastTemplateScan;
  }

  async function handleTemplatesClick() {
    els.previewSection.hidden = true;
    els.templatesPanel.hidden = false;
    els.tplListView.hidden = false;
    els.tplPreviewView.hidden = true;
    await renderTemplatesList();
  }

  async function renderTemplatesList() {
    var scan = await ensureTemplateScan();
    var suggestions = WSTemplates.suggestTemplates(scan.autoDetectResult, scan.structuredScanResult);
    if (suggestions.length) {
      var names = suggestions.map(function (s) {
        var t = WSTemplates.getBuiltinTemplate(s.templateId);
        return (t ? t.icon + ' ' + t.name : s.templateId) + ' (' + s.confidence + ')';
      });
      els.tplSuggestionNote.hidden = false;
      els.tplSuggestionNote.textContent = 'Suggested for this page: ' + names.join(', ') + '.';
    } else {
      els.tplSuggestionNote.hidden = true;
    }

    var customTemplates = await WSTemplates.listCustomTemplates();
    els.tplList.innerHTML = '';
    WSTemplates.getBuiltinTemplates().forEach(function (t) { els.tplList.appendChild(buildTemplateRow(t, false)); });
    customTemplates.forEach(function (t) { els.tplList.appendChild(buildTemplateRow(t, true)); });
  }

  function buildTemplateRow(t, isCustom) {
    var row = document.createElement('div');
    row.className = 'ws-template-row';

    var head = document.createElement('div');
    head.className = 'ws-template-head';
    var icon = document.createElement('span'); icon.className = 'ws-template-icon'; icon.textContent = t.icon || '📄';
    var name = document.createElement('span'); name.className = 'ws-template-name'; name.textContent = t.name;
    var badge = document.createElement('span'); badge.className = 'ws-template-badge'; badge.textContent = isCustom ? 'Custom' : 'Built-in';
    head.appendChild(icon); head.appendChild(name); head.appendChild(badge);

    var desc = document.createElement('p');
    desc.className = 'ws-template-desc';
    desc.textContent = t.description || '';

    var actions = document.createElement('div');
    actions.className = 'ws-template-actions';
    var previewBtn = document.createElement('button');
    previewBtn.textContent = 'Preview';
    previewBtn.addEventListener('click', function () { openTemplatePreview(t); });
    actions.appendChild(previewBtn);

    // spec #9: built-in templates are never editable/deletable — only a
    // custom (saved/imported) template gets management actions at all.
    if (isCustom) {
      var renameBtn = document.createElement('button');
      renameBtn.textContent = 'Rename';
      renameBtn.addEventListener('click', function () { handleRenameTemplate(t); });
      var dupBtn = document.createElement('button');
      dupBtn.textContent = 'Duplicate';
      dupBtn.addEventListener('click', function () { handleDuplicateTemplate(t); });
      var exportBtn = document.createElement('button');
      exportBtn.textContent = 'Export';
      exportBtn.addEventListener('click', function () { handleExportTemplate(t); });
      var delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'ws-scraper-danger';
      delBtn.addEventListener('click', function () { handleDeleteTemplate(t); });
      actions.appendChild(renameBtn);
      actions.appendChild(dupBtn);
      actions.appendChild(exportBtn);
      actions.appendChild(delBtn);
    }

    row.appendChild(head);
    row.appendChild(desc);
    row.appendChild(actions);
    return row;
  }

  async function handleRenameTemplate(t) {
    var name = prompt('Rename template:', t.name);
    if (name === null) return;
    var res = await WSTemplates.renameCustomTemplate(t.id, name);
    if (!res.ok) { setStatus(res.error, true); return; }
    renderTemplatesList();
    setStatus('Renamed to "' + res.template.name + '".', false);
  }

  async function handleDuplicateTemplate(t) {
    var res = await WSTemplates.duplicateCustomTemplate(t.id);
    if (!res.ok) { setStatus(res.error, true); return; }
    renderTemplatesList();
    setStatus('Duplicated as "' + res.template.name + '".', false);
  }

  function handleExportTemplate(t) {
    var json = WSTemplates.exportTemplateToJson(t);
    // The viewer sandbox this popup itself might run under blocks
    // script-driven downloads (same constraint every export path in
    // this project already respects) — a template is small, plain-text
    // JSON, so showing it via prompt() (selectable/copyable) is a safe,
    // dependency-free way to get it out without triggering a file save.
    prompt('Copy this template JSON (Ctrl+C, then Cancel):', json);
  }

  async function handleDeleteTemplate(t) {
    if (!confirm('Delete the template "' + t.name + '"? This cannot be undone.')) return;
    var res = await WSTemplates.deleteCustomTemplate(t.id);
    if (!res.ok) { setStatus(res.error, true); return; }
    renderTemplatesList();
    setStatus('Deleted "' + t.name + '".', false);
  }

  async function handleSaveCurrentAsTemplate() {
    if (!state.columns.length) { setStatus('Add at least one column first.', true); return; }
    var suggested = hostname ? hostname.replace(/^www\./, '') + ' Template' : 'My Template';
    var name = prompt('Template Name:', suggested);
    if (name === null) return;
    var runFields = currentRunModeFields();
    var dsFields = currentDeepScrapePrefsFields();
    var res = await WSTemplates.saveCustomTemplate({
      name: name, description: '',
      columns: state.columns, containerSelector: state.containerSelector,
      paginationConfig: runFields.mode && runFields.mode !== 'current-page' ? runFields : null,
      deepScrapeConfig: (dsFields.deepScrape && dsFields.deepScrape.fields && dsFields.deepScrape.fields.length) ? dsFields.deepScrape : null,
      // V1.23 spec #27: capture the current transform pipeline too, if any
      // — sanitized (never trusted as-is) inside WSTemplates.normalizeTemplate.
      transforms: activeTransforms
    });
    if (!res.ok) { setStatus(res.error, true); return; }
    setStatus('Saved "' + res.template.name + '" as a template.', false);
    if (!els.templatesPanel.hidden) renderTemplatesList();
  }

  function handleImportTemplateFile() {
    els.tplImportFile.value = '';
    els.tplImportFile.click();
  }

  function handleImportTemplateFileChange() {
    var file = els.tplImportFile.files && els.tplImportFile.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      var res = WSTemplates.importTemplateFromJson(String(reader.result || ''));
      if (!res.ok) { setStatus('Import failed: ' + res.error, true); return; }
      // Imported templates are ALWAYS treated as custom (never silently
      // marked builtin, whatever the file claims — see normalizeTemplate)
      // and go through the exact same name-collision-checked save path
      // a fresh "Save as Template" does.
      var saveRes = await WSTemplates.saveCustomTemplate(res.template);
      if (!saveRes.ok) { setStatus('Import failed: ' + saveRes.error, true); return; }
      renderTemplatesList();
      setStatus('Imported "' + saveRes.template.name + '".', false);
    };
    reader.onerror = function () { setStatus('Could not read that file.', true); };
    reader.readAsText(file);
  }

  /** Shows what applying `t` would actually do, WITHOUT changing
   * anything yet (spec #4: "the user must understand what will be
   * added before applying it") — a fully separate, explicit Apply click
   * is still required afterward. */
  async function openTemplatePreview(t) {
    els.tplListView.hidden = true;
    els.tplPreviewView.hidden = false;
    els.tplPreviewName.textContent = (t.icon || '📄') + ' ' + t.name;
    els.tplPreviewDesc.textContent = t.description || '';
    els.tplPreviewFields.innerHTML = '';

    if (t.applyStrategy === 'direct-columns') {
      // A custom template already has real, concrete columns — no
      // matching needed, just show exactly what's in it.
      templatePreviewContext = { template: t, isDirect: true };
      els.tplPreviewNote.hidden = false;
      els.tplPreviewNote.textContent = 'Applying this template will REPLACE your current columns and Run Mode settings with this template’s own (' + t.columns.length + ' column' + (t.columns.length === 1 ? '' : 's') + ').';
      t.columns.forEach(function (c) {
        var row = document.createElement('div');
        row.className = 'ws-ad-field-row';
        var main = document.createElement('div'); main.className = 'ws-ad-field-main';
        var nameRow = document.createElement('div'); nameRow.className = 'ws-ad-field-name-row';
        var nameEl = document.createElement('span'); nameEl.className = 'ws-ad-field-name'; nameEl.textContent = c.name;
        var typeEl = document.createElement('span'); typeEl.className = 'ws-ad-field-type'; typeEl.textContent = attrLabel(c.attribute);
        nameRow.appendChild(nameEl); nameRow.appendChild(typeEl);
        main.appendChild(nameRow);
        row.appendChild(main);
        els.tplPreviewFields.appendChild(row);
      });
      els.tplPreviewUnmatched.hidden = true;
      els.tplApplyBtn.hidden = t.columns.length === 0;
      return;
    }

    var scan = await ensureTemplateScan();
    var matchResult = WSTemplates.matchTemplateFields(t, scan.autoDetectResult, scan.structuredScanResult.fields || []);

    // A field sourced from Auto Detect needs ITS OWN freshly-detected
    // container — safe to apply only when the scraper doesn't already
    // have a DIFFERENT container/columns in place (never silently mixes
    // two unrelated containers' selectors together).
    var hasExistingContainer = !!state.containerSelector;
    var usable = [];
    var blockedCount = 0;
    matchResult.matched.forEach(function (m) {
      if (m.source === 'autodetect' && hasExistingContainer) { blockedCount++; return; }
      usable.push(m);
    });

    templatePreviewContext = { template: t, isDirect: false, usable: usable, matchResult: matchResult };

    if (blockedCount > 0) {
      els.tplPreviewNote.hidden = false;
      els.tplPreviewNote.textContent = blockedCount + ' field' + (blockedCount === 1 ? '' : 's') + ' would need a fresh page structure and ' + (blockedCount === 1 ? 'was' : 'were') + ' skipped because you already have columns set up (use Reset Columns first to use ' + (blockedCount === 1 ? 'it' : 'them') + '). Matched fields below will be ADDED to your current columns.';
    } else if (usable.length) {
      els.tplPreviewNote.hidden = false;
      els.tplPreviewNote.textContent = 'Matched fields below will be ADDED to your current columns — nothing existing is removed.';
    } else {
      els.tplPreviewNote.hidden = true;
    }

    // V1.23 spec #27: a purely INFORMATIONAL tip only — never applies a
    // transform automatically. A built-in template's apply is an append-
    // only action the user didn't get to preview column-by-column before
    // clicking Apply, so auto-adding transform steps here would go
    // against spec's "never force transformation without explicit UX
    // confirmation." The user can add the suggested transform themselves
    // afterward from the Transform panel (optionally via the matching Preset).
    var tip = CATEGORY_TRANSFORM_TIP[t.category];
    if (tip) {
      els.tplPreviewNote.hidden = false;
      els.tplPreviewNote.textContent += (els.tplPreviewNote.textContent ? ' ' : '') + tip;
    }

    usable.forEach(function (m, idx) {
      var row = document.createElement('label');
      row.className = 'ws-ad-field-row';
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.fieldIndex = String(idx);
      var main = document.createElement('div'); main.className = 'ws-ad-field-main';
      var nameRow = document.createElement('div'); nameRow.className = 'ws-ad-field-name-row';
      var nameEl = document.createElement('span'); nameEl.className = 'ws-ad-field-name'; nameEl.textContent = m.name;
      var sourceEl = document.createElement('span'); sourceEl.className = 'ws-ad-field-type';
      sourceEl.textContent = m.source === 'structured' ? 'Structured' : (m.source === 'computed' ? 'Computed' : 'Auto Detect');
      nameRow.appendChild(nameEl); nameRow.appendChild(sourceEl);
      var sampleEl = document.createElement('div'); sampleEl.className = 'ws-ad-field-sample';
      sampleEl.textContent = m.sampleValue ? 'Sample: ' + m.sampleValue : '(no sample value)';
      main.appendChild(nameRow); main.appendChild(sampleEl);
      row.appendChild(checkbox); row.appendChild(main);
      els.tplPreviewFields.appendChild(row);
    });

    if (matchResult.unmatched.length) {
      els.tplPreviewUnmatched.hidden = false;
      els.tplPreviewUnmatched.textContent = 'Not found on this page: ' + matchResult.unmatched.join(', ') + ' — you can still add these manually afterward.';
    } else {
      els.tplPreviewUnmatched.hidden = true;
    }

    els.tplApplyBtn.hidden = usable.length === 0;
  }

  function handleTemplatePreviewBack() {
    els.tplListView.hidden = false;
    els.tplPreviewView.hidden = true;
    templatePreviewContext = null;
  }

  /** spec #5/#12: applying NEVER creates a "permanently special" scraper
   * — every generated column is an ordinary one, and a name collision is
   * resolved deterministically (a "(template)" suffix, the SAME pattern
   * V1.21's Structured Data inspector already established) rather than
   * silently overwriting an existing column. */
  function handleTemplateApply() {
    if (!templatePreviewContext) return;
    var ctx = templatePreviewContext;

    if (ctx.isDirect) {
      var t = ctx.template;
      // Every applied column gets a FRESH id (so re-applying the same
      // template twice, or applying it alongside manually-added columns,
      // can never collide) — track old->new so the template's OWN
      // transform pipeline (V1.23), which references those same original
      // ids, can be rewritten to match rather than pointing at ids that
      // no longer exist.
      var idMap = {};
      var newColumns = t.columns.map(function (c) {
        var newId = WSStorage.makeColumnId();
        idMap[c.id] = newId;
        return Object.assign({}, c, { id: newId });
      });
      state = { containerSelector: t.containerSelector, columns: newColumns };
      persistState();
      loadedScraperId = null;
      loadedScraperName = null;
      deepScrapeConfig = t.deepScrapeConfig ? WSRecipes.normalizeDeepScrape(t.deepScrapeConfig) : WSRecipes.emptyDeepScrape();
      renderDeepScrapePanel();
      WSRecipes.setLoadedScraperId(hostname, null);
      applyRunModeConfigToUI(t.paginationConfig || {});
      renderColumns();
      clearResults();
      // V1.23 spec #27: a custom template's transform pipeline (if any)
      // replaces the working one too, consistent with this branch's
      // overall "replace the whole config" semantics — mirrors how
      // applyLoadedScraper restores scraper.transforms. MUST run AFTER
      // clearResults(), which unconditionally resets activeTransforms to
      // [] as part of clearing a stale scrape's results. Column
      // references inside each step are rewritten through idMap so they
      // still resolve against the freshly-minted column ids above.
      activeTransforms = (t.transforms || []).map(function (step) {
        var clone = JSON.parse(JSON.stringify(step));
        if (clone.column && idMap[clone.column]) clone.column = idMap[clone.column];
        if (clone.options && Array.isArray(clone.options.sourceColumns)) {
          clone.options.sourceColumns = clone.options.sourceColumns.map(function (id) { return idMap[id] || id; });
        }
        return clone;
      });
      invalidateTransformCache();
      renderTransformHistory();
      closeTemplatesPanel();
      setStatus('Applied template "' + t.name + '".', false);
      return;
    }

    var checkboxes = els.tplPreviewFields.querySelectorAll('input[type="checkbox"]');
    var toAdd = [];
    checkboxes.forEach(function (cb) { if (cb.checked) toAdd.push(ctx.usable[parseInt(cb.dataset.fieldIndex, 10)]); });
    if (!toAdd.length) { setStatus('Select at least one field first.', true); return; }

    var existingNames = {};
    state.columns.forEach(function (c) { existingNames[c.name.trim().toLowerCase()] = true; });

    if (!state.containerSelector && ctx.matchResult.usesAutoDetect && ctx.matchResult.containerSelector) {
      state.containerSelector = ctx.matchResult.containerSelector;
    }

    toAdd.forEach(function (m) {
      var name = m.name;
      if (existingNames[name.trim().toLowerCase()]) {
        var n = 2;
        var candidate = name + ' (template)';
        while (existingNames[candidate.trim().toLowerCase()]) { candidate = name + ' (template ' + n + ')'; n++; }
        name = candidate;
      }
      existingNames[name.trim().toLowerCase()] = true;

      if (m.source === 'structured') {
        state.columns.push({ id: WSStorage.makeColumnId(), name: name, relativeSelector: null, attribute: 'structured', structuredPath: m.structuredPath, structuredKind: m.structuredKind || 'text' });
      } else if (m.source === 'computed') {
        state.columns.push({ id: WSStorage.makeColumnId(), name: name, relativeSelector: ':scope', attribute: 'position' });
      } else {
        state.columns.push({ id: WSStorage.makeColumnId(), name: name, relativeSelector: m.relativeSelector, attribute: m.attribute, attributeName: m.attributeName || null });
      }
    });

    persistState();
    renderColumns();
    closeTemplatesPanel();
    setStatus(toAdd.length + ' field' + (toAdd.length === 1 ? '' : 's') + ' added from "' + ctx.template.name + '".', false);
  }

  // =====================================================================
  // Run Mode (V1.3): Auto Scroll / Multi-page setup + live progress.
  // Orchestration itself runs entirely in content/pagination.js; this
  // popup only sends the Start/Stop/Resume messages and reflects whatever
  // chrome.storage.session already says, so closing and reopening the
  // popup mid-run is always safe.
  // =====================================================================

  function getSelectedRunMode() {
    var checked = document.querySelector('input[name="run-mode"]:checked');
    return checked ? checked.value : 'current-page';
  }

  function runKey() {
    return 'ws_run::' + hostname;
  }

  function sessionGet(key) {
    return new Promise(function (resolve) {
      chrome.storage.session.get([key], function (result) { resolve((result && result[key]) || null); });
    });
  }

  function sessionSet(key, value) {
    return new Promise(function (resolve) {
      var data = {};
      data[key] = value;
      chrome.storage.session.set(data, resolve);
    });
  }

  // V1.19: Multi-page's Next button and Load More's button share the
  // exact same underlying pick (a single relativeSelector) and the same
  // pendingNextButtonConfig variable — only the STATUS TEXT differs per
  // mode, so both status nodes are always kept in sync together (whichever
  // one is actually visible is decided purely by onRunModeChanged's
  // hidden/shown panels, never by which text was last written here).
  function updateNextButtonStatusText() {
    var text = pendingNextButtonConfig ? 'Set (matches the control on this page)' : 'Not set';
    els.nextButtonStatus.textContent = text;
    if (els.lmButtonStatus) els.lmButtonStatus.textContent = text;
  }

  function updateUrlPatternStatusText() {
    if (!els.urlPatternStatus) return;
    els.urlPatternStatus.textContent = pendingUrlPatternConfig
      ? 'Set (' + (pendingUrlPatternConfig.kind === 'path' ? '/' + pendingUrlPatternConfig.key + '/N path' : '?' + pendingUrlPatternConfig.key + '=N query') + ', starting at ' + pendingUrlPatternConfig.start + ', step ' + pendingUrlPatternConfig.step + ')'
      : 'Not detected — use Auto-Detect Pagination above, or configure manually.';
  }

  function onMpMethodChanged() {
    var usingUrlPattern = els.mpMethod && els.mpMethod.value === 'urlPattern';
    if (els.mpNextButtonConfig) els.mpNextButtonConfig.hidden = usingUrlPattern;
    if (els.mpUrlPatternConfig) els.mpUrlPatternConfig.hidden = !usingUrlPattern;
  }

  /** V1 UX WORKFLOW SIMPLIFICATION: exactly ONE extraction button is ever
   * visible — #preview-btn for Current Page, #start-run-btn for every
   * other run mode (both keep their own pre-existing id/click handler/
   * behavior; only which one is shown changes here). Previously
   * #preview-btn was shown unconditionally, so Auto Scroll/Multi-page/
   * Load More modes showed BOTH buttons at once with no indication which
   * one to actually click — this was the literal "Preview vs Start"
   * confusion. Also keeps the "Advanced Settings" disclosure
   * (#run-section-advanced) open once a non-default mode is selected or
   * restored (e.g. loading a saved scraper), so a configured run mode is
   * never left hidden behind a collapsed section — never force-closes it. */
  function onRunModeChanged() {
    var mode = getSelectedRunMode();
    els.autoScrollOptions.hidden = mode !== 'auto-scroll';
    els.multiPageOptions.hidden = mode !== 'multi-page';
    els.loadMoreOptions.hidden = mode !== 'load-more';
    els.paginationDetectWrap.hidden = (mode !== 'multi-page' && mode !== 'load-more');
    els.runDedupeOptions.hidden = mode === 'current-page';
    els.startRunBtn.hidden = mode === 'current-page';
    if (els.previewBtn) els.previewBtn.hidden = mode !== 'current-page';
    if (mode !== 'current-page' && els.runSectionAdvanced) els.runSectionAdvanced.open = true;
    // V1 SIMPLIFIED SESSION WORKFLOW: the whole explicit Run Mode flow
    // now lives inside the "Gelişmiş" wrapper — keep it (and Manual mode,
    // since Run Mode is Manual-only content) open/selected whenever a
    // non-default mode is in play, so a user who explicitly opted into
    // this power-user flow is never left staring at a collapsed panel.
    if (mode !== 'current-page') {
      if (els.scrapeAdvancedPanel) els.scrapeAdvancedPanel.open = true;
      setScrapeModeUi('manual', { sessionOnly: true });
    }
    if (mode === 'multi-page') onMpMethodChanged();
    if (mode !== 'current-page') {
      populateColumnSelect(els.runDedupeKey, true);
    }
  }

  /** Reused for both Multi-page's Next button and Load More's button —
   * `label` only changes the on-page banner/status text, never the
   * underlying pick mechanism (content.js's 'next-button' picker purpose
   * is completely mode-agnostic; it just resolves a stable selector for
   * whatever element gets clicked). */
  async function handleSelectNextButton() {
    setStatus('Preparing selection mode…', false);
    try {
      // Clear any stale prior pick so we can tell a fresh one apart.
      await sessionSet('ws_next_button_pick::' + hostname, null);
      await sendToContent({ type: 'START_PICK', purpose: 'next-button' });
      var mode = getSelectedRunMode();
      setStatus(mode === 'load-more'
        ? 'Click the "Load More" / "Show More" button on the page (Esc to cancel).'
        : 'Click the "Next" / pagination control on the page (Esc to cancel).', false);
    } catch (e) {
      setStatus("Couldn't start selection on this page.", true);
    }
  }

  async function checkForPendingNextButtonPick() {
    var key = 'ws_next_button_pick::' + hostname;
    var pick = await sessionGet(key);
    if (pick && pick.relativeSelector) {
      pendingNextButtonConfig = { relativeSelector: pick.relativeSelector };
      await sessionSet(key, null); // consumed
      updateNextButtonStatusText();
      setStatus('Button selected' + (pick.disabled ? ' (⚠ looked disabled at pick time — double-check).' : '.'), false);
    }
  }

  // =====================================================================
  // V1.19 #2 — Pagination Auto-Detect: conservative, suggestion-only.
  // Never starts a run by itself; "Use Detected" only fills in the exact
  // same fields a manual pick/entry would, leaving Start as a fully
  // separate, explicit user action either way.
  // =====================================================================

  function paginationDetectionSummary(detection) {
    if (!detection || !detection.detected) return 'No pagination confidently detected on this page.';
    if (detection.detected === 'load-more' && detection.candidate) {
      return 'Load More button: "' + (detection.candidate.previewText || detection.candidate.relativeSelector) + '"';
    }
    if (detection.detected === 'pagination' && detection.candidate) {
      return 'Next button: "' + (detection.candidate.previewText || detection.candidate.relativeSelector) + '"';
    }
    if (detection.detected === 'pagination' && detection.urlPattern) {
      return 'URL pattern: ' + (detection.urlPattern.kind === 'path' ? '/' + detection.urlPattern.key + '/N' : '?' + detection.urlPattern.key + '=N');
    }
    return 'No pagination confidently detected on this page.';
  }

  async function handleDetectPagination() {
    setStatus('Scanning the page for pagination…', false);
    try {
      var res = await sendToContent({ type: 'RUN_PAGINATION_AUTO_DETECT' });
      lastPaginationDetection = (res && res.ok) ? res : null;
    } catch (e) {
      lastPaginationDetection = null;
    }
    els.paginationDetectResult.hidden = false;
    els.pdSummaryText.textContent = 'Detected: ' + paginationDetectionSummary(lastPaginationDetection);
    var confidence = (lastPaginationDetection && lastPaginationDetection.candidate) ? 'high'
      : (lastPaginationDetection && lastPaginationDetection.urlPattern) ? lastPaginationDetection.urlPattern.confidence
      : null;
    els.pdConfidenceBadge.textContent = confidence ? confidence.toUpperCase() : '';
    els.pdConfidenceBadge.className = 'ws-status-badge' + (confidence ? ' ws-conf-' + confidence : '');
    els.pdUseBtn.hidden = !(lastPaginationDetection && lastPaginationDetection.detected);
    setStatus('', false);
  }

  function handleUseDetectedPagination() {
    var detection = lastPaginationDetection;
    if (!detection || !detection.detected) return;

    if (detection.candidate && detection.candidate.kind === 'load-more') {
      document.querySelector('input[name="run-mode"][value="load-more"]').checked = true;
      pendingNextButtonConfig = { relativeSelector: detection.candidate.relativeSelector };
      updateNextButtonStatusText();
    } else if (detection.candidate && detection.candidate.kind === 'next-button') {
      document.querySelector('input[name="run-mode"][value="multi-page"]').checked = true;
      if (els.mpMethod) els.mpMethod.value = 'nextButton';
      pendingNextButtonConfig = { relativeSelector: detection.candidate.relativeSelector };
      updateNextButtonStatusText();
    } else if (detection.urlPattern) {
      document.querySelector('input[name="run-mode"][value="multi-page"]').checked = true;
      if (els.mpMethod) els.mpMethod.value = 'urlPattern';
      pendingUrlPatternConfig = {
        kind: detection.urlPattern.kind, key: detection.urlPattern.key, style: detection.urlPattern.style,
        start: detection.urlPattern.start, step: detection.urlPattern.step > 0 ? detection.urlPattern.step : 1
      };
      if (els.urlPatternKey) els.urlPatternKey.value = pendingUrlPatternConfig.kind + ':' + pendingUrlPatternConfig.key;
      if (els.urlPatternStart) els.urlPatternStart.value = pendingUrlPatternConfig.start;
      if (els.urlPatternStep) els.urlPatternStep.value = pendingUrlPatternConfig.step;
      updateUrlPatternStatusText();
    }

    onRunModeChanged();
    els.paginationDetectResult.hidden = true;
    setStatus('Detected pagination applied — review the fields below, then Start when ready.', false);
  }

  function handleDismissPaginationDetection() {
    els.paginationDetectResult.hidden = true;
  }

  /** Builds a urlPatternConfig from the manual URL Pattern fields —
   * returns null (with a status message already set) if the fields don't
   * describe a usable pattern, e.g. an offset-style key detected with no
   * confirmed step. Never guesses a step on the caller's behalf. */
  function buildUrlPatternConfigFromFields() {
    var raw = els.urlPatternKey.value || 'query:page';
    var parts = raw.split(':');
    var kind = parts[0] === 'path' ? 'path' : 'query';
    var key = parts[1] || 'page';
    var start = parseInt(els.urlPatternStart.value, 10);
    var step = parseInt(els.urlPatternStep.value, 10);
    if (!(start >= 0) || !(step >= 1)) {
      setStatus('Enter a valid starting value and step for URL Pattern pagination.', true);
      return null;
    }
    return { kind: kind, key: key, style: kind === 'path' ? 'page' : (key === 'start' || key === 'offset' ? 'offset' : 'page'), start: start, step: step };
  }

  // V1 FINAL production audit (spec #9/#47): handleStartRun and
  // handlePreview previously had NO re-entrancy guard — neither the
  // Start Run button nor the Preview button was ever disabled while its
  // own async chain (a permission prompt + content-script registration +
  // content-script round-trip for Start Run; a content-script round-trip
  // for Preview) was in flight. A genuine rapid double-click during that
  // window could start two overlapping runs — for Start Run, two
  // overlapping pagination loops racing on the same session-storage
  // run-state key; for Preview, each with its own unique runId, meaning
  // BOTH could successfully charge a trial credit for what the user
  // experienced as one click (WSLicense.consumeRunCredit's runId-based
  // idempotency only prevents the SAME run being charged twice, not two
  // distinct accidental runs). Fixed with a minimal, purely-additive
  // re-entrancy flag shared by both (they're mutually exclusive user
  // actions anyway, never legitimately fired at the same instant) — no
  // change to either function's actual logic, ordering, or error handling.
  var runTriggerInFlight = false;

  async function handleStartRun() {
    if (runTriggerInFlight) return;
    runTriggerInFlight = true;
    try {
      await handleStartRunInner();
    } finally {
      runTriggerInFlight = false;
    }
  }

  async function handleStartRunInner() {
    var mode = getSelectedRunMode();
    if (mode === 'current-page') return;
    if (!state.columns.length) { setStatus('Add at least one column first.', true); return; }

    var mpMethod = els.mpMethod ? els.mpMethod.value : 'nextButton';
    var urlPatternConfigToUse = null;

    if (mode === 'multi-page' && mpMethod === 'urlPattern') {
      urlPatternConfigToUse = buildUrlPatternConfigFromFields();
      if (!urlPatternConfigToUse) return; // status already set
    } else if ((mode === 'multi-page' && mpMethod !== 'urlPattern') || mode === 'load-more') {
      if (!pendingNextButtonConfig) {
        setStatus(mode === 'load-more' ? 'Select a Load More button first.' : 'Select a Next button first.', true);
        return;
      }
    }
    if (!(await trialAllowsNewRun())) { showTrialCompleteModal(); return; }

    var dedupeKey = els.runDedupeKey.value || 'entire-row';

    if (mode === 'auto-scroll') {
      var asLimits = {
        maxRows: parseInt(els.asMaxRows.value, 10) || 1000,
        maxScrolls: parseInt(els.asMaxScrolls.value, 10) || 100,
        noNewDataAttempts: 3
      };
      setStatus('Starting Auto Scroll…', false);
      try {
        await sendToContent({
          type: 'START_AUTO_SCROLL', tabId: tabId,
          containerSelector: state.containerSelector, columns: state.columns,
          dedupeKey: dedupeKey, limits: asLimits
        });
      } catch (e) {
        setStatus("Couldn't start Auto Scroll on this page.", true);
        return;
      }
      showRunProgressUI();
      return;
    }

    // multi-page / load-more: both need a runtime-scoped host permission
    // so the run can survive a real page navigation (see manifest.json's
    // optional_host_permissions — nothing is granted until this exact
    // moment, and only for this one site). Load More gets the exact same
    // treatment as Multi-page (V1.19) since its own loop tolerates a real
    // navigation too (spec #5's usual same-document append is still the
    // common case, but it's not assumed to be the ONLY case).
    var modeLabel = mode === 'load-more' ? 'Load More' : 'Multi-page';
    var origin = originPatternFor(hostname);
    setStatus('Requesting permission for ' + hostname + '…', false);
    var granted;
    try {
      granted = await chrome.permissions.request({ origins: [origin] });
    } catch (e) {
      granted = false;
    }
    if (!granted) {
      setStatus('Permission was declined — ' + modeLabel + ' needs access to this site to keep working after each page change.', true);
      return;
    }

    try {
      await chrome.scripting.registerContentScript({
        id: 'ws-pagination-' + hostname,
        matches: [origin],
        js: CONTENT_FILES,
        runAt: 'document_idle',
        persistAcrossSessions: false
      });
    } catch (e) {
      // Most likely a duplicate id from a previous run on this same site —
      // re-register cleanly rather than failing the whole Start action.
      try {
        await chrome.scripting.unregisterContentScripts({ ids: ['ws-pagination-' + hostname] });
        await chrome.scripting.registerContentScript({
          id: 'ws-pagination-' + hostname, matches: [origin], js: CONTENT_FILES,
          runAt: 'document_idle', persistAcrossSessions: false
        });
      } catch (e2) {
        setStatus('Could not set up ' + modeLabel + ' for this site. Try again.', true);
        return;
      }
    }

    if (mode === 'load-more') {
      var lmLimits = {
        maxClicks: parseInt(els.lmMaxClicks.value, 10) || 30,
        maxRows: parseInt(els.lmMaxRows.value, 10) || 1000,
        noNewDataAttempts: 3,
        delayMs: parseInt(els.lmDelayMs.value, 10) || 0,
        retryCount: parseInt(els.lmRetryCount.value, 10) || 0
      };
      setStatus('Starting Load More…', false);
      try {
        await sendToContent({
          type: 'START_LOAD_MORE', tabId: tabId,
          containerSelector: state.containerSelector, columns: state.columns,
          dedupeKey: dedupeKey, limits: lmLimits, nextButtonConfig: pendingNextButtonConfig
        });
      } catch (e) {
        setStatus("Couldn't start Load More on this page.", true);
        return;
      }
      showRunProgressUI();
      return;
    }

    var mpLimits = {
      maxPages: parseInt(els.mpMaxPages.value, 10) || 10,
      maxRows: parseInt(els.mpMaxRows.value, 10) || 1000,
      delayMs: parseInt(els.mpDelayMs.value, 10) || 0,
      retryCount: parseInt(els.mpRetryCount.value, 10) || 0
    };

    setStatus('Starting Multi-page…', false);
    try {
      await sendToContent({
        type: 'START_MULTI_PAGE', tabId: tabId,
        containerSelector: state.containerSelector, columns: state.columns,
        dedupeKey: dedupeKey, limits: mpLimits,
        nextButtonConfig: mpMethod === 'urlPattern' ? null : pendingNextButtonConfig,
        paginationMethod: mpMethod, urlPatternConfig: urlPatternConfigToUse
      });
    } catch (e) {
      setStatus("Couldn't start Multi-page on this page.", true);
      return;
    }
    showRunProgressUI();
  }

  function originPatternFor(host) {
    return '*://' + host + '/*';
  }

  async function cleanupRunPermissions(runState) {
    if (!runState || (runState.mode !== 'multi-page' && runState.mode !== 'load-more')) return;
    var origin = originPatternFor(runState.hostname);
    try { await chrome.scripting.unregisterContentScripts({ ids: ['ws-pagination-' + runState.hostname] }); } catch (e) { /* ignore */ }
    try { await chrome.permissions.remove({ origins: [origin] }); } catch (e) { /* ignore */ }
  }

  function showRunProgressUI() {
    els.runSection.hidden = true;
    els.runProgressSection.hidden = false;
    // #run-progress-section lives inside the "Gelişmiş" wrapper (Manual
    // mode only) — force both open so an in-progress/just-restored Auto
    // Scroll/Multi-page/Load More run's status is never silently hidden
    // behind a collapsed panel on popup reopen (renderRunProgress calls
    // this from init()'s existingRun restore path).
    if (els.scrapeAdvancedPanel) els.scrapeAdvancedPanel.open = true;
    setScrapeModeUi('manual', { sessionOnly: true });
  }

  function showRunSetupUI() {
    els.runProgressSection.hidden = true;
    els.runSection.hidden = false;
    // #run-section only ever reaches this un-hidden state for a non-
    // Current-Page mode (Current Page never shows run-progress-section in
    // the first place) — always reopen its Advanced Settings wrapper AND
    // the outer "Gelişmiş" wrapper (plus Manual mode) so it's actually
    // visible to the user, not just present-but-collapsed.
    if (els.runSectionAdvanced) els.runSectionAdvanced.open = true;
    if (els.scrapeAdvancedPanel) els.scrapeAdvancedPanel.open = true;
    setScrapeModeUi('manual', { sessionOnly: true });
  }

  var STOP_REASON_LABELS = {
    'user': 'stopped by you',
    'max-rows': 'reached the max rows limit',
    'max-scrolls': 'reached the max scrolls limit',
    'no-new-data': 'no new data found after several attempts',
    'reached-bottom': 'reached the bottom of the page',
    'max-pages': 'reached the max pages limit',
    'disabled-next': 'no more pages (the button is disabled)',
    'loop': 'a repeated page/content loop was detected',
    'next-not-found': 'the button could not be found on this page',
    'page-not-changed': 'the page did not change after clicking',
    // V1.19 additions
    'max-clicks': 'reached the max clicks limit',
    'button-gone': 'no more results (the Load More button is gone)',
    'origin-changed': 'stopped — the page navigated away from this site'
  };

  function describeStopReason(reason) {
    return STOP_REASON_LABELS[reason] || reason || 'unknown reason';
  }

  // 'paused' is deliberately NOT in this list — a paused run isn't
  // "done" in any sense the completion-reason line below should
  // describe, and Stop must stay available while paused (V1.20: Pause
  // must not behave like Stop — the user can still fully Stop a paused
  // run, or Resume it; both remain live choices).
  var TERMINAL_STATUSES = ['completed', 'stopped', 'error'];

  function renderRunProgress(runState) {
    if (!runState) { showRunSetupUI(); return; }

    showRunProgressUI();
    els.runStatusBadge.textContent = runState.status.toUpperCase();
    els.runStatusBadge.className = 'ws-status-badge ws-status-' + runState.status;

    var line;
    if (runState.mode === 'auto-scroll') {
      line = 'Rows collected: ' + runState.rows.length + '  •  Scrolls: ' + runState.progress.scrollCount + '  •  New last pass: ' + runState.progress.lastPassNewRows;
    } else if (runState.mode === 'load-more') {
      line = 'Clicks: ' + runState.progress.clickCount + (runState.limits && runState.limits.maxClicks ? ' / ' + runState.limits.maxClicks : '') +
        '  •  Rows collected: ' + runState.rows.length + '  •  New last click: ' + runState.progress.lastPassNewRows;
    } else {
      line = 'Page ' + runState.progress.pageNumber + (runState.limits && runState.limits.maxPages ? ' / ' + runState.limits.maxPages : '') + '  •  Rows: ' + runState.rows.length +
        '  •  New last page: ' + runState.progress.lastPassNewRows;
    }

    var isTerminal = TERMINAL_STATUSES.indexOf(runState.status) !== -1;
    if (isTerminal) {
      line += ' — ' + (runState.status === 'error' ? 'Error: ' : runState.status === 'stopped' ? 'Stopped: ' : 'Completed: ') + describeStopReason(runState.stopReason);
    } else if (runState.status === 'paused') {
      line += ' — Paused. Resume to continue from here, or Stop to finish.';
    }
    els.runProgressText.textContent = line;

    // V1.20: user-visible retry status (never affects control flow).
    var retryStatus = runState.progress && runState.progress.retryStatus;
    if (els.runRetryStatus) {
      els.runRetryStatus.hidden = !retryStatus;
      els.runRetryStatus.textContent = retryStatus || '';
    }

    els.pauseRunBtn.hidden = isTerminal || runState.status === 'paused';
    els.stopRunBtn.hidden = isTerminal;
    els.resumeRunBtn.hidden = runState.status !== 'stopped' && runState.status !== 'paused';
    els.viewRunResultsBtn.hidden = runState.rows.length === 0;
  }

  async function handleStopRun() {
    setStatus('Stopping…', false);
    try { await sendToContent({ type: 'STOP_RUN' }); } catch (e) { /* fall through to the direct-write safety net below */ }
    // Defensive fallback: guarantees Stop takes effect (preventing any
    // future bootstrap-resume) even if the content script isn't currently
    // reachable (e.g. the tab is between page loads right now).
    var rs = await sessionGet(runKey());
    if (rs && rs.status !== 'stopped') {
      rs.status = 'stopped';
      rs.stopReason = 'user';
      rs.updatedAt = Date.now();
      await sessionSet(runKey(), rs);
      renderRunProgress(rs);
    }
  }

  /** V1.20 — a distinct action from Stop (spec: "Pause must not behave
   * like Stop"). Same delivery mechanics/defensive fallback as Stop
   * above, writing 'paused' instead of 'stopped'. */
  async function handlePauseRun() {
    setStatus('Pausing…', false);
    try { await sendToContent({ type: 'PAUSE_RUN' }); } catch (e) { /* fall through to the direct-write safety net below */ }
    var rs = await sessionGet(runKey());
    if (rs && rs.status !== 'paused') {
      rs.status = 'paused';
      rs.stopReason = 'user';
      rs.updatedAt = Date.now();
      await sessionSet(runKey(), rs);
      renderRunProgress(rs);
    }
  }

  async function handleResumeRun() {
    setStatus('Resuming…', false);
    try {
      var res = await sendToContent({ type: 'RESUME_RUN' });
      if (!res || !res.ok) throw new Error(res && res.error);
    } catch (e) {
      setStatus("Couldn't resume — reopen this page and try again.", true);
    }
  }

  async function handleViewRunResults() {
    var rs = await sessionGet(runKey());
    if (!rs || !rs.rows.length) return;
    rawRows = rs.rows;
    invalidateTransformCache(); // keep activeTransforms, same rationale as handlePreview
    activeFilter = null;
    activeDedupe = null;
    activeSort = null;
    els.filterPanel.hidden = true;
    els.sortPanel.hidden = true;
    els.dedupePanel.hidden = true;
    els.previewSection.hidden = false;
    renderResults();
    setStatus('');
  }

  /** V1.15: the ONE place an Auto Scroll/Multi-page run's trial credit is
   * charged — a run only ever completes successfully via
   * runState.status === 'completed' ('stopped'/'error' never charge, per
   * spec). Called from BOTH attachRunStorageListener's onChanged callback
   * (the common case: popup open when the run finishes) AND init's own
   * "was a run already sitting here when the popup opened?" check (the
   * run kept going with the popup closed and finished in the background —
   * still must be charged exactly once). Safe to call from both places
   * for the same runId: WSLicense.consumeRunCredit() is idempotent by
   * runId, so whichever call lands first charges, and the other is a
   * silent no-op. */
  async function maybeChargeForCompletedRun(runState) {
    if (!runState || runState.status !== 'completed') return;
    await chargeRunCredit(runState.runId);
  }

  function attachRunStorageListener() {
    if (storageListenerAttached) return;
    storageListenerAttached = true;
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'session') return;
      var change = changes[runKey()];
      if (!change) return;
      var newState = change.newValue;
      renderRunProgress(newState);
      if (newState && TERMINAL_STATUSES.indexOf(newState.status) !== -1) {
        cleanupRunPermissions(newState);
        maybeChargeForCompletedRun(newState);
      }
    });
  }

  // =====================================================================
  // Saved Scrapers
  // =====================================================================

  function scraperDisplayHost(scraper) {
    return scraper.hostname + scraper.pathname;
  }

  var lastKnownScraperCount = 0; // read by updateScrapeWorkflowStatus's first-run check without needing its own async fetch

  async function renderScrapers() {
    var scrapers = await WSRecipes.listScrapers();
    els.scrapersList.innerHTML = '';
    els.scrapersEmpty.hidden = scrapers.length > 0;
    lastKnownScraperCount = scrapers.length;
    updateScrapeWorkflowStatus();

    scrapers.forEach(function (scraper) {
      var li = document.createElement('li');
      li.className = 'ws-scraper-row';

      var head = document.createElement('div');
      head.className = 'ws-scraper-head';
      var name = document.createElement('span');
      name.className = 'ws-scraper-name';
      name.textContent = scraper.name;
      name.title = scraper.name;
      var host = document.createElement('span');
      host.className = 'ws-scraper-host';
      host.textContent = scraperDisplayHost(scraper);
      host.title = scraperDisplayHost(scraper);
      head.appendChild(name);
      head.appendChild(host);

      var actions = document.createElement('div');
      actions.className = 'ws-scraper-actions';

      var runBtn = document.createElement('button');
      runBtn.textContent = 'Run';
      runBtn.addEventListener('click', function () { handleRunScraper(scraper); });

      var loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', function () { handleLoadScraper(scraper); });

      var renameBtn = document.createElement('button');
      renameBtn.textContent = 'Rename';
      renameBtn.addEventListener('click', function () { handleRenameScraper(scraper); });

      var deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.className = 'ws-scraper-danger';
      deleteBtn.addEventListener('click', function () { handleDeleteScraper(scraper); });

      actions.appendChild(runBtn);
      actions.appendChild(loadBtn);
      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);

      li.appendChild(head);
      li.appendChild(actions);
      els.scrapersList.appendChild(li);

      renderScraperSnapshotFooter(li, scraper);
    });
  }

  /** Appends the small "Snapshots: N — Manage" footer (spec #13) to a
   * Saved Scraper row. Deliberately minimal — no full database UI, just
   * a date + row-count list with Delete, matching the spec's own mockup. */
  async function renderScraperSnapshotFooter(li, scraper) {
    var count = await WSSnapshots.countSnapshots({ scraperId: scraper.id });
    if (!count) return; // nothing to show until the user saves a first snapshot

    var footer = document.createElement('div');
    footer.className = 'ws-scraper-snapshot-row';
    var note = document.createElement('span');
    note.className = 'ws-scraper-snapshot-note';
    note.textContent = 'Snapshots: ' + count + '/' + WSSnapshots.DEFAULT_RETENTION_PER_GROUP;
    var manageBtn = document.createElement('button');
    manageBtn.className = 'ws-scraper-snapshot-manage';
    manageBtn.textContent = 'Manage';
    footer.appendChild(note);
    footer.appendChild(manageBtn);
    li.appendChild(footer);

    var list = document.createElement('ul');
    list.className = 'ws-snapshot-manage-list';
    list.hidden = true;
    li.appendChild(list);

    manageBtn.addEventListener('click', async function () {
      var willShow = list.hidden;
      list.hidden = !willShow;
      manageBtn.textContent = willShow ? 'Hide' : 'Manage';
      if (!willShow) return;
      var snaps = await WSSnapshots.listSnapshots({ scraperId: scraper.id });
      list.innerHTML = '';
      snaps.forEach(function (snap) {
        var row = document.createElement('li');
        row.className = 'ws-snapshot-manage-row';
        var label = document.createElement('span');
        label.textContent = formatSnapshotDate(snap.createdAt) + ' — ' + snap.rowCount + ' rows';
        var delBtn = document.createElement('button');
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', async function () {
          await WSSnapshots.deleteSnapshot(snap.id);
          await renderScrapers();
        });
        row.appendChild(label);
        row.appendChild(delBtn);
        list.appendChild(row);
      });
    });
  }

  function confirmIfPageMismatch(scraper) {
    if (WSRecipes.matchesPage(scraper, hostname, pathname)) return true;
    var msg = scraper.hostname === hostname
      ? 'This scraper was created for a different page on ' + scraper.hostname + ' (' + scraper.pathname + '), not this one. Continue anyway?'
      : 'This scraper was created for ' + scraper.hostname + ' — you’re currently on ' + hostname + '. Continue anyway?';
    return confirm(msg);
  }

  /** V1.22: factored out of applyLoadedScraper so "Apply Template" (a
   * custom template's own paginationConfig has the exact same shape,
   * see utils/templates.js's normalizePaginationConfig) can restore the
   * Run Mode UI identically, instead of a second copy of this logic.
   * Accepts anything with mode/nextButtonConfig/paginationMethod/
   * urlPatternConfig/dedupeKey/limits — a saved scraper record or a
   * template's paginationConfig both already match this shape. */
  function applyRunModeConfigToUI(runModeSource) {
    var mode = (runModeSource && runModeSource.mode) || 'current-page';
    var modeRadio = document.querySelector('input[name="run-mode"][value="' + mode + '"]');
    if (modeRadio) modeRadio.checked = true;
    pendingNextButtonConfig = (runModeSource && runModeSource.nextButtonConfig) || null;
    pendingUrlPatternConfig = (runModeSource && runModeSource.urlPatternConfig) || null;
    updateNextButtonStatusText();
    updateUrlPatternStatusText();
    if (els.mpMethod) els.mpMethod.value = (runModeSource && runModeSource.paginationMethod) || 'nextButton';
    if (pendingUrlPatternConfig) {
      if (els.urlPatternKey) els.urlPatternKey.value = pendingUrlPatternConfig.kind + ':' + pendingUrlPatternConfig.key;
      if (els.urlPatternStart) els.urlPatternStart.value = pendingUrlPatternConfig.start;
      if (els.urlPatternStep) els.urlPatternStep.value = pendingUrlPatternConfig.step;
    }
    onRunModeChanged();
    var limits = runModeSource && runModeSource.limits;
    if (limits) {
      if (mode === 'auto-scroll') {
        els.asMaxRows.value = limits.maxRows || 1000;
        els.asMaxScrolls.value = limits.maxScrolls || 100;
      } else if (mode === 'multi-page') {
        els.mpMaxPages.value = limits.maxPages || 10;
        els.mpMaxRows.value = limits.maxRows || 1000;
        els.mpDelayMs.value = limits.delayMs || 0;
        els.mpRetryCount.value = limits.retryCount || 0;
      } else if (mode === 'load-more') {
        els.lmMaxClicks.value = limits.maxClicks || 30;
        els.lmMaxRows.value = limits.maxRows || 1000;
        els.lmDelayMs.value = limits.delayMs || 0;
        els.lmRetryCount.value = limits.retryCount || 0;
      }
    }
    if (mode !== 'current-page') {
      populateColumnSelect(els.runDedupeKey, true);
      els.runDedupeKey.value = (runModeSource && runModeSource.dedupeKey) || 'entire-row';
    }
  }

  async function applyLoadedScraper(scraper) {
    state = {
      containerSelector: scraper.containerSelector,
      columns: JSON.parse(JSON.stringify(scraper.columns))
    };
    await persistState();
    loadedScraperId = scraper.id;
    loadedScraperName = scraper.name;
    await WSRecipes.setLoadedScraperId(hostname, loadedScraperId);
    renderColumns();
    clearResults();

    // Restore the saved run-mode setup too (V1.3, extended V1.19 for
    // load-more / paginationMethod / urlPatternConfig; V1.22 factors
    // this into its own function so "Apply Template" can reuse the
    // EXACT same restore logic instead of a second copy — see
    // applyRunModeConfigToUI below), if this recipe has one.
    applyRunModeConfigToUI(scraper);

    // Restore V1.5 download preferences too — these only take visible
    // effect the next time the Download setup panel is opened (its
    // column list is rebuilt from state.columns each time), but the
    // template/folder/dedupe fields can be prefilled right away.
    loadedDownloadColumn = scraper.downloadColumn || null;
    if (scraper.filenameTemplate) els.dlFilenameTemplate.value = scraper.filenameTemplate;
    if (scraper.folderName) els.dlFolderName.value = scraper.folderName;
    var dedupeValue = scraper.skipDuplicates === false ? 'keep' : 'skip';
    var dedupeRadio = document.querySelector('input[name="dl-dedupe"][value="' + dedupeValue + '"]');
    if (dedupeRadio) dedupeRadio.checked = true;

    // Restore V1.6 compare-key preference (takes visible effect the next
    // time the Snapshots panel is opened, same as the download prefs above).
    loadedCompareKey = scraper.compareKey || null;

    // Restore V1.12 Research Bundle preferences (takes visible effect the
    // next time the Research Bundle panel is opened, same pattern as the
    // download/compare prefs above) — a scraper saved under V1.11 or
    // earlier simply lacks `research`, and the panel falls back to
    // computing fresh defaults per its own spec #3.
    loadedScraperResearch = scraper.research || null;

    // Restore V1.18 Deep Scraping configuration — a scraper saved under
    // V1.17 or earlier simply lacks `deepScrape` entirely, and one saved
    // under V1.18/V1.19 has it but lacks V1.20's additive retryLimit
    // field specifically. WSRecipes.normalizeDeepScrape self-heals BOTH
    // cases the same way saveScraper/updateScraper already do (never
    // just `|| emptyDeepScrape()`, which would only cover the "missing
    // entirely" case and leave a partially-shaped object otherwise).
    deepScrapeConfig = WSRecipes.normalizeDeepScrape(scraper.deepScrape);
    renderDeepScrapePanel();

    // Restore V1.7 saved transforms (spec #25) — under explicit user
    // control via "Apply saved transforms automatically", default on.
    // Deep-cloned so editing the live pipeline never mutates the saved
    // scraper's stored config (that only happens via an explicit
    // Save/Update Scraper click).
    loadedAutoApplyTransforms = scraper.autoApplyTransforms !== false;
    els.tfAutoApplySaved.checked = loadedAutoApplyTransforms;
    if (loadedAutoApplyTransforms && scraper.transforms && scraper.transforms.length) {
      activeTransforms = JSON.parse(JSON.stringify(scraper.transforms));
      invalidateTransformCache();
    }
  }

  async function handleLoadScraper(scraper) {
    if (!confirmIfPageMismatch(scraper)) return;
    await applyLoadedScraper(scraper);
    setStatus('Loaded "' + scraper.name + '" (' + scraper.columns.length + ' columns).', false);
  }

  async function handleRunScraper(scraper) {
    if (!confirmIfPageMismatch(scraper)) return;
    await applyLoadedScraper(scraper);
    setStatus('Running "' + scraper.name + '"…', false);
    // Respects whatever run mode was saved with the recipe (V1.3) — a
    // scraper saved while set to Auto Scroll/Multi-page starts that mode
    // directly; a plain (or V1.2-era, mode-less) scraper just Previews,
    // exactly as V1.2's Run always has. Either way this always requires
    // this explicit Run click — nothing starts scraping on its own.
    if ((scraper.mode || 'current-page') === 'current-page') {
      await handlePreview();
    } else {
      await handleStartRun();
    }
  }

  async function handleRenameScraper(scraper) {
    var newName = prompt('Rename scraper:', scraper.name);
    if (newName === null) return;
    var res = await WSRecipes.renameScraper(scraper.id, newName);
    if (!res.ok) { setStatus(res.error, true); return; }
    if (loadedScraperId === scraper.id) loadedScraperName = res.scraper.name;
    await renderScrapers();
    updateScraperButtonsVisibility();
    setStatus('Renamed to "' + res.scraper.name + '".', false);
  }

  /** V1.13.1 spec #6: the confirmation text below is written to match
   * EXACTLY what WSRecipes.deleteScraper() + this handler actually do —
   * inspected first, not assumed:
   *   - removes the whole saved scraper record, which is where
   *     monitoring.enabled/intervalMinutes, monitoring.notifyOnChanges,
   *     and monitoring.history all live (embedded fields, not a
   *     separate store) — so all three are genuinely gone with it;
   *   - if monitoring was enabled, its chrome.alarms entry is cleared
   *     FIRST (see the comment below) so nothing is left scheduled;
   *   - Snapshots (utils/snapshots.js) live in a completely separate
   *     `ws_snapshots` store keyed by scraperId and are NEVER touched by
   *     deleteScraper() — they are not deleted, but with the scraper
   *     record gone, nothing in the UI can reach them again;
   *   - rawRows (the popup's in-memory current Results/Research dataset)
   *     is never touched by deletion at all, nor are any already-
   *     exported/downloaded files (deletion only ever writes to
   *     chrome.storage.local, never chrome.downloads).
   */
  function buildDeleteScraperConfirmText(scraper) {
    var lines = ['Delete "' + scraper.name + '"?', ''];
    lines.push('This removes the saved scraper configuration, including its monitoring schedule, notification preference, and monitoring run history.');
    lines.push('');
    lines.push('Saved snapshots for this scraper are kept in storage but will no longer be reachable from the app.');
    lines.push('');
    lines.push('Your current Results/Research data and any already-exported or downloaded files are not affected.');
    lines.push('');
    lines.push("This can't be undone.");
    return lines.join('\n');
  }

  async function handleDeleteScraper(scraper) {
    if (!confirm(buildDeleteScraperConfirmText(scraper))) return;
    // Clear its monitoring alarm WHILE the record still exists — after
    // deleteScraper() below, background.js can only clean it up lazily
    // (self-heals the next time a stale alarm fires and finds no
    // scraper), so doing it here avoids a dangling alarm in the meantime.
    if (scraper.monitoring && scraper.monitoring.enabled) {
      await sendToBackground({ type: 'SET_MONITORING', scraperId: scraper.id, enabled: false });
    }
    await WSRecipes.deleteScraper(scraper.id);
    if (loadedScraperId === scraper.id) {
      loadedScraperId = null;
      loadedScraperName = null;
      await WSRecipes.setLoadedScraperId(hostname, null);
      updateScraperButtonsVisibility();
    }
    await renderScrapers();
    await renderMonitoringSection();
    setStatus('Deleted "' + scraper.name + '".', false);
  }

  // =====================================================================
  // Monitoring (V1.8): schedules a Saved Scraper to re-run itself
  // headlessly via chrome.alarms + background.js, then auto-snapshot +
  // compare — all actual orchestration lives in background.js so it keeps
  // working even when the popup is closed (same reasoning as V1.5's
  // download queue). This section only manages the config (enable/
  // disable/interval), the manual "Run Now" trigger, and reflecting
  // whatever background.js has written back to the Saved Scraper record.
  // =====================================================================

  var MONITOR_INTERVAL_LABELS = { 60: 'Hourly', 360: 'Every 6 hours', 720: 'Every 12 hours', 1440: 'Daily' };
  var MONITOR_STATUS_BADGE_CLASS = { running: 'running', success: 'completed', error: 'error' };

  function formatMonitorTimestamp(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  // =====================================================================
  // V1.11: Monitoring Dashboard / Summary — a card's overall status is one
  // of exactly four categories (deliberately NOT including the transient
  // 'running' state, which keeps its own distinct RUNNING badge wherever
  // it's rendered and simply isn't reclassified as any of these four
  // until its run actually finishes — per spec, the Summary/filters only
  // need to update "immediately after" a run COMPLETES, not while one is
  // mid-flight):
  //   'error'   — latest completed run failed
  //   'changed' — latest completed run succeeded AND found new/removed/
  //               changed rows (CHANGED takes precedence over SUCCESS)
  //   'success' — latest completed run succeeded with zero changes
  //   'never'   — no completed run yet (includes a run currently in
  //               progress with no prior completed run to fall back to)
  // Sort priority (spec #10) follows this exact order: error > changed >
  // success > never; within a group, newest lastRunAt first.
  // =====================================================================
  var MONITOR_CARD_STATUS_PRIORITY = { error: 0, changed: 1, success: 2, never: 3 };
  var MONITOR_CARD_STATUS_LABEL = { error: 'ERROR', changed: 'CHANGED', success: 'SUCCESS', never: 'NEVER RUN' };
  var MONITOR_CARD_BADGE_CLASS = { error: 'error', changed: 'changed', success: 'completed', never: 'never' };

  function computeMonitorCardStatus(monitoring) {
    if (!monitoring || !monitoring.lastRunStatus || monitoring.lastRunStatus === 'running') return 'never';
    if (monitoring.lastRunStatus === 'error') return 'error';
    if (monitoring.lastRunStatus === 'success') return monitoring.lastRunHasChanges ? 'changed' : 'success';
    return 'never';
  }

  function compareMonitorCards(a, b) {
    var sa = computeMonitorCardStatus(a.monitoring), sb = computeMonitorCardStatus(b.monitoring);
    var pa = MONITOR_CARD_STATUS_PRIORITY[sa], pb = MONITOR_CARD_STATUS_PRIORITY[sb];
    if (pa !== pb) return pa - pb;
    var ta = (a.monitoring && a.monitoring.lastRunAt) || 0;
    var tb = (b.monitoring && b.monitoring.lastRunAt) || 0;
    return tb - ta; // newest Last run first within the same status group
  }

  /** All four counters are scoped to ENABLED scrapers only (spec #3: "the
   * latest monitoring result of each enabled scraper") — a disabled
   * scraper's leftover run history stays visible on its own card but
   * doesn't feed the aggregate Summary line. */
  function computeMonitorSummary(scrapers) {
    var active = scrapers.filter(function (s) { return s.monitoring && s.monitoring.enabled; });
    var counts = { active: active.length, success: 0, changed: 0, errors: 0 };
    active.forEach(function (s) {
      var status = computeMonitorCardStatus(s.monitoring);
      if (status === 'success') counts.success++;
      else if (status === 'changed') counts.changed++;
      else if (status === 'error') counts.errors++;
    });
    return counts;
  }

  var monitoringStatusFilter = 'all'; // 'all' | 'changed' | 'errors' — resets each popup open, not persisted (a live triage view, not a saved preference)

  function renderMonitorFilterButtons() {
    var buttons = els.monitoringFilters.querySelectorAll('.ws-monitor-filter-btn');
    buttons.forEach(function (btn) {
      btn.classList.toggle('ws-chip-active', btn.dataset.filter === monitoringStatusFilter);
    });
  }

  function applyMonitorFilter(scrapers) {
    if (monitoringStatusFilter === 'changed') return scrapers.filter(function (s) { return computeMonitorCardStatus(s.monitoring) === 'changed'; });
    if (monitoringStatusFilter === 'errors') return scrapers.filter(function (s) { return computeMonitorCardStatus(s.monitoring) === 'error'; });
    return scrapers;
  }

  // renderMonitoringSection is triggered from TWO independent places that
  // can fire close together for the same user action: the explicit call
  // at the end of handleEnableMonitoring/handleDisableMonitoring/
  // handleRunMonitoredNow, AND attachMonitoringStorageListener's
  // chrome.storage.onChanged listener (which fires whenever EITHER of
  // those writes lands, from this context or the background one).
  // Both do an async chrome.storage.local read before touching the DOM,
  // and Chrome gives no ordering guarantee between "a message round-trip
  // finishing" and "a separate onChanged event arriving" — so the SLOWER
  // of two overlapping calls can finish LAST even though it started
  // first, painting stale data over a correct render that already
  // landed (this is what real-Chrome testing surfaced: Enable -> Run Now
  // -> Disable -> Enable intermittently showed "—" for Last/Next run
  // even though the underlying storage record was correct throughout).
  // Fix: a monotonically increasing generation token — a call whose
  // generation is no longer the latest by the time its read resolves
  // simply never touches the DOM, so only the most recently STARTED
  // render can ever win, regardless of how the two async reads settle.
  var monitoringRenderGeneration = 0;
  var openHistoryScraperId = null; // V1.10: which scraper's History panel is currently expanded (survives re-renders, reset by rebuilding the whole list)
  async function renderMonitoringSection() {
    var myGeneration = ++monitoringRenderGeneration;
    var scrapers = await WSRecipes.listScrapers();
    if (myGeneration !== monitoringRenderGeneration) return; // superseded by a newer render already in flight — never let stale data win
    els.monitoringList.innerHTML = '';
    els.monitoringEmpty.hidden = scrapers.length > 0;

    // V1.11: Summary counters are computed over EVERY saved scraper (only
    // enabled ones actually contribute — see computeMonitorSummary), so
    // they're always accurate even while a status filter is hiding most
    // of the list below.
    els.monitoringSummary.hidden = scrapers.length === 0;
    els.monitoringFilters.hidden = scrapers.length === 0;
    if (scrapers.length > 0) {
      var summary = computeMonitorSummary(scrapers);
      els.monitoringSummary.textContent = 'Monitoring Summary\n' +
        summary.active + ' Active | ' + summary.success + ' Success | ' + summary.changed + ' Changed | ' + summary.errors + ' Errors';
      renderMonitorFilterButtons();
    }

    // Sort by attention priority (ERROR > CHANGED > SUCCESS > NEVER RUN;
    // newest Last run first within a group) BEFORE filtering, so the
    // filtered subset keeps the same relative order.
    var sorted = scrapers.slice().sort(compareMonitorCards);
    var visible = applyMonitorFilter(sorted);
    els.monitoringFilterEmpty.hidden = !(scrapers.length > 0 && visible.length === 0);

    visible.forEach(function (scraper) {
      var monitoring = scraper.monitoring || { enabled: false, intervalMinutes: null, lastRunStatus: null, lastRunAt: null, nextRunAt: null, lastRunSummary: '', lastError: null, notifyOnChanges: true, history: [], lastRunHasChanges: false };

      var li = document.createElement('li');
      li.className = 'ws-scraper-row';
      // V1 WORKFLOW REORG — lets "Monitor Changes" (Results tab) scroll
      // to and highlight the specific card its saved scraper corresponds
      // to, without needing a second, parallel way to locate monitoring
      // cards. See focusMonitoringCard().
      li.dataset.scraperId = scraper.id;

      var head = document.createElement('div');
      head.className = 'ws-scraper-head';
      var name = document.createElement('span');
      name.className = 'ws-scraper-name';
      name.textContent = scraper.name;
      name.title = scraper.name;
      head.appendChild(name);
      // A currently in-progress run keeps its own distinct RUNNING badge
      // (unchanged since V1.8); otherwise EVERY card now always shows one
      // of the four V1.11 status badges (spec #7) — including NEVER RUN,
      // which V1.10 never rendered a badge for at all.
      if (monitoring.enabled && monitoring.lastRunStatus === 'running') {
        var runningBadge = document.createElement('span');
        runningBadge.className = 'ws-status-badge ws-status-running';
        runningBadge.textContent = 'RUNNING';
        head.appendChild(runningBadge);
      } else {
        var cardStatus = computeMonitorCardStatus(monitoring);
        var badge = document.createElement('span');
        badge.className = 'ws-status-badge ws-status-' + MONITOR_CARD_BADGE_CLASS[cardStatus];
        badge.textContent = MONITOR_CARD_STATUS_LABEL[cardStatus];
        head.appendChild(badge);
      }
      li.appendChild(head);

      // V1.13.1 spec #4: NEVER RUN must never be ambiguous about WHY —
      // "disabled" (nothing scheduled) and "never run yet" (scheduled but
      // hasn't fired) are two different facts and are shown separately:
      // "Monitoring disabled"/the interval line already says which one
      // applies, this note only ever adds "no snapshot to compare yet".
      // A running-in-progress card (cardStatus left undefined this pass)
      // never shows it, matching spec's "immediately after Run
      // COMPLETES" framing used throughout this file already.
      if (typeof cardStatus !== 'undefined' && cardStatus === 'never') {
        var neverRunNote = document.createElement('p');
        neverRunNote.className = 'ws-monitor-never-run-note';
        neverRunNote.textContent = 'No monitoring snapshot yet.';
        li.appendChild(neverRunNote);
      }

      // V1.13.1 spec #4: ALWAYS rendered now (previously skipped entirely
      // for "disabled and never run", the one combination that used to
      // have nothing to say beyond the Enable controls below) — a
      // disabled-and-never-run card must still explicitly say "Monitoring
      // disabled" so it's never confused with an enabled card that just
      // hasn't fired its first run yet (the neverRunNote above is
      // identical for both; this line is what tells them apart). Last
      // run/summary/error are shown regardless of enabled/disabled; only
      // "Next run" (meaningless without an actual alarm) is enabled-only.
      {
        var statusLine = document.createElement('p');
        statusLine.className = 'ws-monitor-status-line';
        var lines = [];
        if (monitoring.enabled) {
          lines.push(MONITOR_INTERVAL_LABELS[monitoring.intervalMinutes] || ('Every ' + monitoring.intervalMinutes + ' min'));
        } else {
          lines.push('Monitoring disabled');
        }
        if (monitoring.lastRunStatus) {
          lines.push('Last run: ' + formatMonitorTimestamp(monitoring.lastRunAt) + (monitoring.lastRunStatus === 'running' ? ' (running now…)' : ''));
          if (monitoring.lastRunStatus === 'success' && monitoring.lastRunSummary) lines.push(monitoring.lastRunSummary);
          if (monitoring.lastRunStatus === 'error' && monitoring.lastError) lines.push('⚠ ' + monitoring.lastError);
        } else if (monitoring.enabled) {
          lines.push('No runs yet.');
        }
        if (monitoring.enabled) lines.push('Next run: ' + formatMonitorTimestamp(monitoring.nextRunAt));
        statusLine.textContent = lines.join('\n');
        li.appendChild(statusLine);
      }

      var controls = document.createElement('div');
      controls.className = 'ws-monitor-controls';

      if (!monitoring.enabled) {
        var select = document.createElement('select');
        WSRecipes.MONITOR_INTERVALS.forEach(function (mins) {
          var opt = document.createElement('option');
          opt.value = String(mins);
          opt.textContent = MONITOR_INTERVAL_LABELS[mins] || (mins + ' min');
          select.appendChild(opt);
        });
        var notifyCheckbox = document.createElement('input');
        notifyCheckbox.type = 'checkbox';
        notifyCheckbox.checked = monitoring.notifyOnChanges !== false;
        var notifyLabel = document.createElement('label');
        notifyLabel.className = 'ws-monitor-notify-label';
        notifyLabel.appendChild(notifyCheckbox);
        notifyLabel.appendChild(document.createTextNode(' 🔔'));
        notifyLabel.title = 'Notify me when this scraper finds changes or errors';
        var enableBtn = document.createElement('button');
        enableBtn.textContent = 'Enable';
        enableBtn.className = 'ws-monitor-btn-primary'; // the one obvious primary action for a not-yet-monitored scraper (spec #7)
        enableBtn.addEventListener('click', function () {
          handleEnableMonitoring(scraper, parseInt(select.value, 10), notifyCheckbox.checked);
        });
        controls.appendChild(select);
        controls.appendChild(notifyLabel);
        controls.appendChild(enableBtn);
        appendHistoryButtonIfAny(controls, scraper, monitoring);
        li.appendChild(controls);
      } else {
        var runNowBtn = document.createElement('button');
        runNowBtn.textContent = 'Run Now';
        runNowBtn.className = 'ws-monitor-btn-primary'; // the one obvious primary action on an enabled card (spec #7) — Disable stays secondary
        runNowBtn.disabled = monitoring.lastRunStatus === 'running';
        // V1.15: Monitoring is fully available to every user and never
        // consumes a trial run credit (the 10-run trial applies only to
        // user-initiated Preview/Start Run scraping) — no gating here at all.
        runNowBtn.addEventListener('click', function () { handleRunMonitoredNow(scraper); });
        var disableBtn = document.createElement('button');
        disableBtn.textContent = 'Disable';
        disableBtn.addEventListener('click', function () { handleDisableMonitoring(scraper); });
        var notifyToggle = document.createElement('input');
        notifyToggle.type = 'checkbox';
        notifyToggle.checked = monitoring.notifyOnChanges !== false;
        var notifyToggleLabel = document.createElement('label');
        notifyToggleLabel.className = 'ws-monitor-notify-label';
        notifyToggleLabel.appendChild(notifyToggle);
        notifyToggleLabel.appendChild(document.createTextNode(' 🔔'));
        notifyToggleLabel.title = 'Notify me when this scraper finds changes or errors';
        notifyToggle.addEventListener('change', function () { handleToggleNotify(scraper, notifyToggle.checked); });
        controls.appendChild(runNowBtn);
        controls.appendChild(disableBtn);
        controls.appendChild(notifyToggleLabel);
        appendHistoryButtonIfAny(controls, scraper, monitoring);
        li.appendChild(controls);
      }

      if (openHistoryScraperId === scraper.id) {
        li.appendChild(buildMonitoringHistoryPanel(scraper, monitoring));
      }

      els.monitoringList.appendChild(li);
    });
  }

  /** V1.10: only shown once there's at least one run to look back on —
   * an empty History button linking to nothing isn't useful. */
  function appendHistoryButtonIfAny(controls, scraper, monitoring) {
    if (!monitoring.history || !monitoring.history.length) return;
    var historyBtn = document.createElement('button');
    historyBtn.textContent = 'History';
    historyBtn.addEventListener('click', function () {
      openHistoryScraperId = (openHistoryScraperId === scraper.id) ? null : scraper.id;
      renderMonitoringSection();
    });
    controls.appendChild(historyBtn);
  }

  /** V1.10: a compact per-run list — date/time, SUCCESS/ERROR badge, and
   * either the row-count breakdown (success) or the error message
   * (error). Newest first, matching monitoring.history's own order. */
  function buildMonitoringHistoryPanel(scraper, monitoring) {
    var panel = document.createElement('div');
    panel.className = 'ws-monitor-history-panel';

    var list = document.createElement('ul');
    list.className = 'ws-monitor-history-list';
    (monitoring.history || []).forEach(function (entry) {
      var row = document.createElement('li');
      row.className = 'ws-monitor-history-row';

      var head = document.createElement('div');
      head.className = 'ws-monitor-history-head';
      var dateSpan = document.createElement('span');
      dateSpan.textContent = formatMonitorTimestamp(entry.at);
      var badge = document.createElement('span');
      badge.className = 'ws-status-badge ws-status-' + (MONITOR_STATUS_BADGE_CLASS[entry.status] || entry.status);
      badge.textContent = (entry.status || '').toUpperCase();
      head.appendChild(dateSpan);
      head.appendChild(badge);
      row.appendChild(head);

      var detail = document.createElement('div');
      detail.className = 'ws-monitor-history-detail';
      if (entry.status === 'success') {
        detail.textContent = entry.totalRows + ' rows | +' + entry.newCount + ' new | -' + entry.removedCount + ' removed | ~' + entry.changedCount + ' changed';
      } else {
        detail.textContent = '⚠ ' + (entry.error || 'Unknown error');
      }
      row.appendChild(detail);

      list.appendChild(row);
    });
    panel.appendChild(list);

    var clearBtn = document.createElement('button');
    clearBtn.className = 'ws-chip-btn ws-chip-btn-warn';
    clearBtn.textContent = 'Clear History';
    clearBtn.addEventListener('click', function () { handleClearMonitoringHistory(scraper); });
    panel.appendChild(clearBtn);

    return panel;
  }

  /** Clears ONLY the run history array — snapshots, scraper config,
   * transforms, the monitoring schedule, last-run info, and the
   * notification preference are all untouched (recipes.js's
   * clearMonitoringHistory structurally can't touch them). */
  async function handleClearMonitoringHistory(scraper) {
    if (!confirm('Clear monitoring history for "' + scraper.name + '"? This only removes the run history list — snapshots, the saved scraper configuration, and the current schedule are kept.')) return;
    var res = await sendToBackground({ type: 'CLEAR_MONITORING_HISTORY', scraperId: scraper.id });
    if (!res || !res.ok) { setStatus('Could not clear history.', true); return; }
    openHistoryScraperId = null;
    await renderMonitoringSection();
    setStatus('History cleared for "' + scraper.name + '".', false);
  }

  /** Enabling requires a real, persistent host permission for this
   * scraper's site — a headless background tab is NOT covered by
   * activeTab (that only ever follows a direct user gesture on the
   * currently active tab), so this request (itself a genuine user
   * gesture, this click) is the one and only place that permission can
   * be obtained. See background.js's V1.8 section header for the full
   * platform-constraint explanation. */
  async function handleEnableMonitoring(scraper, intervalMinutes, notifyOnChanges) {
    var origin = originPatternFor(scraper.hostname);
    setStatus('Requesting permission for ' + scraper.hostname + '…', false);
    var granted;
    try { granted = await chrome.permissions.request({ origins: [origin] }); } catch (e) { granted = false; }
    if (!granted) {
      setStatus('Permission was declined — Monitoring needs access to revisit this site automatically.', true);
      return;
    }
    var res = await sendToBackground({ type: 'SET_MONITORING', scraperId: scraper.id, enabled: true, intervalMinutes: intervalMinutes, notifyOnChanges: notifyOnChanges });
    if (!res || !res.ok) { setStatus('Could not enable monitoring.', true); return; }
    await renderMonitoringSection();
    setStatus('Monitoring enabled for "' + scraper.name + '".', false, 'success');
  }

  /** Deliberately does NOT revoke the host permission it was granted
   * under (unlike Multi-page's run-end cleanup) — the user may re-enable
   * shortly, and removing it would just mean re-prompting for the exact
   * same permission again. */
  async function handleDisableMonitoring(scraper) {
    var res = await sendToBackground({ type: 'SET_MONITORING', scraperId: scraper.id, enabled: false });
    if (!res || !res.ok) { setStatus('Could not disable monitoring.', true); return; }
    await renderMonitoringSection();
    setStatus('Monitoring disabled for "' + scraper.name + '".', false);
  }

  /** V1.9: flips the notify-on-changes toggle for an already-enabled
   * scraper. Deliberately a SEPARATE message from SET_MONITORING (not
   * "enable again with the same interval") — SET_MONITORING always
   * recreates the chrome.alarms entry and recomputes nextRunAt when
   * enabled:true, which would silently reset the actual monitoring
   * schedule as a side effect of just toggling a notification
   * preference. SET_NOTIFY only ever touches notifyOnChanges. */
  async function handleToggleNotify(scraper, notifyOnChanges) {
    var res = await sendToBackground({ type: 'SET_NOTIFY', scraperId: scraper.id, notifyOnChanges: notifyOnChanges });
    if (!res || !res.ok) { setStatus('Could not update notification setting.', true); return; }
    await renderMonitoringSection();
    setStatus(notifyOnChanges ? 'Notifications enabled for "' + scraper.name + '".' : 'Notifications disabled for "' + scraper.name + '".', false);
  }

  /** Fire-and-forget on purpose — the run can take a while, and its
   * progress is reflected live via the chrome.storage.onChanged listener
   * below rather than blocking this click. */
  async function handleRunMonitoredNow(scraper) {
    setStatus('Running "' + scraper.name + '" now…', false);
    await sendToBackground({ type: 'RUN_MONITORED_NOW', scraperId: scraper.id });
    await renderMonitoringSection();
  }

  var monitoringStorageListenerAttached = false;
  function attachMonitoringStorageListener() {
    if (monitoringStorageListenerAttached) return;
    monitoringStorageListenerAttached = true;
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local' || !changes.ws_saved_scrapers) return;
      renderMonitoringSection();
    });
  }

  /** Reads the currently-configured run mode/options straight from the
   * Run Mode UI, so a scraper is always saved with whatever setup the
   * user actually has in front of them right now. */
  function currentRunModeFields() {
    var mode = getSelectedRunMode();
    var fields = { mode: mode, nextButtonConfig: null, paginationMethod: 'nextButton', urlPatternConfig: null, dedupeKey: 'entire-row', limits: null };
    if (mode === 'current-page') return fields;
    fields.dedupeKey = els.runDedupeKey.value || 'entire-row';
    if (mode === 'auto-scroll') {
      fields.limits = {
        maxRows: parseInt(els.asMaxRows.value, 10) || 1000,
        maxScrolls: parseInt(els.asMaxScrolls.value, 10) || 100
      };
    } else if (mode === 'multi-page') {
      fields.paginationMethod = els.mpMethod ? els.mpMethod.value : 'nextButton';
      fields.nextButtonConfig = fields.paginationMethod === 'urlPattern' ? null : pendingNextButtonConfig;
      // Reads the raw fields directly (no validation/status side effects
      // here — this is just "what's currently in the UI", not a Start
      // action; buildUrlPatternConfigFromFields()'s validation runs at
      // actual Start time instead).
      if (fields.paginationMethod === 'urlPattern' && els.urlPatternKey) {
        var upParts = (els.urlPatternKey.value || 'query:page').split(':');
        fields.urlPatternConfig = {
          kind: upParts[0] === 'path' ? 'path' : 'query',
          key: upParts[1] || 'page',
          style: upParts[0] === 'path' ? 'page' : ((upParts[1] === 'start' || upParts[1] === 'offset') ? 'offset' : 'page'),
          start: parseInt(els.urlPatternStart.value, 10) || 0,
          step: parseInt(els.urlPatternStep.value, 10) || 1
        };
      } else {
        fields.urlPatternConfig = null;
      }
      fields.limits = {
        maxPages: parseInt(els.mpMaxPages.value, 10) || 10,
        maxRows: parseInt(els.mpMaxRows.value, 10) || 1000,
        delayMs: parseInt(els.mpDelayMs.value, 10) || 0,
        retryCount: parseInt(els.mpRetryCount.value, 10) || 0
      };
    } else if (mode === 'load-more') {
      fields.nextButtonConfig = pendingNextButtonConfig;
      fields.limits = {
        maxClicks: parseInt(els.lmMaxClicks.value, 10) || 30,
        maxRows: parseInt(els.lmMaxRows.value, 10) || 1000,
        noNewDataAttempts: 3,
        delayMs: parseInt(els.lmDelayMs.value, 10) || 0,
        retryCount: parseInt(els.lmRetryCount.value, 10) || 0
      };
    }
    return fields;
  }

  /** Same idea as currentRunModeFields(), for V1.5's download setup.
   * Reads whatever's currently in the Download panel's fields (or their
   * untouched HTML defaults if the panel was never opened this session)
   * — never fabricates a value the user didn't actually see. */
  function currentDownloadPrefsFields() {
    var dedupeRadio = document.querySelector('input[name="dl-dedupe"]:checked');
    return {
      downloadColumn: els.dlColumnSelect.value || null,
      filenameTemplate: els.dlFilenameTemplate.value || '',
      folderName: els.dlFolderName.value || 'Web Scraper',
      skipDuplicates: !dedupeRadio || dedupeRadio.value !== 'keep'
    };
  }

  /** Same idea as currentRunModeFields()/currentDownloadPrefsFields(), for
   * V1.6's Compare-rows-by preference. */
  function currentComparePrefsFields() {
    return { compareKey: els.compareKeySelect.value || loadedCompareKey || 'entire-row' };
  }

  /** Same idea, for V1.7's transform pipeline. Per spec #31, a transform
   * scoped to "Current filtered rows" (t.rowIndices set) is inherently
   * tied to one specific scrape's row positions — it is NOT portable to
   * a future run, so it's deliberately excluded from what gets saved;
   * only "All rows" transforms persist to a Saved Scraper. */
  function currentTransformPrefsFields() {
    var portable = activeTransforms.filter(function (t) { return !t.rowIndices; });
    return { transforms: portable, autoApplyTransforms: els.tfAutoApplySaved.checked };
  }

  /** V1.18: same idea, for Deep Scraping — saves the CONFIGURATION only
   * (enabled/sourceColumnId/fields/concurrency/pacing), never any
   * run-time result data (that lives only in chrome.storage.session for
   * the current run, exactly like every other zip/monitoring run state
   * in this project). */
  function currentDeepScrapePrefsFields() {
    return { deepScrape: deepScrapeConfig || WSRecipes.emptyDeepScrape() };
  }

  async function handleSaveScraper() {
    if (!state.columns.length) { setStatus('Add at least one column first.', true); return; }
    // V1.15: no more saved-scraper cap of any kind — Saved Scrapers were
    // never part of the 10-run trial to begin with.
    var suggested = hostname ? hostname.replace(/^www\./, '') : 'My Scraper';
    var name = prompt('Scraper Name:', suggested);
    if (name === null) return;
    var runFields = currentRunModeFields();
    var downloadFields = currentDownloadPrefsFields();
    var compareFields = currentComparePrefsFields();
    var transformFields = currentTransformPrefsFields();
    var deepScrapeFields = currentDeepScrapePrefsFields();
    var res = await WSRecipes.saveScraper(Object.assign({
      name: name,
      hostname: hostname,
      pathname: pathname,
      url: pageUrl,
      containerSelector: state.containerSelector,
      columns: state.columns
    }, runFields, downloadFields, compareFields, transformFields, deepScrapeFields));
    if (!res.ok) { setStatus(res.error, true); return; }
    loadedScraperId = res.scraper.id;
    loadedScraperName = res.scraper.name;
    await WSRecipes.setLoadedScraperId(hostname, loadedScraperId);
    updateScraperButtonsVisibility();
    await renderScrapers();
    await renderMonitoringSection();
    setStatus('Saved "' + res.scraper.name + '".', false);
  }

  async function handleUpdateScraper() {
    if (!loadedScraperId) return;
    var runFields = currentRunModeFields();
    var downloadFields = currentDownloadPrefsFields();
    var compareFields = currentComparePrefsFields();
    var transformFields = currentTransformPrefsFields();
    var deepScrapeFields = currentDeepScrapePrefsFields();
    var res = await WSRecipes.updateScraper(loadedScraperId, Object.assign({
      url: pageUrl,
      containerSelector: state.containerSelector,
      columns: state.columns
    }, runFields, downloadFields, compareFields, transformFields, deepScrapeFields));
    if (!res.ok) { setStatus(res.error, true); return; }
    await renderScrapers();
    await renderMonitoringSection();
    setStatus('Updated "' + res.scraper.name + '".', false);
  }

  // =====================================================================
  // Transform / Data Cleaning (V1.7): the FIRST results-pipeline stage —
  // RAW -> TRANSFORMS -> FILTER -> REMOVE DUPLICATES -> SORT -> display/
  // export. Logic lives entirely in utils/transforms.js (pure, DOM-free);
  // this section only manages the "add a transform" UI, the applied-
  // transforms history list, and Undo/Reset. See computeTransformedResult
  // / effectiveColumns just below, which every other pipeline stage reads
  // from instead of state.columns/rawRows directly.
  // =====================================================================

  var TRANSFORM_OPTION_GROUPS = {
    findReplace: 'tfFindReplaceFields', regexReplace: 'tfRegexReplaceFields', regexExtract: 'tfRegexExtractFields',
    changeCase: 'tfCaseFields', prefixSuffix: 'tfPrefixSuffixFields', removePrefix: 'tfRemovePrefixFields',
    removeSuffix: 'tfRemoveSuffixFields', fillEmpty: 'tfFillEmptyFields', normalizeNumber: 'tfNormalizeNumberFields',
    normalizeCurrency: 'tfNormalizeCurrencyFields', normalizePercentage: 'tfNormalizePercentageFields',
    normalizeDate: 'tfNormalizeDateFields', normalizeBoolean: 'tfNormalizeBooleanFields', extractDomain: 'tfExtractDomainFields',
    normalizeUrl: 'tfNormalizeUrlFields', substring: 'tfSubstringFields', split: 'tfSplitFields', combine: 'tfCombineFields'
  };

  var TRANSFORM_LABELS = {
    trim: 'Trim', collapseWhitespace: 'Collapse Whitespace', removeLineBreaks: 'Remove Line Breaks',
    normalizeLineBreaks: 'Normalize Line Breaks', removeTabs: 'Remove Tabs', removeInvisibleChars: 'Remove Invisible Characters',
    normalizeUnicode: 'Normalize Unicode', decodeHtmlEntities: 'Decode HTML Entities',
    removeCurrency: 'Remove Currency', extractNumber: 'Extract Number', normalizeNumber: 'Normalize Number',
    normalizeCurrency: 'Normalize Currency', normalizePercentage: 'Normalize Percentage', normalizeDate: 'Normalize Date',
    normalizeBoolean: 'Normalize Boolean', findReplace: 'Find & Replace',
    regexReplace: 'Regex Replace', regexExtract: 'Regex Extract', changeCase: 'Change Case', capitalizeFirst: 'Capitalize First Letter',
    prefixSuffix: 'Add Prefix/Suffix', removePrefix: 'Remove Prefix', removeSuffix: 'Remove Suffix',
    fillEmpty: 'Fill Empty/Missing', normalizeUrl: 'Normalize URL',
    removeTrackingParams: 'Remove Tracking Params', extractDomain: 'Extract Domain', stripHtml: 'Strip HTML', substring: 'Substring',
    split: 'Split Column', combine: 'Combine Columns'
  };

  var SPLIT_OUTPUT_MODE_LABELS = { firstPart: 'first part', lastPart: 'last part', partByIndex: 'part by index', joinParts: 'joined parts' };

  function describeTransform(t, columns) {
    var label = TRANSFORM_LABELS[t.type] || t.type;
    var name;
    if (t.type === 'combine') {
      var srcNames = ((t.options && t.options.sourceColumns) || []).map(function (id) {
        var c = findColumnAnywhere(id, columns);
        return c ? c.name : id;
      });
      name = label + ' — ' + srcNames.join(' + ') + ' → ' + ((t.options && t.options.outputName) || '');
    } else {
      var col = findColumnAnywhere(t.column, columns);
      name = label + ' — ' + (col ? col.name : t.column);
      if (t.type === 'split') {
        if (WSTransforms.isStructuralSplit(t)) {
          name += ' → ' + ((t.options && t.options.outputNames) || []).join(', ');
        } else {
          name += ' (' + (SPLIT_OUTPUT_MODE_LABELS[(t.options && t.options.outputMode) || 'firstPart'] || '') + ')';
        }
      }
      if (t.destination === 'newColumn') name += ' → ' + (t.newColumnName || 'New Column');
    }
    if (t.rowIndices) name += ' (filtered rows only)';
    if (t.enabled === false) name += ' (disabled)';
    return name;
  }

  /** Looks a column up across the ORIGINAL scraper columns (state.columns)
   * — used for history labels, since a transform might reference a column
   * a LATER transform in the list has already renamed/removed from the
   * effective set. Falls back to null gracefully (label just shows the id). */
  function findColumnAnywhere(id, columns) {
    return columns.filter(function (c) { return c.id === id; })[0] || state.columns.filter(function (c) { return c.id === id; })[0] || null;
  }

  function renderTransformHistory() {
    els.transformsHistoryList.innerHTML = '';
    els.transformsHistoryEmpty.hidden = activeTransforms.length > 0;
    var runningColumns = state.columns.slice();
    activeTransforms.forEach(function (t, idx) {
      var li = document.createElement('li');
      if (t.enabled === false) li.className = 'ws-transform-history-disabled';

      var enableCb = document.createElement('input');
      enableCb.type = 'checkbox';
      enableCb.checked = t.enabled !== false;
      enableCb.title = 'Enable/disable this step';
      enableCb.addEventListener('change', function () { handleToggleTransformEnabled(t.id, enableCb.checked); });

      var label = document.createElement('span');
      label.className = 'ws-transform-history-label';
      label.textContent = describeTransform(t, runningColumns);
      label.title = label.textContent;

      var upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'ws-transform-reorder';
      upBtn.textContent = '▲';
      upBtn.title = 'Move up'; upBtn.setAttribute('aria-label', 'Move up');
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', function () { handleMoveTransformStep(t.id, -1); });

      var downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'ws-transform-reorder';
      downBtn.textContent = '▼';
      downBtn.title = 'Move down'; downBtn.setAttribute('aria-label', 'Move down');
      downBtn.disabled = idx === activeTransforms.length - 1;
      downBtn.addEventListener('click', function () { handleMoveTransformStep(t.id, 1); });

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', function () { handleRemoveTransformStep(t.id); });

      li.appendChild(enableCb);
      li.appendChild(label);
      li.appendChild(upBtn);
      li.appendChild(downBtn);
      li.appendChild(removeBtn);
      els.transformsHistoryList.appendChild(li);

      if (t.enabled === false) return; // a disabled step's real effect is skipped too — don't advance runningColumns past it
      // advance runningColumns so a LATER step's label can still resolve
      // a column a split/combine created earlier in the list
      try { runningColumns = WSTransforms.applyOneTransform([], runningColumns, t, { baseUrl: pageUrl }).columns; } catch (e) { /* label falls back gracefully */ }
    });
    els.undoLastTransformBtn.disabled = activeTransforms.length === 0;
    els.resetTransformsBtn.disabled = activeTransforms.length === 0;
  }

  /** V1.23 spec #2: enable/disable individual transform steps without
   * removing them from the pipeline. */
  function handleToggleTransformEnabled(id, enabled) {
    var t = activeTransforms.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    if (enabled) delete t.enabled; else t.enabled = false;
    invalidateTransformCache();
    renderTransformHistory();
    renderResults();
    setStatus(enabled ? 'Transform step enabled.' : 'Transform step disabled.', false);
  }

  /** V1.23 spec #2: reorder transform steps — order matters, so a step
   * referencing a column a LATER (now earlier) step no longer produces
   * can fail; that's surfaced the same way any other transform error
   * already is (computeTransformedResult falls back to untransformed
   * data with a clear status message), never a silent corruption. */
  function handleMoveTransformStep(id, delta) {
    var idx = activeTransforms.findIndex(function (t) { return t.id === id; });
    if (idx === -1) return;
    var newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= activeTransforms.length) return;
    var tmp = activeTransforms[idx];
    activeTransforms[idx] = activeTransforms[newIdx];
    activeTransforms[newIdx] = tmp;
    invalidateTransformCache();
    renderTransformHistory();
    renderResults();
    setStatus('Transform step moved.', false);
  }

  /** The "add a transform" form's Column select (and Combine's source
   * checkbox list) reflect the EFFECTIVE column set, which changes the
   * instant a Split/Combine step is added, undone, or removed — so every
   * mutation of activeTransforms must refresh them before anything reads
   * the form's current value again, or a stale selection could silently
   * reference a column that no longer exists. */
  function refreshTransformFormColumns() {
    populateTransformColumnSelect();
    if (els.tfOperationSelect.value === 'combine') populateCombineSourceList();
  }

  function handleRemoveTransformStep(id) {
    activeTransforms = activeTransforms.filter(function (t) { return t.id !== id; });
    invalidateTransformCache();
    renderTransformHistory();
    renderResults();
    refreshTransformFormColumns();
    updateTransformPreview();
    setStatus('Transform step removed.', false);
  }

  function handleUndoLastTransform() {
    if (!activeTransforms.length) return;
    activeTransforms = activeTransforms.slice(0, -1);
    invalidateTransformCache();
    renderTransformHistory();
    renderResults();
    refreshTransformFormColumns();
    updateTransformPreview();
    setStatus('Undid the last transform.', false);
  }

  function handleResetTransforms() {
    if (!activeTransforms.length) return;
    if (!confirm('Remove all transforms and return to the raw scraped data?')) return;
    activeTransforms = [];
    invalidateTransformCache();
    renderTransformHistory();
    renderResults();
    refreshTransformFormColumns();
    updateTransformPreview();
    setStatus('All transforms reset — showing raw scraped data.', false);
  }

  function populateTransformColumnSelect() {
    els.tfColumnSelect.innerHTML = '';
    effectiveColumns().forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      els.tfColumnSelect.appendChild(opt);
    });
  }

  function populateCombineSourceList() {
    els.tfCombineSourceList.innerHTML = '';
    effectiveColumns().forEach(function (c) {
      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = c.id;
      cb.addEventListener('change', updateTransformPreview);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + c.name));
      els.tfCombineSourceList.appendChild(label);
    });
  }

  /** Whether the currently-selected split configuration is the
   * STRUCTURAL kind (creates N new columns) — mirrors
   * WSTransforms.isStructuralSplit but reads live form state instead of
   * a stored transform object, since the candidate hasn't been built yet. */
  function isCurrentSplitStructural() {
    return !els.tfSplitOutputMode || els.tfSplitOutputMode.value === 'columns';
  }

  function renderTransformOptionGroups() {
    var type = els.tfOperationSelect.value;
    Object.keys(TRANSFORM_OPTION_GROUPS).forEach(function (t) { els[TRANSFORM_OPTION_GROUPS[t]].hidden = t !== type; });
    els.tfTargetColumnWrap.hidden = type === 'combine';
    var structural = type === 'combine' || (type === 'split' && isCurrentSplitStructural());
    els.tfScopeWrap.hidden = structural || !(activeFilter);
    els.tfDestinationWrap.hidden = structural;
    if (type === 'combine') populateCombineSourceList();
    if (type === 'split') updateSplitFieldVisibility();
    if (type === 'normalizeNumber') updateNumberFieldVisibility();
    if (type === 'normalizeBoolean') updateBooleanFieldVisibility();
    if (type === 'regexExtract') updateExtractFieldVisibility();
    updateDestinationFieldVisibility();
  }

  function updateSubstringFieldVisibility() {
    var mode = els.tfSubstringMode.value;
    els.tfSubstringNWrap.hidden = mode === 'range';
    els.tfSubstringRangeWrap.hidden = mode !== 'range';
  }

  function updateSplitFieldVisibility() {
    var mode = document.querySelector('input[name="tf-split-mode"]:checked').value;
    els.tfSplitDelimiterWrap.hidden = mode !== 'delimiter';
    els.tfSplitRegexWrap.hidden = mode !== 'regex';
    var outputMode = els.tfSplitOutputMode.value;
    els.tfSplitColumnsWrap.hidden = outputMode !== 'columns';
    els.tfSplitPartIndexWrap.hidden = outputMode !== 'partByIndex';
    els.tfSplitJoinWithWrap.hidden = outputMode !== 'joinParts';
    // Switching outputMode also flips whether THIS step is structural —
    // update Scope/Destination directly here too (not via
    // renderTransformOptionGroups, which would call back into this
    // function and recurse).
    var structural = isCurrentSplitStructural();
    els.tfScopeWrap.hidden = structural || !(activeFilter);
    els.tfDestinationWrap.hidden = structural;
    updateDestinationFieldVisibility();
  }

  function updateNumberFieldVisibility() {
    els.tfNumberCustomWrap.hidden = els.tfNumberMode.value !== 'custom';
  }

  function updateBooleanFieldVisibility() {
    els.tfBoolUnmatchedValueWrap.hidden = els.tfBoolUnmatchedMode.value !== 'custom';
  }

  function updateExtractFieldVisibility() {
    els.tfExtractJoinWrap.hidden = !els.tfExtractAll.checked;
  }

  /** V1.23 spec #19 Column Derivation — "Transform in place" vs "Create
   * new column", offered for every non-structural transform type. */
  function updateDestinationFieldVisibility() {
    var destRadio = document.querySelector('input[name="tf-destination"]:checked');
    els.tfNewColumnNameWrap.hidden = !destRadio || destRadio.value !== 'newColumn';
  }

  /** Reads the "add a transform" form into a candidate transform config —
   * does NOT touch activeTransforms. Returns null (and sets a status
   * error) if the form is incomplete. */
  function buildCandidateTransform() {
    var type = els.tfOperationSelect.value;
    var id = WSTransforms.makeTransformId();

    if (type === 'combine') {
      var checked = els.tfCombineSourceList.querySelectorAll('input[type="checkbox"]:checked');
      var sourceColumns = Array.prototype.map.call(checked, function (cb) { return cb.value; });
      return {
        id: id, type: 'combine', column: null,
        options: {
          sourceColumns: sourceColumns,
          template: els.tfCombineTemplate.value,
          outputName: els.tfCombineOutputName.value,
          keepOriginal: els.tfCombineKeepOriginal.checked
        }
      };
    }

    var column = els.tfColumnSelect.value;
    if (!column) { setStatus('Select a column first.', true); return null; }

    var options = {};
    switch (type) {
      case 'findReplace': {
        var occRadio = document.querySelector('input[name="tf-find-occurrence"]:checked');
        options = { find: els.tfFindValue.value, replace: els.tfReplaceValue.value, caseSensitive: els.tfCaseSensitive.checked, occurrence: occRadio ? occRadio.value : 'all' };
        break;
      }
      case 'regexReplace':
        options = { pattern: els.tfRegexPattern.value, flags: els.tfRegexFlags.value, replacement: els.tfRegexReplacement.value };
        break;
      case 'regexExtract':
        options = {
          pattern: els.tfExtractPattern.value, flags: els.tfExtractFlags.value, group: parseInt(els.tfExtractGroup.value, 10) || 0, fallback: els.tfExtractFallback.value,
          all: els.tfExtractAll.checked, joinWith: els.tfExtractJoin.value
        };
        break;
      case 'changeCase':
        options = { mode: els.tfCaseMode.value };
        break;
      case 'capitalizeFirst':
        options = {};
        break;
      case 'prefixSuffix':
        options = { prefix: els.tfPrefixValue.value, suffix: els.tfSuffixValue.value };
        break;
      case 'removePrefix':
        options = { prefix: els.tfRemovePrefixValue.value, caseSensitive: els.tfRemovePrefixCaseSensitive.checked };
        break;
      case 'removeSuffix':
        options = { suffix: els.tfRemoveSuffixValue.value, caseSensitive: els.tfRemoveSuffixCaseSensitive.checked };
        break;
      case 'fillEmpty':
        options = { value: els.tfFillValue.value, matchValues: els.tfFillMatchValues.value, mode: els.tfFillMode.value };
        break;
      case 'normalizeNumber':
        options = { mode: els.tfNumberMode.value, decimalSep: els.tfNumberDecimalSep.value, thousandsSep: els.tfNumberThousandsSep.value };
        break;
      case 'normalizeCurrency':
        options = { mode: els.tfCurrencyMode.value };
        break;
      case 'normalizePercentage':
        options = { mode: els.tfPercentageMode.value };
        break;
      case 'normalizeDate':
        options = { dayMonthOrder: els.tfDateOrder.value, outputFormat: els.tfDateOutputFormat.value };
        break;
      case 'normalizeBoolean':
        options = {
          trueValues: els.tfBoolTrueValues.value, falseValues: els.tfBoolFalseValues.value,
          outputTrue: els.tfBoolOutputTrue.value, outputFalse: els.tfBoolOutputFalse.value,
          unmatchedMode: els.tfBoolUnmatchedMode.value, unmatchedValue: els.tfBoolUnmatchedValue.value
        };
        break;
      case 'extractDomain':
        options = { part: els.tfDomainPart.value };
        break;
      case 'normalizeUrl':
        options = { removeFragment: els.tfRemoveFragment.checked };
        break;
      case 'substring':
        options = { mode: els.tfSubstringMode.value, n: parseInt(els.tfSubstringN.value, 10) || 0, start: parseInt(els.tfSubstringStart.value, 10) || 0, end: els.tfSubstringEnd.value ? parseInt(els.tfSubstringEnd.value, 10) : null };
        break;
      case 'split': {
        var mode = document.querySelector('input[name="tf-split-mode"]:checked').value;
        var limit = document.querySelector('input[name="tf-split-limit"]:checked').value;
        var outputNames = els.tfSplitOutputNames.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        options = {
          mode: mode, delimiter: els.tfSplitDelimiter.value, pattern: els.tfSplitPattern.value, flags: els.tfSplitFlags.value,
          limit: limit, outputNames: outputNames, keepOriginal: els.tfSplitKeepOriginal.checked,
          outputMode: els.tfSplitOutputMode.value, partIndex: parseInt(els.tfSplitPartIndex.value, 10) || 0, joinWith: els.tfSplitJoinWith.value
        };
        break;
      }
      default:
        options = {};
    }

    var candidate = { id: id, type: type, column: column, options: options };

    // V1.23 spec #19: "Transform in place" (default) vs "Create new
    // column" — offered for every non-structural transform (never for
    // combine, and never for split's structural 'columns' output mode,
    // both of which already create their own new column(s)).
    var isStructuralCandidate = type === 'split' && isCurrentSplitStructural();
    if (isStructuralCandidate) { /* no destination control for this candidate */ }
    else {
      var destRadio = document.querySelector('input[name="tf-destination"]:checked');
      if (destRadio && destRadio.value === 'newColumn' && !els.tfDestinationWrap.hidden) {
        candidate.destination = 'newColumn';
        candidate.newColumnName = els.tfNewColumnName.value;
      }
    }

    var scopeRadio = document.querySelector('input[name="tf-scope"]:checked');
    if (scopeRadio && scopeRadio.value === 'filtered' && !els.tfScopeWrap.hidden) {
      candidate.rowIndices = getCurrentFilteredRawIndices();
    }
    return candidate;
  }

  /** Maps the CURRENT filtered view's rows back to their raw-row indices
   * — transforms never add/remove rows, so a transformed row's position
   * always matches its rawRows index throughout the transform stage. */
  function getCurrentFilteredRawIndices() {
    var transformed = computeTransformedResult();
    if (!activeFilter) return transformed.rows.map(function (_, i) { return i; });
    var fres = WSResults.applyFilter(transformed.rows, activeFilter);
    if (fres.error || !fres.rows) return [];
    var indexOfRow = new Map();
    transformed.rows.forEach(function (r, i) { indexOfRow.set(r, i); });
    return fres.rows.map(function (r) { return indexOfRow.get(r); }).filter(function (i) { return i !== undefined; });
  }

  /** Preview-before-apply (spec #30) — live-updates as the user edits the
   * form, never mutates activeTransforms. */
  function updateTransformPreview() {
    if (!rawRows.length) { els.tfPreviewText.textContent = ''; return; }
    var candidate = buildCandidateTransform();
    if (!candidate) { els.tfPreviewText.textContent = ''; return; }
    var res = WSTransforms.previewTransform(rawRows, state.columns, activeTransforms, candidate, { baseUrl: pageUrl }, 5);
    els.tfErrorText.hidden = true;
    if (!res.ok) {
      els.tfErrorText.hidden = false;
      els.tfErrorText.textContent = res.error;
      els.tfPreviewText.textContent = '';
      return;
    }
    if (!res.examples.length) {
      els.tfPreviewText.textContent = 'No populated example values to preview yet.';
      return;
    }
    var lines = ['Before → After', ''];
    res.examples.forEach(function (ex) { lines.push(ex.before + '  →  ' + ex.after); });
    lines.push('', 'Showing ' + res.examples.length + ' example' + (res.examples.length === 1 ? '' : 's') + '.');
    els.tfPreviewText.textContent = lines.join('\n');
  }

  function handleApplyTransform() {
    if (!rawRows.length) { setStatus('Run Preview first — there’s nothing to transform yet.', true); return; }
    var candidate = buildCandidateTransform();
    if (!candidate) return;

    // Validate against the FULL dataset (the live preview only samples a
    // few rows) so a rare edge case elsewhere in the data can't slip
    // through and only surface as an error later.
    try {
      WSTransforms.applyTransforms(rawRows, state.columns, activeTransforms.concat([candidate]), { baseUrl: pageUrl });
    } catch (e) {
      els.tfErrorText.hidden = false;
      els.tfErrorText.textContent = friendlyErrorMessage(e, 'This transform could not be applied to your data.');
      return;
    }

    activeTransforms.push(candidate);
    invalidateTransformCache();
    els.tfErrorText.hidden = true;
    renderTransformHistory();
    renderResults();
    refreshTransformFormColumns();
    updateTransformPreview();
    setStatus('Transform applied.', false);
  }

  /** V1.23 spec #25 Transform Presets — a ready-made SEQUENCE of ordinary
   * steps targeting the currently-selected column, added atomically (all
   * steps validated together against the full dataset; none are added if
   * any would fail). Every added step is immediately an ordinary editable
   * entry in the history list afterward — a preset never becomes a
   * locked/special kind of step. */
  function handleAddPreset() {
    if (!rawRows.length) { setStatus('Run Preview first — there’s nothing to transform yet.', true); return; }
    var column = els.tfColumnSelect.value;
    if (!column) { setStatus('Select a column first.', true); return; }
    var preset = WSTransforms.PRESETS[els.tfPresetSelect.value];
    if (!preset) return;

    var newSteps = preset.steps.map(function (s) {
      return { id: WSTransforms.makeTransformId(), type: s.type, column: column, options: Object.assign({}, s.options || {}) };
    });

    try {
      WSTransforms.applyTransforms(rawRows, state.columns, activeTransforms.concat(newSteps), { baseUrl: pageUrl });
    } catch (e) {
      els.tfErrorText.hidden = false;
      els.tfErrorText.textContent = friendlyErrorMessage(e, 'This preset could not be applied to your data.');
      return;
    }

    activeTransforms = activeTransforms.concat(newSteps);
    invalidateTransformCache();
    els.tfErrorText.hidden = true;
    renderTransformHistory();
    renderResults();
    refreshTransformFormColumns();
    updateTransformPreview();
    setStatus('Added "' + preset.label + '" preset (' + newSteps.length + ' step' + (newSteps.length === 1 ? '' : 's') + ').', false);
  }

  function handleCancelTransformPanel() {
    els.transformPanel.hidden = true;
  }

  function toggleTransformPanel() {
    var willShow = els.transformPanel.hidden;
    els.filterPanel.hidden = true;
    els.sortPanel.hidden = true;
    els.dedupePanel.hidden = true;
    els.snapshotsPanel.hidden = true;
    els.exportOptionsPanel.hidden = true;
    els.transformPanel.hidden = !willShow;
    if (!willShow) return;
    renderTransformHistory();
    refreshTransformFormColumns();
    renderTransformOptionGroups();
    updateSubstringFieldVisibility();
    updateSplitFieldVisibility();
    updateTransformPreview();
  }

  // =====================================================================
  // Results pipeline: RAW -> FILTER -> REMOVE DUPLICATES -> SORT -> display/export

  /** V1.7: transforms are the first pipeline stage (RAW -> TRANSFORMS ->
   * FILTER -> DEDUPE -> SORT), reproduced fresh from rawRows every time
   * per the non-destructive design (see utils/transforms.js). Cached
   * until rawRows/activeTransforms change (invalidateTransformCache()),
   * so re-rendering the results table on every keystroke elsewhere in the
   * UI doesn't re-run the whole pipeline (spec #34). Falls back to the
   * untransformed dataset — never a blank UI — if a transform errors. */
  // NEW FEATURE — DATA CLEANING ENGINE: applies each column's own
  // cleanerType (mission spec #18: "extract raw value -> apply selected
  // column cleaner -> preview cleaned value -> store cleaned export
  // value") to a FRESH cloned array — rawRows itself is never mutated,
  // exactly like WSTransforms' own non-destructive contract, so the true
  // original extracted value always survives underneath (spec #3). Runs
  // BEFORE the advanced WSTransforms pipeline, so a user's own Transform
  // steps see already-cleaned values, and BEFORE dedupe/session identity
  // (which live entirely in content/livewatch.js et al., operating on
  // session.rows directly — this function is never in that path at all,
  // so cleaning can never destructively affect dedupe, per spec #24).
  //
  // Fast path: when no column has an active (non-'raw') cleanerType,
  // returns `rows` completely untouched — spec #1's "if cleaning is
  // disabled... existing behavior must remain unchanged" holds by
  // construction, not merely as an emergent property of every cleaner
  // being a no-op.
  /** TRAVERSAL/CLEANING mission (section 5): the EFFECTIVE cleaner type
   * for a column — the user's own explicit choice (`col.cleanerType`,
   * including an explicit 'raw') always wins and is NEVER second-guessed
   * (that dropdown's own "byte-for-byte, no exceptions" RAW contract is
   * absolute); only a column the user has NEVER touched at all
   * (`cleanerType` still nullish — see the setup UI's own
   * `col.cleanerType || 'raw'` DISPLAY-only default, which never writes
   * 'raw' into the data until an actual dropdown change fires) gets a
   * smart default inferred from its own name (WSCleaners.inferCleanerType
   * — Price/Fiyat, Old Price/Eski Fiyat, Link/URL). Falls back to 'raw'
   * when nothing can be confidently inferred, identical to today. */
  function effectiveCleanerType(col) {
    if (col.cleanerType) return col.cleanerType;
    if (typeof WSCleaners !== 'undefined' && WSCleaners.inferCleanerType) {
      try { return WSCleaners.inferCleanerType(col.name) || 'raw'; } catch (e) { /* fall through */ }
    }
    return 'raw';
  }

  function applyColumnCleaners(rows, columns, context) {
    // typeof-guarded (not a bare `WSCleaners` reference) so this degrades
    // safely to "no cleaning" — identical to RAW — rather than throwing,
    // in any context that hasn't loaded utils/cleaners.js.
    if (typeof WSCleaners === 'undefined' || !columns.some(function (c) { return effectiveCleanerType(c) !== 'raw'; })) return rows;
    return rows.map(function (row) {
      var clone = Object.assign({}, row);
      columns.forEach(function (c) {
        var type = effectiveCleanerType(c);
        if (type === 'raw') return;
        try { clone[c.id] = WSCleaners.applyCleaner(type, row[c.id], context); }
        catch (e) { /* a single malformed value must never break the row (spec #25) — keep it as-extracted */ }
      });
      return clone;
    });
  }

  function computeTransformedResult() {
    if (transformResultCache) return transformResultCache;
    // V1.18: merged Deep Scraping columns (deepScrapeColumns — {id,name}
    // only, never real selectors) are appended to the REAL scraper
    // columns for this one chokepoint every consumer (Filter/Sort/
    // Dedupe/Preview/Export/download-button-visibility) already goes
    // through via effectiveColumns()/computeDisplayRows(). state.columns
    // itself is NEVER touched — it stays the pure extraction contract
    // Save Scraper/Preview/Auto Scroll/Multi-page all still rely on
    // (spec #14: "never replace original columns accidentally").
    var baseColumns = deepScrapeColumns.length ? state.columns.concat(deepScrapeColumns) : state.columns;
    var cleanedRows = applyColumnCleaners(rawRows, baseColumns, { baseUrl: pageUrl });
    // TRAVERSAL/CLEANING mission (section 5/8): always-on data-integrity
    // fixes (Old Price duplicating Current Price, generic ad/marketplace
    // boilerplate masquerading as a Seller name) — never gated behind any
    // per-column setting, since these are correctness fixes for
    // objectively wrong data, not a cleaning-style preference. Runs AFTER
    // column cleaning so the OLD-PRICE-equals-CURRENT-PRICE comparison
    // sees already-deduplicated price text, exactly like a user reading
    // the final exported values would.
    if (typeof WSCleaners !== 'undefined' && WSCleaners.applySemanticIntegrityFixes) {
      try { cleanedRows = WSCleaners.applySemanticIntegrityFixes(cleanedRows, baseColumns); }
      catch (e) { /* never let this optional integrity pass break rendering — keep the already-cleaned rows */ }
    }
    var result;
    try {
      result = WSTransforms.applyTransforms(cleanedRows, baseColumns, activeTransforms, { baseUrl: pageUrl });
    } catch (e) {
      setStatus('Transform error — showing untransformed data: ' + friendlyErrorMessage(e, 'an unexpected error.'), true);
      result = { rows: cleanedRows, columns: baseColumns };
    }
    transformResultCache = result;
    return result;
  }

  function invalidateTransformCache() {
    transformResultCache = null;
  }

  /** The column list Filter/Sort/Dedupe/Export/Download/Snapshot should
   * all use — the scraper's own state.columns PLUS whatever Split/Combine
   * transforms have added (and minus whichever originals they removed).
   * Never state.columns directly once any transform is active. */
  function effectiveColumns() {
    return computeTransformedResult().columns;
  }

  function computeDisplayRows() {
    var transformed = computeTransformedResult();
    var rows = transformed.rows;
    var columns = transformed.columns;
    var error = null;

    if (activeFilter) {
      var fres = WSResults.applyFilter(rows, activeFilter);
      if (fres.error) { error = fres.error; rows = []; }
      else rows = fres.rows;
    }
    if (!error && activeDedupe) {
      rows = WSResults.removeDuplicates(rows, columns, activeDedupe.mode).rows;
    }
    if (!error && activeSort) {
      rows = WSResults.applySort(rows, activeSort.columnId, activeSort.direction);
    }
    return { rows: rows, error: error, columns: columns };
  }

  function buildPreviewTable(columns, rows, limit, targetTable) {
    targetTable = targetTable || els.previewTable;
    targetTable.innerHTML = '';
    var anyAnomaly = rows.some(function (r) { return r._wsAnomaly; });

    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    if (anyAnomaly) headRow.appendChild(document.createElement('th'));
    columns.forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = c.name;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    targetTable.appendChild(thead);

    var tbody = document.createElement('tbody');
    rows.slice(0, limit).forEach(function (row) {
      var tr = document.createElement('tr');
      if (row._wsAnomaly) tr.className = 'ws-row-anomaly';

      if (anyAnomaly) {
        var flagTd = document.createElement('td');
        flagTd.className = 'ws-anomaly-flag';
        if (row._wsAnomaly) {
          flagTd.textContent = '⚠';
          flagTd.title = 'Possible mismatch: ' + row._wsAnomaly;
        }
        tr.appendChild(flagTd);
      }

      columns.forEach(function (c) {
        var td = document.createElement('td');
        var value = row[c.id] || '';
        if (value) {
          td.textContent = value;
          td.title = value;
        } else {
          td.textContent = '—';
          td.className = 'ws-cell-missing';
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    targetTable.appendChild(tbody);
  }

  function renderResults() {
    var result = computeDisplayRows();
    if (result.error) setStatus(result.error, true);

    var rows = result.rows;
    els.rowCount.textContent = '(' + rows.length +
      (rows.length !== rawRows.length ? ' of ' + rawRows.length : '') +
      ' row' + (rawRows.length === 1 ? '' : 's') + ')';
    buildPreviewTable(result.columns, rows, PREVIEW_LIMIT);
    els.previewNote.textContent = rows.length > PREVIEW_LIMIT
      ? 'Showing first ' + PREVIEW_LIMIT.toLocaleString() + ' of ' + rows.length.toLocaleString() + ' rows.'
      : '';
    els.anomalyLegend.hidden = !rows.some(function (r) { return r._wsAnomaly; });
    els.resetResultsBtn.hidden = !(activeFilter || activeDedupe || activeSort);
    els.toggleTransformBtn.classList.toggle('ws-chip-active', activeTransforms.length > 0);
    els.toggleFilterBtn.classList.toggle('ws-chip-active', !!activeFilter);
    els.toggleSortBtn.classList.toggle('ws-chip-active', !!activeSort);
    els.toggleDedupeBtn.classList.toggle('ws-chip-active', !!activeDedupe);

    updateDownloadButtonsVisibility();
    updateScrapeWorkflowStatus();
    updateResultsEmptyState();
    updateResearchTabState();
    renderLiveSessionUI();
  }

  // Download buttons only ever appear when there's a matching column type
  // in the CURRENT (post-transform) columns — never forced on an empty/
  // irrelevant dataset. A transformed/split/combined column counts too,
  // e.g. a Normalize URL'd Link column is still download-eligible.
  function updateDownloadButtonsVisibility() {
    var columns = effectiveColumns();
    var hasImageColumn = columns.some(isImageLikeColumn);
    var hasLinkColumn = columns.some(isLinkLikeColumn);
    els.downloadImagesBtn.hidden = !hasImageColumn;
    els.downloadFilesBtn.hidden = !hasLinkColumn;
  }

  // V1 FINAL: shares runTriggerInFlight with handleStartRun above — see
  // that function's own comment for the full rationale.
  async function handlePreview() {
    if (runTriggerInFlight) return;
    runTriggerInFlight = true;
    try {
      await handlePreviewInner();
    } finally {
      runTriggerInFlight = false;
    }
  }

  async function handlePreviewInner() {
    if (!state.columns.length) {
      setStatus('Add at least one column first.', true);
      return;
    }
    if (!(await trialAllowsNewRun())) { showTrialCompleteModal(); return; }
    setStatus('Scanning page…', false, 'running');
    try {
      var res = await sendToContent({ type: 'RUN_EXTRACTION' });
      if (!res || !res.ok) throw new Error('extraction-failed');
      rawRows = res.rows;
      // V1.15: Preview (Current Page mode) IS the scraping run for this
      // mode — a real extraction against the live page just succeeded, so
      // it consumes exactly 1 trial credit (a fresh id per click; unlike
      // an Auto Scroll/Multi-page run's completion, which can be OBSERVED
      // more than once for the same run, two separate Preview clicks are
      // two separate real extractions and correctly charge twice).
      // Preview/configuration actions that never reach this point (no
      // columns yet, blocked by the trial gate above, or a failed/thrown
      // extraction below) never charge anything.
      await chargeRunCredit('preview_' + hostname + '_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      // Deliberately KEEP activeTransforms across a re-Preview (e.g.
      // re-scraping the same page later) — the whole point of a
      // non-destructive pipeline is that the same cleanup rules replay
      // automatically over fresh raw data. Filter/Sort/Dedupe (which
      // depend on a specific snapshot's values) still reset.
      invalidateTransformCache();
      activeFilter = null;
      activeDedupe = null;
      activeSort = null;
      els.transformPanel.hidden = true;
      els.filterPanel.hidden = true;
      els.sortPanel.hidden = true;
      els.dedupePanel.hidden = true;
      els.snapshotsPanel.hidden = true;
      els.previewSection.hidden = false;
      renderResults();
      if (!rawRows.length) {
        setStatus('No matching elements found on this page — the saved selectors may no longer match this page’s current layout.', true);
      } else {
        setStatus('');
      }
    } catch (e) {
      setStatus("Couldn't read data from this page.", true);
    }
  }

  function handleResetResults() {
    activeFilter = null;
    activeDedupe = null;
    activeSort = null;
    renderResults();
    setStatus('Results reset to the raw scraped data.', false);
  }

  // ---- Filter panel ----

  // Filter/Sort/Dedupe run AFTER Transforms in the pipeline, so their
  // column pickers must offer the EFFECTIVE (post-transform) columns —
  // including any Split/Combine has added — not the scraper's originals.
  function populateColumnSelect(select, includeEntireRow) {
    select.innerHTML = '';
    if (includeEntireRow) {
      var o = document.createElement('option');
      o.value = 'entire-row';
      o.textContent = 'Entire Row';
      select.appendChild(o);
    }
    effectiveColumns().forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      select.appendChild(opt);
    });
  }

  function toggleFilterPanel() {
    var willShow = els.filterPanel.hidden;
    els.transformPanel.hidden = true;
    els.sortPanel.hidden = true;
    els.dedupePanel.hidden = true;
    els.snapshotsPanel.hidden = true;
    els.exportOptionsPanel.hidden = true;
    els.filterPanel.hidden = !willShow;
    if (willShow) {
      populateColumnSelect(els.filterColumn, false);
      if (activeFilter) els.filterColumn.value = activeFilter.columnId;
      els.filterCondition.innerHTML = '';
      FILTER_CONDITIONS.forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.value;
        opt.textContent = c.label;
        els.filterCondition.appendChild(opt);
      });
      if (activeFilter) {
        els.filterCondition.value = activeFilter.condition;
        els.filterValue.value = activeFilter.value || '';
      }
      updateFilterValueVisibility();
    }
  }

  function updateFilterValueVisibility() {
    var noValue = NO_VALUE_CONDITIONS.indexOf(els.filterCondition.value) !== -1;
    els.filterValue.hidden = noValue;
    els.filterValueLabel.hidden = noValue;
  }

  function handleApplyFilter() {
    var candidate = {
      columnId: els.filterColumn.value,
      condition: els.filterCondition.value,
      value: els.filterValue.value
    };
    var res = WSResults.applyFilter(computeTransformedResult().rows, candidate);
    if (res.error) { setStatus(res.error, true); return; }
    activeFilter = candidate;
    renderResults();
    setStatus('Filter applied.', false);
  }

  function handleClearFilter() {
    activeFilter = null;
    els.filterValue.value = '';
    renderResults();
    setStatus('Filter cleared.', false);
  }

  // ---- Sort panel ----

  function toggleSortPanel() {
    var willShow = els.sortPanel.hidden;
    els.transformPanel.hidden = true;
    els.filterPanel.hidden = true;
    els.dedupePanel.hidden = true;
    els.snapshotsPanel.hidden = true;
    els.exportOptionsPanel.hidden = true;
    els.sortPanel.hidden = !willShow;
    if (willShow) {
      populateColumnSelect(els.sortColumn, false);
      if (activeSort) {
        els.sortColumn.value = activeSort.columnId;
        var radios = document.getElementsByName('sort-dir');
        for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === activeSort.direction;
      }
    }
  }

  function handleApplySort() {
    var direction = document.querySelector('input[name="sort-dir"]:checked').value;
    activeSort = { columnId: els.sortColumn.value, direction: direction };
    renderResults();
    setStatus('Sort applied.', false);
  }

  function handleClearSort() {
    activeSort = null;
    renderResults();
    setStatus('Sort cleared.', false);
  }

  // ---- Remove duplicates panel ----

  function toggleDedupePanel() {
    var willShow = els.dedupePanel.hidden;
    els.transformPanel.hidden = true;
    els.filterPanel.hidden = true;
    els.sortPanel.hidden = true;
    els.snapshotsPanel.hidden = true;
    els.exportOptionsPanel.hidden = true;
    els.dedupePanel.hidden = !willShow;
    if (willShow) populateColumnSelect(els.dedupeColumn, true);
  }

  function handleApplyDedupe() {
    var mode = els.dedupeColumn.value;
    var transformed = computeTransformedResult();
    // Dedupe operates on the TRANSFORMED + FILTERED set (transforms ->
    // filter -> dedupe -> sort), so the reported count matches what the
    // user is about to see.
    var afterFilter = transformed.rows;
    if (activeFilter) {
      var fres = WSResults.applyFilter(transformed.rows, activeFilter);
      afterFilter = fres.error ? [] : fres.rows;
    }
    var dres = WSResults.removeDuplicates(afterFilter, transformed.columns, mode);
    activeDedupe = { mode: mode };
    renderResults();
    setStatus(dres.removedCount + ' duplicate' + (dres.removedCount === 1 ? '' : 's') + ' removed.', false);
  }

  // =====================================================================
  // Export / Copy (V1.24 spec: "Export / Destination Improvements") —
  // all operate on the pipeline's CURRENT (transformed, filtered,
  // deduped, sorted) rows, per spec; column order/name follow
  // state.columns exactly as displayed. Adds: selected-column export,
  // an optional "Raw <Column>" sibling for anything an in-place
  // transform changed, a configurable CSV delimiter, filename templates,
  // NDJSON, a Copy format picker, and a clean (currently unconfigured)
  // Google Sheets destination — none of this changes the ONE-CLICK
  // default behavior of CSV/Excel/JSON/Copy when the Export Options
  // panel is never touched (spec #2's "a beginner should still be able
  // to click CSV/Excel/JSON without configuring anything").
  // =====================================================================

  var exportPreferences = WSSettings.defaultExportPreferences(); // overwritten by syncExportPreferencesFromSettings() during init(); safe defaults reproduce pre-V1.24 behavior exactly

  /** Reuses loadAppSettings()'s already-loaded cachedAppSettings (a
   * single WSSettings.load() round-trip at init, same as every other app
   * setting) rather than a second, redundant storage read — must run
   * AFTER loadAppSettings() has populated it. */
  function syncExportPreferencesFromSettings() {
    exportPreferences = (cachedAppSettings && cachedAppSettings.exportPreferences) || WSSettings.defaultExportPreferences();
    if (els.exportCsvDelimiter) els.exportCsvDelimiter.value = exportPreferences.csvDelimiter;
    if (els.exportFilenameTemplate) els.exportFilenameTemplate.value = exportPreferences.filenameTemplate;
    if (els.exportIncludeRaw) els.exportIncludeRaw.checked = exportPreferences.includeRawValues;
    if (els.copyFormatSelect) els.copyFormatSelect.value = exportPreferences.copyFormat;
  }

  /** Fire-and-forget, matching every other lightweight preference save in
   * this project — the in-memory exportPreferences updates immediately
   * so the UI never waits on the write. */
  function persistExportPreference(patch) {
    exportPreferences = Object.assign({}, exportPreferences, patch);
    WSSettings.setExportPreferences(patch);
  }

  /** Returns the transformed+filtered+sorted rows AND the columns they're
   * keyed by (which may differ from state.columns once Split/Combine are
   * active) — export/copy/download must always use these together. */
  function getExportRows() {
    if (!state.columns.length) { setStatus('Add at least one column first.', true); return null; }
    var result = computeDisplayRows();
    if (result.error) { setStatus(result.error, true); return null; }
    if (!result.rows.length) { setStatus('No rows to export.', true); return null; }
    return { rows: result.rows, columns: result.columns };
  }

  /** Which columns currently have at least one ENABLED, IN-PLACE
   * transform touching them — i.e. a transform whose raw source value is
   * no longer visible anywhere else, because destination:'newColumn' and
   * structural split/combine already produce their own separate raw+
   * transformed column pair naturally (spec #17's "do not duplicate
   * every raw field automatically" — only fields that actually NEED a
   * raw sibling to still be visible get one). */
  function columnsWithInPlaceTransform() {
    var touched = {};
    activeTransforms.forEach(function (t) {
      if (t.enabled === false) return;
      if (t.type === 'combine') return;
      if (t.type === 'split' && WSTransforms.isStructuralSplit(t)) return;
      if (t.destination === 'newColumn') return;
      if (t.column) touched[t.column] = true;
    });
    return Object.keys(touched);
  }

  /** Maps each row object CURRENTLY in the transformed pipeline back to
   * its original rawRows index — reuses the exact same "transforms never
   * add/remove rows, so a transformed row's position always matches its
   * rawRows index" invariant V1.23's own getCurrentFilteredRawIndices
   * already relies on for filtering. */
  function buildRawRowIndexMap() {
    var transformed = computeTransformedResult();
    var map = new Map();
    transformed.rows.forEach(function (r, i) { map.set(r, i); });
    return map;
  }

  /** V1.24 spec #2-3/#17: builds the FINAL (columns, rows) an export/
   * Copy/destination should actually use — starting from getExportRows()
   * (the same canonical dataset every pipeline stage already reads from,
   * never a second computation) and optionally narrowing to selected
   * columns and/or adding "Raw <Column>" siblings. Column selection is
   * applied FIRST so a raw sibling only ever appears for a column that
   * survived selection — never an orphaned "Raw" column with no visible
   * transformed counterpart. */
  function buildExportData(opts) {
    opts = opts || {};
    var base = getExportRows();
    if (!base) return null;
    var columns = base.columns.slice();
    var rows = base.rows;

    if (opts.selectedColumnIds) {
      columns = columns.filter(function (c) { return opts.selectedColumnIds.indexOf(c.id) !== -1; });
      if (!columns.length) { setStatus('Select at least one column to export.', true); return null; }
    }

    if (opts.includeRawValues) {
      var touchedIds = columnsWithInPlaceTransform().filter(function (id) {
        return columns.some(function (c) { return c.id === id; });
      });
      if (touchedIds.length) {
        var rawMap = buildRawRowIndexMap();
        var newColumns = columns.slice();
        touchedIds.forEach(function (colId) {
          var srcCol = columns.filter(function (c) { return c.id === colId; })[0];
          var idx = newColumns.findIndex(function (c) { return c.id === colId; });
          newColumns.splice(idx + 1, 0, { id: '__raw_' + colId, name: 'Raw ' + srcCol.name });
        });
        rows = rows.map(function (row) {
          var clone = Object.assign({}, row);
          var rawIdx = rawMap.get(row);
          touchedIds.forEach(function (colId) {
            clone['__raw_' + colId] = (rawIdx != null && rawRows[rawIdx]) ? (rawRows[rawIdx][colId] || '') : '';
          });
          return clone;
        });
        columns = newColumns;
      }
    }

    return { rows: rows, columns: columns };
  }

  /** Reads the Export Options panel's live column-checkbox state — but
   * ONLY once the panel has actually been rendered at least once
   * (els.exportColumnList.children.length > 0); before that, a one-click
   * export correctly includes every column with zero DOM work, matching
   * pre-V1.24 behavior exactly. Returns null (meaning "no filtering,
   * export everything") when the panel was never opened OR every column
   * is still checked. */
  function getSelectedExportColumnIds() {
    if (!els.exportColumnList.children.length) return null;
    var boxes = els.exportColumnList.querySelectorAll('input[type="checkbox"]');
    var selected = Array.prototype.filter.call(boxes, function (cb) { return cb.checked; }).map(function (cb) { return cb.value; });
    if (selected.length === boxes.length) return null;
    return selected;
  }

  function buildExportDataForCurrentOptions() {
    return buildExportData({
      selectedColumnIds: getSelectedExportColumnIds(),
      includeRawValues: !!(els.exportIncludeRaw && els.exportIncludeRaw.checked)
    });
  }

  function currentCsvDelimiter() {
    var v = els.exportCsvDelimiter ? els.exportCsvDelimiter.value : null;
    return v || exportPreferences.csvDelimiter || ',';
  }

  /** V1.24 spec #9-10: the export FILE's base name (no extension),
   * reusing WSDownloads.buildExportFilename's {site}/{scraper}/{date}/
   * {time}/{rows}/{format} token vocabulary. */
  function currentExportFilenameBase(format, rowCount) {
    var template = (els.exportFilenameTemplate && els.exportFilenameTemplate.value.trim()) || exportPreferences.filenameTemplate;
    return WSDownloads.buildExportFilename(template, {
      site: hostname, scraper: loadedScraperName || hostname, rows: rowCount, format: format
    });
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function rowsLabel(n) {
    return n + ' row' + (n === 1 ? '' : 's');
  }

  function handleExportCsv() {
    try {
      var data = buildExportDataForCurrentOptions();
      if (!data) return;
      var csv = WSCsv.rowsToCSV(data.columns, data.rows, { delimiter: currentCsvDelimiter() });
      var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      triggerDownload(blob, currentExportFilenameBase('csv', data.rows.length) + '.csv');
      setStatus(rowsLabel(data.rows.length) + ' exported as CSV.', false, 'success');
    } catch (e) {
      setStatus('CSV export failed.', true);
    }
  }

  function handleExportXlsx() {
    try {
      var data = buildExportDataForCurrentOptions();
      if (!data) return;
      var bytes = WSXlsx.buildWorkbook(data.columns, data.rows);
      var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      triggerDownload(blob, currentExportFilenameBase('xlsx', data.rows.length) + '.xlsx');
      setStatus(rowsLabel(data.rows.length) + ' exported as Excel.', false);
    } catch (e) {
      setStatus('Excel export failed.', true);
    }
  }

  function handleExportJson() {
    try {
      var data = buildExportDataForCurrentOptions();
      if (!data) return;
      var json = WSResults.rowsToJSON(data.columns, data.rows);
      var blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
      triggerDownload(blob, currentExportFilenameBase('json', data.rows.length) + '.json');
      setStatus(rowsLabel(data.rows.length) + ' exported as JSON.', false);
    } catch (e) {
      setStatus('JSON export failed.', true);
    }
  }

  /** V1.24 spec #7 — a clearly SEPARATE button/format from plain JSON
   * (never a hidden mode switch), so a normal user who just wants "JSON"
   * is never confused by NDJSON showing up unexpectedly. */
  function handleExportNdjson() {
    try {
      var data = buildExportDataForCurrentOptions();
      if (!data) return;
      var ndjson = WSResults.rowsToNDJSON(data.columns, data.rows);
      var blob = new Blob([ndjson], { type: 'application/x-ndjson;charset=utf-8;' });
      triggerDownload(blob, currentExportFilenameBase('ndjson', data.rows.length) + '.ndjson');
      setStatus(rowsLabel(data.rows.length) + ' exported as NDJSON.', false);
    } catch (e) {
      setStatus('NDJSON export failed.', true);
    }
  }

  /** V1.24 spec #13-15/#39: Google Sheets is a REAL, clean destination
   * abstraction (utils/destinations.js) that is honestly unconfigured in
   * this build (no OAuth Client ID exists to provision it safely) — this
   * handler always reports that clearly rather than pretending to try,
   * and NEVER sends any data anywhere (spec #39 privacy is trivially
   * satisfied: nothing leaves the browser via this button). */
  async function handleExportSheets() {
    var dest = WSDestinations.getDestination('google-sheets');
    if (!dest || !dest.available) {
      setStatus(dest && dest.reason ? dest.reason : 'Google Sheets isn’t available in this installation.', true);
      return;
    }
    var data = buildExportDataForCurrentOptions();
    if (!data) return;
    setStatus('Sending to Google Sheets…', false, 'running');
    try {
      await WSDestinations.exportToGoogleSheets(data, { mode: 'new' });
      setStatus(rowsLabel(data.rows.length) + ' sent to Google Sheets.', false, 'success');
    } catch (e) {
      setStatus('Google Sheets export failed: ' + friendlyErrorMessage(e, 'an unknown error.'), true);
    }
  }

  async function handleCopy() {
    var data = buildExportDataForCurrentOptions();
    if (!data) return;
    var format = els.copyFormatSelect ? els.copyFormatSelect.value : 'tsv';
    var text;
    if (format === 'csv') text = WSCsv.rowsToCSV(data.columns, data.rows, { delimiter: currentCsvDelimiter() });
    else if (format === 'json') text = WSResults.rowsToJSON(data.columns, data.rows);
    else text = WSResults.rowsToTSV(data.columns, data.rows);
    var label = rowsLabel(data.rows.length) + ' copied' + (format !== 'tsv' ? ' as ' + format.toUpperCase() : '') + '.';
    try {
      await navigator.clipboard.writeText(text);
      setStatus(label, false);
      return;
    } catch (e) {
      // fall through to legacy fallback below
    }
    try {
      var ok = await copyViaFallback(text);
      if (!ok) throw new Error('execCommand copy failed');
      setStatus(label, false);
    } catch (e2) {
      setStatus('Copy failed — clipboard access was blocked.', true);
    }
  }

  // ---- Export Options panel (spec #2-4, #16) ---------------------------

  function renderExportColumnList() {
    els.exportColumnList.innerHTML = '';
    effectiveColumns().forEach(function (c) {
      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = c.id;
      cb.checked = true;
      cb.addEventListener('change', updateExportPreviewText);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + c.name));
      els.exportColumnList.appendChild(label);
    });
  }

  function setAllExportColumnsChecked(checked) {
    els.exportColumnList.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = checked; });
    updateExportPreviewText();
  }

  /** Lightweight, non-forced preview (spec #16 — "do not force preview
   * for simple one-click exports", so this only ever runs while the
   * Export Options panel is actually open). */
  function updateExportPreviewText() {
    if (els.exportOptionsPanel.hidden) return;
    var base = getExportRows();
    if (!base) { els.exportPreviewText.textContent = ''; return; }
    var selectedIds = getSelectedExportColumnIds();
    var colCount = selectedIds ? selectedIds.length : base.columns.length;
    var lines = [
      rowsLabel(base.rows.length) + ', ' + colCount + ' column' + (colCount === 1 ? '' : 's') + (els.exportIncludeRaw.checked ? ' (+ raw values where a transform changed them)' : ''),
      'Filename: ' + currentExportFilenameBase('csv', base.rows.length) + '.csv (Excel/JSON/NDJSON use the same base name)'
    ];
    els.exportPreviewText.textContent = lines.join('\n');
  }

  function toggleExportOptionsPanel() {
    var willShow = els.exportOptionsPanel.hidden;
    els.transformPanel.hidden = true;
    els.filterPanel.hidden = true;
    els.sortPanel.hidden = true;
    els.dedupePanel.hidden = true;
    els.snapshotsPanel.hidden = true;
    els.exportOptionsPanel.hidden = !willShow;
    if (!willShow) return;
    renderExportColumnList();
    els.exportCsvDelimiter.value = exportPreferences.csvDelimiter;
    els.exportFilenameTemplate.value = exportPreferences.filenameTemplate;
    els.exportIncludeRaw.checked = exportPreferences.includeRawValues;
    updateExportPreviewText();
  }

  // =====================================================================
  // Bulk Download (V1.5, ZIP-packaged since V1.13.2): a post-processing
  // layer entirely separate from scraping itself — it only ever reads
  // already-extracted URLs out of state.columns/rawRows. Actual fetch +
  // ZIP + the one final chrome.downloads.download() call all live in
  // background.js (see its own V1.13.2 section header for the full
  // architecture), so downloading keeps progressing even if this popup
  // closes; this file just sends Start/Stop/Retry messages and reflects
  // chrome.storage.session's ws_zip_run key.
  // =====================================================================

  var loadedDownloadColumn = null; // preferred column id from a loaded Saved Scraper, if any
  var currentZipRunId = null; // whichever zip run — Bulk Download OR Research Bundle, only one at a time (see activeDownloadPurpose) — is currently live

  function sendToBackground(message) {
    return chrome.runtime.sendMessage(message);
  }

  function makeZipRunId() {
    return 'zip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /** V1.13.2: fetch() (unlike chrome.downloads.download(), which always
   * bypassed CORS via Chrome's own download manager) DOES enforce CORS
   * from an extension context unless a matching host permission is held
   * — so this requests exactly the origins the queued items' URLs point
   * to (never a blanket grab), synchronously off the real user gesture
   * that called it (the same hard requirement Monitoring's Enable button
   * has always had — see background.js, which only ever calls the
   * gesture-free chrome.permissions.contains()). Returns ok:true with an
   * empty pattern list when there's nothing to fetch (e.g. a
   * manifest-only Research Bundle), so callers never need to special-
   * case "no assets" separately. */
  async function requestOriginPermissions(items) {
    var patterns = WSDownloads.uniqueOriginPatterns(items.map(function (it) { return it.url; }));
    if (!patterns.length) return { ok: true, patterns: patterns };
    var granted;
    try { granted = await chrome.permissions.request({ origins: patterns }); } catch (e) { granted = false; }
    return { ok: granted, patterns: patterns };
  }

  /** Filter/Sort/Dedupe-aware: "Current filtered results" reuses the
   * exact same pipeline CSV/XLSX/JSON already export from; "Entire
   * dataset" goes back to the TRANSFORMED (but not filtered/sorted)
   * dataset — spec #29: a cleaned-up field (e.g. Normalize URL'd Link,
   * or a Trimmed title used in the filename template) should still be
   * the transformed value even when the user picks "entire dataset". */
  function getDownloadScopeRows() {
    var scopeRadio = document.querySelector('input[name="dl-scope"]:checked');
    var scope = scopeRadio ? scopeRadio.value : 'filtered';
    return scope === 'all' ? computeTransformedResult().rows : computeDisplayRows().rows;
  }

  function columnCoverage(columnId) {
    var rows = computeTransformedResult().rows;
    if (!rows.length) return 0;
    return rows.filter(function (r) { return r[columnId]; }).length / rows.length;
  }

  function guessDefaultFilenameTemplate() {
    var textCols = effectiveColumns().filter(function (c) { return c.attribute === 'text'; });
    var titleLike = textCols.filter(function (c) { return /title|name/i.test(c.name); })[0];
    var col = titleLike || textCols[0];
    return col ? ('{' + col.name + '}') : '';
  }

  function populateDownloadColumnSelect() {
    var candidates = effectiveColumns().filter(downloadKind === 'image' ? isImageLikeColumn : isLinkLikeColumn);
    els.dlColumnSelect.innerHTML = '';

    var preferred = candidates.some(function (c) { return c.id === loadedDownloadColumn; }) ? loadedDownloadColumn : null;
    if (!preferred) {
      var best = null, bestCoverage = -1;
      candidates.forEach(function (c) {
        var cov = columnCoverage(c.id);
        if (cov > bestCoverage) { bestCoverage = cov; best = c.id; }
      });
      preferred = best;
    }

    candidates.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name + ' (' + Math.round(columnCoverage(c.id) * 100) + '% coverage)';
      if (c.id === preferred) opt.selected = true;
      els.dlColumnSelect.appendChild(opt);
    });
  }

  function renderTypeFilterCheckboxes() {
    var columnId = els.dlColumnSelect.value;
    if (!columnId) { els.dlTypeFilterList.innerHTML = ''; return; }
    var scopeRows = getDownloadScopeRows();
    var collected = WSDownloads.collectUniqueUrls(scopeRows, columnId, true);
    var typesPresent = {};
    collected.items.forEach(function (item) { typesPresent[WSDownloads.detectFileTypeGroup(item.url).group] = true; });

    els.dlTypeFilterList.innerHTML = '';
    Object.keys(typesPresent).sort().forEach(function (t) {
      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.value = t;
      cb.addEventListener('change', updateDownloadPreview);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + t));
      els.dlTypeFilterList.appendChild(label);
    });
  }

  function buildCurrentDownloadOptions() {
    var dedupeRadio = document.querySelector('input[name="dl-dedupe"]:checked');
    var typeFilter = null;
    if (downloadKind === 'file') {
      var checked = els.dlTypeFilterList.querySelectorAll('input[type="checkbox"]:checked');
      typeFilter = Array.prototype.map.call(checked, function (cb) { return cb.value; });
    }
    return {
      columnId: els.dlColumnSelect.value,
      downloadKind: downloadKind,
      template: els.dlFilenameTemplate.value,
      skipDuplicates: !dedupeRadio || dedupeRadio.value !== 'keep',
      typeFilter: typeFilter
    };
  }

  function buildDownloadSummaryText(queueResult) {
    var s = queueResult.stats;
    var lines = [];
    lines.push((downloadKind === 'image' ? 'Image URLs found: ' : 'Files found: ') + s.totalRows);
    lines.push('Unique: ' + s.unique);
    if (s.duplicates) lines.push(s.duplicates + ' duplicate' + (s.duplicates === 1 ? '' : 's') + ' skipped');
    if (s.invalid) lines.push(s.invalid + ' invalid URL' + (s.invalid === 1 ? '' : 's') + ' skipped');
    if (s.empty) lines.push(s.empty + ' empty value' + (s.empty === 1 ? '' : 's') + ' skipped');
    if (s.typeFilterSkipped) lines.push(s.typeFilterSkipped + ' skipped by file type filter');
    var types = Object.keys(s.byType);
    if (downloadKind === 'file' && types.length) {
      lines.push('');
      types.sort().forEach(function (t) { lines.push(t + ': ' + s.byType[t]); });
    }
    lines.push('');
    lines.push('Estimated names generated: ' + queueResult.items.length);
    return lines.join('\n');
  }

  function updateDownloadPreview() {
    if (!els.dlColumnSelect.value) {
      els.dlPreviewSummary.textContent = 'No matching column available.';
      return;
    }
    var result = WSDownloads.buildDownloadQueue(getDownloadScopeRows(), effectiveColumns(), buildCurrentDownloadOptions());
    els.dlPreviewSummary.textContent = buildDownloadSummaryText(result);
  }

  function handleOpenDownloadPanel(kind) {
    downloadKind = kind;
    els.autoDetectPanel.hidden = true;
    els.transformPanel.hidden = true;
    els.filterPanel.hidden = true;
    els.sortPanel.hidden = true;
    els.dedupePanel.hidden = true;
    els.snapshotsPanel.hidden = true;
    els.exportOptionsPanel.hidden = true;
    els.researchSetupPanel.hidden = true;

    els.dlTypeFilterWrap.hidden = kind !== 'file';
    els.dlScopeWrap.hidden = !(activeFilter || activeDedupe || activeSort);
    var filteredScopeRadio = document.querySelector('input[name="dl-scope"][value="filtered"]');
    if (filteredScopeRadio) filteredScopeRadio.checked = true;
    var skipRadio = document.querySelector('input[name="dl-dedupe"][value="skip"]');
    if (skipRadio) skipRadio.checked = true;

    populateDownloadColumnSelect();
    if (!els.dlFilenameTemplate.value) els.dlFilenameTemplate.value = guessDefaultFilenameTemplate();
    if (!els.dlFolderName.value) els.dlFolderName.value = 'Web Scraper';

    if (kind === 'file') renderTypeFilterCheckboxes();
    updateDownloadPreview();

    els.downloadSetupPanel.hidden = false;
  }

  function handleCancelDownloadSetup() {
    els.downloadSetupPanel.hidden = true;
  }

  async function handleStartDownload() {
    var options = buildCurrentDownloadOptions();
    if (!options.columnId) { setStatus('No column selected.', true); return; }

    var queueResult = WSDownloads.buildDownloadQueue(getDownloadScopeRows(), effectiveColumns(), options);
    if (!queueResult.items.length) { setStatus('No valid URLs to download.', true); return; }

    var folderName = WSDownloads.sanitizeFolderName(els.dlFolderName.value) || 'Web Scraper';
    // V1.13.2: each item's filename gets an images/ or files/ prefix so
    // it lands in the right in-zip subfolder — chrome.downloads.download()
    // used to receive these unprefixed (the outer folderName alone was
    // enough when each asset was its own download); now the folder
    // structure lives INSIDE the single zip instead.
    var zipItems = queueResult.items.map(function (it) {
      return { id: it.id, url: it.url, filename: (options.downloadKind === 'image' ? 'images/' : 'files/') + it.filename };
    });

    setStatus('Requesting permission…', false, 'running');
    var perm = await requestOriginPermissions(zipItems);
    if (!perm.ok) { setStatus('Permission was declined — downloading needs access to fetch these files.', true, 'warning'); return; }

    var runId = makeZipRunId();
    var zipFilename = WSDownloads.sanitizeFilename(safeHostForFilename() + '_' + (options.downloadKind === 'image' ? 'images' : 'files')) + '.zip';
    setStatus('Starting download…', false, 'running');
    try {
      var res = await sendToBackground({
        type: 'START_ZIP_RUN', runId: runId, kind: options.downloadKind, zipFilename: zipFilename, folderName: folderName,
        items: zipItems, manifestFiles: [], concurrency: 4, originPatterns: perm.patterns
      });
      if (!res || !res.ok) throw new Error('start failed');
    } catch (e) {
      setStatus("Couldn't start the download.", true);
      return;
    }
    activeDownloadPurpose = 'bulk';
    currentZipRunId = runId;
    els.downloadSetupPanel.hidden = true;
    attachDownloadStorageListener();
    renderDownloadProgress(null); // "Downloading images 0/N" immediately, before the first storage write lands
    setStatus('');
  }

  // completed/cancelled/error are shared across BOTH panels (Bulk
  // Download and Research Bundle) since both now render the exact same
  // ws_zip_run status enum — fetching/zipping/awaiting-manifest are
  // "still working" (running-styled), the rest are terminal.
  var ZIP_STATUS_BADGE_CLASS = { fetching: 'running', zipping: 'running', 'awaiting-manifest': 'running', completed: 'completed', cancelled: 'stopped', error: 'error' };
  var ZIP_TERMINAL_STATUSES = ['completed', 'cancelled', 'error'];

  function zipKindLabel(kind) {
    if (kind === 'image') return 'images';
    if (kind === 'file') return 'files';
    return 'assets';
  }

  /** Spec's exact progress vocabulary: "Downloading images 18/60" /
   * "Building ZIP..." / "Ready", plus a Failed count whenever at least
   * one item didn't make it (never silently dropped — spec #4/#17). */
  function zipProgressLines(state) {
    var c = state.counts;
    var lines = [];
    if (state.status === 'fetching' || state.status === 'awaiting-manifest') {
      lines.push('Downloading ' + zipKindLabel(state.kind) + ' ' + (c.fetched + c.failed) + '/' + c.total);
    } else if (state.status === 'zipping') {
      lines.push('Building ZIP…');
    } else if (state.status === 'completed') {
      lines.push('Ready');
    } else if (state.status === 'cancelled') {
      lines.push('Cancelled.');
    } else if (state.status === 'error') {
      lines.push('⚠ ' + (state.error || 'Something went wrong.'));
    }
    if (c.failed) lines.push('Failed: ' + c.failed);
    return lines;
  }

  function renderDownloadProgress(state) {
    if (activeDownloadPurpose !== 'bulk') return; // this run belongs to the Research Bundle panel instead — see renderResearchProgress
    els.downloadProgressSection.hidden = false;
    if (!state) {
      els.dlStatusBadge.textContent = 'STARTING';
      els.dlStatusBadge.className = 'ws-status-badge ws-status-running';
      els.dlProgressText.textContent = 'Downloading ' + zipKindLabel(downloadKind) + ' 0/…';
      els.dlFolderNote.textContent = '';
      els.dlStopBtn.hidden = false;
      els.dlRetryBtn.hidden = true;
      els.dlDoneBtn.hidden = true;
      return;
    }
    els.dlStatusBadge.textContent = state.status.toUpperCase();
    els.dlStatusBadge.className = 'ws-status-badge ws-status-' + (ZIP_STATUS_BADGE_CLASS[state.status] || state.status);
    els.dlProgressText.textContent = zipProgressLines(state).join('\n');
    els.dlFolderNote.textContent = state.status === 'completed'
      ? ('Saved to: ' + state.folderName + '/' + state.zipFilename)
      : ('Folder: ' + state.folderName);

    var terminal = ZIP_TERMINAL_STATUSES.indexOf(state.status) !== -1;
    els.dlStopBtn.hidden = terminal;
    els.dlRetryBtn.hidden = !(terminal && state.counts.failed > 0);
    els.dlDoneBtn.hidden = !terminal;
  }

  async function handleStopDownload() {
    setStatus('Stopping…', false);
    try { await sendToBackground({ type: 'STOP_ZIP_RUN', runId: currentZipRunId }); } catch (e) { setStatus('Could not reach the download manager.', true); }
  }

  async function handleRetryFailedDownloads() {
    setStatus('Retrying failed downloads…', false, 'running');
    try { await sendToBackground({ type: 'RETRY_FAILED_ZIP_ITEMS', runId: currentZipRunId }); } catch (e) { setStatus('Could not reach the download manager.', true); }
  }

  function handleDownloadDone() {
    els.downloadProgressSection.hidden = true;
    activeDownloadPurpose = null;
    currentZipRunId = null;
    setStatus('');
  }

  function attachDownloadStorageListener() {
    if (downloadListenerAttached) return;
    downloadListenerAttached = true;
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'session') return;
      if (!changes.ws_zip_run) return;
      var state = changes.ws_zip_run.newValue;
      if (!state || state.runId !== currentZipRunId) return; // an event for a run we're not currently showing (e.g. a stale/earlier one)
      // dispatched to whichever panel currently owns the run — see
      // activeDownloadPurpose's own comment above.
      if (activeDownloadPurpose === 'research') renderResearchProgress(state);
      else renderDownloadProgress(state);
    });
  }

  // =====================================================================
  // Research Dataset Builder / Export Bundle (V1.12; ZIP-packaged since
  // V1.13.2): turns the current results (full or filtered) into a
  // structured, portable dataset — ONE zip containing manifest.csv/xlsx/
  // json + dataset-info.json + images/ + files/ — with every row keeping
  // a stable Dataset ID that ties it to its asset(s). Deliberately a thin
  // orchestration layer, same as Bulk Download and Snapshots before it:
  //   - utils/research.js (pure) still does ALL the actual planning:
  //     Dataset ID assignment, filename/URL mapping, manifest row
  //     shaping, asset status computation, dataset-info.json shaping —
  //     completely unchanged by V1.13.2.
  //   - Asset fetching + the final single chrome.downloads.download()
  //     call for the whole zip now live in background.js's V1.13.2 ZIP
  //     Bundle section (see its header comment) — the SAME pipeline
  //     Bulk Download Images/Files use, just with kind:'research' and a
  //     set of manifest files added alongside the asset items.
  //   - Manifest CONTENT is still computed here (computeResearchManifestFiles
  //     below) — that never changed — but the FINISHED BYTES are now
  //     handed to background.js (base64, over chrome.runtime.sendMessage)
  //     once the asset fetch phase completes, rather than being
  //     downloaded directly from the popup. This two-step handoff exists
  //     because Asset Status (Downloaded/Failed) can only be computed
  //     AFTER fetching finishes, so the manifest can't be built until
  //     background.js reports back that it's ready for it — see
  //     renderResearchProgress's 'awaiting-manifest' branch below.
  //   - Never touches WSSnapshots or any monitoring.* field — spec #22.
  // =====================================================================

  var researchBundle = null; // the in-progress/most-recent bundle's full plan+state, or null

  function pickResearchNameColumnId() {
    var titleName = pickTitleColumnName(); // reuses the exact heuristic Snapshots already uses
    if (!titleName) return null;
    var col = effectiveColumns().filter(function (c) { return c.name === titleName; })[0];
    return col ? col.id : null;
  }

  function getResearchScopeRows() {
    var scopeRadio = document.querySelector('input[name="rb-scope"]:checked');
    var scope = scopeRadio ? scopeRadio.value : 'filtered';
    return scope === 'all' ? computeTransformedResult().rows : computeDisplayRows().rows;
  }

  function populateResearchColumnSelects() {
    var columns = effectiveColumns();
    var imageCandidates = columns.filter(isImageLikeColumn);
    var fileCandidates = columns.filter(isLinkLikeColumn);

    function fill(select, candidates, preferredId) {
      select.innerHTML = '';
      candidates.forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        if (c.id === preferredId || (!preferredId && c === candidates[0])) opt.selected = true;
        select.appendChild(opt);
      });
      return candidates.length ? (select.value || (candidates[0] && candidates[0].id)) : null;
    }

    var loadedResearch = (loadedScraperId && loadedScraperResearch) || null;
    var imgId = fill(els.rbImageColumnSelect, imageCandidates, loadedResearch && loadedResearch.imageColumnId);
    var fileId = fill(els.rbFileColumnSelect, fileCandidates, loadedResearch && loadedResearch.fileColumnId);
    els.rbImageColumnWrap.hidden = imageCandidates.length === 0;
    els.rbFileColumnWrap.hidden = fileCandidates.length === 0;
    return { imageCandidates: imageCandidates, fileCandidates: fileCandidates, imgId: imgId, fileId: fileId };
  }

  /** Spec #3's exact defaults: Excel ON, JSON ON, Images ON only when an
   * Image column exists, Files OFF, CSV OFF (not named as "on" in the
   * spec's default list) — unless a loaded Saved Scraper has its own
   * saved research prefs (spec #21), in which case those win. */
  function applyResearchDefaults(candidates) {
    var prefs = (loadedScraperId && loadedScraperResearch) || WSResearch_defaultPrefs();
    els.rbIncludeCsv.checked = !!prefs.includeCsv;
    els.rbIncludeXlsx.checked = prefs.includeXlsx !== false;
    els.rbIncludeJson.checked = prefs.includeJson !== false;
    els.rbIncludeImages.checked = candidates.imageCandidates.length > 0 && prefs.includeImages !== false;
    els.rbIncludeFiles.checked = candidates.fileCandidates.length > 0 && !!prefs.includeFiles;
  }

  // V1.14: falls back to the Settings > Downloads global default (loaded
  // once at init into cachedAppSettings — see loadAppSettings's sibling
  // call in init()) instead of a hardcoded object; if settings haven't
  // loaded yet for any reason, this is the EXACT same object V1.12
  // always hardcoded here, so behavior is unchanged either way.
  function WSResearch_defaultPrefs() {
    if (cachedAppSettings && cachedAppSettings.researchFormatDefaults) return cachedAppSettings.researchFormatDefaults;
    return { includeCsv: false, includeXlsx: true, includeJson: true, includeImages: true, includeFiles: false };
  }

  function updateResearchPreview() {
    var rows = getResearchScopeRows();
    var lines = [];
    lines.push('Rows: ' + rows.length);
    if (els.rbIncludeImages.checked && !els.rbImageColumnWrap.hidden) {
      var plan = WSResearch.buildAssetPlan(rows, effectiveColumns(), WSResearch.assignDatasetIds(rows), {
        includeImages: true, imageColumnId: els.rbImageColumnSelect.value, nameColumnId: pickResearchNameColumnId()
      });
      lines.push('Images: ' + plan.imageQueue.length + (plan.imageStats && plan.imageStats.duplicates ? ' (' + plan.imageStats.duplicates + ' duplicate URL' + (plan.imageStats.duplicates === 1 ? '' : 's') + ' reusing the same file)' : ''));
    }
    if (els.rbIncludeFiles.checked && !els.rbFileColumnWrap.hidden) {
      var filePlan = WSResearch.buildAssetPlan(rows, effectiveColumns(), WSResearch.assignDatasetIds(rows), {
        includeFiles: true, fileColumnId: els.rbFileColumnSelect.value, nameColumnId: pickResearchNameColumnId()
      });
      lines.push('Files: ' + filePlan.fileQueue.length);
    }
    var formats = [];
    if (els.rbIncludeCsv.checked) formats.push('CSV');
    if (els.rbIncludeXlsx.checked) formats.push('Excel');
    if (els.rbIncludeJson.checked) formats.push('JSON');
    lines.push('Manifest formats: ' + (formats.length ? formats.join(', ') : 'none selected'));
    els.rbPreviewSummary.textContent = lines.join('\n');
  }

  function handleOpenResearchPanel() {
    if (!state.columns.length) { setStatus('Add at least one column first.', true); return; }
    els.autoDetectPanel.hidden = true;
    els.transformPanel.hidden = true;
    els.filterPanel.hidden = true;
    els.sortPanel.hidden = true;
    els.dedupePanel.hidden = true;
    els.snapshotsPanel.hidden = true;
    els.exportOptionsPanel.hidden = true;
    els.downloadSetupPanel.hidden = true;

    var prefs = (loadedScraperId && loadedScraperResearch) || WSResearch_defaultPrefs();
    if (!els.rbDatasetName.value) {
      els.rbDatasetName.value = (prefs.datasetNameTemplate && prefs.datasetNameTemplate.trim()) ||
        (loadedScraperName || (hostname ? hostname.replace(/^www\./, '') : 'Research')) + ' Research';
    }

    els.rbScopeWrap.hidden = !(activeFilter || activeDedupe || activeSort);
    var filteredScopeRadio = document.querySelector('input[name="rb-scope"][value="filtered"]');
    if (filteredScopeRadio) filteredScopeRadio.checked = true;

    var candidates = populateResearchColumnSelects();
    applyResearchDefaults(candidates);
    updateResearchPreview();
    els.researchSetupPanel.hidden = false;
  }

  function handleCancelResearchSetup() {
    els.researchSetupPanel.hidden = true;
  }

  async function handleStartResearchBundle() {
    var datasetNameRaw = els.rbDatasetName.value || 'Research Dataset';
    var includeCsv = els.rbIncludeCsv.checked;
    var includeXlsx = els.rbIncludeXlsx.checked;
    var includeJson = els.rbIncludeJson.checked;
    var includeImages = els.rbIncludeImages.checked && !els.rbImageColumnWrap.hidden;
    var includeFiles = els.rbIncludeFiles.checked && !els.rbFileColumnWrap.hidden;
    var imageColumnId = includeImages ? els.rbImageColumnSelect.value : null;
    var fileColumnId = includeFiles ? els.rbFileColumnSelect.value : null;

    if (!includeCsv && !includeXlsx && !includeJson) { setStatus('Select at least one manifest format (CSV, Excel, or JSON).', true, 'warning'); return; }

    var columns = effectiveColumns();
    var rows = getResearchScopeRows();
    if (!rows.length) { setStatus('No rows to include in the bundle.', true); return; }

    var datasetName = WSResearch.sanitizeDatasetName(datasetNameRaw);
    // V1.13.2: the whole bundle is now ONE file — Web Scraper/Research/
    // <dataset name>.zip — replacing V1.12's Web Scraper/Research/
    // <dataset name>/ folder full of separate manifest + asset files.
    var zipFilename = datasetName + '.zip';
    var folderName = 'Web Scraper/Research';
    var datasetIds = WSResearch.assignDatasetIds(rows);
    var nameColumnId = pickResearchNameColumnId();
    var plan = WSResearch.buildAssetPlan(rows, columns, datasetIds, {
      includeImages: includeImages, imageColumnId: imageColumnId,
      includeFiles: includeFiles, fileColumnId: fileColumnId,
      nameColumnId: nameColumnId
    });

    researchBundle = {
      datasetName: datasetName, folderName: folderName, zipFilename: zipFilename, columns: columns, rows: rows, datasetIds: datasetIds,
      includeCsv: includeCsv, includeXlsx: includeXlsx, includeJson: includeJson,
      includeImages: includeImages, includeFiles: includeFiles,
      imageColumnId: imageColumnId, fileColumnId: fileColumnId,
      imageUrlToFilename: plan.imageUrlToFilename, fileUrlToFilename: plan.fileUrlToFilename,
      createdAt: Date.now(), manifestsSent: false
    };

    // Duplicate image/file URLs across rows (spec #2) are already
    // resolved by WSResearch.buildAssetPlan reusing WSDownloads' own
    // dedup — only ONE item per unique URL ends up queued here, exactly
    // like V1.12; V1.13.2 changed nothing about that.
    var assetItems = plan.imageQueue.map(function (it) { return Object.assign({}, it, { assetKind: 'image' }); })
      .concat(plan.fileQueue.map(function (it) { return Object.assign({}, it, { assetKind: 'file' }); }));

    els.researchSetupPanel.hidden = true;
    els.rbProgressTitle.textContent = 'Creating Research Bundle';

    if (loadedScraperId) {
      WSRecipes.setResearchPrefs(loadedScraperId, {
        datasetNameTemplate: datasetNameRaw, includeCsv: includeCsv, includeXlsx: includeXlsx, includeJson: includeJson,
        includeImages: includeImages, includeFiles: includeFiles, imageColumnId: imageColumnId, fileColumnId: fileColumnId
      }).then(function (res) { if (res && res.ok) loadedScraperResearch = res.scraper.research; });
    }

    // Permission is only ever requested when there's actually something
    // to fetch — a manifest-only bundle (Images/Files both off) needs
    // none, and requestOriginPermissions() already returns ok:true with
    // an empty pattern list in that case, so this never has to special-
    // case "no assets" itself.
    var perm = { ok: true, patterns: [] };
    if (assetItems.length) {
      setStatus('Requesting permission…', false, 'running');
      perm = await requestOriginPermissions(assetItems);
      if (!perm.ok) {
        setStatus('Permission was declined — the Research Bundle needs access to fetch these images/files.', true, 'warning');
        researchBundle = null;
        return;
      }
    }

    var runId = makeZipRunId();
    setStatus('Starting Research Bundle…', false, 'running');
    try {
      var res = await sendToBackground({
        type: 'START_ZIP_RUN', runId: runId, kind: 'research', zipFilename: zipFilename, folderName: folderName,
        items: assetItems, manifestFiles: [], concurrency: 4, originPatterns: perm.patterns
      });
      if (!res || !res.ok) throw new Error('start failed');
    } catch (e) {
      setStatus("Couldn't start the Research Bundle.", true);
      researchBundle = null;
      return;
    }
    activeDownloadPurpose = 'research';
    currentZipRunId = runId;
    attachDownloadStorageListener();
    renderResearchProgress(null);
    setStatus('');
  }

  /** Computes manifest.csv/xlsx/json + dataset-info.json from the
   * research bundle's plan and (once available) the run's final
   * per-item fetch outcomes — identical logic to V1.12's own
   * finalizeResearchBundle, just returning base64 file descriptors
   * instead of Blobs, since these now travel to background.js over
   * chrome.runtime.sendMessage instead of being downloaded directly from
   * here. `itemsFromRun` is `[]` for a manifest-only bundle (Images/
   * Files both off) — every asset's status then correctly reads
   * 'skipped', matching utils/research.js's own documented behavior. */
  function computeResearchManifestFiles(rb, itemsFromRun) {
    var statusMap = WSResearch.runItemsToStatusMap(itemsFromRun || []);
    var manifest = WSResearch.buildManifestRows(rb.rows, rb.columns, rb.datasetIds, {
      includeImages: rb.includeImages, includeFiles: rb.includeFiles,
      imageColumnId: rb.imageColumnId, fileColumnId: rb.fileColumnId,
      imageUrlToFilename: rb.imageUrlToFilename, fileUrlToFilename: rb.fileUrlToFilename,
      imageUrlToStatus: rb.includeImages ? statusMap : null,
      fileUrlToStatus: rb.includeFiles ? statusMap : null
    });

    var files = [];
    if (rb.includeCsv) files.push({ name: 'manifest.csv', dataB64: WSZip.bytesToBase64(new TextEncoder().encode('﻿' + WSCsv.rowsToCSV(manifest.columns, manifest.rows))) });
    if (rb.includeXlsx) files.push({ name: 'manifest.xlsx', dataB64: WSZip.bytesToBase64(WSXlsx.buildWorkbook(manifest.columns, manifest.rows)) });
    if (rb.includeJson) files.push({ name: 'manifest.json', dataB64: WSZip.bytesToBase64(new TextEncoder().encode(WSResults.rowsToJSON(manifest.columns, manifest.rows))) });

    var includedFormats = [];
    if (rb.includeCsv) includedFormats.push('csv');
    if (rb.includeXlsx) includedFormats.push('xlsx');
    if (rb.includeJson) includedFormats.push('json');
    if (rb.includeImages) includedFormats.push('images');
    if (rb.includeFiles) includedFormats.push('files');

    var fetchedCount = (itemsFromRun || []).filter(function (it) { return it.status === 'fetched'; }).length;
    var failedCount = (itemsFromRun || []).filter(function (it) { return it.status === 'failed'; }).length;
    var datasetInfo = WSResearch.buildDatasetInfo({
      datasetName: rb.datasetName, createdAt: rb.createdAt, sourceURL: pageUrl, hostname: hostname,
      savedScraperName: loadedScraperName || null, rowCount: rb.rows.length, includedFormats: includedFormats,
      assetCount: fetchedCount, failedAssetCount: failedCount,
      scraperVersion: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : null,
      columns: rb.columns,
      // V1.24 spec #24: extra metadata, purely additive — see
      // WSResearch.buildDatasetInfo's own doc comment.
      collectionMode: currentRunModeFields().mode,
      deepScrapeEnabled: !!(deepScrapeConfig && deepScrapeConfig.enabled),
      transformStepCount: activeTransforms.length,
      exportedAt: Date.now()
    });
    files.push({ name: 'dataset-info.json', dataB64: WSZip.bytesToBase64(new TextEncoder().encode(JSON.stringify(datasetInfo, null, 2))) });

    return files;
  }

  function renderResearchProgress(state) {
    if (activeDownloadPurpose !== 'research' || !researchBundle) return;
    els.researchProgressSection.hidden = false;

    var imageTotal = researchBundle.includeImages ? Object.keys(researchBundle.imageUrlToFilename).length : 0;
    var fileTotal = researchBundle.includeFiles ? Object.keys(researchBundle.fileUrlToFilename).length : 0;

    if (!state) {
      els.rbStatusBadge.textContent = 'STARTING';
      els.rbStatusBadge.className = 'ws-status-badge ws-status-running';
      els.rbProgressText.textContent = 'Rows: ' + researchBundle.rows.length + '\nImages: ' + imageTotal + '\nFiles: ' + fileTotal;
      els.rbFolderNote.textContent = 'Folder: ' + researchBundle.folderName + '/' + researchBundle.zipFilename;
      els.rbStopBtn.hidden = false;
      els.rbRetryBtn.hidden = true;
      els.rbDoneBtn.hidden = true;
      return;
    }

    els.rbStatusBadge.textContent = state.status.toUpperCase();
    els.rbStatusBadge.className = 'ws-status-badge ws-status-' + (ZIP_STATUS_BADGE_CLASS[state.status] || state.status);
    var lines = ['Rows: ' + researchBundle.rows.length, 'Images: ' + imageTotal, 'Files: ' + fileTotal, ''].concat(zipProgressLines(state));
    els.rbProgressText.textContent = lines.join('\n');
    els.rbFolderNote.textContent = state.status === 'completed'
      ? ('Saved to: ' + state.folderName + '/' + state.zipFilename)
      : ('Folder: ' + state.folderName);

    var terminal = ZIP_TERMINAL_STATUSES.indexOf(state.status) !== -1;
    els.rbStopBtn.hidden = terminal;
    els.rbRetryBtn.hidden = !(terminal && state.counts.failed > 0);
    els.rbDoneBtn.hidden = !terminal;
    if (terminal) {
      els.rbProgressTitle.textContent = state.status === 'completed' ? 'Research Bundle Complete'
        : (state.status === 'cancelled' ? 'Research Bundle Cancelled' : 'Research Bundle Failed');
    }

    // background.js parks a 'research' run at 'awaiting-manifest' once
    // every asset has been fetched (see its own header comment) — it
    // can't compute Asset Status itself (utils/research.js is popup-
    // only), so this is the one moment the popup MUST be listening: as
    // soon as this status is seen, compute the manifest from the run's
    // now-final per-item outcomes and hand the bytes back so
    // background.js can finish the zip. manifestsSent guards against
    // sending it twice for the same awaiting-manifest window (this
    // listener can fire more than once while the status hasn't changed
    // again yet) — handleRetryFailedResearchAssets resets it before a
    // retry so the NEXT awaiting-manifest window sends a fresh one.
    if (state.status === 'awaiting-manifest' && !researchBundle.manifestsSent) {
      researchBundle.manifestsSent = true;
      var manifestFiles = computeResearchManifestFiles(researchBundle, state.items);
      sendToBackground({ type: 'PROVIDE_RESEARCH_MANIFEST', runId: state.runId, manifestFiles: manifestFiles })
        .catch(function (e) { setStatus('Could not finalize the Research Bundle: ' + friendlyErrorMessage(e, 'please try again.'), true); });
    }
  }

  async function handleStopResearchBundle() {
    setStatus('Stopping…', false);
    try { await sendToBackground({ type: 'STOP_ZIP_RUN', runId: currentZipRunId }); } catch (e) { setStatus('Could not reach the download manager.', true); }
  }

  async function handleRetryFailedResearchAssets() {
    setStatus('Retrying failed assets…', false, 'running');
    if (researchBundle) researchBundle.manifestsSent = false; // a successful retry must regenerate the manifest with updated Asset Status
    try { await sendToBackground({ type: 'RETRY_FAILED_ZIP_ITEMS', runId: currentZipRunId }); } catch (e) { setStatus('Could not reach the download manager.', true); }
  }

  function handleResearchBundleDone() {
    els.researchProgressSection.hidden = true;
    activeDownloadPurpose = null;
    currentZipRunId = null;
    researchBundle = null;
    setStatus('');
  }

  // =====================================================================
  // Snapshots / Change Detection (V1.6): a manual-run comparison layer on
  // top of the results pipeline, exactly like Bulk Download is a
  // post-processing layer — it only ever reads already-extracted rows out
  // of state.columns/rawRows and never touches the scraper engine.
  // Snapshots persist via utils/snapshots.js (chrome.storage.local, local
  // only); the comparison itself (utils/changes.js) is pure in-memory
  // logic, never persisted. No scheduled/background checks of any kind —
  // every snapshot and every comparison happens because the user clicked
  // a button right now.
  // =====================================================================

  // V1.7 policy (spec #26): Snapshot/Compare use the EFFECTIVE
  // (post-transform) columns and dataset — a Trimmed/Normalized value is
  // what gets compared, which is exactly what cuts down on false-positive
  // "changes" caused by pure formatting noise like "$19.99" vs "19.99".
  // This is a documented, deliberate behavior change from V1.6 (which had
  // no transform stage to be "before" or "after" of) — never silent.
  function namedColumnsFromState() {
    return effectiveColumns().map(function (c) { return { name: c.name, attribute: c.attribute }; });
  }

  function pickTitleColumnName() {
    var columns = effectiveColumns();
    var textCols = columns.filter(function (c) { return c.attribute === 'text'; });
    var titleLike = textCols.filter(function (c) { return /title|name|product/i.test(c.name); })[0];
    var col = titleLike || textCols[0] || columns[0];
    return col ? col.name : null;
  }

  function pickLinkColumnName() {
    var col = effectiveColumns().filter(isLinkLikeColumn)[0];
    return col ? col.name : null;
  }

  /** Snapshots group by Saved Scraper when one is loaded, or by
   * hostname+pathname for an ad-hoc/temporary snapshot (spec #25). */
  function getSnapshotGroupFilter() {
    return loadedScraperId ? { scraperId: loadedScraperId } : { hostname: hostname, pathname: pathname };
  }

  function formatSnapshotDate(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  /** Priority per spec #3: a saved preference > a Link/URL-like column >
   * Entire Row. */
  function populateCompareKeySelect() {
    els.compareKeySelect.innerHTML = '';
    var entireOpt = document.createElement('option');
    entireOpt.value = 'entire-row';
    entireOpt.textContent = 'Entire Row';
    els.compareKeySelect.appendChild(entireOpt);
    var columns = effectiveColumns();
    columns.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = c.name;
      els.compareKeySelect.appendChild(opt);
    });

    var preferred = null;
    if (loadedCompareKey === 'entire-row') preferred = 'entire-row';
    else if (loadedCompareKey && columns.some(function (c) { return c.name === loadedCompareKey; })) preferred = loadedCompareKey;
    if (!preferred) preferred = pickLinkColumnName() || 'entire-row';
    els.compareKeySelect.value = preferred;
  }

  /** Live feedback (spec #17) — warns before the user even clicks
   * Compare/Save if the chosen key isn't actually unique in the current
   * results, without silently mismatching anything. */
  function updateSnapshotDuplicateNote() {
    if (!rawRows.length) { els.snapshotDuplicateNote.hidden = true; return; }
    var columns = namedColumnsFromState();
    var namedRows = WSChanges.toNamedRows(effectiveColumns(), computeTransformedResult().rows);
    var keyMode = els.compareKeySelect.value || 'entire-row';
    var dupCount = WSChanges.countDuplicateKeys(namedRows, columns, keyMode);
    if (dupCount > 0) {
      els.snapshotDuplicateNote.hidden = false;
      els.snapshotDuplicateNote.textContent = '⚠ ' + dupCount + ' duplicate "' + (keyMode === 'entire-row' ? 'Entire Row' : keyMode) +
        '" value' + (dupCount === 1 ? '' : 's') + ' found in the current results. Comparison may be ambiguous.';
    } else {
      els.snapshotDuplicateNote.hidden = true;
    }
  }

  async function refreshSnapshotInfo() {
    var previousSnapshot = await WSSnapshots.getLatestSnapshot(getSnapshotGroupFilter());
    if (!previousSnapshot) {
      // Spec #15: first run is not an error state.
      els.snapshotInfoText.textContent = 'No previous snapshot yet.';
      els.compareSnapshotBtn.hidden = true;
    } else {
      els.snapshotInfoText.textContent = 'Previous snapshot: ' + formatSnapshotDate(previousSnapshot.createdAt) + ' (' + previousSnapshot.rowCount + ' rows)';
      els.compareSnapshotBtn.hidden = false;
    }
  }

  async function toggleSnapshotsPanel() {
    var willShow = els.snapshotsPanel.hidden;
    els.transformPanel.hidden = true;
    els.filterPanel.hidden = true;
    els.sortPanel.hidden = true;
    els.dedupePanel.hidden = true;
    els.downloadSetupPanel.hidden = true;
    els.researchSetupPanel.hidden = true;
    els.exportOptionsPanel.hidden = true;
    els.snapshotsPanel.hidden = !willShow;
    if (!willShow) return;
    populateCompareKeySelect();
    updateSnapshotDuplicateNote();
    await refreshSnapshotInfo();
  }

  /** Snapshot captures the TRANSFORMED dataset (spec #26 policy) — AFTER
   * configured Transforms, but BEFORE the temporary Filter/Sort/Dedupe
   * view; never a filtered subset (spec #24), which would corrupt every
   * future comparison. */
  function currentSnapshotInput() {
    var transformed = computeTransformedResult();
    return {
      scraperId: loadedScraperId || null,
      scraperName: loadedScraperName || (hostname || 'Untitled'),
      url: pageUrl || '',
      hostname: hostname,
      pathname: pathname,
      columns: namedColumnsFromState(),
      rows: WSChanges.toNamedRows(transformed.columns, transformed.rows),
      uniqueKey: els.compareKeySelect.value || loadedCompareKey || 'entire-row'
    };
  }

  async function handleSaveSnapshot() {
    if (!rawRows.length) { setStatus('Run Preview first — there’s nothing to snapshot yet.', true); return; }
    var res = await WSSnapshots.saveSnapshot(currentSnapshotInput());
    if (!res.ok) { setStatus(res.error, true); return; }
    await refreshSnapshotInfo();
    await renderScrapers(); // picks up the updated "Snapshots: N" footer
    setStatus(res.warning ? ('Snapshot saved. ' + res.warning) : ('Snapshot saved (' + res.snapshot.rowCount + ' rows).'), false);
  }

  function getFilteredChangeEntries(result, filter) {
    var entries = [];
    if (filter === 'all' || filter === 'new') {
      result.new.forEach(function (row) { entries.push({ type: 'new', row: row }); });
    }
    if (filter === 'all' || filter === 'removed') {
      result.removed.forEach(function (row) { entries.push({ type: 'removed', row: row }); });
    }
    if (filter === 'all' || filter === 'changed') {
      result.changed.forEach(function (c) {
        entries.push({ type: 'changed', previousRow: c.previousRow, currentRow: c.currentRow, fieldChanges: c.fieldChanges });
      });
    }
    if (filter === 'price') {
      result.changed.forEach(function (c) {
        if (c.fieldChanges.some(function (fc) { return fc.isPriceChange; })) {
          entries.push({ type: 'changed', previousRow: c.previousRow, currentRow: c.currentRow, fieldChanges: c.fieldChanges });
        }
      });
    }
    return entries;
  }

  function buildChangeDetail(container, entry, columns) {
    container.innerHTML = '';
    if (entry.type === 'changed') {
      var changedByName = {};
      entry.fieldChanges.forEach(function (fc) { changedByName[fc.columnName] = fc; });
      columns.forEach(function (col) {
        var line = document.createElement('div');
        line.className = 'ws-change-detail-field';
        var name = document.createElement('span');
        name.className = 'ws-change-detail-field-name';
        name.textContent = col.name;
        var value = document.createElement('span');
        value.className = 'ws-change-detail-field-value';
        var fc = changedByName[col.name];
        if (fc) {
          value.classList.add('ws-change-detail-diff');
          var oldSpan = document.createElement('span');
          oldSpan.className = 'ws-change-detail-old';
          oldSpan.textContent = fc.oldValue || '—';
          var newSpan = document.createElement('span');
          newSpan.className = 'ws-change-detail-new';
          newSpan.textContent = fc.newValue || '—';
          value.appendChild(oldSpan);
          value.appendChild(document.createTextNode(' → '));
          value.appendChild(newSpan);
        } else {
          value.textContent = 'unchanged';
        }
        line.appendChild(name);
        line.appendChild(value);
        container.appendChild(line);
      });
    } else {
      columns.forEach(function (col) {
        var line = document.createElement('div');
        line.className = 'ws-change-detail-field';
        var name = document.createElement('span');
        name.className = 'ws-change-detail-field-name';
        name.textContent = col.name;
        var value = document.createElement('span');
        value.className = 'ws-change-detail-field-value';
        value.textContent = entry.row[col.name] || '—';
        line.appendChild(name);
        line.appendChild(value);
        container.appendChild(line);
      });
    }
  }

  function buildChangeRowElement(entry, columns) {
    var rowEl = document.createElement('div');
    rowEl.className = 'ws-change-row';

    var head = document.createElement('div');
    head.className = 'ws-change-row-head';

    var badge = document.createElement('span');
    badge.className = 'ws-change-badge ws-change-badge-' + entry.type;
    badge.textContent = entry.type === 'new' ? '+ New' : entry.type === 'removed' ? '− Removed' : '~ Changed';
    head.appendChild(badge);

    var title = document.createElement('span');
    title.className = 'ws-change-title';
    var titleCol = pickTitleColumnName();
    var displayRow = entry.type === 'removed' ? entry.row : (entry.currentRow || entry.row);
    title.textContent = (titleCol && displayRow[titleCol]) || '(no title column)';
    title.title = title.textContent;
    head.appendChild(title);

    if (entry.type === 'changed') {
      var priceFc = entry.fieldChanges.filter(function (fc) { return fc.isPriceChange; })[0];
      if (priceFc) {
        var chip = document.createElement('span');
        chip.className = 'ws-price-chip ' + (priceFc.direction === 'decreased' ? 'ws-price-chip-down' : 'ws-price-chip-up');
        var deltaText = (priceFc.delta > 0 ? '+' : '') + (Math.round(priceFc.delta * 100) / 100);
        var pctText = priceFc.percent === null ? '' : ' (' + (priceFc.percent > 0 ? '+' : '') + Math.round(priceFc.percent) + '%)';
        chip.textContent = (priceFc.direction === 'decreased' ? '↓ ' : '↑ ') + deltaText + pctText;
        head.appendChild(chip);
      }
    }
    rowEl.appendChild(head);

    if (entry.type === 'changed') {
      var preview = document.createElement('div');
      preview.className = 'ws-change-preview';
      var parts = entry.fieldChanges.slice(0, 2).map(function (fc) {
        return fc.columnName + ': ' + (fc.oldValue || '—') + ' → ' + (fc.newValue || '—');
      });
      if (entry.fieldChanges.length > 2) parts.push('+' + (entry.fieldChanges.length - 2) + ' more');
      preview.textContent = parts.join('  •  ');
      rowEl.appendChild(preview);
    }

    var detail = document.createElement('div');
    detail.className = 'ws-change-detail';
    detail.hidden = true;
    rowEl.appendChild(detail);

    var built = false;
    rowEl.addEventListener('click', function () {
      if (!built) { buildChangeDetail(detail, entry, columns); built = true; }
      detail.hidden = !detail.hidden;
    });

    return rowEl;
  }

  function renderChangesList() {
    if (!lastComparisonResult) return;
    var columns = namedColumnsFromState();
    var entries = getFilteredChangeEntries(lastComparisonResult, changesActiveFilter);
    els.changesList.innerHTML = '';
    // V1.25 spec #3-4: windowed the same way the Results table already
    // was — export/Copy of change data (currentChangesExport) still
    // reads from the FULL, un-windowed `entries`/lastComparisonResult,
    // never this rendered slice.
    entries.slice(0, CHANGES_LIST_LIMIT).forEach(function (entry) { els.changesList.appendChild(buildChangeRowElement(entry, columns)); });
    els.changesEmptyNote.hidden = entries.length > 0;
    if (entries.length > CHANGES_LIST_LIMIT) {
      els.changesTruncatedNote.hidden = false;
      els.changesTruncatedNote.textContent = 'Showing first ' + CHANGES_LIST_LIMIT.toLocaleString() + ' of ' + entries.length.toLocaleString() + ' changes.';
    } else {
      els.changesTruncatedNote.hidden = true;
    }
  }

  function setChangesFilter(filter) {
    changesActiveFilter = filter;
    [els.changesFilterAll, els.changesFilterNew, els.changesFilterRemoved, els.changesFilterChanged, els.changesFilterPrice].forEach(function (btn) {
      btn.classList.toggle('ws-chip-active', btn.dataset.filter === filter);
    });
    renderChangesList();
  }

  function renderChangesSummary(result, previousSnapshot) {
    var lines = [];
    lines.push('Previous snapshot: ' + formatSnapshotDate(previousSnapshot.createdAt));
    lines.push('Current: ' + formatSnapshotDate(Date.now()));
    lines.push('');
    lines.push('Rows: ' + result.stats.previousCount + ' previous, ' + result.stats.currentCount + ' current');
    lines.push('');
    lines.push('Changes:  +' + result.stats.newCount + ' New   −' + result.stats.removedCount + ' Removed   ~' + result.stats.changedCount + ' Changed');
    if (result.stats.priceDecreased || result.stats.priceIncreased) {
      lines.push('Price:  ↓' + result.stats.priceDecreased + ' decreased   ↑' + result.stats.priceIncreased + ' increased');
    }
    els.changesSummaryText.textContent = lines.join('\n');

    if (result.duplicateKeyWarning) {
      els.changesDuplicateNote.hidden = false;
      els.changesDuplicateNote.textContent = '⚠ ' + result.duplicateKeyWarning.message;
    } else {
      els.changesDuplicateNote.hidden = true;
    }
    els.changesFilterPrice.hidden = !(result.stats.priceDecreased || result.stats.priceIncreased);
  }

  async function handleCompareWithPrevious() {
    if (!rawRows.length) { setStatus('Run Preview first so there’s something to compare.', true); return; }
    var previousSnapshot = await WSSnapshots.getLatestSnapshot(getSnapshotGroupFilter());
    if (!previousSnapshot) { setStatus('No previous snapshot to compare with — save one first.', true); return; }

    var transformed = computeTransformedResult();
    var columns = namedColumnsFromState();
    var currentNamed = WSChanges.toNamedRows(transformed.columns, transformed.rows);
    var keyMode = els.compareKeySelect.value || 'entire-row';

    lastComparisonResult = WSChanges.compareDatasets(previousSnapshot.rows, currentNamed, columns, { keyMode: keyMode });

    els.snapshotsPanel.hidden = true;
    els.previewSection.hidden = true;
    els.changesSection.hidden = false;
    renderChangesSummary(lastComparisonResult, previousSnapshot);
    setChangesFilter('all');
    setStatus('');
  }

  function handleChangesBack() {
    els.changesSection.hidden = true;
    els.previewSection.hidden = false;
  }

  async function handleSaveAfterCompare() {
    if (!els.saveSnapshotAfterCompare.checked) {
      setStatus('Check "Save current results as a new snapshot" first.', true);
      return;
    }
    await handleSaveSnapshot();
  }

  var CHANGES_EXPORT_HEADERS = ['Change Type', 'Field', 'Old Value', 'New Value', 'Link'];
  var PRICE_EXPORT_HEADERS = ['Product', 'Old Price', 'New Price', 'Difference', 'Percent', 'Link'];

  function currentChangesExport() {
    if (!lastComparisonResult) { setStatus('Run a comparison first.', true); return null; }
    var linkCol = pickLinkColumnName();
    if (changesActiveFilter === 'price') {
      var rows = WSChanges.priceChangesToExportRows(lastComparisonResult, pickTitleColumnName(), linkCol);
      if (!rows.length) { setStatus('No price changes to export.', true); return null; }
      return { rows: rows, columns: PRICE_EXPORT_HEADERS.map(function (h) { return { id: h, name: h }; }) };
    }
    var allRows = WSChanges.changesToExportRows(lastComparisonResult, linkCol);
    if (!allRows.length) { setStatus('No changes to export.', true); return null; }
    return { rows: allRows, columns: CHANGES_EXPORT_HEADERS.map(function (h) { return { id: h, name: h }; }) };
  }

  function handleExportChangesCsv() {
    var data = currentChangesExport();
    if (!data) return;
    try {
      var csv = WSCsv.rowsToCSV(data.columns, data.rows);
      var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      triggerDownload(blob, 'web-scraper-changes-' + safeHostForFilename() + '-' + Date.now() + '.csv');
      setStatus(rowsLabel(data.rows.length) + ' of changes exported as CSV.', false);
    } catch (e) {
      setStatus('CSV export failed.', true);
    }
  }

  function handleExportChangesXlsx() {
    var data = currentChangesExport();
    if (!data) return;
    try {
      var bytes = WSXlsx.buildWorkbook(data.columns, data.rows);
      var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      triggerDownload(blob, 'web-scraper-changes-' + safeHostForFilename() + '-' + Date.now() + '.xlsx');
      setStatus(rowsLabel(data.rows.length) + ' of changes exported as Excel.', false);
    } catch (e) {
      setStatus('Excel export failed.', true);
    }
  }

  function handleExportChangesJson() {
    var data = currentChangesExport();
    if (!data) return;
    try {
      var objects = data.rows.map(function (row) {
        var obj = {};
        data.columns.forEach(function (c) { obj[c.name] = row[c.id] || ''; });
        return obj;
      });
      var json = JSON.stringify(objects, null, 2);
      var blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
      triggerDownload(blob, 'web-scraper-changes-' + safeHostForFilename() + '-' + Date.now() + '.json');
      setStatus(rowsLabel(data.rows.length) + ' of changes exported as JSON.', false);
    } catch (e) {
      setStatus('JSON export failed.', true);
    }
  }

  async function copyViaFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // =====================================================================
  // V1 WORKFLOW REORG — Results "Next Actions" (spec #3/#5/#6): Export /
  // Monitor / Research are reframed as DOWNSTREAM actions performed on
  // already-collected results, not unrelated top-level destinations.
  // Every handler below reuses an EXISTING function unchanged — no
  // Monitor/Research/Export logic is duplicated.
  // =====================================================================

  function handleResultsExportData() {
    toggleExportOptionsPanel(); // existing function — same as the "⚙ Export Options" chip
  }

  /** Monitor Changes: monitoring runs on a schedule against a SAVED
   * scraper's config, so if the current results came from an ad-hoc
   * configuration (no loadedScraperId — e.g. straight from an AUTO
   * extraction that was never saved), this saves it first using the
   * EXISTING handleSaveScraper() flow (same name prompt a user gets from
   * "💾 Save as New Scraper" — not a silent/surprising auto-save) before
   * navigating. If the user cancels that prompt, nothing is saved and
   * navigation is skipped, matching handleSaveScraper()'s own existing
   * cancel behavior. */
  async function handleResultsGoMonitor() {
    if (!loadedScraperId) {
      await handleSaveScraper();
      if (!loadedScraperId) return; // user cancelled the save-name prompt
    }
    switchTab('monitor');
    focusMonitoringCard(loadedScraperId);
  }

  /** Scrolls to and briefly highlights the monitoring card for
   * `scraperId` so "Monitor Changes" feels like it's continuing the same
   * task rather than dropping the user into an unrelated list (spec #5:
   * "the user should not feel like Monitor is an unrelated product").
   * A short setTimeout gives any just-triggered renderMonitoringSection()
   * (called by handleSaveScraper() above) a moment to finish painting the
   * new/updated card before it's looked up. */
  function focusMonitoringCard(scraperId) {
    if (!scraperId || !els.monitoringList) return;
    setTimeout(function () {
      var card = els.monitoringList.querySelector('[data-scraper-id="' + scraperId + '"]');
      if (!card) return;
      if (card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
      card.classList.add('ws-scraper-row-highlight');
      setTimeout(function () { card.classList.remove('ws-scraper-row-highlight'); }, 2000);
    }, 80);
  }

  /** Create Research Package: Research already operates on whatever the
   * CURRENT results are (rawRows/effective columns), not a saved-scraper
   * association, so this needs no save-first step — just switch tabs and
   * open the EXISTING research-setup-panel exactly as if the user had
   * clicked "📦 Create Research Bundle" themselves. */
  function handleResultsGoResearch() {
    switchTab('research');
    handleOpenResearchPanel(); // existing function
  }

  function handleBackToResults() {
    switchTab('results');
  }

  // =====================================================================
  // Tab Navigation (V1.13): SCRAPE / RESULTS / MONITOR / RESEARCH.
  // Deliberately presentation-only — switching tabs is nothing more than
  // toggling which existing DOM section is .hidden; it never clears
  // columns, rawRows, activeTransforms/Filter/Sort/Dedupe, monitoring
  // state, or research settings (spec #19). The tab a user was last on
  // is remembered in chrome.storage.session (spec #20 — a small, isolated
  // key, so it can never make anything else fragile) and restored the
  // next time the popup opens; if that read ever fails for any reason,
  // it simply falls back to 'scrape' rather than blocking init().
  // =====================================================================

  var TAB_NAMES = ['scrape', 'results', 'monitor', 'research'];
  var ACTIVE_TAB_SESSION_KEY = 'ws_active_tab';
  var activeTab = 'scrape';

  function switchTab(tab, opts) {
    if (TAB_NAMES.indexOf(tab) === -1) tab = 'scrape';
    activeTab = tab;
    TAB_NAMES.forEach(function (t) {
      var panel = document.getElementById('tab-panel-' + t);
      if (panel) panel.hidden = t !== tab;
      var btn = els.tabNav && els.tabNav.querySelector('.ws-tab-btn[data-tab="' + t + '"]');
      if (btn) {
        btn.classList.toggle('ws-tab-active', t === tab);
        btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      }
    });
    // V1.13.1 bugfix: unconditionally resync BOTH on every switch (not
    // just when entering their own tab) — Research and Results must
    // always reflect whatever rawRows currently holds (spec: "use the
    // existing current results state/data", never a separate source of
    // truth), regardless of which of the several rawRows-populating code
    // paths (Preview, a Saved Scraper's current-page Run, or View
    // Results after a completed Auto Scroll/Multi-page run) last ran, or
    // which tab happened to be active when it ran. This makes staleness
    // structurally impossible rather than relying on every future
    // rawRows-mutating call site remembering to call these itself.
    updateScrapeWorkflowStatus();
    updateResultsEmptyState();
    updateResearchTabState();
    if (!opts || opts.persist !== false) {
      try { sessionSet(ACTIVE_TAB_SESSION_KEY, tab); } catch (e) { /* best-effort — remembering the last tab is never allowed to break tab switching itself */ }
    }
  }

  /** V1.13.1: the Scrape tab's compact "1. Configure → 2. Run →
   * 3. Review Results" status area — always derived from state.columns/
   * rawRows (never a separate progress flag that could drift), so it's
   * automatically correct no matter how those got populated. */
  function updateScrapeWorkflowStatus() {
    if (!els.scrapeStatusText) return;
    var hasColumns = state.columns.length > 0;
    var hasResults = rawRows.length > 0;
    var step = hasResults ? 3 : (hasColumns ? 2 : 1);
    if (els.scrapeWorkflowSteps) {
      Array.prototype.forEach.call(els.scrapeWorkflowSteps.querySelectorAll('.ws-workflow-step'), function (el) {
        var s = parseInt(el.dataset.step, 10);
        el.classList.toggle('ws-workflow-step-active', s === step);
        el.classList.toggle('ws-workflow-step-done', s < step);
      });
    }
    // V1.14 spec #6: a brand-new user (no columns AND no saved scrapers
    // yet — the only combination that means "never used this extension
    // before", not just "cleared the current page's columns") gets the
    // compact 4-step walkthrough instead of just the bare 1-line prompt.
    if (els.firstRunHelp) els.firstRunHelp.hidden = hasColumns || lastKnownScraperCount > 0;
    if (!hasColumns) {
      els.scrapeStatusText.textContent = WSI18n.t('scrape.status.empty');
      els.scrapeViewResultsBtn.hidden = true;
    } else if (!hasResults) {
      els.scrapeStatusText.textContent = WSI18n.t('scrape.status.ready');
      els.scrapeViewResultsBtn.hidden = true;
    } else {
      els.scrapeStatusText.textContent = WSI18n.t('scrape.status.captured', { count: rawRows.length });
      els.scrapeViewResultsBtn.hidden = false;
    }
  }

  /** Spec #3: "No results yet. Configure and run a scraper first." plus
   * a "Go to Scrape" action, and — once there IS data — a compact
   * "N rows ready" status line. Based on rawRows (the same signal every
   * other results-dependent UI piece already uses), not on
   * preview-section's own .hidden flag — so it's correct regardless of
   * which of the several places that happens to set it last touched it. */
  function updateResultsEmptyState() {
    if (!els.resultsEmpty) return;
    var hasRows = rawRows.length > 0;
    if (els.resultsEmptyWrap) els.resultsEmptyWrap.hidden = hasRows;
    if (els.resultsStatusText) els.resultsStatusText.textContent = hasRows ? WSI18n.t('results.status.ready', { count: rawRows.length }) : '';
  }

  /** Spec #5: shows row/image-coverage status, hides the "Create
   * Research Bundle" CTA entirely (rather than showing it disabled with
   * no explanation) when there's nothing to build a bundle from yet, and
   * points back to Scrape instead of leaving the user to guess why. */
  function updateResearchTabState() {
    if (!els.researchTabEmpty) return;
    var hasRows = rawRows.length > 0;
    if (els.researchEmptyWrap) els.researchEmptyWrap.hidden = hasRows;
    els.researchBundleBtn.hidden = !hasRows;
    if (!hasRows) { els.researchStatusText.textContent = ''; return; }
    var rows = computeTransformedResult().rows;
    var columns = effectiveColumns();
    var imageCol = columns.filter(isImageLikeColumn)[0];
    var lines = [WSI18n.t('research.status.available', { count: rows.length })];
    if (imageCol) {
      var coverage = rows.length ? rows.filter(function (r) { return r[imageCol.id]; }).length / rows.length : 0;
      lines.push(WSI18n.t('research.status.imageCoverage', { percent: Math.round(coverage * 100), column: imageCol.name }));
    }
    els.researchStatusText.textContent = lines.join('\n');
  }

  // =====================================================================
  // License / Trial Foundation (V1.15): replaces V1.14's Free/Pro
  // feature-gating entirely. Every feature is available to every user —
  // this file holds no per-feature rules at all any more. The ONLY thing
  // gated is STARTING a new user-initiated scraping run once the 10-run
  // trial is used up (see guardTrialRun's call sites: handlePreview,
  // handleStartRun). A credit is charged exactly once per successfully
  // COMPLETED run — see chargeRunCredit/maybeChargeForCompletedRun —
  // never for a failed/cancelled/stopped one, and never for Monitoring
  // (background.js's runScheduledScrape never touches WSLicense at all).
  // =====================================================================

  var currentLicenseState = null; // WSLicense.loadLicenseState()'s result, refreshed at init and after every credit-affecting/license-affecting action
  var cachedAppSettings = null; // WSSettings.load()'s result, refreshed at init and whenever Settings saves a change

  async function loadLicenseState() {
    currentLicenseState = await WSLicense.loadLicenseState();
  }

  async function loadAppSettings() {
    cachedAppSettings = await WSSettings.load();
  }

  /** Re-applies every license-driven visual: the header badge, and (if
   * Settings is open) its license text/summary — called once at init and
   * again any time the license state actually changes (a credit charge,
   * or the dev switcher). */
  function applyLicenseUI() {
    if (!currentLicenseState) return;
    if (els.headerTrialBadge) {
      var isEmpty = !currentLicenseState.isLicensed && currentLicenseState.trialRunsRemaining === 0;
      els.headerTrialBadge.textContent = currentLicenseState.isLicensed
        ? WSI18n.t('header.trial.unlimited')
        : WSI18n.t('header.trial.runsLeft', { count: currentLicenseState.trialRunsRemaining });
      els.headerTrialBadge.classList.toggle('ws-trial-badge-empty', isEmpty);
    }
    if (els.settingsLicenseText) els.settingsLicenseText.textContent = currentLicenseState.isLicensed ? WSI18n.t('settings.licenseLicensed') : WSI18n.t('settings.licenseFreeTrial');
    if (els.settingsLicenseSummary) {
      els.settingsLicenseSummary.textContent = currentLicenseState.isLicensed
        ? WSI18n.t('settings.licenseSummaryLicensed')
        : WSI18n.t('settings.licenseSummaryTrial', { remaining: currentLicenseState.trialRunsRemaining, total: currentLicenseState.trialTotalRuns });
    }
    if (els.settingsUnlockBtn) els.settingsUnlockBtn.hidden = currentLicenseState.isLicensed;

    // V1.16: a small, purely-informational line about WHERE the current
    // license state came from and how fresh a server check of it is —
    // never a gating input (gating only ever reads licenseStatus/
    // hasRunsRemaining), just transparency. Silent/hidden for a plain
    // trial user (nothing to say yet).
    if (els.settingsLicenseVerificationNote) {
      var note = els.settingsLicenseVerificationNote;
      note.classList.remove('ws-license-verification-note-warn');
      if (currentLicenseState.uiStatus === 'revoked') {
        note.hidden = false;
        note.textContent = 'This license was refunded or revoked' + (currentLicenseState.lastServerCheckAt ? ' (checked ' + new Date(currentLicenseState.lastServerCheckAt).toLocaleDateString() + ')' : '') + '. Purchase again below to restore unlimited access.';
        note.classList.add('ws-license-verification-note-warn');
      } else if (currentLicenseState.isLicensed && currentLicenseState.verificationSource === 'dev-simulated') {
        note.hidden = false;
        note.textContent = 'Simulated for local development — never a real purchase.';
      } else if (currentLicenseState.isLicensed && currentLicenseState.verificationSource === 'server') {
        note.hidden = false;
        note.textContent = currentLicenseState.lastServerCheckAt
          ? 'Verified with the license server ' + currentLicenseState.daysSinceLastServerCheck + ' day' + (currentLicenseState.daysSinceLastServerCheck === 1 ? '' : 's') + ' ago.'
          : 'Verified at activation.';
      } else {
        note.hidden = true;
        note.textContent = '';
      }
    }
  }

  /**
   * V1 FINAL Bug #1 — ROOT CAUSE FIX. This is now THE single canonical
   * gate every run-triggering action (Preview / Start Run / Deep Scrape
   * Start) goes through, and it is the ONE place responsible for
   * guaranteeing the header badge and the paywall decision can never
   * contradict each other.
   *
   * ROOT CAUSE of the real-Chrome bug ("10 runs left" shown in the
   * header at the exact same moment the "Free trial complete" modal
   * opens): trialAllowsNewRun() used to read the in-memory
   * currentLicenseState directly and unconditionally. currentLicenseState
   * starts as `null` and is only populated once init()'s own
   * loadLicenseState() call resolves. If ANYTHING allowed a gated action
   * to be evaluated before that resolved — a fast click, a popup
   * reopened in an unusual way, or (see the companion fix below) any
   * later step in init() throwing and leaving state exactly as it was at
   * that moment — the OLD code took two DIFFERENT, WRONG readings of the
   * exact same "not yet loaded" (null) state:
   *   - applyLicenseUI() started with `if (!currentLicenseState) return;`
   *     — a null state left the header COMPLETELY UNTOUCHED, still
   *     showing popup.html's static placeholder text ("10 runs left").
   *   - WSLicense.hasRunsRemaining(null) evaluates
   *     `!!(null && (...))` = false — a null state was silently treated
   *     as "zero runs remaining", incorrectly blocking the action and
   *     showing "Free trial complete".
   * Two different fallback behaviors for the identical missing-state
   * case is exactly how a "10 runs left" header and a "trial complete"
   * modal could both be visible at once — neither number was ever
   * actually wrong on its own, they were just each guessing differently
   * about a state neither had actually seen yet.
   *
   * THE FIX: trialAllowsNewRun() is now async and, if currentLicenseState
   * is missing, ALWAYS resolves it fresh from storage FIRST — and
   * refreshes the header via applyLicenseUI() in that exact same step —
   * before making or reporting any gating decision. There is no longer
   * any code path where the gating decision and the header can be based
   * on two different snapshots of state: they are now always the same
   * freshly-resolved value, read together, in one place.
   */
  async function trialAllowsNewRun() {
    if (!currentLicenseState) {
      currentLicenseState = await WSLicense.loadLicenseState();
      applyLicenseUI();
    }
    return WSLicense.hasRunsRemaining(currentLicenseState);
  }

  /** V1.16: two distinct reasons a new run can be blocked — the original
   * V1.15 "used up your 10 free runs" case (copy UNCHANGED, verbatim)
   * and the new "your license was revoked/refunded" case, which needs
   * different, honest wording (spec #7 "refunded/revoked license"). Both
   * reuse the exact same modal DOM/buttons — there is still only ever
   * ONE modal, just two possible messages depending on WHY. */
  function showTrialCompleteModal() {
    if (currentLicenseState && currentLicenseState.uiStatus === 'revoked') {
      els.trialModalTitle.textContent = WSI18n.t('trialModal.revokedTitle');
      els.trialModalBody.textContent = WSI18n.t('trialModal.revokedBody');
    } else {
      els.trialModalTitle.textContent = WSI18n.t('trialModal.title');
      els.trialModalBody.textContent = WSI18n.t('trialModal.body', { count: currentLicenseState ? currentLicenseState.trialTotalRuns : WSLicense.TRIAL_TOTAL_RUNS });
    }
    els.trialModalOverlay.hidden = false;
  }

  function hideTrialModal() {
    els.trialModalOverlay.hidden = true;
  }

  /** The one place a successful run's credit is actually consumed —
   * called only after a scrape is already known to have completed
   * successfully (see handlePreview / maybeChargeForCompletedRun).
   * Idempotent by runId (WSLicense.consumeRunCredit), so it's always
   * safe to call even if the same completion could theoretically be
   * observed twice. Refreshes currentLicenseState + the header badge
   * immediately afterward so "N runs left" is never stale. */
  async function chargeRunCredit(runId) {
    var result = await WSLicense.consumeRunCredit(runId);
    currentLicenseState = await WSLicense.loadLicenseState();
    applyLicenseUI();
    return result;
  }

  /** The "Unlock Unlimited — $5" CTA (both the modal's and Settings').
   * V1.15/V1.16 deliberately ship NO real payment flow —
   * WSLicense.activateLicense() is a stub that can never succeed yet (see
   * its own header comment: no fake payment verification). The failure
   * path just surfaces that honestly rather than silently doing nothing
   * or pretending to unlock anything. The success branch below is
   * unreachable today (activateLicense() always resolves ok:false) but is
   * real, working code — V1.16 spec #7's "activation success" state —
   * ready for the moment a real checkout+activation call actually
   * succeeds, with no other file needing to change. */
  async function handleUnlockPurchaseClick() {
    var res = await WSLicense.activateLicense();
    if (!res.ok) {
      setStatus(res.error || WSI18n.t('msg.purchaseNotAvailable'), true);
      return;
    }
    hideTrialModal();
    currentLicenseState = await WSLicense.loadLicenseState();
    applyLicenseUI();
    setStatus(WSI18n.t('msg.purchaseSuccess'), false, 'success');
  }

  // ---- Settings panel ----

  /** V1 FINAL PART B spec #7 — populates the language <select> with one
   * option per WSI18n.SUPPORTED locale (native name — never translated,
   * spec #7 "display native names") plus an "Auto (follow browser)"
   * option, and marks whichever is currently active. Safe to call every
   * time Settings opens (idempotent, cheap, no storage/network work). */
  function renderLanguageSelector() {
    if (!els.settingsLanguageSelect) return;
    var current = WSI18n.getCurrentLanguage();
    var sel = els.settingsLanguageSelect;
    sel.innerHTML = '';
    var autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = WSI18n.t('settings.languageAuto');
    sel.appendChild(autoOpt);
    WSI18n.supportedLocales().forEach(function (code) {
      var opt = document.createElement('option');
      opt.value = code;
      opt.textContent = WSI18n.nativeName(code);
      sel.appendChild(opt);
    });
    // Reflect the ACTUAL stored preference (not just the resolved
    // language) so "Auto" stays shown as selected for a user who has
    // never explicitly chosen a language, even though `current` above is
    // the browser-detected concrete code.
    WSSettings.load().then(function (settings) {
      sel.value = (settings && settings.language) || 'auto';
    });
  }

  /** Explicit selection always wins from here on (spec #6) — persists via
   * WSSettings, switches WSI18n's in-memory language, and re-renders
   * every `[data-i18n]` node plus every JS-driven dynamic string
   * currently on screen. Pure relabeling: never touches scraper config,
   * results, trial/license state, or triggers any scrape/network work
   * (spec #26/#37). */
  async function handleLanguageChange() {
    var code = els.settingsLanguageSelect && els.settingsLanguageSelect.value;
    if (!code) return;
    if (code === 'auto') {
      await WSSettings.setLanguage('auto');
      var detected = await WSI18n.resolveLanguage();
      await WSI18n.setLanguage(detected);
      // setLanguage() above re-persists 'detected' as an explicit value —
      // immediately overwrite back to 'auto' so future sessions keep
      // following the browser rather than getting pinned to today's
      // detected language.
      await WSSettings.setLanguage('auto');
    } else {
      await WSI18n.setLanguage(code);
    }
    WSI18n.applyToDom(document);
    applyLicenseUI(); // header badge / settings license text are JS-driven, not [data-i18n]
    updateAutoExtractButtonState(); // the live item-count label is also JS-driven, not [data-i18n]
    renderLanguageSelector();
  }

  async function handleOpenSettings() {
    els.tabNav.hidden = true;
    els.mainContent.hidden = true;
    els.settingsPanel.hidden = false;
    applyLicenseUI();
    renderLanguageSelector();
    if (els.settingsVersionText) els.settingsVersionText.textContent = (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '');

    var settings = await WSSettings.load();
    var d = settings.researchFormatDefaults;
    if (els.settingsRbCsv) els.settingsRbCsv.checked = !!d.includeCsv;
    if (els.settingsRbXlsx) els.settingsRbXlsx.checked = d.includeXlsx !== false;
    if (els.settingsRbJson) els.settingsRbJson.checked = d.includeJson !== false;
    if (els.settingsRbImages) els.settingsRbImages.checked = d.includeImages !== false;
    if (els.settingsRbFiles) els.settingsRbFiles.checked = !!d.includeFiles;

    if (els.settingsDevSwitcher) {
      var isDev = await WSLicense.isDevelopmentInstall();
      els.settingsDevSwitcher.hidden = !isDev;
      if (isDev) {
        var radio = document.querySelector('input[name="settings-dev-license"][value="' + currentLicenseState.licenseStatus + '"]');
        if (radio) radio.checked = true;
      }
    }
  }

  function handleCloseSettings() {
    els.settingsPanel.hidden = true;
    els.tabNav.hidden = false;
    els.mainContent.hidden = false;
    if (els.settingsRecoverPanel) handleCloseRecoverPanel();
  }

  /** DEV ONLY license switch — see WSLicense.activateDevLicense's/
   * isDevelopmentInstall's own comments for why the surrounding radio
   * group is only ever shown at all when chrome.management.getSelf()
   * reports an unpacked/sideloaded install. Never touches any scraper/
   * snapshot/monitoring/history data — switching license state only
   * changes whether a NEW run can start. */
  async function handleDevLicenseSwitch(mode) {
    if (mode === 'licensed') await WSLicense.activateDevLicense();
    else if (mode === 'revoked') await WSLicense.simulateRevokedDev();
    else await WSLicense.resetToTrialDev();
    currentLicenseState = await WSLicense.loadLicenseState();
    applyLicenseUI();
    setStatus('Development license switched to ' + mode.toUpperCase() + '.', false, 'success');
  }

  /** V1 FINAL PART C (spec #27-32) — DEV ONLY. Jumps trialRunsUsed to an
   * exact value for manual QA of the real 10-free-runs -> paywall flow.
   * The click listeners for these buttons are only ever attached (see
   * init() below) — same reachability guarantee as handleDevLicenseSwitch
   * above: the button DOM itself lives inside #settings-dev-switcher,
   * which handleOpenSettings() only ever unhides after a real
   * isDevelopmentInstall() check resolves true. `runsUsed` is read
   * straight from the clicked button's own data-qa-runs attribute (set
   * in popup.html — STATE A=0, B=1, C=9, D=10) rather than hardcoded
   * here twice, so the HTML stays the single source of truth for which
   * button means which count. */
  async function handleQaSetTrialRunsUsed(runsUsed) {
    await WSLicense.setTrialRunsUsedDev(runsUsed);
    currentLicenseState = await WSLicense.loadLicenseState();
    applyLicenseUI();
    var radio = document.querySelector('input[name="settings-dev-license"][value="trial"]');
    if (radio) radio.checked = true;
    setStatus('QA: trial runs used set to ' + runsUsed + ' (' + (WSLicense.TRIAL_TOTAL_RUNS - runsUsed) + ' remaining).', false, 'success');
  }

  /** V1 FINAL PART C spec #27 "STATE E" + spec #35 — DEV ONLY simulation
   * of a successful purchase (PAYMENT_SUCCESS -> isUnlocked=true), so the
   * unlocked-user UI/scraping behavior can be exercised before/while a
   * real payment integration exists. Reuses activateDevLicense() exactly
   * (same function the pre-existing Licensed(DEV) radio already calls) —
   * this is NOT a second, parallel unlock mechanism, just a second UI
   * entry point to the one that already existed, for discoverability
   * next to the other QA trial-state buttons. NEVER reachable outside
   * the same isDevelopmentInstall()-gated container as everything else
   * here — this is explicitly NOT the real payment system (spec #35/#36:
   * "DO NOT USE QA PAYMENT SIMULATION AS THE REAL PAYMENT SYSTEM"). */
  async function handleQaSimulateUnlock() {
    await WSLicense.activateDevLicense();
    currentLicenseState = await WSLicense.loadLicenseState();
    applyLicenseUI();
    var radio = document.querySelector('input[name="settings-dev-license"][value="licensed"]');
    if (radio) radio.checked = true;
    setStatus('QA: simulated PAYMENT_SUCCESS — unlimited unlocked (dev-only, not a real purchase).', false, 'success');
  }

  /** V1 FINAL PART C spec #27 "RESET QA TRIAL STATE" — DEV ONLY. Reuses
   * resetToTrialDev() exactly (same function the pre-existing Trial radio
   * already calls) — returns to completedRuns=0/runsRemaining=10/
   * isUnlocked=false, ready to start a clean manual 10-run test. */
  async function handleQaResetTrialState() {
    await WSLicense.resetToTrialDev();
    currentLicenseState = await WSLicense.loadLicenseState();
    applyLicenseUI();
    var radio = document.querySelector('input[name="settings-dev-license"][value="trial"]');
    if (radio) radio.checked = true;
    setStatus('QA: trial state reset to clean (0 used, 10 remaining, not unlocked).', false, 'success');
  }

  // ---- V1.16: license recovery UI (spec #7) ----

  function handleOpenRecoverPanel() {
    els.settingsRecoverPanel.hidden = false;
    if (els.settingsRecoverEmail) els.settingsRecoverEmail.focus();
  }

  function handleCloseRecoverPanel() {
    els.settingsRecoverPanel.hidden = true;
    if (els.settingsRecoverEmail) els.settingsRecoverEmail.value = '';
  }

  /** Same honest-stub pattern as handleUnlockPurchaseClick — never fakes
   * a match, never grants access. See utils/license.js's recoverLicense()
   * for the real request/response shape a future backend will use. */
  async function handleSubmitRecover() {
    var email = (els.settingsRecoverEmail && els.settingsRecoverEmail.value || '').trim();
    if (!email) { setStatus(WSI18n.t('msg.enterRecoveryEmail'), true); return; }
    var res = await WSLicense.recoverLicense(email);
    if (!res.ok) {
      setStatus(res.error || WSI18n.t('msg.recoveryNotAvailable'), true);
      return;
    }
    // Unreachable today (recoverLicense() always fails closed) — this is
    // where a real recovered licenseKey would be fed into
    // WSLicense.activateLicense() and the success path below would run.
    handleCloseRecoverPanel();
    currentLicenseState = await WSLicense.loadLicenseState();
    applyLicenseUI();
    setStatus(WSI18n.t('msg.recoverySuccess'), false, 'success');
  }

  async function handleSettingsResearchDefaultsChange() {
    var res = await WSSettings.setResearchFormatDefaults({
      includeCsv: els.settingsRbCsv.checked, includeXlsx: els.settingsRbXlsx.checked, includeJson: els.settingsRbJson.checked,
      includeImages: els.settingsRbImages.checked, includeFiles: els.settingsRbFiles.checked
    });
    if (res && res.ok) cachedAppSettings = res.settings;
  }

  // =====================================================================
  // V1.18 Deep Scraping: follows a Link column from an already-scraped
  // list page out to each detail page and merges back a small set of
  // configured fields — see background.js's own section header comment
  // for the full fetch()+tab-extraction architecture. This section is
  // ONLY the popup-side config UI, sample test, progress display, and
  // (the one piece that genuinely belongs here, not in background.js)
  // the URL<->row MERGE, since only the popup holds rawRows in memory.
  // =====================================================================

  var deepScrapeConfig = null; // {enabled, sourceColumnId, fields, concurrency, delayMode, customDelayMs} — mirrors loadedScraperResearch's pattern
  var deepScrapeColumns = []; // [{id, name, sourceFieldId}] — merged INTO effectiveColumns() via computeTransformedResult(), see above; state.columns itself is never touched
  var deepScrapeEditingFieldId = null; // non-null while ds-add-field-form is editing an EXISTING field rather than adding a new one
  var currentDeepScrapeRunId = null;
  var deepScrapeStorageListenerAttached = false;

  function dsSourceColumnCandidates() {
    // Any 'href'-typed OR structured URL-kind column is a valid Deep
    // Scraping source — not just ones literally named "Link" (spec's
    // general-purpose requirement: jobs/houses/articles/directories all
    // just need SOME link column; V1.21 extends this to a structured
    // "url"-kind field, e.g. a JSON-LD Product.url).
    return effectiveColumns().filter(isLinkLikeColumn);
  }

  function renderDeepScrapePanel() {
    if (!deepScrapeConfig) deepScrapeConfig = WSRecipes.emptyDeepScrape();
    if (!els.dsEnabled) return;
    els.dsEnabled.checked = !!deepScrapeConfig.enabled;
    els.dsConfigBody.hidden = !deepScrapeConfig.enabled;

    var candidates = dsSourceColumnCandidates();
    els.dsSourceColumn.innerHTML = '';
    if (!candidates.length) {
      var opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = '(no Link column in Results yet)';
      els.dsSourceColumn.appendChild(opt0);
    } else {
      candidates.forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        if (c.id === deepScrapeConfig.sourceColumnId) opt.selected = true;
        els.dsSourceColumn.appendChild(opt);
      });
      if (!candidates.some(function (c) { return c.id === deepScrapeConfig.sourceColumnId; })) {
        deepScrapeConfig.sourceColumnId = candidates[0].id;
      }
    }

    els.dsConcurrency.value = String(deepScrapeConfig.concurrency || 4);
    els.dsDelayMode.value = deepScrapeConfig.delayMode || 'auto';
    els.dsCustomDelayRow.hidden = deepScrapeConfig.delayMode !== 'custom';
    if (deepScrapeConfig.customDelayMs != null) els.dsCustomDelay.value = String(deepScrapeConfig.customDelayMs);
    if (els.dsRetryLimit) els.dsRetryLimit.value = String(deepScrapeConfig.retryLimit || 3);

    renderDeepScrapeFieldsList();
    updateDsWorkloadSummary();
  }

  function renderDeepScrapeFieldsList() {
    els.dsFieldsList.innerHTML = '';
    var fields = deepScrapeConfig.fields || [];
    els.dsFieldsEmpty.hidden = fields.length > 0;
    fields.forEach(function (f) {
      var li = document.createElement('li');
      li.className = 'ws-column-row';
      var nameEl = document.createElement('span');
      nameEl.className = 'ws-column-name';
      nameEl.style.cssText = 'flex:1;padding:4px 0;';
      nameEl.textContent = f.name;
      var tag = document.createElement('span');
      tag.className = 'ws-column-tag';
      tag.textContent = attrLabel(f.attribute) + (f.multiple === 'all' ? ' (all)' : '');
      var delBtn = document.createElement('button');
      delBtn.className = 'ws-column-delete';
      delBtn.textContent = '×';
      delBtn.title = 'Delete field'; delBtn.setAttribute('aria-label', 'Delete field');
      delBtn.addEventListener('click', function () {
        deepScrapeConfig.fields = deepScrapeConfig.fields.filter(function (x) { return x.id !== f.id; });
        renderDeepScrapeFieldsList();
        updateDsWorkloadSummary();
      });
      li.appendChild(nameEl);
      li.appendChild(tag);
      li.appendChild(delBtn);
      els.dsFieldsList.appendChild(li);
    });
  }

  /** spec #5/#7: dedupes detail URLs from the source column's raw values
   * (already-resolved absolute URLs for an href column — see
   * WSSelector.hrefFromAnchor/resolveUrl, unchanged since V1.1/V1.9),
   * rejecting anything WSDownloads.validateDownloadUrl wouldn't accept as
   * a genuine http(s) destination (reused verbatim — the exact same
   * scheme/shape validation V1.5's Bulk Download already relies on). */
  function computeUniqueDetailUrls() {
    if (!deepScrapeConfig || !deepScrapeConfig.sourceColumnId) return { urls: [], totalRows: 0 };
    var seen = Object.create(null);
    var urls = [];
    var totalRows = 0;
    rawRows.forEach(function (row) {
      var raw = row[deepScrapeConfig.sourceColumnId];
      if (!raw) return;
      totalRows++;
      var validation = WSDownloads.validateDownloadUrl(raw);
      if (!validation.ok || validation.scheme === 'data') return; // a detail page must be a real http(s) destination
      if (!seen[raw]) { seen[raw] = true; urls.push(raw); }
    });
    return { urls: urls, totalRows: totalRows };
  }

  function updateDsWorkloadSummary() {
    if (!els.dsWorkloadSummary) return;
    var info = computeUniqueDetailUrls();
    var fieldCount = (deepScrapeConfig.fields || []).length;
    // spec #21: neutral, honest numbers — never a fake precise time estimate.
    els.dsWorkloadSummary.textContent = 'Rows: ' + rawRows.length + '  •  Unique detail URLs: ' + info.urls.length +
      '  •  Detail fields: ' + fieldCount + '  •  Estimated requests: ' + info.urls.length;
  }

  function handleToggleDeepScrapePanel() {
    els.deepScrapePanel.hidden = !els.deepScrapePanel.hidden;
    if (!els.deepScrapePanel.hidden) renderDeepScrapePanel();
  }

  function handleDsEnabledChange() {
    deepScrapeConfig.enabled = els.dsEnabled.checked;
    els.dsConfigBody.hidden = !deepScrapeConfig.enabled;
    if (deepScrapeConfig.enabled) updateDsWorkloadSummary();
  }

  function handleDsSourceColumnChange() {
    deepScrapeConfig.sourceColumnId = els.dsSourceColumn.value || null;
    updateDsWorkloadSummary();
  }

  function handleDsConcurrencyChange() {
    deepScrapeConfig.concurrency = parseInt(els.dsConcurrency.value, 10) || 4;
  }
  /** V1.20: spec "Configurable retry limits" — previously a fixed
   * background.js constant (3 attempts). */
  function handleDsRetryLimitChange() {
    deepScrapeConfig.retryLimit = parseInt(els.dsRetryLimit.value, 10) || 3;
  }
  function handleDsDelayModeChange() {
    deepScrapeConfig.delayMode = els.dsDelayMode.value === 'custom' ? 'custom' : 'auto';
    els.dsCustomDelayRow.hidden = deepScrapeConfig.delayMode !== 'custom';
  }
  function handleDsCustomDelayChange() {
    deepScrapeConfig.customDelayMs = Math.max(0, parseInt(els.dsCustomDelay.value, 10) || 0);
  }

  function handleDsFieldAttributeChange() {
    els.dsFieldAttrNameRow.hidden = els.dsFieldAttribute.value !== 'attr';
  }

  function handleDsAddFieldClick() {
    deepScrapeEditingFieldId = null;
    els.dsFieldName.value = '';
    els.dsFieldSelector.value = '';
    els.dsFieldAttribute.value = 'text';
    els.dsFieldAttrName.value = '';
    els.dsFieldMultiple.checked = false;
    els.dsFieldAttrNameRow.hidden = true;
    els.dsAddFieldForm.hidden = false;
    els.dsFieldName.focus();
  }

  function handleDsFieldCancelClick() {
    els.dsAddFieldForm.hidden = true;
    deepScrapeEditingFieldId = null;
  }

  function handleDsFieldSaveClick() {
    var name = els.dsFieldName.value.trim();
    var selector = els.dsFieldSelector.value.trim();
    if (!name || !selector) { setStatus('Enter both a field name and a selector.', true); return; }
    var field = {
      id: deepScrapeEditingFieldId || WSStorage.makeColumnId(),
      name: name,
      relativeSelector: selector,
      attribute: els.dsFieldAttribute.value,
      multiple: els.dsFieldMultiple.checked ? 'all' : 'first'
    };
    if (field.attribute === 'attr') field.attributeName = els.dsFieldAttrName.value.trim();
    if (deepScrapeEditingFieldId) {
      deepScrapeConfig.fields = deepScrapeConfig.fields.map(function (f) { return f.id === deepScrapeEditingFieldId ? field : f; });
    } else {
      deepScrapeConfig.fields = (deepScrapeConfig.fields || []).concat([field]);
    }
    els.dsAddFieldForm.hidden = true;
    deepScrapeEditingFieldId = null;
    renderDeepScrapeFieldsList();
    updateDsWorkloadSummary();
  }

  /** spec #3: reuses the V1.17 Element Picker verbatim, just pointed at a
   * SAMPLE detail page opened in its own real (active — the user needs
   * to interact with it) tab, with purpose:'detail-field' so picks stage
   * into chrome.storage.session (ws_detail_field_picks::<hostname>)
   * instead of this page's own ws_state — see content/content.js's
   * handlePicked. checkForPendingDetailFieldPicks() (called from init())
   * picks the staged fields up the next time the popup reopens on THIS
   * (the list) page. */
  async function handleDsPickFieldsClick() {
    var info = computeUniqueDetailUrls();
    if (!info.urls.length) { setStatus('No detail URLs available yet — run Preview first.', true); return; }
    var sampleUrl = info.urls[0];
    try {
      var tab = await new Promise(function (resolve, reject) {
        chrome.tabs.create({ url: sampleUrl, active: true }, function (t) {
          if (chrome.runtime.lastError || !t) reject(new Error('Could not open the sample page.'));
          else resolve(t);
        });
      });
      await new Promise(function (r) { setTimeout(r, 400); }); // let the new tab's content script have a moment to inject/settle
      await chrome.tabs.sendMessage(tab.id, { type: 'START_PICK', purpose: 'detail-field', targetHostname: hostname });
      setStatus('Pick fields on the sample page that just opened, then come back to this popup.', false);
    } catch (e) {
      setStatus("Couldn't open the sample page for picking.", true);
    }
  }

  /** Mirrors checkForPendingNextButtonPick()'s exact recovery pattern
   * (V1.3) — called once at init(). Any fields staged by a detail-page
   * pick since the popup last closed are merged into deepScrapeConfig
   * (never overwriting fields already added another way) and the
   * staging key is cleared (consumed exactly once). */
  async function checkForPendingDetailFieldPicks() {
    var key = 'ws_detail_field_picks::' + hostname;
    var staged = await sessionGet(key);
    if (!staged || !staged.length) return;
    if (!deepScrapeConfig) deepScrapeConfig = WSRecipes.emptyDeepScrape();
    var existingIds = (deepScrapeConfig.fields || []).map(function (f) { return f.id; });
    var newOnes = staged.filter(function (f) { return existingIds.indexOf(f.id) === -1; });
    deepScrapeConfig.fields = (deepScrapeConfig.fields || []).concat(newOnes);
    await sessionSet(key, null);
    if (newOnes.length) {
      deepScrapeConfig.enabled = true;
      els.deepScrapePanel.hidden = false;
      renderDeepScrapePanel();
      setStatus(newOnes.length + ' detail field' + (newOnes.length === 1 ? '' : 's') + ' added from the sample page.', false, 'success');
    }
  }

  /** spec #4/#20: tests up to 3 sample detail pages BEFORE committing to
   * a full run — reuses the exact same validate-then-extract pipeline
   * the real run uses (background.js's TEST_DEEP_SCRAPE_SAMPLE handler
   * calls the SAME validateDetailUrl/extractDetailFields functions,
   * just without the retry/queue/session-tracking machinery a real run
   * needs), so a broken selector is caught here, not 400 requests later. */
  async function handleDsTestClick() {
    if (!deepScrapeConfig.fields || !deepScrapeConfig.fields.length) { setStatus('Add at least one detail field first.', true); return; }
    var info = computeUniqueDetailUrls();
    if (!info.urls.length) { setStatus('No detail URLs available — run Preview first.', true); return; }
    var sampleUrls = info.urls.slice(0, 3);

    var originPatterns = WSDownloads.uniqueOriginPatterns(sampleUrls);
    if (originPatterns.length) {
      var granted = false;
      try { granted = await chrome.permissions.request({ origins: originPatterns }); } catch (e) { granted = false; }
      if (!granted) { setStatus('Permission was declined — Deep Scraping needs access to the detail pages’ site(s).', true); return; }
    }

    els.dsTestResults.hidden = false;
    els.dsTestResults.textContent = 'Testing ' + sampleUrls.length + ' page' + (sampleUrls.length === 1 ? '' : 's') + '…';
    var res;
    try {
      res = await sendToBackground({ type: 'TEST_DEEP_SCRAPE_SAMPLE', urls: sampleUrls, fields: deepScrapeConfig.fields });
    } catch (e) {
      els.dsTestResults.textContent = "Couldn't reach the background service to run the test.";
      return;
    }
    if (!res || !res.ok) { els.dsTestResults.textContent = 'Test failed to run.'; return; }

    var lines = [];
    sampleUrls.forEach(function (url, i) {
      var r = res.results[url];
      lines.push('Page ' + (i + 1) + ':');
      if (!r || r.status === 'failed') {
        lines.push('  Failed' + (r && r.error ? ' — ' + r.error : ''));
        return;
      }
      deepScrapeConfig.fields.forEach(function (f) {
        var val = r.fields ? r.fields[f.id] : undefined;
        var display = Array.isArray(val) ? (val.length ? val.join('; ') : null) : (val || null);
        lines.push('  ' + f.name + ': ' + (display ? '✓ ' + String(display).slice(0, 60) : 'Missing'));
      });
    });
    els.dsTestResults.textContent = lines.join('\n');
  }

  function makeDeepScrapeRunId() {
    return 'ds_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /** spec #33: Deep Scraping is gated + charged exactly like any other
   * user-initiated scraping run (Preview/Start Run) — ONE credit for the
   * whole operation, charged only once it reaches 'completed' (never per
   * detail page, never for a 'stopped'/'error' run) — see
   * renderDeepScrapeProgress's terminal-status handling below, the exact
   * same pattern maybeChargeForCompletedRun already uses for Auto Scroll/
   * Multi-page runs. */
  async function handleDsStartClick() {
    if (!deepScrapeConfig.fields || !deepScrapeConfig.fields.length) { setStatus('Add at least one detail field first.', true); return; }
    if (!deepScrapeConfig.sourceColumnId) { setStatus('Choose a Link column to follow first.', true); return; }
    if (!(await trialAllowsNewRun())) { showTrialCompleteModal(); return; }

    var info = computeUniqueDetailUrls();
    if (!info.urls.length) { setStatus('No detail URLs to visit.', true); return; }

    var originPatterns = WSDownloads.uniqueOriginPatterns(info.urls);
    if (originPatterns.length) {
      var granted = false;
      try { granted = await chrome.permissions.request({ origins: originPatterns }); } catch (e) { granted = false; }
      if (!granted) { setStatus('Permission was declined — Deep Scraping needs access to the detail pages’ site(s).', true); return; }
    }

    currentDeepScrapeRunId = makeDeepScrapeRunId();
    attachDeepScrapeStorageListener();
    els.dsProgressSection.hidden = false;
    els.dsSummaryText.hidden = true;
    els.deepScrapePanel.hidden = true;

    await sendToBackground({
      type: 'START_DEEP_SCRAPE', runId: currentDeepScrapeRunId, urls: info.urls, fields: deepScrapeConfig.fields,
      concurrency: deepScrapeConfig.concurrency || 4, delayMode: deepScrapeConfig.delayMode || 'auto',
      customDelayMs: deepScrapeConfig.customDelayMs, originPatterns: originPatterns,
      retryLimit: deepScrapeConfig.retryLimit || 3
    });
  }

  async function handleDsStopClick() {
    if (!currentDeepScrapeRunId) return;
    await sendToBackground({ type: 'STOP_DEEP_SCRAPE', runId: currentDeepScrapeRunId });
  }

  /** V1.20 — spec #10: retry only the failed detail pages of the run
   * that just finished, without restarting the whole operation. Reuses
   * the SAME currentDeepScrapeRunId/storage listener the original run
   * used — background.js's retryFailedDeepScrapeItems writes back to
   * the exact same ws_deepscrape_run key/runId, so this popup keeps
   * watching it exactly as it already does for the initial run (no new
   * listener, no new trial charge — see maybeChargeForCompletedRun's own
   * runId-idempotent gate, unaffected here since this is the SAME runId). */
  async function handleDsRetryFailedClick() {
    if (!currentDeepScrapeRunId) return;
    els.dsSummaryText.hidden = true;
    await sendToBackground({ type: 'RETRY_FAILED_DEEP_SCRAPE_ITEMS', runId: currentDeepScrapeRunId });
  }

  var deepScrapeChargedRunIds = Object.create(null); // in-memory guard, belt-and-suspenders alongside WSLicense's own ledger

  function renderDeepScrapeProgress(dsState) {
    if (!dsState || dsState.runId !== currentDeepScrapeRunId) return;
    els.dsProgressSection.hidden = false;
    var isTerminal = ['completed', 'stopped', 'error'].indexOf(dsState.status) !== -1;
    els.dsProgressBadge.textContent = dsState.status.toUpperCase();
    els.dsProgressBadge.className = 'ws-status-badge ws-status-' + dsState.status;
    var c = dsState.counts || {};
    var done = (c.completed || 0) + (c.partial || 0) + (c.failed || 0) + (c.skipped || 0);
    var pct = c.total ? Math.round((done / c.total) * 100) : 0;
    els.dsProgressText.textContent = done + ' / ' + (c.total || 0) + ' pages  •  Completed: ' + (c.completed || 0) +
      '  •  Failed: ' + (c.failed || 0) + '  •  Remaining: ' + Math.max(0, (c.total || 0) - done) + '  •  Progress: ' + pct + '%';
    els.dsProgressCurrent.textContent = dsState.currentUrl ? 'Current: ' + dsState.currentUrl : '';
    els.dsStopBtn.hidden = isTerminal;

    // V1.20: user-visible retry status for whichever URL is currently
    // in-flight (never affects control flow — purely informational).
    var currentRecord = dsState.currentUrl && dsState.results ? dsState.results[dsState.currentUrl] : null;
    var retryStatus = currentRecord && currentRecord.retryStatus;
    if (els.dsRetryStatus) {
      els.dsRetryStatus.hidden = !retryStatus;
      els.dsRetryStatus.textContent = retryStatus || '';
    }

    if (dsState.status === 'error' && dsState.error) {
      setStatus(dsState.error, true);
    }

    if (isTerminal) {
      mergeDeepScrapeResults(dsState);
      renderDeepScrapeSummary(dsState);
      // V1.20: only ever offered once the run has actually settled, and
      // only when there's real work for it to do — never restarts
      // already-successful pages.
      if (els.dsRetryFailedBtn) els.dsRetryFailedBtn.hidden = !(c.failed > 0);
      if (dsState.status === 'completed' && !deepScrapeChargedRunIds[dsState.runId]) {
        deepScrapeChargedRunIds[dsState.runId] = true;
        chargeRunCredit(dsState.runId);
      }
    } else if (els.dsRetryFailedBtn) {
      els.dsRetryFailedBtn.hidden = true;
    }
  }

  /** spec #34: a compact, honest completion summary — real counts and
   * the most common failure REASONS (tallied from each result's own
   * error string), never a raw stack trace surfaced to the user. */
  function renderDeepScrapeSummary(dsState) {
    var c = dsState.counts || {};
    var reasonCounts = {};
    Object.keys(dsState.results || {}).forEach(function (url) {
      var r = dsState.results[url];
      if (r.status === 'failed' && r.error) reasonCounts[r.error] = (reasonCounts[r.error] || 0) + 1;
    });
    var topReasons = Object.keys(reasonCounts).sort(function (a, b) { return reasonCounts[b] - reasonCounts[a]; }).slice(0, 3);

    var lines = [];
    lines.push(dsState.status === 'stopped' ? 'Stopped' : dsState.status === 'error' ? 'Deep Scrape could not start' : 'DEEP SCRAPE COMPLETE');
    lines.push((c.total || 0) + ' unique pages');
    lines.push('Completed: ' + (c.completed || 0) + '   Partial: ' + (c.partial || 0) + '   Failed: ' + (c.failed || 0) + (c.skipped ? '   Skipped: ' + c.skipped : ''));
    if (topReasons.length) {
      lines.push('');
      lines.push('Main failure reasons:');
      topReasons.forEach(function (reason) { lines.push('  ' + reasonCounts[reason] + ' × ' + reason); });
    }
    els.dsSummaryText.hidden = false;
    els.dsSummaryText.textContent = lines.join('\n');
  }

  /** spec #14/#15: merges detail-page field values back into rawRows by
   * URL lookup — NEVER by row position — so a failed/skipped row for one
   * URL can never shift another row's data. Column NAME collisions with
   * an EXISTING column are resolved deterministically with a "(detail)"
   * suffix (spec's own example: price / detail_price). Multi-value
   * ('multiple:"all"') fields are joined into one delimited string here
   * (a deliberate, documented simplification — see the V1.18 roadmap
   * notes — that keeps every existing Transform/Filter/Sort/CSV/Excel/
   * JSON/Copy code path completely unaware anything changed, since every
   * merged value is still just a plain string like any other column). */
  function mergeDeepScrapeResults(dsState) {
    if (!deepScrapeConfig || !deepScrapeConfig.sourceColumnId || !dsState || !dsState.results) return;
    var sourceColId = deepScrapeConfig.sourceColumnId;
    var existingNames = {};
    state.columns.forEach(function (c) { existingNames[c.name.trim().toLowerCase()] = true; });

    deepScrapeColumns = (deepScrapeConfig.fields || []).map(function (f) {
      var name = f.name;
      if (existingNames[name.trim().toLowerCase()]) {
        var n = 2;
        var candidate = name + ' (detail)';
        while (existingNames[candidate.trim().toLowerCase()]) { candidate = name + ' (detail ' + n + ')'; n++; }
        name = candidate;
      }
      existingNames[name.trim().toLowerCase()] = true;
      return { id: 'ds_' + f.id, name: name, sourceFieldId: f.id };
    });

    rawRows.forEach(function (row) {
      var url = row[sourceColId];
      var record = url ? dsState.results[url] : null;
      var hasData = record && (record.status === 'completed' || record.status === 'partial') && record.fields;
      deepScrapeColumns.forEach(function (dsCol) {
        if (!hasData) { row[dsCol.id] = ''; return; }
        var raw = record.fields[dsCol.sourceFieldId];
        row[dsCol.id] = Array.isArray(raw) ? raw.join('; ') : (raw || '');
      });
    });

    invalidateTransformCache();
    renderResults();
  }

  function attachDeepScrapeStorageListener() {
    if (deepScrapeStorageListenerAttached) return;
    deepScrapeStorageListenerAttached = true;
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'session' || !changes['ws_deepscrape_run']) return;
      renderDeepScrapeProgress(changes['ws_deepscrape_run'].newValue);
    });
  }

  // =====================================================================
  // Init
  // =====================================================================

  async function init() {
    // V1 FINAL Bug #1 (part 2) — "Maybe Later" wiring is moved here,
    // FIRST, synchronously, before any await in init(). Previously it
    // was wired ~300 lines / a dozen awaits into init()'s own sequential
    // body — if ANY earlier step in that long chain (Saved Scrapers
    // rendering, Monitoring rendering, Deep Scrape run restoration, any
    // of the many other listener-wiring calls before it) ever threw an
    // uncaught error, every listener still to be attached AFTER that
    // point — including the trial modal's own dismiss button — would
    // simply never be wired at all, exactly matching the reported "Maybe
    // Later does nothing, the modal remains open" symptom regardless of
    // what upstream code actually failed. Wiring this first, before
    // anything that could plausibly throw, makes the dismiss button
    // structurally guaranteed to always work.
    if (els.trialModalDismissBtn) els.trialModalDismissBtn.addEventListener('click', hideTrialModal);
    if (els.trialModalOverlay) {
      els.trialModalOverlay.addEventListener('click', function (e) { if (e.target === els.trialModalOverlay) hideTrialModal(); });
    }

    // V1 FINAL PART B spec #6/#7 — resolve and apply the popup's language
    // before the user can interact with anything, so the very first frame
    // is already in the right language (never a flash of English before
    // switching). Started here, in PARALLEL with the chrome.tabs.query
    // call right below (both are independent, side-effect-free reads —
    // one from chrome.storage, one from the active tab) rather than
    // sequentially before it, so this adds essentially zero latency to
    // init()'s critical path instead of one extra full await. Awaited
    // just before the first line that actually needs the DOM to already
    // be in the right language. WSI18n.init() performs no network or
    // scrape-related work of any kind (spec #26).
    var i18nReady = WSI18n.init(document);

    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    await i18nReady;
    var tab = tabs && tabs[0];
    if (!tab || !isSupportedUrl(tab.url)) {
      els.unsupportedNotice.hidden = false;
      els.mainContent.hidden = true;
      return;
    }
    tabId = tab.id;
    var u = null;
    try { u = new URL(tab.url); } catch (e) { u = null; }
    hostname = u ? u.hostname : tab.url;
    pathname = u ? u.pathname : '';
    pageUrl = tab.url;

    await loadState();
    await loadLicenseState();
    await loadAppSettings();
    syncExportPreferencesFromSettings();
    applyLicenseUI();
    deepScrapeConfig = WSRecipes.emptyDeepScrape(); // real values (if any) restored by applyLoadedScraper() when a Saved Scraper is actually Loaded — same convention as loadedDownloadColumn/loadedCompareKey/loadedScraperResearch

    loadedScraperId = await WSRecipes.getLoadedScraperId(hostname);
    if (loadedScraperId) {
      var loaded = await WSRecipes.getScraper(loadedScraperId);
      if (loaded) {
        loadedScraperName = loaded.name;
      } else {
        loadedScraperId = null; // stale reference (scraper was deleted) — self-heal
        await WSRecipes.setLoadedScraperId(hostname, null);
      }
    }
    updateScraperButtonsVisibility();

    // V1 WORKFLOW REORG — decide AUTO vs MANUAL for this popup session
    // now that loadState()/loadedScraperId are both resolved (see
    // decideInitialScrapeMode()'s own comment for the exact rule).
    scrapeMode = await decideInitialScrapeMode();
    renderScrapeMode();

    await renderScrapers();
    await renderMonitoringSection();
    attachMonitoringStorageListener();
    els.monitoringFilters.querySelectorAll('.ws-monitor-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (monitoringStatusFilter === btn.dataset.filter) return;
        monitoringStatusFilter = btn.dataset.filter;
        renderMonitoringSection();
      });
    });
    await checkForPendingNextButtonPick();
    await checkForPendingDetailFieldPicks();

    // V1.18: restore an already-running (or just-finished) Deep Scrape's
    // progress if the popup was closed mid-run — same "closing/reopening
    // must not lose an active background operation" guarantee every
    // other run type (Auto Scroll/Multi-page, ZIP downloads) already has.
    attachDeepScrapeStorageListener();
    var existingDeepScrapeRun = await sessionGet('ws_deepscrape_run');
    if (existingDeepScrapeRun && ['running', 'stopped', 'completed', 'error'].indexOf(existingDeepScrapeRun.status) !== -1) {
      currentDeepScrapeRunId = existingDeepScrapeRun.runId;
      els.deepScrapePanel.hidden = true;
      renderDeepScrapeProgress(existingDeepScrapeRun);
    }

    if (els.toggleDeepScrapeBtn) els.toggleDeepScrapeBtn.addEventListener('click', handleToggleDeepScrapePanel);
    if (els.dsEnabled) els.dsEnabled.addEventListener('change', handleDsEnabledChange);
    if (els.dsSourceColumn) els.dsSourceColumn.addEventListener('change', handleDsSourceColumnChange);
    if (els.dsConcurrency) els.dsConcurrency.addEventListener('change', handleDsConcurrencyChange);
    if (els.dsDelayMode) els.dsDelayMode.addEventListener('change', handleDsDelayModeChange);
    if (els.dsCustomDelay) els.dsCustomDelay.addEventListener('change', handleDsCustomDelayChange);
    if (els.dsRetryLimit) els.dsRetryLimit.addEventListener('change', handleDsRetryLimitChange);
    if (els.dsAddFieldBtn) els.dsAddFieldBtn.addEventListener('click', handleDsAddFieldClick);
    if (els.dsFieldAttribute) els.dsFieldAttribute.addEventListener('change', handleDsFieldAttributeChange);
    if (els.dsFieldSaveBtn) els.dsFieldSaveBtn.addEventListener('click', handleDsFieldSaveClick);
    if (els.dsFieldCancelBtn) els.dsFieldCancelBtn.addEventListener('click', handleDsFieldCancelClick);
    if (els.dsPickFieldsBtn) els.dsPickFieldsBtn.addEventListener('click', handleDsPickFieldsClick);
    if (els.dsTestBtn) els.dsTestBtn.addEventListener('click', handleDsTestClick);
    if (els.dsStartBtn) els.dsStartBtn.addEventListener('click', handleDsStartClick);
    if (els.dsStopBtn) els.dsStopBtn.addEventListener('click', handleDsStopClick);
    if (els.dsRetryFailedBtn) els.dsRetryFailedBtn.addEventListener('click', handleDsRetryFailedClick);

    els.addColumnBtn.addEventListener('click', handleAddColumn);
    els.autoDetectBtn.addEventListener('click', handleAutoDetect);
    els.adStructureSelect.addEventListener('change', function () {
      autoDetectSelectedIndex = parseInt(els.adStructureSelect.value, 10) || 0;
      renderAutoDetectPanel();
    });
    els.adCancelBtn.addEventListener('click', handleCancelAutoDetect);
    els.adUseBtn.addEventListener('click', handleUseAutoDetectFields);
    els.structuredDataBtn.addEventListener('click', handleStructuredDataClick);
    els.sdCancelBtn.addEventListener('click', handleStructuredDataCancel);
    els.sdAddBtn.addEventListener('click', handleStructuredDataAdd);
    els.templatesBtn.addEventListener('click', handleTemplatesClick);
    els.tplCloseBtn.addEventListener('click', closeTemplatesPanel);
    els.tplPreviewBackBtn.addEventListener('click', handleTemplatePreviewBack);
    els.tplCancelBtn.addEventListener('click', handleTemplatePreviewBack);
    els.tplApplyBtn.addEventListener('click', handleTemplateApply);
    els.tplSaveCurrentBtn.addEventListener('click', handleSaveCurrentAsTemplate);
    els.tplImportBtn.addEventListener('click', handleImportTemplateFile);
    els.tplImportFile.addEventListener('change', handleImportTemplateFileChange);
    els.saveScraperBtn.addEventListener('click', handleSaveScraper);
    els.updateScraperBtn.addEventListener('click', handleUpdateScraper);
    els.previewBtn.addEventListener('click', handlePreview);
    els.resetBtn.addEventListener('click', handleResetColumns);
    if (els.baslaBtn) els.baslaBtn.addEventListener('click', handleStartLiveSession);
    if (els.bitirBtn) els.bitirBtn.addEventListener('click', handleFinishLiveSession);
    if (els.durdurBtn) els.durdurBtn.addEventListener('click', handleStopAutoPaginate);
    if (els.discoveryProcessAllBtn) els.discoveryProcessAllBtn.addEventListener('click', handleDiscoveryProcessAll);
    if (els.discoveryProcessFirstBtn) els.discoveryProcessFirstBtn.addEventListener('click', handleDiscoveryProcessFirst);

    els.toggleFilterBtn.addEventListener('click', toggleFilterPanel);
    els.toggleSortBtn.addEventListener('click', toggleSortPanel);
    els.toggleDedupeBtn.addEventListener('click', toggleDedupePanel);
    els.copyBtn.addEventListener('click', handleCopy);
    els.resetResultsBtn.addEventListener('click', handleResetResults);

    els.filterCondition.addEventListener('change', updateFilterValueVisibility);
    els.filterApplyBtn.addEventListener('click', handleApplyFilter);
    els.filterClearBtn.addEventListener('click', handleClearFilter);

    els.sortApplyBtn.addEventListener('click', handleApplySort);
    els.sortClearBtn.addEventListener('click', handleClearSort);

    els.dedupeApplyBtn.addEventListener('click', handleApplyDedupe);

    els.exportCsvBtn.addEventListener('click', handleExportCsv);
    els.exportXlsxBtn.addEventListener('click', handleExportXlsx);
    els.exportJsonBtn.addEventListener('click', handleExportJson);
    els.exportNdjsonBtn.addEventListener('click', handleExportNdjson);
    els.exportSheetsBtn.addEventListener('click', handleExportSheets);
    els.copyFormatSelect.addEventListener('change', function () { persistExportPreference({ copyFormat: els.copyFormatSelect.value }); });

    els.toggleExportOptionsBtn.addEventListener('click', toggleExportOptionsPanel);
    els.exportOptionsCloseBtn.addEventListener('click', function () { els.exportOptionsPanel.hidden = true; });
    els.exportColumnsAllBtn.addEventListener('click', function () { setAllExportColumnsChecked(true); });
    els.exportColumnsNoneBtn.addEventListener('click', function () { setAllExportColumnsChecked(false); });
    els.exportIncludeRaw.addEventListener('change', function () {
      persistExportPreference({ includeRawValues: els.exportIncludeRaw.checked });
      updateExportPreviewText();
    });
    els.exportCsvDelimiter.addEventListener('change', function () {
      persistExportPreference({ csvDelimiter: els.exportCsvDelimiter.value });
      updateExportPreviewText();
    });
    els.exportFilenameTemplate.addEventListener('input', updateExportPreviewText);
    els.exportFilenameTemplate.addEventListener('change', function () {
      persistExportPreference({ filenameTemplate: els.exportFilenameTemplate.value });
    });

    els.downloadImagesBtn.addEventListener('click', function () { handleOpenDownloadPanel('image'); });
    els.downloadFilesBtn.addEventListener('click', function () { handleOpenDownloadPanel('file'); });
    els.dlColumnSelect.addEventListener('change', function () {
      if (downloadKind === 'file') renderTypeFilterCheckboxes();
      updateDownloadPreview();
    });
    els.dlFilenameTemplate.addEventListener('input', updateDownloadPreview);
    document.getElementsByName('dl-dedupe').forEach(function (r) { r.addEventListener('change', updateDownloadPreview); });
    document.getElementsByName('dl-scope').forEach(function (r) {
      r.addEventListener('change', function () {
        if (downloadKind === 'file') renderTypeFilterCheckboxes();
        updateDownloadPreview();
      });
    });
    els.dlCancelBtn.addEventListener('click', handleCancelDownloadSetup);
    els.dlStartBtn.addEventListener('click', handleStartDownload);
    els.dlStopBtn.addEventListener('click', handleStopDownload);
    els.dlRetryBtn.addEventListener('click', handleRetryFailedDownloads);
    els.dlDoneBtn.addEventListener('click', handleDownloadDone);

    els.researchBundleBtn.addEventListener('click', handleOpenResearchPanel);
    els.rbCancelBtn.addEventListener('click', handleCancelResearchSetup);
    els.rbStartBtn.addEventListener('click', handleStartResearchBundle);
    els.rbStopBtn.addEventListener('click', handleStopResearchBundle);
    els.rbRetryBtn.addEventListener('click', handleRetryFailedResearchAssets);
    els.rbDoneBtn.addEventListener('click', handleResearchBundleDone);
    [els.rbIncludeCsv, els.rbIncludeXlsx, els.rbIncludeJson, els.rbIncludeImages, els.rbIncludeFiles, els.rbImageColumnSelect, els.rbFileColumnSelect].forEach(function (el) {
      el.addEventListener('change', updateResearchPreview);
    });
    document.getElementsByName('rb-scope').forEach(function (r) { r.addEventListener('change', updateResearchPreview); });

    els.toggleTransformBtn.addEventListener('click', toggleTransformPanel);
    els.tfOperationSelect.addEventListener('change', function () {
      // renderTransformOptionGroups() is the single authority for shared,
      // type-independent controls (Scope/Destination) — it already calls
      // updateSplitFieldVisibility() itself, but ONLY when type==='split'
      // (V1.23: that function also recomputes Scope/Destination visibility
      // for split's own structural-vs-value-style distinction, so calling
      // it unconditionally here would incorrectly clobber Scope/
      // Destination for every OTHER operation type right after
      // renderTransformOptionGroups() just set them correctly).
      renderTransformOptionGroups();
      updateSubstringFieldVisibility();
      updateTransformPreview();
    });
    els.tfColumnSelect.addEventListener('change', updateTransformPreview);
    els.tfSubstringMode.addEventListener('change', function () { updateSubstringFieldVisibility(); updateTransformPreview(); });
    document.getElementsByName('tf-split-mode').forEach(function (r) { r.addEventListener('change', function () { updateSplitFieldVisibility(); updateTransformPreview(); }); });
    document.getElementsByName('tf-split-limit').forEach(function (r) { r.addEventListener('change', updateTransformPreview); });
    els.tfSplitOutputMode.addEventListener('change', function () { updateSplitFieldVisibility(); updateTransformPreview(); });
    document.getElementsByName('tf-find-occurrence').forEach(function (r) { r.addEventListener('change', updateTransformPreview); });
    els.tfExtractAll.addEventListener('change', function () { updateExtractFieldVisibility(); updateTransformPreview(); });
    els.tfNumberMode.addEventListener('change', function () { updateNumberFieldVisibility(); updateTransformPreview(); });
    els.tfBoolUnmatchedMode.addEventListener('change', function () { updateBooleanFieldVisibility(); updateTransformPreview(); });
    document.getElementsByName('tf-scope').forEach(function (r) { r.addEventListener('change', updateTransformPreview); });
    document.getElementsByName('tf-destination').forEach(function (r) { r.addEventListener('change', function () { updateDestinationFieldVisibility(); updateTransformPreview(); }); });
    [
      els.tfFindValue, els.tfReplaceValue, els.tfCaseSensitive,
      els.tfRegexPattern, els.tfRegexFlags, els.tfRegexReplacement,
      els.tfExtractPattern, els.tfExtractFlags, els.tfExtractGroup, els.tfExtractFallback, els.tfExtractJoin,
      els.tfCaseMode, els.tfPrefixValue, els.tfSuffixValue,
      els.tfRemovePrefixValue, els.tfRemovePrefixCaseSensitive, els.tfRemoveSuffixValue, els.tfRemoveSuffixCaseSensitive,
      els.tfFillValue, els.tfFillMatchValues, els.tfFillMode,
      els.tfNumberDecimalSep, els.tfNumberThousandsSep, els.tfCurrencyMode, els.tfPercentageMode,
      els.tfDateOrder, els.tfDateOutputFormat,
      els.tfBoolTrueValues, els.tfBoolFalseValues, els.tfBoolOutputTrue, els.tfBoolOutputFalse, els.tfBoolUnmatchedValue,
      els.tfDomainPart,
      els.tfRemoveFragment, els.tfSubstringN, els.tfSubstringStart, els.tfSubstringEnd,
      els.tfSplitDelimiter, els.tfSplitPattern, els.tfSplitFlags, els.tfSplitOutputNames, els.tfSplitKeepOriginal,
      els.tfSplitPartIndex, els.tfSplitJoinWith, els.tfNewColumnName,
      els.tfCombineTemplate, els.tfCombineOutputName, els.tfCombineKeepOriginal
    ].forEach(function (el) {
      el.addEventListener('input', updateTransformPreview);
      el.addEventListener('change', updateTransformPreview);
    });
    els.tfApplyBtn.addEventListener('click', handleApplyTransform);
    els.tfCancelBtn.addEventListener('click', handleCancelTransformPanel);
    els.tfAddPresetBtn.addEventListener('click', handleAddPreset);
    els.undoLastTransformBtn.addEventListener('click', handleUndoLastTransform);
    els.resetTransformsBtn.addEventListener('click', handleResetTransforms);

    els.toggleSnapshotsBtn.addEventListener('click', toggleSnapshotsPanel);
    els.compareKeySelect.addEventListener('change', updateSnapshotDuplicateNote);
    els.saveSnapshotBtn.addEventListener('click', handleSaveSnapshot);
    els.compareSnapshotBtn.addEventListener('click', handleCompareWithPrevious);
    els.changesBackBtn.addEventListener('click', handleChangesBack);
    els.changesFilterAll.addEventListener('click', function () { setChangesFilter('all'); });
    els.changesFilterNew.addEventListener('click', function () { setChangesFilter('new'); });
    els.changesFilterRemoved.addEventListener('click', function () { setChangesFilter('removed'); });
    els.changesFilterChanged.addEventListener('click', function () { setChangesFilter('changed'); });
    els.changesFilterPrice.addEventListener('click', function () { setChangesFilter('price'); });
    els.exportChangesCsvBtn.addEventListener('click', handleExportChangesCsv);
    els.exportChangesXlsxBtn.addEventListener('click', handleExportChangesXlsx);
    els.exportChangesJsonBtn.addEventListener('click', handleExportChangesJson);
    els.saveAfterCompareBtn.addEventListener('click', handleSaveAfterCompare);

    document.getElementsByName('run-mode').forEach(function (r) {
      r.addEventListener('change', onRunModeChanged);
    });
    els.selectNextBtn.addEventListener('click', handleSelectNextButton);
    els.selectLoadMoreBtn.addEventListener('click', handleSelectNextButton);
    if (els.mpMethod) els.mpMethod.addEventListener('change', onMpMethodChanged);
    els.detectPaginationBtn.addEventListener('click', handleDetectPagination);
    els.pdUseBtn.addEventListener('click', handleUseDetectedPagination);
    els.pdDismissBtn.addEventListener('click', handleDismissPaginationDetection);
    els.startRunBtn.addEventListener('click', handleStartRun);
    els.pauseRunBtn.addEventListener('click', handlePauseRun);
    els.stopRunBtn.addEventListener('click', handleStopRun);
    els.resumeRunBtn.addEventListener('click', handleResumeRun);
    els.viewRunResultsBtn.addEventListener('click', handleViewRunResults);
    onRunModeChanged();

    attachRunStorageListener();
    // If a run is already in progress (or just finished/stopped) for this
    // site — e.g. the popup was closed and reopened mid-run — reflect
    // that immediately instead of showing the setup UI from scratch.
    var existingRun = await sessionGet(runKey());
    if (existingRun) {
      renderRunProgress(existingRun);
      // V1.15: an Auto Scroll/Multi-page run can complete while the popup
      // is CLOSED (see this file's header comment on run architecture) —
      // the storage.onChanged listener below never fires for a change
      // that happened before this popup instance even existed, so a
      // just-completed run's credit must also be charged right here at
      // boot. Idempotent by runId, so this can never double-charge
      // alongside the onChanged listener below.
      await maybeChargeForCompletedRun(existingRun);
    }

    // Same idea for an in-progress/just-finished zip run — these are NOT
    // scoped per-hostname (a single global "ws_zip_run" key, since a
    // bulk download/research bundle isn't tied to a specific page the
    // way a scrape run is), so no runKey()-style hostname lookup needed.
    attachDownloadStorageListener();
    // V1.13 bugfix (still relevant under V1.13.2's zip pipeline):
    // renderDownloadProgress/renderResearchProgress both gate on
    // activeDownloadPurpose so the two panels never paint over each
    // other's live progress — which starts out null on a fresh popup
    // load, so a run restored here would otherwise render NOTHING even
    // for the common "popup reopened mid Bulk-Download" case. state.kind
    // ('image'/'file'/'research', set by whichever side started the run)
    // tells us directly which panel it belongs to — no folderName-
    // sniffing needed the way the pre-V1.13.2 fix had to.
    var existingZipRun = await sessionGet('ws_zip_run');
    if (existingZipRun) {
      if (existingZipRun.kind === 'research') {
        // The in-memory plan a Research Bundle needs to render/finalize
        // (columns, rows, Dataset IDs, url->filename maps, and — under
        // V1.13.2 — the manifest-building step itself) lives only in the
        // popup instance that started it and is never persisted — a
        // known limitation carried forward from V1.12 (see this file's
        // Research Bundle section header). The asset fetching itself is
        // unaffected and keeps progressing via background.js regardless;
        // only this reopened popup's live view of (and ability to
        // finalize) it is unavailable. activeDownloadPurpose is left
        // null (not 'research') so it doesn't block a subsequent Bulk
        // Download started fresh in this same popup session.
        activeDownloadPurpose = null;
      } else {
        activeDownloadPurpose = 'bulk';
        currentZipRunId = existingZipRun.runId;
        renderDownloadProgress(existingZipRun);
      }
    }

    // V1.13: tab navigation wiring + restoring whichever tab was active
    // the last time this popup was open (spec #20) — purely presentational,
    // reads/writes only the isolated ws_active_tab session key.
    if (els.tabNav) {
      els.tabNav.querySelectorAll('.ws-tab-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
      });
    }
    // V1.13.1: cross-tab quick-nav buttons — every one of these is a pure
    // switchTab() call, never a second path that fetches/duplicates data
    // (Research/Results always read the same rawRows regardless of how
    // you got to that tab).
    if (els.scrapeViewResultsBtn) els.scrapeViewResultsBtn.addEventListener('click', function () { switchTab('results'); });
    if (els.resultsGoScrapeBtn) els.resultsGoScrapeBtn.addEventListener('click', function () { switchTab('scrape'); });
    // V1 WORKFLOW REORG — these two buttons now live in the "Next
    // Actions" block and pass along context (see handleResultsGoResearch/
    // handleResultsGoMonitor) instead of a bare tab switch.
    if (els.resultsGoResearchBtn) els.resultsGoResearchBtn.addEventListener('click', handleResultsGoResearch);
    if (els.resultsGoMonitorBtn) els.resultsGoMonitorBtn.addEventListener('click', handleResultsGoMonitor);
    if (els.resultsExportDataBtn) els.resultsExportDataBtn.addEventListener('click', handleResultsExportData);
    if (els.monitorBackToResultsBtn) els.monitorBackToResultsBtn.addEventListener('click', handleBackToResults);
    if (els.researchBackToResultsBtn) els.researchBackToResultsBtn.addEventListener('click', handleBackToResults);

    // V1 WORKFLOW REORG — AUTO/MANUAL mode switch + Scan Page/Extract Data.
    if (els.modeAutoBtn) els.modeAutoBtn.addEventListener('click', function () { setScrapeModeUi('auto'); });
    if (els.modeManualBtn) els.modeManualBtn.addEventListener('click', function () { setScrapeModeUi('manual'); });
    if (els.autoSwitchToManualBtn) els.autoSwitchToManualBtn.addEventListener('click', function () { setScrapeModeUi('manual'); });
    if (els.scanPageBtn) els.scanPageBtn.addEventListener('click', handleScanPage);
    if (els.autoExtractBtn) els.autoExtractBtn.addEventListener('click', handleAutoExtract);
    // V1 AUTO DETECTION DIAGNOSTICS — DEV ONLY. #auto-diag-panel (and
    // therefore this button) stays `hidden` unless revealAutoDiagPanelIfDev()
    // (called after every successful scan) confirms an unpacked/development
    // install — wiring the listener unconditionally here is safe because
    // the button itself is never visible/clickable in a production build,
    // matching every other dev/QA-only control in this project.
    if (els.autoDiagCopyBtn) els.autoDiagCopyBtn.addEventListener('click', handleCopyAutoDiagnostic);
    if (els.sessionDiagCopyBtn) els.sessionDiagCopyBtn.addEventListener('click', handleCopySessionDiagnostic);
    if (els.researchGoScrapeBtn) els.researchGoScrapeBtn.addEventListener('click', function () { switchTab('scrape'); });

    // V1.14/V1.15/V1.16: Settings / trial-complete modal / recovery wiring.
    if (els.settingsOpenBtn) els.settingsOpenBtn.addEventListener('click', handleOpenSettings);
    if (els.settingsCloseBtn) els.settingsCloseBtn.addEventListener('click', handleCloseSettings);
    if (els.settingsUnlockBtn) els.settingsUnlockBtn.addEventListener('click', handleUnlockPurchaseClick);
    if (els.settingsRecoverBtn) els.settingsRecoverBtn.addEventListener('click', handleOpenRecoverPanel);
    if (els.settingsRecoverCancelBtn) els.settingsRecoverCancelBtn.addEventListener('click', handleCloseRecoverPanel);
    if (els.settingsRecoverSubmitBtn) els.settingsRecoverSubmitBtn.addEventListener('click', handleSubmitRecover);
    if (els.settingsLanguageSelect) els.settingsLanguageSelect.addEventListener('change', handleLanguageChange);
    // trialModalDismissBtn/trialModalOverlay are wired at the very top of
    // init() now (V1 FINAL Bug #1 fix) — not duplicated here.
    if (els.trialModalUnlockBtn) els.trialModalUnlockBtn.addEventListener('click', handleUnlockPurchaseClick);
    document.getElementsByName('settings-dev-license').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) handleDevLicenseSwitch(r.value); });
    });
    // V1 FINAL PART C — QA trial-state buttons. Reachable ONLY through
    // this same #settings-dev-switcher DOM (hidden unless
    // isDevelopmentInstall() resolves true — see handleOpenSettings());
    // wiring the listeners unconditionally here is safe because the
    // buttons themselves are never visible/clickable in a production
    // build, matching every other control in this same container.
    [els.qaTrialStateABtn, els.qaTrialStateBBtn, els.qaTrialStateCBtn, els.qaTrialStateDBtn].forEach(function (btn) {
      if (!btn) return;
      btn.addEventListener('click', function () { handleQaSetTrialRunsUsed(parseInt(btn.getAttribute('data-qa-runs'), 10) || 0); });
    });
    if (els.qaTrialStateEBtn) els.qaTrialStateEBtn.addEventListener('click', handleQaSimulateUnlock);
    if (els.qaTrialResetBtn) els.qaTrialResetBtn.addEventListener('click', handleQaResetTrialState);
    [els.settingsRbCsv, els.settingsRbXlsx, els.settingsRbJson, els.settingsRbImages, els.settingsRbFiles].forEach(function (cb) {
      if (cb) cb.addEventListener('change', handleSettingsResearchDefaultsChange);
    });

    // V1 SIMPLIFIED SESSION WORKFLOW: an active or just-finished
    // live-collect session for this hostname always wins over whichever
    // tab was last active — e.g. the user closed the popup while
    // collecting on the Sonuçlar tab, then reopened it on a different
    // page/moment; this must land back on Sonuçlar with the existing
    // dataset, never the empty setup screen (restoreLiveSessionIfAny
    // itself switches to 'results' once it finds something to restore).
    var restoredSession = false;
    try { restoredSession = await restoreLiveSessionIfAny(); } catch (e) { /* best-effort — fall through to normal tab restore */ }
    if (!restoredSession) {
      var savedTab = null;
      try { savedTab = await sessionGet(ACTIVE_TAB_SESSION_KEY); } catch (e) { /* fall back to 'scrape' below */ }
      switchTab(savedTab || 'scrape', { persist: false });
    }
  }

  init().catch(function (e) { console.error('DEBUG INIT CRASHED:', e && e.stack || e); });
})();
