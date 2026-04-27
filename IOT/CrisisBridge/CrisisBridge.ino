/*
 * ============================================================
 *  CrisisBridge — Multi-Risk Safety & Incident Intelligence Node
 *  ESP32 Firmware v1.0
 * ============================================================
 *  Hardware:
 *    DHT11         → GPIO 16
 *    WS2812B       → GPIO 17
 *    I2C SDA       → GPIO 21
 *    I2C SCL       → GPIO 22
 *    PCF8574 Prox  → 0x3A
 *    I2CKeyPad     → 0x3D
 * ============================================================
 */

/* ---------- Blynk credentials (set BEFORE #include) ---------- */
#define BLYNK_TEMPLATE_ID   "TMPL36NuxY6pF"
#define BLYNK_TEMPLATE_NAME "CrisisBridge"
#define BLYNK_AUTH_TOKEN    "F8wPnZFNlNZXx1dq3cDsYtmEgxcHU36e"

#define BLYNK_PRINT Serial

/* ---------- Libraries ---------- */
#include <WiFi.h>
#include <BlynkSimpleEsp32.h>
#include <ThingSpeak.h>
#include <DHT.h>
#include <Wire.h>
#include <Adafruit_NeoPixel.h>
#include "I2CKeyPad.h"

/* ---------- WiFi ---------- */
char ssid[] = "Moto";
char pass[] = "MukeshPhone";

/* ---------- ThingSpeak ---------- */
unsigned long channelID    = 3359560;
const char*   writeAPIKey  = "Q233ZZGYI5BM0OH2";
WiFiClient    tsClient;                        // dedicated client for ThingSpeak

/* ---------- Pin Definitions ---------- */
#define DHTPIN      16
#define DHTTYPE     DHT11
#define LED_PIN     17
#define NUM_LEDS    1

/* ---------- I2C Addresses ---------- */
#define PCF8574_ADDR 0x3A
#define KEYPAD_ADDR  0x3D

/* ---------- Objects ---------- */
DHT               dht(DHTPIN, DHTTYPE);
Adafruit_NeoPixel led(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);
I2CKeyPad         keypad(KEYPAD_ADDR);

/* ---------- System State Machine ---------- */
enum State {
  SAFE,
  WARNING,
  CRITICAL,
  ALERT_SENT,
  ACKNOWLEDGED,
  ESCALATED
};

State currentState   = SAFE;
State previousState  = SAFE;

/* ---------- Sensor Data ---------- */
float temperature    = 0.0;
float humidity       = 0.0;
int   proximityByte  = 0;
int   proximityCount = 0;
int   riskScore      = 0;

/* ---------- Flags & Timers ---------- */
bool           alertSent        = false;
bool           manualOverride   = false;
unsigned long  lastSensorRead   = 0;
unsigned long  lastBlynkPush    = 0;
unsigned long  lastThingSpeak   = 0;
unsigned long  alertSentTime    = 0;
unsigned long  eventID          = 0;
unsigned long  lastAckTime      = 0;

const unsigned long SENSOR_INTERVAL = 2000;   // 2 s
const unsigned long BLYNK_INTERVAL  = 2000;   // 2 s
const unsigned long TS_INTERVAL     = 20000;  // 20 s  (ThingSpeak rate limit)
const unsigned long ESCALATE_TIMEOUT= 30000;  // 30 s  before escalation

/* ================================================================
 *  SENSOR READING
 * ================================================================ */
void readSensors() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();

  if (!isnan(t)) temperature = t;
  if (!isnan(h)) humidity    = h;

  Wire.requestFrom(PCF8574_ADDR, 1);
  if (Wire.available()) {
    proximityByte = Wire.read();
  }
  proximityCount = countActiveSensors(proximityByte);
}

/* ================================================================
 *  PROXIMITY DECODER
 * ================================================================ */
int countActiveSensors(int byteVal) {
  int count = 0;
  for (int i = 0; i < 8; i++) {
    if (byteVal & (1 << i)) count++;
  }
  return count;
}

/* ================================================================
 *  RISK CALCULATION ENGINE
 * ================================================================ */
int calculateRisk() {
  // Temperature score  (0-40)
  int tempScore;
  if (temperature > 40)      tempScore = 40;
  else if (temperature > 30) tempScore = 20;
  else                        tempScore = 5;

  // Humidity score  (0-30)
  int humScore;
  if (humidity > 85)      humScore = 30;
  else if (humidity > 70) humScore = 15;
  else                     humScore = 5;

  // Proximity score  (0-30, capped)
  int proxScore = min(proximityCount * 10, 30);

  return tempScore + humScore + proxScore;
}

/* ================================================================
 *  STATE MACHINE
 * ================================================================ */
void updateState() {
  if (currentState == ACKNOWLEDGED) {
    // Stay acknowledged until risk normalises
    if (riskScore < 30) {
      currentState = SAFE;
      alertSent    = false;
    }
    return;
  }

  if (manualOverride) return;  // freeze state if override active

  // Determine base state from risk
  State newState;
  if (riskScore < 30)      newState = SAFE;
  else if (riskScore < 60) newState = WARNING;
  else                      newState = CRITICAL;

  // Transitions
  if (newState == CRITICAL && !alertSent) {
    currentState  = ALERT_SENT;
    alertSent     = true;
    alertSentTime = millis();
    eventID++;

    // Blynk push notification
    Blynk.logEvent("critical_alert",
      String("CRITICAL! Risk=") + riskScore +
      " T=" + temperature + " H=" + humidity);
  }
  else if (currentState == ALERT_SENT) {
    // Check escalation timeout
    if (millis() - alertSentTime > ESCALATE_TIMEOUT) {
      currentState = ESCALATED;
      Blynk.logEvent("critical_alert", "ESCALATED — No acknowledgment!");
    }
  }
  else {
    currentState = newState;
  }
}

/* ================================================================
 *  LED CONTROL (NeoPixel)
 * ================================================================ */
void updateLED() {
  led.clear();
  uint32_t color;

  switch (currentState) {
    case SAFE:          color = led.Color(0, 255, 0);    break; // Green
    case WARNING:       color = led.Color(255, 200, 0);  break; // Yellow
    case CRITICAL:      color = led.Color(255, 0, 0);    break; // Red
    case ALERT_SENT:    // blink red
      color = (millis() / 300 % 2) ? led.Color(255, 0, 0) : led.Color(0, 0, 0);
      break;
    case ESCALATED:     color = led.Color(255, 0, 80);   break; // Magenta
    case ACKNOWLEDGED:  color = led.Color(0, 0, 255);    break; // Blue
    default:            color = led.Color(50, 50, 50);
  }

  led.setPixelColor(0, color);
  led.show();
}

/* ================================================================
 *  KEYPAD HANDLING
 * ================================================================ */
void handleKeypad() {
  if (!keypad.isPressed()) return;

  uint8_t idx = keypad.getKey();
  if (idx != 16) {  // valid key
    Serial.print("[KEYPAD] Key pressed: ");
    Serial.println(idx);

    if (currentState == ALERT_SENT || currentState == CRITICAL || currentState == ESCALATED) {
      currentState = ACKNOWLEDGED;
      alertSent    = false;
      lastAckTime  = millis();
      Serial.println("[STATE] → ACKNOWLEDGED via keypad");
    }
  }
}

/* ================================================================
 *  BLYNK PUSH
 * ================================================================ */
void sendToBlynk() {
  Blynk.virtualWrite(V0, temperature);
  Blynk.virtualWrite(V1, humidity);
  Blynk.virtualWrite(V2, riskScore);
  Blynk.virtualWrite(V3, (int)currentState);
  Blynk.virtualWrite(V7, (currentState == SAFE)    ? 1 :
                          (currentState == WARNING) ? 2 :
                          (currentState == CRITICAL || currentState == ALERT_SENT) ? 3 : 4);
}

/* ---------- Blynk Remote Handlers ---------- */
BLYNK_WRITE(V4) {   // Acknowledge button
  if (param.asInt() == 1) {
    if (currentState == ALERT_SENT || currentState == CRITICAL || currentState == ESCALATED) {
      currentState = ACKNOWLEDGED;
      alertSent    = false;
      lastAckTime  = millis();
      Serial.println("[BLYNK] → ACKNOWLEDGED remotely");
    }
  }
}

BLYNK_WRITE(V5) {   // Emergency Reset
  if (param.asInt() == 1) {
    currentState = SAFE;
    alertSent    = false;
    Serial.println("[BLYNK] → RESET to SAFE");
  }
}

BLYNK_WRITE(V6) {   // Manual Override Toggle
  manualOverride = (param.asInt() == 1);
  Serial.print("[BLYNK] Manual override: ");
  Serial.println(manualOverride ? "ON" : "OFF");
}

/* ================================================================
 *  THINGSPEAK PUSH
 * ================================================================ */
void sendToThingSpeak() {
  ThingSpeak.setField(1, temperature);
  ThingSpeak.setField(2, humidity);
  ThingSpeak.setField(3, riskScore);
  ThingSpeak.setField(4, proximityCount);
  ThingSpeak.setField(5, (int)currentState);
  ThingSpeak.setField(6, (int)(currentState == ACKNOWLEDGED));
  ThingSpeak.setField(7, (long)eventID);
  ThingSpeak.setField(8, (lastAckTime > 0 && alertSentTime > 0)
                          ? (float)(lastAckTime - alertSentTime) / 1000.0f
                          : 0.0f);

  int status = ThingSpeak.writeFields(channelID, writeAPIKey);
  Serial.print("[TS] Write status: ");
  Serial.println(status);
}

/* ================================================================
 *  SERIAL MONITOR LOGGING
 * ================================================================ */
void logToSerial() {
  Serial.println("─────────────────────────────");
  Serial.print("Temp: ");      Serial.print(temperature);  Serial.print(" °C | ");
  Serial.print("Hum: ");       Serial.print(humidity);     Serial.print(" % | ");
  Serial.print("Prox: 0b");    Serial.print(proximityByte, BIN);
  Serial.print(" (");          Serial.print(proximityCount); Serial.println(" active)");
  Serial.print("Risk: ");      Serial.print(riskScore);    Serial.print(" | ");
  Serial.print("State: ");     Serial.println(currentState);
}

/* ================================================================
 *  SETUP
 * ================================================================ */
void setup() {
  Serial.begin(115200);
  Serial.println("\n========== CrisisBridge v1.0 ==========");

  // I2C
  Wire.begin();

  // Sensors
  dht.begin();
  keypad.begin();

  // NeoPixel
  led.begin();
  led.setBrightness(60);
  led.show();

  // WiFi + Blynk
  Blynk.begin(BLYNK_AUTH_TOKEN, ssid, pass);

  // ThingSpeak
  ThingSpeak.begin(tsClient);

  Serial.println("[BOOT] System ready.");
}

/* ================================================================
 *  MAIN LOOP — non-blocking, timer-driven
 * ================================================================ */
void loop() {
  Blynk.run();

  unsigned long now = millis();

  // ── Sensor read (every 2 s) ──
  if (now - lastSensorRead >= SENSOR_INTERVAL) {
    lastSensorRead = now;

    readSensors();
    riskScore = calculateRisk();
    updateState();
    updateLED();
    handleKeypad();
    logToSerial();
  }

  // ── Blynk push (every 2 s) ──
  if (now - lastBlynkPush >= BLYNK_INTERVAL) {
    lastBlynkPush = now;
    sendToBlynk();
  }

  // ── ThingSpeak push (every 20 s) ──
  if (now - lastThingSpeak >= TS_INTERVAL) {
    lastThingSpeak = now;
    sendToThingSpeak();
  }

  // ── LED stays animated (called every loop for blink effect) ──
  updateLED();
}
