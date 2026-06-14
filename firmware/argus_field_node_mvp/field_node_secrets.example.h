#pragma once

// ─────────────────────────────────────────────────────────────────────────────
// Argus Field Lynk — optional WiFi / OTA secrets
//
// To enable WiFi OTA updates on the field node:
//   1. Copy this file to field_node_secrets.h (same directory).
//   2. Fill in your WiFi credentials below.
//   3. Recompile and flash via USB once; after that, updates can be applied
//      wirelessly using the Arduino IDE Network port or the `arduino-cli`
//      `--port` flag pointing to the field node's IP address.
//
// If field_node_secrets.h is absent, FIELD_NODE_WIFI_SSID is never defined,
// FIELD_NODE_OTA_AVAILABLE compiles to 0, and all WiFi/OTA code is excluded.
// LoRa command handling is completely unaffected.
//
// SECURITY NOTE: Never commit field_node_secrets.h to version control.
// Add it to .gitignore.  The gateway equivalent (gateway_secrets.h) is
// already ignored.
// ─────────────────────────────────────────────────────────────────────────────

#define FIELD_NODE_WIFI_SSID     "Superstar727"
#define FIELD_NODE_WIFI_PASSWORD "Cadevaliava-01"

// Optional: override the OTA hostname suffix.
// Default hostname is built as: argus-field-<NODE_ID>
// Uncomment and set to a 4-digit suffix to distinguish multiple field nodes
// on the same network (e.g. last 4 digits of the board's MAC address).
// #define FIELD_NODE_OTA_HOSTNAME_SUFFIX "1421"
