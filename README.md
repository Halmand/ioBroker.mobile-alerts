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

1.0.6 (2025-11-28)
 🚀 Erweiterungen
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


1.0.5 (2025-11-08)

Vollständige Regen- und Windsensor-Unterstützung

Parser verbessert (HTML-Anpassungen)

Mehrere PhoneIDs unterstützt

JSON Admin UI hinzugefügt

UI-404 Fehler behoben

1.0.4

Regen-Sensor Parsing ergänzt

Windgeschwindigkeit und Böen erweitert

1.0.3

Mehrere Gateways (PhoneIDs) unterstützt

Neues JSON-basiertes Admin-UI


