# Argus Control

Argus Control is a Vite + React + TypeScript progressive web app for managing ESP32 LoRa field devices through Supabase. The mobile app is designed to become Capacitor-ready later, but it runs locally as a standard PWA today.

## Stack

- Vite
- React
- TypeScript
- React Router
- Supabase JavaScript client
- vite-plugin-pwa

## Install

```bash
npm install
```

## Supabase Setup

1. Copy `.env.example` to `.env.local`.
2. Paste in your Supabase Project URL and anon public key.

The app reads:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Example:

```bash
cp .env.example .env.local
```

If you prefer, you can keep the included example values and replace them with your own project values later.

## Run Locally

```bash
npm run dev
```

Then open the local Vite URL shown in the terminal.

## Apply The Database Schema

1. Open your Supabase project.
2. Go to the SQL Editor.
3. Paste the contents of `supabase/schema.sql`.
4. Run the script.

The schema creates:

- `devices`
- `device_commands`
- `device_events`
- `alerts`
- `freezer_temperature_logs`
- `freezer_lynk_settings`
- `device_telemetry_state`

It also adds indexes, enables realtime publication for those tables, and inserts one test device named `North Fence`.

RLS remains disabled for local testing. Add authentication and RLS policies before using this in production.

## Test A Command

1. Launch the app with `npm run dev`.
2. Open the dashboard.
3. Select `North Fence`.
4. Press `TURN ON` or `TURN OFF` and confirm.
5. Verify a new row appears in `device_commands` with status `pending`.
6. Update the row from Supabase or from your future gateway process to `acknowledged`, `failed`, or `expired`.
7. Confirm the device detail page reacts to the realtime update.

## Login Notes

The app includes:

- Supabase email/password sign-in
- A local test mode so you can work with the UI while RLS is disabled

Local test mode is intended for development only.

## Capacitor Later

When you are ready to wrap this app for Android:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Argus Control" "com.argus.control"
npx cap add android
npm run build
npx cap sync android
```

The current structure is ready for that migration, but Android build files are not included yet.

## Notes

- `confirmed_state` is the real-world state shown in the UI.
- `desired_state` is only the requested state.
- The UI does not assume on/off after a button press.
- The ESP32 gateway firmware is not included in this repository yet.

## Freezer Lynk Telemetry Endpoint

Edge function path:

- `supabase/functions/freezer-telemetry/index.ts`

Expected POST payload:

- `device_key`
- `temperature_f` and/or `temperature_c`
- optional: `raw_sensor_value`, `signal_strength`, `battery_voltage`, `battery_percent`, `firmware_version`

Behavior:

- authenticates by `devices.device_key`
- logs reading to `freezer_temperature_logs`
- updates device `last_seen_at`, firmware, metadata, status
- evaluates warning/alarm thresholds from `freezer_lynk_settings`
- deduplicates alarm transitions using `device_telemetry_state`
- writes recovery events when temperature returns below warning threshold

## Freezer Lynk Pairing (MVP)

From Settings → Device Setup wizard:

1. Select `Freezer Lynk`
2. Choose manual pairing
3. Enter display name, location, and `device_key`
4. Save

The UI inserts a `devices` row with `type=device_type=freezer_lynk` and initializes default `freezer_lynk_settings`.
