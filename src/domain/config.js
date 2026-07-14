import { createDiagnostic } from "./diagnostics.js";
import { FORMAT_VERSION, metadataCommentLines } from "./format.js";
import { stripSourceLines } from "./model.js";
import { stripLineComment } from "./text.js";

const SECTION = /^\[([A-Za-z0-9_.-]+)\]$/;
const KEY_VALUE = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/;
const HEX = /^0x[0-9A-Fa-f]+$/;
const DECIMAL = /^[+-]?[0-9]+$/;

export function parseConfigFile(text) {
  const diagnostics = [];
  const config = {
    format: "chopchae.config.source",
    formatVersion: FORMAT_VERSION,
    sections: []
  };

  let currentSection = null;
  const lines = text.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const source = stripLineComment(rawLine, "#").trim();

    if (source === "") {
      return;
    }

    const sectionMatch = source.match(SECTION);
    if (sectionMatch != null) {
      currentSection = {
        name: sectionMatch[1],
        entries: [],
        line: lineNumber
      };
      config.sections.push(currentSection);
      return;
    }

    const entryMatch = source.match(KEY_VALUE);
    if (entryMatch != null) {
      if (currentSection == null) {
        diagnostics.push(createDiagnostic("error", `Setting "${entryMatch[1]}" appears before a section.`, lineNumber));
        return;
      }

      currentSection.entries.push({
        key: entryMatch[1],
        value: parseConfigValue(entryMatch[2].trim()),
        rawValue: entryMatch[2].trim(),
        line: lineNumber
      });
      return;
    }

    diagnostics.push(createDiagnostic("warning", `Unrecognized config line "${source}".`, lineNumber));
  });

  diagnostics.push(...validateConfig(config));
  return { config: stripSourceLines(config), diagnostics };
}

export function validateConfig(config) {
  const diagnostics = [];
  const sectionNames = new Set();

  for (const section of config.sections) {
    if (sectionNames.has(section.name)) {
      diagnostics.push(createDiagnostic("warning", `Duplicate config section "${section.name}".`, section.line));
    }
    sectionNames.add(section.name);

    const keys = new Set();
    for (const entry of section.entries) {
      if (keys.has(entry.key)) {
        diagnostics.push(createDiagnostic("warning", `Duplicate setting "${entry.key}" in [${section.name}].`, entry.line));
      }
      keys.add(entry.key);
    }
  }

  if (!sectionNames.has("config")) {
    diagnostics.push(createDiagnostic("warning", "Config is missing [config].", null));
  }

  return diagnostics;
}

export function exportConfigFile(config) {
  const lines = [
    ...metadataCommentLines("#", "chopchae.config.ini"),
    ""
  ];

  for (const section of config.sections) {
    lines.push(`[${section.name}]`);
    for (const entry of section.entries) {
      lines.push(`${entry.key} = ${formatConfigValue(entry)}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function summarizeConfig(config) {
  const settings = config.sections.reduce((sum, section) => sum + section.entries.length, 0);
  return {
    sections: config.sections.length,
    settings
  };
}

function parseConfigValue(rawValue) {
  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  if (HEX.test(rawValue)) {
    return Number.parseInt(rawValue, 16);
  }

  if (DECIMAL.test(rawValue)) {
    return Number.parseInt(rawValue, 10);
  }

  return rawValue;
}

function formatConfigValue(entry) {
  if (typeof entry.value === "boolean") {
    return entry.value ? "true" : "false";
  }

  return entry.rawValue;
}
