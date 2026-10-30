#!/bin/bash
# Merges the iptv-org playlists into one, with the group set to the source playlist.
# Ireland's list repeats many UK channels; those are left out, so Ireland shows only its own.
set -euo pipefail
base=https://iptv-org.github.io/iptv
out=${1:-iptv.m3u}
tmp=$(mktemp)
uk=$(mktemp)  # tvg-ids (without the "@feed" part) and stream URLs of the UK group
trap 'rm -f "$uk"' EXIT
echo '#EXTM3U' > "$tmp"
for pair in "countries/pt:Portugal" "countries/br:Brazil" "countries/uk:United Kingdom" "countries/ie:Ireland" \
            "countries/us:USA" "categories/sports:Sports" "categories/movies:Movies" "categories/series:Series"; do
  path=${pair%%:*}; group=${pair#*:}
  curl -sSfL --retry 3 "$base/$path.m3u" | tr -d '\r' | awk -v g="$group" -v ukfile="$uk" '
    BEGIN { if (g == "Ireland") while ((getline k < ukfile) > 0) seen[k] = 1 }
    NR==1 && /^#EXTM3U/ {next}
    # One channel = its #EXTINF line, any option lines, then the stream URL: buffer it whole.
    /^#EXTINF/ {
      if ($0 ~ /group-title="[^"]*"/) sub(/group-title="[^"]*"/, "group-title=\"" g "\"")
      else sub(/,/, " group-title=\"" g "\",")
      id = ""
      if (match($0, /tvg-id="[^"]*"/)) { id = substr($0, RSTART + 8, RLENGTH - 9); sub(/@.*/, "", id) }
      buf = $0; inentry = 1; next
    }
    inentry && /^#/ { buf = buf "\n" $0; next }
    inentry {
      inentry = 0
      if (g == "Ireland" && ((id != "" && (id in seen)) || ($0 in seen))) next
      if (g == "United Kingdom") { if (id != "") print id > ukfile; print $0 > ukfile }
      print buf; print; next
    }
    {print}' >> "$tmp"
done
# Keep the previous playlist if something went wrong and it came out nearly empty
[ "$(grep -c '^#EXTINF' "$tmp")" -gt 500 ] || { echo "Playlist too small, aborting" >&2; exit 1; }
mv "$tmp" "$out"
echo "Channels: $(grep -c '^#EXTINF' "$out")"
