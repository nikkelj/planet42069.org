import path from "node:path";

/** `<slug>_<YYYY-MM-DD>_trajectory[_sim].csv|kml` */
const TRAJECTORY_FILE =
  /^[a-z0-9]+(?:-[a-z0-9]+)*_\d{4}-\d{2}-\d{2}_trajectory(?:_sim)?\.(?:csv|kml)$/i;

/** Basename to send as a download, or null when the URL is not a trajectory file. */
export function trajectoryAttachmentName(urlPath: string): string | null {
  const pathOnly = urlPath.split("?")[0]?.split("#")[0] ?? urlPath;
  let base: string;
  try {
    base = decodeURIComponent(pathOnly.split("/").pop() ?? "");
  } catch {
    return null;
  }
  if (!TRAJECTORY_FILE.test(base)) return null;
  if (base.includes('"') || /[\r\n\\]/.test(base)) return null;
  return base;
}

export function contentDisposition(filename: string): string {
  return `attachment; filename="${filename}"`;
}

/** Resolve a URL path inside `root`, or null if it escapes the directory. */
export function safePublicFile(root: string, urlPath: string): string | null {
  const pathname = urlPath.split("?")[0]?.split("#")[0] ?? urlPath;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/")) return null;
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, `.${decoded}`);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) return null;
  return abs;
}
