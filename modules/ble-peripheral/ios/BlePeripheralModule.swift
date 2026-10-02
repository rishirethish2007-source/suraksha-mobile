import ExpoModulesCore
import CoreBluetooth

/**
 * Native iOS BLE Peripheral Module for Suraksha SOS Mesh Network.
 *
 * Handles:
 * 1. CBPeripheralManager — Advertises the Suraksha Service UUID and hosts GATT characteristics.
 * 2. CBCentralManager — Scans for nearby Suraksha devices and reads their SOS payloads.
 *
 * iOS Limitations:
 * - Background advertising is limited to Service UUIDs only (no manufacturer data).
 * - Scan intervals are throttled in background mode (~1-10 minutes).
 * - Requires "Uses Bluetooth LE accessories" and "Acts as BLE accessory" in Background Modes.
 */
public class BlePeripheralModule: Module {

    // Must match frontend constants in ble.constants.ts
    static let SERVICE_UUID = CBUUID(string: "8fc9a2e0-1b2a-4c3d-9e5f-0a1b2c3d4e5f")
    static let SOS_CHAR_UUID = CBUUID(string: "8fc9a2e1-1b2a-4c3d-9e5f-0a1b2c3d4e5f")
    static let CANCEL_CHAR_UUID = CBUUID(string: "8fc9a2e2-1b2a-4c3d-9e5f-0a1b2c3d4e5f")

    private var peripheralManager: CBPeripheralManager?
    private var centralManager: CBCentralManager?
    private var peripheralDelegate: PeripheralDelegate?
    private var centralDelegate: CentralDelegate?

    private var currentPayloadData: Data?
    private var cancelPayloadData: Data?
    private var isAdvertising = false

    public func definition() -> ModuleDefinition {
        Name("BlePeripheral")

        Events(
            "onSOSReceived",
            "onCancelReceived",
            "onDeviceDiscovered",
            "onError"
        )

        AsyncFunction("initialize") { (promise: Promise) in
            self.peripheralDelegate = PeripheralDelegate(module: self)
            self.centralDelegate = CentralDelegate(module: self)

            self.peripheralManager = CBPeripheralManager(
                delegate: self.peripheralDelegate,
                queue: DispatchQueue.global(qos: .userInitiated),
                options: [CBPeripheralManagerOptionShowPowerAlertKey: true]
            )

            self.centralManager = CBCentralManager(
                delegate: self.centralDelegate,
                queue: DispatchQueue.global(qos: .userInitiated)
            )

            promise.resolve(true)
        }

        AsyncFunction("startAdvertising") { (payloadBase64: String, promise: Promise) in
            guard let data = Data(base64Encoded: payloadBase64) else {
                promise.reject("BLE_ADV_ERROR", "Invalid base64 payload")
                return
            }

            self.currentPayloadData = data
            self.setupAndAdvertise()
            self.isAdvertising = true
            promise.resolve(true)
        }

        AsyncFunction("stopAdvertising") { (promise: Promise) in
            self.peripheralManager?.stopAdvertising()
            self.peripheralManager?.removeAllServices()
            self.isAdvertising = false
            self.currentPayloadData = nil
            self.cancelPayloadData = nil
            promise.resolve(true)
        }

        AsyncFunction("startScanning") { (promise: Promise) in
            guard let central = self.centralManager, central.state == .poweredOn else {
                promise.reject("BLE_SCAN_ERROR", "Bluetooth not ready")
                return
            }

            central.scanForPeripherals(
                withServices: [BlePeripheralModule.SERVICE_UUID],
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
            )
            promise.resolve(true)
        }

        AsyncFunction("stopScanning") { (promise: Promise) in
            self.centralManager?.stopScan()
            promise.resolve(true)
        }

        AsyncFunction("broadcastCancellation") { (cancelPayload: String, promise: Promise) in
            guard let data = Data(base64Encoded: cancelPayload) else {
                promise.reject("BLE_CANCEL_ERROR", "Invalid base64 payload")
                return
            }
            self.cancelPayloadData = data
            promise.resolve(true)
        }

        Function("isSupported") { () -> Bool in
            return true  // All modern iPhones support BLE peripheral mode
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  Setup GATT Service and Start Advertising
    // ══════════════════════════════════════════════════════════════

    private func setupAndAdvertise() {
        guard let pm = peripheralManager, pm.state == .poweredOn else { return }

        // Remove existing services
        pm.removeAllServices()

        // Create SOS characteristic
        let sosChar = CBMutableCharacteristic(
            type: BlePeripheralModule.SOS_CHAR_UUID,
            properties: .read,
            value: nil,  // Dynamic value — served via delegate callback
            permissions: .readable
        )

        // Create Cancel characteristic
        let cancelChar = CBMutableCharacteristic(
            type: BlePeripheralModule.CANCEL_CHAR_UUID,
            properties: .read,
            value: nil,
            permissions: .readable
        )

        let service = CBMutableService(type: BlePeripheralModule.SERVICE_UUID, primary: true)
        service.characteristics = [sosChar, cancelChar]

        pm.add(service)
    }

    // ══════════════════════════════════════════════════════════════
    //  Peripheral Delegate — Handles advertising + read requests
    // ══════════════════════════════════════════════════════════════

    class PeripheralDelegate: NSObject, CBPeripheralManagerDelegate {
        weak var module: BlePeripheralModule?

        init(module: BlePeripheralModule) {
            self.module = module
        }

        func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
            if peripheral.state == .poweredOn {
                NSLog("[SurakshaBLE] Peripheral manager powered on")
                if module?.isAdvertising == true {
                    module?.setupAndAdvertise()
                }
            }
        }

        func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
            if let error = error {
                NSLog("[SurakshaBLE] Failed to add service: \(error.localizedDescription)")
                return
            }

            // Start advertising with the service UUID
            peripheral.startAdvertising([
                CBAdvertisementDataServiceUUIDsKey: [BlePeripheralModule.SERVICE_UUID],
                CBAdvertisementDataLocalNameKey: "Suraksha"
            ])
            NSLog("[SurakshaBLE] Service added, advertising started")
        }

        func peripheralManager(
            _ peripheral: CBPeripheralManager,
            didReceiveRead request: CBATTRequest
        ) {
            NSLog("[SurakshaBLE] Read request for \(request.characteristic.uuid)")

            var data: Data?
            if request.characteristic.uuid == BlePeripheralModule.SOS_CHAR_UUID {
                data = module?.currentPayloadData
            } else if request.characteristic.uuid == BlePeripheralModule.CANCEL_CHAR_UUID {
                data = module?.cancelPayloadData
            }

            if let data = data {
                if request.offset > data.count {
                    peripheral.respond(to: request, withResult: .invalidOffset)
                    return
                }
                request.value = data.subdata(in: request.offset..<data.count)
                peripheral.respond(to: request, withResult: .success)
            } else {
                peripheral.respond(to: request, withResult: .attributeNotFound)
            }
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  Central Delegate — Scans for + reads from other Suraksha devices
    // ══════════════════════════════════════════════════════════════

    class CentralDelegate: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
        weak var module: BlePeripheralModule?
        private var connectedPeripherals: [CBPeripheral] = []

        init(module: BlePeripheralModule) {
            self.module = module
        }

        func centralManagerDidUpdateState(_ central: CBCentralManager) {
            NSLog("[SurakshaBLE] Central manager state: \(central.state.rawValue)")
        }

        func centralManager(
            _ central: CBCentralManager,
            didDiscover peripheral: CBPeripheral,
            advertisementData: [String: Any],
            rssi RSSI: NSNumber
        ) {
            NSLog("[SurakshaBLE] Discovered: \(peripheral.identifier), RSSI: \(RSSI)")

            module?.sendEvent("onDeviceDiscovered", [
                "deviceId": peripheral.identifier.uuidString,
                "rssi": RSSI.intValue,
                "name": peripheral.name ?? "Unknown"
            ])

            // Connect to read payload
            peripheral.delegate = self
            connectedPeripherals.append(peripheral)
            central.connect(peripheral, options: nil)
        }

        func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
            NSLog("[SurakshaBLE] Connected to \(peripheral.identifier)")
            peripheral.discoverServices([BlePeripheralModule.SERVICE_UUID])
        }

        func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
            guard let services = peripheral.services else { return }
            for service in services where service.uuid == BlePeripheralModule.SERVICE_UUID {
                peripheral.discoverCharacteristics(
                    [BlePeripheralModule.SOS_CHAR_UUID, BlePeripheralModule.CANCEL_CHAR_UUID],
                    for: service
                )
            }
        }

        func peripheral(
            _ peripheral: CBPeripheral,
            didDiscoverCharacteristicsFor service: CBService,
            error: Error?
        ) {
            guard let chars = service.characteristics else { return }
            for char in chars {
                peripheral.readValue(for: char)
            }
        }

        func peripheral(
            _ peripheral: CBPeripheral,
            didUpdateValueFor characteristic: CBCharacteristic,
            error: Error?
        ) {
            guard let data = characteristic.value else { return }
            let base64 = data.base64EncodedString()

            NSLog("[SurakshaBLE] Read \(data.count) bytes from \(peripheral.identifier)")

            if characteristic.uuid == BlePeripheralModule.SOS_CHAR_UUID {
                module?.sendEvent("onSOSReceived", [
                    "payloadBase64": base64,
                    "deviceId": peripheral.identifier.uuidString
                ])
            } else if characteristic.uuid == BlePeripheralModule.CANCEL_CHAR_UUID {
                module?.sendEvent("onCancelReceived", [
                    "payloadBase64": base64,
                    "deviceId": peripheral.identifier.uuidString
                ])
            }

            // Disconnect after reading
            module?.centralManager?.cancelPeripheralConnection(peripheral)
            connectedPeripherals.removeAll { $0.identifier == peripheral.identifier }
        }
    }
}
