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

      // Erweiterte Suche nach Sensor-Blöcken
      $('div.sensor, table.table, div[class*="sensor"], div:has(h4)').each((i, el) => {
        const $el = $(el);
        const text = $el.text().trim().replace(/\s+/g, ' ');
        if (!text || text.length < 20) return;

        // Sensornamen extrahieren - verschiedene Methoden versuchen
        let sensorName = '';
        
        // Methode 1: Aus h4 oder ähnlichen Überschriften
        const $h4 = $el.find('h4, .sensor-name, strong, b').first();
        if ($h4.length) {
          sensorName = $h4.text().trim();
        }
        
        // Methode 2: Text vor "ID" suchen
        if (!sensorName) {
          const nameMatch = text.match(/^([^0-9\n]+?)\s*(ID|Zeitpunkt|Temperatur|Luftfeuchte|Regen)/i);
          if (nameMatch) {
            sensorName = nameMatch[1].trim();
          }
        }
        
        // Methode 3: Fallback
        if (!sensorName) {
          sensorName = `Sensor_${i + 1}`;
        }

        const idMatch = text.match(/ID\s+([A-F0-9]{8,})/i);
        const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+\d{4})/);
        const id = idMatch ? idMatch[1].toUpperCase() : null;
        const timestamp = timeMatch ? timeMatch[1].trim() : new Date().toLocaleString('de-DE');

        let battery = 'ok';
        if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';

        const name = this.cleanSensorName(sensorName);
        const data = { id, timestamp, battery };

        // 🌡️ Temperatur & Feuchte - verbesserte Regex
        const tempIn = text.match(/Temperatur(?: Innen)?\s*[:=]?\s*([-\d,]+)\s*°?C/i);
        const humIn = text.match(/Luftfeuchte(?: Innen)?\s*[:=]?\s*([\d,]+)\s*%/i);
        const tempOut = text.match(/Temperatur\s*Außen\s*[:=]?\s*([-\d,]+)\s*°?C/i);
        const humOut = text.match(/Luftfeuchte\s*Außen\s*[:=]?\s*([\d,]+)\s*%/i);
        const tempCable = text.match(/Temperatur\s*Kabelsensor\s*[:=]?\s*([-\d,]+)\s*°?C/i);
        
        // Allgemeine Temperatur/Luftfeuchte falls nichts spezifisches gefunden
        const tempGeneral = text.match(/Temperatur\s*[:=]?\s*([-\d,]+)\s*°?C/i);
        const humGeneral = text.match(/Luftfeuchte\s*[:=]?\s*([\d,]+)\s*%/i);

        if (tempIn) data.temperature = this.parseNumber(tempIn[1]);
        else if (tempGeneral && !tempOut && !tempCable) data.temperature = this.parseNumber(tempGeneral[1]);
        
        if (humIn) data.humidity = this.parseNumber(humIn[1]);
        else if (humGeneral && !humOut) data.humidity = this.parseNumber(humGeneral[1]);
        
        if (tempOut) data.temperature_out = this.parseNumber(tempOut[1]);
        if (humOut) data.humidity_out = this.parseNumber(humOut[1]);
        if (tempCable) data.temperature_cable = this.parseNumber(tempCable[1]);

        // 💧 Regen - verschiedene Formate
        // Format 1: "Regen: 0,3 mm"
        const rainSimple = text.match(/Regen\s*[:=]?\s*([\d,]+)\s*mm/i);
        // Format 2: "Regen Gesamt: X mm"
        const rainTotal = text.match(/Regen\s*Gesamt\s*[:=]?\s*([\d,]+)\s*mm/i);
        const rainRate = text.match(/Regen\s*Rate\s*[:=]?\s*([\d,]+)\s*mm\/h/i);
        
        if (rainSimple && !rainTotal) {
          data.rain = this.parseNumber(rainSimple[1]);
          data.rain_unit = 'mm';
        }
        if (rainTotal) data.rain_total = this.parseNumber(rainTotal[1]);
        if (rainRate) data.rain_rate = this.parseNumber(rainRate[1]);

        // 💧 Feuchtesensor (trocken/feucht)
        const wetMatch = text.match(/(trocken|feucht)/i);
        if (wetMatch) data.wet = wetMatch[1].toLowerCase() === 'feucht';

        // 🌬️ Wind
        const windSpeed = text.match(/Windgeschwindigkeit\s*[:=]?\s*([\d,]+)\s*m\/s/i);
        const windGust = text.match(/Böe\s*[:=]?\s*([\d,]+)\s*m\/s/i);
        const windDir = text.match(/Windrichtung\s*[:=]?\s*([A-Za-zäöüß]+|\d{1,3}°)/i);
        if (windSpeed) data.wind_speed = this.convertWind(this.parseNumber(windSpeed[1]));
        if (windGust) data.wind_gust = this.convertWind(this.parseNumber(windGust[1]));
        if (windDir) data.wind_dir = windDir[1];

        // Nur Sensoren mit gültigen Daten hinzufügen
        if (Object.keys(data).length > 3 || id) { // Mindestens timestamp, battery + andere Daten
          sensors.push({ name, ...data });
        }
      });

      // Durchschnittswerte aus Gesamttext extrahieren
      const bodyText = $('body').text().replace(/\s+/g, ' ');
      const avgMatches = bodyText.match(/Durchschn\.?\s*Luftf\.?\s*3H\s*([\d.]+|OFL)%\s*Durchschn\.?\s*Luftf\.?\s*24H\s*([\d.]+|OFL)%\s*Durchschn\.?\s*Luftf\.?\s*7D\s*([\d.]+|OFL)%\s*Durchschn\.?\s*Luftf\.?\s*30D\s*([\d.]+|OFL)%/i);
      
      if (avgMatches) {
        // Durchschnittswerte unter einem eigenen Kanal speichern
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

      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für ${phoneId}`);
        return;
      }

      // 💾 Objekte unter PhoneID > Sensorname - BEIBEHALTUNG DER STRUKTUR
      for (const sensor of sensors) {
        // Sensornamen genau wie in der Struktur verwenden
        const base = `${phoneId}.${sensor.name}`;

        await this.setObjectNotExistsAsync(base, {
          type: 'channel',
          common: { name: sensor.name },
          native: { phoneId, sensorId: sensor.id },
        });

        for (const [key, val] of Object.entries(sensor)) {
          if (['name'].includes(key)) continue;

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

          if (val !== null && val !== undefined) {
            await this.setStateAsync(`${base}.${key}`, { val, ack: true });
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

  cleanSensorName(name) {
    // Bereinigt den Namen, aber behält die Struktur bei
    // Ersetzt nur problematische Zeichen, behält Umlaute und Leerzeichen
    return name
      .replace(/[^\wäöüßÄÖÜ\s-]/g, '') // Nur Buchstaben, Zahlen, Leerzeichen, Bindestriche
      .replace(/\s+/g, ' ') // Mehrfache Leerzeichen reduzieren
      .trim();
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
