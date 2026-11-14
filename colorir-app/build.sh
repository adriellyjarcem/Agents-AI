#!/usr/bin/env bash
# Gera dist/ColorirPDF.apk sem Gradle nem Android Studio.
# Dependências (Ubuntu/Debian):
#   sudo apt-get install aapt apksigner zipalign dalvik-exchange libandroid-23-java default-jdk zip
set -euo pipefail
cd "$(dirname "$0")"

ANDROID_JAR="${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}"
KEYSTORE="${KEYSTORE:-debug.keystore}"
KS_PASS="${KS_PASS:-android}"
OUT=build
APK=dist/ColorirPDF.apk

rm -rf "$OUT" && mkdir -p "$OUT/classes" "$OUT/assets" dist

# 1. recursos + manifesto + assets (a interface web vai em assets/web)
cp -r web "$OUT/assets/web"
aapt2 compile --dir res -o "$OUT/res.zip"
aapt2 link -o "$OUT/base.apk" -I "$ANDROID_JAR" --manifest AndroidManifest.xml \
  -A "$OUT/assets" --java "$OUT/gen" "$OUT/res.zip"

# 2. Java -> .class -> classes.dex
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$ANDROID_JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')
dalvik-exchange --dex --min-sdk-version=24 --output="$OUT/classes.dex" "$OUT/classes"
(cd "$OUT" && zip -q -j base.apk classes.dex)

# 3. alinhar e assinar
zipalign -f 4 "$OUT/base.apk" "$OUT/aligned.apk"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KS_PASS" -keypass "$KS_PASS" -alias colorir \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Colorir PDF" >/dev/null 2>&1
fi
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --min-sdk-version 24 --out "$APK" "$OUT/aligned.apk"
rm -f "$APK.idsig"
apksigner verify --min-sdk-version 24 "$APK"
ls -la "$APK"
