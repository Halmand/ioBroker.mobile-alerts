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
      const response = await axios.get(url, {
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  },
});
      const $ = cheerio.load(html);

      const sensors = [];

      $('table.table-condensed').each((i, table) => {
        const name = $(table).find('th').first().text().trim();

        const tempEl = $(table).find('td:contains("Temperature")').next().text().trim();
        const humEl = $(table).find('td:contains("Humidity")').next().text().trim();
        const battEl = $(table).find('td:contains("Battery")').next().text().trim();
        const timeEl = $(table).find('td:contains("Last update")').next().text().trim();

        if (name) {
          sensors.push({
            name,
            temperature: parseFloat(tempEl.replace(/[^\d.-]/g, '')),
            humidity: parseFloat(humEl.replace(/[^\d.-]/g, '')),
            battery: battEl.toLowerCase().includes('low') ? 'low' : 'ok',
            timestamp: timeEl,
          });
        }
      });

      if (!sensors.length) {
        this.log.warn('Keine Sensoren gefunden. Prüfe die PhoneID oder Layout der Webseite.');
        return;
      }

      for (const sensor of sensors) {
        const sid = sensor.name.replace(/\s+/g, '_');

        await this.setObjectNotExistsAsync(sid, {
          type: 'channel',
          common: { name: sensor.name },
          native: {},
        });

        await this.setStateAsync(`${sid}.temperature`, { val: sensor.temperature, ack: true });
        await this.setStateAsync(`${sid}.humidity`, { val: sensor.humidity, ack: true });
        await this.setStateAsync(`${sid}.battery`, { val: sensor.battery, ack: true });
        await this.setStateAsync(`${sid}.timestamp`, { val: sensor.timestamp, ack: true });
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
