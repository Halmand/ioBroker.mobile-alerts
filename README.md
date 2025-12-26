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

Mitentwickelt von: Code GPT (PulsR AI) and DeepSeek
Lizenz: MIT License

---
🧾 CHANGELOG

## **1.0.9 (2025-12-26)
🚀 Neue Funktionen & Major Improvements
Multi-Sensor-Unterstützung für Geräte mit mehreren Temperatur-/Feuchtesensoren

Erkennt automatisch: Temp In, Hum In, Temp 1, Hum 1, Temp 2, Hum 2, etc.

Speichert als: temperature, humidity, temperature_1, humidity_1, etc.

Neue Objektstruktur: Phone_<ID>.<Sensorname> für bessere Organisation

Verbesserte Regensensor-Erkennung mit Unterstützung für:

Einfaches Format: Regen: 0,3 mm

Gesamtregen: Regen Gesamt: 5,2 mm

Regenrate: Regen Rate: 2,1 mm/h

🔧 Bugfixes & Optimierungen
HTML-Parsing komplett überarbeitet für beide Mobile-Alerts-Seitenstrukturen:

Alte Struktur: div.sensor, table.table

Neue Struktur: H4-Elemente mit nachfolgenden Datenzeilen

Fehlerkorrektur: phoneldPattern is not defined Fehler behoben

Robuste Sensornamen-Extraktion aus verschiedensten HTML-Formaten

Bessere Batterie-Status-Erkennung für alle Sensortypen

Stabilere Verbindungshandhabung mit verbesserten Timeouts

📊 Kleinere Verbesserungen
Verbesserte Log-Ausgaben mit aussagekräftigeren Meldungen

Konsistente Datenformate für alle Sensortypen

Fallback-Parsing für ältere Mobile-Alerts-Installationen

Optimierte Performance durch effizientere HTML-Verarbeitung


## **1.0.8 (2025-12-22)**

🧭 Winddaten korrigiert
Windrichtung wird jetzt korrekt als Grad + Text erkannt (225° Südwest)
Verhindert, dass die Geschwindigkeit fälschlich im Feld wind_dir landet

💨 Kompatibel mit allen Wetterstationen (MA10006, MA10660, MA10665 usw.)

💧 Wassersensor-Erkennung weiterhin aktiv

🧭 Wassersensor-Erkennung	erkennt automatisch “trocken” / “feucht” und legt den booleschen Wert wet an

🌡️ Unterscheidung Kabelsensor	wenn keine Feuchtigkeitsbegriffe vorkommen → temperature_cable

🪫 Batterieprüfung verbessert	erkennt auch englische Meldungen

🧩 Voll kompatibel mit bisherigen Objekten	keine Brüche in ioBroker

⚙️ Stabiler Parser	robust gegen neue HTML-Strukturen


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
