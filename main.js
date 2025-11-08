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
        const nameMatch = text.match(/^(.*?) ID /);
        const idMatch = text.match(/ID\s+([A-F0-9]+)/i);
        const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+)/);
        const tempMatches = [...text.matchAll(/Temperatur(?:\s+Innen)?\s+([\d,.-]+)\s*C/gi)];
        const humMatches = [...text.matchAll(/Luftfeuchte(?:\s+Innen)?\s+([\d,.-]+)\s*%/gi)];

        if (!nameMatch) return;
        const name = nameMatch[1].trim();
        const id = idMatch ? idMatch[1] : null;
        const timestamp = timeMatch ? timeMatch[1].trim() : null;

        // Innen/Außen-Logik
        if (text.includes('Temperatur Außen')) {
          const tempOut = parseFloat((text.match(/Temperatur Außen\s+([\d,.-]+)/) || [])[1]?.replace(',', '.') || 'NaN');
          const humOut = parseFloat((text.match(/Luftfeuchte Außen\s+([\d,.-]+)/) || [])[1]?.replace(',', '.') || 'NaN');
          const tempIn = parseFloat((text.match(/Temperatur Innen\s+([\d,.-]+)/) || [])[1]?.replace(',', '.') || 'NaN');
          const humIn = parseFloat((text.match(/Luftfeuchte Innen\s+([\d,.-]+)/) || [])[1]?.replace(',', '.') || 'NaN');

          sensors.push({ name: `${name}_Innen`, temperature: tempIn, humidity: humIn, timestamp, id });
          sensors.push({ name: `${name}_Außen`, temperature: tempOut, humidity: humOut, timestamp, id });
        } else {
          const temp = tempMatches[0] ? parseFloat(tempMatches[0][1].replace(',', '.')) : NaN;
          const hum = humMatches[0] ? parseFloat(humMatches[0][1].replace(',', '.')) : NaN;
          sensors.push({ name, temperature: temp, humidity: hum, timestamp, id });
        }
      });

      if (!sensors.length) {
        this.log.warn('Keine Sensoren gefunden. Prüfe die PhoneID oder Portal-Seite.');
        return;
      }

      for (const sensor of sensors) {
        const sid = sensor.name.replace(/\s+/g, '_');
        await this.setObjectNotExistsAsync(sid, {
          type: 'channel',
          common: { name: sensor.name },
          native: {},
        });

        const states = {
          temperature: { val: isNaN(sensor.temperature) ? null : sensor.temperature, unit: '°C' },
          humidity: { val: isNaN(sensor.humidity) ? null : sensor.humidity, unit: '%' },
          timestamp: { val: sensor.timestamp || '', unit: '' },
          id: { val: sensor.id || '', unit: '' },
        };

        for (const [key, value] of Object.entries(states)) {
          await this.setObjectNotExistsAsync(`${sid}.${key}`, {
            type: 'state',
            common: { name: key, type: 'string', role: 'value', read: true, write: false, unit: value.unit },
            native: {},
          });
          await this.setStateAsync(`${sid}.${key}`, { val: value.val, ack: true });
        }
      }

      this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert.`);
      await this.setStateAsync('info.connection', { val: true, ack: true });
    } catch (err) {
      this.log.error(`Fehler beim Abruf: ${err.message}`);
      await this.setStateAsync('info.connection', { val: false, ack: true });
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
