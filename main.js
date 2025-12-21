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
  }

  async onReady() {
    const phoneId = this.config.phoneId;
    const pollInterval = this.config.pollInterval || 300;
    this.windUnit = this.config.windUnit || 'm/s';

    if (!phoneId) {
      this.log.error('Keine PhoneID angegeben!');
      return;
    }

    this.log.info(`Lese Sensordaten für PhoneID ${phoneId}...`);
    await this.fetchData(phoneId);

    this.pollTimer = setInterval(() => this.fetchData(phoneId), pollInterval * 1000);
  }

  async fetchData(phoneId) {
    try {
      const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${phoneId}`;
      const response = await axios.get(url, { timeout: 15000 });
      const html = response.data;
      const $ = cheerio.load(html);

      const sensors = [];

      $('div.sensor, table.table').each((i, sensorEl) => {
        const text = $(sensorEl).text().trim().replace(/\s+/g, ' ');
        if (!text) return;

        const nameMatch = text.match(/^(.*?) ID /);
        const idMatch = text.match(/ID\s+([A-F0-9]+)/i);
        const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+)/);
        const id = idMatch ? idMatch[1] : null;
        const timestamp = timeMatch ? timeMatch[1].trim() : null;

        let battery = 'ok';
        if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) {
          battery = 'low';
        }

        const name = nameMatch ? nameMatch[1].trim() || `Sensor_${i + 1}` : `Sensor_${i + 1}`;
        const data = { name, id, timestamp, battery };

        // 🌡️ Temperatur & Feuchte
        const temp = text.match(/Temperatur(?: Innen)?\s+([\d,.-]+)\s*C/i);
        const hum = text.match(/Luftfeuchte(?: Innen)?\s+([\d,.-]+)\s*%/i);
        const tempCable = text.match(/Temperatur Kabelsensor\s+([\d,.-]+)\s*C/i);

        if (temp) data.temperature = parseFloat(temp[1].replace(',', '.'));
        if (hum) data.humidity = parseFloat(hum[1].replace(',', '.'));

        // 🧭 Wassersensor-Erkennung (trocken/feucht)
        const wetMatch = text.match(/(trocken|feucht)/i);
        if (wetMatch) {
          const state = wetMatch[1].toLowerCase();
          data.wet = state === 'feucht';
        } else if (tempCable) {
          data.temperature_cable = parseFloat(tempCable[1].replace(',', '.'));
        }

        // 🌧️ Regen
        const rainTotal = text.match(/Gesamt\s+([\d,.-]+)\s*mm/i);
        const rainRate = text.match(/Rate\s+([\d,.-]+)\s*mm\/h/i);
        if (rainTotal) data.rain_total = parseFloat(rainTotal[1].replace(',', '.'));
        if (rainRate) data.rain_rate = parseFloat(rainRate[1].replace(',', '.'));

        // 🌬️ Wind — verbesserte Erkennung
        const windSpeed = text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i);
        const windGust = text.match(/Böe\s+([\d,.-]+)\s*m\/s/i);
        const windDirFull = text.match(/Windrichtung\s+([\d°\wäöüß\s]+)/i);
        const windMixed = text.match(/(\d{1,3})°\s*([A-Za-zäöüß]+)/i);

        if (windSpeed) data.wind_speed = this.convertWind(parseFloat(windSpeed[1].replace(',', '.')));
        if (windGust) data.wind_gust = this.convertWind(parseFloat(windGust[1].replace(',', '.')));

        if (windMixed) {
          data.wind_dir = `${windMixed[1]}° ${windMixed[2]}`;
        } else if (windDirFull) {
          const dirVal = windDirFull[1].trim();
          // Filtern: falls aus Versehen eine Zahl mit m/s drin steht → ignorieren
          if (!/m\/s/i.test(dirVal)) {
            data.wind_dir = dirVal;
          }
        }

        // 🧲 Kontaktsensor
        const contactMatch = text.match(/Kontaktsensor\s+(\w+)/i);
        if (contactMatch) {
          const state = contactMatch[1].toLowerCase();
          data.contact = state === 'geschlossen';
        }

        sensors.push(data);
      });

      if (!sensors.length) {
        this.log.warn('Keine Sensoren gefunden. Prüfe PhoneID oder Portal-Seite.');
        return;
      }

      for (const sensor of sensors) {
        const sid = sensor.name.replace(/\s+/g, '_');
        await this.setObjectNotExistsAsync(sid, {
          type: 'channel',
          common: { name: sensor.name },
          native: {},
        });

        for (const [key, val] of Object.entries(sensor)) {
          if (['name'].includes(key)) continue;
          await this.setObjectNotExistsAsync(`${sid}.${key}`, {
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
          await this.setStateAsync(`${sid}.${key}`, { val, ack: true });
        }
      }

      this.log.info(`Sensorupdate abgeschlossen: ${sensors.length} Einträge aktualisiert.`);
      await this.setStateAsync('info.connection', { val: true, ack: true });
    } catch (err) {
      this.log.error(`Fehler beim Abruf: ${err.message}`);
      await this.setStateAsync('info.connection', { val: false, ack: true });
    }
  }

  convertWind(value) {
    switch (this.windUnit) {
      case 'km/h': return +(value * 3.6).toFixed(1);
      case 'bft':  return +Math.round(Math.pow(value / 0.836, 2 / 3));
      default:     return value;
    }
  }

  mapRole(key) {
    if (key.includes('temperature')) return 'value.temperature';
    if (key.includes('humidity')) return 'value.humidity';
    if (key.includes('rain')) return 'value.rain';
    if (key.includes('wind')) return 'value.wind';
    if (key.includes('battery')) return 'indicator.battery';
    if (key.includes('timestamp')) return 'value.time';
    if (key.includes('contact')) return 'sensor.door';
    if (key === 'wet') return 'sensor.water';
    return 'state';
  }

  mapUnit(key) {
    if (key.includes('temperature')) return '°C';
    if (key.includes('humidity')) return '%';
    if (key.includes('rain')) return 'mm';
    if (key.includes('wind')) {
      if (this.windUnit === 'km/h') return 'km/h';
      if (this.windUnit === 'bft') return 'Bft';
      return 'm/s';
    }
    return '';
  }
}

if (require.main !== module) {
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
