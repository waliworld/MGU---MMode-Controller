#!/bin/sh
# Tests, builds and lays out this repository's MGU Store release in dist/release/ (catalog.json and its assets).
# Usage: MGU_STORE=<a clone of github.com/robertnisipeanu/mgu-store> [REPO=owner/name] tools/release.sh
# Needs node and python3. Upload every file of dist/release/ to the GitHub release tagged "catalog".
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
: "${MGU_STORE:?set MGU_STORE to a clone of github.com/robertnisipeanu/mgu-store (its deploy/hu packs the tool kit)}"
REPO=${REPO:-waliworld/MGU---MMode-Controller}
cd "$root"
# the package goes out without BMW's oap-sdk; a placeholder stands in for the build (kit/tools/build.py copies it)
if [ ! -f oap-sdk/index.js ]; then
    mkdir -p oap-sdk
    echo "module.exports = {}; // placeholder: tools/catalog.js takes node_modules/oap-sdk out of the package" > oap-sdk/index.js
    echo '{"name":"oap-sdk","version":"0.0.0-placeholder"}' > oap-sdk/package.json
fi
node native/tbw-mdrive-d/mdrived.js --test
node native/tbw-mdrive-d/test/test_service.js
node tests/app/test_model.js
python3 kit/tools/build.py --hmi ID8 tbw_mdrive
node tests/app/preview.js
node tests/app/test_start.js
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}
export SOURCE_DATE_EPOCH
v=$(node -p "require('./native/tbw-mdrive-d/component.json').version")
a=$(node -p "require('./apps/tbw_mdrive/app.json').version")
node "$MGU_STORE/deploy/hu" artifact native/tbw-mdrive-d --out dist
node tools/catalog.js "$REPO" "dist/tbw_mdrive@$a.tgz" "dist/tbw-mdrive-d@$v.tgz"
echo "release.sh: upload every file of dist/release/ to the GitHub release tagged \"catalog\" of $REPO"
