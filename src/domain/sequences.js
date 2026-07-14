import { createDiagnostic } from "./diagnostics.js";
import { FORMAT_VERSION, formatNumber, metadataCommentLines } from "./format.js";
import { stripSourceLines } from "./model.js";
import { isBlankOrComment, stripLineComment } from "./text.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;
const REPEAT = /^x([0-9]+)$/i;
const SEQUENCE_TOKEN = /\(|\)|x[0-9]+|[A-Za-z_][A-Za-z0-9_]*|[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)/g;
const MAX_DISPLAY_SEGMENTS = 4096;
const DEFAULT_BEATS_PER_BAR = 4;

export function parseSequenceFile(text) {
  const diagnostics = [];
  const model = {
    format: "chopchae.sequence.source",
    formatVersion: FORMAT_VERSION,
    instruments: [],
    timing: {
      beatsPerMinute: 120,
      columnsPerBeat: 1,
      quantaPerColumn: 24
    },
    editor: {
      barLayout: []
    },
    tabs: [],
    sequences: [],
    entry: null
  };

  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    readSequenceEditorMetadata(lines[index], model, lineNumber, diagnostics);
    const source = stripLineComment(lines[index], "#").trim();

    if (source === "") {
      continue;
    }

    if (/^instruments\s*=/.test(source)) {
      const result = readInstrumentBlock(lines, index + 1);
      model.instruments = result.instruments;
      index = result.nextIndex - 1;
      continue;
    }

    const timing = source.match(/^(bpm|beats_per_minute|cpb|qpc)\s*=\s*(.+)$/);
    if (timing != null) {
      applyTiming(model, timing[1], timing[2], lineNumber, diagnostics);
      continue;
    }

    const tab = source.match(/^tab\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*)?(.*)$/);
    if (tab != null) {
      const result = readTabBlock(lines, index + 1, tab[1]);
      model.tabs.push({
        name: tab[1],
        lines: result.tabLines,
        line: lineNumber
      });
      index = result.nextIndex - 1;
      continue;
    }

    const sequence = source.match(/^sequence\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (sequence != null) {
      const result = readSequenceExpression(lines, index + 1, sequence[2]);
      model.sequences.push({
        name: sequence[1],
        expression: normalizeExpression(result.expression),
        line: lineNumber
      });
      index = result.nextIndex - 1;
      continue;
    }

    const play = source.match(/^play\s+([A-Za-z_][A-Za-z0-9_]*)$/);
    if (play != null) {
      model.entry = play[1];
      continue;
    }

    diagnostics.push(createDiagnostic("warning", `Unrecognized sequence line "${source}".`, lineNumber));
  }

  diagnostics.push(...validateSequence(model));
  return { sequence: stripSourceLines(model), diagnostics };
}

export function validateSequence(sequence) {
  const diagnostics = [];
  const tabNames = new Set(sequence.tabs.map((tab) => tab.name));
  const sequenceNames = new Set(sequence.sequences.map((item) => item.name));
  const allNames = new Set([...tabNames, ...sequenceNames]);
  const seenNames = new Set();

  if (sequence.instruments.length === 0) {
    diagnostics.push(createDiagnostic("warning", "Sequence has no instrument list.", null));
  }

  for (const name of sequence.instruments) {
    if (!IDENTIFIER.test(name)) {
      diagnostics.push(createDiagnostic("error", `Invalid instrument name "${name}".`, null));
    }
  }

  if (sequence.timing.beatsPerMinute <= 0) {
    diagnostics.push(createDiagnostic("error", "BPM must be greater than zero.", null));
  }

  if (!Number.isInteger(sequence.timing.columnsPerBeat) || sequence.timing.columnsPerBeat <= 0) {
    diagnostics.push(createDiagnostic("error", "CPB must be a positive integer.", null));
  }

  if (!Number.isInteger(sequence.timing.quantaPerColumn) || sequence.timing.quantaPerColumn <= 0) {
    diagnostics.push(createDiagnostic("error", "QPC must be a positive integer.", null));
  }

  for (const [index, bar] of (sequence.editor?.barLayout ?? []).entries()) {
    if (!Number.isInteger(bar.beats) || bar.beats <= 0) {
      diagnostics.push(createDiagnostic("error", `Bar layout entry ${index + 1} must have a positive beat count.`, null));
    }
    if (!Number.isInteger(bar.columnsPerBeat) || bar.columnsPerBeat <= 0) {
      diagnostics.push(createDiagnostic("error", `Bar layout entry ${index + 1} must have a positive beat size.`, null));
    }
  }

  for (const tab of sequence.tabs) {
    if (seenNames.has(tab.name)) {
      diagnostics.push(createDiagnostic("error", `Duplicate tab or sequence name "${tab.name}".`, tab.line));
    }
    seenNames.add(tab.name);

    if (sequence.instruments.length > 0 && tab.lines.length !== sequence.instruments.length) {
      diagnostics.push(
        createDiagnostic("error", `Tab "${tab.name}" has ${tab.lines.length} lines, expected ${sequence.instruments.length}.`, tab.line)
      );
    }
  }

  for (const item of sequence.sequences) {
    if (seenNames.has(item.name)) {
      diagnostics.push(createDiagnostic("error", `Duplicate tab or sequence name "${item.name}".`, item.line));
    }
    seenNames.add(item.name);

    for (const reference of extractSequenceReferences(item.expression)) {
      if (!allNames.has(reference)) {
        diagnostics.push(createDiagnostic("error", `Unknown sequence reference "${reference}".`, item.line));
      }
    }
  }

  if (sequence.entry != null && !allNames.has(sequence.entry)) {
    diagnostics.push(createDiagnostic("error", `Entry point "${sequence.entry}" is not defined.`, null));
  } else if (sequence.entry == null) {
    diagnostics.push(createDiagnostic("warning", "No play entry point is set.", null));
  }

  return diagnostics;
}

export function exportSequenceFile(sequence) {
  const lines = [
    ...metadataCommentLines("#", "chopchae.sequence.dsl"),
    ...metadataBarLayoutLines(sequence),
    "",
    "instruments =",
    ...sequence.instruments,
    "",
    `bpm = ${formatNumber(sequence.timing.beatsPerMinute)}`,
    `cpb = ${sequence.timing.columnsPerBeat}`,
    `qpc = ${sequence.timing.quantaPerColumn}`,
    ""
  ];

  for (const tab of sequence.tabs) {
    lines.push(`tab ${tab.name} =`);
    tab.lines.forEach((tabLine, lineIndex) => {
      const instrument = sequence.instruments[lineIndex];
      const suffix = instrument == null ? "" : `  # ${instrument}`;
      lines.push(`${tabLine}${suffix}`);
    });
    lines.push("");
  }

  for (const item of sequence.sequences) {
    lines.push(`sequence ${item.name} =`);
    lines.push(item.expression);
    lines.push("");
  }

  if (sequence.entry != null) {
    lines.push(`play ${sequence.entry}`, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function metadataBarLayoutLines(sequence) {
  const layout = sequence.editor?.barLayout ?? [];
  if (layout.length === 0) {
    return [];
  }

  return [`# webapp: barLayout = ${formatBarLayout(layout)}`];
}

function readSequenceEditorMetadata(line, model, lineNumber, diagnostics) {
  const match = line.match(/^\s*#\s*webapp:\s*barLayout\s*=\s*(.*)$/i);
  if (match == null) {
    return;
  }

  model.editor.barLayout = parseBarLayout(match[1], lineNumber, diagnostics);
}

function parseBarLayout(value, lineNumber, diagnostics) {
  const tokens = value.split(/[,\s]+/).map((token) => token.trim()).filter(Boolean);
  const layout = [];

  for (const token of tokens) {
    const match = token.match(/^([1-9][0-9]*)x([1-9][0-9]*)$/i);
    if (match == null) {
      diagnostics.push(createDiagnostic("error", `Invalid bar layout token "${token}". Use beats x columns, such as 4x4.`, lineNumber));
      continue;
    }

    layout.push({
      beats: Number.parseInt(match[1], 10),
      columnsPerBeat: Number.parseInt(match[2], 10)
    });
  }

  return layout;
}

function formatBarLayout(layout) {
  return layout.map((entry) => `${entry.beats}x${entry.columnsPerBeat}`).join(" ");
}

export function buildSequenceBarLayout(sequence, totalColumns, options = {}) {
  const fallback = getDefaultBarSpec(sequence, options);
  const explicitLayout = Array.isArray(sequence.editor?.barLayout)
    ? sequence.editor.barLayout.map((entry) => normalizeBarSpec(entry, fallback))
    : [];
  const explicitColumns = explicitLayout.reduce((sum, entry) => sum + getBarColumns(entry), 0);
  const minimumColumns = getBarColumns(fallback);
  const targetColumns = Math.max(0, totalColumns, explicitColumns, minimumColumns);
  const bars = [];
  let startColumn = 0;
  let index = 0;

  while (startColumn < targetColumns || index < explicitLayout.length) {
    const spec = normalizeBarSpec(explicitLayout[index], fallback);
    const columns = getBarColumns(spec);
    bars.push({
      index,
      startColumn,
      beats: spec.beats,
      columnsPerBeat: spec.columnsPerBeat,
      columns
    });
    startColumn += columns;
    index += 1;
  }

  return bars;
}

export function editSequenceDisplay(sequence, edit, options = {}) {
  if (edit.scope === "instrument") {
    return editSequenceInstruments(sequence, edit);
  }

  const song = resolveSequenceDisplaySong(sequence);
  const totalColumns = getLineWidth(song.lines);
  const barLayout = buildSequenceBarLayout(sequence, totalColumns, options);
  const nextBarLayout = barLayout.map(({ beats, columnsPerBeat }) => ({ beats, columnsPerBeat }));
  const fallbackBarSpec = getDefaultBarSpec(sequence, options);

  if (song.truncated) {
    throw new Error("Cannot edit a truncated sequence display.");
  }

  if (song.segments.length === 0) {
    throw new Error("No playable sequence segments to edit.");
  }

  const segments = createEditableSegments(sequence, song);
  if (edit.scope === "segment") {
    editSequenceSegments(sequence, segments, edit, nextBarLayout, barLayout, fallbackBarSpec);
  } else if (edit.scope === "bar") {
    editSequenceBars(segments, edit, nextBarLayout, barLayout);
  } else if (edit.scope === "bar-setting") {
    editSequenceBarSetting(segments, edit, nextBarLayout, barLayout);
  } else {
    throw new Error(`Unknown sequence edit scope "${edit.scope}".`);
  }

  return createSequenceFromEditableSegments(sequence, segments, nextBarLayout, options);
}

function editSequenceInstruments(sequence, edit) {
  if (edit.intent === "add") {
    const name = normalizeInstrumentEditName(edit.name);
    ensureNewInstrumentName(sequence.instruments, name);
    return {
      ...sequence,
      instruments: [...sequence.instruments, name],
      tabs: sequence.tabs.map((tab) => {
        const width = getTabWidth(tab);
        return {
          ...tab,
          lines: [
            ...normalizeTabInstrumentLines(tab, sequence.instruments.length, width),
            "-".repeat(width)
          ]
        };
      })
    };
  }

  if (edit.intent === "change") {
    const index = normalizeEditIndex(edit.index, sequence.instruments.length);
    const name = normalizeInstrumentEditName(edit.name);
    ensureNewInstrumentName(sequence.instruments.filter((_, itemIndex) => itemIndex !== index), name);
    const instruments = [...sequence.instruments];
    instruments[index] = name;
    return {
      ...sequence,
      instruments
    };
  }

  if (edit.intent === "move") {
    const fromIndex = normalizeEditIndex(edit.index, sequence.instruments.length);
    const toIndex = normalizeEditIndex(edit.targetIndex, sequence.instruments.length);
    if (fromIndex === toIndex) {
      return sequence;
    }

    const instruments = moveArrayItem(sequence.instruments, fromIndex, toIndex);
    return {
      ...sequence,
      instruments,
      tabs: sequence.tabs.map((tab) => {
        const width = getTabWidth(tab);
        return {
          ...tab,
          lines: moveArrayItem(normalizeTabInstrumentLines(tab, sequence.instruments.length, width), fromIndex, toIndex)
        };
      })
    };
  }

  throw new Error(`Unknown instrument edit "${edit.intent}".`);
}

function normalizeInstrumentEditName(name) {
  const value = String(name ?? "").trim();
  if (!IDENTIFIER.test(value)) {
    throw new Error(`Invalid instrument name "${value}".`);
  }
  return value;
}

function ensureNewInstrumentName(instruments, name) {
  if (instruments.includes(name)) {
    throw new Error(`Instrument "${name}" is already in the sequence.`);
  }
}

function normalizeTabInstrumentLines(tab, instrumentCount, width) {
  return Array.from({ length: instrumentCount }, (_, index) => (
    (tab.lines[index] ?? "").padEnd(width, "-")
  ));
}

function moveArrayItem(items, fromIndex, toIndex) {
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

export function summarizeSequence(sequence) {
  const columns = sequence.tabs.reduce((sum, tab) => {
    const longest = tab.lines.reduce((max, line) => Math.max(max, line.length), 0);
    return sum + longest;
  }, 0);

  return {
    instruments: sequence.instruments.length,
    tabs: sequence.tabs.length,
    sequences: sequence.sequences.length,
    columns
  };
}

function createEditableSegments(sequence, song) {
  const instrumentCount = sequence.instruments.length;

  return song.segments.map((segment) => ({
    name: segment.name,
    tempo: segment.tempo,
    columns: segment.columns,
    lines: Array.from({ length: instrumentCount }, (_, lineIndex) => (
      song.lines[lineIndex] ?? ""
    ).slice(segment.startColumn, segment.startColumn + segment.columns).padEnd(segment.columns, "-"))
  }));
}

function editSequenceSegments(sequence, segments, edit, nextBarLayout, barLayout, fallbackBarSpec) {
  const index = normalizeEditIndex(edit.index, segments.length);
  const segmentStart = sumSegmentColumns(segments, index);
  if (edit.intent === "delete") {
    const removedColumns = segments[index].columns;
    segments.splice(index, 1);
    deleteBarLayoutRange(nextBarLayout, barLayout, segmentStart, removedColumns);
    return;
  }

  if (edit.intent !== "add-left" && edit.intent !== "add-right") {
    throw new Error(`Unknown segment edit "${edit.intent}".`);
  }

  const insertIndex = edit.intent === "add-right" ? index + 1 : index;
  const insertColumn = segmentStart + (edit.intent === "add-right" ? segments[index].columns : 0);
  const barInsertIndex = findBarLayoutInsertionIndex(barLayout, insertColumn, edit.intent === "add-right");
  const spec = normalizeBarSpec(
    nextBarLayout[Math.min(barInsertIndex, Math.max(0, nextBarLayout.length - 1))],
    fallbackBarSpec
  );
  const columns = getBarColumns(spec);
  const sourceSegment = segments[index];
  segments.splice(insertIndex, 0, {
    name: nextInsertedSegmentName(sequence, segments),
    tempo: sourceSegment?.tempo ?? sequence.timing.beatsPerMinute,
    columns,
    lines: Array.from({ length: sequence.instruments.length }, () => "-".repeat(columns))
  });
  nextBarLayout.splice(barInsertIndex, 0, spec);
}

function editSequenceBars(segments, edit, nextBarLayout, barLayout) {
  const barIndex = normalizeEditIndex(edit.index, barLayout.length);
  const bar = barLayout[barIndex];

  if (edit.intent === "delete") {
    deleteColumnsFromSegments(segments, bar.startColumn, bar.columns);
    nextBarLayout.splice(barIndex, 1);
    return;
  }

  if (edit.intent !== "add-left" && edit.intent !== "add-right") {
    throw new Error(`Unknown bar edit "${edit.intent}".`);
  }

  const insertColumn = edit.intent === "add-right" ? bar.startColumn + bar.columns : bar.startColumn;
  const spec = { beats: bar.beats, columnsPerBeat: bar.columnsPerBeat };
  insertColumnsIntoSegments(segments, insertColumn, bar.columns, edit.intent === "add-right");
  nextBarLayout.splice(edit.intent === "add-right" ? barIndex + 1 : barIndex, 0, spec);
}

function editSequenceBarSetting(segments, edit, nextBarLayout, barLayout) {
  const barIndex = normalizeEditIndex(edit.index, barLayout.length);
  const bar = barLayout[barIndex];
  const currentSpec = { beats: bar.beats, columnsPerBeat: bar.columnsPerBeat };
  const nextSpec = normalizeBarSpec({
    beats: edit.beats ?? currentSpec.beats,
    columnsPerBeat: edit.columnsPerBeat ?? currentSpec.columnsPerBeat
  }, currentSpec);
  const nextColumns = getBarColumns(nextSpec);
  const deltaColumns = nextColumns - bar.columns;

  if (deltaColumns > 0) {
    insertColumnsIntoSegments(segments, bar.startColumn + bar.columns, deltaColumns, true);
  } else if (deltaColumns < 0) {
    deleteColumnsFromSegments(segments, bar.startColumn + nextColumns, -deltaColumns);
  }

  nextBarLayout[barIndex] = nextSpec;
}

function insertColumnsIntoSegments(segments, sequenceColumn, columns, preferPreviousBoundary) {
  const target = findSegmentInsertionPoint(segments, sequenceColumn, preferPreviousBoundary);
  if (target == null) {
    throw new Error("No sequence segment found for bar insertion.");
  }

  const segment = segments[target.index];
  segment.lines = segment.lines.map((line) => (
    `${line.slice(0, target.localColumn)}${"-".repeat(columns)}${line.slice(target.localColumn)}`
  ));
  segment.columns += columns;
}

function deleteColumnsFromSegments(segments, deleteStart, columns) {
  const deleteEnd = deleteStart + columns;
  let sequenceColumn = 0;
  let removedColumns = 0;

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    sequenceColumn = sumSegmentColumns(segments, index);
    const segmentStart = sequenceColumn;
    const segmentEnd = segmentStart + segment.columns;
    const overlapStart = Math.max(segmentStart, deleteStart);
    const overlapEnd = Math.min(segmentEnd, deleteEnd);

    if (overlapEnd <= overlapStart) {
      continue;
    }

    const localStart = overlapStart - segmentStart;
    const localEnd = overlapEnd - segmentStart;
    const removed = localEnd - localStart;
    removedColumns += removed;
    segment.lines = segment.lines.map((line) => `${line.slice(0, localStart)}${line.slice(localEnd)}`);
    segment.columns -= removed;

    if (segment.columns <= 0) {
      segments.splice(index, 1);
    }
  }

  if (removedColumns === 0) {
    throw new Error("No sequence columns found for that measure.");
  }
}

function findSegmentInsertionPoint(segments, sequenceColumn, preferPreviousBoundary) {
  let startColumn = 0;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const endColumn = startColumn + segment.columns;

    if (sequenceColumn > startColumn && sequenceColumn < endColumn) {
      return { index, localColumn: sequenceColumn - startColumn };
    }

    if (sequenceColumn === startColumn) {
      if (preferPreviousBoundary && index > 0) {
        return { index: index - 1, localColumn: segments[index - 1].columns };
      }
      return { index, localColumn: 0 };
    }

    if (sequenceColumn === endColumn) {
      if (preferPreviousBoundary || index === segments.length - 1) {
        return { index, localColumn: segment.columns };
      }
      return { index: index + 1, localColumn: 0 };
    }

    startColumn = endColumn;
  }

  if (segments.length === 0) {
    return null;
  }

  return { index: segments.length - 1, localColumn: segments.at(-1).columns };
}

function createSequenceFromEditableSegments(sourceSequence, editableSegments, barLayout, options = {}) {
  const segments = editableSegments.filter((segment) => segment.columns > 0);
  if (segments.length === 0) {
    return {
      ...sourceSequence,
      editor: {
        ...sourceSequence.editor,
        barLayout: []
      },
      tabs: [],
      sequences: [],
      entry: null
    };
  }

  const usedTabNames = new Set();
  const tabs = segments.map((segment, index) => {
    const name = uniqueIdentifier(segment.name, usedTabNames, `segment${index + 1}`);
    usedTabNames.add(name);
    return {
      name,
      lines: segment.lines.map((line) => line.padEnd(segment.columns, "-")),
      line: null
    };
  });
  const entryName = uniqueIdentifier(sourceSequence.entry ?? "song", usedTabNames, "song");
  const expression = createSequenceExpression(sourceSequence, segments, tabs);
  const totalColumns = getLineWidth(tabs.flatMap((tab) => tab.lines));

  return {
    ...sourceSequence,
    editor: {
      ...sourceSequence.editor,
      barLayout: compactBarLayoutForExport(sourceSequence, barLayout, totalColumns, options)
    },
    tabs,
    sequences: [{
      name: entryName,
      expression,
      line: null
    }],
    entry: entryName
  };
}

function deleteBarLayoutRange(nextBarLayout, barLayout, startColumn, columns) {
  const endColumn = startColumn + columns;
  const deleteIndexes = [];

  for (const bar of barLayout) {
    if (bar.startColumn >= startColumn && bar.startColumn < endColumn) {
      deleteIndexes.push(bar.index);
    }
  }

  for (const index of deleteIndexes.reverse()) {
    nextBarLayout.splice(index, 1);
  }
}

function findBarLayoutInsertionIndex(barLayout, sequenceColumn, preferPreviousBoundary) {
  for (const bar of barLayout) {
    const endColumn = bar.startColumn + bar.columns;
    if (sequenceColumn > bar.startColumn && sequenceColumn < endColumn) {
      return bar.index + 1;
    }
    if (sequenceColumn === bar.startColumn) {
      return preferPreviousBoundary ? Math.max(0, bar.index) : bar.index;
    }
    if (sequenceColumn === endColumn) {
      return preferPreviousBoundary ? bar.index + 1 : Math.min(bar.index + 1, barLayout.length);
    }
  }

  return barLayout.length;
}

function sumSegmentColumns(segments, endIndex) {
  return segments.slice(0, endIndex).reduce((sum, segment) => sum + segment.columns, 0);
}

function getLineWidth(lines) {
  return lines.reduce((max, line) => Math.max(max, line.length), 0);
}

function compactBarLayoutForExport(sequence, barLayout, totalColumns, options = {}) {
  const fallback = getDefaultBarSpec(sequence, options);
  const bars = buildSequenceBarLayout({
    ...sequence,
    editor: { barLayout }
  }, totalColumns, options);
  const specs = bars.map(({ beats, columnsPerBeat }) => ({ beats, columnsPerBeat }));
  let lastCustomIndex = -1;

  for (let index = 0; index < specs.length; index += 1) {
    if (specs[index].beats !== fallback.beats || specs[index].columnsPerBeat !== fallback.columnsPerBeat) {
      lastCustomIndex = index;
    }
  }

  return lastCustomIndex === -1 ? [] : specs.slice(0, lastCustomIndex + 1);
}

function getDefaultBarSpec(sequence, options = {}) {
  const beats = Number.isInteger(options.defaultBeatsPerBar) && options.defaultBeatsPerBar > 0
    ? options.defaultBeatsPerBar
    : Number.isInteger(options.beatsPerBar) && options.beatsPerBar > 0
      ? options.beatsPerBar
      : DEFAULT_BEATS_PER_BAR;
  const columnsPerBeat = Number.isInteger(sequence.timing.columnsPerBeat) && sequence.timing.columnsPerBeat > 0
    ? sequence.timing.columnsPerBeat
    : 1;

  return { beats, columnsPerBeat };
}

function normalizeBarSpec(spec, fallback) {
  const beats = Number.isInteger(spec?.beats) && spec.beats > 0 ? spec.beats : fallback.beats;
  const columnsPerBeat = Number.isInteger(spec?.columnsPerBeat) && spec.columnsPerBeat > 0
    ? spec.columnsPerBeat
    : fallback.columnsPerBeat;

  return { beats, columnsPerBeat };
}

function getBarColumns(spec) {
  return spec.beats * spec.columnsPerBeat;
}

function createSequenceExpression(sequence, segments, tabs) {
  const tokens = [];
  let currentTempo = sequence.timing.beatsPerMinute;

  for (let index = 0; index < tabs.length; index += 1) {
    const tempo = segments[index].tempo;
    if (tempo !== currentTempo) {
      tokens.push("tempo", formatNumber(tempo));
      currentTempo = tempo;
    }
    tokens.push(tabs[index].name);
  }

  return tokens.join(" ");
}

function nextInsertedSegmentName(sequence, segments) {
  const used = new Set([
    ...sequence.tabs.map((tab) => tab.name),
    ...sequence.sequences.map((item) => item.name),
    ...segments.map((segment) => segment.name)
  ]);
  let index = segments.length + 1;
  let name = `segment${index}`;

  while (used.has(name)) {
    index += 1;
    name = `segment${index}`;
  }

  return name;
}

function uniqueIdentifier(name, used, fallback) {
  const base = normalizeIdentifier(name, fallback);
  let candidate = base;
  let index = 2;

  while (used.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }

  return candidate;
}

function normalizeIdentifier(name, fallback) {
  const candidate = String(name ?? "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^[^A-Za-z_]+/, "");

  return IDENTIFIER.test(candidate) ? candidate : fallback;
}

function normalizeEditIndex(index, length) {
  const number = Number(index);
  if (!Number.isInteger(number) || number < 0 || number >= length) {
    throw new Error("Sequence edit target is out of range.");
  }

  return number;
}

export function resolveSequenceDisplaySong(sequence, options = {}) {
  const maxSegments = options.maxSegments ?? MAX_DISPLAY_SEGMENTS;
  const tabs = new Map(sequence.tabs.map((tab) => [tab.name, tab]));
  const sequences = new Map(sequence.sequences.map((item) => [item.name, item]));
  const warnings = [];
  let truncated = false;

  function createTempoContext() {
    return { tempo: sequence.timing.beatsPerMinute };
  }

  function emptyResolution() {
    return {
      parts: [],
      markers: []
    };
  }

  function resolveName(name, stack = [], context = createTempoContext(), depth = 0) {
    if (tabs.has(name)) {
      return {
        parts: [{
          tab: tabs.get(name),
          tempo: context.tempo
        }],
        markers: []
      };
    }

    const item = sequences.get(name);
    if (item == null) {
      warnings.push(`Unknown sequence item "${name}".`);
      return emptyResolution();
    }

    if (stack.includes(name)) {
      warnings.push(`Recursive sequence "${name}" was skipped.`);
      return emptyResolution();
    }

    const resolved = resolveExpression(item.expression, [...stack, name], context, depth + 1);
    return {
      parts: resolved.parts,
      markers: resolved.parts.length === 0
        ? resolved.markers
        : [
            {
              name,
              kind: "sequence",
              depth,
              startPart: 0,
              endPart: resolved.parts.length
            },
            ...resolved.markers
          ]
    };
  }

  function resolveExpression(expression, stack, context, depth) {
    const tokens = expression.match(SEQUENCE_TOKEN) ?? [];
    return parseExpressionTokens(tokens, 0, stack, context, depth);
  }

  function parseExpressionTokens(tokens, startIndex, stack, context, depth) {
    const resolved = emptyResolution();
    let index = startIndex;

    while (index < tokens.length) {
      const token = tokens[index];

      if (token === ")") {
        return { ...resolved, nextIndex: index + 1 };
      }

      let nextResolved = emptyResolution();
      if (token === "(") {
        const group = parseExpressionTokens(tokens, index + 1, stack, context, depth);
        nextResolved = group;
        index = group.nextIndex;
      } else if (token === "tempo") {
        index += 1;
        const value = tokens[index] ?? "";
        if (NUMBER.test(value)) {
          context.tempo = parseTempoToken(value, context.tempo);
          index += 1;
        }
        continue;
      } else if (REPEAT.test(token) || NUMBER.test(token)) {
        index += 1;
        continue;
      } else {
        nextResolved = resolveName(token, stack, context, depth);
        index += 1;
      }

      const repeat = (tokens[index] ?? "").match(REPEAT);
      const count = repeat == null ? 1 : Number.parseInt(repeat[1], 10);
      if (repeat != null) {
        index += 1;
      }

      appendRepeatedResolution(resolved, nextResolved, count);
      if (resolved.parts.length >= maxSegments) {
        return { ...resolved, nextIndex: tokens.length };
      }
    }

    return { ...resolved, nextIndex: index };
  }

  function appendRepeatedResolution(target, source, count) {
    for (let repeatIndex = 0; repeatIndex < count; repeatIndex += 1) {
      const remaining = maxSegments - target.parts.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }

      const includedParts = Math.min(source.parts.length, remaining);
      const offset = target.parts.length;
      target.parts.push(...source.parts.slice(0, includedParts));
      for (const marker of source.markers) {
        if (marker.startPart >= includedParts) {
          continue;
        }
        target.markers.push({
          ...marker,
          startPart: offset + marker.startPart,
          endPart: offset + Math.min(marker.endPart, includedParts)
        });
      }

      if (includedParts < source.parts.length) {
        truncated = true;
        return;
      }
    }
  }

  const entry = chooseDisplayEntry(sequence, tabs, sequences, resolveName);
  const entryResolution = entry == null ? emptyResolution() : resolveName(entry.name, [], createTempoContext(), 0);
  const resolved = concatenateTabParts(sequence.instruments.length, entryResolution.parts);
  const segmentRows = createSequenceSegmentRows(entryResolution.markers, resolved.segments);

  return {
    entryName: entry?.name ?? null,
    entryKind: entry?.kind ?? null,
    selectionReason: entry?.reason ?? "none",
    lines: resolved.lines,
    segments: resolved.segments,
    segmentRows,
    tempoSpans: resolved.tempoSpans,
    truncated,
    warnings
  };
}

function readInstrumentBlock(lines, startIndex) {
  const instruments = [];
  let index = startIndex;

  for (; index < lines.length; index += 1) {
    if (isBlankOrComment(lines[index], "#")) {
      break;
    }

    const source = stripLineComment(lines[index], "#").trim();
    if (source !== "") {
      instruments.push(source);
    }
  }

  return { instruments, nextIndex: index + 1 };
}

function readTabBlock(lines, startIndex) {
  const tabLines = [];
  let index = startIndex;

  for (; index < lines.length; index += 1) {
    if (isBlankOrComment(lines[index], "#")) {
      break;
    }

    const source = stripLineComment(lines[index], "#").replace(/\|/g, "").trim();
    if (source !== "") {
      tabLines.push(source);
    }
  }

  return { tabLines, nextIndex: index + 1 };
}

function readSequenceExpression(lines, startIndex, firstLine) {
  const expression = [];

  if (firstLine.trim() !== "") {
    expression.push(firstLine.trim());
  }

  let index = startIndex;
  for (; index < lines.length; index += 1) {
    if (isBlankOrComment(lines[index], "#")) {
      break;
    }

    const source = stripLineComment(lines[index], "#").trim();
    if (source === "" || startsTopLevelStatement(source)) {
      break;
    }
    expression.push(source);
  }

  return { expression: expression.join(" "), nextIndex: index };
}

function startsTopLevelStatement(source) {
  return /^(instruments\s*=|tab\s+|sequence\s+|play\s+|bpm\s*=|beats_per_minute\s*=|cpb\s*=|qpc\s*=)/.test(source);
}

function chooseDisplayEntry(sequence, tabs, sequences, resolveName) {
  if (sequence.entry != null) {
    if (tabs.has(sequence.entry)) {
      return { name: sequence.entry, kind: "tab", reason: "play" };
    }

    if (sequences.has(sequence.entry)) {
      return { name: sequence.entry, kind: "sequence", reason: "play" };
    }
  }

  if (sequence.sequences.length > 0) {
    return sequence.sequences
      .map((item) => ({
        name: item.name,
        kind: "sequence",
        reason: sequence.entry == null ? "longestSequence" : "fallbackLongestSequence",
        columns: sumTabColumns(resolveName(item.name).parts)
      }))
      .sort((a, b) => b.columns - a.columns)[0];
  }

  if (sequence.tabs.length > 0) {
    return sequence.tabs
      .map((tab) => ({
        name: tab.name,
        kind: "tab",
        reason: sequence.entry == null ? "longestTab" : "fallbackLongestTab",
        columns: getTabWidth(tab)
      }))
      .sort((a, b) => b.columns - a.columns)[0];
  }

  return null;
}

function createSequenceSegmentRows(markers, segments) {
  if (segments.length === 0) {
    return [];
  }

  const totalColumns = segments.at(-1).startColumn + segments.at(-1).columns;
  const rows = [];

  for (const marker of markers) {
    const startColumn = segments[marker.startPart]?.startColumn ?? 0;
    const endColumn = marker.endPart >= segments.length
      ? totalColumns
      : segments[marker.endPart]?.startColumn ?? totalColumns;
    const columns = endColumn - startColumn;
    if (columns <= 0) {
      continue;
    }
    if (rows[marker.depth] == null) {
      rows[marker.depth] = [];
    }
    rows[marker.depth].push({
      name: marker.name,
      kind: marker.kind,
      depth: marker.depth,
      startColumn,
      columns
    });
  }

  return [
    ...rows.filter(Boolean),
    segments.map((segment) => ({
      ...segment,
      kind: "tab",
      depth: rows.length
    }))
  ];
}

function concatenateTabParts(instrumentCount, parts) {
  const lines = Array.from({ length: instrumentCount }, () => "");
  const segments = [];
  const tempoSpans = [];
  let startColumn = 0;

  for (const part of parts) {
    const columns = getTabWidth(part.tab);
    segments.push({
      name: part.tab.name,
      startColumn,
      columns,
      tempo: part.tempo
    });
    appendTempoSpan(tempoSpans, startColumn, columns, part.tempo);

    for (let index = 0; index < instrumentCount; index += 1) {
      lines[index] += (part.tab.lines[index] ?? "").padEnd(columns, "-");
    }

    startColumn += columns;
  }

  return { lines, segments, tempoSpans };
}

function sumTabColumns(parts) {
  return parts.reduce((sum, part) => sum + getTabWidth(part.tab), 0);
}

function getTabWidth(tab) {
  return tab.lines.reduce((max, line) => Math.max(max, line.length), 0);
}

function appendTempoSpan(tempoSpans, startColumn, columns, tempo) {
  const previous = tempoSpans.at(-1);
  if (previous != null && previous.tempo === tempo) {
    previous.columns += columns;
    return;
  }

  tempoSpans.push({
    tempo,
    startColumn,
    columns
  });
}

function parseTempoToken(value, currentTempo) {
  const parsed = Number.parseFloat(value);
  return /^[+-]/.test(value) ? currentTempo + parsed : parsed;
}

function applyTiming(model, key, valueText, line, diagnostics) {
  const value = valueText.trim();
  if (!NUMBER.test(value)) {
    diagnostics.push(createDiagnostic("error", `Invalid timing value "${value}".`, line));
    return;
  }

  const numericValue = Number.parseFloat(value);
  if (key === "bpm" || key === "beats_per_minute") {
    model.timing.beatsPerMinute = numericValue;
  } else if (key === "cpb") {
    model.timing.columnsPerBeat = numericValue;
  } else if (key === "qpc") {
    model.timing.quantaPerColumn = numericValue;
  }
}

function normalizeExpression(expression) {
  return expression.replace(/\s+/g, " ").trim();
}

function extractSequenceReferences(expression) {
  const tokens = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return tokens.filter((token) => token !== "tempo" && !/^x[0-9]+$/i.test(token));
}
