#!/bin/sh
# Downloads the storefront pages used as perf fixtures into perf/fixtures/ (untracked).
# Pages change over time, so a new download changes the guard hashes: record them again
# with `node perf/guard.mts --update` only before the first experiment of a campaign.
set -e
cd "$(dirname "$0")"
mkdir -p fixtures
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
for u in \
  https://www.allbirds.com/products/mens-strider-explore \
  https://rothys.com/products/the-teddy-slipper \
  https://www.brooklinen.com/ \
  https://www.brooklinen.com/pages/our-stores \
  https://colourpop.com/ \
  https://www.deathwishcoffee.com/pages/about \
  https://www.deathwishcoffee.com/products/death-wish-instant-coffee-1 \
  https://www.taylorstitch.com/pages/care-guide \
  https://www.kitandace.com/products/8671730630852-restore-half-zip \
  https://www.kitandace.com/pages/size-guide \
  https://www.tentree.com/pages/about \
  https://www.beardbrand.com/pages/learn-about-us \
  https://www.nativecos.com/pages/about-us \
  https://www.nativecos.com/products/dry-shampoo
do
  f=$(echo "$u" | sed -E 's#https?://(www\.)?##; s#/$##; s#/#_#g').html
  curl -sfL -A "$UA" -H 'Accept-Language: en-US' --max-time 30 -o "fixtures/$f" "$u"
  echo "$f"
done
