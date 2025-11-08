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

    this.pollTimer = null;
  }

  async onReady() {
    const phoneId = this.config.phoneId;
    const pollInterval = this.config.pollInterval || 300;

    if (!phoneId) {
      this.log.error('Keine PhoneID angegeben! Bitte in den Instanzeinstellungen eintragen.');
      return;
    }

    this.log.info(`Lese Sensordaten für PhoneID ${phoneId}...`);
    await this.fetchData(phoneId);

    // Wiederhole Abruf im Intervall
    this.pollTimer = setInterval(() => this.fetchData(phoneId), pollInterval * 1000);
  }

  async fetchData(phoneId) {
    try {
      const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${phoneId}`;
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        },
      });

      const html = response.data;
      const $ = cheerio.load(html);

      const sensors = [];

      $('div.sensor').each((i, el) => {
        const name = $(el).find('.name').text().trim() || `Sensor_${i + 1}`;
        const temperature = $(el).find('.temperature .value').text().trim();
        const humidity = $(el).find('.humidity .value').text().trim();
        const battery = $(el).find('.battery').text().includes('low') ? 'low' : 'ok';
        const timestamp = $(el).find('.time').text().trim();

        sensors.push({ name, temperature, humidity, battery, timestamp });
      });

      // Fallback: falls HTML andere Struktur hat
      if (sensors.length === 0) {
        $('table.table tr').each((i, row) => {
          const cols = $(row).find('td');
          if (cols.length >= 4) {
            const name = $(cols[0]).text().trim();
            const temperature = $(cols[1]).text().trim();
            const humidity = $(cols[2]).text().trim();
            const battery = $(cols[3]).text().includes('low') ? 'low' : 'ok';
            const timestamp = cols[4] ? $(cols[4]).text().trim() : '';
            if (name && temperature) {
              sensors.push({ name, temperature, humidity, battery, timestamp });
            }
          }
        });
      }

      if (sensors.length === 0) {
        this.log.warn('Keine Sensoren gefunden. Prüfe die PhoneID oder das HTML-Layout der Seite.');
        await this.setStateAsync('info.connection', { val: false, ack: true });
        return;
      }

      for (const sensor of sensors) {
        const sid = sensor.name.replace(/\s+/g, '_');
        await this.setObjectNotExistsAsync(sid, {
          type: 'channel',
          common: { name: sensor.name },
          native: {},
        });

        await this.setObjectNotExistsAsync(`${sid}.temperature`, {
          type: 'state',
          common: { name: 'Temperatur', type: 'number', unit: '°C', role: 'value.temperature', read: true, write: false },
          native: {},
        });
        await this.setObjectNotExistsAsync(`${sid}.humidity`, {
          type: 'state',
          common: { name: 'Luftfeuchtigkeit', type: 'number', unit: '%', role: 'value.humidity', read: true, write: false },
          native: {},
        });
        await this.setObjectNotExistsAsync(`${sid}.battery`, {
          type: 'state',
          common: { name: 'Batteriestatus', type: 'string', role: 'indicator.battery', read: true, write: false },
          native: {},
        });
        await this.setObjectNotExistsAsync(`${sid}.timestamp`, {
          type: 'state',
          common: { name: 'Zeitstempel', type: 'string', role: 'date', read: true, write: false },
          native: {},
        });

        await this.setStateAsync(`${sid}.temperature`, { val: parseFloat(sensor.temperature) || null, ack: true });
        await this.setStateAsync(`${sid}.humidity`, { val: parseFloat(sensor.humidity) || null, ack: true });
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

  onUnload(callback) {
    try {
      if (this.pollTimer) clearInterval(this.pollTimer);
      callback();
    } catch (e) {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
