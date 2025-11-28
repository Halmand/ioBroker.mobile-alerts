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
    const phoneIds = (this.config.phoneId || '').split(',').map(id => id.trim()).filter(Boolean);
    const pollInterval = this.config.pollInterval || 300;
    this.windUnit = this.config.windUnit || 'm/s';

    if (!phoneIds.length) {
      this.log.error('Keine PhoneID angegeben!');
      return;
    }

    this.log.info(`Starte Abruf für ${phoneIds.length} PhoneID(s): ${phoneIds.join(', ')}`);

    for (const id of phoneIds) {
      await this.fetchData(id);
    }

    this.pollTimer = setInterval(async () => {
      for (const id of phoneIds) {
        await this.fetchData(id);
      }
    }, pollInterval * 1000);
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

        const name = nameMatch ? nameMatch[1].trim() : `Sensor_${i + 1}`;
        const data = { name, id, timestamp, battery };

        // 🌡️ Temperatur & Feuchte
        const tempIn = text.match(/Temperatur(?: Innen)?\s+([\d,.-]+)\s*C/i);
        const humIn = text.match(/Luftfeuchte(?: Innen)?\s+([\d,.-]+)\s*%/i);
        const tempOut = text.match(/Temperatur Außen\s+([\d,.-]+)\s*C/i);
        const humOut = text.match(/Luftfeuchte Außen\s+([\d,.-]+)\s*%/i);
        const tempCable = text.match(/Temperatur Kabelsensor\s+([\d,.-]+)\s*C/i);

        // 🧾 Historische Durchschnittswerte Luftfeuchtigkeit
        const hum3h = text.match(/Durchschn\.\s*Luftf\.\s*3H\s+([\d,.-]+)\s*%/i);
        const hum24h = text.match(/Durchschn\.\s*Luftf\.\s*24H\s+([\d,.-]+)\s*%/i);
        const hum7d = text.match(/Durchschn\.\s*Luftf\.\s*7D\s+([\d,.-]+)\s*%/i);
        const hum30d = text.match(/Durchschn\.\s*Luftf\.\s*30D\s+([\d,.-]+)\s*%/i);

        if (tempIn) data.temperature = parseFloat(tempIn[1].replace(',', '.'));
        if (humIn) data.humidity = parseFloat(humIn[1].replace(',', '.'));
        if (tempOut) data.temperature_out = parseFloat(tempOut[1].replace(',', '.'));
        if (humOut) data.humidity_out = parseFloat(humOut[1].replace(',', '.'));
        if (tempCable) data.temperature_cable = parseFloat(tempCable[1].replace(',', '.'));
        if (hum3h) data.humidity_avg_3h = parseFloat(hum3h[1].replace(',', '.'));
        if (hum24h) data.humidity_avg_24h = parseFloat(hum24h[1].replace(',', '.'));
        if (hum7d) data.humidity_avg_7d = parseFloat(hum7d[1].replace(',', '.'));
        if (hum30d) data.humidity_avg_30d = parseFloat(hum30d[1].replace(',', '.'));

        // 🌧️ Regen-Sensoren
        const rainTotal = text.match(/Gesamt\s+([\d,.-]+)\s*mm/i);
        const rainRate = text.match(/Rate\s+([\d,.-]+)\s*mm\/h/i);
        if (rainTotal) data.rain_total = parseFloat(rainTotal[1].replace(',', '.'));
        if (rainRate) data.rain_rate = parseFloat(rainRate[1].replace(',', '.'));

        // 🌬️ Wind-Sensoren
        const windSpeed = text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i);
        const windMax = text.match(/Böe\s+([\d,.-]+)\s*m\/s/i);
        const windDir = text.match(/Windrichtung\s+([\w\s°]+)/i);
        if (windSpeed) data.wind_speed = this.convertWind(parseFloat(windSpeed[1].replace(',', '.')));
        if (windMax) data.wind_gust = this.convertWind(parseFloat(windMax[1].replace(',', '.')));
        if (windDir) data.wind_dir = windDir[1].trim();

        sensors.push(data);
      });

      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für PhoneID ${phoneId}.`);
        return;
      }

      for (const sensor of sensors) {
        const sid = `Phone_${phoneId}.${sensor.name.replace(/\s+/g, '_')}`;
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
              type: typeof val === 'number' ? 'number' : 'string',
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

      this.log.info(`PhoneID ${phoneId}: Erfolgreich ${sensors.length} Sensor(en) aktualisiert.`);
      await this.setStateAsync('info.connection', { val: true, ack: true });
    } catch (err) {
      this.log.error(`Fehler beim Abruf für ${phoneId}: ${err.message}`);
      await this.setStateAsync('info.connection', { val: false, ack: true });
    }
  }

  convertWind(value) {
    switch (this.windUnit) {
      case 'km/h':
        return +(value * 3.6).toFixed(1);
      case 'bft':
        const bft = Math.pow(value / 0.836, 2 / 3);
        return +Math.round(bft);
      default:
        return value;
    }
  }

  mapRole(key) {
    if (key.includes('temperature')) return 'value.temperature';
    if (key.includes('humidity')) return 'value.humidity';
    if (key.includes('rain')) return 'value.rain';
    if (key.includes('wind')) return 'value.wind';
    if (key.includes('battery')) return 'indicator.battery';
    if (key.includes('timestamp')) return 'value.time';
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
