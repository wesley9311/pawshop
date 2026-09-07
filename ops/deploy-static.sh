#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root so ownership, release links, and Nginx reload are controlled.' >&2
  exit 1
fi

: "${PAWSHOP_SOURCE_DIR:?Set PAWSHOP_SOURCE_DIR to the checked-out repository.}"
: "${PAWSHOP_RELEASE_ID:?Set PAWSHOP_RELEASE_ID to the full Git commit SHA.}"
: "${PAWSHOP_HTTPS_ORIGIN:?Set PAWSHOP_HTTPS_ORIGIN, for example https://pawlivora.com.}"
: "${PAWSHOP_HTTP_ORIGIN:?Set PAWSHOP_HTTP_ORIGIN, for example http://pawlivora.com.}"

for required_command in git tar curl python3 nginx systemctl; do
  command -v "$required_command" >/dev/null || {
    echo "Required production command is unavailable: $required_command" >&2
    exit 1
  }
done

if [[ ! $PAWSHOP_RELEASE_ID =~ ^[0-9a-f]{40}$ ]]; then
  echo 'PAWSHOP_RELEASE_ID must be a full lowercase Git commit SHA.' >&2
  exit 1
fi

probe_host=$(python3 - "$PAWSHOP_HTTP_ORIGIN" "$PAWSHOP_HTTPS_ORIGIN" <<'PY'
import sys
from urllib.parse import urlsplit

http_origin, https_origin = map(urlsplit, sys.argv[1:])
valid = (
    http_origin.scheme == 'http' and https_origin.scheme == 'https'
    and http_origin.hostname == https_origin.hostname
    and http_origin.hostname is not None
    and http_origin.port is None and https_origin.port is None
    and not http_origin.username and not https_origin.username
    and not http_origin.query and not https_origin.query
    and not http_origin.fragment and not https_origin.fragment
    and http_origin.path in ('', '/') and https_origin.path in ('', '/')
)
if not valid:
    raise SystemExit('Production origins must be matching standard-port HTTP and HTTPS origins.')
print(http_origin.hostname)
PY
)
http_resolve=(--resolve "$probe_host:80:127.0.0.1")
https_resolve=(--resolve "$probe_host:443:127.0.0.1")

release_root=/srv/pawshop/releases
release_dir="$release_root/$PAWSHOP_RELEASE_ID"
staging_dir="$release_root/.${PAWSHOP_RELEASE_ID}.staging"
current_link=/srv/pawshop/current
previous_target=
release_created=0
probe_catalog=
probe_headers=

public_paths=(
  index.html PawShop.html product.html shipping.html returns.html privacy.html
  terms.html catalog.json config.js safe.js support.js policy.css favicon.svg
  robots.txt assets
)

cleanup() {
  rm -rf -- "$staging_dir"
  [[ -z $probe_catalog ]] || rm -f -- "$probe_catalog"
  [[ -z $probe_headers ]] || rm -f -- "$probe_headers"
}
rollback() {
  local status=$?
  cleanup
  if [[ -n $previous_target && -e $previous_target ]]; then
    ln -sfn -- "$previous_target" "$current_link"
    nginx -t >/dev/null && systemctl reload nginx
  elif [[ -L $current_link && $(readlink -f -- "$current_link") == "$release_dir" ]]; then
    rm -f -- "$current_link"
  fi
  [[ $release_created == 0 ]] || rm -rf -- "$release_dir"
  exit "$status"
}
trap rollback ERR INT TERM

resolved_commit=$(git -C "$PAWSHOP_SOURCE_DIR" rev-parse --verify "$PAWSHOP_RELEASE_ID^{commit}")
if [[ $resolved_commit != "$PAWSHOP_RELEASE_ID" ]]; then
  echo 'The requested release does not resolve to the exact commit.' >&2
  exit 1
fi
if [[ $(git -C "$PAWSHOP_SOURCE_DIR" rev-parse HEAD) != "$PAWSHOP_RELEASE_ID" ]] ||
   ! git -C "$PAWSHOP_SOURCE_DIR" diff --quiet ||
   ! git -C "$PAWSHOP_SOURCE_DIR" diff --cached --quiet; then
  echo 'The production checkout must be on the requested commit with no tracked changes.' >&2
  exit 1
fi
if [[ -e $release_dir ]]; then
  echo "Release already exists: $release_dir" >&2
  exit 1
fi

mkdir -p -- "$release_root"
cleanup
mkdir -- "$staging_dir"
git -C "$PAWSHOP_SOURCE_DIR" archive "$PAWSHOP_RELEASE_ID" -- "${public_paths[@]}" | tar -x -C "$staging_dir"

if find "$staging_dir" -type l -print -quit | grep -q .; then
  echo 'Public release contains a symbolic link; refusing deployment.' >&2
  exit 1
fi
for forbidden in admin.html dashboard.html account.html _commerce .git .env; do
  if [[ -e "$staging_dir/$forbidden" ]]; then
    echo "Forbidden public release path: $forbidden" >&2
    exit 1
  fi
done

chown -R root:root -- "$staging_dir"
chmod -R u=rwX,go=rX -- "$staging_dir"
mv -- "$staging_dir" "$release_dir"
release_created=1
if [[ -L $current_link ]]; then previous_target=$(readlink -f -- "$current_link"); fi
ln -sfn -- "$release_dir" "$current_link"
nginx -t
systemctl reload nginx

probe_catalog=$(mktemp)
probe_headers=$(mktemp)
read -r redirect_status redirect_target < <(
  curl "${http_resolve[@]}" --silent --show-error --max-time 10 --output /dev/null \
    --write-out '%{http_code} %{redirect_url}\n' "$PAWSHOP_HTTP_ORIGIN/"
)
if [[ $redirect_status != 301 && $redirect_status != 308 ]] ||
   [[ $redirect_target != "$PAWSHOP_HTTPS_ORIGIN/" ]]; then
  echo 'Production HTTP redirect verification failed.' >&2
  false
fi

home_status=$(curl "${https_resolve[@]}" --silent --show-error --max-time 10 --dump-header "$probe_headers" \
  --output /dev/null --write-out '%{http_code}' "$PAWSHOP_HTTPS_ORIGIN/")
[[ $home_status == 200 ]] || { echo 'Production HTTPS root verification failed.' >&2; false; }
grep -Eiq '^X-Content-Type-Options:[[:space:]]*nosniff[[:space:]]*$' "$probe_headers" || {
  echo 'Production nosniff header verification failed.' >&2; false;
}
grep -Eiq '^X-Frame-Options:[[:space:]]*DENY[[:space:]]*$' "$probe_headers" || {
  echo 'Production frame header verification failed.' >&2; false;
}

catalog_status=$(curl "${https_resolve[@]}" --silent --show-error --max-time 10 --output "$probe_catalog" \
  --write-out '%{http_code}' "$PAWSHOP_HTTPS_ORIGIN/catalog.json")
[[ $catalog_status == 200 ]] || { echo 'Production catalog verification failed.' >&2; false; }
python3 - "$probe_catalog" "$release_dir" <<'PY'
import json, pathlib, re, sys
with open(sys.argv[1], encoding='utf-8') as source:
    products = json.load(source)
release_dir = pathlib.Path(sys.argv[2]).resolve()
image_path = re.compile(r'^assets/products/[a-z0-9-]+/[a-z0-9-]+\.jpg$')
if not isinstance(products, list) or not products:
    raise SystemExit('Public catalog must contain at least one product.')
for item in products:
    images = item.get('images')
    if (item.get('active') is not True or item.get('availability') != 'prelaunch'):
        raise SystemExit('Public catalog must contain active prelaunch products only.')
    if 'stock' in item or 'originalPrice' in item:
        raise SystemExit('Public catalog contains an unverified stock or reference-price claim.')
    if not isinstance(images, list) or not images or any(not isinstance(path, str) or not image_path.fullmatch(path) for path in images):
        raise SystemExit('Public catalog images must use the self-hosted product image directory.')
    for path in images:
        image = (release_dir / path).resolve()
        if release_dir not in image.parents or not image.is_file() or image.stat().st_size == 0:
            raise SystemExit('A public catalog image is missing from the immutable release.')
PY

for sensitive_path in admin.html dashboard.html account.html; do
  sensitive_status=$(curl "${https_resolve[@]}" --silent --show-error --max-time 10 --output /dev/null \
    --write-out '%{http_code}' "$PAWSHOP_HTTPS_ORIGIN/$sensitive_path")
  [[ $sensitive_status == 404 ]] || {
    echo "Sensitive production route is public: /$sensitive_path" >&2
    false
  }
done

trap - ERR INT TERM
cleanup
echo "Production release activated: $PAWSHOP_RELEASE_ID"
