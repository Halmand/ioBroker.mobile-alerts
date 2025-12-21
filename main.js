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

        // 🌡️ Temperatur & Feuchte
        const tempIn = text.match(/Temperatur(?: Innen)?\s+([\d,.-]+)\s*C/i);
        const humIn = text.match(/Luftfeuchte(?: Innen)?\s+([\d,.-]+)\s*%/i);
        const tempOut = text.match(/Temperatur Außen\s+([\d,.-]+)\s*C/i);
        const humOut = text.match(/Luftfeuchte Außen\s+([\d,.-]+)\s*%/i);
        const tempCable = text.match(/Temperatur Kabelsensor\s+([\d,.-]+)\s*C/i);

        if (tempIn) data.temperature = parseFloat(tempIn[1].replace(',', '.'));
        if (humIn) data.humidity = parseFloat(humIn[1].replace(',', '.'));
        if (tempOut) data.temperature_out = parseFloat(tempOut[1].replace(',', '.'));
        if (humOut) data.humidity_out = parseFloat(humOut[1].replace(',', '.'));
        if (tempCable) data.temperature_cable = parseFloat(tempCable[1].replace(',', '.'));

        // 💧 Feuchtesensor (trocken/feucht)
        const wetMatch = text.match(/(trocken|feucht)/i);
        if (wetMatch) data.wet = wetMatch[1].toLowerCase() === 'feucht';

        // 🌧️ Regen
        const rainTotal = text.match(/Gesamt\s+([\d,.-]+)\s*mm/i);
        const rainRate = text.match(/Rate\s+([\d,.-]+)\s*mm\/h/i);
        if (rainTotal) data.rain_total = parseFloat(rainTotal[1].replace(',', '.'));
        if (rainRate) data.rain_rate = parseFloat(rainRate[1].replace(',', '.'));

        // 🌬️ Wind
        const windSpeed = text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i);
        const windGust = text.match(/Böe\s+([\d,.-]+)\s*m\/s/i);
        const windMixed = text.match(/(\d{1,3})°\s*([A-Za-zäöüß]+)/i);
        const windDirOnly = text.match(/Windrichtung\s+([A-Za-zäöüß]+|\d{1,3}°)/i);

        if (windSpeed) data.wind_speed = this.convertWind(parseFloat(windSpeed[1].replace(',', '.')));
        if (windGust) data.wind_gust = this.convertWind(parseFloat(windGust[1].replace(',', '.')));
        if (windMixed) data.wind_dir = `${windMixed[1]}° ${windMixed[2]}`;
        else if (windDirOnly) data.wind_dir = windDirOnly[1];

        sensors.push({ name, ...data });
      });

      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für ${phoneId}`);
        return;
      }

      // Objektstruktur aufbauen
      for (const sensor of sensors) {
        const base = `${phoneId}.${sensor.name.replace(/\s+/g, '_')}`;

        await this.setObjectNotExistsAsync(base, {
          type: 'channel',
          common: { name: sensor.name },
          native: { phoneId },
        });

        for (const [key, val] of Object.entries(sensor)) {
          if (['name'].includes(key)) continue;

          await this.setObjectNotExistsAsync(`${base}.${key}`, {
            type: 'state',
            common: {
              name: key,
              type: typeof val === 'number' ? 'number' : 'string',
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

      this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für ${phoneId}.`);
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
