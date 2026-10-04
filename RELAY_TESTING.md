# Local test APK 1.0.3

Install the updated APK on both Android phones, keeping the existing app data.
The test build uses http://172.18.67.184:8000 and local test tokens. If the laptop
IP changes, build with the workflow's backend_url input. Keep the backend and
PostGIS database running. Enroll each phone online with its own phone token.

## Verify nearby delivery

1. Enable Bluetooth, Location, notifications and nearby relay on Phone B.
2. Keep both apps open, within a few metres, for the first test.
3. On Phone A, disable Wi-Fi and mobile data, leaving Bluetooth and Location on.
4. Hold SOS for three seconds and select a type. Start measuring after the app
   obtains location: GPS acquisition is separate from BLE delivery.
5. B should show a nearby alert. If B can reach the backend, verify a relayed SOS
   is stored there. If B is offline, it should advertise for another enrolled phone.
6. Repeat with A online. A now advertises nearby while submitting to the API too.
   The backend deduplicates by SOS ID; an online receipt does not cancel A's advert.
7. Repeat with B's screen locked. Record phone model, Android version, app state,
   elapsed time and whether the persistent relay notification remains visible.

## Dismiss and cancel

- **Dismiss message** hides A's status banner; **Cancel this SOS** remains available.
- **Dismiss this message** hides a nearby card and its notification. It stays hidden
  after refresh and app restart. This does not cancel somebody else's SOS or relay.
- **Cancel this SOS** removes A's local broadcast/queue and submits a cancellation.
  If the backend is unreachable, cancellation stays queued until connectivity returns.
- The persistent Android "nearby relay is active" notification represents the
  running service. Use **Stop nearby relay** to stop that service.
- Offline copies already received by other phones cannot immediately learn a
  server cancellation. They expire at their signed TTL or receive a server rejection.

## Changes and limits

Android foreground scanning uses low latency; background requests balanced scans
(subject to OS restrictions). Advertisements use low latency. Reconnection waits
3 seconds rather than 65 seconds. Failed scans retry after 6 seconds. GATT transfers
have a 15-second inactivity timeout rather than a fixed one-minute connection wait.
Updated Android peers negotiate MTU and use a separate fast characteristic carrying
up to 180 data bytes per read. The original characteristic retains 12-byte framing
for old Android/iOS peers. Both endpoints must be updated for the faster Android path.

Nearby inbox verification/notification no longer waits for uploads. API requests
make one bounded attempt; durable queues handle later retries. Network checks
probe the configured backend, including on Wi-Fi without public internet.

BLE discovery and background execution cannot guarantee a delivery deadline.
TypeScript/regression tests and Android builds do not replace physical two/three
phone testing. iOS uses the compatible legacy transfer path; its shorter retry
cooldown still needs an iOS device/build check.
