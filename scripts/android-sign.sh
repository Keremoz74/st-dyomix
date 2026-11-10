#!/usr/bin/env bash
# Collects the Android builds into out/android/ and signs them.
# With ANDROID keystore secrets: release-signed APK + AAB (ready for Google Play / sideloading).
# Without them: the APK is signed with a throwaway debug key so it can still be installed for testing.
set -euo pipefail
OUT=out/android
mkdir -p "$OUT"
APK=$(find src-tauri/gen/android/app/build/outputs/apk -name '*universal*release*.apk' | head -1)
AAB=$(find src-tauri/gen/android/app/build/outputs/bundle -name '*.aab' | head -1)
BT=$(ls -d "$ANDROID_SDK_ROOT"/build-tools/* | sort -V | tail -1)

if [ -n "${KEYSTORE_B64:-}" ]; then
  echo "$KEYSTORE_B64" | base64 -d > "$RUNNER_TEMP/release.keystore"
  KS="$RUNNER_TEMP/release.keystore"; PASS="$KEYSTORE_PASSWORD"; ALIAS="$KEY_ALIAS"; KIND=release
else
  # the repo's fixed test key: every test APK has the same signature, so it installs as an update
  echo "No keystore secret: signing with the repo's test key (fine for your own devices, not for Google Play)."
  KS="scripts/test-signing.keystore"; PASS=ozmixtest; ALIAS=test; KIND=test
fi

"$BT/zipalign" -f -p 4 "$APK" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --ks-key-alias "$ALIAS" --out "$OUT/OzmixStudio-$KIND.apk" "$OUT/aligned.apk"
rm "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/OzmixStudio-$KIND.apk"

if [ -n "$AAB" ]; then
  cp "$AAB" "$OUT/OzmixStudio-$KIND.aab"
  jarsigner -keystore "$KS" -storepass "$PASS" -keypass "$PASS" "$OUT/OzmixStudio-$KIND.aab" "$ALIAS"
fi
ls -la "$OUT"
