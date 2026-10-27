#!/bin/bash
# Merges the iptv-org playlists into one, with the group set to the source playlist.
set -euo pipefail
base=https://iptv-org.github.io/iptv
out=${1:-iptv.m3u}
tmp=$(mktemp)
echo '#EXTM3U' > "$tmp"
for pair in "countries/pt:Portugal" "countries/br:Brazil" "countries/uk:United Kingdom" "countries/ie:Ireland" \
            "countries/us:USA" "categories/sports:Sports" "categories/movies:Movies" "categories/series:Series"; do
  path=${pair%%:*}; group=${pair#*:}
  curl -sSfL --retry 3 "$base/$path.m3u" | tr -d '\r' | awk -v g="$group" '
    NR==1 && /^#EXTM3U/ {next}
    /^#EXTINF/ {
      if ($0 ~ /group-title="[^"]*"/) sub(/group-title="[^"]*"/, "group-title=\"" g "\"")
      else sub(/,/, " group-title=\"" g "\",")
    }
    {print}' >> "$tmp"
done
# Keep the previous playlist if something went wrong and it came out nearly empty
[ "$(grep -c '^#EXTINF' "$tmp")" -gt 500 ] || { echo "Playlist too small, aborting" >&2; exit 1; }
mv "$tmp" "$out"
echo "Channels: $(grep -c '^#EXTINF' "$out")"
