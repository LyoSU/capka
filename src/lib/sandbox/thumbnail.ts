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
 *  most 200 cached pictures. Distinct exit codes only for the server log.
 *
 *  A document's (not a sheet's: those preview in the browser) intermediate PDF is
 *  KEPT under the same key, because it is also the document preview: with
 *  CAPKA_THUMB_FORMAT=pdf the script makes sure that PDF exists and prints its
 *  size, and PDF_CHUNK_SCRIPT reads it out. Whichever of the two runs first pays
 *  for LibreOffice; the other reuses its PDF. Kept PDFs are capped at 24 MB in
 *  total (newest first) — this /tmp is a small tmpfs charged to the container's
 *  memory. */
export const THUMBNAIL_SCRIPT = String.raw`set -u
cd /workspace || exit 3
f=$(realpath -e -- "$CAPKA_THUMB_PATH" 2>/dev/null) || exit 4
case "$f" in /workspace/*) ;; *) exit 4 ;; esac
[ -f "$f" ] && [ "$(stat -c %s -- "$f")" -le 31457280 ] || exit 5
d=/tmp/.capka-thumbs; mkdir -p "$d" || exit 6
ext=$(printf %s "$f" | sed -n 's/.*\.\([A-Za-z0-9]*\)$/\1/p' | tr '[:upper:]' '[:lower:]')
pdf="$d/$CAPKA_THUMB_KEY.pdf"
out="$d/$CAPKA_THUMB_KEY.png"
[ "$(printenv CAPKA_THUMB_FORMAT || :)" = pdf ] && want=$pdf || want=$out
if [ ! -s "$want" ]; then
  exec 9>"$d/lock"; flock -w 40 9 || exit 7
  if [ ! -s "$want" ]; then
    w=$(mktemp -d "$d/w.XXXXXX") || exit 6
    trap 'rm -rf "$w"' EXIT
    if [ -s "$pdf" ]; then
      cp -- "$pdf" "$w/in.pdf" || exit 6
    else
      cp -- "$f" "$w/in.$ext" || exit 6
      if [ "$ext" != pdf ]; then
        HOME="$d" timeout 40 /usr/bin/soffice -env:UserInstallation="file://$d/profile" --headless --norestore \
          --convert-to pdf --outdir "$w" "$w/in.$ext" >/dev/null 2>&1 || exit 8
        [ -s "$w/in.pdf" ] || exit 8
      fi
      case "$ext" in
        docx|doc|odt|rtf|pptx|ppt|odp)
          cp -- "$w/in.pdf" "$w/keep.pdf" && mv -- "$w/keep.pdf" "$pdf" || exit 6
          # Newest first; drop the rest once their sum passes 24 MB.
          tot=0
          for p in $(ls -1t "$d"/*.pdf 2>/dev/null); do
            tot=$((tot + $(stat -c %s -- "$p"))); [ "$tot" -le 25165824 ] || rm -f -- "$p"
          done ;;
      esac
    fi
    if [ "$want" = "$out" ]; then
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
fi
[ -s "$want" ] || exit 8
if [ "$want" = "$pdf" ]; then stat -c %s -- "$pdf"; else base64 -w0 "$out"; fi`;

/** One slice of a kept PDF (see THUMBNAIL_SCRIPT), base64. Sliced because an exec's
 *  output is capped at 1 MB by the controller: PDF_CHUNK_BYTES of raw bytes is
 *  ~930 KB of base64. The block index comes from the environment as a plain
 *  integer the route formats itself. */
export const PDF_CHUNK_BYTES = 700_000;
export const PDF_CHUNK_SCRIPT = String.raw`f="/tmp/.capka-thumbs/$CAPKA_THUMB_KEY.pdf"
[ -s "$f" ] || exit 4
dd if="$f" bs=${PDF_CHUNK_BYTES} skip="$CAPKA_PDF_CHUNK" count=1 2>/dev/null | base64 -w0`;
