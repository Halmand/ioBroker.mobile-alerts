# ioBroker.mobile-alerts

![Logo](admin/mobile-alerts.png)

### 🌦️ Mobile Alerts Sensor Ausleser für ioBroker

Dieser Adapter liest **Temperatur-, Feuchtigkeits-, Regen-, Wind- und Bodensensoren**  
aus dem Online-Portal [mobile-alerts.eu](https://measurements.mobile-alerts.eu) aus  
und stellt die Werte in ioBroker als Datenpunkte bereit.

---

## 🧩 Funktionen

- Unterstützt **mehrere PhoneIDs** (mehrere Gateways)
- Liest automatisch:
  - 🌡️ Temperatur (innen/außen)
  - 💧 Luftfeuchtigkeit
  - 🌬️ Windgeschwindigkeit, Böen, Richtung
  - 🌧️ Regenmenge
  - 🔋 Batteriestatus
  - 🕒 Zeitstempel pro Sensor
- Unterstützt Einheiten für Wind:
  - `m/s`, `km/h`, `bft`
- JSON-Konfiguration über Admin-Oberfläche
- Getrennte Objektstruktur nach PhoneID und Sensorname

---

## ⚙️ Installation

### Variante 1 – GitHub (empfohlen für Tests)
```bash
cd /opt/iobroker
iobroker url "https://github.com/Halmand/ioBroker.mobile-alerts.git"
