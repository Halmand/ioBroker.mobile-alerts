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
```
---

🧠 Konfiguration
Einstellung	Beschreibung
Phone ID(s)	Eine oder mehrere PhoneIDs vom Mobile Alerts Account, getrennt durch Kommas
Abfrageintervall (Sekunden)	Wie oft der Adapter die Werte von der Website abruft
Windgeschwindigkeitseinheit	m/s, km/h oder bft

---

🧑‍💻 Entwickler

Autor: Halmand

Mitentwickelt von: Code GPT (PulsR AI)
Lizenz: MIT License

---

🧾 Changelog
## **1.0.7 (2025-11-29)**
-kleiner Bugfix in der jsonConfig.json

---

## **1.0.6 (2025-11-28)**
### 🚀 Erweiterungen
- Unterstützung für **Temperatur-Kabelsensoren** (z. B. MA10430 / MA10860)
- Historische **Luftfeuchte-Durchschnittswerte** hinzugefügt:
  - 3 Stunden (`humidity_avg_3h`)
  - 24 Stunden (`humidity_avg_24h`)
  - 7 Tage (`humidity_avg_7d`)
  - 30 Tage (`humidity_avg_30d`)
- Automatische Konvertierung von Komma-Dezimalwerten (z. B. `24,7` → `24.7`)
- Parser für Kombi-Temperatursensoren verbessert
- Logging-Ausgabe optimiert (zeigt PhoneID pro Abruf)
- Neue Objektstruktur: `Phone_<ID>.<Sensorname>.<Messwert>`

---

## **1.0.5 (2025-11-08)**
### 🌦️ Neue Funktionen
- Unterstützung für **Wind- & Regensensoren**
  - `wind_speed`, `wind_gust`, `wind_dir`
  - `rain_total`, `rain_rate`
- Parser an HTML-Struktur von Mobile Alerts angepasst
- Unterstützung für **mehrere PhoneIDs**
- Neue Einheiten für Windgeschwindigkeit:
  - `m/s`, `km/h`, `bft`
- Verbesserte Fehlerbehandlung bei nicht erreichbarem Portal
- JSON-Admin-UI hinzugefügt
- Behebung des „404 index_m.html not found“-Fehlers

---

## **1.0.4 (2025-11-07)**
### ⚙️ Verbesserungen
- Regen-Sensor Parsing ergänzt  
- Fehlerbehandlung für unvollständige HTML-Blöcke hinzugefügt  
- Stabilität beim Mehrfach-Abruf verbessert  

---

## **1.0.3 (2025-11-05)**
### 🔧 Änderungen
- Parser vollständig überarbeitet (kompatibel mit Cheerio / Axios)
- Strukturierte Objektanlage nach Sensorname
- Admin-UI auf JSON-Konfiguration umgestellt
- Batteriestatus-Logik verbessert

---

## **1.0.2 (2025-11-02)**
### 🧩 Erste stabile Testversion
- Grundlegende Funktion:
  - Temperatur und Luftfeuchte auslesen
  - Zeitstempel speichern
  - Batteriestatus erfassen
- Unterstützung für mehrere Sensoren pro PhoneID

---

## **1.0.0 (2025-10-29)**
### 🎉 Erstveröffentlichung
- Initiale Adapterstruktur erstellt  
- iobroker.admin Integration vorbereitet  
- Basis für Sensordaten-Abruf gelegt  
