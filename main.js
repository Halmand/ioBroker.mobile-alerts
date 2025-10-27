'use strict';
const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

class MobileAlerts extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'mobile-alerts' });
        this.pollTimer = null;
        this.phoneId = '';
        this.pollInterval = 300000;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }
    async onReady() {
        this.phoneId = this.config.phoneId || '035886772208';
        this.pollInterval = (this.config.pollInterval || 300) * 1000;
        this.log.info(`Adapter gestartet – PhoneID: ${this.phoneId}`);
        await this.updateSensors();
        this.pollTimer = setInterval(async () => await this.updateSensors(), this.pollInterval);
    }
    async updateSensors() {
        try {
            const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${this.phoneId}`;
            this.log.debug(`Rufe Daten von ${url} ab ...`);
            const response = await axios.get(url, { timeout: 15000 });
            const $ = cheerio.load(response.data);
            const sensors = [];
            $('.panel.panel-default').each((i, el) => {
                const sensorName = $(el).find('.panel-heading').text().trim();
                const temperature = $(el).find('.temperature .value').text().trim().replace('°C', '').replace(',', '.');
                const humidity = $(el).find('.humidity .value').text().trim().replace('%', '').replace(',', '.');
                const battery = $(el).find('.battery').text().trim();
                const timestamp = $(el).find('.timestamp, .time').text().trim();
                if (sensorName) {
                    sensors.push({
                        id: sensorName.replace(/\s+/g, '_'),
                        name: sensorName,
                        temperature: parseFloat(temperature) || null,
                        humidity: parseFloat(humidity) || null,
                        battery: battery || 'unknown',
                        timestamp: timestamp || new Date().toISOString()
                    });
                }
            });
            if (!sensors.length) {
                this.log.warn('Keine Sensoren gefunden. Prüfe die PhoneID.');
                return;
            }
            for (const sensor of sensors) {
                const base = `sensors.${sensor.id}`;
                await this.extendObjectAsync(base, { type: 'device', common: { name: sensor.name }, native: {} });
                const states = {
                    temperature: { name: 'Temperature', type: 'number', unit: '°C', role: 'value.temperature' },
                    humidity: { name: 'Humidity', type: 'number', unit: '%', role: 'value.humidity' },
                    battery: { name: 'Battery status', type: 'string', role: 'indicator.battery' },
                    timestamp: { name: 'Last Update', type: 'string', role: 'date' }
                };
                for (const [key, cfg] of Object.entries(states)) {
                    await this.setObjectNotExistsAsync(`${base}.${key}`, { type: 'state', common: { ...cfg, read: true, write: false }, native: {} });
                    await this.setStateAsync(`${base}.${key}`, { val: sensor[key], ack: true });
                }
                this.log.info(`Sensor aktualisiert: ${sensor.name} → ${sensor.temperature}°C, ${sensor.humidity}%, Batterie: ${sensor.battery}`);
            }
        } catch (err) {
            this.log.error(`Fehler beim Abrufen: ${err.message}`);
        }
    }
    onUnload(callback) {
        try { if (this.pollTimer) clearInterval(this.pollTimer); callback(); }
        catch (e) { callback(); }
    }
}
if (module.parent) module.exports = (options) => new MobileAlerts(options);
else new MobileAlerts();
