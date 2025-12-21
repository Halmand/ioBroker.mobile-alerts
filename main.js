'use strict';

/*
 *  Mobile Alerts ioBroker Adapter
 *  Version 1.1.2 (optimized for JS-Controller 7.1)
 *
 *  Supported:
 *  - Temperatur Innen / Außen
 *  - Luftfeuchte
 *  - Historische Luftfeuchte: 3h / 24h / 7d / 30d
 *  - Temperatur Kabelsensor
 *  - Bodensensor (trocken / feucht)
 *  - Regenmenge
 *  - Windrichtung / Windgeschwindigkeit / Böe
 *  - Batterie-Zustand
 *  - Timestamp
 *  - Multi-PhoneID Support
 */

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

// ------------------------------------------------------------

class MobileAlerts extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'mobile-alerts',
        });

        this.interval = null;
        this.phoneIds = [];
        this.pollInterval = 300;
    }

    // --------------------------------------------------------
    // START
    // --------------------------------------------------------
    async onReady() {
        try {
            this.phoneIds = (this.config.phoneId || '')
                .split(',')
                .map(id => id.trim())
                .filter(id => id.length > 0);

            if (this.phoneIds.length === 0) {
                this.log.warn('⚠ Keine PhoneID eingetragen!');
                return;
            }

            this.pollInterval = parseInt(this.config.pollInterval || 300, 10);

            await this.fetchAll();
            this.interval = setInterval(() => this.fetchAll(), this.pollInterval * 1000);

        } catch (e) {
            this.log.error('❌ Fehler in onReady(): ' + e);
        }
    }

    // --------------------------------------------------------
    // Rufe alle PhoneIDs ab
    // --------------------------------------------------------
    async fetchAll() {
        for (const phoneId of this.phoneIds) {
            try {
                await this.fetchData(phoneId);
            } catch (e) {
                this.log.error(`❌ Fehler beim Abruf der PhoneID ${phoneId}: ${e}`);
            }
        }
    }

    // --------------------------------------------------------
    // Abruf & Parsen für eine PhoneID
    // --------------------------------------------------------
    async fetchData(phoneId) {
        const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${phoneId}`;

        this.log.debug(`⬇ Abruf: ${url}`);

        const response = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept-Language': 'de-DE,de;q=0.8,en;q=0.7'
            }
        });

        const html = response.data;
        const $ = cheerio.load(html);

        const panels = $('div.panel').toArray();
        let sensorCount = 0;

        // ----------------------------------------------------
        // Jeder Sensor (async!)
        // ----------------------------------------------------
        for (const el of panels) {
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            if (!text) continue;

            // Sensorname
            const nameMatch = text.match(/^(.*?) ID/i);
            const sensorName = nameMatch ? nameMatch[1].trim() : 'Sensor';

            // Sensor-ID
            const idMatch = text.match(/ID\s*([A-F0-9]+)/i);
            const sensorId = idMatch ? idMatch[1] : 'Unknown';

            // Timestamp
            const tsMatch = text.match(/(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/);
            const timestamp = tsMatch ? tsMatch[1] : null;

            const base = `Phone_${phoneId}.${sensorName}`;

            // Channel erzeugen
            await this.extendObjectAsync(base, {
                type: 'channel',
                common: { name: sensorName },
                native: { id: sensorId }
            });

            // Helper zum Schreiben
            const w = async (state, value, type = 'number', unit = '') => {
                if (value === null || value === undefined || Number.isNaN(value)) return;

                const objId = `${base}.${state}`;

                await this.setObjectNotExistsAsync(objId, {
                    type: 'state',
                    common: {
                        name: state,
                        type,
                        role: 'value',
                        read: true,
                        write: false,
                        unit
                    },
                    native: {}
                });

                await this.setStateAsync(objId, { val: value, ack: true });
            };

            // Werte extrahieren
            const tIn = extract(text, /Temperatur(?: Innen)?\s+([\d,.-]+)/);
            const tOut = extract(text, /Temperatur Außen\s+([\d,.-]+)/);
            const hIn = extract(text, /Luftfeuchte(?: Innen)?\s+([\d,.-]+)/);
            const hOut = extract(text, /Luftfeuchte Außen\s+([\d,.-]+)/);
            const tCable = extract(text, /Temperatur Kabelsensor\s+([\d,.-]+)/);

            const soil =
                /trocken/i.test(text) ? 'dry' :
                /feucht/i.test(text) ? 'wet' :
                null;

            const hum3h = extract(text, /Durchschn\.\s*Luftf\.\s*3H\s+([\d,.-]+)/);
            const hum24h = extract(text, /Durchschn\.\s*Luftf\.\s*24H\s+([\d,.-]+)/);
            const hum7d = extract(text, /Durchschn\.\s*Luftf\.\s*7D\s+([\d,.-]+)/);
            const hum30d = extract(text, /Durchschn\.\s*Luftf\.\s*30D\s+([\d,.-]+)/);

            const windSpeed = extract(text, /Windgeschwindigkeit\s+([\d.,-]+)/);
            const windGust = extract(text, /Böe\s+([\d.,-]+)/);
            const windDir = extract(text, /Windrichtung\s+(\d+)\s*°/);

            const rain = extract(text, /Regen(?:menge)?\s+([\d,.-]+)/);

            const battery =
                /low|schwach|leer/i.test(text) ? 0 :
                /ok|gut/i.test(text) ? 1 :
                null;

            // Speichern
            await w('temperature', tIn ?? tOut, 'number', '°C');
            await w('humidity', hIn ?? hOut, 'number', '%');
            await w('temperature_cable', tCable, 'number', '°C');

            if (soil) await w('soil_status', soil, 'string');

            await w('hum3h', hum3h, 'number', '%');
            await w('hum24h', hum24h, 'number', '%');
            await w('hum7d', hum7d, 'number', '%');
            await w('hum30d', hum30d, 'number', '%');

            await w('wind_speed', windSpeed, 'number', 'm/s');
            await w('wind_gust', windGust, 'number', 'm/s');
            await w('wind_dir', windDir, 'number', '°');

            await w('rain', rain, 'number', 'mm');

            if (battery !== null) await w('battery', battery);
            if (timestamp) await w('timestamp', timestamp, 'string');

            sensorCount++;
        }

        this.log.info(`✔ PhoneID ${phoneId}: ${sensorCount} Sensoren aktualisiert.`);
    }

    // --------------------------------------------------------
    onUnload(callback) {
        try {
            if (this.interval) clearInterval(this.interval);
            callback();
        } catch (e) {
            callback();
        }
    }
}

// ------------------------------------------------------------
// Hilfsfunktion
// ------------------------------------------------------------
function extract(text, regex) {
    const m = text.match(regex);
    if (!m || m.length < 2) return null;
    return parseFloat(m[1].replace(',', '.'));
}

// ------------------------------------------------------------

if (require.main !== module) {
    module.exports = options => new MobileAlerts(options);
} else {
    new MobileAlerts();
}
