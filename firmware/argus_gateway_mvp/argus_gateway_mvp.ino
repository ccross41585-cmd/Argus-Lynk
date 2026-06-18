#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <RadioLib.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoOTA.h>
#include <time.h>
#include <math.h>
#include "gateway_secrets.h"

// Human-readable gateway identity stored in device_commands.gateway_id.
const char* GATEWAY_ID = "home-base-001";

// ── Firmware identity ─────────────────────────────────────────────────────────
// Bump DEVICE_FIRMWARE_VERSION on every release build.
//
// TODO (future cloud-OTA): Compare DEVICE_FIRMWARE_VERSION against a
//   devices.target_firmware_version column in Supabase to drive staged rollout,
//   update-available notifications, and rollback tracking.  The gateway OTA
//   hostname is argus-gateway-<GATEWAY_ID> (e.g. argus-gateway-home-base-001).
const char* DEVICE_FIRMWARE_VERSION = "1.1.6";
const char* DEVICE_BUILD_DATE       = "2026-06-18";
const char* DEVICE_ROLE             = "gateway";
const bool  OTA_SUPPORTED           = true;

// Gateway has no relay, so this is a no-op placeholder for symmetry with the
// field node.  Set true if a future gateway variant needs a safe-state action.
const bool OTA_SAFE_MODE_RELAY_OFF = false;

const bool DEBUG_VERBOSE = false;

// Legacy field-node network identifiers.
const String NETWORK_KEY = "farm123";
const String NODE_ID = "fence1";

#define OLED_SDA 17
#define OLED_SCL 18
#define OLED_RST 21
#define OLED_ADDR 0x3C
#define VEXT_CTRL 36

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

// Heltec WiFi LoRa 32 V3 / SX1262 pinout.
#define LORA_NSS 8
#define LORA_DIO1 14
#define LORA_RST 12
#define LORA_BUSY 13
#define LORA_SCK 9
#define LORA_MISO 11
#define LORA_MOSI 10

const float LORA_FREQ = 915.0;

SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RST);

// Polling and ACK timing.
const unsigned long POLL_INTERVAL_MS = 2000;
const unsigned long ACK_TIMEOUT_MS = 3000;
const unsigned long COMMAND_RECOVERY_TIMEOUT_MS = 10UL * 60UL * 1000UL;  // 10 min
const size_t RECENT_COMMAND_CACHE_SIZE = 12;

// Simple NTP setup so the gateway can send ISO timestamps to Supabase.
const long GMT_OFFSET_SECONDS = 0;
const int DAYLIGHT_OFFSET_SECONDS = 0;
const char* NTP_SERVER = "pool.ntp.org";

struct PendingCommand {
  String id;
  String deviceId;
  String gatewayId;
  String command;
  String status;
  String createdAt;
};

// Post-command verification state machine.
struct PendingVerify {
  bool active;
  PendingCommand command;
  String expectedState;    // "on" or "off" — what the command should result in
  String lastAuxRaw;       // most recent aux_raw seen during window
  String lastFb;           // most recent contactor_feedback seen during window
  unsigned long startedAt; // millis() when window opened
  int retries;             // number of STATUS retries sent so far
};
PendingVerify pendingVerify = {false, {"", "", "", "", "", ""}, "", "", "", 0, 0};

String recentCommandIds[RECENT_COMMAND_CACHE_SIZE];
size_t recentCommandWriteIndex = 0;
unsigned long lastPollStartedAt = 0;
volatile bool receivedFlag = false;
bool oledOk = false;
bool wifiOk = false;
bool supabaseOk = false;
bool loraOk = false;
bool otaBusy = false;  // true while ArduinoOTA is flashing — gates LoRa + Supabase ops
String lastFenceState = "UNKNOWN";
String lastCommandText = "NONE";
String lastAckText = "NONE";
String lastTxText = "NONE";
String lastErrorText = "";
String lastHttpResponseBody = "";
int lastHttpStatusCode = 0;
int lastPollCount = 0;
float lastRssi = NAN;
float lastSnr = NAN;
unsigned long lastScreenUpdate = 0;

struct AckPacket {
  bool isValid;
  String sequence;
  String confirmedState;
  String relayState;
  String contactorFeedback;
  String auxRaw;         // AUX_LOW or AUX_HIGH as reported by field node GPIO34
  String physicalState;  // "on"/"off" — physical confirmed state from aux (field node >= 1.1.1)
};

// Cached Supabase device ID for the NODE_ID field node.
// Populated the first time a command for that node is processed.
String cachedFenceDeviceId = "";

// Heartbeat fault detection
unsigned long lastHbReceivedAt = 0;      // millis() when last HB was received from field node
bool powerLossAlertSent = false;          // Dedup: cleared when feedback returns to healthy
bool nodeOfflineAlertSent = false;        // Dedup: cleared after recovery + re-arm interval
unsigned long lastOfflineAlertSentAt = 0; // millis() when last offline alert was dispatched
String lastVerificationAlertCommandId = ""; // Dedup verification failure alerts per command

// 5 minutes — matches the PWA ONLINE_TIMEOUT_MS and is generous enough to
// survive transient RF gaps or the gateway being busy with Supabase calls.
const unsigned long HB_OFFLINE_TIMEOUT_MS = 5UL * 60UL * 1000UL;  // 5 min

// Minimum time between consecutive "Field Lynk Offline" alerts.
// Prevents alert storms if the node is flapping (brief drop then HB resets dedup).
const unsigned long OFFLINE_ALERT_MIN_INTERVAL_MS = 30UL * 60UL * 1000UL;  // 30 min

// Post-command physical verification window.
// After an ACK, the gateway waits up to CONTACT_VERIFY_TIMEOUT_MS for contactor
// feedback that confirms the physical state matches the issued command.
const unsigned long CONTACT_VERIFY_GRACE_MS    = 500;    // min wait before first check (ms)
const unsigned long CONTACT_VERIFY_TIMEOUT_MS  = 5000;   // max window before failure (ms)
const unsigned long CONTACT_VERIFY_RETRY_MS    = 750;    // STATUS retry interval (ms)
const int           CONTACT_VERIFY_MAX_RETRIES = 4;      // max STATUS retries in window

struct TransmitResult {
  bool isSuccess;
  int state;
};

#if defined(ESP8266) || defined(ESP32)
ICACHE_RAM_ATTR
#endif
void setReceiveFlag(void) {
  receivedFlag = true;
}

void logVerbose(const String& message) {
  if (DEBUG_VERBOSE) {
    Serial.println(message);
  }
}

String yesNoText(bool value) {
  return value ? "OK" : "NO";
}

String normalizedFenceState(const String& value) {
  if (value == "on" || value == "ON") {
    return "ON";
  }

  if (value == "off" || value == "OFF") {
    return "OFF";
  }

  return "UNKNOWN";
}

String shortCommandId(const String& commandId) {
  if (commandId.length() <= 8) {
    return commandId;
  }

  return commandId.substring(0, 8);
}

void drawScreen() {
  if (!oledOk) {
    return;
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("ARGUS BASE");
  display.print("WiFi:");
  display.print(yesNoText(wifiOk));
  display.print(" DB:");
  display.println(yesNoText(supabaseOk));
  display.print("LoRa:");
  display.print(yesNoText(loraOk));
  display.print(" OTA:");
  display.println(otaBusy ? "BUSY" : "RDY");
  display.print("FW:");
  display.println(DEVICE_FIRMWARE_VERSION);
  display.print("Fence:");
  display.println(lastFenceState);
  display.print("Last:");
  display.println(lastCommandText);
  display.print("ACK:");
  display.println(lastAckText);

  if (!isnan(lastRssi) || !isnan(lastSnr)) {
    display.print("R:");
    if (isnan(lastRssi)) {
      display.print("--");
    } else {
      display.print(static_cast<int>(lastRssi));
    }
    display.print(" S:");
    if (isnan(lastSnr)) {
      display.print("--");
    } else {
      display.print(lastSnr, 1);
    }
  } else {
    display.print("Poll:");
    display.print(lastPollCount);
  }

  display.display();
  lastScreenUpdate = millis();
}

void setupOLED() {
  Serial.println("Initializing OLED...");
  pinMode(VEXT_CTRL, OUTPUT);
  digitalWrite(VEXT_CTRL, LOW);
  delay(10);

  pinMode(OLED_RST, OUTPUT);
  digitalWrite(OLED_RST, LOW);
  delay(20);
  digitalWrite(OLED_RST, HIGH);
  delay(50);

  Wire.begin(OLED_SDA, OLED_SCL);

  oledOk = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (!oledOk) {
    Serial.println("OLED init failed");
    return;
  }

  Serial.println("OLED init OK");

  display.clearDisplay();
  display.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, SSD1306_WHITE);
  display.display();
  delay(150);

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Argus Base Booting");
  display.println("OLED OK");
  display.println("SDA 17 SCL 18");
  display.display();
  delay(1000);
  lastScreenUpdate = millis();
}

String buildApiUrl(const String& pathAndQuery) {
  return String(SUPABASE_URL) + "/rest/v1/" + pathAndQuery;
}

String trimCopy(const String& value) {
  String result = value;
  result.trim();
  return result;
}

String packetPart(const String& packet, int partIndex) {
  int tokenStart = 0;

  for (int currentIndex = 0; currentIndex < partIndex; currentIndex++) {
    tokenStart = packet.indexOf('|', tokenStart);
    if (tokenStart < 0) {
      return "";
    }

    tokenStart += 1;
  }

  int tokenEnd = packet.indexOf('|', tokenStart);
  if (tokenEnd < 0) {
    tokenEnd = packet.length();
  }

  return packet.substring(tokenStart, tokenEnd);
}

bool hasSeenCommandId(const String& commandId) {
  for (size_t index = 0; index < RECENT_COMMAND_CACHE_SIZE; index++) {
    if (recentCommandIds[index] == commandId) {
      return true;
    }
  }

  return false;
}

void rememberCommandId(const String& commandId) {
  recentCommandIds[recentCommandWriteIndex] = commandId;
  recentCommandWriteIndex = (recentCommandWriteIndex + 1) % RECENT_COMMAND_CACHE_SIZE;
}

String commandToConfirmedState(const String& command) {
  if (command == "turn_on") {
    return "on";
  }

  if (command == "turn_off") {
    return "off";
  }

  return "unknown";
}

String commandToLegacyAction(const String& command) {
  if (command == "turn_on") {
    return "ON";
  }

  if (command == "turn_off") {
    return "OFF";
  }

  return "";
}

String legacyActionToConfirmedState(const String& action) {
  if (action == "ON") {
    return "on";
  }

  if (action == "OFF") {
    return "off";
  }

  return "";
}

String timestampNow() {
  struct tm timeInfo;

  if (!getLocalTime(&timeInfo, 100)) {
    return "";
  }

  char buffer[25];
  strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &timeInfo);
  return String(buffer);
}

bool parseIsoTimestampUtc(const String& isoTs, time_t& outEpoch) {
  int year = 0;
  int month = 0;
  int day = 0;
  int hour = 0;
  int minute = 0;
  int second = 0;

  // Accept either Zulu or offset-less UTC format.
  int matched = sscanf(
    isoTs.c_str(),
    "%d-%d-%dT%d:%d:%dZ",
    &year,
    &month,
    &day,
    &hour,
    &minute,
    &second
  );
  if (matched != 6) {
    matched = sscanf(
      isoTs.c_str(),
      "%d-%d-%dT%d:%d:%d",
      &year,
      &month,
      &day,
      &hour,
      &minute,
      &second
    );
  }
  if (matched != 6) {
    return false;
  }

  struct tm tmValue = {};
  tmValue.tm_year = year - 1900;
  tmValue.tm_mon = month - 1;
  tmValue.tm_mday = day;
  tmValue.tm_hour = hour;
  tmValue.tm_min = minute;
  tmValue.tm_sec = second;
  tmValue.tm_isdst = 0;

  time_t epoch = mktime(&tmValue);
  if (epoch <= 0) {
    return false;
  }

  outEpoch = epoch;
  return true;
}

bool isCommandExpiredByAge(const PendingCommand& command) {
  if (command.createdAt.length() == 0) return false;

  time_t createdEpoch = 0;
  if (!parseIsoTimestampUtc(command.createdAt, createdEpoch)) {
    return false;
  }

  time_t nowEpoch = time(nullptr);
  if (nowEpoch <= 0) return false;

  long ageSeconds = (long)difftime(nowEpoch, createdEpoch);
  if (ageSeconds < 0) return false;

  return (unsigned long)ageSeconds * 1000UL >= COMMAND_RECOVERY_TIMEOUT_MS;
}

void printHttpError(const String& context, int statusCode, const String& body) {
  supabaseOk = false;
  lastErrorText = context + " HTTP " + String(statusCode);
  Serial.printf("%s failed. HTTP %d\n", context.c_str(), statusCode);
  if (body.length() > 0) {
    Serial.println(body);
  }
  drawScreen();
}

bool sendJsonPatch(const String& url, const String& payload, const String& context) {
  HTTPClient http;
  if (DEBUG_VERBOSE) {
    Serial.print("sendJsonPatch begin: ");
    Serial.println(context);
    Serial.print("sendJsonPatch url: ");
    Serial.println(url);
    Serial.print("sendJsonPatch payload: ");
    Serial.println(payload);
  }

  http.begin(url);
  http.setTimeout(3000);  // Don't block longer than 3 s — keeps OTA window open
  http.setReuse(false);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  http.addHeader("Prefer", "return=minimal");
  logVerbose("sendJsonPatch headers ready");

  int statusCode = http.PATCH(payload);
  lastHttpStatusCode = statusCode;
  if (DEBUG_VERBOSE) {
    Serial.print("sendJsonPatch PATCH returned: ");
    Serial.println(statusCode);
  }

  String response;
  if (statusCode < 200 || statusCode >= 300) {
    logVerbose("sendJsonPatch reading error response body");
    response = http.getString();
  }
  lastHttpResponseBody = response;

  logVerbose("sendJsonPatch calling http.end()");
  http.end();
  logVerbose("sendJsonPatch finished http.end()");

  if (statusCode < 200 || statusCode >= 300) {
    printHttpError(context, statusCode, response);
    return false;
  }

  supabaseOk = true;
  logVerbose("sendJsonPatch success");
  return true;
}

bool isSchemaMissingColumnError(const String& columnName = "") {
  if (lastHttpStatusCode != 400 || lastHttpResponseBody.indexOf("PGRST204") < 0) {
    return false;
  }
  if (columnName.length() == 0) {
    return true;
  }
  return lastHttpResponseBody.indexOf(columnName) >= 0;
}

bool isMissingFailureReasonColumnError() {
  return isSchemaMissingColumnError("failure_reason");
}

bool updateDeviceCommandStatus(const String& deviceId,
                               const String& commandStatus,
                               const String& lastCommandResult = "",
                               const String& commandVerifiedAt = "",
                               const String& commandFailedAt = "") {
  if (deviceId.length() == 0 || commandStatus.length() == 0) {
    return false;
  }

  String fetchUrl = buildApiUrl("devices?id=eq." + deviceId + "&select=metadata");
  HTTPClient http;
  http.begin(fetchUrl);
  http.setTimeout(3000);
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  int fetchStatus = http.GET();
  String fetchPayload = http.getString();
  http.end();

  DynamicJsonDocument merged(1024);
  if (fetchStatus >= 200 && fetchStatus < 300) {
    DynamicJsonDocument fetched(1024);
    if (!deserializeJson(fetched, fetchPayload) && fetched.is<JsonArray>() && fetched[0]["metadata"].is<JsonObject>()) {
      merged.set(fetched[0]["metadata"].as<JsonObject>());
    }
  }

  merged["command_status"] = commandStatus;
  if (lastCommandResult.length() > 0) {
    merged["last_command_result"] = lastCommandResult;
  }
  if (commandVerifiedAt.length() > 0) {
    merged["command_verified_at"] = commandVerifiedAt;
  }
  if (commandFailedAt.length() > 0) {
    merged["command_failed_at"] = commandFailedAt;
  }

  DynamicJsonDocument patchBody(1024);
  patchBody["metadata"] = merged;
  String patchPayload;
  serializeJson(patchBody, patchPayload);
  return sendJsonPatch(buildApiUrl("devices?id=eq." + deviceId), patchPayload, "PATCH devices command status");
}

bool markCommandSent(const PendingCommand& command) {
  DynamicJsonDocument body(256);
  body["status"] = "gateway_received";
  body["gateway_id"] = GATEWAY_ID;

  String sentAt = timestampNow();
  if (sentAt.length() > 0) {
    body["sent_at"] = sentAt;
    body["gateway_received_at"] = sentAt;
  }

  String url = buildApiUrl("device_commands?id=eq." + command.id);
  String payload;
  serializeJson(body, payload);
  if (!sendJsonPatch(url, payload, "PATCH device_commands sent")) {
    // Schema compatibility: lifecycle timestamp columns may be missing.
    if (isSchemaMissingColumnError()) {
      Serial.println("[SCHEMA COMPAT] device_commands lifecycle column missing. Retrying sent patch with minimal payload.");
      DynamicJsonDocument compatBody(128);
      compatBody["status"] = "gateway_received";
      compatBody["gateway_id"] = GATEWAY_ID;
      String compatPayload;
      serializeJson(compatBody, compatPayload);
      if (sendJsonPatch(url, compatPayload, "PATCH device_commands sent (schema fallback)")) {
        goto command_sent_ok;
      }
    }

    // Backward compatibility: DB may not have lifecycle columns yet.
    DynamicJsonDocument legacyBody(256);
    legacyBody["status"] = "sent";
    legacyBody["gateway_id"] = GATEWAY_ID;
    if (sentAt.length() > 0) {
      legacyBody["sent_at"] = sentAt;
    }
    String legacyPayload;
    serializeJson(legacyBody, legacyPayload);
    if (!sendJsonPatch(url, legacyPayload, "PATCH device_commands sent (legacy fallback)")) {
      return false;
    }
  }

command_sent_ok:

  String desiredState = commandToConfirmedState(command.command);
  if (desiredState == "on" || desiredState == "off") {
    DynamicJsonDocument desiredBody(256);
    desiredBody["desired_state"] = desiredState;
    String desiredPayload;
    serializeJson(desiredBody, desiredPayload);
    sendJsonPatch(buildApiUrl("devices?id=eq." + command.deviceId), desiredPayload, "PATCH devices desired_state at command pickup");
    Serial.printf("[STATE SEPARATION] desired=%s confirmed=(unchanged) device=%s\n",
      desiredState.c_str(), command.deviceId.c_str());
  }

  updateDeviceCommandStatus(command.deviceId, "sent", "pending");
  Serial.printf("[COMMAND PROGRESS] gateway_received id=%s device=%s\n",
    command.id.c_str(), command.deviceId.c_str());
  return true;
}

bool markCommandAcknowledged(const PendingCommand& command) {
  DynamicJsonDocument body(256);
  body["status"] = "node_acknowledged";
  body["error_message"] = nullptr;

  String acknowledgedAt = timestampNow();
  if (acknowledgedAt.length() > 0) {
    body["acknowledged_at"] = acknowledgedAt;
    body["node_acknowledged_at"] = acknowledgedAt;
  }

  String url = buildApiUrl("device_commands?id=eq." + command.id);
  String payload;
  serializeJson(body, payload);
  if (!sendJsonPatch(url, payload, "PATCH device_commands acknowledged")) {
    // Backward compatibility: DB may not have node_acknowledged_at yet.
    DynamicJsonDocument legacyBody(256);
    legacyBody["status"] = "acknowledged";
    legacyBody["error_message"] = nullptr;
    if (acknowledgedAt.length() > 0) {
      legacyBody["acknowledged_at"] = acknowledgedAt;
    }
    String legacyPayload;
    serializeJson(legacyBody, legacyPayload);
    if (!sendJsonPatch(url, legacyPayload, "PATCH device_commands acknowledged (legacy fallback)")) {
      return false;
    }
  }

  updateDeviceCommandStatus(command.deviceId, "node_acknowledged", "pending");

  Serial.printf("[COMMAND PROGRESS] node_acknowledged id=%s device=%s\n",
    command.id.c_str(), command.deviceId.c_str());
  drawScreen();
  return true;
}

bool updateDeviceConfirmedState(const String& deviceId, const String& confirmedState, const String& desiredState) {
  if (deviceId.length() == 0 || confirmedState.length() == 0) {
    return false;
  }

  DynamicJsonDocument deviceBody(512);
  deviceBody["confirmed_state"] = confirmedState;
  deviceBody["desired_state"] = desiredState;
  deviceBody["online"] = true;
  deviceBody["status"] = "online";

  String nowTs = timestampNow();
  if (nowTs.length() > 0) {
    deviceBody["last_seen"]    = nowTs;
    deviceBody["last_seen_at"] = nowTs;
  }

  Serial.printf("[STATE SEPARATION] desired=%s confirmed=%s device=%s\n",
    desiredState.c_str(), confirmedState.c_str(), deviceId.c_str());

  String deviceUrl = buildApiUrl("devices?id=eq." + deviceId);
  String devicePayload;
  serializeJson(deviceBody, devicePayload);
  return sendJsonPatch(deviceUrl, devicePayload, "PATCH devices confirmed state after verification");
}

bool updateDeviceContactorFeedback(const String& deviceId,
                                   const String& contactorFeedback,
                                   const String& auxRaw,
                                   const String& fieldFirmwareVersion = "",
                                   bool fieldWifiConnected = false,
                                   const String& commandStatus = "",
                                   const String& lastCommandResult = "",
                                   const String& commandVerifiedAt = "") {
  if (contactorFeedback.length() == 0 && auxRaw.length() == 0) {
    return true;
  }

  // Fetch existing metadata first so we can merge without clobbering other fields
  String fetchUrl = buildApiUrl("devices?id=eq." + deviceId + "&select=metadata");
  HTTPClient http;
  http.begin(fetchUrl);
  http.setTimeout(3000);
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  int fetchStatus = http.GET();
  String fetchPayload = http.getString();
  http.end();

  DynamicJsonDocument merged(1024);
  if (fetchStatus >= 200 && fetchStatus < 300) {
    DynamicJsonDocument fetched(1024);
    if (!deserializeJson(fetched, fetchPayload) && fetched.is<JsonArray>() && fetched[0]["metadata"].is<JsonObject>()) {
      merged.set(fetched[0]["metadata"].as<JsonObject>());
    }
  }
  merged["contactor_feedback"] = contactorFeedback;
  if (auxRaw.length() > 0) {
    merged["aux_raw"] = auxRaw;
  }
  // Persist command verification state when provided.
  if (commandStatus.length() > 0) {
    merged["command_status"] = commandStatus;
  }
  if (lastCommandResult.length() > 0) {
    merged["last_command_result"] = lastCommandResult;
  }
  if (commandVerifiedAt.length() > 0) {
    merged["command_verified_at"] = commandVerifiedAt;
  }
  // Persist firmware info reported by the field node in the HB packet.
  if (fieldFirmwareVersion.length() > 0) {
    merged["device_role"]    = "field_node";
    merged["ota_supported"]  = fieldWifiConnected;  // OTA requires WiFi on field node
    merged["wifi_connected"] = fieldWifiConnected;
  }

  String nowTs = timestampNow();

  DynamicJsonDocument patchBody(1024);
  patchBody["metadata"]  = merged;
  patchBody["online"]    = true;
  patchBody["status"]    = "online";
  if (nowTs.length() > 0) {
    patchBody["last_seen"]    = nowTs;
    patchBody["last_seen_at"] = nowTs;
  }
  // Write firmware_version to the top-level column when the field node reports it.
  if (fieldFirmwareVersion.length() > 0) {
    patchBody["firmware_version"] = fieldFirmwareVersion;
  }

  Serial.printf("[HB] Updating device %s: online=true status=online last_seen=%s fb=%s aux=%s fw=%s wifi=%s\n",
    deviceId.c_str(), nowTs.c_str(), contactorFeedback.c_str(), auxRaw.c_str(),
    fieldFirmwareVersion.length() > 0 ? fieldFirmwareVersion.c_str() : "(none)",
    fieldWifiConnected ? "1" : "0");

  String patchPayload;
  serializeJson(patchBody, patchPayload);

  String patchUrl = buildApiUrl("devices?id=eq." + deviceId);
  return sendJsonPatch(patchUrl, patchPayload, "PATCH devices heartbeat");
}

// ── Alert creation + push notification ─────────────────────────────────────────────

// Inserts an alert row into Supabase and returns the new alert UUID string.
// Returns an empty string on failure.
String insertAlert(const String& severity, const String& title, const String& message) {
  DynamicJsonDocument body(512);
  if (cachedFenceDeviceId.length() > 0) {
    body["device_id"] = cachedFenceDeviceId;
  }
  body["severity"] = severity;
  body["title"]    = title;
  body["message"]  = message;
  body["status"]   = "active";

  String payload;
  serializeJson(body, payload);

  String url = buildApiUrl("alerts");
  HTTPClient http;
  http.begin(url);
  http.setTimeout(3000);
  http.setReuse(false);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  http.addHeader("Prefer", "return=representation");

  int statusCode = http.POST(payload);
  String response = http.getString();
  http.end();

  if (statusCode < 200 || statusCode >= 300) {
    Serial.printf("insertAlert failed. HTTP %d\n", statusCode);
    return "";
  }

  // Supabase returns a JSON array of inserted rows when Prefer:return=representation is set.
  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, response)) {
    Serial.println("insertAlert: JSON parse error");
    return "";
  }

  String alertId;
  if (doc.is<JsonArray>() && doc[0]["id"].is<const char*>()) {
    alertId = String(doc[0]["id"].as<const char*>());
  }
  Serial.printf("Alert inserted: %s\n", alertId.c_str());
  return alertId;
}

// Calls the Supabase edge function to fan push notifications out to all
// subscribed devices for the given alert.
void callPushEdgeFunction(const String& alertId) {
  if (alertId.length() == 0) return;

  DynamicJsonDocument body(128);
  body["alertId"] = alertId;
  String payload;
  serializeJson(body, payload);

  String url = String(SUPABASE_URL) + "/functions/v1/send-push-notification";
  HTTPClient http;
  http.begin(url);
  http.setTimeout(3000);
  http.setReuse(false);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);

  int statusCode = http.POST(payload);
  String response = http.getString();
  http.end();

  if (statusCode < 200 || statusCode >= 300) {
    Serial.printf("callPushEdgeFunction failed. HTTP %d: %s\n", statusCode, response.substring(0, 80).c_str());
    return;
  }
  Serial.printf("Push dispatched for alert %s: %s\n", alertId.c_str(), response.substring(0, 60).c_str());
}

// One-step: insert alert + fire push notifications.
void createAndSendAlert(const String& severity, const String& title, const String& message) {
  Serial.printf("[ALERT] %s: %s\n", severity.c_str(), title.c_str());
  String alertId = insertAlert(severity, title, message);
  if (alertId.length() == 0) {
    Serial.println("[ALERT] insertAlert failed — check anon key INSERT permission on alerts table.");
    return;
  }
  Serial.printf("[ALERT] Inserted alert %s. Calling push edge function...\n", alertId.c_str());
  callPushEdgeFunction(alertId);
}

bool markCommandFailed(const PendingCommand& command,
                       const String& errorMessage,
                       const String& status = "failed",
                       const String& failureReason = "") {
  DynamicJsonDocument body(256);
  body["status"] = status;
  body["error_message"] = errorMessage;
  if (failureReason.length() > 0) {
    body["failure_reason"] = failureReason;
  }

  String nowTs = timestampNow();
  if (status == "verification_failed" && nowTs.length() > 0) {
    body["failed_at"] = nowTs;
  }

  String url = buildApiUrl("device_commands?id=eq." + command.id);
  String payload;
  serializeJson(body, payload);
  Serial.printf("[COMMAND FAILED] id=%s status=%s reason=%s error=%s\n",
    command.id.c_str(), status.c_str(), failureReason.c_str(), errorMessage.c_str());
  Serial.print("Command failed: ");
  Serial.println(errorMessage);
  lastErrorText = errorMessage;
  supabaseOk = false;
  drawScreen();
  if (sendJsonPatch(url, payload, "PATCH device_commands failed")) {
    return true;
  }

  if (!isSchemaMissingColumnError()) {
    return false;
  }

  Serial.println("[SCHEMA COMPAT] failed command payload contains missing column(s). Retrying with minimal payload.");
  DynamicJsonDocument fallbackBody(256);
  fallbackBody["status"] = status;
  fallbackBody["error_message"] = errorMessage;
  String fallbackPayload;
  serializeJson(fallbackBody, fallbackPayload);
  return sendJsonPatch(url, fallbackPayload, "PATCH device_commands failed (schema fallback)");
}

bool markCommandLifecycleStatus(const PendingCommand& command,
                                const String& status,
                                const String& timestampField = "",
                                const String& failureReason = "") {
  DynamicJsonDocument body(512);
  body["status"] = status;

  String nowTs = timestampNow();
  if (timestampField.length() > 0 && nowTs.length() > 0) {
    body[timestampField] = nowTs;
  }

  if (failureReason.length() > 0) {
    body["failure_reason"] = failureReason;
  }

  String url = buildApiUrl("device_commands?id=eq." + command.id);
  String payload;
  serializeJson(body, payload);
  if (sendJsonPatch(url, payload, "PATCH device_commands lifecycle status")) {
    return true;
  }

  // Schema compatibility fallback: old DB schemas may not have lifecycle
  // timestamp columns (sent_to_node_at, node_acknowledged_at, verified_at)
  // and/or failure_reason.
  if (!isSchemaMissingColumnError()) {
    return false;
  }

  Serial.println("[SCHEMA COMPAT] lifecycle column missing. Retrying lifecycle patch with status-only payload.");
  DynamicJsonDocument fallbackBody(128);
  fallbackBody["status"] = status;
  String fallbackPayload;
  serializeJson(fallbackBody, fallbackPayload);
  return sendJsonPatch(url, fallbackPayload, "PATCH device_commands lifecycle status (schema fallback)");
}

bool fetchPendingCommands(PendingCommand* commands, size_t maxCommands, size_t& commandCount) {
  commandCount = 0;

  String url = buildApiUrl(
    "device_commands?or=(status.eq.pending,status.eq.gateway_received,status.eq.sent_to_node,status.eq.node_acknowledged,status.eq.verifying)"
    "&order=created_at.desc"
    "&select=id,device_id,gateway_id,command,status,created_at"
  );

  HTTPClient http;
  http.begin(url);
  http.setTimeout(3000);
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);

  logVerbose("Polling Supabase for pending commands...");
  int statusCode = http.GET();
  String payload = http.getString();
  http.end();

  if (statusCode < 200 || statusCode >= 300) {
    supabaseOk = false;
    lastPollCount = 0;
    drawScreen();
    printHttpError("GET pending device_commands", statusCode, payload);
    return false;
  }

  supabaseOk = true;

  DynamicJsonDocument doc(8192);
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("Failed to parse pending command JSON: %s\n", error.c_str());
    supabaseOk = false;
    lastErrorText = "Pending parse failed";
    drawScreen();
    return false;
  }

  JsonArray rows = doc.as<JsonArray>();
  for (JsonObject row : rows) {
    if (commandCount >= maxCommands) {
      Serial.println("Pending command list exceeded local buffer. Remaining rows will be retried on the next poll.");
      break;
    }

    PendingCommand& nextCommand = commands[commandCount++];
    nextCommand.id = row["id"].as<const char*>();
    nextCommand.deviceId = row["device_id"].as<const char*>();
    nextCommand.gatewayId = row["gateway_id"].isNull() ? "" : String(row["gateway_id"].as<const char*>());
    nextCommand.command = row["command"].as<const char*>();
    nextCommand.status = row["status"].isNull() ? "pending" : String(row["status"].as<const char*>());
    nextCommand.createdAt = row["created_at"].isNull() ? "" : String(row["created_at"].as<const char*>());

    Serial.printf("[COMMAND RECOVERY] status=%s id=%s created_at=%s\n",
      nextCommand.status.c_str(), nextCommand.id.c_str(), nextCommand.createdAt.c_str());
  }

  lastPollCount = static_cast<int>(commandCount);
  Serial.print("Poll: pending=");
  Serial.println(commandCount);
  drawScreen();
  return true;
}

void connectToWifi() {
  Serial.printf("Connecting to WiFi SSID: %s\n", WIFI_SSID);
  wifiOk = false;
  drawScreen();
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
  }

  Serial.println();
  Serial.print("WiFi connected. IP address: ");
  Serial.println(WiFi.localIP());
  wifiOk = true;
  lastErrorText = "";
  drawScreen();
}

void ensureWifiConnected() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.println("WiFi dropped. Reconnecting...");
  wifiOk = false;
  drawScreen();
  WiFi.disconnect();
  connectToWifi();
}

void syncClock() {
  Serial.println("Starting NTP time sync...");
  configTime(GMT_OFFSET_SECONDS, DAYLIGHT_OFFSET_SECONDS, NTP_SERVER);

  for (int attempt = 0; attempt < 20; attempt++) {
    if (timestampNow().length() > 0) {
      Serial.println("Clock synchronized.");
      return;
    }

    delay(250);
  }

  Serial.println("Clock sync not ready yet. The gateway will continue and retry timestamps later.");
}

void initializeLoRa() {
  Serial.println("Initializing SX1262 radio...");
  int state = radio.begin(LORA_FREQ);

  if (state != RADIOLIB_ERR_NONE) {
    loraOk = false;
    lastErrorText = "LoRa init failed";
    drawScreen();
    Serial.printf("SX1262 init failed. RadioLib code: %d\n", state);
    while (true) {
      delay(1000);
    }
  }

  radio.setPacketReceivedAction(setReceiveFlag);
  loraOk = true;
  lastErrorText = "";
  drawScreen();
  Serial.println("SX1262 radio ready.");
}

String buildCommandPacket(const PendingCommand& command, const String& legacyAction) {
  return "CMD|" + NETWORK_KEY + "|" + NODE_ID + "|" + command.id + "|" + legacyAction;
}

TransmitResult sendCommandPacket(String packet) {
  logVerbose("Calling radio.transmit...");
  if (DEBUG_VERBOSE) {
    Serial.print("Sending LoRa command packet: ");
    Serial.println(packet);
  }

  int state = radio.transmit(packet);
  if (DEBUG_VERBOSE) {
    Serial.print("radio.transmit returned: ");
    Serial.println(state);
  }

  loraOk = state == RADIOLIB_ERR_NONE;
  if (!loraOk) {
    lastErrorText = "LoRa transmit " + String(state);
  }
  drawScreen();

  return {state == RADIOLIB_ERR_NONE, state};
}

AckPacket waitForAck(const PendingCommand& command) {
  AckPacket ack = {false, "", "", "", "", "", ""};
  unsigned long waitStartedAt = millis();
  receivedFlag = false;

  int state = radio.startReceive();
  if (state != RADIOLIB_ERR_NONE) {
    loraOk = false;
    lastErrorText = "LoRa receive start failed";
    drawScreen();
    Serial.printf("Failed to enter receive mode. RadioLib code: %d\n", state);
    return ack;
  }

  while (millis() - waitStartedAt < ACK_TIMEOUT_MS) {
    if (!receivedFlag) {
      delay(25);
      continue;
    }

    receivedFlag = false;

    String packet;
    state = radio.readData(packet);
    if (state == RADIOLIB_ERR_CRC_MISMATCH) {
      logVerbose("ACK ignored because CRC check failed.");
      radio.startReceive();
      continue;
    }

    if (state != RADIOLIB_ERR_NONE) {
      loraOk = false;
      lastErrorText = "LoRa read failed";
      drawScreen();
      Serial.printf("Failed to read ACK packet. RadioLib code: %d\n", state);
      radio.startReceive();
      continue;
    }

    packet = trimCopy(packet);
    Serial.print("[ACK RECEIVED] ");
    Serial.println(packet);

    String packetType = packetPart(packet, 0);
    String packetKey = packetPart(packet, 1);
    String packetNode = packetPart(packet, 2);
    String packetSequence = packetPart(packet, 3);
    String packetAction            = packetPart(packet, 4);
    String packetRelayState        = packetPart(packet, 5);  // ON/OFF output pin state
    String packetAuxRaw            = packetPart(packet, 6);  // AUX_LOW or AUX_HIGH
    String packetContactorFeedback = packetPart(packet, 7);
    String packetPhysicalState     = packetPart(packet, 8);  // "on"/"off"
    String packetFirmwareVersion   = packetPart(packet, 9);
    String packetWifiConnected     = packetPart(packet, 10);

    if (DEBUG_VERBOSE) {
      Serial.printf("[ACK PARSE] seq=%s cmd=%s relay=%s aux=%s fb=%s confirmed=%s fw=%s wifi=%s\n",
        packetSequence.c_str(),
        packetAction.c_str(),
        packetRelayState.c_str(),
        packetAuxRaw.c_str(),
        packetContactorFeedback.c_str(),
        packetPhysicalState.c_str(),
        packetFirmwareVersion.c_str(),
        packetWifiConnected.c_str());
    }

    if (packetType != "ACK") {
      logVerbose("ACK ignored because type is not ACK.");
      radio.startReceive();
      continue;
    }

    if (packetKey != NETWORK_KEY) {
      logVerbose("ACK ignored because network key does not match.");
      radio.startReceive();
      continue;
    }

    if (packetNode != NODE_ID) {
      logVerbose("ACK ignored because node id does not match.");
      radio.startReceive();
      continue;
    }

    if (packetSequence != command.id) {
      logVerbose("ACK ignored because sequence does not match the command in flight.");
      radio.startReceive();
      continue;
    }

    ack.confirmedState = (packetPhysicalState == "on" || packetPhysicalState == "off")
      ? packetPhysicalState
      : legacyActionToConfirmedState(packetAction);
    if (ack.confirmedState.length() == 0) {
      logVerbose("ACK ignored because state token is not ON or OFF.");
      radio.startReceive();
      continue;
    }

    ack.isValid = true;
    ack.sequence = packetSequence;
    ack.relayState = packetRelayState;
    ack.contactorFeedback = packetContactorFeedback;
    ack.auxRaw = packetAuxRaw;
    ack.physicalState = packetPhysicalState;
    loraOk = true;
    lastRssi = radio.getRSSI();
    lastSnr = radio.getSNR();
    return ack;
  }

  radio.standby();
  return ack;
}

// ── Post-command verification helpers ─────────────────────────────────────────

// Returns true when AUX contact confirms the issued command.
// Field Lynk verification is aux-first: feedback alone is never sufficient.
bool isCommandVerified(const String& expectedState, const String& auxRaw) {
  if (expectedState == "on")  return auxRaw == "AUX_HIGH";
  if (expectedState == "off") return auxRaw == "AUX_LOW";
  return false;
}

// Returns true when AUX is present and opposite of the expected state.
bool isAuxOppositeExpected(const String& expectedState, const String& auxRaw) {
  if (auxRaw.length() == 0) return false;
  if (expectedState == "on"  && auxRaw == "AUX_LOW")  return true;
  if (expectedState == "off" && auxRaw == "AUX_HIGH") return true;
  return false;
}

void processPendingCommand(const PendingCommand& command) {
  if (command.id.length() == 0 || command.deviceId.length() == 0 || command.command.length() == 0) {
    Serial.println("Skipping malformed command row from Supabase.");
    return;
  }

  if (command.gatewayId.length() > 0 && command.gatewayId != GATEWAY_ID) {
    Serial.printf("Skipping command %s because it belongs to gateway %s\n", command.id.c_str(), command.gatewayId.c_str());
    return;
  }

  if (hasSeenCommandId(command.id)) {
    Serial.printf("Skipping duplicate command already handled in this session: %s\n", command.id.c_str());
    return;
  }

  const String recoveredStatus = command.status.length() > 0 ? command.status : "pending";
  Serial.printf("[COMMAND RECOVERY] status=%s id=%s\n", recoveredStatus.c_str(), command.id.c_str());

  if (isCommandExpiredByAge(command)) {
    markCommandFailed(
      command,
      "Command expired before completion",
      "expired",
      "command_expired"
    );
    rememberCommandId(command.id);
    return;
  }

  String expectedState = commandToConfirmedState(command.command);
  String legacyAction = commandToLegacyAction(command.command);
  if (expectedState == "unknown" || legacyAction.length() == 0) {
    Serial.printf("Unsupported command '%s'. Marking as failed.\n", command.command.c_str());
    if (markCommandFailed(command, "Unsupported command for gateway MVP")) {
      rememberCommandId(command.id);
    }
    return;
  }

  if (recoveredStatus == "verifying" || recoveredStatus == "node_acknowledged" || recoveredStatus == "acknowledged") {
    markCommandLifecycleStatus(command, "verifying");
    updateDeviceCommandStatus(command.deviceId, "verifying", "pending");
    Serial.printf("[COMMAND PROGRESS] verifying id=%s (recovered from %s)\n",
      command.id.c_str(), recoveredStatus.c_str());
    pendingVerify.active        = true;
    pendingVerify.command       = command;
    pendingVerify.expectedState = expectedState;
    pendingVerify.lastAuxRaw    = "";
    pendingVerify.lastFb        = "";
    pendingVerify.startedAt     = millis();
    pendingVerify.retries       = 0;
    radio.startReceive();
    return;
  }

  lastCommandText = legacyAction;
  lastAckText = "NONE";
  lastTxText = "NONE";
  lastErrorText = "";
  drawScreen();

  if (!markCommandSent(command)) {
    Serial.println("Could not mark command as sent. It will be retried on the next poll.");
    drawScreen();
    return;
  }

  logVerbose("markCommandSent returned true");
  logVerbose("Preparing legacy LoRa command");
  String packet = buildCommandPacket(command, legacyAction);
  if (DEBUG_VERBOSE) {
    Serial.print("Legacy LoRa packet built: ");
    Serial.println(packet);
  }

  AckPacket ack = {false, "", "", "", "", "", ""};
  for (int attempt = 0; attempt < 2; attempt++) {
    TransmitResult transmitResult = sendCommandPacket(packet);
    if (!transmitResult.isSuccess) {
      String errorMessage = "LoRa transmit failed: " + String(transmitResult.state);
      markCommandFailed(command, errorMessage);
      Serial.println("Finished command processing, returning to polling");
      return;
    }

    lastTxText = legacyAction;
    drawScreen();
    Serial.print("CMD sent: ");
    Serial.print(legacyAction);
    Serial.print(" id=");
    Serial.println(shortCommandId(command.id));
    markCommandLifecycleStatus(command, "sent_to_node", "sent_to_node_at");
    Serial.printf("[COMMAND PROGRESS] sent_to_node id=%s\n", command.id.c_str());

    logVerbose("Starting ACK wait...");
    ack = waitForAck(command);
    if (DEBUG_VERBOSE) {
      Serial.print("ACK wait finished. validAck=");
      Serial.println(ack.isValid ? "true" : "false");
    }

    if (ack.isValid) {
      lastAckText = "OK";
      lastFenceState = normalizedFenceState(ack.confirmedState);
      Serial.print("ACK ok: ");
      Serial.println(lastFenceState);
      drawScreen();
      break;
    }

    lastAckText = "FAIL";
    lastErrorText = "No valid ACK";
    drawScreen();

    if (attempt == 0) {
      Serial.println("ACK missed, retrying once...");
    }
  }

  if (ack.isValid) {
    markCommandLifecycleStatus(command, "node_acknowledged", "node_acknowledged_at");
    Serial.printf("[COMMAND PROGRESS] node_acknowledged id=%s\n", command.id.c_str());
    markCommandLifecycleStatus(command, "verifying");
    updateDeviceCommandStatus(command.deviceId, "verifying", "pending");
    Serial.printf("[COMMAND PROGRESS] verifying id=%s\n", command.id.c_str());
    Serial.printf("[ACK] node=%s state=%s aux=%s fb=%s\n",
      NODE_ID.c_str(), ack.confirmedState.c_str(), ack.auxRaw.c_str(), ack.contactorFeedback.c_str());
    const bool ackAuxPresent = ack.auxRaw.length() > 0;
    const bool ackVerified = isCommandVerified(expectedState, ack.auxRaw);
    const bool ackOpposite = isAuxOppositeExpected(expectedState, ack.auxRaw);
    const char* ackResult = ackVerified ? "verified" : (ackOpposite ? "opposite_waiting" : "pending");
    Serial.printf("[AUX VERIFY] desired=%s aux_raw=%s feedback=%s result=%s\n",
      expectedState.c_str(), ack.auxRaw.c_str(), ack.contactorFeedback.c_str(), ackResult);

    if (!ackAuxPresent) {
      Serial.printf("[AUX MISSING] command_id=%s packet=ACK|%s|%s|%s|%s|%s|%s|%s|%s\n",
        command.id.c_str(),
        NETWORK_KEY.c_str(),
        NODE_ID.c_str(),
        ack.sequence.c_str(),
        legacyAction.c_str(),
        ack.relayState.c_str(),
        ack.auxRaw.c_str(),
        ack.contactorFeedback.c_str(),
        ack.physicalState.c_str());
    }

    if (ackVerified) {
      Serial.printf("[ACK VERIFY FAST PATH] command_id=%s expected=%s aux=%s result=verified\n",
        command.id.c_str(), expectedState.c_str(), ack.auxRaw.c_str());
      String nowTs = timestampNow();
      markCommandLifecycleStatus(command, "verified", "verified_at");
      updateDeviceContactorFeedback(command.deviceId, ack.contactorFeedback, ack.auxRaw,
                                    "", false, "verified", "verified", nowTs);
      updateDeviceCommandStatus(command.deviceId, "verified", "verified", nowTs);
      updateDeviceConfirmedState(command.deviceId, expectedState, expectedState);
      Serial.printf("[COMMAND VERIFIED] id=%s desired=%s confirmed=%s\n",
        command.id.c_str(), expectedState.c_str(), expectedState.c_str());
      rememberCommandId(command.id);
      Serial.println("Finished command processing, returning to polling");
      return;
    }

    // Aux missing/opposite/uncertain — start post-command verification window.
    Serial.printf("[AUX VERIFY] desired=%s aux_raw=%s feedback=%s result=waiting\n",
      expectedState.c_str(), ack.auxRaw.c_str(), ack.contactorFeedback.c_str());
    markCommandAcknowledged(command);
    updateDeviceContactorFeedback(command.deviceId, ack.contactorFeedback, ack.auxRaw,
                                  "", false, "verifying", "pending", "");
    updateDeviceCommandStatus(command.deviceId, "verifying", "pending");
    pendingVerify.active        = true;
    pendingVerify.command       = command;
    pendingVerify.expectedState = expectedState;
    pendingVerify.lastAuxRaw    = ack.auxRaw;
    pendingVerify.lastFb        = ack.contactorFeedback;
    pendingVerify.startedAt     = millis();
    pendingVerify.retries       = 0;
    // rememberCommandId deferred until verification resolves.
    radio.startReceive();
    Serial.println("Entered verification window, returning to polling");
    return;
  }

  // ACK may be lost even when the node acted on the command. Do one explicit
  // verification window with STATUS retries before declaring failure.
  Serial.println("[VERIFY] No ACK yet — entering verification window for extra checks.");
  markCommandLifecycleStatus(command, "verifying");
  Serial.printf("[COMMAND PROGRESS] verifying id=%s\n", command.id.c_str());
  updateDeviceCommandStatus(command.deviceId, "verifying", "pending");
  pendingVerify.active        = true;
  pendingVerify.command       = command;
  pendingVerify.expectedState = expectedState;
  pendingVerify.lastAuxRaw    = "";
  pendingVerify.lastFb        = "";
  pendingVerify.startedAt     = millis();
  pendingVerify.retries       = 0;
  radio.startReceive();
  Serial.println("Entered verification window after missed ACK, returning to polling");
}

// ── Post-command verification window ─────────────────────────────────────────
// Called every loop iteration while pendingVerify.active == true.
// Processes incoming HB and ACK packets, sends STATUS retries, and resolves
// the verification as either "verified" or "verification_failed".
void checkVerificationWindow() {
  if (!pendingVerify.active) return;

  unsigned long elapsedMs = millis() - pendingVerify.startedAt;

  // Process any pending LoRa packet (HB from periodic/immediate HB, or ACK from STATUS retry).
  if (receivedFlag) {
    receivedFlag = false;
    String packet;
    int state = radio.readData(packet);
    if (state == RADIOLIB_ERR_NONE) {
      packet.trim();
      String pType = packetPart(packet, 0);
      String pKey  = packetPart(packet, 1);
      String pNode = packetPart(packet, 2);
      String pFb   = "";
      String pAux  = "";
      String pRelay = "";
      bool relevant = false;

      if (pType == "HB" && pKey == NETWORK_KEY && pNode == NODE_ID) {
        pRelay = packetPart(packet, 5);
        pAux   = packetPart(packet, 6);
        pFb    = packetPart(packet, 7);
        lastHbReceivedAt     = millis();
        nodeOfflineAlertSent = false;
        lastRssi = radio.getRSSI();
        lastSnr  = radio.getSNR();
        relevant = true;
      } else if (pType == "ACK" && pKey == NETWORK_KEY && pNode == NODE_ID) {
        // ACK in response to a STATUS retry we sent.
        String pSeq = packetPart(packet, 3);
        if (pSeq == pendingVerify.command.id) {
          pRelay = packetPart(packet, 5);
          pAux   = packetPart(packet, 6);
          pFb    = packetPart(packet, 7);
          lastRssi = radio.getRSSI();
          lastSnr  = radio.getSNR();
          relevant = true;
        }
      }

      if (relevant && (pFb.length() > 0 || pAux.length() > 0 || pRelay.length() > 0)) {
        pendingVerify.lastFb     = pFb;
        pendingVerify.lastAuxRaw = pAux;

        if (pAux.length() == 0) {
          Serial.printf("[AUX MISSING] command_id=%s packet=%s\n",
            pendingVerify.command.id.c_str(), packet.c_str());
        }

        const bool verified = isCommandVerified(pendingVerify.expectedState, pAux);
        const bool auxOpposite = isAuxOppositeExpected(pendingVerify.expectedState, pAux);
        const char* verifyResult = verified ? "verified" : (auxOpposite ? "opposite_waiting" : "pending");
        Serial.printf("[AUX VERIFY] desired=%s aux_raw=%s feedback=%s result=%s\n",
          pendingVerify.expectedState.c_str(), pAux.c_str(), pFb.c_str(), verifyResult);

        if (verified) {
          String confirmedState = (pendingVerify.expectedState == "on") ? "on" : "off";
          String nowTs = timestampNow();
          markCommandLifecycleStatus(pendingVerify.command, "verified", "verified_at");
          updateDeviceContactorFeedback(pendingVerify.command.deviceId, pFb, pAux,
                                        "", false, "verified", "verified", nowTs);
          updateDeviceCommandStatus(pendingVerify.command.deviceId, "verified", "verified", nowTs);
          updateDeviceConfirmedState(pendingVerify.command.deviceId, confirmedState, pendingVerify.expectedState);
          Serial.printf("[COMMAND VERIFIED] id=%s desired=%s confirmed=%s\n",
            pendingVerify.command.id.c_str(), pendingVerify.expectedState.c_str(), confirmedState.c_str());
          rememberCommandId(pendingVerify.command.id);
          lastFenceState = normalizedFenceState(confirmedState);
          pendingVerify.active = false;
          drawScreen();
          radio.startReceive();
          return;
        }

        // Do not fail early on opposite AUX; continue retries until timeout.
      }
    }
    radio.startReceive();
  }

  // Timeout: window expired without confirmation.
  if (elapsedMs >= CONTACT_VERIFY_TIMEOUT_MS) {
    Serial.printf("[VERIFY] failed after timeout (elapsed=%lu ms, last_fb=%s, last_aux=%s)\n",
      elapsedMs, pendingVerify.lastFb.c_str(), pendingVerify.lastAuxRaw.c_str());
    const bool auxMissing = pendingVerify.lastAuxRaw.length() == 0;
    const bool auxMismatch = isAuxOppositeExpected(pendingVerify.expectedState, pendingVerify.lastAuxRaw);
    const String failureReason = auxMissing
      ? "aux_missing"
      : (auxMismatch ? "aux_mismatch" : "verification_timeout");
    String nowTs = timestampNow();
    markCommandLifecycleStatus(
      pendingVerify.command,
      "verification_failed",
      "failed_at",
      failureReason
    );
    updateDeviceContactorFeedback(pendingVerify.command.deviceId,
                                  pendingVerify.lastFb, pendingVerify.lastAuxRaw,
                                  "", false, "verification_failed", "verification_failed", nowTs);
    updateDeviceCommandStatus(pendingVerify.command.deviceId, "verification_failed", "verification_failed", "", nowTs);
    markCommandFailed(pendingVerify.command,
      auxMissing
        ? "Verification timeout — aux contact feedback missing"
        : (auxMismatch
            ? "Verification timeout — aux contact remained opposite of requested state"
            : "Verification timeout — no physical confirmation received"),
      "verification_failed",
      failureReason);
    bool nodeLooksOffline = (lastHbReceivedAt == 0) || ((millis() - lastHbReceivedAt) > HB_OFFLINE_TIMEOUT_MS);
    if (lastVerificationAlertCommandId != pendingVerify.command.id) {
      lastVerificationAlertCommandId = pendingVerify.command.id;
      if (nodeLooksOffline) {
        createAndSendAlert("critical", "Field Lynk Connection Issue",
          "Field Lynk command could not be verified because the node appears offline or stale.");
      } else if (auxMissing) {
        createAndSendAlert("critical", "Field Lynk Aux Feedback Missing",
          "Field Lynk command was sent, but aux contact feedback was not received before timeout.");
      } else if (auxMismatch) {
        createAndSendAlert("critical", "Field Lynk Command Not Confirmed",
          "Field Lynk command was sent, but aux contact remained opposite of the requested state.");
      } else {
        createAndSendAlert("critical", "Field Lynk Command Not Confirmed",
          "Field Lynk command was sent but physical feedback did not match. Check the fence controller.");
      }
    }
    rememberCommandId(pendingVerify.command.id);
    pendingVerify.active = false;
    radio.startReceive();
    return;
  }

  // Retry: send STATUS command every CONTACT_VERIFY_RETRY_MS so field node re-ACKs with current state.
  if (pendingVerify.retries < CONTACT_VERIFY_MAX_RETRIES &&
      elapsedMs >= (unsigned long)(pendingVerify.retries + 1) * CONTACT_VERIFY_RETRY_MS) {
    pendingVerify.retries++;
    Serial.printf("[VERIFY] retry %d\n", pendingVerify.retries);
    // Same command_id → field node dedup logic re-ACKs with current physical state.
    String statusPacket = "CMD|" + NETWORK_KEY + "|" + NODE_ID + "|" +
                          pendingVerify.command.id + "|STATUS";
    radio.transmit(statusPacket);
    radio.startReceive();
  }
}

void pollSupabase() {
  PendingCommand commands[16];
  size_t commandCount = 0;
  if (!fetchPendingCommands(commands, 16, commandCount)) {
    return;
  }

  for (size_t index = 0; index < commandCount; index++) {
    processPendingCommand(commands[index]);
    // Cache device ID so heartbeat updates can reach Supabase without a command.
    if (commands[index].deviceId.length() > 0 && cachedFenceDeviceId.length() == 0) {
      cachedFenceDeviceId = commands[index].deviceId;
    }
  }

  // After processing all pending commands, return radio to passive receive mode
  // so incoming HB packets are captured between poll cycles.
  radio.startReceive();
}

// Processes one incoming LoRa HB packet if receivedFlag is set.
// Updates Supabase device metadata (contactor_feedback + aux_raw) without
// requiring an in-flight command.
void processHeartbeatIfReady() {
  if (!receivedFlag) return;
  receivedFlag = false;

  String packet;
  int state = radio.readData(packet);
  if (state != RADIOLIB_ERR_NONE) {
    radio.startReceive();
    return;
  }
  packet.trim();

  String pType = packetPart(packet, 0);
  if (pType != "HB") {
    // Not a heartbeat — could be a stray ACK. Discard and re-listen.
    radio.startReceive();
    return;
  }

  String hbKey   = packetPart(packet, 1);
  String hbNode  = packetPart(packet, 2);
  // New HB layout:
  // HB|key|node|HB|cmd_state|relay_state|aux_raw|contactor_feedback|confirmed_state|uptime|firmware|wifi
  String hbMarker = packetPart(packet, 3);
  String hbState = packetPart(packet, 4);
  String hbRelay = packetPart(packet, 5);
  String hbAux   = packetPart(packet, 6);
  String hbFb    = packetPart(packet, 7);
  String hbConfirmedState = packetPart(packet, 8);

  // Backward-compatible fallback for older heartbeat layout.
  if (hbMarker != "HB") {
    hbState = packetPart(packet, 3);
    hbRelay = hbState;
    hbFb    = packetPart(packet, 4);
    hbAux   = packetPart(packet, 5);
    hbConfirmedState = (hbAux == "AUX_HIGH") ? "on" : (hbAux == "AUX_LOW" ? "off" : "");
  }

  if (hbKey != NETWORK_KEY || hbNode != NODE_ID) {
    radio.startReceive();
    return;
  }

  Serial.printf("[HB PACKET] state=%s relay=%s aux=%s fb=%s confirmed=%s\n",
    hbState.c_str(), hbRelay.c_str(), hbAux.c_str(), hbFb.c_str(), hbConfirmedState.c_str());

  // Optional fields added in firmware 1.1.0+ — gracefully absent on older nodes.
  String hbFirmwareVersion  = packetPart(packet, hbMarker == "HB" ? 10 : 7);  // e.g. "1.1.0"; empty on old firmware
  bool   hbWifiConnected    = (packetPart(packet, hbMarker == "HB" ? 11 : 8) == "1");

  if (hbFirmwareVersion.length() > 0) {
    Serial.printf("HB firmware: version=%s wifi=%s\n",
      hbFirmwareVersion.c_str(), hbWifiConnected ? "yes" : "no");
  }
  // Show physical contactor feedback on OLED when a fault exists,
  // otherwise show the commanded state (ON/OFF).
  if (hbFb == "FAILED" || hbFb == "STUCK_ON") {
    lastFenceState = hbFb;
  } else {
    lastFenceState = normalizedFenceState(hbState);
  }
  lastHbReceivedAt = millis();
  nodeOfflineAlertSent = false;  // Field node is alive — re-arm offline alert dedup.
  drawScreen();

  // Healthy states clear the power-loss dedup so future faults alert again.
  if (hbFb == "CONFIRMED" || hbFb == "OPEN") {
    powerLossAlertSent = false;
  }

  // Fence commanded ON but contactor did not engage — likely power supply failure.
  if (hbFb == "FAILED" && !powerLossAlertSent && !pendingVerify.active) {
    powerLossAlertSent = true;
    createAndSendAlert(
      "critical",
      "Fence Charger Lost Power",
      "The Field Lynk has detected that the fence charger lost power. Please check the power supply to the fence."
    );
  }

  // Contactor stuck on after OFF command.
  if (hbFb == "STUCK_ON" && !powerLossAlertSent && !pendingVerify.active) {
    powerLossAlertSent = true;
    createAndSendAlert(
      "warning",
      "Fence Contactor Fault",
      "The fence was turned off but the Field Lynk is still detecting voltage on the fence line. Please check the fence controller."
    );
  }

  if (cachedFenceDeviceId.length() > 0) {
    updateDeviceContactorFeedback(cachedFenceDeviceId, hbFb, hbAux,
                                  hbFirmwareVersion, hbWifiConnected);
  } else {
    Serial.println("HB: no cached device ID yet — skipping Supabase update");
  }

  radio.startReceive();
}

// Fetches the Supabase device UUID for the fence controller owned by this
// gateway. Called once at boot so HB fault alerts and metadata updates work
// even before any command has ever been processed.
void fetchFenceDeviceId() {
  String url = buildApiUrl(
    String("devices?gateway_id=eq.") + GATEWAY_ID +
    "&type=eq.fence_controller&select=id&limit=1"
  );

  HTTPClient http;
  http.begin(url);
  http.setTimeout(3000);
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  int statusCode = http.GET();
  String payload = http.getString();
  http.end();

  if (statusCode < 200 || statusCode >= 300) {
    Serial.printf("fetchFenceDeviceId: HTTP %d\n", statusCode);
    return;
  }

  DynamicJsonDocument doc(256);
  if (deserializeJson(doc, payload)) {
    Serial.println("fetchFenceDeviceId: JSON parse error");
    return;
  }

  if (!doc.is<JsonArray>() || doc.as<JsonArray>().size() == 0) {
    Serial.println("fetchFenceDeviceId: no fence_controller found for this gateway_id. Check devices table.");
    return;
  }

  cachedFenceDeviceId = String(doc[0]["id"].as<const char*>());
  Serial.printf("Fence device ID: %s\n", cachedFenceDeviceId.c_str());
}

// ── ArduinoOTA ──────────────────────────────────────────────────────────────────────

void setupOTA() {
  // OTA hostname: argus-gateway-<GATEWAY_ID>  (e.g. argus-gateway-home-base-001)
  String hostname = String("argus-gateway-") + String(GATEWAY_ID);
  ArduinoOTA.setHostname(hostname.c_str());

  ArduinoOTA.onStart([]() {
    otaBusy = true;
    const char* type = (ArduinoOTA.getCommand() == U_FLASH) ? "sketch" : "filesystem";
    Serial.printf("[OTA] Start — type: %s\n", type);
    if (oledOk) {
      display.clearDisplay();
      display.setTextSize(1);
      display.setTextColor(SSD1306_WHITE);
      display.setCursor(0, 0);
      display.println("OTA Start");
      display.println(type);
      display.display();
    }
  });

  ArduinoOTA.onEnd([]() {
    otaBusy = false;
    Serial.println("[OTA] Success — rebooting.");
    if (oledOk) {
      display.clearDisplay();
      display.setCursor(0, 0);
      display.println("OTA Success");
      display.println("Rebooting...");
      display.display();
    }
  });

  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    uint8_t pct = (uint8_t)((progress * 100UL) / total);
    Serial.printf("[OTA] Progress: %u%%\n", pct);
    if (oledOk) {
      display.clearDisplay();
      display.setCursor(0, 0);
      display.println("OTA Progress");
      display.print(pct);
      display.println("%");
      display.display();
    }
  });

  ArduinoOTA.onError([](ota_error_t error) {
    otaBusy = false;
    Serial.printf("[OTA] Error [%u]: ", (unsigned)error);
    if      (error == OTA_AUTH_ERROR)    Serial.println("Auth Failed");
    else if (error == OTA_BEGIN_ERROR)   Serial.println("Begin Failed");
    else if (error == OTA_CONNECT_ERROR) Serial.println("Connect Failed");
    else if (error == OTA_RECEIVE_ERROR) Serial.println("Receive Failed");
    else if (error == OTA_END_ERROR)     Serial.println("End Failed");
    else                                 Serial.println("Unknown");
    if (oledOk) {
      display.clearDisplay();
      display.setCursor(0, 0);
      display.println("OTA Error");
      display.print("Code: ");
      display.println((int)error);
      display.display();
    }
  });

  ArduinoOTA.begin();
  Serial.print("[OTA] Ready. Hostname: ");
  Serial.println(hostname);
  if (oledOk) {
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("OTA Ready");
    // Truncate hostname to fit 21 chars per OLED line at text size 1.
    display.println(hostname.substring(0, 21));
    display.display();
    delay(1000);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("Argus gateway MVP booting...");

  setupOLED();
  drawScreen();
  connectToWifi();
  syncClock();
  setupOTA();            // Must come after WiFi is connected.
  fetchFenceDeviceId();  // Populate cachedFenceDeviceId before first HB arrives.
  drawScreen();
  initializeLoRa();

  Serial.println("Gateway ready. Waiting for next poll cycle.");
  // Start passive receive immediately so HB packets from the field node are
  // captured before the first command poll cycle completes.
  radio.startReceive();
  drawScreen();
}

void loop() {
  ensureWifiConnected();

  // ArduinoOTA must poll every loop iteration to catch incoming OTA connections.
  // It never blocks; the onStart callback sets otaBusy=true for the duration
  // of the flash, which gates all LoRa and Supabase operations below.
  ArduinoOTA.handle();

  if (otaBusy) {
    // Flash write in progress — yield immediately and skip all field operations.
    delay(25);
    return;
  }

  // Drain any incoming HB packets while idle between polls,
  // or run the post-command verification window if one is active.
  if (pendingVerify.active) {
    checkVerificationWindow();
    delay(25);
    return;
  }

  processHeartbeatIfReady();

  // Detect field node going offline (no heartbeat within 2.5× the HB interval).
  // Only triggers after we have received at least one HB (lastHbReceivedAt > 0),
  // so a freshly-booted gateway does not false-alarm before the node checks in.
  if (lastHbReceivedAt > 0 &&
      (millis() - lastHbReceivedAt) > HB_OFFLINE_TIMEOUT_MS &&
      !nodeOfflineAlertSent) {
    nodeOfflineAlertSent = true;
    powerLossAlertSent = true;  // Avoid a second alert when HB resumes with FAILED state.
    Serial.println("Field node heartbeat timeout — marking device offline.");

    // Rate-limit the alert: do not fire again within OFFLINE_ALERT_MIN_INTERVAL_MS
    // even if the node recovers briefly (resets nodeOfflineAlertSent) then drops again.
    unsigned long nowMs = millis();
    bool alertAllowed = (lastOfflineAlertSentAt == 0) ||
                        ((nowMs - lastOfflineAlertSentAt) >= OFFLINE_ALERT_MIN_INTERVAL_MS);
    if (!alertAllowed) {
      Serial.printf("[OFFLINE] Skipping alert — last sent %lu s ago, min interval %lu s.\n",
        (nowMs - lastOfflineAlertSentAt) / 1000UL,
        OFFLINE_ALERT_MIN_INTERVAL_MS / 1000UL);
    }

    // Mark the device offline in Supabase and clear contactor feedback to OPEN
    // so the dashboard reflects that the fence is de-energized (relay defaults
    // to open when the field node loses power).
    if (cachedFenceDeviceId.length() > 0) {
      // IMPORTANT: Do NOT touch last_seen or last_seen_at here.
      // Those columns must only be updated when the device is actually heard from.
      // last_seen freshness is used by the PWA as the sole source of truth for
      // connection state — writing now() here would hide the real silence period.
      String offlineTs = timestampNow();
      Serial.printf("[OFFLINE] Marking device %s offline. online=false status=offline. last_seen NOT changed.\n",
        cachedFenceDeviceId.c_str());

      // Step 1: Fetch existing metadata so we can merge without clobbering fields.
      String fetchUrl = buildApiUrl("devices?id=eq." + cachedFenceDeviceId + "&select=metadata");
      HTTPClient httpMeta;
      httpMeta.begin(fetchUrl);
      httpMeta.setTimeout(3000);
      httpMeta.addHeader("apikey", SUPABASE_ANON_KEY);
      httpMeta.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
      int fetchSt = httpMeta.GET();
      String fetchBody = httpMeta.getString();
      httpMeta.end();

      DynamicJsonDocument mergedMeta(1024);
      if (fetchSt >= 200 && fetchSt < 300) {
        DynamicJsonDocument fetched(1024);
        if (!deserializeJson(fetched, fetchBody) && fetched.is<JsonArray>() && fetched[0]["metadata"].is<JsonObject>()) {
          mergedMeta.set(fetched[0]["metadata"].as<JsonObject>());
        }
      }
      // Set contactor feedback to OPEN so the dashboard shows the fence as OFF.
      // The relay is normally-open, so it de-energises when the field node loses power.
      mergedMeta["contactor_feedback"] = "OPEN";
      // Record the wall-clock time the gateway declared the node offline.
      // This is intentionally separate from last_seen (which remains at the
      // last real received timestamp) and is useful for alert dedup / diagnostics.
      if (offlineTs.length() > 0) {
        mergedMeta["offline_marked_at"] = offlineTs;
      }

      // Step 2: Single PATCH — sets online/status and the merged metadata in one request.
      // last_seen and last_seen_at are deliberately omitted.
      DynamicJsonDocument offlineBody(1024);
      offlineBody["online"]   = false;
      offlineBody["status"]   = "offline";
      offlineBody["metadata"] = mergedMeta;
      String offlinePayload;
      serializeJson(offlineBody, offlinePayload);
      sendJsonPatch(
        buildApiUrl("devices?id=eq." + cachedFenceDeviceId),
        offlinePayload,
        "PATCH device offline (HB timeout)"
      );
    }

    if (alertAllowed) {
      lastOfflineAlertSentAt = millis();
      createAndSendAlert(
        "critical",
        "Field Lynk Offline",
        "The Field Lynk has stopped responding. Please check its power supply and make sure it is within range of the gateway."
      );
    }
  }

  if (millis() - lastPollStartedAt >= POLL_INTERVAL_MS) {
    lastPollStartedAt = millis();
    pollSupabase();
  }

  delay(50);
}