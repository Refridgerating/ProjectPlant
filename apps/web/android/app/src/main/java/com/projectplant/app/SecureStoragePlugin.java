package com.projectplant.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SecureStorage")
public class SecureStoragePlugin extends Plugin {
    private static final String PREF_FILE = "projectplant_secure_prefs";
    private SharedPreferences prefs;

    private synchronized SharedPreferences getPrefs() throws Exception {
        if (prefs == null) {
            Context ctx = getContext();
            String masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC);
            prefs = EncryptedSharedPreferences.create(
                PREF_FILE,
                masterKeyAlias,
                ctx,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        }
        return prefs;
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void getItem(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("key is required");
            return;
        }
        try {
            SharedPreferences p = getPrefs();
            String value = p.getString(key, null);
            JSObject ret = new JSObject();
            if (value == null) {
                ret.put("value", (Object) null);
            } else {
                ret.put("value", value);
            }
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to read from secure storage", e);
        }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void setItem(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || key.isEmpty()) {
            call.reject("key is required");
            return;
        }
        if (value == null) {
            call.reject("value is required");
            return;
        }
        try {
            SharedPreferences p = getPrefs();
            p.edit().putString(key, value).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to write to secure storage", e);
        }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void removeItem(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("key is required");
            return;
        }
        try {
            SharedPreferences p = getPrefs();
            p.edit().remove(key).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to remove from secure storage", e);
        }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void clear(PluginCall call) {
        try {
            SharedPreferences p = getPrefs();
            p.edit().clear().apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to clear secure storage", e);
        }
    }
}

