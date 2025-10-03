Android Signed Release APK
====================================================

This guide covers creating a signing keystore, configuring Gradle, enabling the shrinker with safe rules for Capacitor/MQTT, building a release APK, and installing it.

Prerequisites
- JDK installed (for `keytool`) and Android SDK/Platform Tools (`adb`).
- Project native module: `apps/android/android`.

1) Create a release keystore
- From `apps/android/android`, create a folder for keys:
  - Windows (PowerShell): `New-Item -ItemType Directory -Force keystore`
  - macOS/Linux: `mkdir -p keystore`
- Generate a PKCS12 keystore (valid ~100 years):
  - Windows (PowerShell):
    `& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v -storetype PKCS12 -keystore keystore\release.keystore -alias projectplant -keyalg RSA -keysize 2048 -validity 36500`
  - macOS/Linux:
    `keytool -genkeypair -v -storetype PKCS12 -keystore keystore/release.keystore -alias projectplant -keyalg RSA -keysize 2048 -validity 36500`

Note the passwords and the alias you set; you'll reference them below.

2) Configure Gradle signing properties
- Edit `apps/android/android/gradle.properties` and set:
  - `RELEASE_STORE_FILE=keystore/release.keystore`
  - `RELEASE_STORE_PASSWORD=your-store-password`
  - `RELEASE_KEY_ALIAS=projectplant` (or your alias)
  - `RELEASE_KEY_PASSWORD=your-key-password`
- Keystore files are ignored by `.gitignore` (`*.jks`, `*.keystore`, `keystore/`). Do not commit secrets.

3) Shrinker/ProGuard rules
- Release build enables R8 shrinking and resource shrinking.
- App rules live in `apps/android/android/app/proguard-rules.pro` and include safe keep rules for Capacitor, Cordova plugin shims, and common MQTT libraries (Eclipse Paho / HiveMQ). Adjust if you add/remove native libraries.

4) Build the signed release APK
- From `apps/android/android`:
  - Windows: `gradlew.bat assembleRelease`
  - macOS/Linux: `./gradlew assembleRelease`
- Output APK path:
  - `apps/android/android/app/build/outputs/apk/release/app-release.apk`

5) Install on a device
- Enable USB debugging and connect a device or start an emulator, then:
  - `adb install -r apps/android/android/app/build/outputs/apk/release/app-release.apk`
  - If you see signature conflicts, uninstall the debug app first: `adb uninstall com.projectplant.app` then install again.

Notes
- For Play Store, consider generating an App Bundle: `bundleRelease` instead of `assembleRelease`.
- If you add native MQTT libraries, keep rules are already permissive. Tighten rules later for maximum shrink if needed.

