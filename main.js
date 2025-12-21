'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

/* Hilfsfunktion für Zahlen */
function num(v) {
    return parseFloat(String(v).replace(',', '.'));
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

        const phoneIds = (this.config.phoneId || '').split(',').map(p => p.trim()).filter(Boolean);
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

            $('.panel').each((_, el) => {

                const name = $(el).find('.panel-heading').text().trim();
                const text = $(el).find('.panel-body').text().replace(/\s+/g, ' ').trim();

                if (!text) return;

                const data = {};

                // Temperatur
                const temp = text.match(/Temperatur\s+([\d,.-]+)\s*°C/i);
                if (temp) data.temperature = num(temp[1]);

                // Luftfeuchte
                const hum = text.match(/Luftfeuchte\s+([\d,.-]+)\s*%/i);
                if (hum) data.humidity = num(hum[1]);

                // Regen (0,3 mm Schritte)
                const rain = text.match(/Regen.*?([\d,.-]+)\s*mm/i);
                if (rain) {
                    const val = num(rain[1]);
                    data.rain_total = val;
                }

                // Wind (wenn vorhanden)
                const wind = text.match(/Wind.*?([\d,.-]+)\s*m\/s/i);
                if (wind) {
                    const w = num(wind[1]);
                    data.wind = this.convertWind(w);
                }

                // Batterie
                const batt = text.match(/Batterie.*?([\d,.-]+)\s*V/i);
                if (batt) data.battery = num(batt[1]);

                sensors.push({ name, data });
            });

            // ----------------------
            // Objektstruktur anlegen + Daten schreiben
            // ----------------------

            for (const sensor of sensors) {

                const sensorBase = `Phone_${phoneId}.${sensor.name.replace(/\s+/g, '_')}`;
                const data = sensor.data;

                await this.setObjectNotExistsAsync(`Phone_${phoneId}`, {
                    type: 'device',
                    common: { name: `Phone ${phoneId}` },
                    native: {}
                });

                await this.setObjectNotExistsAsync(sensorBase, {
                    type: 'channel',
                    common: { name: sensor.name },
                    native: {}
                });

                // Werte anlegen
                for (const k of Object.keys(data)) {

                    await this.setObjectNotExistsAsync(`${sensorBase}.${k}`, {
                        type: 'state',
                        common: {
                            name: k,
                            type: 'number',
                            role: this.mapRole(k),
                            unit: this.mapUnit(k),
                            read: true,
                            write: false
                        },
                        native: {}
                    });

                    await this.setStateAsync(`${sensorBase}.${k}`, { val: data[k], ack: true });
                }

                // ----------------------
                // Regenreferenzen & Berechnung
                // ----------------------
                if (data.rain_total !== undefined) {

                    const base = sensorBase;

                    const now = new Date();
                    const hour = now.getHours();
                    const weekday = now.getDay(); // 1=Mo
                    const day = now.getDate();
                    const month = now.getMonth() + 1;

                    const hKey = `${base}.rain_ref_hour`;
                    const dKey = `${base}.rain_ref_day`;
                    const wKey = `${base}.rain_ref_week`;
                    const mKey = `${base}.rain_ref_month`;

                    // REFERENZ STATES SICHER ANLEGEN
                    for (const k of [hKey, dKey, wKey, mKey]) {
                        await this.setObjectNotExistsAsync(k, {
                            type: 'state',
                            common: {
                                name: k.split('.').pop(),
                                type: 'number',
                                role: 'value.rain',
                                unit: 'mm',
                                read: true,
                                write: false
                            },
                            native: {}
                        });
                    }

                    const hourRef = await this.getStateAsync(hKey);
                    const dayRef = await this.getStateAsync(dKey);
                    const weekRef = await this.getStateAsync(wKey);
                    const monthRef = await this.getStateAsync(mKey);

                    const cur = data.rain_total;

                    // Reset Stunde
                    if (!hourRef || new Date(hourRef.ts).getHours() !== hour) {
                        await this.setStateAsync(hKey, { val: cur, ack: true });
                    }

                    // Reset Tag
                    if (!dayRef || new Date(dayRef.ts).getDate() !== day) {
                        await this.setStateAsync(dKey, { val: cur, ack: true });
                    }

                    // Reset Woche (Montag)
                    const mon = (weekday === 1);
                    if (!weekRef || mon && new Date(weekRef.ts).getDay() !== 1) {
                        await this.setStateAsync(wKey, { val: cur, ack: true });
                    }

                    // Reset Monat
                    if (!monthRef || new Date(monthRef.ts).getMonth() + 1 !== month) {
                        await this.setStateAsync(mKey, { val: cur, ack: true });
                    }

                    // Berechnete Werte
                    const hourRain = cur - (hourRef?.val ?? cur);
                    const dayRain = cur - (dayRef?.val ?? cur);
                    const weekRain = cur - (weekRef?.val ?? cur);
                    const monthRain = cur - (monthRef?.val ?? cur);

                    const extra = {
                        rain_last_hour: +hourRain.toFixed(1),
                        rain_today: +dayRain.toFixed(1),
                        rain_week: +weekRain.toFixed(1),
                        rain_month: +monthRain.toFixed(1)
                    };

                    // Extra-Objekte schreiben
                    for (const k of Object.keys(extra)) {
                        await this.setObjectNotExistsAsync(`${base}.${k}`, {
                            type: 'state',
                            common: {
                                name: k,
                                type: 'number',
                                role: 'value.rain',
                                unit: 'mm',
                                read: true,
                                write: false
                            },
                            native: {}
                        });
                        await this.setStateAsync(`${base}.${k}`, { val: extra[k], ack: true });
                    }
                }
            }

            this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für Phone_${phoneId}.`);
            await this.setStateAsync('info.connection', { val: true, ack: true });

        } catch (e) {
            this.log.error('Fehler beim Abruf für ' + phoneId + ': ' + e);
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
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new MobileAlerts(options);
} else {
    new MobileAlerts();
}
