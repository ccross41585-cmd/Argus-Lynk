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

// Relay wiring. Adjust active level to match your module so boot does not pulse the relay.
const int RELAY_PIN = 26;
const int RELAY_ACTIVE_LEVEL = HIGH;
const int RELAY_IDLE_LEVEL = LOW;

// Heltec WiFi LoRa 32 V3 / SX1262 pinout.
#define LORA_NSS 8
#define LORA_DIO1 14
#define LORA_RST 12
#define LORA_BUSY 13

const float LORA_FREQ = 915.0;

SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RST);

String lastHandledSequence = "";
bool relayIsOn = false;
volatile bool receivedFlag = false;
bool oledOk = false;
bool loraOk = false;
String lastPacketText = "NONE";
String lastCommandText = "NONE";
String lastAckText = "NONE";
String lastErrorText = "";

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

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("ARGUS NODE");
  display.print("LoRa:");
  display.println(loraOk ? "OK" : "NO");
  display.print("Relay:");
  display.println(relayIsOn ? "ON" : "OFF");
  display.print("Cmd:");
  display.println(lastCommandText);
  display.print("Ack:");
  display.println(lastAckText);
  display.print("Pkt:");
  display.println(lastPacketText);
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

String relayStateText() {
  return readRelayOutputState() ? "ON" : "OFF";
}

void applyRelayState(bool nextRelayState) {
  digitalWrite(RELAY_PIN, nextRelayState ? RELAY_ACTIVE_LEVEL : RELAY_IDLE_LEVEL);
  relayIsOn = readRelayOutputState();

  if (relayIsOn != nextRelayState) {
    lastErrorText = "RELAY MISMATCH";
    Serial.println("Relay output verification failed after write.");
  } else {
    lastErrorText = "";
  }

  drawScreen();
}

void sendAck(const String& sequence) {
  String packet = "ACK|" + NETWORK_KEY + "|" + NODE_ID + "|" + sequence + "|" + relayStateText();
  lastAckText = relayStateText();
  drawScreen();

  Serial.print("Sending ACK: ");
  Serial.println(packet);

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

void setupRelay() {
  // Set the idle level before switching the pin to OUTPUT to avoid relay glitches.
  digitalWrite(RELAY_PIN, RELAY_IDLE_LEVEL);
  pinMode(RELAY_PIN, OUTPUT);
  relayIsOn = readRelayOutputState();

  Serial.print("Relay initialized. Current state: ");
  Serial.println(relayStateText());
}

void handleCommandPacket(const String& packet) {
  String packetType = packetPart(packet, 0);
  String packetKey = packetPart(packet, 1);
  String packetNode = packetPart(packet, 2);
  String sequence = packetPart(packet, 3);
  String command = packetPart(packet, 4);

  if (packetType != "CMD" || packetKey.length() == 0 || packetNode.length() == 0 || sequence.length() == 0 || command.length() == 0) {
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
    lastAckText = relayStateText();
    drawScreen();
    Serial.printf("Duplicate command received again: %s\n", sequence.c_str());
    sendAck(sequence);
    return;
  }

  if (command == "ON") {
    applyRelayState(true);
  } else if (command == "OFF") {
    applyRelayState(false);
  } else {
    lastPacketText = "BAD CMD";
    lastErrorText = command;
    drawScreen();
    Serial.printf("Unsupported command received: %s\n", command.c_str());
    int state = radio.startReceive();
    if (state != RADIOLIB_ERR_NONE) {
      Serial.printf("Failed to restart receive mode. RadioLib code: %d\n", state);
    }
    return;
  }

  lastHandledSequence = sequence;
  lastPacketText = shortText(sequence, 8);
  lastCommandText = command;
  lastErrorText = "";
  drawScreen();

  Serial.print("Applied command ");
  Serial.print(command);
  Serial.print(". Relay state is now ");
  Serial.println(relayStateText());

  sendAck(sequence);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("Argus field node MVP booting...");

  setupOLED();
  drawScreen();
  setupRelay();
  initializeLoRa();

  Serial.print("Listening for node: ");
  Serial.println(NODE_ID);
}

void loop() {
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
  relayIsOn = readRelayOutputState();
  drawScreen();
  Serial.print("LoRa packet received: ");
  Serial.println(packet);

  handleCommandPacket(packet);
}