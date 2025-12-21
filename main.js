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
                const t = $(el).text().trim().replace(/\s+/g, ' ');
                if (!t) return;

                const name = $(el).find('h3, .sensor-name').first().text().trim() || `Sensor_${i}`;
                const data = { name };

                // Zeitpunkt
                const ts = t.match(/Zeitpunkt\s+([\d:. ]+)/i);
                if (ts) data.timestamp = ts[1].trim();

                // Temperatur
                const temp = t.match(/Temperatur\s+([\d,.-]+)\s*C/i);
                if (temp) data.temperature = parseFloat(temp[1].replace(',', '.'));

                // Luftfeuchte
                const hum = t.match(/Luftfeuchte\s+(\d+)\s*%/i);
                if (hum) data.humidity = parseInt(hum[1]);

                // Regen
                const rain = t.match(/Regen\s+([\d,.-]+)\s*mm/i);
                if (rain) data.rain = parseFloat(rain[1].replace(',', '.'));

                // Wind
                const wind = t.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i);
                if (wind) data.wind = this.convertWind(parseFloat(wind[1].replace(',', '.')));

                const gust = t.match(/Böe\s+([\d,.-]+)\s*m\/s/i);
                if (gust) data.gust = this.convertWind(parseFloat(gust[1].replace(',', '.')));

                // Windrichtung
                const dir = t.match(/Windrichtung\s+([A-Za-z]+)/i);
                if (dir) data.wind_direction = dir[1];

                // Batterie
                const bat = t.match(/Batterie\s+(\d+)%/i);
                if (bat) data.battery = parseInt(bat[1]);

                // WET SENSOR
                const wet = t.match(/Bodenfeuchte\s+(Nass|Trocken)/i);
                if (wet) data.wet = wet[1] === 'Nass';

                // ✔ KONTAKTSENSOR (NEU)
                const door = t.match(/Kontaktsensor\s+(Geschlossen|Offen)/i);
                if (door) {
                    data.contact = door[1] === 'Offen';
                    data.contact_text = door[1];
                }

                sensors.push(data);
            });

            if (!sensors.length) {
                this.log.warn(`Keine Sensoren gefunden für ${phoneId}`);
                return;
            }

            // -----------------------------------------------
            // ❗ Deine Struktur: mobile-alerts.0.Phone_<ID>.<SensorName>.<Wert>
            // -----------------------------------------------
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
            this.log.error(`Fehler beim Abruf von Phone_${phoneId}: ${err.message}`);
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
        if (k === 'contact') return 'sensor.door';
        if (k === 'contact_text') return 'text';
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
    module.exports = options => new MobileAlerts(options);
} else {
    new MobileAlerts();
}
