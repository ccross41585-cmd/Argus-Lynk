#include <WiFi.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <math.h>
#include <esp_sleep.h>
#include <esp_bt.h>

// ── Device identity / endpoint ───────────────────────────────────────────────
const char* DEVICE_KEY = "FL-6A4F9B";
const char* FIRMWARE_VERSION = "0.1.0";
const char* WIFI_SSID = "Superstar727";
const char* WIFI_PASSWORD = "Cadevaliava-01";
const char* TELEMETRY_URL = "https://zmdijnkvymiuuwiwtmhd.supabase.co/functions/v1/freezer-telemetry";
const char* SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InptZGlqbmt2eW1pdXV3aXd0bWhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMTQxNDQsImV4cCI6MjA5NTU5MDE0NH0.Jkh5vgKyTDjT8A3Y2irXqrGVSe670Qi4UcHJSC6FcP0";      // Optional fallback auth. If set, sends Authorization + apikey.
const char* TELEMETRY_BEARER_TOKEN = ""; // Optional device token; leave blank for device_key-only auth.

// ── Sensor / timing ──────────────────────────────────────────────────────────
const int DS18B20_PIN = 4;                 // Configurable data GPIO
const int SENSOR_POWER_PIN = -1;           // Set >= 0 if DS18B20 power is switched by a GPIO.
const int BATTERY_ADC_PIN = -1;            // Optional battery monitor ADC pin.
const bool DEBUG_MODE = false;
const unsigned long DEBUG_INTERVAL_SECONDS = 10UL;
const unsigned long PRODUCTION_INTERVAL_SECONDS = 300UL;
const unsigned long ALARM_INTERVAL_SECONDS = 60UL;
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000UL;
const unsigned long WIFI_DOT_INTERVAL_MS = 250UL;
const uint16_t HTTP_TIMEOUT_MS = 10000;

// ── LED pins (set -1 if not connected) ───────────────────────────────────────
const int LED_R_PIN = 25;
const int LED_G_PIN = 26;
const int LED_B_PIN = 27;

// On-device indicator thresholds used for adaptive sleep decisions.
const float LOCAL_WARNING_HIGH_F = 5.0f;
const float LOCAL_ALARM_HIGH_F = 10.0f;

RTC_DATA_ATTR uint32_t bootCount = 0;
RTC_DATA_ATTR uint32_t consecutiveTelemetryFailures = 0;

OneWire oneWire(DS18B20_PIN);
DallasTemperature tempBus(&oneWire);
int lastLedR = -1;
int lastLedG = -1;
int lastLedB = -1;

void logAlways(const char* section, const String& message) {
  Serial.printf("[%lu] [%s] %s\n", millis(), section, message.c_str());
}

void logStep(const char* section, const String& message) {
  if (!DEBUG_MODE) return;
  logAlways(section, message);
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

String formatDsAddress(const DeviceAddress addr) {
  char out[24];
  snprintf(
    out,
    sizeof(out),
    "%02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X",
    addr[0], addr[1], addr[2], addr[3], addr[4], addr[5], addr[6], addr[7]
  );
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
  logStep("SENSOR", "Sensor power enabled");
  delay(750);
}

void sensorPowerOff() {
  if (!sensorPowerEnabled()) return;
  digitalWrite(SENSOR_POWER_PIN, LOW);
  logStep("SENSOR", "Sensor power disabled");
}

float readBatteryVoltage() {
  if (BATTERY_ADC_PIN < 0) return NAN;

  const int raw = analogRead(BATTERY_ADC_PIN);
  const float adcVoltage = (static_cast<float>(raw) / 4095.0f) * 3.3f;
  const float estimatedBatteryVoltage = adcVoltage * 2.0f; // placeholder for future divider tuning
  logStep("BATT", String("ADC raw=") + raw + ", voltage=" + String(estimatedBatteryVoltage, 3) + "V");
  return estimatedBatteryVoltage;
}

void wifiShutdown() {
  if (WiFi.getMode() != WIFI_OFF) {
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    logStep("WIFI", "WiFi powered down");
  }
}

void printBootChecklist() {
  logAlways("BOOT", "Starting Freezer Lynk WiFi MVP");
  logAlways("BOOT", String("Boot Count: ") + bootCount + ", Wake Reason: " + wakeReasonToString(esp_sleep_get_wakeup_cause()));
  logAlways("BOOT", String("Firmware Version: ") + FIRMWARE_VERSION);
  logAlways("BOOT", String("Device Key: ") + DEVICE_KEY);
  logAlways("BOOT", String("DS18B20 GPIO: ") + DS18B20_PIN + ", Sensor Power GPIO: " + SENSOR_POWER_PIN);
  logAlways("BOOT", String("WiFi SSID: ") + WIFI_SSID);
  logAlways("BOOT", String("Telemetry URL: ") + TELEMETRY_URL);
  logAlways("BOOT", String("Auth Mode: ")
    + (strlen(TELEMETRY_BEARER_TOKEN) > 0 ? "Bearer token"
      : (strlen(SUPABASE_ANON_KEY) > 0 ? "Supabase anon key" : "NONE (will 401 if JWT verify is enabled)")));
  logAlways("BOOT", String("Free Heap: ") + ESP.getFreeHeap() + " bytes");
  logAlways("BOOT", String("ESP32 MAC: ") + formatMacAddress());
  logAlways("BOOT", String("DEBUG_MODE=") + (DEBUG_MODE ? "true" : "false")
    + ", prod interval=" + PRODUCTION_INTERVAL_SECONDS + "s, alarm interval=" + ALARM_INTERVAL_SECONDS + "s");
  logAlways("BOOT", String("Consecutive Telemetry Failures: ") + consecutiveTelemetryFailures);
}

void printSensorInventory() {
  if (!DEBUG_MODE) return;

  sensorPowerOn();
  logStep("SENSOR", "Initializing DS18B20...");
  tempBus.begin();

  const uint8_t count = tempBus.getDeviceCount();
  logStep("SENSOR", String("Found ") + count + " sensor(s)");

  if (count == 0) {
    logStep("SENSOR", "ERROR: No DS18B20 sensors found");
    sensorPowerOff();
    return;
  }

  for (uint8_t i = 0; i < count; i++) {
    DeviceAddress addr;
    if (tempBus.getAddress(addr, i)) {
      logStep("SENSOR", String("Address[") + i + "]: " + formatDsAddress(addr));
    } else {
      logStep("SENSOR", String("Address[") + i + "]: ERROR: Unable to read device address");
    }
  }
  logStep("SENSOR", "Sensor inventory complete");
  sensorPowerOff();
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
    logStep("LED", String("R=") + (nextR == HIGH ? "ON" : "OFF")
      + " G=" + (nextG == HIGH ? "ON" : "OFF")
      + " B=" + (nextB == HIGH ? "ON" : "OFF"));
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

void bluePairingBlink() {
  logStep("LED", "Blue blink (pairing/WiFi not connected)");
  blinkColor(false, false, true, 1, 35, 20);
}

bool wifiEnsureConnected() {
  if (WiFi.status() == WL_CONNECTED) {
    logStep("WIFI", String("Already connected, IP: ") + WiFi.localIP().toString());
    return true;
  }

  logStep("WIFI", "Connecting to WiFi...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const unsigned long start = millis();
  unsigned long lastDotAt = start;
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < WIFI_CONNECT_TIMEOUT_MS) {
    if (DEBUG_MODE && (millis() - lastDotAt) >= WIFI_DOT_INTERVAL_MS) {
      Serial.print('.');
      Serial.flush();
      lastDotAt = millis();
    }
    delay(25);
  }
  if (DEBUG_MODE) Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    logAlways("WIFI", String("Connected, IP: ") + WiFi.localIP().toString());
    return true;
  }

  logAlways("WIFI", String("WiFi connect timeout, status=") + WiFi.status());
  wifiShutdown();
  return false;
}

bool isInvalidDs18b20C(float c) {
  // DS18B20 startup / disconnected sentinel values.
  if (c == -127.0f) return true; // disconnected
  if (c == 85.0f) return true;   // power-on default before conversion

  // Broad sanity clamp for freezer use-case.
  if (c < -80.0f || c > 80.0f) return true;
  return false;
}

float cToF(float c) {
  return (c * 9.0f / 5.0f) + 32.0f;
}

bool postTelemetry(float tempF, float tempC, float batteryVoltage) {
  logStep("HTTP", "Posting telemetry...");
  if (WiFi.status() != WL_CONNECTED) {
    logAlways("HTTP", "WiFi not connected, skipping POST");
    return false;
  }

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(TELEMETRY_URL);
  http.addHeader("Content-Type", "application/json");

  bool authConfigured = false;
  if (strlen(TELEMETRY_BEARER_TOKEN) > 0) {
    http.addHeader("Authorization", String("Bearer ") + TELEMETRY_BEARER_TOKEN);
    authConfigured = true;
    logStep("HTTP", "Auth header: Bearer token");
  } else if (strlen(SUPABASE_ANON_KEY) > 0) {
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
    http.addHeader("apikey", SUPABASE_ANON_KEY);
    authConfigured = true;
    logStep("HTTP", "Auth header: Supabase anon key (Authorization + apikey)");
  }

  if (!authConfigured) {
    logStep("HTTP", "WARNING: No auth configured; edge function may return 401");
  }

  String payload = "{";
  payload += "\"device_key\":\"" + String(DEVICE_KEY) + "\",";
  payload += "\"temperature_f\":" + String(tempF, 3) + ",";
  payload += "\"temperature_c\":" + String(tempC, 3) + ",";
  payload += "\"battery_voltage\":" + (isnan(batteryVoltage) ? String("null") : String(batteryVoltage, 3)) + ",";
  payload += "\"battery_percent\":null,";
  payload += "\"firmware_version\":\"" + String(FIRMWARE_VERSION) + "\"";
  payload += "}";

  logStep("HTTP", String("Endpoint: ") + TELEMETRY_URL);
  logStep("HTTP", String("Payload: ") + payload);

  const int code = http.POST(payload);
  String body = http.getString();
  if (code < 0) {
    logAlways("HTTP", String("HTTP error: ") + http.errorToString(code));
  }
  http.end();

  logAlways("HTTP", String("Response code: ") + code);
  logStep("HTTP", String("Response body: ") + (body.length() > 0 ? body : "<empty>"));

  return code >= 200 && code < 300;
}

bool readTemperature(float& outC, float& outF) {
  logStep("SENSOR", "Reading DS18B20 temperature...");

  sensorPowerOn();
  tempBus.begin();

  const uint8_t count = tempBus.getDeviceCount();
  if (count == 0) {
    logAlways("SENSOR", "No DS18B20 sensors found");
    sensorPowerOff();
    return false;
  }

  tempBus.requestTemperatures();
  const float tempC = tempBus.getTempCByIndex(0);
  const float tempF = cToF(tempC);

  logStep("SENSOR", String("Raw temp C=") + String(tempC, 3) + " F=" + String(tempF, 3));

  if (isnan(tempC) || isnan(tempF)) {
    logAlways("SENSOR", "Invalid temp (NaN)");
    sensorPowerOff();
    return false;
  }

  if (tempC == DEVICE_DISCONNECTED_C) {
    logAlways("SENSOR", "Invalid temp (DEVICE_DISCONNECTED_C)");
    sensorPowerOff();
    return false;
  }

  if (tempC == -127.0f) {
    logAlways("SENSOR", "Invalid temp (-127C)");
    sensorPowerOff();
    return false;
  }

  if (tempC == 85.0f) {
    logAlways("SENSOR", "Invalid temp (85C)");
    sensorPowerOff();
    return false;
  }

  // Explicitly reject the sentinel readings requested for this MVP.
  if (tempF <= -196.6f || tempC <= -127.0f || tempF >= 185.0f || tempC >= 85.0f) {
    logAlways("SENSOR", "Invalid temp (sentinel/range check)");
    sensorPowerOff();
    return false;
  }

  if (isInvalidDs18b20C(tempC)) {
    logAlways("SENSOR", "Invalid temp (sanity check)");
    sensorPowerOff();
    return false;
  }

  outC = tempC;
  outF = tempF;
  sensorPowerOff();
  logAlways("SENSOR", String("Temp: ") + String(tempF, 1) + "F");
  return true;
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

void setup() {
  Serial.begin(115200);
  delay(200);
  bootCount++;

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

  printBootChecklist();
  printSensorInventory();
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
    bluePairingBlink();
    enterDeepSleep(selectSleepIntervalSeconds(true, false, tempF), "wifi connect failed");
  }

  const bool sent = postTelemetry(tempF, tempC, batteryVoltage);
  wifiShutdown();

  if (sent) {
    consecutiveTelemetryFailures = 0;
    logAlways("HTTP", "POST success");
    blinkColor(false, true, false, 1, 40, 20);
  } else {
    consecutiveTelemetryFailures++;
    logAlways("HTTP", "POST failed");
    blinkColor(true, false, false, 1, 45, 20);
  }

  if (tempF > LOCAL_ALARM_HIGH_F) {
    logStep("SENSOR", String("Temp above local alarm threshold: ") + String(tempF, 1) + "F");
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
