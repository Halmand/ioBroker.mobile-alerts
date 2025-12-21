'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

/* Hilfsfunktion für Zahlen */
function num(v) {
  return parseFloat(String(v).replace(',', '.'));
}

class MobileAlerts extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: 'mobile-alerts',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.pollTimer = null;
    this.windUnit = 'm/s';
  }

  async onReady() {
    const phoneIds = (this.config.phoneId || '').split(',').map(p => p.trim()).filter(Boolean);
    const pollInterval = Number(this.config.pollInterval || 300);
    this.windUnit = this.config.windUnit || 'm/s';

    if (!phoneIds.length) {
      this.log.error('Keine PhoneID angegeben!');
      return;
    }

    // initial fetch
    for (const id of phoneIds) {
      try {
        await this.fetchData(id);
      } catch (e) {
        this.log.error(`fetchData initial für ${id} failed: ${e && e.message}`);
      }
    }

    // poll timer
    this.pollTimer = setInterval(() => {
      phoneIds.forEach(id => this.fetchData(id).catch(e => this.log.debug(`fetchData error ${e && e.message}`)));
    }, pollInterval * 1000);
  }

  onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.log.info('Adapter stopped');
      callback();
    } catch (e) {
      callback();
    }
  }

  // ---------------------------
  // fetchData: holt Seite, parst Sensoren, legt States an
  // Struktur: <phoneId>.Phone_<phoneId>.<SensorName>.<feld>
  // ---------------------------
  async fetchData(phoneId) {
    try {
      if (!phoneId) {
        this.log.warn('fetchData: kein phoneId übergeben');
        return;
      }

      const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${encodeURIComponent(phoneId)}`;
      this.log.debug(`Abruf URL: ${url}`);

      const res = await axios.get(url, { timeout: 15000 });
      const html = res.data;
      const $ = cheerio.load(html);

      const sensors = [];

      $('div.sensor, table.table').each((i, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (!text) return;

        // Name / ID / Zeit
        const nameMatch = text.match(/^(.*?)\s+ID\s+/);
        const idMatch = text.match(/ID\s+([A-F0-9\-]+)/i);
        const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+)/i);
        const id = idMatch ? idMatch[1] : null;
        const timestamp = timeMatch ? timeMatch[1].trim() : null;

        let battery = 'ok';
        if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';

        const name = nameMatch ? nameMatch[1].trim() : `Sensor_${i + 1}`;
        const data = { id, timestamp, battery, _rawText: text };

        // Temperatur & Feuchte
        const tempIn = text.match(/Temperatur(?:\s*Innen)?\s+([\d,.\-]+)\s*°?\s*C/i);
        const humIn = text.match(/Luftfeuchte(?:\s*Innen)?\s+([\d,.\-]+)\s*%/i);
        const tempOut = text.match(/Temperatur(?:\s*Außen|\s*Aussen)\s+([\d,.\-]+)\s*°?\s*C/i);
        const humOut = text.match(/Luftfeuchte(?:\s*Außen|\s*Aussen)\s+([\d,.\-]+)\s*%/i);
        const tempCable = text.match(/Temperatur(?:\s*Kabelsensor|\s*Kabel)\s+([\d,.\-]+)\s*°?\s*C/i);

        if (tempIn) data.temperature = num(tempIn[1]);
        if (humIn) data.humidity = num(humIn[1]);
        if (tempOut) data.temperature_out = num(tempOut[1]);
        if (humOut) data.humidity_out = num(humOut[1]);
        if (tempCable) data.temperature_cable = num(tempCable[1]);

        // Feuchtesensor trocken/feucht
        const wetMatch = text.match(/\b(trocken|feucht)\b/i);
        if (wetMatch) data.wet = wetMatch[1].toLowerCase() === 'feucht';

        // Regen
        const rainTotal = text.match(/Gesamt\s+([\d,.\-]+)\s*mm/i);
        const rainRate = text.match(/Rate\s+([\d,.\-]+)\s*mm\/h/i);
        if (rainTotal) data.rain_total = num(rainTotal[1]);
        if (rainRate) data.rain_rate = num(rainRate[1]);

        // Wind
        const windSpeed = text.match(/Windgeschwindigkeit\s+([\d,.\-]+)\s*(m\/s|km\/h)?/i);
        const windGust = text.match(/Böe\s+([\d,.\-]+)\s*(m\/s|km\/h)?/i);
        const windDir = text.match(/Windrichtung\s+([A-Za-zäöüß]+|\d{1,3}°)/i);
        if (windSpeed) data.wind_speed = this.convertWind(num(windSpeed[1]));
        if (windGust) data.wind_gust = this.convertWind(num(windGust[1]));
        if (windDir) data.wind_dir = windDir[1];

        sensors.push({ name, ...data });
      });

      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für ${phoneId}`);
        await this.setStateAsync('info.connection', { val: false, ack: true });
        return;
      }

      // Erlaubte Ranges (einfacher Guard gegen Fantasiewerte)
      const ranges = {
        temperature: { min: -50, max: 60 },
        temperature_out: { min: -50, max: 60 },
        temperature_cable: { min: -50, max: 60 },
        humidity: { min: 0, max: 100 },
        humidity_out: { min: 0, max: 100 },
        rain_total: { min: 0, max: 100000 },
        rain_rate: { min: 0, max: 10000 },
        wind_speed: { min: 0, max: 200 },
        wind_gust: { min: 0, max: 300 },
      };

      // Objekte unter Phone_<phoneId> > Sensorname
      for (const sensor of sensors) {
        const sensorNameSafe = sensor.name.replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
        const base = `${phoneId}.Phone_${phoneId}.${sensorNameSafe}`;

        // channel for sensor
        await this.setObjectNotExistsAsync(`${base}`, {
          type: 'channel',
          common: { name: sensor.name },
          native: { phoneId },
        });

        // write fields (skip internal _rawText)
        for (const [key, val] of Object.entries(sensor)) {
          if (key === 'name' || key === '_rawText') continue;
          if (val === null || typeof val === 'undefined') continue;

          // Guard numeric ranges
          if (typeof val === 'number' && ranges[key]) {
            const r = ranges[key];
            if (isNaN(val) || val < r.min || val > r.max) {
              this.log.debug(`Wert ausgeschlossen (außerhalb range) ${base}.${key} = ${val}`);
              continue;
            }
          }

          const common = {
            name: key,
            type: typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string',
            role: this.mapRole(key),
            read: true,
            write: false,
            unit: this.mapUnit(key),
          };

          await this.setObjectNotExistsAsync(`${base}.${key}`, {
            type: 'state',
            common,
            native: {},
          });

          await this.setStateAsync(`${base}.${key}`, { val: common.type === 'number' ? Number(val) : val, ack: true });
        }
      }

      this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für ${phoneId}.`);
      await this.setStateAsync('info.connection', { val: true, ack: true });
    } catch (err) {
      this.log.error(`Fehler beim Abruf für ${phoneId}: ${err && err.message}`);
      await this.setStateAsync('info.connection', { val: false, ack: true });
    }
  }

  convertWind(v) {
    if (!v && v !== 0) return v;
    if (this.windUnit === 'km/h') return +(v * 3.6).toFixed(1);
    if (this.windUnit === 'bft') return +Math.round(Math.pow(v / 0.836, 2 / 3));
    return v;
  }

  mapRole(k) {
    const key = k.toLowerCase();
    if (key.includes('temperature')) return 'value.temperature';
    if (key.includes('humidity')) return 'value.humidity';
    if (key.includes('rain')) return 'value.rain';
    if (key.includes('wind')) return 'value.wind';
    if (key.includes('battery')) return 'indicator.battery';
    if (key.includes('timestamp') || key.includes('time')) return 'value.time';
    if (key === 'wet') return 'sensor.water';
    return 'state';
  }

  mapUnit(k) {
    const key = k.toLowerCase();
    if (key.includes('temperature')) return '°C';
    if (key.includes('humidity')) return '%';
    if (key.includes('rain')) return 'mm';
    if (key.includes('wind')) {
      if (this.windUnit === 'km/h') return 'km/h';
      if (this.windUnit === 'bft') return 'Bft';
      return 'm/s';
    }
    if (key.includes('battery')) return '%';
    return '';
  }
}

if (require.main !== module) {
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
