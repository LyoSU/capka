import { createHash } from "node:crypto";

/** A workspace-relative path, or null for anything that tries to leave it. The
 *  render script re-checks with `realpath` inside the sandbox; this keeps the
 *  obvious cases from ever reaching an exec. */
export function workspaceRelative(path: string): string | null {
  const rel = path.replace(/^\/workspace\//, "").replace(/^\.\//, "");
  if (!rel || rel.startsWith("/") || rel.split("/").some((s) => s === ".." || s === "")) return null;
  return rel;
}

/** One rendered thumbnail per file version: the same path edited later (new
 *  mtime or size) is a new key, so a stale picture is never served for it. */
export function thumbnailKey(sessionKey: string, path: string, modifiedAt: string | null, size: number): string {
  // `v2`: the rendering changed (2× resolution, top-of-page crop), so pictures
  // cached under the old scheme are not served for it. Bump it again whenever
  // THUMBNAIL_SCRIPT draws something different.
  return createHash("sha256").update(`v2\0${sessionKey}\0${path}\0${modifiedAt ?? ""}\0${size}`).digest("hex").slice(0, 32);
}

/** Runs inside the sandbox as the sandbox user, with the path and key in the
 *  environment (never interpolated into the command). Prints the PNG as base64.
 *  The cache is in the container's /tmp, not the workspace: it never shows up in
 *  a listing, an archive or the agent's `ls`, and dies with the container.
 *  One render at a time per sandbox (flock), its own LibreOffice profile so it
 *  never collides with a soffice the agent is running, 30 MB / 40 s caps, and at
 *  most 200 cached pictures. Distinct exit codes only for the server log. */
export const THUMBNAIL_SCRIPT = String.raw`set -u
cd /workspace || exit 3
f=$(realpath -e -- "$CAPKA_THUMB_PATH" 2>/dev/null) || exit 4
case "$f" in /workspace/*) ;; *) exit 4 ;; esac
[ -f "$f" ] && [ "$(stat -c %s -- "$f")" -le 31457280 ] || exit 5
d=/tmp/.capka-thumbs; mkdir -p "$d" || exit 6
out="$d/$CAPKA_THUMB_KEY.png"
if [ ! -s "$out" ]; then
  exec 9>"$d/lock"; flock -w 40 9 || exit 7
  if [ ! -s "$out" ]; then
    w=$(mktemp -d "$d/w.XXXXXX") || exit 6
    trap 'rm -rf "$w"' EXIT
    ext=$(printf %s "$f" | sed -n 's/.*\.\([A-Za-z0-9]*\)$/\1/p' | tr '[:upper:]' '[:lower:]')
    cp -- "$f" "$w/in.$ext" || exit 6
    if [ "$ext" != pdf ]; then
      HOME="$d" timeout 40 /usr/bin/soffice -env:UserInstallation="file://$d/profile" --headless --norestore \
        --convert-to pdf --outdir "$w" "$w/in.$ext" >/dev/null 2>&1 || exit 8
    fi
    # 640px wide: about twice the width a tile draws it at, so it is sharp on a
    # retina screen. Only the top of the page is kept (640x480) — the tile shows
    # the top of a document, and the rest would be bytes nobody sees.
    case "$ext" in
      # A sheet prints small in a corner of an empty page: render the page 1400px
      # wide, cut the margins away, then fit the used range to the width — but
      # zoom at most 2x (pad to 700px first), so three columns do not turn into
      # three giant cells.
      xlsx|xls|ods)
        timeout 15 pdftoppm -png -f 1 -l 1 -singlefile -scale-to-x 1400 -scale-to-y -1 "$w/in.pdf" "$w/t" >/dev/null 2>&1 || exit 9
        timeout 15 convert "$w/t.png" -trim +repage -bordercolor white -border 16 "$w/t.png" >/dev/null 2>&1 || exit 9
        tw=$(identify -format %w "$w/t.png") && th=$(identify -format %h "$w/t.png") || exit 9
        timeout 15 convert "$w/t.png" -background white -gravity NorthWest -extent "$((tw > 700 ? tw : 700))x$th" \
          -resize 640x -crop 640x480+0+0 +repage "$w/t.png" >/dev/null 2>&1 || exit 9 ;;
      *) timeout 15 pdftoppm -png -f 1 -l 1 -singlefile -scale-to-x 640 -scale-to-y -1 -W 640 -H 480 "$w/in.pdf" "$w/t" >/dev/null 2>&1 || exit 9 ;;
    esac
    mv "$w/t.png" "$out" || exit 6
    ls -1t "$d"/*.png 2>/dev/null | tail -n +201 | xargs -r rm -f
  fi
fi
base64 -w0 "$out"`;
