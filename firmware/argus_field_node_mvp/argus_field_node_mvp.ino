#include <RadioLib.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ── Optional WiFi / OTA ──────────────────────────────────────────────────────────────
// Copy field_node_secrets.example.h → field_node_secrets.h and define
// FIELD_NODE_WIFI_SSID / FIELD_NODE_WIFI_PASSWORD to enable WiFi OTA updates.
// If the file is absent or the credentials are not defined, OTA is silently
// disabled at compile time and LoRa operation is completely unaffected.
//
// TODO (future LoRa-OTA): When the gateway sends an OTA_NOTIFY packet over
//   LoRa, the field node should wake WiFi, pull the binary from Supabase
//   Storage or a GitHub Release URL, and apply it via the Arduino OTA API.
//   The LoRa packet format reserved for this is:
//     OTA_NOTIFY|<key>|<node>|<target_version>|<download_url>
//   Current version, target version, staged rollout flag, and rollback hash
//   will be tracked in Supabase (devices.firmware_version / metadata).
#if __has_include("field_node_secrets.h")
  #include "field_node_secrets.h"
#endif

#ifdef FIELD_NODE_WIFI_SSID
  #define FIELD_NODE_OTA_AVAILABLE 1
  #include <WiFi.h>
  #include <ArduinoOTA.h>
#else
  #define FIELD_NODE_OTA_AVAILABLE 0
#endif

const String NETWORK_KEY = "farm123";
const String NODE_ID = "fence1";

// ── Firmware identity ────────────────────────────────────────────────────────────────────
const char* DEVICE_FIRMWARE_VERSION = "1.1.1";
const char* DEVICE_BUILD_DATE       = "2026-06-13";
const char* DEVICE_ROLE             = "field_node";
#if FIELD_NODE_OTA_AVAILABLE
  const bool OTA_SUPPORTED = true;
#else
  const bool OTA_SUPPORTED = false;
#endif

// Safety flag: set true to force the relay to the idle (off) state before
// an OTA flash begins.  Left false by default so the relay is preserved
// across an update unless you deliberately enable this.
const bool OTA_SAFE_MODE_RELAY_OFF = false;

#define OLED_SDA 17
#define OLED_SCL 18
#define OLED_RST 21
#define OLED_ADDR 0x3C
#define VEXT_CTRL 36

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

// Relay wiring. Set RELAY_ACTIVE_LOW true if your module energises on a LOW signal.
#define RELAY_ACTIVE_LOW false
const int RELAY_PIN          = 26;
const int RELAY_ACTIVE_LEVEL = RELAY_ACTIVE_LOW ? LOW  : HIGH;
const int RELAY_IDLE_LEVEL   = RELAY_ACTIVE_LOW ? HIGH : LOW;

// Auxiliary contactor feedback: 3.3 V → aux contact → GPIO 34 (input-only, no pull).
// Closed (contactor ON)  → GPIO 34 reads HIGH (~3.27 V).
// Open   (contactor OFF) → GPIO 34 reads LOW  (floating low via external path).
#define CONTACTOR_FEEDBACK_PIN 34

// Heartbeat interval (ms). Field node broadcasts state every HB_INTERVAL_MS.
const unsigned long HB_INTERVAL_MS = 30000;
unsigned long lastHeartbeatAt = 0;
bool immediateHeartbeatNeeded = false;  // Set true to fire HB ASAP (e.g. power-loss detected).

// Contactor feedback timing and failure tracking.
const unsigned long CONTACTOR_GRACE_MS = 1000; // Grace period after relay command before declaring failure.
unsigned long lastCommandChangeMs = 0;          // millis() timestamp of last relay state change.
bool contactFailed = false;                     // Latches true on mismatch; cleared when aux matches command.

// Auto-rearm removed: only gateway commands change relay state.

// Heltec WiFi LoRa 32 V3 / SX1262 pinout.
#define LORA_NSS  8
#define LORA_DIO1 14
#define LORA_RST  12
#define LORA_BUSY 13

const float LORA_FREQ = 915.0;

SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RST);

String lastHandledSequence = "";
bool commandedOn = false;         // Default commanded state is OFF at boot. Wait for a gateway command.
volatile bool receivedFlag = false;
bool oledOk = false;
bool loraOk = false;
// WiFi / OTA runtime state (only meaningful when FIELD_NODE_OTA_AVAILABLE==1).
#if FIELD_NODE_OTA_AVAILABLE
bool wifiConnected = false;  // true once WiFi.status() == WL_CONNECTED
bool otaEnabled    = false;  // true once ArduinoOTA.begin() succeeds
bool otaBusy       = false;  // true while a firmware flash is in progress
#endif
String lastPacketText  = "NONE";
String lastCommandText = "NONE";
String lastAckText     = "NONE";
String lastErrorText   = "";
String lastFeedbackText = "";     // Tracks previous feedback to detect changes.
float  lastRSSI = 0.0;
float  lastSNR  = 0.0;

// ── Contactor feedback ────────────────────────────────────────────────────────

// Debounced read: 5 samples over 100 ms, majority vote.
// Returns true when the aux contact is CLOSED (HIGH = 3.3 V via contact → GPIO 34).
bool readAuxDebounced() {
  int highCount = 0;
  for (int i = 0; i < 5; i++) {
    if (digitalRead(CONTACTOR_FEEDBACK_PIN) == HIGH) highCount++;
    delay(20);
  }
  return highCount >= 3;
}

// Raw aux label included in ACK / HB packets so the gateway can forward it.
// HIGH = contact closed (contactor ON); LOW = contact open (contactor OFF).
String auxRawLabel() {
  return readAuxDebounced() ? "AUX_HIGH" : "AUX_LOW";
}

bool contactorIsEngaged() {
  return readAuxDebounced();  // true = HIGH = contact closed = contactor ON.
}

// Returns the relationship between the commanded state and the physical contactor.
// Includes a CONTACTOR_GRACE_MS window after a relay command before declaring failure.
// Uses STUCK_ON (underscore) for clean pipe-delimited packet parsing.
String contactorFeedback() {
  bool auxHigh = readAuxDebounced();
  unsigned long msSinceCommand = millis() - lastCommandChangeMs;

  // Still within grace window — don't declare failure yet.
  if (msSinceCommand < CONTACTOR_GRACE_MS) {
    return "CHECKING";
  }

  if ( commandedOn &&  auxHigh) { contactFailed = false; return "CONFIRMED"; }
  if ( commandedOn && !auxHigh) { contactFailed = true;  return "FAILED";    }
  if (!commandedOn && !auxHigh) { contactFailed = false; return "OPEN";      }
  // !commandedOn && auxHigh
  contactFailed = true;
  return "STUCK_ON";
}

// Emits a Serial message whenever the feedback state transitions.
// Also sets immediateHeartbeatNeeded if a FAILED condition is detected.
void checkFeedbackChange() {
  bool   auxHigh        = readAuxDebounced();
  String raw            = auxHigh ? "AUX_HIGH" : "AUX_LOW";
  int    rawPin         = digitalRead(CONTACTOR_FEEDBACK_PIN);
  String fb             = contactorFeedback();
  unsigned long msSince = millis() - lastCommandChangeMs;

  if (fb != lastFeedbackText) {
    lastFeedbackText = fb;
    Serial.print("[AUX] Cmd=");
    Serial.print(commandedOn ? "ON" : "OFF");
    Serial.print(" GPIO34=");
    Serial.print(rawPin == HIGH ? "HIGH" : "LOW");
    Serial.print(" AuxLabel=");
    Serial.print(raw);
    Serial.print(" Status=");
    Serial.print(fb);
    Serial.print(" msSinceCmd=");
    Serial.println(msSince);

    // If the fence was commanded ON but the contactor just disengaged (outside
    // the grace window), flag an immediate heartbeat so the gateway learns quickly.
    if (fb == "FAILED" && commandedOn) {
      Serial.println("[AUX] Power loss detected while commanded ON — flagging immediate HB.");
      immediateHeartbeatNeeded = true;
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

String shortText(const String& value, size_t limit) {
  if (value.length() <= limit) {
    return value;
  }
  return value.substring(0, limit);
}

#if defined(ESP8266) || defined(ESP32)
ICACHE_RAM_ATTR
#endif
void setReceiveFlag(void) {
  receivedFlag = true;
}

void drawScreen() {
  if (!oledOk) {
    return;
  }

  String fb  = contactorFeedback();
  String raw = auxRawLabel();
  char rssiSnr[24];
  snprintf(rssiSnr, sizeof(rssiSnr), "RSSI:%.0f SNR:%.1f", lastRSSI, lastSNR);

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.print("NODE: ");
  display.println(NODE_ID);
  display.print("Cmd: ");
  display.println(commandedOn ? "ON" : "OFF");
  display.print("Aux: ");
  display.println(raw);          // AUX_LOW or AUX_HIGH
  display.print("Contact: ");
  display.println(fb);           // CONFIRMED / OPEN / FAILED / STUCK_ON
  display.print("Radio: ");
  display.println(loraOk ? "READY" : "NO");
  display.println(rssiSnr);
#if FIELD_NODE_OTA_AVAILABLE
  display.print("OTA: ");
  display.println(otaEnabled ? (wifiConnected ? "RDY" : "NoWiFi") : "OFF");
#endif
  display.display();
}

void setupOLED() {
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

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Argus Node Boot");
  display.println("OLED OK");
  display.display();
  delay(750);
}

String trimCopy(const String& value) {
  String result = value;
  result.trim();
  return result;
}

bool readRelayOutputState() {
  return digitalRead(RELAY_PIN) == RELAY_ACTIVE_LEVEL;
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

// ── Relay ─────────────────────────────────────────────────────────────────────

void applyRelayState(bool nextCommandedOn) {
  commandedOn = nextCommandedOn;
  lastCommandChangeMs = millis();  // Start grace period timer.
  contactFailed = false;           // Clear any previous failure flag on new command.

  digitalWrite(RELAY_PIN, commandedOn ? RELAY_ACTIVE_LEVEL : RELAY_IDLE_LEVEL);

  Serial.print("[RELAY] Cmd=");
  Serial.print(commandedOn ? "ON" : "OFF");
  Serial.print(" GPIO34_immed=");
  Serial.println(digitalRead(CONTACTOR_FEEDBACK_PIN) == HIGH ? "HIGH" : "LOW");

  if (readRelayOutputState() != commandedOn) {
    lastErrorText = "RELAY MISMATCH";
    Serial.println("[RELAY] Output verification failed after write.");
  } else {
    lastErrorText = "";
  }

  // Log raw aux 200 ms after energising; full status evaluated after grace period in loop.
  delay(200);
  Serial.print("[AUX] 200ms post-cmd GPIO34=");
  Serial.print(digitalRead(CONTACTOR_FEEDBACK_PIN) == HIGH ? "HIGH" : "LOW");
  Serial.print(" AuxLabel=");
  Serial.print(auxRawLabel());
  Serial.print(" msSinceCmd=");
  Serial.println(millis() - lastCommandChangeMs);

  // Reset lastFeedbackText so checkFeedbackChange() emits the CHECKING transition.
  lastFeedbackText = "";
  checkFeedbackChange();
  drawScreen();
}

void setupRelay() {
  // Pre-load the idle level before switching to OUTPUT so the relay stays
  // de-energised at boot. Wait for a gateway ON command before engaging.
  digitalWrite(RELAY_PIN, RELAY_IDLE_LEVEL);
  pinMode(RELAY_PIN, OUTPUT);

  if (readRelayOutputState() != commandedOn) {
    lastErrorText = "RELAY MISMATCH";
    Serial.println("Relay output verification failed at boot.");
  }

  Serial.print("Relay initialized. Commanded state: ");
  Serial.println(commandedOn ? "ON" : "OFF");
}

// ── LoRa ──────────────────────────────────────────────────────────────────────

// Sends a heartbeat packet at regular intervals so the gateway can update
// aux_raw / contactor_feedback without waiting for a command cycle.
void sendHeartbeat() {
  String fb  = contactorFeedback();
  String raw = auxRawLabel();
  String relayState = readRelayOutputState() ? "ON" : "OFF";
  String physState = readAuxDebounced() ? "on" : "off";

  // Optional firmware fields (parts 7 and 8).
  // The gateway silently ignores these on older builds; newer builds parse them.
  // Part 6 = millis() (existing), Part 7 = firmware_version, Part 8 = wifi_connected.
#if FIELD_NODE_OTA_AVAILABLE
  String wifiStr = wifiConnected ? "1" : "0";
#else
  String wifiStr = "0";
#endif

  // Layout:
  // HB|<key>|<node>|HB|<cmd_state>|<relay_state>|<aux_raw>|<contactor_feedback>|<confirmed_state>|<uptime_ms>|<firmware_version>|<wifi_connected>
  String packet = "HB|" + NETWORK_KEY + "|" + NODE_ID + "|HB"
                  + "|" + (commandedOn ? "ON" : "OFF")
                  + "|" + relayState
                  + "|" + raw
                  + "|" + fb
                  + "|" + physState
                  + "|" + String(millis())
                  + "|" + String(DEVICE_FIRMWARE_VERSION)
                  + "|" + wifiStr;
  Serial.print("[HB PACKET] ");
  Serial.println(packet);
  int state = radio.transmit(packet);
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("HB transmit failed. RadioLib code: %d\n", state);
  }
  state = radio.startReceive();
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("HB: failed to return to receive mode. RadioLib code: %d\n", state);
  }
}

void sendAck(const String& sequence) {
  // Wait out any remaining contactor grace period so feedback is definitive (never "CHECKING").
  unsigned long msSinceCmd = millis() - lastCommandChangeMs;
  if (msSinceCmd < CONTACTOR_GRACE_MS) {
    unsigned long waitMs = CONTACTOR_GRACE_MS - msSinceCmd;
    Serial.printf("[ACK] Grace wait %lu ms before reading feedback.\n", waitMs);
    delay(waitMs);
  }
  String fb  = contactorFeedback();
  String raw = auxRawLabel();
  String relayState = readRelayOutputState() ? "ON" : "OFF";
  // Physical confirmed_state: "on" if aux contact is closed (AUX_HIGH), "off" otherwise.
  // Independent of commanded state — this is what the gateway uses to verify the command.
  String physState = readAuxDebounced() ? "on" : "off";
  // Layout:
  // ACK|<key>|<node>|<seq>|<cmd_state>|<relay_state>|<aux_raw>|<contactor_feedback>|<confirmed_state>|<firmware_version>|<wifi_connected>
  String packet = "ACK|" + NETWORK_KEY + "|" + NODE_ID + "|" + sequence
                  + "|" + (commandedOn ? "ON" : "OFF")
                  + "|" + relayState
                  + "|" + raw
                  + "|" + fb
                  + "|" + physState
                  + "|" + String(DEVICE_FIRMWARE_VERSION)
#if FIELD_NODE_OTA_AVAILABLE
                  + "|" + String(wifiConnected ? "1" : "0");
#else
                  + "|0";
#endif
  lastAckText = commandedOn ? "ON" : "OFF";
  drawScreen();

  Serial.print("[ACK PACKET] ");
  Serial.println(packet);
  Serial.print("AUX_RAW=");
  Serial.println(raw);

  int state = radio.transmit(packet);
  if (state != RADIOLIB_ERR_NONE) {
    lastErrorText = "ACK TX FAIL";
    Serial.printf("ACK transmit failed. RadioLib code: %d\n", state);
    return;
  }

  state = radio.startReceive();
  if (state != RADIOLIB_ERR_NONE) {
    loraOk = false;
    lastErrorText = "RX restart fail";
    drawScreen();
    Serial.printf("Failed to return radio to receive mode. RadioLib code: %d\n", state);
  }
}

void initializeLoRa() {
  Serial.println("Initializing SX1262 radio...");
  int state = radio.begin(LORA_FREQ);

  if (state != RADIOLIB_ERR_NONE) {
    loraOk = false;
    lastErrorText = "LoRa init fail";
    Serial.printf("SX1262 init failed. RadioLib code: %d\n", state);
    while (true) {
      delay(1000);
    }
  }

  radio.setPacketReceivedAction(setReceiveFlag);
  state = radio.startReceive();
  if (state != RADIOLIB_ERR_NONE) {
    loraOk = false;
    lastErrorText = "RX start fail";
    Serial.printf("Failed to start receive mode. RadioLib code: %d\n", state);
    while (true) {
      delay(1000);
    }
  }

  loraOk = true;
  drawScreen();
  Serial.println("SX1262 radio ready.");
}

// ── Command handling ──────────────────────────────────────────────────────────

void handleCommandPacket(const String& packet) {
  String packetType = packetPart(packet, 0);
  String packetKey  = packetPart(packet, 1);
  String packetNode = packetPart(packet, 2);
  String sequence   = packetPart(packet, 3);
  String command    = packetPart(packet, 4);

  if (packetType != "CMD" || packetKey.length() == 0 || packetNode.length() == 0
      || sequence.length() == 0 || command.length() == 0) {
    if (packetType == "ACK") {
      lastPacketText = "ACK SEEN";
      drawScreen();
    }
    Serial.println("Ignoring malformed command packet.");
    int state = radio.startReceive();
    if (state != RADIOLIB_ERR_NONE) {
      Serial.printf("Failed to restart receive mode. RadioLib code: %d\n", state);
    }
    return;
  }

  if (packetKey != NETWORK_KEY) {
    lastPacketText = "NET MISMATCH";
    drawScreen();
    Serial.println("Ignoring packet for another network.");
    int state = radio.startReceive();
    if (state != RADIOLIB_ERR_NONE) {
      Serial.printf("Failed to restart receive mode. RadioLib code: %d\n", state);
    }
    return;
  }

  if (packetNode != NODE_ID) {
    lastPacketText = "NODE MISMATCH";
    drawScreen();
    Serial.println("Ignoring packet for another node.");
    int state = radio.startReceive();
    if (state != RADIOLIB_ERR_NONE) {
      Serial.printf("Failed to restart receive mode. RadioLib code: %d\n", state);
    }
    return;
  }

  if (sequence == lastHandledSequence) {
    lastPacketText = "DUP " + shortText(sequence, 8);
    lastCommandText = command;
    drawScreen();
    Serial.printf("Duplicate command received again: %s\n", sequence.c_str());
    sendAck(sequence);
    return;
  }

  if (command == "ON") {
    applyRelayState(true);
  } else if (command == "OFF") {
    applyRelayState(false);
  } else if (command == "STATUS") {
    // No state change — ACK with current commanded state and contactor feedback.
  } else {
    lastPacketText = "BAD CMD";
    lastErrorText  = command;
    drawScreen();
    Serial.printf("Unsupported command received: %s\n", command.c_str());
    int state = radio.startReceive();
    if (state != RADIOLIB_ERR_NONE) {
      Serial.printf("Failed to restart receive mode. RadioLib code: %d\n", state);
    }
    return;
  }

  lastHandledSequence = sequence;
  lastPacketText  = shortText(sequence, 8);
  lastCommandText = command;
  lastErrorText   = "";
  drawScreen();

  Serial.printf("[CMD] Received %s id=%s commanded=%s\n",
    command.c_str(), sequence.c_str(), commandedOn ? "ON" : "OFF");

  sendAck(sequence);
}

// ── Arduino entry points ──────────────────────────────────────────────────────

// \u2500\u2500 Optional WiFi OTA setup \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
#if FIELD_NODE_OTA_AVAILABLE
void setupWifiOTA() {
  Serial.printf("[OTA] Connecting to WiFi: %s\n", FIELD_NODE_WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(FIELD_NODE_WIFI_SSID, FIELD_NODE_WIFI_PASSWORD);

  // Non-blocking: try for up to 10 s; LoRa setup continues regardless.
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 10000) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    wifiConnected = false;
    otaEnabled    = false;
    Serial.println("[OTA] WiFi connect failed \u2014 OTA disabled. LoRa continues normally.");
    return;
  }

  wifiConnected = true;
  Serial.print("[OTA] WiFi connected. IP: ");
  Serial.println(WiFi.localIP());

  // OTA hostname: argus-field-<NODE_ID>  (e.g. argus-field-fence1)
  String hostname = String("argus-field-") + NODE_ID;
  ArduinoOTA.setHostname(hostname.c_str());

  ArduinoOTA.onStart([]() {
    otaBusy = true;
    Serial.println("[OTA] Start");
    if (OTA_SAFE_MODE_RELAY_OFF) {
      // Force relay to idle (safe) state before the flash write begins.
      // Controlled by the OTA_SAFE_MODE_RELAY_OFF constant at the top of this file.
      digitalWrite(RELAY_PIN, RELAY_IDLE_LEVEL);
      Serial.println("[OTA] Relay forced OFF (OTA_SAFE_MODE_RELAY_OFF=true).");
    }
    if (oledOk) {
      display.clearDisplay();
      display.setTextSize(1);
      display.setTextColor(SSD1306_WHITE);
      display.setCursor(0, 0);
      display.println("OTA Start");
      display.display();
    }
  });

  ArduinoOTA.onEnd([]() {
    otaBusy = false;
    Serial.println("[OTA] Success \u2014 rebooting.");
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
      display.print("OTA ");
      display.print(pct);
      display.println("%");
      display.display();
    }
  });

  ArduinoOTA.onError([](ota_error_t error) {
    otaBusy = false;
    Serial.printf("[OTA] Error [%u]\n", (unsigned)error);
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
  otaEnabled = true;
  Serial.print("[OTA] Ready. Hostname: ");
  Serial.println(hostname);
  if (oledOk) {
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("OTA Ready");
    display.println(hostname.substring(0, 18));
    display.display();
    delay(1000);
  }
}
#endif

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("Argus field node MVP booting...");

  setupOLED();
  setupRelay();

  // GPIO34 is input-only; no internal pull — 3.3 V is sourced externally through the aux contact.
  pinMode(CONTACTOR_FEEDBACK_PIN, INPUT);

  // Boot self-test: read aux raw before relay activates.
  int rawBoot = digitalRead(CONTACTOR_FEEDBACK_PIN);
  Serial.print("BOOT_AUX_RAW=");
  Serial.println(rawBoot == LOW ? "LOW" : "HIGH");

  // If a future build defaults commandedOn=true, wait for relay settle then re-read.
  if (commandedOn) {
    delay(500);
    Serial.print("BOOT_AUX_RAW_POST_RELAY=");
    Serial.println(auxRawLabel());
  }

  // Seed lastFeedbackText so the first checkFeedbackChange() call is silent.
  lastFeedbackText = contactorFeedback();
  Serial.print("Initial contactor feedback: ");
  Serial.println(lastFeedbackText);

  drawScreen();
  initializeLoRa();

#if FIELD_NODE_OTA_AVAILABLE
  // WiFi/OTA setup runs after LoRa is ready; a failed WiFi connect does not
  // block or halt the field node.  LoRa command handling is always available.
  setupWifiOTA();
#endif

  Serial.printf("[BOOT] firmware=%s build=%s role=%s ota=%s\n",
    DEVICE_FIRMWARE_VERSION, DEVICE_BUILD_DATE, DEVICE_ROLE,
    OTA_SUPPORTED ? "true" : "false");

  Serial.print("Listening for node: ");
  Serial.println(NODE_ID);
}

void loop() {
#if FIELD_NODE_OTA_AVAILABLE
  // ArduinoOTA.handle() must run every loop iteration to catch incoming OTA
  // connections.  It is non-blocking when no OTA client is active.
  // The onStart callback sets otaBusy=true for the duration of the flash write,
  // which gates all LoRa, relay, and heartbeat operations below.
  if (otaEnabled) {
    ArduinoOTA.handle();
  }

  if (otaBusy) {
    // Flash write in progress — skip all LoRa and relay operations.
    delay(25);
    return;
  }
#endif

  // Continuous physical feedback monitoring — prints on any transition.
  // Also sets immediateHeartbeatNeeded if power loss is detected.
  checkFeedbackChange();

  // Immediate heartbeat on power-loss detection (higher priority than interval).
  if (immediateHeartbeatNeeded) {
    immediateHeartbeatNeeded = false;
    lastHeartbeatAt = millis();  // Reset interval so next scheduled HB doesn't fire immediately.
    sendHeartbeat();
  }

  // Periodic heartbeat so the gateway can track aux_raw without a command cycle.
  if (millis() - lastHeartbeatAt >= HB_INTERVAL_MS) {
    lastHeartbeatAt = millis();
    sendHeartbeat();
  }

  if (!receivedFlag) {
    delay(25);
    return;
  }

  receivedFlag = false;

  String packet;
  int state = radio.readData(packet);
  if (state == RADIOLIB_ERR_CRC_MISMATCH) {
    lastPacketText = "CRC ERR";
    drawScreen();
    Serial.println("Ignoring packet with CRC mismatch.");
    state = radio.startReceive();
    if (state != RADIOLIB_ERR_NONE) {
      Serial.printf("Failed to restart receive mode. RadioLib code: %d\n", state);
    }
    return;
  }

  if (state != RADIOLIB_ERR_NONE) {
    loraOk = false;
    lastPacketText = "READ ERR";
    lastErrorText = String(state);
    drawScreen();
    Serial.printf("Failed to read LoRa packet. RadioLib code: %d\n", state);
    state = radio.startReceive();
    if (state != RADIOLIB_ERR_NONE) {
      Serial.printf("Failed to restart receive mode. RadioLib code: %d\n", state);
    }
    return;
  }

  packet = trimCopy(packet);
  lastPacketText = shortText(packet, 12);
  loraOk = true;
  lastRSSI = radio.getRSSI();
  lastSNR  = radio.getSNR();
  drawScreen();
  Serial.print("LoRa packet received: ");
  Serial.println(packet);

  handleCommandPacket(packet);
}