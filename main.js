'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

/* Hilfsfunktion: sichere Zahl (Komma oder Punkt) */
function num(v) {
    if (v === undefined || v === null) return NaN;
    const s = String(v).trim().replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
}

/* Sanitizer für Objekt-/Channel-Namen */
function sanitizeId(s) {
    return String(s || '')
        .normalize('NFKD') // unicode normalize
        .replace(/[\u0300-\u036f]/g, '') // remove diacritics
        .replace(/[^a-zA-Z0-9_\-]/g, '_') // allowed chars
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}

class MobileAlerts extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'mobile-alerts',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));

        // Default windUnit falls back auf 'm/s'
        this.windUnit = 'm/s';
        this.pollTimer = null;
    }

    async onReady() {
        try {
            this.windUnit = this.config.windUnit || 'm/s';
            const phoneIds = (this.config.phoneId || '').split(',').map(p => p.trim()).filter(Boolean);
            const pollInterval = (this.config.pollInterval || 300);

            if (!phoneIds.length) {
                this.log.error('Keine PhoneID angegeben!');
                await this.setStateAsync('info.connection', { val: false, ack: true });
                return;
            }

            // Erstabruf für alle PhoneIDs (seriell)
            for (const id of phoneIds) {
                try {
                    await this.fetchData(id);
                } catch (err) {
                    this.log.warn(`Initialer Abruf für ${id} fehlgeschlagen: ${err.message}`);
                }
            }

            // Polling
            if (this.pollTimer) clearInterval(this.pollTimer);
            this.pollTimer = setInterval(() => {
                phoneIds.forEach(id => {
                    this.fetchData(id).catch(err => this.log.debug(`fetchData(${id}) Fehler im Interval: ${err.message}`));
                });
            }, parseInt(pollInterval, 10) * 1000);

            this.log.info(`Polling gestartet (${pollInterval}s) für PhoneIDs: ${phoneIds.join(', ')}`);
        } catch (err) {
            this.log.error(`onReady Fehler: ${err.message}`);
            await this.setStateAsync('info.connection', { val: false, ack: true });
        }
    }

    async onUnload(callback) {
        try {
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            this.log.info('Adapter stopped');
            callback && callback();
        } catch (e) {
            callback && callback();
        }
    }

    async fetchData(phoneId) {
        if (!phoneId) {
            this.log.warn('fetchData: leere phoneId');
            return;
        }
        const encodedId = encodeURIComponent(phoneId);
        const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${encodedId}`;

        try {
            this.log.debug(`Abruf URL: ${url}`);
            const res = await axios.get(url, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'ioBroker mobile-alerts adapter',
                    'Accept-Language': 'de-DE,de;q=0.8,en;q=0.7'
                }
            });

            const html = res.data;
            const $ = cheerio.load(html);

            const sensors = [];

            $('div.sensor, table.table').each((i, el) => {
                const text = $(el).text().trim().replace(/\s+/g, ' ');
                if (!text) return;

                // Name anhand vorangestellter Texte erkennen, ansonsten Fallback
                const nameMatch = text.match(/^(.*?)\s+ID\s+/i);
                const idMatch = text.match(/ID\s+([A-F0-9\-]+)/i);
                const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+)/i);

                const id = idMatch ? idMatch[1] : null;
                const timestamp = timeMatch ? timeMatch[1].trim() : null;

                let battery = 'ok';
                if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';

                const name = nameMatch ? nameMatch[1].trim() : `Sensor_${i + 1}`;
                const data = { id, timestamp, battery };

                // Temperatur & Feuchte (versucht mehrere Varianten)
                const tempIn = text.match(/Temperatur(?:\s*Innen)?\s+([\d,.\-]+)\s*°?\s*C/i);
                const humIn = text.match(/Luftfeuchte(?:\s*Innen)?\s+([\d,.\-]+)\s*%/i);
                const tempOut = text.match(/Temperatur(?:\s*Außen| Außen)?\s+([\d,.\-]+)\s*°?\s*C/i);
                const humOut = text.match(/Luftfeuchte(?:\s*Außen| Außen)?\s+([\d,.\-]+)\s*%/i);
                const tempCable = text.match(/Temperatur(?:\s*Kabelsensor| Kabelsensor)?\s+([\d,.\-]+)\s*°?\s*C/i);

                if (tempIn) data.temperature = num(tempIn[1]);
                if (humIn) data.humidity = num(humIn[1]);
                if (tempOut) data.temperature_out = num(tempOut[1]);
                if (humOut) data.humidity_out = num(humOut[1]);
                if (tempCable) data.temperature_cable = num(tempCable[1]);

                // Feuchtigkeits-/Nasssensor (trocken/feucht)
                const wetMatch = text.match(/\b(trocken|feucht)\b/i);
                if (wetMatch) data.wet = wetMatch[1].toLowerCase() === 'feucht';

                // Regen
                const rainTotal = text.match(/Gesamt\s+([\d,.\-]+)\s*mm/i);
                const rainRate = text.match(/Rate\s+([\d,.\-]+)\s*mm\/h/i);
                if (rainTotal) data.rain_total = num(rainTotal[1]);
                if (rainRate) data.rain_rate = num(rainRate[1]);

                // Wind
                const windSpeed = text.match(/Windgeschwindigkeit\s+([\d,.\-]+)\s*(m\/s|km\/h)?/i);
                const windGust = text.match(/Böe\s+([\d,.\-]+)\s*(m\/s|km\/h)?/i);
                const windDir = text.match(/Windrichtung\s+([A-Za-zäöüß]+|\d{1,3}°)/i);

                if (windSpeed) data.wind_speed = this.convertWind(num(windSpeed[1]));
                if (windGust) data.wind_gust = this.convertWind(num(windGust[1]));
                if (windDir) data.wind_dir = windDir[1];

                sensors.push({ name, ...data });
            });

            if (!sensors.length) {
                this.log.warn(`Keine Sensoren gefunden für ${phoneId}`);
                await this.setStateAsync('info.connection', { val: false, ack: true });
                return;
            }

            // Schreibe Objekte / States unter PhoneID.Channel.Sensor
            for (const sensor of sensors) {
                const channelId = sanitizeId(`${phoneId}_${sensor.name}`);
                const base = `${channelId}`; // Wir verwenden adapter-internes Namensschema (instance wird automatisch vorangestellt)

                // Channel anlegen
                await this.setObjectNotExistsAsync(base, {
                    type: 'channel',
                    common: { name: sensor.name },
                    native: { phoneId }
                });

                for (const [key, val] of Object.entries(sensor)) {
                    if (key === 'name') continue;

                    const stateId = `${base}.${sanitizeId(key)}`;

                    const valueType = typeof val === 'number' && !isNaN(val) ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string';
                    await this.setObjectNotExistsAsync(stateId, {
                        type: 'state',
                        common: {
                            name: key,
                            type: valueType,
                            role: this.mapRole(key),
                            read: true,
                            write: false,
                            unit: this.mapUnit(key)
                        },
                        native: {}
                    });

                    // setState: für Zahlen die Zahl, sonst String/Boolean
                    const setVal = (valueType === 'number') ? Number(val) : val;
                    await this.setStateAsync(stateId, { val: setVal, ack: true });
                }
            }

            this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für ${phoneId}.`);
            await this.setStateAsync('info.connection', { val: true, ack: true });
        } catch (err) {
            const status = err && err.response && err.response.status;
            if (status === 404) {
                this.log.error(`fetchData: 404 für phoneId=${phoneId}`);
            } else {
                this.log.error(`Fehler beim Abruf für ${phoneId}: ${err.message}`);
            }
            await this.setStateAsync('info.connection', { val: false, ack: true });
            throw err; // weiterwerfen, kann beim Polling geloggt werden
        }
    }

    convertWind(v) {
        if (isNaN(v)) return v;
        if (this.windUnit === 'km/h') return +(v * 3.6).toFixed(1);
        if (this.windUnit === 'bft') return +Math.round(Math.pow(v / 0.836, 2 / 3));
        return v;
    }

    mapRole(k) {
        const key = k.toLowerCase();
        if (key.includes('temp')) return 'value.temperature';
        if (key.includes('humidity') || key.includes('feuchte')) return 'value.humidity';
        if (key.includes('rain')) return 'value.rain';
        if (key.includes('wind')) return 'value.wind';
        if (key.includes('battery')) return 'indicator.battery';
        if (key.includes('timestamp') || key.includes('zeit')) return 'value.time';
        if (key === 'wet') return 'sensor.water';
        return 'state';
    }

    mapUnit(k) {
        const key = k.toLowerCase();
        if (key.includes('temp')) return '°C';
        if (key.includes('humidity') || key.includes('feuchte')) return '%';
        if (key.includes('rain')) return 'mm';
        if (key.includes('wind')) {
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
