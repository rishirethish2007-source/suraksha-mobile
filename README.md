# Suraksha mobile

Expo SDK 57 / React Native SOS client for the companion [backend](https://github.com/rishirethish2007-source/suraksha-backend).

## Setup

Use Node.js 22.13+ (Node 24 recommended).

```sh
npm ci
cp .env.example .env
# Set EXPO_PUBLIC_API_URL to the reachable backend origin, without /api/v1.
npm start
```

The home screen asks for your user ID, name, phone, and session token instead of sending hardcoded test identities and coordinates. The session token is held in memory; it is not persisted or broadcast over BLE. User sign-in must be connected to your identity provider before production use. `userId` must equal the JWT's `sub`. See the backend README for issuer, audience, and roles/scopes. Do not place credentials in `EXPO_PUBLIC_*` variables: those are bundled into the app.

Location permission is required. The app obtains real coordinates through Expo Location and can use a recent cached fix if current GPS times out. It never silently substitutes Mumbai or (0, 0).

## Delivery states

- **Received by server** means the API explicitly returned success.
- **Bluetooth advertising** means the native advertising callback succeeded; it does not confirm that another device or the backend received the alert.
- **Saved on this device** means a durable retry entry exists, with no confirmed delivery.

Pending alerts retry on reconnect and periodically while the screen is mounted. Expired alerts are not resent. Queued cancellations take priority over alerts and retry until confirmed. The app cannot promise retries while terminated; no background worker/foreground Android service has been implemented.

The **Enable nearby relay** control starts foreground scanning. An online relay gateway needs a token with the backend's `sos:relay` scope. BLE-origin identities remain unverified and nearby alerts are labelled accordingly. Never assume an unsigned received BLE packet is authenticated.

## Native BLE builds

Expo Go and web do not contain the local native module. They can use online delivery and durable queues, but cannot advertise or scan. Build the app to enable Bluetooth:

```sh
npm run android
npm run ios
```

Use EAS builds if local Android/Xcode tooling is unavailable. The local module in `modules/ble-peripheral` includes Android Gradle/manifest and iOS podspec metadata for Expo autolinking. SDK defaults choose Kotlin/compile tooling; no outdated Kotlin override is applied.

The versioned BLE packet uses a compact JSON array and is limited to the standard 512-byte GATT value. It includes core identity, position, timestamp, TTL, hop count, and compact relay history; optional detailed location metadata/media references are not transported. Oversized alerts remain queued for online delivery instead of being silently truncated. Both platforms use the same service UUIDs. This packet format is incompatible with the old simulated JavaScript bridge.

Local cancellation stops advertising and is sent through the authenticated API. Unsigned BLE cancellation messages are deliberately not honored, since they could suppress someone else's SOS. A received relay may continue displaying until its TTL; the backend tombstone prevents cancelled alerts from being re-created after confirmed cancellation.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npx expo install --check
npx expo export --platform web
```

Tests exercise actual TypeScript services with mocked device/network/storage boundaries: API field mapping, server errors, nearby queries, BLE encoding/validation, concurrent queue writes, retries, cancellation persistence, and expiry. Web export and native autolinking checks do not replace an Android/iOS native build or physical two-phone BLE tests. Test denied permissions, disabled Bluetooth, disconnections, multi-hop delivery, cancellation, GPS failure, app termination, and reconnect behavior before relying on the app in an emergency.
