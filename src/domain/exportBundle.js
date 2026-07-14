import { commonMetadata } from "./format.js";
import { exportConfigFile } from "./config.js";
import { exportSequenceFile } from "./sequences.js";
import { exportSoundLibrary } from "./sounds.js";

export function createExportBundle({ sounds = null, sequence = null, config = null }) {
  const files = [];

  if (sounds != null) {
    files.push({
      kind: "sounds",
      fileName: "gen_sounds.txt",
      content: exportSoundLibrary(sounds),
      format: "chopchae.sounds.dsl"
    });
  }

  if (sequence != null) {
    files.push({
      kind: "sequence",
      fileName: "gen_sequence.txt",
      content: exportSequenceFile(sequence),
      format: "chopchae.sequence.dsl"
    });
  }

  if (config != null) {
    files.push({
      kind: "config",
      fileName: "gen_config.txt",
      content: exportConfigFile(config),
      format: "chopchae.config.ini"
    });
  }

  const manifest = createManifest(files);
  files.push({
    kind: "manifest",
    fileName: "gen_manifest.json",
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    format: "chopchae.export.manifest"
  });

  return files;
}

function createManifest(files) {
  return {
    ...commonMetadata("chopchae.export.manifest"),
    artifacts: files.map((file) => ({
      kind: file.kind,
      file: file.fileName,
      format: file.format,
      bytes: utf8ByteLength(file.content),
      checksum: fnv1a(file.content)
    }))
  };
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}

function fnv1a(text) {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;

  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}
