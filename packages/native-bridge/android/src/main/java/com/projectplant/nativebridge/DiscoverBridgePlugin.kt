package com.projectplant.nativebridge

import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONException

@CapacitorPlugin(name = "DiscoverBridge")
class DiscoverBridgePlugin : Plugin() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var previousCleanup: (() -> Unit)? = null

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun discover(call: PluginCall) {
        previousCleanup?.invoke()

        val nsdManager = context?.getSystemService(NsdManager::class.java)
        if (nsdManager == null) {
            call.reject("NSD service unavailable")
            previousCleanup = null
            return
        }

        val serviceTypes = extractServiceTypes(call)
        if (serviceTypes.isEmpty()) {
            call.reject("No service types available for discovery")
            previousCleanup = null
            return
        }

        val timeoutMs = call.getInt("timeoutMs") ?: DEFAULT_TIMEOUT_MS
        val resolved = AtomicBoolean(false)
        val listeners = mutableSetOf<NsdManager.DiscoveryListener>()
        var timeoutRunnable: Runnable? = null

        fun cleanup() {
            timeoutRunnable?.let {
                mainHandler.removeCallbacks(it)
                timeoutRunnable = null
            }
            listeners.forEach { listener ->
                try {
                    nsdManager.stopServiceDiscovery(listener)
                } catch (_: IllegalArgumentException) {
                    // listener already stopped
                }
            }
            listeners.clear()
            previousCleanup = null
        }

        previousCleanup = { cleanup() }

        mainHandler.post {
            serviceTypes.forEach { serviceType ->
                val listener = createDiscoveryListener(call, serviceType, nsdManager, listeners, resolved, ::serviceTypeMatches) {
                    cleanup()
                }
                try {
                    nsdManager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
                    listeners.add(listener)
                } catch (_: IllegalArgumentException) {
                    listeners.remove(listener)
                }
            }

            timeoutRunnable = Runnable {
                if (resolved.compareAndSet(false, true)) {
                    cleanup()
                    call.resolve()
                }
            }

            timeoutRunnable?.let {
                mainHandler.postDelayed(it, timeoutMs.toLong())
            }
        }
    }

    override fun handleOnDestroy() {
        previousCleanup?.invoke()
        previousCleanup = null
        super.handleOnDestroy()
    }

    private fun createDiscoveryListener(
        call: PluginCall,
        targetType: String,
        nsdManager: NsdManager,
        listeners: MutableSet<NsdManager.DiscoveryListener>,
        resolved: AtomicBoolean,
        matches: (String?, String) -> Boolean,
        cleanup: () -> Unit
    ): NsdManager.DiscoveryListener {
        return object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String?) {
                // no-op
            }

            override fun onDiscoveryStopped(serviceType: String?) {
                listeners.remove(this)
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (resolved.get()) {
                    return
                }
                if (!matches(serviceInfo.serviceType, targetType)) {
                    return
                }
                try {
                    nsdManager.resolveService(serviceInfo, object : NsdManager.ResolveListener {
                        override fun onServiceResolved(resolvedInfo: NsdServiceInfo) {
                            val hostAddress = resolvedInfo.host?.hostAddress ?: resolvedInfo.host?.hostName
                            if (hostAddress.isNullOrEmpty()) {
                                return
                            }
                            if (resolved.compareAndSet(false, true)) {
                                cleanup()
                                val data = JSObject()
                                data.put("host", hostAddress)
                                data.put("port", resolvedInfo.port)
                                val resolvedType = resolvedInfo.serviceType ?: targetType
                                data.put("serviceType", resolvedType)
                                call.resolve(data)
                            }
                        }

                        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                            // ignore and continue discovery
                        }
                    })
                } catch (_: IllegalArgumentException) {
                    // ignore and continue discovery
                }
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                // no-op
            }

            override fun onStartDiscoveryFailed(serviceType: String?, errorCode: Int) {
                try {
                    nsdManager.stopServiceDiscovery(this)
                } catch (_: IllegalArgumentException) {
                    // no-op
                }
                listeners.remove(this)
            }

            override fun onStopDiscoveryFailed(serviceType: String?, errorCode: Int) {
                try {
                    nsdManager.stopServiceDiscovery(this)
                } catch (_: IllegalArgumentException) {
                    // no-op
                }
                listeners.remove(this)
            }
        }
    }

    private fun extractServiceTypes(call: PluginCall): List<String> {
        val jsArray: JSArray? = try {
            call.getArray("serviceTypes")
        } catch (_: JSONException) {
            null
        }
        if (jsArray == null || jsArray.length() == 0) {
            return DEFAULT_SERVICE_TYPES
        }
        val result = mutableListOf<String>()
        for (index in 0 until jsArray.length()) {
            val value = jsArray.optString(index, "").trim()
            if (value.isNotEmpty()) {
                result.add(value)
            }
        }
        return if (result.isEmpty()) DEFAULT_SERVICE_TYPES else result
    }

    private fun serviceTypeMatches(actual: String?, expected: String): Boolean {
        if (actual == null) {
            return false
        }
        val normalizedActual = actual.trim().lowercase()
        val normalizedExpected = expected.trim().lowercase()
        return normalizedActual.contains(normalizedExpected)
    }

    companion object {
        private const val DEFAULT_TIMEOUT_MS = 10_000
        private val DEFAULT_SERVICE_TYPES = listOf("_projectplant._tcp", "_http._tcp")
    }
}
