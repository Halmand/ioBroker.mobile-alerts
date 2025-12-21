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
    const phoneIds = (this.config.phoneId || '').split(',').map(p => p.trim()).filter(Boolean);
    const pollInterval = this.config.pollInterval || 300;
    this.windUnit = this.config.windUnit || 'm/s';

    if (!phoneIds.length) {
      this.log.error('Keine PhoneID angegeben!');
      return;
    }

    for (const id of phoneIds) await this.fetchData(id);

    this.pollTimer = setInterval(() => {
      phoneIds.forEach(id => this.fetchData(id));
    }, pollInterval * 1000);
  }

  async fetchData(phoneId) {
    try {
      const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${phoneId}`;
      const res = await axios.get(url, { timeout: 15000 });
      const html = res.data;
      const $ = cheerio.load(html);

      const sensors = [];

      $('div.sensor, table.table').each((i, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (!text) return;

        const nameMatch = text.match(/ID\s+([A-F0-9]+)/i);
        const name = $(el).find('h3, .sensor-name').first().text().trim() || `Sensor_${i}`;
        const id = nameMatch ? nameMatch[1] : `unknown_${i}`;

        const data = { name, id };

        // Zeitstempel
        const ts = text.match(/Zeitpunkt\s+([\d:. ]+)/i);
        if (ts) data.timestamp = ts[1].trim();

        // Temperatur innen/außen
        const tIn = text.match(/Temperatur\s+([\d,.-]+)\s*C/i);
        if (tIn) data.temperature = parseFloat(tIn[1].replace(',', '.'));

        // Luftfeuchte
        const hIn = text.match(/Luftfeuchte\s+([\d,.-]+)\s*%/i);
        if (hIn) data.humidity = parseFloat(hIn[1].replace(',', '.'));

        // ✔ WIND FIX
        const windSpeed =
          text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i) ||
          text.match(/Wind\s+([\d,.-]+)\s*m\/s/i);

        const windGust =
          text.match(/Böe\s+([\d,.-]+)\s*m\/s/i) ||
          text.match(/Windböe[n]?\s+([\d,.-]+)\s*m\/s/i);

        const windDir = text.match(/Windrichtung\s+([A-Za-zäöüÄÖÜ ]+)/i);

        if (windSpeed) data.wind_speed = this.convertWind(parseFloat(windSpeed[1].replace(',', '.')));
        if (windGust) data.wind_gust = this.convertWind(parseFloat(windGust[1].replace(',', '.')));
        if (windDir) data.wind_dir = windDir[1].trim();

        // ✔ REGEN FIX
        const rain = text.match(/Regen\s+([\d,.]+)\s*mm/i);
        if (rain) data.rain = parseFloat(rain[1].replace(',', '.'));

        sensors.push(data);
      });

      const phoneBase = `Phone_${phoneId}`;
      await this.setObjectNotExistsAsync(phoneBase, {
        type: 'channel',
        common: { name: phoneBase },
        native: {},
      });

      for (const sensor of sensors) {
        const sensorBase = `${phoneBase}.${sensor.name.replace(/\s+/g, '_')}`;

        await this.setObjectNotExistsAsync(sensorBase, {
          type: 'channel',
          common: { name: sensor.name },
          native: { phoneId },
        });

        for (const [key, val] of Object.entries(sensor)) {
          if (key === 'name') continue;

          await this.setObjectNotExistsAsync(`${sensorBase}.${key}`, {
            type: 'state',
            common: {
              name: key,
              type: typeof val,
              role: this.mapRole(key),
              read: true,
              write: false,
              unit: this.mapUnit(key),
            },
            native: {},
          });

          await this.setStateAsync(`${sensorBase}.${key}`, { val, ack: true });
        }
      }

      this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für Phone_${phoneId}.`);
      await this.setStateAsync('info.connection', { val: true, ack: true });

    } catch (err) {
      this.log.error(`Fehler beim Abruf für ${phoneId}: ${err.message}`);
      await this.setStateAsync('info.connection', { val: false, ack: true });
    }
  }

  convertWind(v) {
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
}

if (require.main !== module) {
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
