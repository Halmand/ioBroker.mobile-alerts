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

                if (!idMatch) return;
                const id = idMatch[1];
                const name = nameMatch ? nameMatch[1].trim() : `Sensor_${id}`;
                const timestamp = timeMatch ? timeMatch[1].trim() : '';

                const data = { name, id, timestamp };

                // -------- TEMPERATUR --------
                const temp = text.match(/Temperatur\s+([\d,.-]+)\s*°C/i);
                if (temp) data.temperature = this.toNumber(temp[1]);

                // -------- LUFTFEUCHTE --------
                const hum = text.match(/Luftfeuchte\s+([\d,.-]+)\s*%/i);
                if (hum) data.humidity = this.toNumber(hum[1]);

                // -------- DURCHSCHNITT LUFTFEUCHTE --------
                const avg3h  = text.match(/Durchschn\.?\s+Luftf\.?\s*3H\s+([\d,.-]+)\s*%/i);
                const avg24h = text.match(/Durchschn\.?\s+Luftf\.?\s*24H\s+([\d,.-]+)\s*%/i);
                const avg7d  = text.match(/Durchschn\.?\s+Luftf\.?\s*7D\s+([\d,.-]+)\s*%/i);
                const avg30d = text.match(/Durchschn\.?\s+Luftf\.?\s*30D\s+([\d,.-]+)\s*%/i);

                if (avg3h)  data.humidity_avg_3h  = this.toNumber(avg3h[1]);
                if (avg24h) data.humidity_avg_24h = this.toNumber(avg24h[1]);
                if (avg7d)  data.humidity_avg_7d  = this.toNumber(avg7d[1]);
                if (avg30d) data.humidity_avg_30d = this.toNumber(avg30d[1]);

                // -------- WIND --------
                const windSpeed =
                    text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i) ||
                    text.match(/Wind\s+([\d,.-]+)\s*m\/s/i);

                const windGust =
                    text.match(/Böe\s+([\d,.-]+)\s*m\/s/i) ||
                    text.match(/Windböen\s+([\d,.-]+)\s*m\/s/i);

                const windDirMatch = text.match(/Windrichtung\s+([A-Za-zÄÖÜäöüß]+)/i);

                if (windSpeed) data.wind = this.convertWind(this.toNumber(windSpeed[1]));
                if (windGust) data.wind_gust = this.convertWind(this.toNumber(windGust[1]));
                if (windDirMatch) data.wind_dir = windDirMatch[1];

                // -------- REGEN --------
                const rain = text.match(/Regenmenge\s+([\d,.-]+)\s*mm/i);
                if (rain) data.rain = this.toNumber(rain[1]);

                sensors.push(data);
            });

            // -------- STATES ANLEGEN --------
            for (const s of sensors) {
                const base = `sensors.${s.id}`;

                await this.setObjectNotExistsAsync(base, { type: 'channel', common: { name: s.name }, native: {} });

                for (const k of Object.keys(s)) {
                    if (k === 'id') continue;

                    await this.setObjectNotExistsAsync(`${base}.${k}`, {
                        type: 'state',
                        common: {
                            name: k,
                            type: typeof s[k],
                            role: this.mapRole(k),
                            unit: this.mapUnit(k),
                            read: true,
                            write: false
                        },
                        native: {}
                    });

                    await this.setStateAsync(`${base}.${k}`, { val: s[k], ack: true });
                }
            }

            this.log.info(`Aktualisiert: ${sensors.length} Sensor(en) für PhoneID ${phoneId}`);
            await this.setStateAsync('info.connection', { val: true, ack: true });

        } catch (err) {
            this.log.error(`Fehler bei PhoneID ${phoneId}: ${err.message}`);
            await this.setStateAsync('info.connection', { val: false, ack: true });
        }
    }

    toNumber(v) {
        if (v === undefined || v === null) return null;
        return parseFloat(String(v).replace(',', '.'));
    }

    convertWind(v) {
        if (v === null || isNaN(v)) return null;
        if (this.windUnit === 'km/h') return +(v * 3.6).toFixed(1);
        if (this.windUnit === 'bft') return +Math.round(Math.pow(v / 0.836, 2 / 3));
        return v; // m/s
    }

    mapRole(k) {
        if (k.includes('temperature')) return 'value.temperature';
        if (k.includes('humidity') && !k.includes('avg')) return 'value.humidity';
        if (k.includes('avg')) return 'value.humidity';
        if (k.includes('rain')) return 'value.rain';
        if (k.includes('wind') && k !== 'wind_dir') return 'value.speed';
        if (k === 'wind_dir') return 'value.direction';
        if (k.includes('timestamp')) return 'value.time';
        return 'state';
    }

    mapUnit(k) {
        if (k.includes('temperature')) return '°C';
        if (k.includes('humidity')) return '%';
        if (k.includes('rain')) return 'mm';
        if (k.includes('wind') && k !== 'wind_dir') {
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
