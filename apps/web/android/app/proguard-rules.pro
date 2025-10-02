# Project specific R8/ProGuard rules.
# These are applied in addition to the consumer rules from included AARs.

# Keep annotations (Capacitor plugin annotations, @JavascriptInterface, etc.)
-keepattributes *Annotation*

# Keep WebView JavaScript interfaces (avoid stripping JS-annotated methods)
-keepclassmembers class ** {
    @android.webkit.JavascriptInterface <methods>;
}

# Capacitor core and plugins (belt-and-suspenders; AARs ship consumer rules)
-keep class com.getcapacitor.** { *; }
-keep class io.ionic.** { *; }
-keep class org.apache.cordova.** { *; }

# MQTT libraries (safe if present; no-ops otherwise)
-keep class org.eclipse.paho.client.mqttv3.** { *; }
-keep class org.eclipse.paho.android.service.** { *; }
-keep class com.hivemq.** { *; }

# Optional: preserve line numbers in crash reports
#-keepattributes SourceFile,LineNumberTable

# Optional: if you preserve line numbers, you can hide source filenames
#-renamesourcefileattribute SourceFile
