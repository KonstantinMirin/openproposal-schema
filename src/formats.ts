import type { Ajv2020 } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";

/**
 * The RFC 9562 string form of a UUID: 32 hexadecimal digits in five groups,
 * either case. JSON Schema 2020-12 asserts `uuid` by this form (validation
 * § 7.3.5); ajv-formats also accepts a `urn:uuid:` prefix, which is a URN,
 * not a UUID's string form, so every validator here replaces its check.
 */
export const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** Installs the formats an Ajv validator asserts: ajv-formats, with `uuid` as RFC 9562 writes it. */
export function installFormats(ajv: Ajv2020): Ajv2020 {
  ajvFormats.default(ajv);
  ajv.addFormat("uuid", UUID);
  return ajv;
}
