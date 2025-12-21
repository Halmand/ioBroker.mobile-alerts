'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

class MobileAlerts extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'mobile-alerts'
        });

        this.interval = null;
        this.pollInterval = 300;
        this.phoneIds = [];
    }

    async onReady() {
        try {
            // Mehrere IDs durch Komma getrennt
            this.phoneIds = (this.config.phoneId || '')
                .split(',')
                .map(a => a.trim())
                .filter(a => a.length > 0);

            this.pollInterval = parseInt(this.config.pollInterval || 300, 10);

            if (this.phoneIds.length === 0) {
                this.log.warn('Keine PhoneIDs eingetragen!');
                return;
            }

            await this.fetchAll();

            this.interval = setInterval(() => this.fetchAll(), this.pollInterval * 1000);

        } catch (e) {
            this.log.error('Fehler beim Start: ' + e);
        }
    }

    async fetchAll() {
        for (const phoneId of this.phoneIds) {
            try {
                await this.fetchData(phoneId);
            } catch (e) {
                this.log.error(`Fehler beim Abruf PhoneID ${phoneId}: ${e}`);
            }
        }
    }

    async fetchData(phoneId) {
        const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${phoneId}`;

        this.log.debug(`Abruf: ${url}`);

        const response = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                'Accept-Language': 'de-DE,de;q=0.8,en;q=0.7'
            }
        });

        const html = response.data;
        const $ = cheerio.load(html);

        let sensorCount = 0;

        $('div.panel').each((i, el) => {
            const panelText = $(el).text().replace(/\s+/g, ' ').trim();

            if (!panelText) return;

            const nameMatch = panelText.match(/^(.*?) ID/i);
            const idMatch = panelText.match(/ID\s*([A-F0-9]+)/i);
            const timeMatch = panelText.match(/(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/);

            const sensorName = nameMatch ? nameMatch[1].trim() : 'Sensor';
            const sensorId = idMatch ? idMatch[1] : 'Unknown';
            const timestamp = timeMatch ? timeMatch[1] : null;

            const base = `Phone_${phoneId}.${sensorName}`;

            this.extendObjectAsync(base, {
                type: 'channel',
                common: { name: sensorName },
                native: { id: sensorId }
            });

            const write = async (name, value, type = 'number', unit = '') => {
                if (value === null || value === undefined || value === 'NaN' || Number.isNaN(value)) return;
                await this.setObjectNotExistsAsync(`${base}.${name}`, {
                    type: 'state',
                    common: {
                        name,
                        type,
                        role: 'value',
                        read: true,
                        write: false,
                        unit
                    },
                    native: {}
                });
                await this.setStateAsync(`${base}.${name}`, { val: value, ack: true });
            };

            // Temperatur Innen/Außen
            const tIn = extract(panelText, /Temperatur(?: Innen)?\s+([\d,.-]+)/);
            const tOut = extract(panelText, /Temperatur Außen\s+([\d,.-]+)/);

            // Luftfeuchte Innen/Außen
            const hIn = extract(panelText, /Luftfeuchte(?: Innen)?\s+([\d,.-]+)/);
            const hOut = extract(panelText, /Luftfeuchte Außen\s+([\d,.-]+)/);

            // Kabelsensor Temperatur
            const tCable = extract(panelText, /Temperatur Kabelsensor\s+([\d,.-]+)/);

            // Bodensensor (trocken / feucht)
            const soil =
                /trocken/i.test(panelText) ? 'dry' :
                /feucht/i.test(panelText) ? 'wet' :
                null;

            // Historische Feuchte
            const hum3h = extract(panelText, /Durchschn\.\s*Luftf\.\s*3H\s+([\d,.-]+)/);
            const hum24h = extract(panelText, /Durchschn\.\s*Luftf\.\s*24H\s+([\d,.-]+)/);
            const hum7d = extract(panelText, /Durchschn\.\s*Luftf\.\s*7D\s+([\d,.-]+)/);
            const hum30d = extract(panelText, /Durchschn\.\s*Luftf\.\s*30D\s+([\d,.-]+)/);

            // Windrichtung, Windgeschwindigkeit, Böe
            const windSpeed = extract(panelText, /Windgeschwindigkeit\s+([\d,.,]+)/);
            const windGust = extract(panelText, /Böe\s+([\d,.,]+)/);
            const windDir = extract(panelText, /Windrichtung\s+([\d]+)\s*°/);

            // Regen
            const rain = extract(panelText, /Regen(?:menge)?\s+([\d,.-]+)/);

            // Batterie
            const battery =
                /low|schwach|leer/i.test(panelText) ? 0 :
                /ok|gut/i.test(panelText) ? 1 :
                null;

            // Speichern
            await write('temperature', tIn ?? tOut, 'number', '°C');
            await write('humidity', hIn ?? hOut, 'number', '%');
            await write('temperature_cable', tCable, 'number', '°C');

            if (soil) {
                await write('soil_status', soil, 'string');
            }

            await write('hum3h', hum3h, 'number', '%');
            await write('hum24h', hum24h, 'number', '%');
            await write('hum7d', hum7d, 'number', '%');
            await write('hum30d', hum30d, 'number', '%');

            await write('wind_speed', windSpeed, 'number', 'm/s');
            await write('wind_gust', windGust, 'number', 'm/s');
            await write('wind_dir', windDir, 'number', '°');

            await write('rain', rain, 'number', 'mm');

            if (battery !== null) {
                await write('battery', battery, 'number');
            }

            if (timestamp) {
                await write('timestamp', timestamp, 'string');
            }

            sensorCount++;
        });

        this.log.info(`PhoneID ${phoneId}: ${sensorCount} Sensoren aktualisiert.`);
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

/** Hilfsfunktion für Zahlenextraktion */
function extract(text, regex) {
    const match = text.match(regex);
    if (!match || match.length < 2) return null;
    return parseFloat(match[1].replace(',', '.'));
}

if (require.main !== module) {
    module.exports = (options) => new MobileAlerts(options);
} else {
    new MobileAlerts();
}
