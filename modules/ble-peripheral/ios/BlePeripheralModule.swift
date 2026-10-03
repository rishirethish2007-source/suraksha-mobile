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
 * - Background scan timing is controlled by iOS; no delivery latency is guaranteed.
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
    private var wantsScanning = false
    private var cursors: [UUID: Int] = [:]
    private var snapshots: [UUID: Data] = [:]
    private var adverts: [String: Data] = [:]
    private var rotationIndex = 0
    private var rotationTimer: Timer?
    private var expiryTimer: DispatchWorkItem?
    private let defaults = UserDefaults.standard

    private func live(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let stamp = object["timestamp"] as? String, let ttl = object["ttlSeconds"] as? Double else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return (formatter.date(from: stamp)?.timeIntervalSinceNow ?? -Double.infinity) + ttl > 0
    }
    private func rotateAdverts() {
        adverts = adverts.filter { live($0.value) }
        defaults.set(adverts, forKey: "suraksha.adverts.v2")
        guard !adverts.isEmpty else {
            peripheralManager?.stopAdvertising(); peripheralManager?.removeAllServices()
            isAdvertising = false; currentPayloadData = nil
            rotationTimer?.invalidate(); rotationTimer = nil
            return
        }
        let keys = adverts.keys.sorted()
        currentPayloadData = adverts[keys[rotationIndex % keys.count]]
        rotationIndex += 1
    }
    private func managers() {
        guard peripheralManager == nil else { return }
        peripheralDelegate = PeripheralDelegate(module: self)
        centralDelegate = CentralDelegate(module: self)
        peripheralManager = CBPeripheralManager(delegate: peripheralDelegate, queue: .main,
            options: [CBPeripheralManagerOptionShowPowerAlertKey: true,
                      CBPeripheralManagerOptionRestoreIdentifierKey: "suraksha.peripheral.v2"])
        centralManager = CBCentralManager(delegate: centralDelegate, queue: .main,
            options: [CBCentralManagerOptionRestoreIdentifierKey: "suraksha.central.v2"])
    }
    private func receive(_ data: Data, deviceId: String) {
        let encoded = data.base64EncodedString()
        var inbox = defaults.stringArray(forKey: "suraksha.inbox") ?? []
        if !inbox.contains(encoded) {
            guard inbox.count < 100 else { return }
            inbox.append(encoded)
            defaults.set(inbox, forKey: "suraksha.inbox")
        }
        sendEvent("onSOSReceived", ["payloadBase64": encoded, "deviceId": deviceId])
    }

    private var advertisingPromise: Promise?
    private var advertisingTimeout: DispatchWorkItem?

    public func definition() -> ModuleDefinition {
        Name("BlePeripheral")

        Events(
            "onSOSReceived",
            "onCancelReceived",
            "onDeviceDiscovered",
            "onError"
        )

        OnCreate {
            // Recreate managers for state restoration only after the user opted in.
            DispatchQueue.main.async {
                if self.defaults.bool(forKey: "suraksha.relay.enabled") {
                    self.wantsScanning = true
                    self.managers()
                }
            }
        }
        AsyncFunction("initialize") { () -> Bool in
            self.managers()
            return true
        }.runOnQueue(.main)
        AsyncFunction("getInbox") { () -> [String] in
            self.defaults.stringArray(forKey: "suraksha.inbox") ?? []
        }.runOnQueue(.main)
        AsyncFunction("acknowledgeInbox") { (packet: String) in
            let inbox = self.defaults.stringArray(forKey: "suraksha.inbox") ?? []
            self.defaults.set(inbox.filter { $0 != packet }, forKey: "suraksha.inbox")
        }.runOnQueue(.main)

        AsyncFunction("startAdvertising") { (payloadBase64: String, promise: Promise) in
            guard let data = Data(base64Encoded: payloadBase64) else {
                promise.reject("BLE_ADV_ERROR", "Invalid base64 payload")
                return
            }

            guard !data.isEmpty && data.count <= 16384 else {
                promise.reject("BLE_ADV_ERROR", "Mesh packet exceeds 16384 bytes")
                return
            }
            guard self.advertisingPromise == nil else {
                promise.reject("BLE_ADV_ERROR", "Advertising is already starting")
                return
            }
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let stamp = object["timestamp"] as? String, let ttl = object["ttlSeconds"] as? Double else {
                promise.reject("BLE_PACKET_ERROR", "Invalid packet expiry")
                return
            }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let timestamp = formatter.date(from: stamp) else {
                promise.reject("BLE_PACKET_ERROR", "Invalid timestamp")
                return
            }
            self.expiryTimer?.cancel()
            let expiry = DispatchWorkItem { [weak self] in
                self?.peripheralManager?.stopAdvertising()
                self?.peripheralManager?.removeAllServices()
                self?.currentPayloadData = nil
                self?.isAdvertising = false
                self?.defaults.removeObject(forKey: "suraksha.advert")
            }
            self.expiryTimer = expiry
            guard timestamp.timeIntervalSinceNow + ttl > 0 else { promise.reject("BLE_EXPIRED", "SOS expired"); return }
            let id = object["sosId"] as? String ?? ""
            guard self.adverts.count < 100 || self.adverts[id] != nil else {
                promise.reject("BLE_QUEUE_FULL", "Relay advertising queue is full"); return
            }
            self.adverts[id] = data
            self.defaults.set(self.adverts, forKey: "suraksha.adverts.v2")
            if self.rotationTimer == nil {
                self.rotationTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.rotateAdverts() }
            }
            self.defaults.set(data, forKey: "suraksha.advert")
            self.currentPayloadData = data
            if self.isAdvertising && self.peripheralManager?.isAdvertising == true {
                promise.resolve(true)
                return
            }
            self.advertisingPromise = promise
            self.isAdvertising = true
            let timeout = DispatchWorkItem { [weak self] in
                self?.advertisingPromise?.reject("BLE_ADV_TIMEOUT", "Bluetooth advertising timed out")
                self?.advertisingPromise = nil
                self?.isAdvertising = false
                self?.peripheralManager?.stopAdvertising()
                self?.peripheralManager?.removeAllServices()
            }
            self.advertisingTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
            self.setupAndAdvertise()
        }.runOnQueue(.main)

        AsyncFunction("removeAdvertisement") { (id: String) in
            self.adverts.removeValue(forKey: id)
            self.rotateAdverts()
        }.runOnQueue(.main)
        AsyncFunction("stopAdvertising") { (promise: Promise) in
            self.adverts.removeAll()
            self.rotationTimer?.invalidate(); self.rotationTimer = nil
            self.defaults.removeObject(forKey: "suraksha.adverts.v2")
            self.expiryTimer?.cancel()
            self.defaults.removeObject(forKey: "suraksha.advert")
            self.advertisingTimeout?.cancel()
            self.advertisingPromise?.reject("BLE_ADV_CANCELLED", "Advertising stopped")
            self.advertisingPromise = nil
            self.peripheralManager?.stopAdvertising()
            self.peripheralManager?.removeAllServices()
            self.isAdvertising = false
            self.currentPayloadData = nil
            self.cancelPayloadData = nil
            promise.resolve(true)
        }.runOnQueue(.main)

        AsyncFunction("startScanning") { () -> Bool in
            self.wantsScanning = true
            self.defaults.set(true, forKey: "suraksha.relay.enabled")
            self.managers()
            if self.centralManager?.state == .poweredOn {
                self.centralManager?.scanForPeripherals(withServices: [BlePeripheralModule.SERVICE_UUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
            }
            return true
        }.runOnQueue(.main)
        AsyncFunction("stopScanning") { () -> Bool in
            self.wantsScanning = false
            self.defaults.set(false, forKey: "suraksha.relay.enabled")
            self.centralManager?.stopScan()
            return true
        }.runOnQueue(.main)

        AsyncFunction("broadcastCancellation") { (cancelPayload: String, promise: Promise) in
            guard let data = Data(base64Encoded: cancelPayload) else {
                promise.reject("BLE_CANCEL_ERROR", "Invalid base64 payload")
                return
            }
            self.cancelPayloadData = data
            promise.resolve(true)
        }.runOnQueue(.main)

        OnDestroy {
            self.centralManager?.stopScan()
            self.peripheralManager?.stopAdvertising()
            self.peripheralManager?.removeAllServices()
            self.advertisingTimeout?.cancel()
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

        func peripheralManager(_ peripheral: CBPeripheralManager, willRestoreState dict: [String: Any]) {
            guard let module = module, let data = module.defaults.data(forKey: "suraksha.advert"),
                let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let stamp = object["timestamp"] as? String, let ttl = object["ttlSeconds"] as? Double else { return }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let timestamp = formatter.date(from: stamp), timestamp.timeIntervalSinceNow + ttl > 0 else {
                peripheral.stopAdvertising(); peripheral.removeAllServices(); return
            }
            module.adverts = module.defaults.dictionary(forKey: "suraksha.adverts.v2") as? [String: Data] ?? [:]
            module.currentPayloadData = data
            module.isAdvertising = true
            module.rotationTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak module] _ in module?.rotateAdverts() }
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
                module?.advertisingTimeout?.cancel()
                module?.advertisingPromise?.reject("BLE_GATT_ERROR", error.localizedDescription)
                module?.advertisingPromise = nil
                module?.isAdvertising = false
                return
            }

            guard module?.isAdvertising == true else { return }
            // Start advertising with the service UUID
            peripheral.startAdvertising([
                CBAdvertisementDataServiceUUIDsKey: [BlePeripheralModule.SERVICE_UUID],
                CBAdvertisementDataLocalNameKey: "Suraksha"
            ])
            NSLog("[SurakshaBLE] Service added, advertising started")
        }

        func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
            module?.advertisingTimeout?.cancel()
            if let error = error {
                module?.isAdvertising = false
                module?.advertisingPromise?.reject("BLE_ADV_ERROR", error.localizedDescription)
            } else {
                module?.advertisingPromise?.resolve(true)
            }
            module?.advertisingPromise = nil
        }

        func peripheralManager(
            _ peripheral: CBPeripheralManager,
            didReceiveRead request: CBATTRequest
        ) {
            NSLog("[SurakshaBLE] Read request for \(request.characteristic.uuid)")

            guard request.characteristic.uuid == BlePeripheralModule.SOS_CHAR_UUID,
                  request.offset == 0, let module = module, let payload = module.currentPayloadData else {
                peripheral.respond(to: request, withResult: .attributeNotFound); return
            }
            guard module.live(payload) else { peripheral.respond(to: request, withResult: .attributeNotFound); return }
            let id = request.central.identifier
            let cursor = module.cursors[id] ?? 0
            guard module.snapshots.count < 8 || module.snapshots[id] != nil else { peripheral.respond(to: request, withResult: .insufficientResources); return }
            if cursor == 0 { module.snapshots[id] = payload }
            let data = module.snapshots[id] ?? payload
            let total = (data.count + 11) / 12
            guard cursor < total else {
                module.cursors[id] = 0; module.snapshots.removeValue(forKey: id)
                peripheral.respond(to: request, withResult: .attributeNotFound); return
            }
            let chunk = data.subdata(in: cursor * 12..<min(data.count, (cursor + 1) * 12))
            var frame = Data([83, 75, 2, UInt8(cursor >> 8), UInt8(cursor & 255), UInt8(total >> 8), UInt8(total & 255), UInt8(chunk.count)])
            frame.append(chunk)
            request.value = frame
            module.cursors[id] = cursor + 1
            peripheral.respond(to: request, withResult: .success)
            // CoreBluetooth has no disconnect callback for read-only centrals.
            if cursor == 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 65) { [weak module] in
                module?.cursors.removeValue(forKey: id); module?.snapshots.removeValue(forKey: id)
            } }

        }
    }

    // ══════════════════════════════════════════════════════════════
    //  Central Delegate — Scans for + reads from other Suraksha devices
    // ══════════════════════════════════════════════════════════════

    class CentralDelegate: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
        weak var module: BlePeripheralModule?
        private var connectedPeripherals: [CBPeripheral] = []
        private var buffers: [UUID: Data] = [:]
        private var sequences: [UUID: Int] = [:]
        private var counts: [UUID: Int] = [:]
        private var lastSeen: [UUID: Date] = [:]

        init(module: BlePeripheralModule) {
            self.module = module
        }

        func centralManagerDidUpdateState(_ central: CBCentralManager) {
            if central.state == .poweredOn && module?.wantsScanning == true {
                central.scanForPeripherals(withServices: [BlePeripheralModule.SERVICE_UUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
            }
        }

        func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
            if let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] {
                connectedPeripherals = peripherals
                for peripheral in peripherals {
                    peripheral.delegate = self
                    // Restart interrupted transfers; a partial packet is never delivered.
                    central.cancelPeripheralConnection(peripheral)
                }
            }
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

            // Bound resources and reconnect frequency; no duplicate delivery assumptions.
            guard connectedPeripherals.count < 4, Date().timeIntervalSince(lastSeen[peripheral.identifier] ?? .distantPast) > 65 else { return }
            if lastSeen.count > 1000 { lastSeen.removeAll() }
            lastSeen[peripheral.identifier] = Date()
            buffers[peripheral.identifier] = Data()
            sequences[peripheral.identifier] = 0
            counts.removeValue(forKey: peripheral.identifier)
            guard !connectedPeripherals.contains(where: { $0.identifier == peripheral.identifier }) else { return }
            peripheral.delegate = self
            connectedPeripherals.append(peripheral)
            central.connect(peripheral, options: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self, weak peripheral] in
                guard let peripheral = peripheral,
                    self?.connectedPeripherals.contains(where: { $0.identifier == peripheral.identifier }) == true else { return }
                central.cancelPeripheralConnection(peripheral)
                self?.connectedPeripherals.removeAll { $0.identifier == peripheral.identifier }
            }
        }

        func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
            connectedPeripherals.removeAll { $0.identifier == peripheral.identifier }
        }
        func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
            connectedPeripherals.removeAll { $0.identifier == peripheral.identifier }
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
            if let characteristic = chars.first(where: { $0.uuid == BlePeripheralModule.SOS_CHAR_UUID }) {
                peripheral.readValue(for: characteristic)
            } else { module?.centralManager?.cancelPeripheralConnection(peripheral) }
        }

        func peripheral(
            _ peripheral: CBPeripheral,
            didUpdateValueFor characteristic: CBCharacteristic,
            error: Error?
        ) {
            let id = peripheral.identifier
            func finish() {
                module?.centralManager?.cancelPeripheralConnection(peripheral)
                connectedPeripherals.removeAll { $0.identifier == id }
                buffers.removeValue(forKey: id); sequences.removeValue(forKey: id); counts.removeValue(forKey: id)
            }
            guard error == nil, let data = characteristic.value, data.count >= 8 else { finish(); return }
            let f = [UInt8](data)
            let seq = Int(f[3]) * 256 + Int(f[4])
            let total = Int(f[5]) * 256 + Int(f[6])
            let size = Int(f[7])
            guard f[0] == 83, f[1] == 75, f[2] == 2, seq == (sequences[id] ?? 0),
                  total > 0, total <= 1366, counts[id] == nil || counts[id] == total,
                  size > 0, size <= 12, data.count == 8 + size,
                  (buffers[id]?.count ?? 0) + size <= 16384 else { finish(); return }
            counts[id] = total
            buffers[id, default: Data()].append(data.subdata(in: 8..<data.count))
            sequences[id] = seq + 1
            if seq + 1 == total {
                if let packet = buffers[id] { module?.receive(packet, deviceId: id.uuidString) }
                finish()
            } else { peripheral.readValue(for: characteristic) }

        }
    }
}
