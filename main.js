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

        const nameMatch = text.match(/^(.*?) ID /);
        const idMatch = text.match(/ID\s+([A-F0-9]+)/i);
        const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+)/);
        const id = idMatch ? idMatch[1] : null;
        const timestamp = timeMatch ? timeMatch[1].trim() : null;

        let battery = 'ok';
        if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';

        const name = nameMatch ? nameMatch[1].trim() : `Sensor_${i + 1}`;
        const data = { id, timestamp, battery };

        const num = x => parseFloat(x.replace(',', '.'));

        const tIn = text.match(/Temperatur(?: Innen)?\s+([\d,.-]+)\s*C/i);
        const hIn = text.match(/Luftfeuchte(?: Innen)?\s+([\d,.-]+)\s*%/i);
        const tOut = text.match(/Temperatur Außen\s+([\d,.-]+)\s*C/i);
        const hOut = text.match(/Luftfeuchte Außen\s+([\d,.-]+)\s*%/i);
        const tCable = text.match(/Temperatur Kabelsensor\s+([\d,.-]+)\s*C/i);

        if (tIn) data.temperature = num(tIn[1]);
        if (hIn) data.humidity = num(hIn[1]);
        if (tOut) data.temperature_out = num(tOut[1]);
        if (hOut) data.humidity_out = num(hOut[1]);
        if (tCable) data.temperature_cable = num(tCable[1]);

        // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
        // ✔ FIX: WIND (Windgeschwindigkeit, Böe, Windrichtung)
        // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
        const windSpeed =
          text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i) ||
          text.match(/Wind\s+([\d,.-]+)\s*m\/s/i);

        const windGust =
          text.match(/Böe\s+([\d,.-]+)\s*m\/s/i) ||
          text.match(/Windböe[n]?\s+([\d,.-]+)\s*m\/s/i);

        const windDir = text.match(/Windrichtung\s+([A-Za-zäöüÄÖÜ ]+)/i);

        if (windSpeed) data.wind_speed = this.convertWind(parseFloat(windSpeed[1].replace(',', '.')));
        if (windGust)  data.wind_gust  = this.convertWind(parseFloat(windGust[1].replace(',', '.')));
        if (windDir)   data.wind_dir   = windDir[1].trim();

        // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
        // ✔ FIX: HUMIDITY-AVERAGES nur wenn vorhanden
        // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
        const avg3h  = text.match(/Durchschn\.?\s+Luftf\.?\s*3H\s+([\d,.-]+|OFL)\s*%/i);
        const avg24h = text.match(/Durchschn\.?\s+Luftf\.?\s*24H\s+([\d,.-]+|OFL)\s*%/i);
        const avg7d  = text.match(/Durchschn\.?\s+Luftf\.?\s*7D\s+([\d,.-]+|OFL)\s*%/i);
        const avg30d = text.match(/Durchschn\.?\s+Luftf\.?\s*30D\s+([\d,.-]+|OFL)\s*%/i);

        if (avg3h)  data.humidity_avg_3h  = avg3h[1] === 'OFL' ? null : num(avg3h[1]);
        if (avg24h) data.humidity_avg_24h = avg24h[1] === 'OFL' ? null : num(avg24h[1]);
        if (avg7d)  data.humidity_avg_7d  = avg7d[1] === 'OFL' ? null : num(avg7d[1]);
        if (avg30d) data.humidity_avg_30d = avg30d[1] === 'OFL' ? null : num(avg30d[1]);
        // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

        sensors.push({ name, ...data });
      });

      const phoneBase = `Phone_${phoneId}`;

      await this.setObjectNotExistsAsync(phoneBase, {
        type: 'folder',
        common: { name: `Phone ${phoneId}` },
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
