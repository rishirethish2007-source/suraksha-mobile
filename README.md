# Suraksha SOS mobile

Modular Expo / React Native integration with the common FastAPI backend. The UI calls `SOSTriggerService`; `src/interfaces/sos.types.ts` defines the strict TypeScript payload and `sos-api.service.ts` maps it to the backend snake_case contract.

The workflow requests high-accuracy foreground GPS, signs the immutable origin, saves to a durable local queue, and tries the API when reachable. It falls back to BLE when disconnected or the backend is unavailable. A recent cached location can be used after GPS timeout, with provider and accuracy reported explicitly; high accuracy is requested, never guaranteed by hardware.

`mesh-runtime.service.ts` owns verified receive, local notification, distance, relay hop/TTL limits, durable forwarding and retries independently of screen mounting. `origin-security.ts` implements P-256 verification; tokens and private keys stay in SecureStore and never enter mesh packets. The home screen provides nearby coordinates, map navigation and an authenticated “I can help” action (requires connectivity).

The local Expo module in `modules/ble-peripheral` supplies central and peripheral roles on Android/iOS. The advertising packet contains a service UUID; peers connect and fetch framed GATT data, then perform application-level store-and-forward. This is not the Bluetooth SIG Mesh profile. react-native-ble-plx alone cannot advertise as a peripheral. Frames are at most 20 bytes, with version/sequence/count headers and an overall 16 KiB limit; interrupted transfers are discarded. Native durable inboxes, queue bounds, expiry and rotating advertisements support multiple concurrent alerts.

## Background behavior and permissions

- Android: explicit relay opt-in requests Bluetooth Scan/Connect/Advertise and foreground precise location permissions. A connectedDevice foreground service shows a persistent notification, owns scanning and restores queued advertising; Headless JS processes received packets and retries. Notification permission is requested separately. OEM battery restrictions, Bluetooth off, reboot and user force-stop can interrupt delivery; reopen and enable relay after force-stop/reboot. The system may restart a killed service, but this is not guaranteed.
- iOS: CoreBluetooth central/peripheral background modes and restoration identifiers are configured. Discovery is coalesced/throttled, background advertising omits the local name and moves service UUIDs to Apple's overflow area. Android may not discover an iPhone advertising in the background. State restoration is best effort; user force-quit prevents automatic relaunch. iOS does not provide Android Headless JS; processing depends on the app receiving execution time. Do not promise continuous scanning or immediate background delivery.
- Background retry tasks are opportunistic (minimum interval request 15 minutes), not emergency latency timers. Foreground retries run every 30 seconds. BLE notifications only happen after complete packet transfer and origin verification.
- Enable relay before backgrounding. Expo Go, browsers and simulators cannot validate phone-to-phone BLE. Use physical devices with a native development/preview build. Production acceptance requires locked-screen, battery and radio tests on supported device models.

## Authentication

Configure the common platform's OIDC issuer/client and register `suraksha://auth-callback` as its redirect URI. Sign-in uses authorization code with PKCE; refresh tokens and device keys use secure platform storage. Configure backend JWT issuer/audience/public key and the CA key. Enroll every device online before offline use; renew the default 30-day certificate by signing in again while online. You can pin the CA public key with EXPO_PUBLIC_DEVICE_CA_PUBLIC_KEY; otherwise it is trusted from the configured HTTPS enrollment endpoint. Do not enable test login or insecure HTTP in released builds.

No delivery acknowledgement propagates across the offline mesh. Other phones may continue rebroadcasting until TTL after a successful upload or cancellation. Backend deduplication and cancellation tombstones prevent resurrection; offline neighbors can still display an unexpired stale alert. Relay routing metadata is untrusted telemetry. Nearby SOS names/locations are intentionally visible to other participating phones; do not put access tokens, medical records or other unnecessary private data in the message.

See [TESTING.md](TESTING.md) for setup and acceptance tests, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for boundaries, and [examples/active-relayed-sos.json](examples/active-relayed-sos.json) for the backend response fixture.
