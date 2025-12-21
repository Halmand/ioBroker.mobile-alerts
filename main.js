'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

function num(v) {
    return parseFloat(String(v).replace(',', '.'));
}

// ------------------------------------------------------
// CLEAN FUNCTION – erzeugt 100% gültige ioBroker IDs
// ------------------------------------------------------
function cleanId(str) {
    if (!str) return '';

    return String(str)
        .trim()
        .replace(/<\/?[^>]+(>|$)/g, '')       // HTML entfernen
        .replace(/[^\w\d_-]+/g, '_')          // ungültige Zeichen ersetzen
        .replace(/_+/g, '_')                  // doppelte "_" entfernen
        .replace(/^_+|_+$/g, '')              // "_" am Anfang/Ende entfernen
        .replace(/\.$/, '')                   // Punkt am Ende entfernen
        .slice(0, 50);                        // maximale Länge
}

class MobileAlerts extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: 'mobile-alerts',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        const phoneIds = (this.config.phoneId || '')
            .split(',')
            .map(p => p.trim())
            .filter(Boolean);

        const pollInterval = this.config.pollInterval || 300;
        this.windUnit = this.config.windUnit || 'm/s';

        if (!phoneIds.length) {
            this.log.error('Keine PhoneID angegeben!');
            return;
        }

        for (const id of phoneIds) await this.fetchData(id);

        this.interval = setInterval(() => {
            phoneIds.forEach(id => this.fetchData(id));
        }, pollInterval * 1000);
    }

    async fetchData(phoneId) {
        try {
            const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${phoneId}`;
            const res = await axios.get(url);
            const $ = cheerio.load(res.data);

            const sensors = [];

            $('.panel').each((index, el) => {

                let rawName = $(el).find('.panel-heading').text().trim();
                let name = cleanId(rawName) || `Sensor_${index + 1}`;

                const sensor = {
                    name,
                    values: {}
                };

                $(el).find('.table tr').each((_, row) => {
                    const rawKey = $(row).find('td').eq(0).text().trim().toLowerCase();
                    const key = cleanId(rawKey.replace(/\s+/g, '_'));

                    let val = $(row).find('td').eq(1).text().trim();

                    if (!key || !val) return;

                    const m = val.match(/([-+]?[0-9]*[.,]?[0-9]+)/);

                    if (m) val = num(m[1]);

                    if (key.includes('wind') && typeof val === 'number') {
                        val = this.convertWind(val);
                    }

                    sensor.values[key] = val;
                });

                sensors.push(sensor);
            });

            for (const sensor of sensors) {
                let sensorBase = cleanId(`Phone_${phoneId}_${sensor.name}`);

                await this.setObjectNotExistsAsync(sensorBase, {
                    type: 'device',
                    common: { name: sensor.name },
                    native: {}
                });

                for (const [k, v] of Object.entries(sensor.values)) {

                    const role = this.mapRole(k);
                    const unit = this.mapUnit(k);

                    const id = cleanId(`${sensorBase}_${k}`);

                    await this.setObjectNotExistsAsync(id, {
                        type: 'state',
                        common: {
                            name: k,
                            type: typeof v === 'number' ? 'number' : 'string',
                            unit,
                            role,
                            read: true,
                            write: false
                        },
                        native: {}
                    });

                    await this.setStateAsync(id, { val: v, ack: true });
                }
            }

            await this.setStateAsync('info.connection', { val: true, ack: true });

        } catch (e) {
            this.log.error(`Fehler beim Abruf für ${phoneId}: ${e}`);
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

    onUnload(callback) {
        try {
            if (this.interval) clearInterval(this.interval);
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
