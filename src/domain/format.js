export const GENERATOR_NAME = "chopchae-webapp";
export const GENERATOR_VERSION = "0.1.0";
export const FORMAT_VERSION = 1;

export function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  return String(Number(value.toFixed(6))).replace(/\.0+$/, "");
}

export function commonMetadata(format) {
  return {
    format,
    formatVersion: FORMAT_VERSION,
    generator: GENERATOR_NAME,
    generatorVersion: GENERATOR_VERSION
  };
}

export function metadataCommentLines(commentPrefix, format) {
  const metadata = commonMetadata(format);
  return [
    `${commentPrefix} format: ${metadata.format}`,
    `${commentPrefix} formatVersion: ${metadata.formatVersion}`,
    `${commentPrefix} generator: ${metadata.generator}`,
    `${commentPrefix} generatorVersion: ${metadata.generatorVersion}`
  ];
}
