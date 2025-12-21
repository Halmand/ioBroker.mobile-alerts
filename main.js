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

                // Durchschnittswerte Luftfeuchte (NEU – EINZIGE ÄNDERUNG)
                const hum3 = t.match(/Durchschn\. Luftf\. 3H\s+(\d+)%/i);
                if (hum3) data.humidity_avg_3h = parseInt(hum3[1]);

                const hum24 = t.match(/Durchschn\. Luftf\. 24H\s+(\d+)%/i);
                if (hum24) data.humidity_avg_24h = parseInt(hum24[1]);

                const hum7 = t.match(/Durchschn\. Luftf\. 7D\s+(\d+)%/i);
                if (hum7) data.humidity_avg_7d = parseInt(hum7[1]);

                const hum30 = t.match(/Durchschn\. Luftf\. 30D\s+(\d+)%/i);
                if (hum30) data.humidity_avg_30d = parseInt(hum30[1]);

                // Regen
                const rain = t.match(/Regenmenge\s+([\d,.-]+)\s*mm/i);
                if (rain) data.rain = parseFloat(rain[1].replace(',', '.'));

                // Wind
                const wind = t.match(/Wind\s+([\d,.-]+)\s*m\/s/i);
                if (wind) data.wind = this.convertWind(parseFloat(wind[1].replace(',', '.')));

                // Batterie
                const batt = t.match(/Batterie\s+(\d+)\s*%/i);
                if (batt) data.battery = parseInt(batt[1]);

                // Kontaktsensor
                if (/offen/i.test(t)) {
                    data.contact = true;
                    data.contact_text = 'Offen';
                } else if (/geschlossen/i.test(t)) {
                    data.contact = false;
                    data.contact_text = 'Geschlossen';
                }

                sensors.push(data);
            });

            // Daten in States schreiben
            for (const sensor of sensors) {
                const sensorBase = `Phone_${phoneId}.${sensor.name}`;

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
