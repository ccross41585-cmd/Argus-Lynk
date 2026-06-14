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
const char* DEVICE_FIRMWARE_VERSION = "1.1.0";
const char* DEVICE_BUILD_DATE       = "2026-06-13";
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
};

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
int lastPollCount = 0;
float lastRssi = NAN;
float lastSnr = NAN;
unsigned long lastScreenUpdate = 0;

struct AckPacket {
  bool isValid;
  String sequence;
  String confirmedState;
  String contactorFeedback;
  String auxRaw;   // AUX_LOW or AUX_HIGH as reported by field node GPIO34
};

// Cached Supabase device ID for the NODE_ID field node.
// Populated the first time a command for that node is processed.
String cachedFenceDeviceId = "";

// Heartbeat fault detection
unsigned long lastHbReceivedAt = 0;      // millis() when last HB was received from field node
bool powerLossAlertSent = false;          // Dedup: cleared when feedback returns to healthy
bool nodeOfflineAlertSent = false;        // Dedup: cleared after recovery + re-arm interval
unsigned long lastOfflineAlertSentAt = 0; // millis() when last offline alert was dispatched

// 5 minutes — matches the PWA ONLINE_TIMEOUT_MS and is generous enough to
// survive transient RF gaps or the gateway being busy with Supabase calls.
const unsigned long HB_OFFLINE_TIMEOUT_MS = 5UL * 60UL * 1000UL;  // 5 min

// Minimum time between consecutive "Field Lynk Offline" alerts.
// Prevents alert storms if the node is flapping (brief drop then HB resets dedup).
const unsigned long OFFLINE_ALERT_MIN_INTERVAL_MS = 30UL * 60UL * 1000UL;  // 30 min

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
  display.println(yesNoText(loraOk));
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
  http.setReuse(false);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  http.addHeader("Prefer", "return=minimal");
  logVerbose("sendJsonPatch headers ready");

  int statusCode = http.PATCH(payload);
  if (DEBUG_VERBOSE) {
    Serial.print("sendJsonPatch PATCH returned: ");
    Serial.println(statusCode);
  }

  String response;
  if (statusCode < 200 || statusCode >= 300) {
    logVerbose("sendJsonPatch reading error response body");
    response = http.getString();
  }

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

bool markCommandSent(const PendingCommand& command) {
  DynamicJsonDocument body(256);
  body["status"] = "sent";
  body["gateway_id"] = GATEWAY_ID;

  String sentAt = timestampNow();
  if (sentAt.length() > 0) {
    body["sent_at"] = sentAt;
  }

  String url = buildApiUrl("device_commands?id=eq." + command.id);
  String payload;
  serializeJson(body, payload);
  return sendJsonPatch(url, payload, "PATCH device_commands sent");
}

bool markCommandAcknowledged(const PendingCommand& command, const String& confirmedState) {
  DynamicJsonDocument body(256);
  body["status"] = "acknowledged";
  body["error_message"] = nullptr;

  String acknowledgedAt = timestampNow();
  if (acknowledgedAt.length() > 0) {
    body["acknowledged_at"] = acknowledgedAt;
  }

  String url = buildApiUrl("device_commands?id=eq." + command.id);
  String payload;
  serializeJson(body, payload);
  if (!sendJsonPatch(url, payload, "PATCH device_commands acknowledged")) {
    return false;
  }

  DynamicJsonDocument deviceBody(512);
  deviceBody["confirmed_state"] = confirmedState;
  deviceBody["online"] = true;
  deviceBody["status"] = "online";

  String lastSeen = timestampNow();
  if (lastSeen.length() > 0) {
    deviceBody["last_seen"]    = lastSeen;
    deviceBody["last_seen_at"] = lastSeen;
  }

  Serial.printf("[ACK] Updating device %s: online=true status=online last_seen=%s\n",
    command.deviceId.c_str(), lastSeen.c_str());

  String deviceUrl = buildApiUrl("devices?id=eq." + command.deviceId);
  String devicePayload;
  serializeJson(deviceBody, devicePayload);
  if (!sendJsonPatch(deviceUrl, devicePayload, "PATCH devices after ACK")) {
    return false;
  }

  Serial.print("Device state updated: ");
  Serial.println(confirmedState);
  drawScreen();
  return true;
}

bool updateDeviceContactorFeedback(const String& deviceId,
                                   const String& contactorFeedback,
                                   const String& auxRaw,
                                   const String& fieldFirmwareVersion = "",
                                   bool fieldWifiConnected = false) {
  if (contactorFeedback.length() == 0 && auxRaw.length() == 0) {
    return true;
  }

  // Fetch existing metadata first so we can merge without clobbering other fields
  String fetchUrl = buildApiUrl("devices?id=eq." + deviceId + "&select=metadata");
  HTTPClient http;
  http.begin(fetchUrl);
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

bool markCommandFailed(const PendingCommand& command, const String& errorMessage) {
  DynamicJsonDocument body(256);
  body["status"] = "failed";
  body["error_message"] = errorMessage;

  String url = buildApiUrl("device_commands?id=eq." + command.id);
  String payload;
  serializeJson(body, payload);
  Serial.print("Command failed: ");
  Serial.println(errorMessage);
  lastErrorText = errorMessage;
  supabaseOk = false;
  drawScreen();
  return sendJsonPatch(url, payload, "PATCH device_commands failed");
}

bool fetchPendingCommands(PendingCommand* commands, size_t maxCommands, size_t& commandCount) {
  commandCount = 0;

  String url = buildApiUrl("device_commands?status=eq.pending&order=created_at.asc&select=id,device_id,gateway_id,command");

  HTTPClient http;
  http.begin(url);
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
  AckPacket ack = {false, "", ""};
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
    if (DEBUG_VERBOSE) {
      Serial.print("ACK packet received: ");
      Serial.println(packet);
    }

    String packetType = packetPart(packet, 0);
    String packetKey = packetPart(packet, 1);
    String packetNode = packetPart(packet, 2);
    String packetSequence = packetPart(packet, 3);
    String packetAction = packetPart(packet, 4);
    String packetContactorFeedback = packetPart(packet, 5);
    String packetAuxRaw            = packetPart(packet, 6);  // AUX_LOW or AUX_HIGH

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

    ack.confirmedState = legacyActionToConfirmedState(packetAction);
    if (ack.confirmedState.length() == 0) {
      logVerbose("ACK ignored because state token is not ON or OFF.");
      radio.startReceive();
      continue;
    }

    ack.isValid = true;
    ack.sequence = packetSequence;
    ack.contactorFeedback = packetContactorFeedback;
    ack.auxRaw = packetAuxRaw;
    loraOk = true;
    lastRssi = radio.getRSSI();
    lastSnr = radio.getSNR();
    return ack;
  }

  radio.standby();
  return ack;
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

  String expectedState = commandToConfirmedState(command.command);
  String legacyAction = commandToLegacyAction(command.command);
  if (expectedState == "unknown" || legacyAction.length() == 0) {
    Serial.printf("Unsupported command '%s'. Marking as failed.\n", command.command.c_str());
    if (markCommandFailed(command, "Unsupported command for gateway MVP")) {
      rememberCommandId(command.id);
    }
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

  AckPacket ack = {false, "", ""};
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
    if (markCommandAcknowledged(command, ack.confirmedState)) {
      updateDeviceContactorFeedback(command.deviceId, ack.contactorFeedback, ack.auxRaw);
      rememberCommandId(command.id);
    }
    Serial.println("Finished command processing, returning to polling");
    return;
  }

  if (markCommandFailed(command, "No valid ACK after retry")) {
    rememberCommandId(command.id);
  }
  Serial.println("Finished command processing, returning to polling");
}

void pollSupabase() {
  PendingCommand commands[8];
  size_t commandCount = 0;
  if (!fetchPendingCommands(commands, 8, commandCount)) {
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
  String hbState = packetPart(packet, 3);
  String hbFb    = packetPart(packet, 4);
  String hbAux   = packetPart(packet, 5);

  if (hbKey != NETWORK_KEY || hbNode != NODE_ID) {
    radio.startReceive();
    return;
  }

  Serial.printf("HB received: state=%s fb=%s aux=%s\n",
    hbState.c_str(), hbFb.c_str(), hbAux.c_str());

  // Optional fields added in firmware 1.1.0+ — gracefully absent on older nodes.
  String hbFirmwareVersion  = packetPart(packet, 7);  // e.g. "1.1.0"; empty on old firmware
  bool   hbWifiConnected    = (packetPart(packet, 8) == "1");

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
  if (hbFb == "FAILED" && !powerLossAlertSent) {
    powerLossAlertSent = true;
    createAndSendAlert(
      "critical",
      "Fence Charger Lost Power",
      "The Field Lynk has detected that the fence charger lost power. Please check the power supply to the fence."
    );
  }

  // Contactor stuck on after OFF command.
  if (hbFb == "STUCK_ON" && !powerLossAlertSent) {
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

  // Drain any incoming HB packets while idle between polls.
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