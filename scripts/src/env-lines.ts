/**
 * Shapes resolved values into the `.env` lines this command prints. Pure text
 * formatting — no network, no filesystem — so it is unit-tested directly against
 * the I/O matrix's "`.env` lines shaped" row.
 */

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Characters that are safe to leave unquoted in a `.env` value: alphanumerics,
// and the punctuation that actually shows up in the values this command emits
// (Stellar ids, URLs, comma-separated lists). Anything else — spaces, the
// passphrase's semicolon, quotes — gets the value quoted.
const SAFE_UNQUOTED_VALUE = /^[A-Za-z0-9_.\-:/,]*$/;
// `process.loadEnvFile` (like the wider `.env` convention it follows) does
// not support escape sequences inside either quote style — it just scans for
// the next matching quote character. So a value can only be quoted if it
// contains none of the quote character it would be wrapped in, and a literal
// newline always breaks the one-line-per-entry format outright.
const UNENCODABLE_VALUE = /[\r\n']/;

/** One `KEY=value` line. Throws if `key` is not a valid, bare `.env` key, or
 * if `value` contains a character this command cannot faithfully encode. */
export function shapeEnvLine(key: string, value: string): string {
  if (!VALID_KEY.test(key)) {
    throw new Error(`"${key}" is not a valid .env key`);
  }
  if (SAFE_UNQUOTED_VALUE.test(value)) {
    return `${key}=${value}`;
  }
  if (UNENCODABLE_VALUE.test(value)) {
    throw new Error(
      `"${key}"'s value contains a newline or a single quote, which cannot be encoded into a .env line`,
    );
  }
  // Single-quoted: `process.loadEnvFile` reads everything between the quotes
  // literally, double quotes included, so nothing needs escaping here.
  return `${key}='${value}'`;
}

/**
 * One line per entry, in the order given. Object key order is insertion order
 * for string keys, so callers control the printed order by building `values`
 * in the order they want it read back.
 */
export function shapeEnvLines(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => shapeEnvLine(key, value))
    .join("\n");
}
