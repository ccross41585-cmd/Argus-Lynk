#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Preferences.h>
#include <Update.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <math.h>
#include <esp_sleep.h>
#include <esp_bt.h>

// ── Developer overrides ──────────────────────────────────────────────────────
// Set FORCE_PROVISIONING_MODE true to always start the provisioning AP,
// even if valid config is already saved in NVS (useful for UI development).
const bool FORCE_PROVISIONING_MODE = false;

// DEV_FALLBACK_CONFIG is only used when there is no NVS config AND this is true.
// Set false for production/shipping firmware so blank devices auto-provision.
const bool DEV_FALLBACK_CONFIG = false;
const char* DEV_DEVICE_KEY      = "FL-6A4F9B";
const char* DEV_WIFI_SSID       = "Superstar727";
const char* DEV_WIFI_PASSWORD   = "Cadevaliava-01";
const char* DEV_TELEMETRY_URL   = "https://zmdijnkvymiuuwiwtmhd.supabase.co/functions/v1/freezer-telemetry";
const char* DEV_MANIFEST_URL    = "https://zmdijnkvymiuuwiwtmhd.supabase.co/functions/v1/freezer-firmware-manifest";
const char* DEV_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InptZGlqbmt2eW1pdXV3aXd0bWhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMTQxNDQsImV4cCI6MjA5NTU5MDE0NH0.Jkh5vgKyTDjT8A3Y2irXqrGVSe670Qi4UcHJSC6FcP0";
const char* DEV_TELEMETRY_TOKEN = "";
const char* DEV_UPDATE_CHANNEL  = "stable";

const char* FIRMWARE_VERSION = "0.2.0";
const char* DEVICE_MODEL = "freezer_lynk_wifi_mvp";

const int DS18B20_PIN = 4;
const int SENSOR_POWER_PIN = -1;
const int BATTERY_ADC_PIN = -1;
const int SETUP_BUTTON_PIN = 0;

const bool DEBUG_MODE = false;
const unsigned long DEBUG_INTERVAL_SECONDS = 10UL;
const unsigned long PRODUCTION_INTERVAL_SECONDS = 300UL;
const unsigned long ALARM_INTERVAL_SECONDS = 60UL;
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000UL;
const uint16_t HTTP_TIMEOUT_MS = 12000;
const unsigned long PROVISIONING_TIMEOUT_MS = 0UL; // 0 = never timeout (loop forever until provisioned)
const unsigned long MANIFEST_CHECK_INTERVAL_BOOT_CYCLES = 24;
// Hold setup button this long at power-on to trigger factory reset
const unsigned long FACTORY_RESET_HOLD_MS = 3000UL;

const int LED_R_PIN = 25;
const int LED_G_PIN = 26;
const int LED_B_PIN = 27;

const float LOCAL_WARNING_HIGH_F = 5.0f;
const float LOCAL_ALARM_HIGH_F = 10.0f;

RTC_DATA_ATTR uint32_t bootCount = 0;
RTC_DATA_ATTR uint32_t consecutiveTelemetryFailures = 0;
RTC_DATA_ATTR uint32_t lastManifestCheckBoot = 0;

struct DeviceConfig {
  String deviceKey;
  String wifiSsid;
  String wifiPassword;
  String telemetryUrl;
  String telemetryToken;
  String supabaseAnonKey;
  String firmwareManifestUrl;
  String updateChannel;
};

OneWire oneWire(DS18B20_PIN);
DallasTemperature tempBus(&oneWire);
Preferences preferences;
WebServer provisioningServer(80);
DeviceConfig config;

int lastLedR = -1;
int lastLedG = -1;
int lastLedB = -1;
bool provisionedDuringSession = false;

void logAlways(const char* section, const String& message) {
  Serial.printf("[%lu] [%s] %s\n", millis(), section, message.c_str());
}

void logStep(const char* section, const String& message) {
  if (!DEBUG_MODE) return;
  logAlways(section, message);
}

String escapeJson(const String& input) {
  String out;
  out.reserve(input.length() + 8);
  for (size_t i = 0; i < input.length(); i++) {
    const char c = input.charAt(i);
    if (c == '\\' || c == '"') out += '\\';
    out += c;
  }
  return out;
}

String formatMacAddress() {
  const uint64_t mac = ESP.getEfuseMac();
  char out[18];
  snprintf(
    out,
    sizeof(out),
    "%02X:%02X:%02X:%02X:%02X:%02X",
    static_cast<uint8_t>(mac >> 40),
    static_cast<uint8_t>(mac >> 32),
    static_cast<uint8_t>(mac >> 24),
    static_cast<uint8_t>(mac >> 16),
    static_cast<uint8_t>(mac >> 8),
    static_cast<uint8_t>(mac)
  );
  return String(out);
}

String shortChipId() {
  const uint64_t mac = ESP.getEfuseMac();
  char out[7];
  snprintf(out, sizeof(out), "%06X", static_cast<uint32_t>(mac & 0xFFFFFF));
  return String(out);
}

const char* wakeReasonToString(esp_sleep_wakeup_cause_t cause) {
  switch (cause) {
    case ESP_SLEEP_WAKEUP_TIMER: return "timer";
    case ESP_SLEEP_WAKEUP_EXT0: return "ext0";
    case ESP_SLEEP_WAKEUP_EXT1: return "ext1";
    case ESP_SLEEP_WAKEUP_TOUCHPAD: return "touchpad";
    case ESP_SLEEP_WAKEUP_ULP: return "ulp";
    case ESP_SLEEP_WAKEUP_UNDEFINED:
    default:
      return "cold_boot_or_reset";
  }
}

bool sensorPowerEnabled() {
  return SENSOR_POWER_PIN >= 0;
}

void sensorPowerOn() {
  if (!sensorPowerEnabled()) return;
  digitalWrite(SENSOR_POWER_PIN, HIGH);
  delay(750);
}

void sensorPowerOff() {
  if (!sensorPowerEnabled()) return;
  digitalWrite(SENSOR_POWER_PIN, LOW);
}

bool hasRgbLed() {
  return LED_R_PIN >= 0 && LED_G_PIN >= 0 && LED_B_PIN >= 0;
}

void ledOff() {
  if (!hasRgbLed()) return;
  digitalWrite(LED_R_PIN, LOW);
  digitalWrite(LED_G_PIN, LOW);
  digitalWrite(LED_B_PIN, LOW);
}

void ledSet(bool r, bool g, bool b) {
  if (!hasRgbLed()) return;
  const int nextR = r ? HIGH : LOW;
  const int nextG = g ? HIGH : LOW;
  const int nextB = b ? HIGH : LOW;

  if (nextR != lastLedR || nextG != lastLedG || nextB != lastLedB) {
    lastLedR = nextR;
    lastLedG = nextG;
    lastLedB = nextB;
  }

  digitalWrite(LED_R_PIN, nextR);
  digitalWrite(LED_G_PIN, nextG);
  digitalWrite(LED_B_PIN, nextB);
}

void blinkColor(bool r, bool g, bool b, int times, int onMs, int offMs) {
  if (!hasRgbLed()) return;
  for (int i = 0; i < times; i++) {
    ledSet(r, g, b);
    delay(onMs);
    ledOff();
    delay(offMs);
  }
}

void wifiShutdown() {
  provisioningServer.stop();
  if (WiFi.getMode() != WIFI_OFF) {
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
  }
}

bool loadConfigFromPreferences(DeviceConfig& out) {
  preferences.begin("freezer", true);
  out.deviceKey = preferences.getString("device_key", "");
  out.wifiSsid = preferences.getString("wifi_ssid", "");
  out.wifiPassword = preferences.getString("wifi_pass", "");
  out.telemetryUrl = preferences.getString("telemetry_url", "");
  out.telemetryToken = preferences.getString("telemetry_tok", "");
  out.supabaseAnonKey = preferences.getString("anon_key", "");
  out.firmwareManifestUrl = preferences.getString("manifest_url", "");
  out.updateChannel = preferences.getString("update_channel", "stable");
  preferences.end();

  // Config is valid only if all required fields are present
  return out.deviceKey.length() > 0
      && out.wifiSsid.length() > 0
      && out.wifiPassword.length() > 0
      && out.telemetryUrl.length() > 0;
}

void saveConfigToPreferences(const DeviceConfig& in) {
  preferences.begin("freezer", false);
  preferences.putString("device_key", in.deviceKey);
  preferences.putString("wifi_ssid", in.wifiSsid);
  preferences.putString("wifi_pass", in.wifiPassword);
  preferences.putString("telemetry_url", in.telemetryUrl);
  preferences.putString("telemetry_tok", in.telemetryToken);
  preferences.putString("anon_key", in.supabaseAnonKey);
  preferences.putString("manifest_url", in.firmwareManifestUrl);
  preferences.putString("update_channel", in.updateChannel.length() ? in.updateChannel : "stable");
  preferences.end();
}

void clearStoredConfig() {
  preferences.begin("freezer", false);
  preferences.clear();
  preferences.end();
}

void applyDevFallback(DeviceConfig& out) {
  out.deviceKey         = DEV_DEVICE_KEY;
  out.wifiSsid          = DEV_WIFI_SSID;
  out.wifiPassword      = DEV_WIFI_PASSWORD;
  out.telemetryUrl      = DEV_TELEMETRY_URL;
  out.telemetryToken    = DEV_TELEMETRY_TOKEN;
  out.supabaseAnonKey   = DEV_SUPABASE_ANON_KEY;
  out.firmwareManifestUrl = DEV_MANIFEST_URL;
  out.updateChannel     = DEV_UPDATE_CHANNEL;
}

bool isConfigValid(const DeviceConfig& cfg) {
  return cfg.deviceKey.length() > 0
      && cfg.wifiSsid.length() > 0
      && cfg.wifiPassword.length() > 0
      && cfg.telemetryUrl.length() > 0;
}

// Loads config from NVS. Falls back to dev constants only when DEV_FALLBACK_CONFIG=true.
// Returns true if a valid (usable) config is now loaded.
bool loadRuntimeConfig() {
  if (loadConfigFromPreferences(config)) {
    return true;
  }
  if (DEV_FALLBACK_CONFIG) {
    logAlways("CFG", "No NVS config - using DEV fallback");
    applyDevFallback(config);
    return isConfigValid(config);
  }
  return false;
}

bool buttonPressed() {
  return digitalRead(SETUP_BUTTON_PIN) == LOW;
}

// Called once immediately on wake-up.
// If button is held for FACTORY_RESET_HOLD_MS seconds, wipe NVS and reboot.
// On reboot the device will see no config and auto-enter provisioning mode.
//
// Customer flow:
//   1. Hold setup button
//   2. Power device on (or plug in USB)
//   3. Keep holding 3 seconds → factory reset
void checkFactoryResetAtBoot() {
  if (!buttonPressed()) return;

  logAlways("BTN", String("Setup button held at boot - hold ") + (FACTORY_RESET_HOLD_MS / 1000UL) + "s for factory reset...");
  const unsigned long holdStart = millis();

  while (buttonPressed()) {
    const unsigned long held = millis() - holdStart;
    if (held >= FACTORY_RESET_HOLD_MS) {
      logAlways("BTN", "Factory reset! Clearing NVS config and rebooting.");
      blinkColor(true, false, false, 5, 150, 80);
      clearStoredConfig();
      delay(300);
      ESP.restart();
    }
    // Blue blink as visual feedback while holding
    blinkColor(false, false, true, 1, 30, 30);
    delay(20);
  }

  const float heldSec = (millis() - holdStart) / 1000.0f;
  logAlways("BTN", String("Button released after ") + String(heldSec, 1) + "s - continuing normal boot.");
}

float readBatteryVoltage() {
  if (BATTERY_ADC_PIN < 0) return NAN;

  const int raw = analogRead(BATTERY_ADC_PIN);
  const float adcVoltage = (static_cast<float>(raw) / 4095.0f) * 3.3f;
  const float estimatedBatteryVoltage = adcVoltage * 2.0f;
  return estimatedBatteryVoltage;
}

bool wifiEnsureConnected() {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFi.mode(WIFI_STA);
  WiFi.begin(config.wifiSsid.c_str(), config.wifiPassword.c_str());

  const unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < WIFI_CONNECT_TIMEOUT_MS) {
    delay(30);
    blinkColor(false, false, true, 1, 15, 15);
  }

  if (WiFi.status() == WL_CONNECTED) {
    logAlways("WIFI", String("Connected, IP: ") + WiFi.localIP().toString());
    return true;
  }

  logAlways("WIFI", String("WiFi connect timeout, status=") + WiFi.status());
  wifiShutdown();
  return false;
}

bool isInvalidDs18b20C(float c) {
  if (c == -127.0f || c == 85.0f) return true;
  if (c < -80.0f || c > 80.0f) return true;
  return false;
}

bool isUsableSecret(const String& value) {
  return value.length() > 0 && value.indexOf("placeholder") < 0;
}

float cToF(float c) {
  return (c * 9.0f / 5.0f) + 32.0f;
}

bool readTemperature(float& outC, float& outF) {
  sensorPowerOn();
  
  // Debug: Check GPIO 4 state
  int gpio4State = digitalRead(DS18B20_PIN);
  logAlways("SENSOR", String("GPIO 4 state: ") + (gpio4State ? "HIGH" : "LOW"));
  
  tempBus.begin();
  int deviceCount = tempBus.getDeviceCount();
  logAlways("SENSOR", String("OneWire devices found: ") + deviceCount);

  if (deviceCount == 0) {
    logAlways("SENSOR", "ERROR: No DS18B20 detected on GPIO 4");
    logAlways("SENSOR", "Check: (1) 4.7kΩ pullup resistor on DQ to 3.3V, (2) Power/GND connections, (3) Wiring to GPIO 4");
    sensorPowerOff();
    // Mock data for testing without hardware
    outC = 3.6f;
    outF = 38.5f;
    return true;
  }

  tempBus.requestTemperatures();
  const float tempC = tempBus.getTempCByIndex(0);
  const float tempF = cToF(tempC);

  if (isnan(tempC) || isnan(tempF) || tempC == DEVICE_DISCONNECTED_C || isInvalidDs18b20C(tempC)) {
    logAlways("SENSOR", "Invalid DS18B20 reading - using mock temp 38.5F");
    sensorPowerOff();
    // Mock data for testing
    outC = 3.6f;
    outF = 38.5f;
    return true;
  }

  outC = tempC;
  outF = tempF;
  sensorPowerOff();
  logAlways("SENSOR", String("Temp: ") + String(tempF, 1) + "F");
  return true;
}

String jsonExtractString(const String& json, const char* key) {
  String needle = String("\"") + key + "\"";
  const int keyIndex = json.indexOf(needle);
  if (keyIndex < 0) return "";
  const int colonIndex = json.indexOf(':', keyIndex + needle.length());
  if (colonIndex < 0) return "";

  int quoteStart = json.indexOf('"', colonIndex + 1);
  if (quoteStart < 0) return "";
  int quoteEnd = quoteStart + 1;
  while (quoteEnd < static_cast<int>(json.length())) {
    if (json.charAt(quoteEnd) == '"' && json.charAt(quoteEnd - 1) != '\\') break;
    quoteEnd++;
  }
  if (quoteEnd >= static_cast<int>(json.length())) return "";
  return json.substring(quoteStart + 1, quoteEnd);
}

bool jsonExtractBool(const String& json, const char* key, bool fallback) {
  String needle = String("\"") + key + "\"";
  const int keyIndex = json.indexOf(needle);
  if (keyIndex < 0) return fallback;
  const int colonIndex = json.indexOf(':', keyIndex + needle.length());
  if (colonIndex < 0) return fallback;

  int start = colonIndex + 1;
  while (start < static_cast<int>(json.length()) && (json.charAt(start) == ' ' || json.charAt(start) == '\n')) {
    start++;
  }
  if (json.startsWith("true", start)) return true;
  if (json.startsWith("false", start)) return false;
  return fallback;
}

int jsonExtractInt(const String& json, const char* key, int fallback) {
  String needle = String("\"") + key + "\"";
  const int keyIndex = json.indexOf(needle);
  if (keyIndex < 0) return fallback;
  const int colonIndex = json.indexOf(':', keyIndex + needle.length());
  if (colonIndex < 0) return fallback;

  int start = colonIndex + 1;
  while (start < static_cast<int>(json.length()) && (json.charAt(start) == ' ' || json.charAt(start) == '\n')) {
    start++;
  }

  int end = start;
  while (end < static_cast<int>(json.length()) && (isDigit(json.charAt(end)) || json.charAt(end) == '-')) {
    end++;
  }

  if (end <= start) return fallback;
  return json.substring(start, end).toInt();
}

bool postTelemetry(float tempF, float tempC, float batteryVoltage) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(config.telemetryUrl);
  http.addHeader("Content-Type", "application/json");

  if (isUsableSecret(config.telemetryToken)) {
    http.addHeader("Authorization", String("Bearer ") + config.telemetryToken);
  } else if (isUsableSecret(config.supabaseAnonKey)) {
    http.addHeader("Authorization", String("Bearer ") + config.supabaseAnonKey);
    http.addHeader("apikey", config.supabaseAnonKey);
  } else {
    logAlways("HTTP", "No valid auth secret configured (set telemetry token or anon key)");
  }

  String payload = "{";
  payload += "\"device_key\":\"" + escapeJson(config.deviceKey) + "\",";
  payload += "\"temperature_f\":" + String(tempF, 3) + ",";
  payload += "\"temperature_c\":" + String(tempC, 3) + ",";
  payload += "\"battery_voltage\":" + (isnan(batteryVoltage) ? String("null") : String(batteryVoltage, 3)) + ",";
  payload += "\"battery_percent\":null,";
  payload += "\"firmware_version\":\"" + String(FIRMWARE_VERSION) + "\"";
  payload += "}";

  const int code = http.POST(payload);
  const bool ok = code >= 200 && code < 300;
  if (!ok) {
    logAlways("HTTP", String("Telemetry POST failed, code=") + code + ", body=" + http.getString());
  }
  http.end();
  return ok;
}

bool shouldCheckManifest() {
  if (config.firmwareManifestUrl.length() == 0) return false;
  if (DEBUG_MODE) return true;
  if (bootCount <= 1) return true;
  return (bootCount - lastManifestCheckBoot) >= MANIFEST_CHECK_INTERVAL_BOOT_CYCLES;
}

bool performOtaFromUrl(const String& firmwareUrl) {
  if (firmwareUrl.length() == 0) return false;

  HTTPClient http;
  WiFiClientSecure secureClient;

  http.setTimeout(45000);
  bool beginOk = false;
  if (firmwareUrl.startsWith("https://")) {
    secureClient.setInsecure();
    beginOk = http.begin(secureClient, firmwareUrl);
  } else {
    beginOk = http.begin(firmwareUrl);
  }

  if (!beginOk) {
    logAlways("OTA", "Failed to initialize firmware download");
    return false;
  }

  const int code = http.GET();
  if (code != HTTP_CODE_OK) {
    logAlways("OTA", String("Firmware download failed, code=") + code);
    http.end();
    return false;
  }

  const int contentLength = http.getSize();
  if (contentLength <= 0) {
    logAlways("OTA", "Invalid firmware content length");
    http.end();
    return false;
  }

  if (!Update.begin(contentLength)) {
    logAlways("OTA", "Update.begin failed");
    http.end();
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();
  const size_t written = Update.writeStream(*stream);
  if (written != static_cast<size_t>(contentLength)) {
    logAlways("OTA", String("Incomplete write: ") + written + "/" + contentLength);
  }

  const bool finished = Update.end();
  const bool success = finished && Update.isFinished();
  if (!success) {
    logAlways("OTA", String("OTA failed: ") + Update.errorString());
  }

  http.end();
  return success;
}

void checkAndApplyOta(float latestTempF, bool inAlarmState) {
  if (!shouldCheckManifest()) return;

  lastManifestCheckBoot = bootCount;

  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(config.firmwareManifestUrl);
  http.addHeader("Content-Type", "application/json");

  if (isUsableSecret(config.telemetryToken)) {
    http.addHeader("Authorization", String("Bearer ") + config.telemetryToken);
  } else if (isUsableSecret(config.supabaseAnonKey)) {
    http.addHeader("Authorization", String("Bearer ") + config.supabaseAnonKey);
    http.addHeader("apikey", config.supabaseAnonKey);
  } else {
    logAlways("OTA", "No valid auth secret configured for manifest request");
  }

  String requestBody = "{";
  requestBody += "\"device_key\":\"" + escapeJson(config.deviceKey) + "\",";
  requestBody += "\"current_version\":\"" + String(FIRMWARE_VERSION) + "\",";
  requestBody += "\"channel\":\"" + escapeJson(config.updateChannel.length() ? config.updateChannel : "stable") + "\",";
  requestBody += "\"model\":\"" + String(DEVICE_MODEL) + "\"";
  requestBody += "}";

  const int code = http.POST(requestBody);
  const String responseBody = http.getString();
  http.end();

  if (code < 200 || code >= 300) {
    logAlways("OTA", String("Manifest request failed, code=") + code);
    return;
  }

  const bool shouldUpdate = jsonExtractBool(responseBody, "update", false);
  if (!shouldUpdate) {
    logStep("OTA", "No update available");
    return;
  }

  const bool force = jsonExtractBool(responseBody, "force", false);
  const int minBatteryPercent = jsonExtractInt(responseBody, "min_battery_percent", 20);
  const String latestVersion = jsonExtractString(responseBody, "latest_version");
  const String firmwareUrl = jsonExtractString(responseBody, "firmware_url");

  if (!force) {
    if (inAlarmState || latestTempF > LOCAL_ALARM_HIGH_F) {
      logAlways("OTA", "Skipping update while in alarm state");
      return;
    }

    if (!isnan(readBatteryVoltage())) {
      const int estimatedPercent = 100;
      if (estimatedPercent < minBatteryPercent) {
        logAlways("OTA", "Skipping update due to low battery");
        return;
      }
    }
  }

  logAlways("OTA", String("Applying update ") + latestVersion + " from " + firmwareUrl);
  if (performOtaFromUrl(firmwareUrl)) {
    logAlways("OTA", "Update complete. Restarting.");
    delay(200);
    ESP.restart();
  } else {
    logAlways("OTA", "Update attempt failed");
  }
}

unsigned long selectSleepIntervalSeconds(bool sensorOk, bool telemetryOk, float tempF) {
  if (DEBUG_MODE) return DEBUG_INTERVAL_SECONDS;
  if (!sensorOk || !telemetryOk) return ALARM_INTERVAL_SECONDS;
  if (tempF > LOCAL_WARNING_HIGH_F) return ALARM_INTERVAL_SECONDS;
  return PRODUCTION_INTERVAL_SECONDS;
}

void enterDeepSleep(unsigned long intervalSeconds, const String& reason) {
  ledOff();
  sensorPowerOff();
  wifiShutdown();

#if defined(CONFIG_BT_ENABLED)
  btStop();
#endif

  esp_sleep_enable_timer_wakeup(intervalSeconds * 1000000ULL);
  logAlways("SLEEP", String("Sleeping for ") + intervalSeconds + " second(s) - " + reason);
  Serial.flush();
  delay(20);
  esp_deep_sleep_start();
}

void handleProvisioningCors() {
  provisioningServer.sendHeader("Access-Control-Allow-Origin", "*");
  provisioningServer.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  provisioningServer.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  provisioningServer.send(204);
}

void handleProvisioningStatus() {
  // Refresh config snapshot for status response
  DeviceConfig snap;
  loadConfigFromPreferences(snap);

  String body = "{";
  body += "\"ok\":true,";
  body += "\"device_model\":\"" + String(DEVICE_MODEL) + "\",";
  body += "\"firmware_version\":\"" + String(FIRMWARE_VERSION) + "\",";
  body += "\"mac\":\"" + formatMacAddress() + "\",";
  body += "\"chip_id\":\"" + shortChipId() + "\",";
  body += "\"configured\":" + String(isConfigValid(snap) ? "true" : "false") + ",";
  body += "\"device_key\":\"" + escapeJson(snap.deviceKey) + "\"";
  body += "}";

  provisioningServer.sendHeader("Access-Control-Allow-Origin", "*");
  provisioningServer.send(200, "application/json", body);
}

bool parseConfigureField(const String& body, const String& key, String& outValue) {
  const String quotedKey = "\"" + key + "\"";
  int k = body.indexOf(quotedKey);
  if (k < 0) return false;
  int colon = body.indexOf(':', k + quotedKey.length());
  if (colon < 0) return false;
  int q1 = body.indexOf('"', colon + 1);
  if (q1 < 0) return false;
  int q2 = body.indexOf('"', q1 + 1);
  if (q2 < 0) return false;
  outValue = body.substring(q1 + 1, q2);
  return true;
}

void handleProvisioningConfigure() {
  String raw = provisioningServer.arg("plain");
  if (raw.length() == 0) {
    provisioningServer.send(400, "application/json", "{\"ok\":false,\"error\":\"Missing JSON body\"}");
    return;
  }

  DeviceConfig incoming = config;
  parseConfigureField(raw, "device_key", incoming.deviceKey);
  parseConfigureField(raw, "wifi_ssid", incoming.wifiSsid);
  parseConfigureField(raw, "wifi_password", incoming.wifiPassword);
  parseConfigureField(raw, "telemetry_url", incoming.telemetryUrl);
  parseConfigureField(raw, "telemetry_token", incoming.telemetryToken);
  parseConfigureField(raw, "supabase_anon_key", incoming.supabaseAnonKey);
  parseConfigureField(raw, "firmware_manifest_url", incoming.firmwareManifestUrl);
  parseConfigureField(raw, "update_channel", incoming.updateChannel);

  if (incoming.deviceKey.length() == 0 || incoming.wifiSsid.length() == 0 || incoming.telemetryUrl.length() == 0) {
    provisioningServer.send(400, "application/json", "{\"ok\":false,\"error\":\"device_key, wifi_ssid, telemetry_url required\"}");
    return;
  }

  saveConfigToPreferences(incoming);
  config = incoming;
  provisionedDuringSession = true;

  provisioningServer.sendHeader("Access-Control-Allow-Origin", "*");
  provisioningServer.send(200, "application/json", "{\"ok\":true,\"message\":\"Saved. Device will restart.\"}");
}

void handleProvisioningReset() {
  clearStoredConfig();
  provisioningServer.sendHeader("Access-Control-Allow-Origin", "*");
  provisioningServer.send(200, "application/json", "{\"ok\":true,\"message\":\"Factory reset complete\"}");
  delay(150);
  ESP.restart();
}

void runProvisioningPortal() {
  WiFi.mode(WIFI_AP);
  const String ssid = String("FreezerLynk-") + shortChipId();
  WiFi.softAP(ssid.c_str(), "argussetup");

  const String setupUrl = "http://192.168.4.1/configure";
  logAlways("PROVISION", "No valid config found. Starting provisioning mode.");
  logAlways("PROVISION", String("AP SSID: ") + ssid);
  logAlways("PROVISION", String("AP Password: argussetup"));
  logAlways("PROVISION", String("Setup URL: ") + setupUrl);
  logAlways("PROVISION", "Connect to the AP then POST config JSON to the setup URL.");

  provisioningServer.on("/status",    HTTP_GET,     handleProvisioningStatus);
  provisioningServer.on("/configure", HTTP_POST,    handleProvisioningConfigure);
  provisioningServer.on("/reset",     HTTP_POST,    handleProvisioningReset);
  provisioningServer.on("/status",    HTTP_OPTIONS, handleProvisioningCors);
  provisioningServer.on("/configure", HTTP_OPTIONS, handleProvisioningCors);
  provisioningServer.on("/reset",     HTTP_OPTIONS, handleProvisioningCors);
  provisioningServer.begin();

  // Loop forever - no timeout, no deep sleep while waiting for provisioning.
  // Device will restart automatically once config is saved via /configure.
  while (true) {
    provisioningServer.handleClient();
    blinkColor(false, false, true, 1, 35, 50);
    if (provisionedDuringSession) {
      logAlways("PROVISION", "Configuration saved. Restarting device.");
      delay(250);
      ESP.restart();
    }
    delay(20);
  }
}

void printConfigSummary(bool configValid) {
  Serial.println("Config status:");
  Serial.println(configValid ? "VALID" : "INVALID");
  Serial.printf("Device Key: %s\n", config.deviceKey.length() ? config.deviceKey.c_str() : "(not set)");
  Serial.printf("SSID: %s\n",       config.wifiSsid.length()  ? config.wifiSsid.c_str()  : "(not set)");
  Serial.printf("AP Name: FreezerLynk-%s\n", shortChipId().c_str());
  if (!configValid) {
    Serial.printf("Telemetry URL: %s\n", config.telemetryUrl.length() ? config.telemetryUrl.c_str() : "(not set)");
  }
}

void printBootChecklist() {
  logAlways("BOOT", "Starting Freezer Lynk WiFi");
  logAlways("BOOT", String("Boot Count: ") + bootCount + ", Wake Reason: " + wakeReasonToString(esp_sleep_get_wakeup_cause()));
  logAlways("BOOT", String("Firmware Version: ") + FIRMWARE_VERSION);
  logAlways("BOOT", String("Model: ") + DEVICE_MODEL);
  logAlways("BOOT", String("Device Key: ") + config.deviceKey);
  logAlways("BOOT", String("WiFi SSID: ") + config.wifiSsid);
  logAlways("BOOT", String("Telemetry URL: ") + config.telemetryUrl);
  logAlways("BOOT", String("Manifest URL: ") + config.firmwareManifestUrl);
  logAlways("BOOT", String("Update Channel: ") + config.updateChannel);
  logAlways("BOOT", String("ESP32 MAC: ") + formatMacAddress());
  logAlways("BOOT", String("Consecutive Telemetry Failures: ") + consecutiveTelemetryFailures);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  bootCount++;

  // Button is only used for runtime factory reset - no boot-time GPIO0 hold.
  pinMode(SETUP_BUTTON_PIN, INPUT_PULLUP);

  // ── Factory reset check ──────────────────────────────────────────────────
  // If setup button is held for 3s at power-on, clear NVS and reboot.
  // Device then auto-enters provisioning mode (no config in NVS).
  checkFactoryResetAtBoot();

  if (hasRgbLed()) {
    pinMode(LED_R_PIN, OUTPUT);
    pinMode(LED_G_PIN, OUTPUT);
    pinMode(LED_B_PIN, OUTPUT);
    ledOff();
  }

  if (sensorPowerEnabled()) {
    pinMode(SENSOR_POWER_PIN, OUTPUT);
    digitalWrite(SENSOR_POWER_PIN, LOW);
  }

  if (BATTERY_ADC_PIN >= 0) {
    analogReadResolution(12);
  }

  logAlways("BOOT", String("Freezer Lynk ") + FIRMWARE_VERSION + " | MAC: " + formatMacAddress());
  logAlways("BOOT", String("Boot #") + bootCount + " | Wake: " + wakeReasonToString(esp_sleep_get_wakeup_cause()));

  // Load config - if invalid, auto-enter provisioning (no button required).
  const bool configValid = loadRuntimeConfig();
  printConfigSummary(configValid);

  if (FORCE_PROVISIONING_MODE) {
    logAlways("BOOT", "FORCE_PROVISIONING_MODE=true, starting provisioning AP.");
    runProvisioningPortal(); // never returns
  }

  if (!configValid) {
    logAlways("BOOT", "No valid config found. Starting provisioning mode automatically.");
    runProvisioningPortal(); // never returns
  }

  printBootChecklist();
  logAlways("BOOT", "Setup complete");
}

void loop() {
  logAlways("CYCLE", "Starting telemetry cycle");

  float tempC = 0.0f;
  float tempF = 0.0f;
  const float batteryVoltage = readBatteryVoltage();

  if (!readTemperature(tempC, tempF)) {
    consecutiveTelemetryFailures++;
    blinkColor(true, false, false, 1, 45, 20);
    enterDeepSleep(selectSleepIntervalSeconds(false, false, 0.0f), "sensor read failed");
  }

  if (!wifiEnsureConnected()) {
    consecutiveTelemetryFailures++;
    blinkColor(false, false, true, 1, 45, 20);
    enterDeepSleep(selectSleepIntervalSeconds(true, false, tempF), "wifi connect failed");
  }

  checkAndApplyOta(tempF, tempF > LOCAL_ALARM_HIGH_F);

  const bool sent = postTelemetry(tempF, tempC, batteryVoltage);
  wifiShutdown();

  if (sent) {
    consecutiveTelemetryFailures = 0;
    blinkColor(false, true, false, 1, 40, 20);
  } else {
    consecutiveTelemetryFailures++;
    blinkColor(true, false, false, 1, 45, 20);
  }

  if (tempF > LOCAL_ALARM_HIGH_F) {
    blinkColor(true, false, false, 1, 45, 20);
  }

  const unsigned long nextSleepSeconds = selectSleepIntervalSeconds(true, sent, tempF);
  const String sleepReason = !sent
    ? "telemetry failed"
    : tempF > LOCAL_WARNING_HIGH_F
      ? "temperature above warning threshold"
      : "normal temperature";

  enterDeepSleep(nextSleepSeconds, sleepReason);
}
