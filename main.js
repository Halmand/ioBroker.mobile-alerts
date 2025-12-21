'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

class MobileAlerts extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: 'mobile-alerts',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    const phoneIds = (this.config.phoneId || '').split(',').map(p => p.trim()).filter(Boolean);
    const pollInterval = this.config.pollInterval || 300;
    this.windUnit = this.config.windUnit || 'm/s';

    if (!phoneIds.length) {
      this.log.error('Keine PhoneID angegeben!');
      return;
    }

    for (const id of phoneIds) await this.fetchData(id);

    this.pollTimer = setInterval(() => {
      phoneIds.forEach(id => this.fetchData(id).catch(err => {
        this.log.error(`Fehler im Polling für ${id}: ${err.message}`);
      }));
    }, pollInterval * 1000);
  }

  async onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.log.info('Adapter wurde gestoppt');
      callback();
    } catch (err) {
      callback();
    }
  }

  async fetchData(phoneId) {
    try {
      const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${phoneId}`;
      const res = await axios.get(url, { 
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      const html = res.data;
      const $ = cheerio.load(html);

      const sensors = [];

      // Versuche verschiedene HTML-Strukturen
      // Methode 1: Suche nach Sensor-Containern mit h4-Überschriften
      $('h4').each((i, el) => {
        const $h4 = $(el);
        const sensorName = $h4.text().trim();
        if (!sensorName || this.isInvalidName(sensorName)) return;

        // Nächsten Container mit Sensor-Daten finden
        const $container = $h4.closest('div') || $h4.parent();
        const containerText = $container.text().trim().replace(/\s+/g, ' ');
        
        this.parseSensorData(sensorName, containerText, sensors);
      });

      // Methode 2: Suche nach Tabellen
      $('table.table').each((i, table) => {
        const $table = $(table);
        const tableText = $table.text().trim().replace(/\s+/g, ' ');
        
        // Sensor-Name aus Tabelle extrahieren
        const nameMatch = tableText.match(/^([^0-9\n]+?)\s*(ID|Zeitpunkt)/i);
        if (nameMatch) {
          const sensorName = nameMatch[1].trim();
          if (!this.isInvalidName(sensorName)) {
            this.parseSensorData(sensorName, tableText, sensors);
          }
        }
      });

      // Methode 3: Suche nach div.sensor Elementen
      $('div.sensor').each((i, el) => {
        const $el = $(el);
        const elementText = $el.text().trim().replace(/\s+/g, ' ');
        
        // Sensor-Name aus div.sensor extrahieren
        const nameMatch = elementText.match(/^([^0-9\n]+?)\s*(ID|Zeitpunkt)/i);
        if (nameMatch) {
          const sensorName = nameMatch[1].trim();
          if (!this.isInvalidName(sensorName)) {
            this.parseSensorData(sensorName, elementText, sensors);
          }
        }
      });

      // Durchschnittswerte extrahieren
      const bodyText = $('body').text().replace(/\s+/g, ' ');
      const avgMatches = bodyText.match(/Durchschn\.?\s*Luftf\.?\s*3H\s*([\d.]+|OFL)%\s*Durchschn\.?\s*Luftf\.?\s*24H\s*([\d.]+|OFL)%\s*Durchschn\.?\s*Luftf\.?\s*7D\s*([\d.]+|OFL)%\s*Durchschn\.?\s*Luftf\.?\s*30D\s*([\d.]+|OFL)%/i);
      
      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für ${phoneId}`);
        return;
      }

      // 💾 Bestehende Struktur bereinigen - entferne falsche Objekte
      await this.cleanupOldObjects(phoneId, sensors.map(s => s.name));

      // 💾 Objekte unter PhoneID > Sensorname
      for (const sensor of sensors) {
        const base = `${phoneId}.${sensor.name.replace(/\s+/g, '_')}`;

        await this.setObjectNotExistsAsync(base, {
          type: 'channel',
          common: { name: sensor.name },
          native: { phoneId, sensorId: sensor.id },
        });

        for (const [key, val] of Object.entries(sensor)) {
          if (['name', 'id'].includes(key)) continue;

          await this.setObjectNotExistsAsync(`${base}.${key}`, {
            type: 'state',
            common: {
              name: key,
              type: typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string',
              role: this.mapRole(key),
              read: true,
              write: false,
              unit: this.mapUnit(key),
            },
            native: {},
          });

          await this.setStateAsync(`${base}.${key}`, { val, ack: true });
        }
      }

      // Durchschnittswerte speichern
      if (avgMatches) {
        const avgBase = `${phoneId}.Durchschnittswerte`;
        
        await this.setObjectNotExistsAsync(avgBase, {
          type: 'channel',
          common: { 
            name: 'Durchschnittswerte',
            desc: 'Durchschnittliche Luftfeuchtigkeitswerte'
          },
          native: {},
        });

        const averages = {
          humidity_avg_3h: avgMatches[1] === 'OFL' ? null : this.parseNumber(avgMatches[1]),
          humidity_avg_24h: avgMatches[2] === 'OFL' ? null : this.parseNumber(avgMatches[2]),
          humidity_avg_7d: avgMatches[3] === 'OFL' ? null : this.parseNumber(avgMatches[3]),
          humidity_avg_30d: avgMatches[4] === 'OFL' ? null : this.parseNumber(avgMatches[4]),
        };

        for (const [key, val] of Object.entries(averages)) {
          if (val !== null) {
            await this.setObjectNotExistsAsync(`${avgBase}.${key}`, {
              type: 'state',
              common: {
                name: this.getFriendlyName(key),
                type: 'number',
                role: 'value.humidity',
                read: true,
                write: false,
                unit: '%',
              },
              native: {},
            });

            await this.setStateAsync(`${avgBase}.${key}`, { val, ack: true });
          }
        }
      }

      this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für ${phoneId}.`);
      await this.setStateAsync('info.connection', { val: true, ack: true });
    } catch (err) {
      this.log.error(`Fehler beim Abruf für ${phoneId}: ${err.message}`);
      await this.setStateAsync('info.connection', { val: false, ack: true });
    }
  }

  parseSensorData(sensorName, text, sensors) {
    // Sensor-ID extrahieren
    const idMatch = text.match(/ID\s+([A-F0-9]{8,})/i);
    const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+\d{4})/);
    const id = idMatch ? idMatch[1] : null;
    const timestamp = timeMatch ? timeMatch[1].trim() : null;

    let battery = 'ok';
    if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';

    const data = { id, timestamp, battery };

    // Temperatur & Feuchte
    const tempIn = text.match(/Temperatur(?: Innen)?\s+([\d,.-]+)\s*C/i);
    const humIn = text.match(/Luftfeuchte(?: Innen)?\s+([\d,.-]+)\s*%/i);
    const tempOut = text.match(/Temperatur Außen\s+([\d,.-]+)\s*C/i);
    const humOut = text.match(/Luftfeuchte Außen\s+([\d,.-]+)\s*%/i);
    const tempCable = text.match(/Temperatur Kabelsensor\s+([\d,.-]+)\s*C/i);

    if (tempIn) data.temperature = this.parseNumber(tempIn[1]);
    if (humIn) data.humidity = this.parseNumber(humIn[1]);
    if (tempOut) data.temperature_out = this.parseNumber(tempOut[1]);
    if (humOut) data.humidity_out = this.parseNumber(humOut[1]);
    if (tempCable) data.temperature_cable = this.parseNumber(tempCable[1]);

    // Regen (einfaches Format "Regen: X mm")
    const rainMatch = text.match(/Regen\s+([\d,.-]+)\s*mm/i);
    if (rainMatch) {
      data.rain = this.parseNumber(rainMatch[1]);
    }

    // Regen (erweitertes Format)
    const rainTotal = text.match(/Gesamt\s+([\d,.-]+)\s*mm/i);
    const rainRate = text.match(/Rate\s+([\d,.-]+)\s*mm\/h/i);
    if (rainTotal) data.rain_total = this.parseNumber(rainTotal[1]);
    if (rainRate) data.rain_rate = this.parseNumber(rainRate[1]);

    // Wind
    const windSpeed = text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i);
    const windGust = text.match(/Böe\s+([\d,.-]+)\s*m\/s/i);
    const windDir = text.match(/Windrichtung\s+([A-Za-zäöüß]+|\d{1,3}°)/i);
    if (windSpeed) data.wind_speed = this.convertWind(this.parseNumber(windSpeed[1]));
    if (windGust) data.wind_gust = this.convertWind(this.parseNumber(windGust[1]));
    if (windDir) data.wind_dir = windDir[1];

    // Feuchtesensor
    const wetMatch = text.match(/(trocken|feucht)/i);
    if (wetMatch) data.wet = wetMatch[1].toLowerCase() === 'feucht';

    // Nur Sensoren mit Daten hinzufügen
    if (Object.keys(data).length > 3) { // Mindestens mehr als nur id, timestamp, battery
      sensors.push({ name: sensorName, ...data });
    }
  }

  isInvalidName(name) {
    // Prüfe, ob der Name ungültig ist (nur Zahlen, Hexadezimal-Codes, Einheiten, etc.)
    const invalidPatterns = [
      /^\d+$/, // Nur Zahlen
      /^[A-F0-9]{8,}$/i, // Hex-Codes (Sensor-IDs)
      /^\d+\.\d+\s*(°C|C|m\/s|ms|mm|%)$/i, // Werte mit Einheiten
      /^\.\d+\s*/, // Dezimalzahlen
      /^-?\d+$/, // Negative Zahlen
      /^\d+\s*ms$/i, // Millisekunden
      /^\d+\s*C$/i, // Celsius ohne °
      /^\d+\s*mm$/i, // Millimeter
      /^Durchschnittswerte$/i,
      /^Oststdost$/i
    ];
    
    return invalidPatterns.some(pattern => pattern.test(name.trim()));
  }

  async cleanupOldObjects(phoneId, validSensorNames) {
    try {
      // Hole alle existierenden Objekte für diese PhoneID
      const objects = await this.getForeignObjectsAsync(`${this.namespace}.${phoneId}.*`, 'channel');
      
      if (objects) {
        const validNames = validSensorNames.map(name => name.replace(/\s+/g, '_'));
        
        for (const objId in objects) {
          const parts = objId.split('.');
          const sensorName = parts[parts.length - 1];
          
          // Lösche Objekt, wenn es kein gültiger Sensor-Name ist
          if (!validNames.includes(sensorName) && 
              !['Durchschnittswerte', 'info'].includes(sensorName)) {
            
            // Lösche alle States unter diesem Channel zuerst
            const states = await this.getForeignObjectsAsync(`${objId}.*`, 'state');
            if (states) {
              for (const stateId in states) {
                await this.delForeignObjectAsync(stateId);
              }
            }
            
            // Dann lösche den Channel
            await this.delForeignObjectAsync(objId);
            this.log.debug(`Ungültiges Objekt gelöscht: ${sensorName}`);
          }
        }
      }
    } catch (err) {
      this.log.warn(`Fehler beim Bereinigen alter Objekte: ${err.message}`);
    }
  }

  parseNumber(str) {
    if (!str) return null;
    const num = parseFloat(str.replace(',', '.'));
    return isNaN(num) ? null : num;
  }

  convertWind(v) {
    if (v === null || v === undefined) return v;
    if (this.windUnit === 'km/h') return +(v * 3.6).toFixed(1);
    if (this.windUnit === 'bft') return +Math.round(Math.pow(v / 0.836, 2 / 3));
    return v;
  }

  mapRole(k) {
    if (k.includes('temperature')) return 'value.temperature';
    if (k.includes('humidity')) return 'value.humidity';
    if (k.includes('rain')) return 'value.rain';
    if (k.includes('wind')) return 'value.wind';
    if (k.includes('battery')) return 'indicator.battery';
    if (k.includes('timestamp')) return 'value.time';
    if (k === 'wet') return 'sensor.water';
    return 'state';
  }

  mapUnit(k) {
    if (k.includes('temperature')) return '°C';
    if (k.includes('humidity')) return '%';
    if (k.includes('rain')) return 'mm';
    if (k.includes('wind')) {
      if (this.windUnit === 'km/h') return 'km/h';
      if (this.windUnit === 'bft') return 'Bft';
      return 'm/s';
    }
    return '';
  }

  getFriendlyName(k) {
    const names = {
      humidity_avg_3h: 'Durchschnitt Luftfeuchte 3H',
      humidity_avg_24h: 'Durchschnitt Luftfeuchte 24H',
      humidity_avg_7d: 'Durchschnitt Luftfeuchte 7D',
      humidity_avg_30d: 'Durchschnitt Luftfeuchte 30D',
    };
    return names[k] || k.replace(/_/g, ' ');
  }
}

if (require.main !== module) {
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
