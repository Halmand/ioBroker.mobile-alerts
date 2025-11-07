const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

class MobileAlerts extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: 'mobile-alerts'
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

    // Wiederholung im Intervall
    this.pollTimer = setInterval(() => this.fetchData(phoneId), pollInterval * 1000);
  }

  async fetchData(phoneId) {
    try {
      const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${phoneId}`;
      const response = await axios.get(url, { timeout: 10000 });
      const html = response.data;
      const $ = cheerio.load(html);

      const sensors = [];

      $('div.sensor').each((i, el) => {
        const name = $(el).find('.name').text().trim();
        const temperature = $(el).find('.temperature .value').text().trim();
        const humidity = $(el).find('.humidity .value').text().trim();
        const battery = $(el).find('.battery').text().includes('low') ? 'low' : 'ok';
        const timestamp = $(el).find('.time').text().trim();

        sensors.push({ name, temperature, humidity, battery, timestamp });
      });

      if (!sensors.length) {
        this.log.warn('Keine Sensoren gefunden. Prüfe die PhoneID oder Portal-Seite.');
        return;
      }

      for (const sensor of sensors) {
        const sid = sensor.name.replace(/\s+/g, '_');
        await this.setObjectNotExistsAsync(sid, { type: 'channel', common: { name: sensor.name }, native: {} });

        await this.setStateAsync(`${sid}.temperature`, { val: parseFloat(sensor.temperature), ack: true });
        await this.setStateAsync(`${sid}.humidity`, { val: parseFloat(sensor.humidity), ack: true });
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
