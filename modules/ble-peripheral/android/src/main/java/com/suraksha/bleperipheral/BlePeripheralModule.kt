package com.suraksha.bleperipheral

import android.Manifest
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.concurrent.ConcurrentHashMap
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import androidx.core.app.ActivityCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.util.UUID

/**
 * Native Android BLE Peripheral Module for Suraksha SOS Mesh Network.
 *
 * This module handles:
 * 1. BLE Advertising — Broadcasts the Suraksha Service UUID so nearby phones can discover this device.
 * 2. GATT Server — Hosts characteristics containing the full SOS payload (up to 512 bytes).
 *    When a scanning device connects and reads the characteristic, it gets the complete SOS data.
 * 3. BLE Scanning — Discovers nearby Suraksha devices and reads their SOS payloads.
 */
class BlePeripheralModule : Module() {

    companion object {
        private const val TAG = "SurakshaBLE"

        // Must match frontend constants in ble.constants.ts
        val SERVICE_UUID: UUID = UUID.fromString("8fc9a2e0-1b2a-4c3d-9e5f-0a1b2c3d4e5f")
        val SOS_CHAR_UUID: UUID = UUID.fromString("8fc9a2e1-1b2a-4c3d-9e5f-0a1b2c3d4e5f")
        val CANCEL_CHAR_UUID: UUID = UUID.fromString("8fc9a2e2-1b2a-4c3d-9e5f-0a1b2c3d4e5f")
    }

    private var bluetoothAdapter: BluetoothAdapter? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var gattServer: BluetoothGattServer? = null
    private var isAdvertising = false
    private var currentPayloadBase64: String? = null
    private var cancelPayloadBase64: String? = null
    private var scanner: BluetoothLeScanner? = null
    private var isScanning = false
    private var advertisingPromise: Promise? = null
    private val handler = Handler(Looper.getMainLooper())
    private val connectedDevices = ConcurrentHashMap<String, BluetoothGatt>()
    private val readMtu = ConcurrentHashMap<String, Int>()
    private val advertisingTimeout = Runnable {
        advertisingPromise?.reject("BLE_ADV_TIMEOUT", "Bluetooth advertising timed out", null)
        advertisingPromise = null
        stopBleAdvertising()
        stopGattServer()
        isAdvertising = false
    }

    override fun definition() = ModuleDefinition {
        Name("BlePeripheral")

        // ──────────────────────────────────────────────────────────
        //  Events emitted to JavaScript
        // ──────────────────────────────────────────────────────────
        Events(
            "onSOSReceived",      // Payload read from a nearby device via GATT
            "onCancelReceived",   // Cancellation payload received
            "onDeviceDiscovered", // A Suraksha device was found during scan
            "onError"             // Error occurred
        )

        // ──────────────────────────────────────────────────────────
        //  initialize()
        //  Sets up BluetoothAdapter and checks BLE Peripheral support.
        // ──────────────────────────────────────────────────────────
        AsyncFunction("initialize") { promise: Promise ->
            try {
                val context = appContext.reactContext ?: throw Exception("No context")
                val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
                    ?: throw Exception("BluetoothManager not available")

                bluetoothAdapter = manager.adapter
                if (bluetoothAdapter == null || !bluetoothAdapter!!.isEnabled) {
                    throw Exception("Bluetooth is not enabled")
                }

                if (!bluetoothAdapter!!.isMultipleAdvertisementSupported) {
                    Log.w(TAG, "Device does not support BLE advertising (peripheral mode)")
                    throw Exception("BLE Peripheral mode not supported on this device")
                }

                advertiser = bluetoothAdapter!!.bluetoothLeAdvertiser
                scanner = bluetoothAdapter!!.bluetoothLeScanner

                Log.i(TAG, "BLE Peripheral Module initialized successfully")
                promise.resolve(true)
            } catch (e: Exception) {
                Log.e(TAG, "Init failed: ${e.message}")
                promise.reject("BLE_INIT_ERROR", e.message, e)
            }
        }

        // ──────────────────────────────────────────────────────────
        //  startAdvertising(payloadBase64: String)
        //  Starts BLE advertising + GATT server hosting the SOS payload.
        // ──────────────────────────────────────────────────────────
        AsyncFunction("startAdvertising") { payloadBase64: String, promise: Promise ->
            try {
                if (Base64.decode(payloadBase64, Base64.DEFAULT).size > 512) {
                    throw Exception("GATT payload exceeds 512 bytes")
                }
                if (advertisingPromise != null) throw Exception("Advertising is already starting")
                if (isAdvertising) {
                    currentPayloadBase64 = payloadBase64
                    promise.resolve(true)
                    return@AsyncFunction
                }

                if (advertiser == null) throw Exception("Bluetooth is not initialized")
                currentPayloadBase64 = payloadBase64
                advertisingPromise = promise
                handler.postDelayed(advertisingTimeout, 10000)
                startGattServer() // Advertising begins only after onServiceAdded.

            } catch (e: Exception) {
                Log.e(TAG, "Advertising failed: ${e.message}")
                handler.removeCallbacks(advertisingTimeout)
                advertisingPromise = null
                stopGattServer()
                promise.reject("BLE_ADV_ERROR", e.message, e)
            }
        }

        // ──────────────────────────────────────────────────────────
        //  stopAdvertising()
        // ──────────────────────────────────────────────────────────
        AsyncFunction("stopAdvertising") { promise: Promise ->
            try {
                handler.removeCallbacks(advertisingTimeout)
                advertisingPromise?.reject("BLE_ADV_CANCELLED", "Advertising stopped", null)
                advertisingPromise = null
                stopBleAdvertising()
                stopGattServer()
                isAdvertising = false
                currentPayloadBase64 = null
                cancelPayloadBase64 = null

                Log.i(TAG, "Advertising stopped")
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("BLE_STOP_ERROR", e.message, e)
            }
        }

        // ──────────────────────────────────────────────────────────
        //  startScanning()
        //  Scans for nearby Suraksha SOS devices and reads their payload.
        // ──────────────────────────────────────────────────────────
        AsyncFunction("startScanning") { promise: Promise ->
            try {
                if (isScanning || scanner == null) {
                    promise.resolve(false)
                    return@AsyncFunction
                }

                val filters = listOf(
                    ScanFilter.Builder()
                        .setServiceUuid(ParcelUuid(SERVICE_UUID))
                        .build()
                )
                val settings = ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build()

                scanner!!.startScan(filters, settings, scanCallback)
                isScanning = true
                Log.i(TAG, "BLE scanning started")
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("BLE_SCAN_ERROR", e.message, e)
            }
        }

        // ──────────────────────────────────────────────────────────
        //  stopScanning()
        // ──────────────────────────────────────────────────────────
        AsyncFunction("stopScanning") { promise: Promise ->
            try {
                if (isScanning && scanner != null) {
                    scanner!!.stopScan(scanCallback)
                    isScanning = false
                    Log.i(TAG, "BLE scanning stopped")
                }
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("BLE_SCAN_STOP_ERROR", e.message, e)
            }
        }

        // ──────────────────────────────────────────────────────────
        //  broadcastCancellation(cancelPayloadBase64: String)
        // ──────────────────────────────────────────────────────────
        AsyncFunction("broadcastCancellation") { cancelPayload: String, promise: Promise ->
            try {
                cancelPayloadBase64 = cancelPayload
                // Update GATT characteristic if server is running
                updateGattCharacteristic(CANCEL_CHAR_UUID, cancelPayload)
                Log.i(TAG, "Cancellation broadcast updated")
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("BLE_CANCEL_ERROR", e.message, e)
            }
        }

        // ──────────────────────────────────────────────────────────
        //  isSupported() -> Boolean
        // ──────────────────────────────────────────────────────────
        OnDestroy {
            handler.removeCallbacksAndMessages(null)
            if (isScanning) scanner?.stopScan(scanCallback)
            stopBleAdvertising()
            stopGattServer()
            connectedDevices.values.forEach { it.disconnect(); it.close() }
            connectedDevices.clear()
            readMtu.clear()
        }

        Function("isSupported") {
            val adapter = BluetoothAdapter.getDefaultAdapter()
            adapter != null && adapter.isMultipleAdvertisementSupported
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  GATT Server — Hosts SOS payload for connecting Central devices
    // ══════════════════════════════════════════════════════════════

    private fun startGattServer() {
        val context = appContext.reactContext ?: throw Exception("No context")
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager ?: throw Exception("No Bluetooth manager")
        gattServer = manager.openGattServer(context, gattServerCallback) ?: throw Exception("Cannot open GATT server")

        val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

        // SOS Characteristic — readable by Central devices
        val sosChar = BluetoothGattCharacteristic(
            SOS_CHAR_UUID,
            BluetoothGattCharacteristic.PROPERTY_READ,
            BluetoothGattCharacteristic.PERMISSION_READ
        )
        service.addCharacteristic(sosChar)

        // Cancel Characteristic
        val cancelChar = BluetoothGattCharacteristic(
            CANCEL_CHAR_UUID,
            BluetoothGattCharacteristic.PROPERTY_READ,
            BluetoothGattCharacteristic.PERMISSION_READ
        )
        service.addCharacteristic(cancelChar)

        if (gattServer?.addService(service) != true) throw Exception("Cannot add GATT service")
        Log.i(TAG, "GATT Server started with SOS + Cancel characteristics")
    }

    private fun stopGattServer() {
        gattServer?.close()
        gattServer = null
    }

    private fun updateGattCharacteristic(charUuid: UUID, base64Data: String) {
        gattServer?.services?.forEach { service ->
            service.getCharacteristic(charUuid)?.let { char ->
                char.value = Base64.decode(base64Data, Base64.DEFAULT)
            }
        }
    }

    private val gattServerCallback = object : BluetoothGattServerCallback() {
        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            if (advertisingPromise == null) return
            if (status == BluetoothGatt.GATT_SUCCESS) {
                try { startBleAdvertising() } catch (error: Exception) {
                    advertisingPromise?.reject("BLE_ADV_ERROR", error.message, error)
                    advertisingPromise = null
                }
            } else {
                advertisingPromise?.reject("BLE_GATT_ERROR", "Cannot publish GATT service", null)
                advertisingPromise = null
            }
        }
        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            readMtu[device.address] = mtu
        }
        override fun onConnectionStateChange(device: BluetoothDevice?, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> Log.i(TAG, "GATT: Device connected: ${device?.address}")
                BluetoothProfile.STATE_DISCONNECTED -> Log.i(TAG, "GATT: Device disconnected: ${device?.address}")
            }
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice?,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic?
        ) {
            Log.i(TAG, "GATT: Read request for ${characteristic?.uuid}")
            val data = when (characteristic?.uuid) {
                SOS_CHAR_UUID -> currentPayloadBase64?.let { Base64.decode(it, Base64.DEFAULT) }
                CANCEL_CHAR_UUID -> cancelPayloadBase64?.let { Base64.decode(it, Base64.DEFAULT) }
                else -> null
            }

            if (data != null && device != null) {
                if (offset > data.size || offset < 0) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
                    return
                }
                val end = minOf(data.size, offset + (readMtu[device.address] ?: 23) - 1)
                val chunk = data.copyOfRange(offset, end)
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, chunk)
            } else {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
            }
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  BLE Advertising — Broadcasts Suraksha Service UUID
    // ══════════════════════════════════════════════════════════════

    private fun startBleAdvertising() {
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(true)  // Must be connectable for GATT reads
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setTimeout(0)  // Advertise indefinitely
            .build()

        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)  // Save space in adv packet
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .build()

        advertiser?.startAdvertising(settings, data, advertiseCallback)
    }

    private fun stopBleAdvertising() {
        advertiser?.stopAdvertising(advertiseCallback)
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            handler.removeCallbacks(advertisingTimeout)
            isAdvertising = true
            advertisingPromise?.resolve(true)
            advertisingPromise = null
            Log.i(TAG, "BLE advertising started successfully")
        }

        override fun onStartFailure(errorCode: Int) {
            handler.removeCallbacks(advertisingTimeout)
            isAdvertising = false
            advertisingPromise?.reject("BLE_ADV_ERROR", "Advertising failed: $errorCode", null)
            advertisingPromise = null
            stopGattServer()
            Log.e(TAG, "BLE advertising failed with error code: $errorCode")
            sendEvent("onError", mapOf("error" to "Advertising failed: code $errorCode"))
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  BLE Scanning — Discovers other Suraksha devices
    // ══════════════════════════════════════════════════════════════

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult?) {
            result?.device?.let { device ->
                Log.i(TAG, "Discovered Suraksha device: ${device.address}, RSSI: ${result.rssi}")
                sendEvent("onDeviceDiscovered", mapOf(
                    "deviceId" to device.address,
                    "rssi" to result.rssi,
                    "name" to (device.name ?: "Unknown")
                ))

                // Auto-connect to read GATT payload
                connectAndReadPayload(device)
            }
        }

        override fun onScanFailed(errorCode: Int) {
            isScanning = false
            Log.e(TAG, "BLE scan failed: $errorCode")
            sendEvent("onError", mapOf("error" to "Scan failed: code $errorCode"))
        }
    }

    /**
     * Connects to a discovered Suraksha device, reads the SOS characteristic,
     * and emits the payload to JavaScript. Disconnects immediately after reading.
     */
    private fun connectAndReadPayload(device: BluetoothDevice) {
        val context = appContext.reactContext ?: return

        if (connectedDevices.containsKey(device.address)) return
        val connection = device.connectGatt(context, false, object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    connectedDevices.remove(device.address)
                    gatt.close()
                } else if (newState == BluetoothProfile.STATE_CONNECTED) {
                    Log.i(TAG, "Connected to ${device.address}, discovering services...")
                    gatt.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    connectedDevices.remove(device.address)
                    gatt.close()
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    val service = gatt.getService(SERVICE_UUID)
                    val sosChar = service?.getCharacteristic(SOS_CHAR_UUID)
                    if (sosChar != null) {
                        if (!gatt.readCharacteristic(sosChar)) gatt.disconnect()
                    } else {
                        Log.w(TAG, "SOS characteristic not found on ${device.address}")
                        gatt.disconnect()
                    }
                } else { gatt.disconnect() }
            }

            override fun onCharacteristicRead(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                status: Int
            ) {
                if (status == BluetoothGatt.GATT_SUCCESS && characteristic.value != null) {
                    val base64Data = Base64.encodeToString(characteristic.value, Base64.NO_WRAP)
                    Log.i(TAG, "Read payload from ${device.address}: ${base64Data.length} chars")

                    when (characteristic.uuid) {
                        SOS_CHAR_UUID -> sendEvent("onSOSReceived", mapOf(
                            "payloadBase64" to base64Data,
                            "deviceId" to device.address
                        ))
                        CANCEL_CHAR_UUID -> sendEvent("onCancelReceived", mapOf(
                            "payloadBase64" to base64Data,
                            "deviceId" to device.address
                        ))
                    }
                }
                // Disconnect immediately after read
                gatt.disconnect()
            }
        })
        if (connection != null) {
            connectedDevices[device.address] = connection
            handler.postDelayed({
                if (connectedDevices.remove(device.address, connection)) {
                    connection.disconnect()
                    connection.close()
                }
            }, 15000)
        }
    }
}
