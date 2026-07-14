import { diagnosticLabel, hasErrors } from "./domain/diagnostics.js";
import { parseConfigFile } from "./domain/config.js";
import { buildSequenceBarLayout, editSequenceDisplay, exportSequenceFile, parseSequenceFile, resolveSequenceDisplaySong } from "./domain/sequences.js";
import { exportSoundLibrary, parseSoundLibrary } from "./domain/sounds.js";
import { createLibraryBackend, createUnavailableLibraryBackend, formatLibraryBackendError, loadRuntimeConfig } from "./libraryBackends.js";

const ASSET_TYPES = {
  sounds: {
    label: "Sounds",
    libraryKind: "sounds",
    generatedFileName: "gen_sounds.txt",
    parser: parseSoundLibrary,
    modelKey: "library"
  },
  sequence: {
    label: "Sequence",
    libraryKind: "sequences",
    generatedFileName: "gen_sequence.txt",
    parser: parseSequenceFile,
    modelKey: "sequence"
  },
  config: {
    label: "Config",
    libraryKind: "config",
    generatedFileName: "gen_config.txt",
    parser: parseConfigFile,
    modelKey: "config"
  }
};

const SOUND_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOUND_SYMBOL_PATTERN = /^[A-Za-z0-9_#]$/;
const SOUND_RGB_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const LIBRARY_FILE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const SOUND_NAMED_COLORS = new Set([
  "red",
  "orange",
  "blue",
  "green",
  "yellow",
  "indigo",
  "purple",
  "violet",
  "cyan",
  "white"
]);
const SYMBOL_CANDIDATES = [
  "#",
  ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
  ...Array.from("abcdefghijklmnopqrstuvwxyz"),
  ...Array.from("0123456789"),
  "_"
];
const ENVELOPE_EXTEND_HOLD_MS = 1500;
const ENVELOPE_EXTEND_INTERVAL_MS = 250;
const VALUE_ROW_MAX_QUANTA = 16;
const SEQUENCE_DEFAULT_BEATS_PER_BAR = 4;
const SEQUENCE_DEFAULT_COLUMNS_PER_BEAT = 4;
const SEQUENCE_CELL_SIZES = [2.4, 6, 7.92, 12, 15.84, 18, 24, 30];
const SEQUENCE_DEFAULT_CELL_SIZE = 24;
const SEQUENCE_HISTORY_LIMIT = 60;
const SEQUENCE_BAR_BEAT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];
const SEQUENCE_BEAT_COLUMN_OPTIONS = [1, 2, 4, 8, 16];
const SPLASH_IMAGE_PATH = "./assets/chopchae-splash.jpeg";
const runtime = await initializeRuntime();

const state = {
  activeType: "sounds",
  assets: {
    sounds: createEmptyAsset(),
    sequence: createEmptyAsset(),
    config: createEmptyAsset()
  },
  library: null,
  libraryBackend: runtime.libraryBackend,
  runtimeConfig: runtime.config,
  libraryVisible: true,
  messages: runtime.messages.map((message, index) => ({ id: index + 1, ...message })),
  nextMessageId: runtime.messages.length + 1,
  soundsView: "program",
  sequenceView: "grid",
  sequenceCellSize: SEQUENCE_DEFAULT_CELL_SIZE,
  sequenceScrollLeft: 0,
  sequenceHistory: {
    undo: [],
    redo: []
  },
  sequenceInstrumentDrag: null,
  sequenceSaveAs: {
    open: false,
    name: "",
    error: ""
  },
  libraryOpen: {
    open: false
  },
  diagnosticsOpen: false,
  selectedSoundIndex: 0,
  envelopeDrag: null,
  soundNotes: {},
  showPatchView: false,
  splashVisible: true
};

const app = document.querySelector("#app");
await refreshLibrary();
render();
window.addEventListener("pointermove", updateEnvelopeDrag);
window.addEventListener("pointerup", finishEnvelopeDrag);
window.addEventListener("keydown", handleGlobalKeyDown);

function createEmptyAsset() {
  return {
    fileName: null,
    libraryName: "",
    text: "",
    model: null,
    diagnostics: []
  };
}

async function initializeRuntime() {
  try {
    const config = await loadRuntimeConfig();
    return {
      config,
      libraryBackend: createLibraryBackend(config),
      messages: []
    };
  } catch (error) {
    const message = formatLibraryBackendError(error);
    return {
      config: null,
      libraryBackend: createUnavailableLibraryBackend(message),
      messages: [{ tone: "error", text: message }]
    };
  }
}

function render() {
  const active = state.assets[state.activeType];

  app.innerHTML = `
    <div class="shell" ${state.splashVisible ? 'aria-hidden="true"' : ""}>
      <main class="workspace ${state.libraryVisible ? "" : "library-hidden"}">
        <nav class="rail" aria-label="Asset type">
          ${Object.entries(ASSET_TYPES).map(([type, config]) => renderTab(type, config)).join("")}
        </nav>

        ${renderEditor(active)}

        <aside class="inspector">
          ${state.libraryVisible ? `${renderLibrary()}${renderAssetPreview(active)}` : renderLibraryReveal()}
        </aside>
      </main>
      ${renderPatchOverlay(active)}
      ${renderSequenceSaveAsDialog()}
      ${renderLibraryOpenDialog()}
      ${renderDiagnosticsDialog()}
      ${renderActivityLog()}
    </div>
    ${renderSplashScreen()}
  `;

  bindEvents();
}

function renderSplashScreen() {
  if (!state.splashVisible) {
    return "";
  }

  return `
    <section class="splash-screen" role="dialog" aria-modal="true" aria-label="Chop Chae splash page">
      <div class="splash-frame">
        <div class="splash-image-wrap">
          <img class="splash-image" src="${SPLASH_IMAGE_PATH}" alt="Modular synthesizer patched with noodles" decoding="async" fetchpriority="high">
        </div>
        <button class="splash-enter" data-action="enter-splash" type="button">CHOP CHAE</button>
      </div>
    </section>
  `;
}

function renderEditor(active) {
  if (state.activeType === "sounds") {
    return renderSoundsEditor(active);
  }

  if (state.activeType === "sequence") {
    return renderSequenceEditor(active);
  }

  return renderTextEditor(active);
}

function renderTextEditor(active, extraClass = "") {
  return `
    <section class="editor ${extraClass}">
      ${renderEditorChrome()}
      <textarea spellcheck="false" data-action="source">${escapeHtml(active.text)}</textarea>
    </section>
  `;
}

function renderEditorChrome() {
  return `
    <div class="editor-chrome">
      ${renderCurrentFileStrip()}
      ${renderMenuBar()}
    </div>
  `;
}

function renderCurrentFileStrip() {
  const config = ASSET_TYPES[state.activeType];

  return `
    <div class="current-file-strip">
      <span>${escapeHtml(config.label)}</span>
      <strong>${escapeHtml(getActiveLibraryName())}</strong>
    </div>
  `;
}

function renderMenuBar() {
  const sequenceDisabled = state.activeType === "sequence" ? "" : "disabled";
  const undoEntry = state.activeType === "sequence" ? getTopSequenceUndo() : null;
  const redoEntry = state.activeType === "sequence" ? getTopSequenceRedo() : null;
  const undoDisabled = undoEntry == null ? "disabled" : "";
  const redoDisabled = redoEntry == null ? "disabled" : "";

  return `
    <nav class="menu-bar" aria-label="Application menu">
      <details class="app-menu">
        <summary>File</summary>
        <div class="menu-popover" role="menu">
          <button class="menu-item" data-action="new-file" role="menuitem">New</button>
          <button class="menu-item" data-action="open-library-menu" role="menuitem">Open</button>
          <button class="menu-item" data-action="menu-upload" role="menuitem">Upload</button>
          <div class="menu-separator" role="separator"></div>
          <button class="menu-item" data-action="save-library" role="menuitem">Save</button>
          <button class="menu-item" data-action="sequence-save-as" role="menuitem" ${sequenceDisabled}>Save As...</button>
          <button class="menu-item" data-action="download-current" role="menuitem">Download</button>
        </div>
      </details>
      <details class="app-menu">
        <summary>Edit</summary>
        <div class="menu-popover edit-menu-popover" role="menu">
          <button class="menu-item menu-command" data-action="undo-sequence-edit" role="menuitem" ${undoDisabled}>
            <span>${escapeHtml(undoEntry == null ? "Undo" : `Undo ${undoEntry.label}`)}</span>
            <kbd>${formatCommandShortcut("Z")}</kbd>
          </button>
          <button class="menu-item menu-command" data-action="redo-sequence-edit" role="menuitem" ${redoDisabled}>
            <span>${escapeHtml(redoEntry == null ? "Redo" : `Redo ${redoEntry.label}`)}</span>
            <kbd>${formatCommandShortcut("Z", { shift: true })}</kbd>
          </button>
        </div>
      </details>
      <details class="app-menu">
        <summary>View</summary>
        <div class="menu-popover" role="menu">
          ${renderViewMenuItem("grid", "Grid View", sequenceDisabled)}
          ${renderViewMenuItem("text", "Text View", sequenceDisabled)}
        </div>
      </details>
      <div class="menu-spacer"></div>
      ${renderEditStackPeek()}
      <input class="hidden-file-input" type="file" data-action="load-file">
    </nav>
  `;
}

function renderEditStackPeek() {
  if (state.activeType !== "sequence") {
    return "";
  }

  const undoEntry = getTopSequenceUndo();
  const redoEntry = getTopSequenceRedo();
  const label = undoEntry == null
    ? "No edits"
    : `Undo: ${undoEntry.label}`;
  const title = redoEntry == null
    ? label
    : `${label}; Redo: ${redoEntry.label}`;

  return `
    <div class="edit-stack-peek" title="${escapeHtml(title)}">
      <span>History</span>
      <strong>${escapeHtml(label)}</strong>
    </div>
  `;
}

function renderViewMenuItem(view, label, disabled) {
  const active = state.activeType === "sequence" && state.sequenceView === view;
  const shortcut = view === "grid"
    ? formatCommandShortcut("G")
    : formatCommandShortcut("T");

  return `
    <button class="menu-item menu-command checkable" data-action="sequence-view" data-view="${view}" role="menuitemradio" aria-checked="${active}" ${disabled}>
      <span class="menu-check">${active ? "&#10003;" : ""}</span>
      <span>${label}</span>
      <kbd>${shortcut}</kbd>
    </button>
  `;
}

function renderLibraryOpenDialog() {
  if (!state.libraryOpen.open) {
    return "";
  }

  const config = ASSET_TYPES[state.activeType];
  const files = getLibraryFilesForActiveType();
  const rows = files.length === 0
    ? `<div class="empty">No ${config.label.toLowerCase()} files</div>`
    : files.map((file) => `
      <button class="library-row" data-action="open-library-from-dialog" data-name="${escapeHtml(file.name)}">
        <span>${escapeHtml(file.name)}</span>
        <small>${file.exists ? `${file.bytes} bytes` : "missing"}</small>
      </button>
    `).join("");

  return `
    <div class="modal-backdrop" data-action="close-library-open">
      <section class="library-open-modal" role="dialog" aria-modal="true" aria-label="Open library file" data-action="library-open-modal">
        <div class="save-as-header">
          <h2>Open ${escapeHtml(config.label)}</h2>
          <button class="button subtle" data-action="close-library-open">Cancel</button>
        </div>
        <div class="library-open-body">
          <div class="library-list">${rows}</div>
        </div>
      </section>
    </div>
  `;
}

function renderSoundsEditor(active) {
  const tabs = [
    ["program", "Sounds"],
    ["text", "Text"],
    ["buttons", "Button Map"]
  ];

  const body = state.soundsView === "text"
    ? `<textarea spellcheck="false" data-action="source">${escapeHtml(active.text)}</textarea>`
    : state.soundsView === "buttons"
      ? renderButtonMapView(active.model)
      : renderSoundProgramView(active.model);

  return `
    <section class="editor sounds-editor">
      ${renderEditorChrome()}
      <div class="sounds-tabs" role="tablist" aria-label="Sounds editor views">
        ${tabs.map(([view, label]) => `
          <button class="sounds-tab ${state.soundsView === view ? "active" : ""}" data-action="sounds-view" data-view="${view}" role="tab" aria-selected="${state.soundsView === view}">
            ${label}
          </button>
        `).join("")}
      </div>
      <div class="sounds-view">
        ${body}
      </div>
    </section>
  `;
}

function renderSequenceEditor(active) {
  const body = state.sequenceView === "text"
    ? `<textarea spellcheck="false" data-action="source">${escapeHtml(active.text)}</textarea>`
    : renderSequenceGridView(active.model);

  return `
    <section class="editor sequence-editor">
      ${renderEditorChrome()}
      <div class="sequence-view">
        ${body}
      </div>
    </section>
  `;
}

function renderSequenceGridView(sequence) {
  if (sequence == null) {
    return `
      <div class="sequence-empty">
        <strong>No sequence loaded</strong>
        <span>Open a sequence file or use Text to start one.</span>
      </div>
    `;
  }

  const song = resolveSequenceDisplaySong(sequence);
  if (song.lines.length === 0 || song.segments.length === 0) {
    return `
      <div class="sequence-panel">
        ${renderSequenceDisplayControls(sequence, song)}
        <div class="sequence-empty">
          <strong>No playable song</strong>
          <span>Add instruments, tabs, or a sequence expression.</span>
        </div>
      </div>
    `;
  }

  const palette = buildSequenceInstrumentPalette(sequence);
  return `
    <div class="sequence-panel">
      ${renderSequenceDisplayControls(sequence, song)}
      ${renderSequenceBoard(song, palette)}
    </div>
  `;
}

function renderSequenceDisplayControls(sequence, song) {
  const soundOptions = renderActiveSoundsOptions();
  const activeSoundsName = getActiveSoundsName();
  const sequenceZoomIndex = SEQUENCE_CELL_SIZES.indexOf(state.sequenceCellSize);
  const entryLabel = song.entryName == null
    ? "No song"
    : `${song.selectionReason === "play" ? "Play" : "Song"} ${song.entryName}`;
  const segmentCount = song.segments.length === 1 ? "1 fragment" : `${song.segments.length} fragments`;

  return `
    <div class="sequence-control-strip">
      <label class="sequence-select-field sounds-file">
        <span>Sounds</span>
        <select data-action="sequence-sounds-file">
          ${soundOptions}
        </select>
      </label>
      <div class="sequence-song-source" title="${escapeHtml(describeSequenceSongSource(song))}">
        <span>${escapeHtml(entryLabel)}</span>
        <strong>${escapeHtml(segmentCount)}</strong>
      </div>
      <div class="sequence-timing-strip" aria-label="Sequence timing">
        <span>Beat ${formatSequenceBeat(sequence.timing.columnsPerBeat)}</span>
        <strong>${escapeHtml(String(sequence.timing.beatsPerMinute))} BPM</strong>
        <span>${escapeHtml(String(sequence.timing.quantaPerColumn))} q/col</span>
      </div>
      <div class="sequence-zoom-control" aria-label="Sequence zoom">
        <button type="button" data-action="sequence-zoom" data-delta="-1" title="Zoom out" aria-label="Zoom out" ${sequenceZoomIndex <= 0 ? "disabled" : ""}>-</button>
        <span>${formatSequenceZoomLabel(state.sequenceCellSize)}</span>
        <button type="button" data-action="sequence-zoom" data-delta="1" title="Zoom in" aria-label="Zoom in" ${sequenceZoomIndex >= SEQUENCE_CELL_SIZES.length - 1 ? "disabled" : ""}>+</button>
      </div>
      ${renderSequenceDiagnosticsButton()}
      <div class="sequence-active-sounds" title="${escapeHtml(activeSoundsName)}">
        ${state.assets.sounds.model == null ? "No active sounds" : escapeHtml(activeSoundsName)}
      </div>
    </div>
  `;
}

function renderSequenceDiagnosticsButton() {
  const diagnostics = state.assets.sequence.diagnostics;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const status = getDiagnosticsStatus(diagnostics);
  const label = status.level === "pass"
    ? "Diagnostics Pass"
    : status.level === "warn"
      ? `${warnings} ${warnings === 1 ? "Warning" : "Warnings"}`
      : `${errors} ${errors === 1 ? "Error" : "Errors"}`;
  const detail = diagnostics.length === 0
    ? "No diagnostics"
    : `${diagnostics.length} ${diagnostics.length === 1 ? "diagnostic" : "diagnostics"}`;

  return `
    <button class="sequence-diagnostics-button ${status.level}" type="button" data-action="open-diagnostics-report" title="${escapeHtml(detail)}">
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function getDiagnosticsStatus(diagnostics) {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return {
      level: "fail",
      label: "Errors found"
    };
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return {
      level: "warn",
      label: "Warnings found"
    };
  }

  return {
    level: "pass",
    label: "Pass"
  };
}

function renderActiveSoundsOptions() {
  const currentName = getActiveSoundsName();
  const files = state.library?.files.sounds ?? [];
  const names = new Set(files.map((file) => file.name));
  const rows = [];

  if (currentName === "") {
    rows.push(`<option value="" selected>Select sounds...</option>`);
  }

  if (currentName !== "" && !names.has(currentName)) {
    rows.push(`<option value="${escapeHtml(currentName)}" selected>${escapeHtml(currentName)}</option>`);
  }

  rows.push(...files.map((file) => `
    <option value="${escapeHtml(file.name)}" ${currentName === file.name ? "selected" : ""}>${escapeHtml(file.name)}</option>
  `));

  if (rows.length === 0) {
    return `<option value="">No library sounds</option>`;
  }

  return rows.join("");
}

function getActiveSoundsName() {
  const asset = state.assets.sounds;
  return asset.libraryName || asset.fileName || "";
}

function buildSequenceInstrumentPalette(sequence) {
  const groups = state.assets.sounds.model == null ? [] : buildSoundGroups(state.assets.sounds.model);
  const soundsByInstrument = new Map(groups.map((group) => [
    group.name,
    group.entries.map(({ sound }) => sound)
  ]));

  return sequence.instruments.map((name) => ({
    name,
    sounds: soundsByInstrument.get(name) ?? []
  }));
}

function renderSequenceBoard(song, palette) {
  const sequence = state.assets.sequence.model;
  const maxColumns = Math.max(0, ...song.lines.map((line) => line.length));
  const bars = buildSequenceBarLayout(sequence, maxColumns, { defaultBeatsPerBar: SEQUENCE_DEFAULT_BEATS_PER_BAR });
  const totalColumns = bars.reduce((sum, bar) => sum + bar.columns, 0);
  const beatStartColumns = new Set(bars.flatMap((bar) => (
    Array.from({ length: bar.beats }, (_, beatIndex) => bar.startColumn + beatIndex * bar.columnsPerBeat)
  )));
  const barStartColumns = new Set(bars.map((bar) => bar.startColumn));

  return `
    <div class="sequence-board">
      <div class="sequence-grid-frame" data-action="sequence-grid-scroll">
        <div class="sequence-grid" style="--sequence-columns:${totalColumns}; --sequence-cell-size:${state.sequenceCellSize}px">
          ${renderSequenceTempoHeader(song.tempoSpans)}
          ${renderSequenceSegmentHeaders(song)}
          ${renderSequenceBarHeader(bars)}
          ${renderSequenceBeatHeader(bars)}
          ${palette.map((instrument, index) => renderSequenceInstrumentRow(song.lines[index] ?? "", instrument, index, totalColumns, beatStartColumns, barStartColumns)).join("")}
          ${renderSequenceInstrumentAddRow(sequence, totalColumns)}
        </div>
      </div>
      <input class="sequence-horizontal-scrollbar" data-action="sequence-horizontal-scroll" type="range" min="0" max="0" value="0" aria-label="Sequence horizontal scroll">
    </div>
  `;
}

function renderSequenceTempoHeader(tempoSpans) {
  return `
    <div class="sequence-grid-row sequence-tempo-row">
      <div class="sequence-corner">Tempo</div>
      ${tempoSpans.map((span) => `
        <div class="sequence-tempo-label" style="grid-column:${span.startColumn + 2} / span ${span.columns}" title="${escapeHtml(formatTempoLabel(span.tempo))}">
          <span>${escapeHtml(formatTempoLabel(span.tempo))}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderSequenceSegmentHeaders(song) {
  const rows = song.segmentRows?.length > 0 ? song.segmentRows : [song.segments];
  const editableRowIndex = rows.length - 1;

  return rows.map((segments, rowIndex) => renderSequenceSegmentHeaderRow(segments, rowIndex === editableRowIndex)).join("");
}

function renderSequenceSegmentHeaderRow(segments, editable) {
  const label = editable ? "Segment" : "Section";

  return `
    <div class="sequence-grid-row sequence-segments-row ${editable ? "editable" : "nested"}">
      <div class="sequence-corner">${label}</div>
      ${segments.map((segment, segmentIndex) => `
        <div class="sequence-segment-label ${editable ? "editable" : "nested"}" style="grid-column:${segment.startColumn + 2} / span ${segment.columns}" title="${escapeHtml(segment.name)}">
          ${editable ? renderSequenceEditControls("segment", segment.name, segmentIndex) : ""}
          <span class="sequence-segment-name">${escapeHtml(segment.name)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderSequenceBarHeader(bars) {
  return `
    <div class="sequence-grid-row sequence-bars-row">
      <div class="sequence-corner">Bar</div>
      ${bars.map((bar) => `
        <div class="sequence-bar-label" style="grid-column:${bar.startColumn + 2} / span ${bar.columns}">
          ${renderSequenceEditControls("bar", `bar ${bar.index + 1}`, bar.index, { bar })}
          <span class="sequence-bar-number">${bar.index + 1}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderSequenceEditControls(scope, targetName, targetIndex, options = {}) {
  return `
    <span class="sequence-edit-cluster sequence-edit-cluster-start">
      ${renderSequenceEditButton("add-left", `Add ${scope} to the left of ${targetName}`, scope, targetIndex)}
      ${renderSequenceEditButton("delete", `Delete ${targetName}`, scope, targetIndex)}
    </span>
    <span class="sequence-edit-cluster sequence-edit-cluster-end">
      ${options.bar == null ? "" : renderSequenceMeasureMenu(options.bar)}
      ${renderSequenceEditButton("add-right", `Add ${scope} to the right of ${targetName}`, scope, targetIndex)}
    </span>
  `;
}

function renderSequenceEditButton(intent, label, scope, targetIndex, extraClass = "") {
  const icon = intent === "delete"
    ? '<span aria-hidden="true">&times;</span>'
    : '<span aria-hidden="true">+</span>';
  return `
    <button
      class="sequence-edit-dot sequence-edit-dot-${intent} ${extraClass}"
      type="button"
      data-action="sequence-edit"
      data-scope="${escapeHtml(scope)}"
      data-intent="${escapeHtml(intent)}"
      data-index="${targetIndex}"
      title="${escapeHtml(label)}"
      aria-label="${escapeHtml(label)}"
    >${icon}</button>
  `;
}

function renderSequenceMeasureMenu(bar) {
  return `
    <details class="sequence-measure-menu">
      <summary class="sequence-edit-dot sequence-edit-dot-config" title="Measure options" aria-label="Measure options for bar ${bar.index + 1}">
        <span aria-hidden="true">?</span>
      </summary>
      <div class="sequence-measure-popover">
        ${renderSequenceMeasureBranch("Beats", String(bar.beats), "beats", bar.index, bar.beats, SEQUENCE_BAR_BEAT_OPTIONS)}
        ${renderSequenceMeasureBranch("Beat", formatSequenceBeat(bar.columnsPerBeat), "columnsPerBeat", bar.index, bar.columnsPerBeat, SEQUENCE_BEAT_COLUMN_OPTIONS)}
      </div>
    </details>
  `;
}

function renderSequenceMeasureBranch(label, currentLabel, setting, barIndex, currentValue, values) {
  return `
    <div class="sequence-measure-branch">
      <div class="sequence-measure-parent">
        <span>${label}</span>
        <strong>${escapeHtml(currentLabel)}</strong>
        <em aria-hidden="true">›</em>
      </div>
      <div class="sequence-measure-submenu">
        ${values.map((value) => `
          <button
            type="button"
            class="sequence-measure-option"
            data-action="sequence-bar-setting"
            data-index="${barIndex}"
            data-setting="${setting}"
            data-value="${value}"
            aria-pressed="${value === currentValue}"
          >${escapeHtml(setting === "beats" ? String(value) : formatSequenceBeat(value))}</button>
        `).join("")}
      </div>
    </div>
  `;
}

function renderSequenceBeatHeader(bars) {
  return `
    <div class="sequence-grid-row sequence-beats-row">
      <div class="sequence-row-label">Beat</div>
      ${bars.flatMap((bar) => Array.from({ length: bar.beats }, (_, beatIndex) => `
        <div class="sequence-beat-label" style="grid-column:${bar.startColumn + beatIndex * bar.columnsPerBeat + 2} / span ${bar.columnsPerBeat}">
          <strong>${beatIndex + 1}</strong><span>${formatSequenceBeat(bar.columnsPerBeat)}</span>
        </div>
      `)).join("")}
      ${bars.map((bar) => `
        <span class="sequence-bar-rule" style="grid-column:${bar.startColumn + 2}"></span>
      `).join("")}
    </div>
  `;
}

function renderSequenceInstrumentRow(line, instrument, instrumentIndex, totalColumns, beatStartColumns, barStartColumns) {
  return `
    <div class="sequence-grid-row sequence-instrument-row">
      <div class="sequence-instrument-label" draggable="true" data-action="sequence-instrument-drag" data-index="${instrumentIndex}">
        ${renderSequenceInstrumentMenu({
          mode: "change",
          label: instrument.name,
          index: instrumentIndex,
          currentSounds: instrument.sounds,
          options: getSequenceInstrumentOptions(state.assets.sequence.model),
          disabledTitle: "No unused instruments in the selected sounds file."
        })}
      </div>
      ${Array.from({ length: totalColumns }, (_, column) => renderSequenceCell(instrument, line, column, beatStartColumns, barStartColumns)).join("")}
    </div>
  `;
}

function renderSequenceInstrumentAddRow(sequence, totalColumns) {
  const hasSounds = state.assets.sounds.model != null;
  const options = getSequenceInstrumentOptions(sequence);
  const title = hasSounds
    ? "All selected sounds file instruments are already in the grid."
    : "Select a sounds file before adding instruments.";

  return `
    <div class="sequence-grid-row sequence-instrument-add-row ${options.length === 0 ? "disabled" : ""}">
      <div class="sequence-instrument-add-label">
        ${renderSequenceInstrumentMenu({
          mode: "add",
          label: "+",
          options,
          disabledTitle: title
        })}
      </div>
      <div class="sequence-instrument-add-fill" style="grid-column:2 / span ${totalColumns}" aria-hidden="true"></div>
    </div>
  `;
}

function renderSequenceInstrumentMenu({ mode, label, index = null, currentSounds = [], options, disabledTitle }) {
  if (options.length === 0) {
    return `
      <button class="sequence-instrument-trigger disabled" type="button" disabled title="${escapeHtml(disabledTitle)}">
        ${mode === "change" ? `<span class="sequence-drag-grip" aria-hidden="true">≡</span>` : ""}
        <strong>${escapeHtml(label)}</strong>
        ${mode === "change" ? renderSequenceSymbolChips(currentSounds) : ""}
      </button>
    `;
  }

  return `
    <details class="sequence-instrument-menu">
      <summary class="sequence-instrument-trigger" title="${escapeHtml(mode === "add" ? "Add instrument" : "Change instrument")}">
        ${mode === "change" ? `<span class="sequence-drag-grip" aria-hidden="true">≡</span>` : ""}
        <strong>${escapeHtml(label)}</strong>
        ${mode === "change" ? renderSequenceSymbolChips(currentSounds) : ""}
      </summary>
      <div class="sequence-instrument-popover">
        ${options.map((option) => `
          <button
            type="button"
            class="sequence-instrument-option"
            data-action="sequence-instrument-option"
            data-intent="${mode}"
            data-index="${index ?? ""}"
            data-name="${escapeHtml(option.name)}"
          >
            <span>${escapeHtml(option.name)}</span>
            ${renderSequenceSymbolChips(option.sounds)}
          </button>
        `).join("")}
      </div>
    </details>
  `;
}

function getSequenceInstrumentOptions(sequence) {
  const sounds = state.assets.sounds.model;
  if (sounds == null || sequence == null) {
    return [];
  }

  const used = new Set(sequence.instruments);
  return buildSoundGroups(sounds)
    .filter((group) => !used.has(group.name))
    .map((group) => ({
      name: group.name,
      sounds: group.entries.map(({ sound }) => sound)
    }));
}

function renderSequenceSymbolChips(sounds) {
  if (sounds.length === 0) {
    return "";
  }

  return `
    <span class="sequence-symbol-list">
      ${sounds.map((sound) => `
        <span class="sequence-symbol-chip" style="${sound.color == null ? "" : `--symbol-color:${escapeHtml(sound.color)}`}" title="${escapeHtml(sound.name)} ${escapeHtml(sound.symbol)}">
          ${escapeHtml(sound.symbol)}
        </span>
      `).join("")}
    </span>
  `;
}

function renderSequenceCell(instrument, line, column, beatStartColumns, barStartColumns) {
  const rawSymbol = line[column] ?? "";
  const symbol = rawSymbol === "-" ? "" : rawSymbol;
  const active = symbol !== "" && symbol !== " ";
  const sound = active ? findSequenceCellSound(instrument.sounds, symbol) : null;
  const color = sound?.color ?? getFallbackInstrumentColor(instrument.sounds);
  const classes = [
    "sequence-cell",
    active ? "active" : "empty",
    sound == null && active ? "unknown" : "",
    sound?.symbol === "#" && /^[0-9]$/.test(symbol) ? "scaled" : "",
    beatStartColumns.has(column) ? "beat-start" : "",
    barStartColumns.has(column) ? "bar-start" : ""
  ].filter(Boolean).join(" ");
  const title = active
    ? `${instrument.name} ${symbol}`
    : `${instrument.name} rest`;

  return `
    <div class="${classes}" style="${color == null ? "" : `--cell-color:${escapeHtml(color)}`}" title="${escapeHtml(title)}">
      ${active ? escapeHtml(symbol) : ""}
    </div>
  `;
}

function findSequenceCellSound(sounds, symbol) {
  return sounds.find((sound) => sound.symbol === symbol)
    ?? (/^[0-9]$/.test(symbol) ? sounds.find((sound) => sound.symbol === "#") : null)
    ?? null;
}

function getFallbackInstrumentColor(sounds) {
  return sounds.find((sound) => sound.color != null)?.color ?? null;
}

function normalizeColumnsPerBeat(value) {
  return Number.isInteger(value) && value > 0 ? value : SEQUENCE_DEFAULT_COLUMNS_PER_BEAT;
}

function formatSequenceBeat(columnsPerBeat) {
  const value = normalizeColumnsPerBeat(columnsPerBeat);
  const labels = new Map([
    [1, "quarter"],
    [2, "8th"],
    [4, "16th"],
    [8, "32nd"],
    [16, "64th"]
  ]);

  return labels.get(value) ?? `${value}/beat`;
}

function formatSequenceZoomLabel(cellSize) {
  return `${Math.round(cellSize / SEQUENCE_DEFAULT_CELL_SIZE * 100)}%`;
}

function describeSequenceSongSource(song) {
  const reasons = {
    play: "from play keyword",
    longestSequence: "longest sequence",
    fallbackLongestSequence: "fallback to longest sequence",
    longestTab: "longest tab",
    fallbackLongestTab: "fallback to longest tab",
    none: "no source"
  };
  const reason = reasons[song.selectionReason] ?? song.selectionReason;
  const truncated = song.truncated ? " truncated" : "";

  return song.entryName == null
    ? reason
    : `${song.entryName} (${reason}, ${song.segments.length} fragments${truncated})`;
}

function formatTempoLabel(value) {
  return `${Number.isInteger(value) ? value : Number(value.toFixed(3))} BPM`;
}

function renderSoundProgramView(library) {
  if (library == null || library.sounds.length === 0) {
    return `
      <div class="sounds-empty">
        <strong>No sounds loaded</strong>
        <span>Open a sounds file or switch to Text to sketch one in.</span>
        <button class="mini-add text-add" data-action="add-sound" title="Add sound">+</button>
      </div>
    `;
  }

  const groups = buildSoundGroups(library);
  const selected = getSelectedSound(library);

  return `
    <div class="sound-program">
      <aside class="sound-name-browser" aria-label="Sounds by tablature name">
        ${groups.map((group) => renderSoundGroup(group, selected.index)).join("")}
        <button class="mini-add sound-list-add" data-action="add-sound" title="Add sound">+</button>
      </aside>
      <section class="sound-detail">
        ${renderSoundDetail(selected.sound)}
      </section>
    </div>
  `;
}

function renderSoundGroup(group, selectedIndex) {
  return `
    <div class="sound-group">
      <div class="sound-group-name">
        <strong>${escapeHtml(group.name)}</strong>
        <span>${group.entries.length}</span>
      </div>
      <div class="sound-variants">
        ${group.entries.map(({ sound, index }) => `
          <button class="sound-variant ${index === selectedIndex ? "active" : ""}" data-action="select-sound" data-index="${index}">
            <span class="variant-symbol">${escapeHtml(sound.symbol)}</span>
            <span class="variant-meta">
              ${renderColorDot(sound.color)}
              ${sound.key == null ? "auto" : `B${sound.key}`}
            </span>
          </button>
        `).join("")}
        <button class="mini-add variant-add" data-action="add-symbol" data-name="${escapeHtml(group.name)}" title="Add symbol for ${escapeHtml(group.name)}">+</button>
      </div>
    </div>
  `;
}

function renderSoundDetail(sound) {
  const scaled = sound.symbol === "#";
  const maxQuanta = getSoundMaxQuanta(sound);
  const laneMarkup = sound.channels.length === 0
    ? `<div class="empty lane-empty">No CV outputs yet</div>`
    : sound.channels.map((channel, channelIndex) => renderOutputLane(sound, channel, maxQuanta, channelIndex)).join("");

  return `
    <div class="sound-detail-header">
      <div>
        <div class="sound-kicker">Tablature row</div>
        <input class="sound-name-input" data-action="sound-name" value="${escapeHtml(sound.name)}" aria-label="Tablature row">
      </div>
      <div class="sound-meta-strip">
        <label class="sound-pill editable ${scaled ? "scaled" : ""}">
          <span>Symbol</span>
          <input class="sound-pill-input symbol" data-action="sound-meta" data-field="symbol" value="${escapeHtml(sound.symbol)}" maxlength="1" aria-label="Sound symbol">
        </label>
        <label class="sound-pill editable">
          <span>Color</span>
          <input class="sound-pill-input color" data-action="sound-meta" data-field="color" value="${escapeHtml(sound.color ?? "")}" placeholder="auto" aria-label="Sound color">
        </label>
        <label class="sound-pill editable">
          <span>Button</span>
          <input class="sound-pill-input button-id" data-action="sound-meta" data-field="key" value="${sound.key == null ? "" : sound.key}" placeholder="auto" aria-label="Button id">
        </label>
        <div class="sound-pill length-pill">
          <span>Length</span>
          <strong>${formatQuantaLength(maxQuanta)}</strong>
        </div>
      </div>
    </div>
    <div class="lane-stack">
      ${laneMarkup}
      <button class="mini-add channel-add" data-action="add-channel" title="Add CV channel">+</button>
    </div>
  `;
}

function renderOutputLane(sound, channel, maxQuanta, channelIndex) {
  const label = classifyChannel(channel);
  const noteKey = getSoundNoteKey(sound, channel);
  const note = state.soundNotes[noteKey] ?? channel.note ?? "";
  const values = Array.from({ length: maxQuanta }, (_, index) => renderValueToken(channel.values[index])).join("");
  const trigger = isTriggerChannel(channel);
  const showValues = maxQuanta <= VALUE_ROW_MAX_QUANTA;

  return `
    <article class="output-lane">
      <button class="channel-remove" data-action="remove-channel" data-channel-index="${channelIndex}" title="Remove channel"></button>
      <div class="lane-id">
        <strong>Mod${channel.module + 1}, Ch${channel.channel + 1}</strong>
        <span>${label}</span>
        <input class="lane-note" data-action="sound-note" data-channel-index="${channelIndex}" data-note-key="${escapeHtml(noteKey)}" value="${escapeHtml(note)}" placeholder="Note">
        <label class="trigger-toggle">
          <input type="checkbox" data-action="toggle-trigger" data-channel-index="${channelIndex}" ${trigger ? "checked" : ""}>
          <span>Trigger</span>
        </label>
      </div>
      <div class="lane-body">
        <div class="lane-timeline ${showValues ? "" : "no-values"}" style="--quanta:${maxQuanta}">
          ${renderChannelTimeline(channel, maxQuanta, channelIndex)}
          ${showValues ? `
            <div class="value-row">
              ${trigger ? renderValueToken(channel.values[0]) : values}
            </div>
          ` : ""}
        </div>
      </div>
      <div class="lane-count">
        <strong>${channel.values.length}</strong>
        <span>quanta</span>
      </div>
    </article>
  `;
}

function renderChannelTimeline(channel, maxQuanta, channelIndex) {
  if (isTriggerChannel(channel)) {
    return `
      <div class="trigger-lane">
        <span class="trigger-dot"></span>
        <strong>Trigger</strong>
      </div>
    `;
  }

  return renderEnvelope(channel.values, maxQuanta, channelIndex);
}

function renderEnvelope(values, maxQuanta, channelIndex) {
  const samples = Array.from({ length: maxQuanta }, (_, index) => values[index] ?? null);
  const points = samples.map((value, index) => `${timelineX(index, maxQuanta)},${timelineY(value)}`).join(" ");
  const markers = samples.map((value, index) => {
    const className = value == null ? "rest" : value.kind === "trigger" ? "trigger" : value.kind === "scaled" ? "scaled" : "";
    return `
      <span class="envelope-point ${className}" style="left:${timelineX(index, maxQuanta)}%;top:${timelineY(value)}%" title="${escapeHtml(formatCvValue(value))}"></span>
    `;
  }).join("");

  return `
    <div class="envelope-frame" data-action="envelope-drag" data-channel-index="${channelIndex}" aria-label="CV envelope" role="img">
      <svg class="envelope" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line class="envelope-guide top" x1="0" y1="8" x2="100" y2="8"></line>
        <line class="envelope-guide mid" x1="0" y1="52" x2="100" y2="52"></line>
        <line class="envelope-guide base" x1="0" y1="96" x2="100" y2="96"></line>
        <polyline class="envelope-path" points="${points}"></polyline>
      </svg>
      ${markers}
    </div>
  `;
}

function renderValueToken(value) {
  if (value == null) {
    return `<span class="value-token rest" title="returns to 0">0</span>`;
  }

  const className = value.kind === "trigger" ? "trigger" : value.kind === "scaled" ? "scaled" : "";
  return `<span class="value-token ${className}">${escapeHtml(formatCvValue(value))}</span>`;
}

function renderButtonMapView(library) {
  if (library == null || library.sounds.length === 0) {
    return `
      <div class="sounds-empty">
        <strong>No sounds loaded</strong>
        <span>Button assignments will appear here once the file has sounds.</span>
      </div>
    `;
  }

  const assigned = new Map();
  for (const sound of library.sounds) {
    if (sound.key == null) {
      continue;
    }
    if (!assigned.has(sound.key)) {
      assigned.set(sound.key, []);
    }
    assigned.get(sound.key).push(sound);
  }

  return `
    <div class="button-map">
      ${Array.from({ length: 32 }, (_, index) => {
        const buttonId = index + 1;
        const sounds = assigned.get(buttonId) ?? [];
        const primary = sounds[0] ?? null;
        return `
          <div class="pad-button ${sounds.length > 0 ? "assigned" : ""}" style="${primary?.color ? `--pad-color:${escapeHtml(primary.color)}` : ""}">
            <span>${buttonId}</span>
            <strong>${primary == null ? "" : escapeHtml(primary.name)}</strong>
            <small>${sounds.map((sound) => escapeHtml(sound.symbol)).join(" ")}</small>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function buildSoundGroups(library) {
  const groups = [];
  const groupByName = new Map();

  library.sounds.forEach((sound, index) => {
    if (!groupByName.has(sound.name)) {
      const group = { name: sound.name, entries: [] };
      groupByName.set(sound.name, group);
      groups.push(group);
    }
    groupByName.get(sound.name).entries.push({ sound, index });
  });

  return groups;
}

function getSelectedSound(library) {
  const index = Math.min(Math.max(state.selectedSoundIndex, 0), library.sounds.length - 1);
  return {
    index,
    sound: library.sounds[index]
  };
}

function getActiveSound() {
  return state.assets.sounds.model?.sounds[state.selectedSoundIndex] ?? null;
}

function ensureSoundLibrary() {
  const asset = state.assets.sounds;
  if (asset.model != null) {
    return asset.model;
  }

  const result = parseSoundLibrary("");
  asset.model = result.library;
  asset.diagnostics = result.diagnostics;
  asset.text = "";
  asset.fileName = asset.fileName ?? "new_sounds.txt";
  asset.libraryName = asset.libraryName || "new_sounds.txt";
  return asset.model;
}

function createSound(name, symbol) {
  return {
    name,
    symbol,
    key: null,
    color: null,
    channels: []
  };
}

function nextAvailableSoundName(library) {
  const names = new Set(library.sounds.map((sound) => sound.name));
  if (!names.has("sound")) {
    return "sound";
  }

  for (let index = 2; index < 1000; index += 1) {
    const name = `sound${index}`;
    if (!names.has(name)) {
      return name;
    }
  }

  return `sound${library.sounds.length + 1}`;
}

function nextAvailableOutput(sound) {
  const used = new Set(sound.channels.map((channel) => `${channel.module}:${channel.channel}`));
  for (let module = 0; module < 8; module += 1) {
    for (let channel = 0; channel < 8; channel += 1) {
      if (!used.has(`${module}:${channel}`)) {
        return { module, channel };
      }
    }
  }

  return { module: 0, channel: 0 };
}

function createDefaultValues(kind) {
  if (kind === "trigger") {
    return [{ kind: "trigger" }];
  }

  if (kind === "scaled") {
    return [{ kind: "scaled" }];
  }

  return [{ kind: "value", value: 0 }];
}

function nextAvailableSymbol(library, name) {
  return SYMBOL_CANDIDATES.find((symbol) => !soundSymbolExists(library, name, symbol)) ?? null;
}

function soundSymbolExists(library, name, symbol) {
  return library.sounds.some((sound) => sound.name === name && sound.symbol === symbol);
}

function wouldDuplicateSound(library, selectedIndex, name, symbol) {
  return library.sounds.some((sound, index) => index !== selectedIndex && sound.name === name && sound.symbol === symbol);
}

function findLastSoundIndexByName(library, name) {
  let index = -1;
  library.sounds.forEach((sound, soundIndex) => {
    if (sound.name === name) {
      index = soundIndex;
    }
  });
  return index;
}

function normalizeSoundColor(value) {
  if (value === "" || value.toLowerCase() === "auto") {
    return null;
  }

  const lower = value.toLowerCase();
  if (SOUND_NAMED_COLORS.has(lower)) {
    return lower;
  }

  if (SOUND_RGB_COLOR_PATTERN.test(value)) {
    return value;
  }

  return undefined;
}

function normalizeButtonKey(value) {
  if (value === "" || value.toLowerCase() === "auto") {
    return null;
  }

  const key = Number.parseInt(value, 10);
  return String(key) === value && key >= 1 && key <= 32 ? key : undefined;
}

function promptInteger(label, defaultValue, min, max) {
  const value = window.prompt(label, defaultValue);
  if (value == null) {
    return null;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    addActivity(`${label} must be ${min}..${max}.`, "error");
    render();
    return null;
  }

  return parsed;
}

function normalizeChannelKind(value) {
  if (value == null) {
    return null;
  }

  const kind = value.trim().toLowerCase();
  if (["envelope", "scaled", "trigger"].includes(kind)) {
    return kind;
  }

  addActivity("Channel type must be envelope, scaled, or trigger.", "error");
  render();
  return null;
}

function classifyChannel(channel) {
  if (channel.values.length === 1 && channel.values[0].kind === "trigger") {
    return "trigger";
  }

  if (channel.values.every((value) => value.kind === "scaled")) {
    return "scale";
  }

  if (channel.values.some((value) => value.kind === "scaled")) {
    return "scaled CV";
  }

  return "CV envelope";
}

function isTriggerChannel(channel) {
  return channel.values.length === 1 && channel.values[0]?.kind === "trigger";
}

function isScaledChannel(channel) {
  return channel.values.length > 0 && channel.values.every((value) => value.kind === "scaled");
}

function getSoundMaxQuanta(sound) {
  return Math.max(1, ...sound.channels.map((channel) => channel.values.length));
}

function formatQuantaLength(value) {
  return value === 1 ? "1 quantum" : `${value} quanta`;
}

function valueToPercent(value) {
  if (value == null) {
    return 0;
  }

  if (value.kind === "trigger") {
    return 100;
  }

  if (value.kind === "scaled") {
    return 64;
  }

  return value.value;
}

function formatCvValue(value) {
  if (value == null) {
    return "0";
  }

  if (value.kind === "trigger") {
    return "T";
  }

  if (value.kind === "scaled") {
    return "N";
  }

  return Number.isInteger(value.value) ? String(value.value) : String(Number(value.value.toFixed(3)));
}

function getSoundNoteKey(sound, channel) {
  return `${sound.name}:${sound.symbol}:${channel.module}:${channel.channel}`;
}

function timelineX(index, quanta) {
  return ((index + 0.5) / quanta * 100).toFixed(3);
}

function timelineY(value) {
  return (96 - valueToPercent(value) * 0.88).toFixed(3);
}

function dragIndexFromEvent(event, rect, maxQuanta) {
  const stepWidth = rect.width / maxQuanta;
  const offset = Math.min(Math.max(event.clientX - rect.left, 0), Math.max(0, rect.width - 0.001));

  return Math.min(maxQuanta - 1, Math.floor(offset / stepWidth));
}

function dragValueFromEvent(event, rect) {
  const ratio = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  return Math.round(ratio * 100);
}

function renderColorDot(color) {
  if (color == null) {
    return `<span class="color-dot auto"></span>`;
  }

  return `<span class="color-dot" style="--dot-color:${escapeHtml(color)}"></span>`;
}

function renderTab(type, config) {
  const asset = state.assets[type];
  const status = asset.model == null ? "empty" : hasErrors(asset.diagnostics) ? "error" : "ok";
  const active = type === state.activeType ? "active" : "";
  return `
    <button class="rail-tab ${active}" data-action="select-type" data-type="${type}">
      <span>${config.label}</span>
      <span class="status ${status}"></span>
    </button>
  `;
}

function renderActivityLog() {
  const latestId = state.messages.at(-1)?.id ?? null;
  const rows = state.messages.length === 0
    ? `<div class="feedback-empty">No activity yet</div>`
    : [...state.messages].reverse().map((message) => `
        <div class="feedback-row ${message.id === latestId ? "latest" : ""} ${message.tone}">
          <span>#${message.id}</span>
          <p>${escapeHtml(message.text)}</p>
        </div>
      `).join("");

  return `
    <section class="feedback-log" role="log" aria-live="polite" aria-label="Activity log">
      <div class="feedback-header">
        <span>Activity</span>
        <small>Newest first</small>
      </div>
      <div class="feedback-body">
        ${rows}
      </div>
    </section>
  `;
}

function renderLibrary() {
  if (state.library == null) {
    return `
      <section class="panel">
        <div class="panel-title-row">
          <h2>Library</h2>
          <button class="icon-button" title="Hide library" data-action="toggle-library-panel">›</button>
        </div>
        <div class="empty">Library unavailable</div>
      </section>
    `;
  }

  const activeConfig = ASSET_TYPES[state.activeType];
  const files = getLibraryFilesForActiveType();
  const rows = files.length === 0
    ? `<div class="empty">No ${activeConfig.label.toLowerCase()} files</div>`
    : files.map((file) => `
        <button class="library-row" data-action="open-library" data-name="${escapeHtml(file.name)}">
          <span>${escapeHtml(file.name)}</span>
          <small>${file.exists ? `${file.bytes} bytes` : "missing"}</small>
        </button>
      `).join("");

  return `
    <section class="panel">
      <div class="panel-title-row">
        <h2>Library</h2>
        <div class="panel-actions">
          <button class="icon-button" title="Refresh library" data-action="refresh-library">↻</button>
          <button class="icon-button" title="Hide library" data-action="toggle-library-panel">›</button>
        </div>
      </div>
      <div class="library-root">${escapeHtml(state.library.root)}</div>
      <div class="library-meta">${escapeHtml(state.library.envVar)} · ${escapeHtml(state.library.source)}</div>
      <div class="library-list">${rows}</div>
    </section>
  `;
}

function renderLibraryReveal() {
  return `
    <button class="library-reveal" type="button" data-action="toggle-library-panel" title="Show library">
      <span>‹</span>
      <strong>Library</strong>
    </button>
  `;
}

function renderDiagnosticsRows(diagnostics) {
  const rows = diagnostics.length === 0
    ? `<div class="empty">Clean</div>`
    : diagnostics.map((diagnostic) => `
        <div class="diag ${diagnostic.severity}">
          <span>${diagnostic.severity}</span>
          <p>${escapeHtml(diagnosticLabel(diagnostic))}</p>
        </div>
      `).join("");

  return rows;
}

function renderDiagnosticsDialog() {
  if (!state.diagnosticsOpen) {
    return "";
  }

  const diagnostics = state.assets.sequence.diagnostics;
  const status = getDiagnosticsStatus(diagnostics);
  return `
    <div class="modal-backdrop" data-action="close-diagnostics-report">
      <section class="diagnostics-modal" role="dialog" aria-modal="true" aria-label="Sequence diagnostics" data-action="diagnostics-modal">
        <div class="save-as-header">
          <div>
            <h2>Sequence Diagnostics</h2>
            <p class="diagnostics-${status.level}">${escapeHtml(status.label)}</p>
          </div>
          <button class="button subtle" data-action="close-diagnostics-report">Close</button>
        </div>
        <div class="diagnostics-body">
          <div class="diag-list">${renderDiagnosticsRows(diagnostics)}</div>
        </div>
      </section>
    </div>
  `;
}

function renderAssetPreview(asset) {
  if (asset.model == null) {
    return "";
  }

  if (state.activeType === "sounds") {
    return renderSoundsPreview(asset.model);
  }

  if (state.activeType === "sequence") {
    return "";
  }

  return renderConfigPreview(asset.model);
}

function renderSoundsPreview(library) {
  const rows = library.sounds.map((sound) => `
    <tr>
      <td>${escapeHtml(sound.name)}</td>
      <td><code>${escapeHtml(sound.symbol)}</code></td>
      <td>${sound.key ?? ""}</td>
      <td>${renderColor(sound.color)}</td>
      <td>${sound.channels.length}</td>
    </tr>
  `).join("");

  return `
    <section class="panel">
      <div class="panel-title-row">
        <h2>Sounds</h2>
        <button class="button subtle" data-action="show-patch-view">Patch View</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Sym</th><th>Key</th><th>Color</th><th>CV</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderPatchOverlay(active) {
  if (!state.showPatchView || state.activeType !== "sounds" || active.model == null) {
    return "";
  }

  const patchMap = buildPatchMap(active.model);
  const modules = Array.from({ length: 8 }, (_, index) => 8 - index);

  return `
    <div class="modal-backdrop" data-action="close-patch-view">
      <section class="patch-modal" role="dialog" aria-modal="true" aria-label="AIF patch view" data-action="patch-modal">
        <div class="patch-header">
          <div>
            <h2>AIF Patch View</h2>
            <p>${patchMap.usedModules.size} AIF modules, ${patchMap.usedOutputs.size} CV outputs</p>
          </div>
          <button class="button" data-action="close-patch-view">Close</button>
        </div>
        <div class="patch-body">
          <div class="aif-stack">
            ${modules.map((aifNumber) => renderAifModule(aifNumber, patchMap)).join("")}
          </div>
          <div class="patch-list">
            <h3>Wiring</h3>
            ${renderPatchList(patchMap)}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderSequenceSaveAsDialog() {
  if (!state.sequenceSaveAs.open || state.activeType !== "sequence") {
    return "";
  }

  const name = state.sequenceSaveAs.name;
  const existingFile = getLibraryFilesForActiveType().some((file) => file.name === name.trim());
  const message = state.sequenceSaveAs.error !== ""
    ? `<div class="save-as-message error">${escapeHtml(state.sequenceSaveAs.error)}</div>`
    : existingFile
      ? `<div class="save-as-message">Existing library file will be replaced.</div>`
      : "";

  return `
    <div class="modal-backdrop" data-action="close-sequence-save-as">
      <section class="save-as-modal" role="dialog" aria-modal="true" aria-label="Save sequence as" data-action="sequence-save-as-modal">
        <div class="save-as-header">
          <h2>Save Sequence As</h2>
          <button class="button subtle" data-action="close-sequence-save-as">Cancel</button>
        </div>
        <div class="save-as-body">
          <label class="name-field save-as-name">
            <span>Library name</span>
            <input data-action="sequence-save-as-name" value="${escapeHtml(name)}" autocomplete="off">
          </label>
          ${message}
          <div class="save-as-actions">
            <button class="button primary" data-action="confirm-sequence-save-as">Save As</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderAifModule(aifNumber, patchMap) {
  const outputs = Array.from({ length: 8 }, (_, index) => index + 1);
  const active = patchMap.usedModules.has(aifNumber);
  const red = aifNumber === 1 ? "base" : "";

  return `
    <div class="aif-module ${active ? "active" : ""} ${red}">
      <div class="aif-label">AIF ${aifNumber}</div>
      <div class="aif-outputs">
        ${outputs.map((outputNumber) => renderAifOutput(aifNumber, outputNumber, patchMap)).join("")}
      </div>
    </div>
  `;
}

function renderAifOutput(aifNumber, outputNumber, patchMap) {
  const key = `${aifNumber}:${outputNumber}`;
  const patches = patchMap.outputs.get(key) ?? [];
  const oddEven = outputNumber % 2 === 1 ? "odd" : "even";
  const title = patches.length === 0
    ? `AIF ${aifNumber} output ${outputNumber}`
    : patches.map((patch) => `${patch.sound}.${patch.symbol}`).join(", ");

  return `
    <div class="aif-output ${patches.length > 0 ? "patched" : ""} ${oddEven}" title="${escapeHtml(title)}">
      <span>${outputNumber}</span>
    </div>
  `;
}

function renderPatchList(patchMap) {
  if (patchMap.rows.length === 0) {
    return `<div class="empty">No CV outputs in use</div>`;
  }

  return patchMap.rows.map((row) => `
    <div class="patch-row">
      <strong>AIF ${row.aif} · Out ${row.output}</strong>
      <span>${row.patches.map((patch) => escapeHtml(`${patch.sound} ${patch.symbol}`)).join(", ")}</span>
    </div>
  `).join("");
}

function renderConfigPreview(config) {
  const rows = config.sections.slice(0, 10).map((section) => `
    <tr>
      <td>${escapeHtml(section.name)}</td>
      <td>${section.entries.length}</td>
    </tr>
  `).join("");

  return `
    <section class="panel">
      <h2>Sections</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Settings</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function bindEvents() {
  app.querySelector("[data-action='enter-splash']")?.addEventListener("click", dismissSplash);
  if (state.splashVisible) {
    app.querySelector("[data-action='enter-splash']")?.focus();
  }

  bindMenuControls();

  app.querySelectorAll("[data-action='select-type']").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeType = button.dataset.type;
      render();
    });
  });

  app.querySelector("[data-action='source']")?.addEventListener("input", (event) => {
    const selectionStart = event.target.selectionStart;
    const selectionEnd = event.target.selectionEnd;
    updateActiveText(event.target.value, state.assets[state.activeType].fileName, state.assets[state.activeType].libraryName);
    render();
    const textarea = app.querySelector("[data-action='source']");
    textarea?.focus();
    textarea?.setSelectionRange(selectionStart, selectionEnd);
  });

  app.querySelector("[data-action='library-name']")?.addEventListener("input", (event) => {
    state.assets[state.activeType].libraryName = event.target.value.trim();
  });

  app.querySelector("[data-action='load-file']").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (file == null) {
      return;
    }

    updateActiveText(await file.text(), file.name, file.name);
    event.target.value = "";
    addActivity(`Uploaded ${file.name} from this computer.`);
    render();
  });

  app.querySelector("[data-action='new-file']").addEventListener("click", () => {
    closeMenus();
    state.assets[state.activeType] = createNewAsset(state.activeType);
    if (state.activeType === "sequence") {
      resetSequenceHistory();
    }
    state.soundNotes = {};
    addActivity("Started a new file.");
    render();
  });

  app.querySelector("[data-action='download-current']").addEventListener("click", async () => {
    closeMenus();
    await downloadActiveFile();
  });

  app.querySelector("[data-action='save-library']").addEventListener("click", () => {
    closeMenus();
    saveActiveToLibrary();
  });
  app.querySelector("[data-action='sequence-save-as']")?.addEventListener("click", openSequenceSaveAsDialog);

  app.querySelector("[data-action='show-patch-view']")?.addEventListener("click", () => {
    state.showPatchView = true;
    render();
  });

  app.querySelectorAll("[data-action='toggle-library-panel']").forEach((button) => {
    button.addEventListener("click", () => {
      state.libraryVisible = !state.libraryVisible;
      render();
    });
  });

  app.querySelector("[data-action='open-diagnostics-report']")?.addEventListener("click", () => {
    state.diagnosticsOpen = true;
    render();
  });

  app.querySelectorAll("[data-action='sounds-view']").forEach((button) => {
    button.addEventListener("click", () => {
      state.soundsView = button.dataset.view;
      render();
    });
  });

  app.querySelectorAll("[data-action='sequence-view']").forEach((button) => {
    button.addEventListener("click", () => {
      setSequenceView(button.dataset.view);
    });
  });

  app.querySelector("[data-action='sequence-sounds-file']")?.addEventListener("change", async (event) => {
    const name = event.target.value;
    if (name === "" || name === getActiveSoundsName()) {
      return;
    }

    await openSoundsForSequence(name);
  });

  app.querySelectorAll("[data-action='sequence-zoom']").forEach((button) => {
    button.addEventListener("click", () => {
      changeSequenceZoom(Number(button.dataset.delta));
    });
  });

  app.querySelectorAll("[data-action='sequence-edit']").forEach((button) => {
    button.addEventListener("click", () => {
      applySequenceGridEdit(button.dataset.scope, button.dataset.intent, Number(button.dataset.index));
    });
  });

  app.querySelectorAll("[data-action='sequence-bar-setting']").forEach((button) => {
    button.addEventListener("click", () => {
      applySequenceBarSetting(Number(button.dataset.index), button.dataset.setting, Number(button.dataset.value));
    });
  });

  app.querySelectorAll("[data-action='sequence-instrument-option']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      applySequenceInstrumentEdit(button.dataset.intent, button.dataset.index, button.dataset.name);
    });
  });
  bindSequenceInstrumentDrag();

  app.querySelectorAll("[data-action='select-sound']").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSoundIndex = Number(button.dataset.index);
      render();
    });
  });

  app.querySelectorAll("[data-action='add-sound']").forEach((button) => {
    button.addEventListener("click", addSound);
  });

  app.querySelectorAll("[data-action='add-symbol']").forEach((button) => {
    button.addEventListener("click", () => addSoundSymbol(button.dataset.name));
  });

  app.querySelectorAll("[data-action='add-channel']").forEach((button) => {
    button.addEventListener("click", addChannelToSelectedSound);
  });

  app.querySelectorAll("[data-action='remove-channel']").forEach((button) => {
    button.addEventListener("click", () => removeChannelFromSelectedSound(Number(button.dataset.channelIndex)));
  });

  app.querySelectorAll("[data-action='toggle-trigger']").forEach((input) => {
    input.addEventListener("change", (event) => {
      toggleChannelTrigger(Number(event.target.dataset.channelIndex), event.target.checked);
    });
  });

  app.querySelector("[data-action='sound-name']")?.addEventListener("change", (event) => {
    updateSelectedSoundName(event.target.value);
  });

  app.querySelectorAll("[data-action='sound-meta']").forEach((input) => {
    input.addEventListener("change", (event) => {
      updateSelectedSoundMeta(event.target.dataset.field, event.target.value);
    });
  });

  app.querySelectorAll("[data-action='sound-note']").forEach((input) => {
    input.addEventListener("input", (event) => {
      updateSoundChannelNote(event.target.dataset.noteKey, Number(event.target.dataset.channelIndex), event.target.value);
    });
  });

  app.querySelectorAll("[data-action='envelope-drag']").forEach((frame) => {
    frame.addEventListener("pointerdown", (event) => startEnvelopeDrag(event, frame));
  });

  app.querySelectorAll("[data-action='close-patch-view']").forEach((element) => {
    element.addEventListener("click", () => {
      state.showPatchView = false;
      render();
    });
  });

  app.querySelector("[data-action='patch-modal']")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  app.querySelectorAll("[data-action='open-library']").forEach((button) => {
    button.addEventListener("click", () => openLibraryFile(button.dataset.name));
  });

  app.querySelector("[data-action='refresh-library']")?.addEventListener("click", async () => {
    await refreshLibrary();
    addActivity(`${getLibraryLabel()} refreshed.`);
    render();
  });

  bindSequenceSaveAsDialog();
  bindLibraryOpenDialog();
  bindDiagnosticsDialog();
  bindSequenceScrollControls();
}

function bindMenuControls() {
  app.querySelectorAll(".app-menu, .sequence-measure-menu, .sequence-instrument-menu").forEach((menu) => {
    menu.addEventListener("toggle", () => {
      if (menu.open) {
        closeMenus(menu);
        positionSequenceInstrumentMenu(menu);
      } else {
        resetSequenceInstrumentMenuPosition(menu);
      }
    });
  });

  app.querySelector(".shell")?.addEventListener("click", (event) => {
    if (event.target.closest(".app-menu, .sequence-measure-menu, .sequence-instrument-menu") == null) {
      closeMenus();
    }
  });

  app.querySelector("[data-action='menu-upload']")?.addEventListener("click", () => {
    closeMenus();
    app.querySelector("[data-action='load-file']")?.click();
  });

  app.querySelector("[data-action='open-library-menu']")?.addEventListener("click", () => {
    closeMenus();
    state.sequenceSaveAs.open = false;
    state.sequenceSaveAs.error = "";
    state.libraryOpen.open = true;
    render();
  });

  app.querySelector("[data-action='undo-sequence-edit']")?.addEventListener("click", () => {
    closeMenus();
    undoSequenceEdit();
  });

  app.querySelector("[data-action='redo-sequence-edit']")?.addEventListener("click", () => {
    closeMenus();
    redoSequenceEdit();
  });
}

function bindSequenceInstrumentDrag() {
  app.querySelectorAll("[data-action='sequence-instrument-drag']").forEach((label) => {
    label.addEventListener("dragstart", (event) => {
      const index = Number(label.dataset.index);
      state.sequenceInstrumentDrag = { index };
      label.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    });

    label.addEventListener("dragover", (event) => {
      if (state.sequenceInstrumentDrag == null) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearSequenceInstrumentDragClasses("drag-over");
      label.classList.add("drag-over");
    });

    label.addEventListener("dragleave", () => {
      label.classList.remove("drag-over");
    });

    label.addEventListener("drop", (event) => {
      event.preventDefault();
      const sourceIndex = state.sequenceInstrumentDrag?.index
        ?? Number.parseInt(event.dataTransfer.getData("text/plain"), 10);
      const targetIndex = Number(label.dataset.index);
      moveSequenceInstrument(sourceIndex, targetIndex);
    });

    label.addEventListener("dragend", () => {
      state.sequenceInstrumentDrag = null;
      clearSequenceInstrumentDragClasses();
    });
  });
}

function clearSequenceInstrumentDragClasses(className = null) {
  const selector = className == null
    ? ".sequence-instrument-label.dragging, .sequence-instrument-label.drag-over"
    : `.sequence-instrument-label.${className}`;
  app.querySelectorAll(selector).forEach((element) => {
    if (className == null) {
      element.classList.remove("dragging", "drag-over");
    } else {
      element.classList.remove(className);
    }
  });
}

function handleGlobalKeyDown(event) {
  if (state.splashVisible) {
    return;
  }

  if (event.key === "Escape" && state.diagnosticsOpen) {
    state.diagnosticsOpen = false;
    render();
    return;
  }

  if (state.activeType === "sequence" && isCommandShortcut(event, "g")) {
    event.preventDefault();
    setSequenceView("grid");
    return;
  }

  if (state.activeType === "sequence" && isCommandShortcut(event, "t")) {
    event.preventDefault();
    setSequenceView("text");
    return;
  }

  const isUndoKey = isCommandShortcut(event, "z") || isCommandShortcut(event, "z", { shift: true });
  if (!isUndoKey || state.activeType !== "sequence" || isTextEntryTarget(event.target)) {
    return;
  }

  event.preventDefault();
  if (event.shiftKey) {
    redoSequenceEdit();
  } else {
    undoSequenceEdit();
  }
}

function dismissSplash() {
  state.splashVisible = false;
  render();
}

function setSequenceView(view) {
  if (view !== "grid" && view !== "text") {
    return;
  }

  closeMenus();
  if (state.sequenceView === view) {
    return;
  }

  state.sequenceView = view;
  render();
}

function isCommandShortcut(event, key, options = {}) {
  const shift = options.shift ?? false;
  return event.key.toLowerCase() === key.toLowerCase()
    && event.shiftKey === shift
    && !event.altKey
    && isCommandModifier(event);
}

function isCommandModifier(event) {
  if (isApplePlatform()) {
    return event.metaKey && !event.ctrlKey;
  }

  return event.ctrlKey && !event.metaKey;
}

function formatCommandShortcut(key, options = {}) {
  const parts = [];
  if (options.shift === true) {
    parts.push("Shift");
  }
  parts.push(isApplePlatform() ? "Cmd" : "Ctrl", key.toUpperCase());
  return parts.join("-");
}

function isApplePlatform() {
  const platform = globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? "";
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

function isTextEntryTarget(target) {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target?.isContentEditable === true;
}

function applySequenceGridEdit(scope, intent, index) {
  const asset = state.assets.sequence;
  if (asset.model == null) {
    addActivity("Open a valid sequence before editing the grid.", "warning");
    render();
    return;
  }

  try {
    const label = describeSequenceGridEdit(scope, intent, index);
    const editedSequence = editSequenceDisplay(asset.model, { scope, intent, index }, { defaultBeatsPerBar: SEQUENCE_DEFAULT_BEATS_PER_BAR });
    commitSequenceEdit(label, editedSequence);
  } catch (error) {
    addActivity(error.message, "error");
    render();
  }
}

function applySequenceBarSetting(index, setting, value) {
  const asset = state.assets.sequence;
  if (asset.model == null) {
    addActivity("Open a valid sequence before editing the grid.", "warning");
    render();
    return;
  }

  try {
    const edit = setting === "beats"
      ? { scope: "bar-setting", index, beats: value }
      : { scope: "bar-setting", index, columnsPerBeat: value };
    const label = setting === "beats"
      ? `Set Bar ${index + 1} Beats to ${value}`
      : `Set Bar ${index + 1} Beat to ${formatSequenceBeat(value)}`;
    const editedSequence = editSequenceDisplay(asset.model, edit, { defaultBeatsPerBar: SEQUENCE_DEFAULT_BEATS_PER_BAR });
    commitSequenceEdit(label, editedSequence);
  } catch (error) {
    addActivity(error.message, "error");
    render();
  }
}

function applySequenceInstrumentEdit(intent, indexValue, name) {
  const asset = state.assets.sequence;
  if (asset.model == null) {
    addActivity("Open a valid sequence before editing instruments.", "warning");
    render();
    return;
  }

  try {
    const index = indexValue === "" || indexValue == null ? null : Number(indexValue);
    const edit = intent === "add"
      ? { scope: "instrument", intent, name }
      : { scope: "instrument", intent: "change", index, name };
    const label = describeSequenceInstrumentEdit(edit);
    const editedSequence = editSequenceDisplay(asset.model, edit, { defaultBeatsPerBar: SEQUENCE_DEFAULT_BEATS_PER_BAR });
    commitSequenceEdit(label, editedSequence);
  } catch (error) {
    addActivity(error.message, "error");
    render();
  }
}

function moveSequenceInstrument(fromIndex, toIndex) {
  const asset = state.assets.sequence;
  if (asset.model == null || fromIndex === toIndex) {
    state.sequenceInstrumentDrag = null;
    clearSequenceInstrumentDragClasses();
    return;
  }

  try {
    const edit = { scope: "instrument", intent: "move", index: fromIndex, targetIndex: toIndex };
    const label = describeSequenceInstrumentEdit(edit);
    const editedSequence = editSequenceDisplay(asset.model, edit, { defaultBeatsPerBar: SEQUENCE_DEFAULT_BEATS_PER_BAR });
    commitSequenceEdit(label, editedSequence);
  } catch (error) {
    addActivity(error.message, "error");
    render();
  } finally {
    state.sequenceInstrumentDrag = null;
    clearSequenceInstrumentDragClasses();
  }
}

function describeSequenceGridEdit(scope, intent, index) {
  if (scope === "bar") {
    const barLabel = `Bar ${index + 1}`;
    if (intent === "delete") {
      return `Delete ${barLabel}`;
    }
    return `Insert Bar ${intent === "add-left" ? "Left of" : "Right of"} ${barLabel}`;
  }

  const song = resolveSequenceDisplaySong(state.assets.sequence.model);
  const segmentName = song.segments[index]?.name ?? `Segment ${index + 1}`;
  if (intent === "delete") {
    return `Delete Segment ${segmentName}`;
  }
  return `Insert Segment ${intent === "add-left" ? "Left of" : "Right of"} ${segmentName}`;
}

function describeSequenceInstrumentEdit(edit) {
  const instruments = state.assets.sequence.model?.instruments ?? [];
  if (edit.intent === "add") {
    return `Add Instrument ${edit.name}`;
  }

  if (edit.intent === "change") {
    return `Change Instrument ${instruments[edit.index] ?? edit.index + 1} to ${edit.name}`;
  }

  const fromName = instruments[edit.index] ?? `Instrument ${edit.index + 1}`;
  const toName = instruments[edit.targetIndex] ?? `Instrument ${edit.targetIndex + 1}`;
  return `Move Instrument ${fromName} to ${toName}`;
}

function commitSequenceEdit(label, editedSequence) {
  const asset = state.assets.sequence;
  const beforeText = asset.text;
  const afterText = exportSequenceFile(editedSequence);

  if (beforeText === afterText) {
    addActivity("Sequence edit did not change the file.", "warning");
    render();
    return;
  }

  applySequenceTextSnapshot(afterText);
  pushSequenceHistory({
    label,
    beforeText,
    afterText
  });
  state.sequenceView = "grid";
  addActivity(label);
  render();
}

function undoSequenceEdit() {
  const entry = state.sequenceHistory.undo.pop();
  if (entry == null) {
    addActivity("Nothing to undo.", "warning");
    render();
    return;
  }

  applySequenceTextSnapshot(entry.beforeText);
  state.sequenceHistory.redo.push(entry);
  state.sequenceView = "grid";
  addActivity(`Undid ${entry.label}.`);
  render();
}

function redoSequenceEdit() {
  const entry = state.sequenceHistory.redo.pop();
  if (entry == null) {
    addActivity("Nothing to redo.", "warning");
    render();
    return;
  }

  applySequenceTextSnapshot(entry.afterText);
  state.sequenceHistory.undo.push(entry);
  state.sequenceView = "grid";
  addActivity(`Redid ${entry.label}.`);
  render();
}

function applySequenceTextSnapshot(text) {
  const asset = state.assets.sequence;
  const result = parseSequenceFile(text);
  state.assets.sequence = {
    ...asset,
    text,
    model: result.sequence,
    diagnostics: result.diagnostics
  };
}

function pushSequenceHistory(entry) {
  state.sequenceHistory.undo.push(entry);
  if (state.sequenceHistory.undo.length > SEQUENCE_HISTORY_LIMIT) {
    state.sequenceHistory.undo.shift();
  }
  state.sequenceHistory.redo = [];
}

function resetSequenceHistory() {
  state.sequenceHistory.undo = [];
  state.sequenceHistory.redo = [];
}

function getTopSequenceUndo() {
  return state.sequenceHistory.undo.at(-1) ?? null;
}

function getTopSequenceRedo() {
  return state.sequenceHistory.redo.at(-1) ?? null;
}

function closeMenus(exceptMenu = null) {
  app.querySelectorAll(".app-menu, .sequence-measure-menu, .sequence-instrument-menu").forEach((menu) => {
    if (menu !== exceptMenu) {
      menu.open = false;
    }
  });
}

function positionSequenceInstrumentMenu(menu) {
  if (!menu.classList.contains("sequence-instrument-menu")) {
    return;
  }

  const popover = menu.querySelector(".sequence-instrument-popover");
  const trigger = menu.querySelector(".sequence-instrument-trigger");
  const frame = menu.closest(".sequence-grid-frame");
  if (popover == null || trigger == null || frame == null) {
    return;
  }

  resetSequenceInstrumentMenuPosition(menu);
  window.requestAnimationFrame(() => {
    if (!menu.open) {
      return;
    }

    const gap = 6;
    const frameRect = frame.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const naturalHeight = popover.scrollHeight;
    const spaceAbove = Math.max(0, triggerRect.top - frameRect.top - gap);
    const spaceBelow = Math.max(0, frameRect.bottom - triggerRect.bottom - gap);
    const openDown = naturalHeight <= spaceBelow || spaceBelow > spaceAbove;
    const maxHeight = Math.max(1, Math.floor(openDown ? spaceBelow : spaceAbove));

    menu.classList.add(openDown ? "open-down" : "open-up");
    popover.style.setProperty("--sequence-instrument-popover-max-height", `${maxHeight}px`);
  });
}

function resetSequenceInstrumentMenuPosition(menu) {
  if (!menu.classList.contains("sequence-instrument-menu")) {
    return;
  }

  menu.classList.remove("open-up", "open-down");
  menu.querySelector(".sequence-instrument-popover")?.style.removeProperty("--sequence-instrument-popover-max-height");
}

function openSequenceSaveAsDialog() {
  if (state.activeType !== "sequence") {
    return;
  }

  closeMenus();
  state.libraryOpen.open = false;
  state.sequenceSaveAs = {
    open: true,
    name: getActiveLibraryName(),
    error: ""
  };
  render();
  window.setTimeout(() => {
    const input = app.querySelector("[data-action='sequence-save-as-name']");
    input?.focus();
    input?.select();
  }, 0);
}

function bindSequenceSaveAsDialog() {
  app.querySelectorAll("[data-action='close-sequence-save-as']").forEach((element) => {
    element.addEventListener("click", () => {
      state.sequenceSaveAs.open = false;
      state.sequenceSaveAs.error = "";
      render();
    });
  });

  app.querySelector("[data-action='sequence-save-as-modal']")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const input = app.querySelector("[data-action='sequence-save-as-name']");
  input?.addEventListener("input", (event) => {
    state.sequenceSaveAs.name = event.target.value;
    state.sequenceSaveAs.error = "";
  });
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmSequenceSaveAs();
    } else if (event.key === "Escape") {
      state.sequenceSaveAs.open = false;
      state.sequenceSaveAs.error = "";
      render();
    }
  });

  app.querySelector("[data-action='confirm-sequence-save-as']")?.addEventListener("click", confirmSequenceSaveAs);
}

async function confirmSequenceSaveAs() {
  const name = normalizeLibrarySaveName("sequences", state.sequenceSaveAs.name);
  const error = validateLibrarySaveName("sequences", name);

  if (error != null) {
    state.sequenceSaveAs.error = error;
    addActivity(error, "error");
    render();
    return;
  }

  await saveActiveToLibrary({
    name,
    closeSequenceSaveAs: true,
    saveAs: true
  });
}

function bindLibraryOpenDialog() {
  app.querySelectorAll("[data-action='close-library-open']").forEach((element) => {
    element.addEventListener("click", () => {
      state.libraryOpen.open = false;
      render();
    });
  });

  app.querySelector("[data-action='library-open-modal']")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  app.querySelectorAll("[data-action='open-library-from-dialog']").forEach((button) => {
    button.addEventListener("click", async () => {
      state.libraryOpen.open = false;
      await openLibraryFile(button.dataset.name);
    });
  });
}

function bindDiagnosticsDialog() {
  app.querySelectorAll("[data-action='close-diagnostics-report']").forEach((element) => {
    element.addEventListener("click", () => {
      state.diagnosticsOpen = false;
      render();
    });
  });

  app.querySelector("[data-action='diagnostics-modal']")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  app.querySelector("[data-action='diagnostics-modal']")?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      state.diagnosticsOpen = false;
      render();
    }
  });
}

function changeSequenceZoom(delta) {
  const currentIndex = Math.max(0, SEQUENCE_CELL_SIZES.indexOf(state.sequenceCellSize));
  const nextIndex = Math.min(
    SEQUENCE_CELL_SIZES.length - 1,
    Math.max(0, currentIndex + delta)
  );

  if (nextIndex === currentIndex) {
    return;
  }

  state.sequenceCellSize = SEQUENCE_CELL_SIZES[nextIndex];
  render();
}

function bindSequenceScrollControls() {
  const frame = app.querySelector("[data-action='sequence-grid-scroll']");
  const scrollbar = app.querySelector("[data-action='sequence-horizontal-scroll']");
  if (frame == null || scrollbar == null) {
    return;
  }

  const getMaxScrollLeft = () => Math.max(0, frame.scrollWidth - frame.clientWidth);
  const setScrollLeft = (value) => {
    const maxScrollLeft = getMaxScrollLeft();
    const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, value));
    state.sequenceScrollLeft = nextScrollLeft;
    frame.scrollLeft = nextScrollLeft;
    scrollbar.max = String(maxScrollLeft);
    scrollbar.value = String(nextScrollLeft);
    scrollbar.disabled = maxScrollLeft === 0;
  };

  const syncScrollbar = () => {
    setScrollLeft(state.sequenceScrollLeft);
  };

  syncScrollbar();
  window.requestAnimationFrame(syncScrollbar);

  scrollbar.addEventListener("input", (event) => {
    setScrollLeft(Number(event.target.value));
  });

  frame.addEventListener("wheel", (event) => {
    const maxScrollLeft = getMaxScrollLeft();
    if (maxScrollLeft === 0) {
      return;
    }

    const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      ? event.deltaX
      : event.shiftKey
        ? event.deltaY
        : 0;
    if (delta === 0) {
      return;
    }

    event.preventDefault();
    setScrollLeft(frame.scrollLeft + delta);
  }, { passive: false });
}

function createNewAsset(type) {
  if (type === "config") {
    return {
      ...createEmptyAsset(),
      fileName: "chopchae_config.txt",
      libraryName: "chopchae_config.txt",
      text: "[config]\nversion = 1\n",
      model: parseConfigFile("[config]\nversion = 1\n").config,
      diagnostics: []
    };
  }

  const name = type === "sounds" ? "new_sounds.txt" : "new_sequence.txt";
  return {
    ...createEmptyAsset(),
    fileName: name,
    libraryName: name
  };
}

function updateActiveText(text, fileName, libraryName = "") {
  const type = state.activeType;
  const config = ASSET_TYPES[type];
  const result = config.parser(text);
  if (type === "sounds") {
    state.soundNotes = {};
  }
  if (type === "sequence") {
    resetSequenceHistory();
  }
  state.assets[type] = {
    fileName,
    libraryName: type === "config" ? "chopchae_config.txt" : libraryName,
    text,
    model: result[config.modelKey],
    diagnostics: result.diagnostics
  };
}

function updateSoundChannelNote(noteKey, channelIndex, rawNote) {
  const asset = state.assets.sounds;
  const sound = asset.model?.sounds[state.selectedSoundIndex];
  const channel = sound?.channels[channelIndex];
  if (channel == null) {
    return;
  }

  const note = rawNote.replace(/\s+/g, " ").trim();
  state.soundNotes[noteKey] = note;
  if (note === "") {
    delete channel.note;
  } else {
    channel.note = note;
  }

  asset.text = exportSoundLibrary(asset.model, { includeMetadata: false });
  asset.diagnostics = parseSoundLibrary(asset.text).diagnostics;
}

function updateSelectedSoundName(rawName) {
  const library = state.assets.sounds.model;
  const sound = getActiveSound();
  if (library == null || sound == null) {
    return;
  }

  const name = rawName.trim();
  if (!SOUND_NAME_PATTERN.test(name)) {
    addActivity("Sound names must start with a letter or underscore, then use letters, numbers, or underscores.", "error");
    render();
    return;
  }

  if (wouldDuplicateSound(library, state.selectedSoundIndex, name, sound.symbol)) {
    addActivity(`Sound ${name} already has symbol ${sound.symbol}.`, "error");
    render();
    return;
  }

  sound.name = name;
  syncSoundsAssetFromModel();
  render();
}

function updateSelectedSoundMeta(field, rawValue) {
  const library = state.assets.sounds.model;
  const sound = getActiveSound();
  if (library == null || sound == null) {
    return;
  }

  const value = rawValue.trim();
  if (field === "symbol") {
    if (!SOUND_SYMBOL_PATTERN.test(value)) {
      addActivity("Sound symbols must be one character: letter, number, underscore, or #.", "error");
      render();
      return;
    }

    if (wouldDuplicateSound(library, state.selectedSoundIndex, sound.name, value)) {
      addActivity(`Sound ${sound.name} already has symbol ${value}.`, "error");
      render();
      return;
    }

    sound.symbol = value;
  } else if (field === "color") {
    const color = normalizeSoundColor(value);
    if (color === undefined) {
      addActivity("Color must be blank, a supported color name, or #RRGGBB.", "error");
      render();
      return;
    }
    sound.color = color;
  } else if (field === "key") {
    const key = normalizeButtonKey(value);
    if (key === undefined) {
      addActivity("Button must be blank or a number from 1 to 32.", "error");
      render();
      return;
    }
    sound.key = key;
  }

  syncSoundsAssetFromModel();
  render();
}

function addSound() {
  const library = ensureSoundLibrary();
  const name = nextAvailableSoundName(library);
  const symbol = nextAvailableSymbol(library, name);
  if (symbol == null) {
    addActivity(`No available default symbol for ${name}.`, "error");
    render();
    return;
  }

  library.sounds.push(createSound(name, symbol));
  state.selectedSoundIndex = library.sounds.length - 1;
  syncSoundsAssetFromModel();
  addActivity(`Added sound ${name} ${symbol}.`);
  render();
}

function addSoundSymbol(name) {
  const library = ensureSoundLibrary();
  const symbol = nextAvailableSymbol(library, name);
  if (symbol == null) {
    addActivity(`No available symbol for ${name}.`, "error");
    render();
    return;
  }

  const insertAfter = findLastSoundIndexByName(library, name);
  const sound = createSound(name, symbol);
  library.sounds.splice(insertAfter + 1, 0, sound);
  state.selectedSoundIndex = insertAfter + 1;
  syncSoundsAssetFromModel();
  addActivity(`Added symbol ${symbol} to ${name}.`);
  render();
}

function addChannelToSelectedSound() {
  const sound = getActiveSound();
  if (sound == null) {
    return;
  }

  const output = nextAvailableOutput(sound);
  sound.channels.push({
    module: output.module,
    channel: output.channel,
    values: createDefaultValues("envelope")
  });

  syncSoundsAssetFromModel();
  addActivity(`Added Mod${output.module + 1}, Ch${output.channel + 1}.`);
  render();
}

function removeChannelFromSelectedSound(channelIndex) {
  const sound = getActiveSound();
  if (sound?.channels[channelIndex] == null) {
    return;
  }

  const channel = sound.channels[channelIndex];
  sound.channels.splice(channelIndex, 1);
  syncSoundsAssetFromModel();
  addActivity(`Removed Mod${channel.module + 1}, Ch${channel.channel + 1}.`);
  render();
}

function toggleChannelTrigger(channelIndex, trigger) {
  const channel = getActiveSound()?.channels[channelIndex];
  if (channel == null) {
    return;
  }

  channel.values = trigger ? [{ kind: "trigger" }] : [{ kind: "value", value: 100 }];
  syncSoundsAssetFromModel();
  render();
}

function startEnvelopeDrag(event, frame) {
  if (event.button !== 0) {
    return;
  }

  const sound = getActiveSound();
  const channelIndex = Number(frame.dataset.channelIndex);
  const channel = sound?.channels[channelIndex];
  if (channel == null || isTriggerChannel(channel)) {
    return;
  }

  const rect = frame.getBoundingClientRect();
  const maxQuanta = getSoundMaxQuanta(sound);
  const index = dragIndexFromEvent(event, rect, maxQuanta);
  state.envelopeDrag = {
    channelIndex,
    maxQuanta,
    rect,
    startLength: channel.values.length,
    startedOnLast: index >= channel.values.length - 1,
    latestValue: dragValueFromEvent(event, rect),
    extendedOnExit: false,
    extendDelayId: null,
    extendIntervalId: null,
    lastSignature: ""
  };

  applyEnvelopeDrag(event);
  event.preventDefault();
}

function updateEnvelopeDrag(event) {
  if (state.envelopeDrag == null) {
    return;
  }

  applyEnvelopeDrag(event);
}

function finishEnvelopeDrag() {
  if (state.envelopeDrag == null) {
    return;
  }

  stopEnvelopeAutoExtend(state.envelopeDrag);
  state.envelopeDrag = null;
  render();
}

function applyEnvelopeDrag(event) {
  const drag = state.envelopeDrag;
  const channel = getActiveSound()?.channels[drag?.channelIndex];
  if (drag == null || channel == null || isTriggerChannel(channel)) {
    return;
  }

  const value = dragValueFromEvent(event, drag.rect);
  drag.latestValue = value;

  if (event.clientX > drag.rect.right) {
    if (!drag.extendedOnExit) {
      drag.extendedOnExit = true;
      appendEnvelopeQuantum(drag);
    }
    startEnvelopeAutoExtend(drag);
    return;
  }

  drag.extendedOnExit = false;
  stopEnvelopeAutoExtend(drag);

  const index = Math.max(0, dragIndexFromEvent(event, drag.rect, drag.maxQuanta));

  if (isScaledChannel(channel)) {
    resizeScaledChannel(channel, index, drag);
  } else {
    editEnvelopeChannel(channel, index, value, drag);
  }

  const signature = channel.values.map(formatCvValue).join(",");
  if (signature === drag.lastSignature) {
    return;
  }

  drag.lastSignature = signature;
  syncSoundsAssetFromModel();
  render();
}

function editEnvelopeChannel(channel, index, value, drag) {
  if (drag.startedOnLast && index < channel.values.length - 1) {
    channel.values = channel.values.slice(0, Math.max(1, index + 1));
    return;
  }

  while (channel.values.length <= index) {
    channel.values.push({ kind: "value", value });
  }

  channel.values[index] = { kind: "value", value };
}

function resizeScaledChannel(channel, index, drag) {
  if (drag.startedOnLast && index < channel.values.length - 1) {
    channel.values = channel.values.slice(0, Math.max(1, index + 1));
    return;
  }

  while (channel.values.length <= index) {
    channel.values.push({ kind: "scaled" });
  }
}

function startEnvelopeAutoExtend(drag) {
  if (drag.extendDelayId != null || drag.extendIntervalId != null) {
    return;
  }

  drag.extendDelayId = window.setTimeout(() => {
    drag.extendDelayId = null;
    appendEnvelopeQuantum(drag);
    drag.extendIntervalId = window.setInterval(() => appendEnvelopeQuantum(drag), ENVELOPE_EXTEND_INTERVAL_MS);
  }, ENVELOPE_EXTEND_HOLD_MS);
}

function stopEnvelopeAutoExtend(drag) {
  if (drag.extendDelayId != null) {
    window.clearTimeout(drag.extendDelayId);
    drag.extendDelayId = null;
  }

  if (drag.extendIntervalId != null) {
    window.clearInterval(drag.extendIntervalId);
    drag.extendIntervalId = null;
  }
}

function appendEnvelopeQuantum(drag) {
  const channel = getActiveSound()?.channels[drag.channelIndex];
  if (channel == null || isTriggerChannel(channel)) {
    stopEnvelopeAutoExtend(drag);
    return;
  }

  channel.values.push(isScaledChannel(channel)
    ? { kind: "scaled" }
    : { kind: "value", value: drag.latestValue });

  drag.maxQuanta = Math.max(drag.maxQuanta, channel.values.length);
  drag.startedOnLast = true;
  drag.lastSignature = channel.values.map(formatCvValue).join(",");
  syncSoundsAssetFromModel();
  render();
}

function syncSoundsAssetFromModel() {
  const asset = state.assets.sounds;
  if (asset.model == null) {
    return;
  }

  asset.text = exportSoundLibrary(asset.model, { includeMetadata: false });
  const result = parseSoundLibrary(asset.text);
  asset.model = result.library;
  asset.diagnostics = result.diagnostics;
  state.selectedSoundIndex = Math.min(state.selectedSoundIndex, Math.max(0, asset.model.sounds.length - 1));
}

async function openLibraryFile(name) {
  const config = ASSET_TYPES[state.activeType];
  let file;
  try {
    file = await state.libraryBackend.readFile(config.libraryKind, name);
  } catch (error) {
    addActivity(formatLibraryBackendError(error), "error");
    render();
    return;
  }

  updateActiveText(file.content, file.name, file.name);
  addActivity(`Opened ${file.name} from the ${getLibraryLabel().toLowerCase()}.`);
  render();
}

async function openSoundsForSequence(name) {
  let file;
  try {
    file = await state.libraryBackend.readFile("sounds", name);
  } catch (error) {
    addActivity(formatLibraryBackendError(error), "error");
    render();
    return;
  }

  const result = parseSoundLibrary(file.content);
  state.assets.sounds = {
    fileName: file.name,
    libraryName: file.name,
    text: file.content,
    model: result.library,
    diagnostics: result.diagnostics
  };
  state.selectedSoundIndex = 0;
  addActivity(`Using ${file.name} as the active sounds file.`);
  render();
}

async function saveActiveToLibrary(options = {}) {
  const asset = state.assets[state.activeType];
  const config = ASSET_TYPES[state.activeType];
  const name = normalizeLibrarySaveName(config.libraryKind, options.name ?? getActiveLibraryName());
  const nameError = validateLibrarySaveName(config.libraryKind, name);

  if (asset.text === "") {
    addActivity("Nothing to save yet.", "warning");
    render();
    return;
  }

  if (nameError != null) {
    if (state.sequenceSaveAs.open) {
      state.sequenceSaveAs.error = nameError;
    }
    addActivity(nameError, "error");
    render();
    return;
  }

  if (asset.model == null || hasErrors(asset.diagnostics)) {
    addActivity(`Fix validation errors before saving to the ${getLibraryLabel().toLowerCase()}.`, "error");
    render();
    return;
  }

  try {
    await state.libraryBackend.writeFile(config.libraryKind, name, asset.text);
  } catch (error) {
    addActivity(formatLibraryBackendError(error), "error");
    render();
    return;
  }

  await refreshLibrary();
  state.assets[state.activeType].fileName = name;
  state.assets[state.activeType].libraryName = name;
  if (options.closeSequenceSaveAs === true) {
    state.sequenceSaveAs.open = false;
    state.sequenceSaveAs.error = "";
  }
  addActivity(`${options.saveAs === true ? "Saved as" : "Saved"} ${name} to the ${getLibraryLabel().toLowerCase()}.`);
  render();
}

function normalizeLibrarySaveName(kind, name) {
  if (kind === "config") {
    return "chopchae_config.txt";
  }

  return String(name ?? "").trim();
}

function validateLibrarySaveName(kind, name) {
  if (kind === "config") {
    return null;
  }

  if (name === "") {
    return "Choose a library file name before saving.";
  }

  if (
    name.length > 128
    || name.startsWith(".")
    || name.endsWith("~")
    || !LIBRARY_FILE_NAME_PATTERN.test(name)
  ) {
    return "Library names can use letters, numbers, dots, underscores, and dashes.";
  }

  return null;
}

async function refreshLibrary() {
  try {
    state.library = await state.libraryBackend.listLibrary();
  } catch (error) {
    state.library = null;
    addActivity(formatLibraryBackendError(error), "error");
  }
}

function getLibraryLabel() {
  return state.library?.label ?? state.libraryBackend.label ?? "Library";
}

function addActivity(text, tone = "info") {
  state.messages.push({
    id: state.nextMessageId,
    tone,
    text
  });
  state.nextMessageId += 1;

  if (state.messages.length > 80) {
    state.messages = state.messages.slice(-80);
  }
}

function getLibraryFilesForActiveType() {
  if (state.library == null) {
    return [];
  }

  if (state.activeType === "config") {
    return [state.library.files.config];
  }

  const config = ASSET_TYPES[state.activeType];
  return state.library.files[config.libraryKind] ?? [];
}

function getActiveLibraryName() {
  if (state.activeType === "config") {
    return "chopchae_config.txt";
  }

  const asset = state.assets[state.activeType];
  return asset.libraryName || asset.fileName || (state.activeType === "sounds" ? "new_sounds.txt" : "new_sequence.txt");
}

function downloadText(fileName, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function downloadActiveFile() {
  const asset = state.assets[state.activeType];
  const fileName = getActiveLibraryName();
  if (asset.text === "") {
    addActivity("Nothing to download yet.", "warning");
    render();
    return;
  }

  if (typeof window.showSaveFilePicker !== "function") {
    downloadText(fileName, asset.text);
    addActivity(`Downloaded ${fileName}.`);
    render();
    return;
  }

  try {
    const handle = await window.showSaveFilePicker({ suggestedName: fileName });
    const writable = await handle.createWritable();
    await writable.write(asset.text);
    await writable.close();
    addActivity(`Downloaded ${fileName} to the selected location.`);
    render();
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }

    downloadText(fileName, asset.text);
    addActivity(`Downloaded ${fileName}.`);
    render();
  }
}

function renderColor(color) {
  if (color == null) {
    return "";
  }

  const cssColor = color.startsWith("#") ? color : color;
  return `<span class="swatch" style="--swatch:${escapeHtml(cssColor)}"></span><span>${escapeHtml(color)}</span>`;
}

function buildPatchMap(library) {
  const outputs = new Map();

  for (const sound of library.sounds) {
    for (const channel of sound.channels) {
      const aif = channel.module + 1;
      const output = channel.channel + 1;
      const key = `${aif}:${output}`;
      const patch = {
        sound: sound.name,
        symbol: sound.symbol,
        color: sound.color,
        valueCount: channel.values.length
      };

      if (!outputs.has(key)) {
        outputs.set(key, []);
      }
      outputs.get(key).push(patch);
    }
  }

  const rows = [...outputs.entries()]
    .map(([key, patches]) => {
      const [aif, output] = key.split(":").map(Number);
      return { aif, output, patches };
    })
    .sort((a, b) => a.aif - b.aif || a.output - b.output);

  return {
    outputs,
    rows,
    usedModules: new Set(rows.map((row) => row.aif)),
    usedOutputs: new Set(rows.map((row) => `${row.aif}:${row.output}`))
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
