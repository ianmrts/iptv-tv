#!/bin/bash
# Junta as listas do iptv-org numa só, com o grupo igual à lista de origem.
set -euo pipefail
base=https://iptv-org.github.io/iptv
out=iptv.m3u
tmp=$(mktemp)
echo '#EXTM3U' > "$tmp"
for pair in "countries/pt:Portugal" "countries/br:Brasil" "countries/uk:Reino Unido" "countries/us:EUA" \
            "categories/sports:Desporto" "categories/movies:Filmes" "categories/series:Séries"; do
  path=${pair%%:*}; group=${pair#*:}
  curl -sSfL --retry 3 "$base/$path.m3u" | tr -d '\r' | awk -v g="$group" '
    NR==1 && /^#EXTM3U/ {next}
    /^#EXTINF/ {
      if ($0 ~ /group-title="[^"]*"/) sub(/group-title="[^"]*"/, "group-title=\"" g "\"")
      else sub(/,/, " group-title=\"" g "\",")
    }
    {print}' >> "$tmp"
done
# Não substitui a lista se algo correu mal e ficou quase vazia
[ "$(grep -c '^#EXTINF' "$tmp")" -gt 500 ] || { echo "Lista demasiado pequena, abortado" >&2; exit 1; }
mv "$tmp" "$out"
echo "Canais: $(grep -c '^#EXTINF' "$out")"
