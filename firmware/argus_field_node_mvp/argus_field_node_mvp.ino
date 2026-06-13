#include <RadioLib.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const String NETWORK_KEY = "farm123";
const String NODE_ID = "fence1";

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
  String packet = "HB|" + NETWORK_KEY + "|" + NODE_ID + "|"
                  + (commandedOn ? "ON" : "OFF") + "|" + fb + "|" + raw + "|" + String(millis());
  Serial.print("Sending HB: ");
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
  String fb  = contactorFeedback();
  String raw = auxRawLabel();
  // Format: ACK|<key>|<node>|<seq>|<ON/OFF>|<CONFIRMED/FAILED/OPEN/STUCK_ON>|<AUX_LOW/AUX_HIGH>
  String packet = "ACK|" + NETWORK_KEY + "|" + NODE_ID + "|" + sequence
                  + "|" + (commandedOn ? "ON" : "OFF") + "|" + fb + "|" + raw;
  lastAckText = commandedOn ? "ON" : "OFF";
  drawScreen();

  Serial.print("Sending ACK: ");
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

  Serial.print("Handled command ");
  Serial.print(command);
  Serial.print(". Commanded: ");
  Serial.print(commandedOn ? "ON" : "OFF");
  Serial.print(". Contactor: ");
  Serial.println(contactorFeedback());

  sendAck(sequence);
}

// ── Arduino entry points ──────────────────────────────────────────────────────

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

  Serial.print("Listening for node: ");
  Serial.println(NODE_ID);
}

void loop() {
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