/**
 * Package a generated .twb into a .twbx (packaged workbook).
 *
 * A .twbx is simply a ZIP archive containing the .twb at its root (plus, for
 * workbooks with embedded/extract data, a Data/ folder — not needed here since we
 * reference a PUBLISHED datasource on the server via <repository-location>).
 *
 * We build the archive in memory with fflate so the exact same bytes can be sent
 * to the Tableau REST publish endpoint without touching disk.
 */
import { zipSync, strToU8 } from 'fflate';

/** Filesystem-safe base name for the entry inside the archive. */
function sanitizeEntryName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_ ]/g, '_').slice(0, 120) || 'workbook';
}

/**
 * Build a .twbx buffer from the workbook XML.
 *
 * @param twbXml     The full .twb XML string.
 * @param workbookName Display name used for the .twb entry inside the archive.
 * @returns A Buffer containing the packaged workbook (ZIP).
 */
export function packageTwbx(twbXml: string, workbookName: string): Buffer {
  const entryName = `${sanitizeEntryName(workbookName)}.twb`;
  const zipped = zipSync(
    { [entryName]: strToU8(twbXml) },
    // Deflate at a moderate level; Tableau reads standard ZIP/deflate archives.
    { level: 6 },
  );
  return Buffer.from(zipped);
}
