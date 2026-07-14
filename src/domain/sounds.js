import { createDiagnostic } from "./diagnostics.js";
import { FORMAT_VERSION, formatNumber, metadataCommentLines } from "./format.js";
import { stripSourceLines } from "./model.js";
import { countLinesBefore, splitCsv, splitLineComment } from "./text.js";

const NAMED_COLORS = new Set([
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

const SOUND_HEADER = /sound\s*\(([^)]*)\)\s*=\s*\{([\s\S]*?)\}/g;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYMBOL = /^[A-Za-z0-9_#]$/;
const INTEGER = /^[0-9]+$/;
const NUMBER = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;
const RGB_COLOR = /^#[0-9A-Fa-f]{6}$/;

export function parseSoundLibrary(text) {
  const diagnostics = [];
  const sounds = [];
  const matches = [...text.matchAll(SOUND_HEADER)];

  if (matches.length === 0 && text.trim() !== "") {
    diagnostics.push(createDiagnostic("error", "No sound definitions found.", 1));
  }

  for (const match of matches) {
    const line = countLinesBefore(text, match.index);
    const args = splitCsv(match[1]);
    const body = match[2];
    const sound = parseSoundHeader(args, line, diagnostics);

    if (sound != null) {
      sound.channels = parseSoundChannels(body, line, diagnostics);
      sounds.push(sound);
    }
  }

  const library = {
    format: "chopchae.sounds.source",
    formatVersion: FORMAT_VERSION,
    sounds
  };

  diagnostics.push(...validateSoundLibrary(library));
  return { library: stripSourceLines(library), diagnostics };
}

export function validateSoundLibrary(library) {
  const diagnostics = [];
  const seen = new Set();

  for (const sound of library.sounds) {
    const soundLabel = `${sound.name},${sound.symbol}`;

    if (!IDENTIFIER.test(sound.name)) {
      diagnostics.push(createDiagnostic("error", `Invalid sound name "${sound.name}".`, sound.line));
    }

    if (!SYMBOL.test(sound.symbol)) {
      diagnostics.push(createDiagnostic("error", `Invalid sound symbol "${sound.symbol}".`, sound.line));
    }

    if (seen.has(soundLabel)) {
      diagnostics.push(createDiagnostic("error", `Duplicate sound definition "${soundLabel}".`, sound.line));
    }
    seen.add(soundLabel);

    if (sound.channels.length === 0) {
      diagnostics.push(createDiagnostic("warning", `Sound "${sound.name}" has no channel definitions.`, sound.line));
    }

    for (const channel of sound.channels) {
      if (!Number.isInteger(channel.module) || channel.module < 0 || channel.module > 7) {
        diagnostics.push(createDiagnostic("error", `DAC module must be 0..7 for "${soundLabel}".`, channel.line));
      }

      if (!Number.isInteger(channel.channel) || channel.channel < 0 || channel.channel > 7) {
        diagnostics.push(createDiagnostic("error", `DAC channel must be 0..7 for "${soundLabel}".`, channel.line));
      }

      if (channel.values.length === 0) {
        diagnostics.push(createDiagnostic("error", `Channel ${channel.module},${channel.channel} has no values.`, channel.line));
      }

      for (const value of channel.values) {
        if (value.kind === "value" && (value.value < 0 || value.value > 100)) {
          diagnostics.push(createDiagnostic("error", `CV value ${formatNumber(value.value)} must be 0..100.`, channel.line));
        }
      }
    }
  }

  return diagnostics;
}

export function exportSoundLibrary(library, options = {}) {
  const includeMetadata = options.includeMetadata ?? true;
  const lines = includeMetadata
    ? [
        ...metadataCommentLines("//", "chopchae.sounds.dsl"),
        ""
      ]
    : [];

  for (const sound of library.sounds) {
    const args = [sound.name, sound.symbol];
    if (sound.key != null) {
      args.push(String(sound.key));
    }
    if (sound.color != null) {
      args.push(sound.color);
    }

    lines.push(`sound(${args.join(",")}) = {`);

    for (const channel of sound.channels) {
      const values = channel.values.map(formatSoundValue).join(",");
      lines.push(`${channel.module},${channel.channel}: ${values}${formatSoundNote(channel.note)}`);
    }

    lines.push("}", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function summarizeSoundLibrary(library) {
  const channelCount = library.sounds.reduce((sum, sound) => sum + sound.channels.length, 0);
  const aifModules = new Set(library.sounds.flatMap((sound) => sound.channels.map((channel) => channel.module))).size;
  const cvCount = new Set(
    library.sounds.flatMap((sound) => sound.channels.map((channel) => `${channel.module},${channel.channel}`))
  ).size;

  return {
    aifModules,
    cvOutputs: cvCount,
    soundDefs: library.sounds.length,
    cvAssignments: channelCount
  };
}

function parseSoundHeader(args, line, diagnostics) {
  if (args.length < 2 || args.length > 4) {
    diagnostics.push(createDiagnostic("error", "Sound header must have name, symbol, optional key, and optional color.", line));
    return null;
  }

  const [name, symbol, ...extra] = args;
  const sound = {
    name,
    symbol,
    key: null,
    color: null,
    channels: [],
    line
  };

  for (const arg of extra) {
    if (INTEGER.test(arg)) {
      if (sound.key != null) {
        diagnostics.push(createDiagnostic("error", `Duplicate key assignment in "${name}".`, line));
      }
      sound.key = Number.parseInt(arg, 10);
    } else if (isColor(arg)) {
      if (sound.color != null) {
        diagnostics.push(createDiagnostic("error", `Duplicate color assignment in "${name}".`, line));
      }
      sound.color = arg;
    } else {
      diagnostics.push(createDiagnostic("error", `Unknown sound header argument "${arg}".`, line));
    }
  }

  return sound;
}

function parseSoundChannels(body, baseLine, diagnostics) {
  const channels = [];
  const lines = body.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const lineNumber = baseLine + index + 1;
    const { source, comment } = splitLineComment(rawLine, "//");
    const line = source.trim();
    if (line === "") {
      return;
    }

    const match = line.match(/^([0-9]+)\s*,\s*([0-9]+)\s*:\s*(.+)$/);
    if (match == null) {
      diagnostics.push(createDiagnostic("error", `Invalid channel definition "${line}".`, lineNumber));
      return;
    }

    const valueTokens = splitCsv(match[3]);
    const values = valueTokens.map((token) => parseSoundValue(token, lineNumber, diagnostics)).filter(Boolean);

    channels.push({
      module: Number.parseInt(match[1], 10),
      channel: Number.parseInt(match[2], 10),
      values,
      ...(comment == null || comment === "" ? {} : { note: comment }),
      line: lineNumber
    });
  });

  return channels;
}

function parseSoundValue(token, line, diagnostics) {
  if (token === "T") {
    return { kind: "trigger" };
  }

  if (token === "N") {
    return { kind: "scaled" };
  }

  if (NUMBER.test(token)) {
    return { kind: "value", value: Number.parseFloat(token) };
  }

  diagnostics.push(createDiagnostic("error", `Invalid sound value "${token}".`, line));
  return null;
}

function formatSoundValue(value) {
  if (value.kind === "trigger") {
    return "T";
  }

  if (value.kind === "scaled") {
    return "N";
  }

  return formatNumber(value.value);
}

function formatSoundNote(note) {
  if (typeof note !== "string") {
    return "";
  }

  const trimmed = note.replace(/\s+/g, " ").trim();
  return trimmed === "" ? "" : `   // ${trimmed}`;
}

function isColor(value) {
  return NAMED_COLORS.has(value) || RGB_COLOR.test(value);
}
