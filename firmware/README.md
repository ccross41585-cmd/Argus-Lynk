# Argus Control Firmware MVP

This folder contains two Arduino sketches for the first hardware integration pass:

- `argus_gateway_mvp`: ESP32 home-base gateway that polls Supabase every 5 seconds and forwards pending commands over LoRa.
- `argus_field_node_mvp`: ESP32 field node that receives LoRa commands, switches a relay, and sends an ACK.

## Required Arduino Libraries

- `ArduinoJson` by Benoit Blanchon
- `RadioLib` by Jan Gromes
- `Adafruit GFX Library`
- `Adafruit SSD1306`

The gateway sketch also uses the built-in ESP32 libraries:

- `WiFi.h`
- `HTTPClient.h`
- `Wire.h`
- `time.h`

## Before Flashing

1. Copy `firmware/argus_gateway_mvp/gateway_secrets.example.h` to `firmware/argus_gateway_mvp/gateway_secrets.h`.
2. Fill in your real WiFi credentials, Supabase URL, and Supabase anon key in `gateway_secrets.h`.
3. The gateway sketch is currently pinned to the Heltec WiFi LoRa 32 V3 / SX1262 pinout used by the legacy field node.
4. Keep `NETWORK_KEY` and `NODE_ID` aligned between the gateway and field-node sketches.
5. Confirm the relay wiring and the `RELAY_ACTIVE_LEVEL` constant before connecting real equipment.

`gateway_secrets.h` is ignored by git so local credentials do not get pushed to GitHub.

## Packet Format

The gateway MVP currently talks to the legacy working field node packet format.

Command packet:

```text
CMD|farm123|fence1|<sequence>|ON
CMD|farm123|fence1|<sequence>|OFF
```

ACK packet:

```text
ACK|farm123|fence1|<sequence>|ON
ACK|farm123|fence1|<sequence>|OFF
```

`<sequence>` is the Supabase `device_commands.id` value.

## REST Behavior

The gateway uses Supabase REST over HTTP polling, not Realtime.

- Every 5 seconds it fetches `device_commands` where `status = pending`.
- It skips commands assigned to a different `gateway_id`.
- It sets `status = sent` before transmitting over LoRa.
- It maps `turn_on` to `ON` and `turn_off` to `OFF` for the legacy field node protocol.
- It updates `device_commands` and `devices` only after a valid `ACK|...|ON/OFF` packet is received.
- If no valid ACK arrives within 3 seconds, it retries the same packet once.
- If no valid ACK arrives after the retry, it marks the command as `failed`.

## OLED Status

The gateway sketch drives a 128x64 SSD1306 OLED using the same settings as the working field node.

- Line 1: `ARGUS BASE`
- Line 2: WiFi and Supabase status as `OK` or `NO`
- Line 3: LoRa radio status as `OK` or `NO`
- Line 4: Last confirmed fence state as `ON`, `OFF`, or `UNKNOWN`
- Line 5: Last requested command as `ON`, `OFF`, or `NONE`
- Line 6: Last ACK result as `OK`, `FAIL`, or `NONE`
- Line 7: Last RSSI and SNR when available, otherwise current poll count

The OLED is refreshed during boot, after poll cycles, after transmit attempts, after ACK success or failure, and after Supabase updates.

The field node sketch can also drive the same 128x64 SSD1306 OLED to show LoRa status, relay state, last command, ACK state, and the last packet marker while testing command delivery.

## Logging

- `DEBUG_VERBOSE` defaults to `false` in the gateway sketch.
- With `DEBUG_VERBOSE = false`, Serial output stays concise and focuses on poll counts, command sends, ACK results, failures, and device state updates.
- With `DEBUG_VERBOSE = true`, the gateway also prints detailed HTTP and packet flow diagnostics.

## MVP Limits

- `gateway_id` filtering is conservative: unassigned commands are accepted, commands assigned to another gateway are ignored.
- Duplicate protection is in-memory only, so a power cycle clears the recent command cache.
- Timestamps come from NTP. If NTP is unavailable, the gateway still runs but timestamp fields may be empty.
- The included `argus_field_node_mvp` sketch now matches the legacy pipe-delimited protocol and uses RadioLib SX1262.