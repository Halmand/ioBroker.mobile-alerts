'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

class MobileAlerts extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'mobile-alerts',
        });

        this.pollTimer = null;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.log.info('Adapter ready');
        // Konfiguration aus Adapter-Einstellungen
        this.phoneIds = (this.config.phoneId || '').split(',').map(p => p.trim()).filter(Boolean);
        this.pollInterval = Number(this.config.pollInterval || 300); // in Sekunden
        if (!Number.isFinite(this.pollInterval) || this.pollInterval < 5) this.pollInterval = 300;

        if (!this.phoneIds.length) {
            this.log.warn('Keine Phone-ID(s) in der Konfiguration gefunden. Adapter läuft, aber pollt nichts.');
            await this.setStateAsync('info.connection', { val: false, ack: true });
            return;
        }

        // Start initial fetch + Polling
        await this.fetchAllPhones();
        this.startPolling();
    }

    startPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.log.info(`Starte Polling alle ${this.pollInterval} Sekunden für ${this.phoneIds.length} Phone(s).`);
        this.pollTimer = setInterval(() => {
            this.fetchAllPhones().catch(err => {
                this.log.error(`Polling-Fehler: ${err && err.message ? err.message : JSON.stringify(err)}`);
            });
        }, this.pollInterval * 1000);
    }

    async fetchAllPhones() {
        await this.setStateAsync('info.connection', { val: true, ack: true });
        for (const phoneId of this.phoneIds) {
            try {
                await this.fetchPhone(phoneId);
            } catch (err) {
                this.log.error(`Fehler bei fetchPhone(${phoneId}): ${err && err.message ? err.message : JSON.stringify(err)}`);
                await this.setStateAsync('info.connection', { val: false, ack: true });
            }
        }
    }

    async fetchPhone(phoneId) {
        const url = this.buildUrlForPhone(phoneId);
        this.log.debug(`Rufe URL ab für Phone_${phoneId}: ${url}`);

        let html;
        try {
            const resp = await axios.get(url, { timeout: 20000 });
            html = resp.data;
        } catch (err) {
            this.log.error(`HTTP-Fehler beim Abrufen von Phone_${phoneId}: ${err.message}`);
            throw err;
        }

        // Parser: anpassen falls Seite anders strukturiert ist
        const sensors = this.parseHtmlForSensors(html, phoneId);

        // DEBUG: Zeige wie viele Sensoren und ein Beispiel
        this.log.debug(`DEBUG mobile-alerts: für Phone_${phoneId} sensors parsed: ${sensors.length}`);
        if (sensors.length > 0) {
            this.log.debug(`DEBUG mobile-alerts: first sensor sample: ${JSON.stringify(sensors[0])}`);
        } else {
            this.log.debug(`DEBUG mobile-alerts: Keine Sensoren gefunden für Phone_${phoneId}. HTML-Auszug: ${String(html).replace(/\s+/g,' ').substr(0,800)}`);
        }

        // Verarbeite und lege die States/Objekte an
        await this.applySensorsToIoBroker(phoneId, sensors);
        this.log.info(`Erfolgreich ${sensors.length} Sensor(en) für Phone_${phoneId} verarbeitet.`);
    }

    buildUrlForPhone(phoneId) {
        // Standard-URL-Format; passe bei Bedarf an die echte Ziel-URL an
        // Falls du eine andere URL verwendest, sag mir kurz welche.
        return `https://example.com/phone/${encodeURIComponent(phoneId)}`;
    }

    parseHtmlForSensors(html, phoneId) {
        // Beispiel-Parser mit cheerio; diesen Block anpassen, falls dein HTML anders ist.
        const $ = cheerio.load(html);
        const sensors = [];

        // Beispiel: jede ".sensor" Klasse ist ein Sensorblock
        $('.sensor, .device, .reading').each((i, el) => {
            try {
                const block = $(el);
                const name = block.find('.name, .device-name').first().text().trim() || `sensor_${i}`;
                const tempText = block.find('.temp, .temperature').first().text().trim();
                const humText = block.find('.hum, .humidity').first().text().trim();
                const cable = block.find('.cable, .kabel').length > 0; // Beispiel-Flag

                const temp = this.parseNumberFromString(tempText);
                const hum = this.parseNumberFromString(humText);

                const sensor = {
                    id: this.sanitizeId(`${phoneId}.${name}`),
                    name,
                    temperature: Number.isFinite(temp) ? temp : null,
                    humidity: Number.isFinite(hum) ? hum : null,
                    cable: cable || false,
                    raw: block.text().trim().substr(0, 1000),
                };
                sensors.push(sensor);
            } catch (e) {
                this.log.debug(`parseHtmlForSensors: Fehler beim Parsen eines Blocks: ${e.message}`);
            }
        });

        // Falls keine .sensor Blocks gefunden wurden: Fallback-Versuch mit Regex (einfach)
        if (sensors.length === 0) {
            const fallback = [];
            const tempMatches = html.match(/([-+]?[0-9]*\.?[0-9]+)\s?°?C/gi) || [];
            const humMatches = html.match(/([0-9]{1,3})\s?%/g) || [];
            if (tempMatches.length || humMatches.length) {
                const t = tempMatches[0] ? parseFloat(tempMatches[0]) : null;
                const h = humMatches[0] ? parseInt(humMatches[0]) : null;
                fallback.push({
                    id: this.sanitizeId(`${phoneId}.fallback_sensor`),
                    name: 'fallback_sensor',
                    temperature: Number.isFinite(t) ? t : null,
                    humidity: Number.isFinite(h) ? h : null,
                    cable: false,
                    raw: html.replace(/\s+/g, ' ').substr(0, 800),
                });
            }
            return fallback;
        }

        return sensors;
    }

    parseNumberFromString(s) {
        if (!s) return NaN;
        const m = s.replace(',', '.').match(/-?[0-9]*\.?[0-9]+/);
        return m ? parseFloat(m[0]) : NaN;
    }

    sanitizeId(id) {
        // sichere Objekt-ID: nur a-z0-9_.- ; ersetze Umlaute und Leerzeichen
        if (!id) return '';
        const mapUml = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue' };
        id = id.replace(/[\u00C0-\u017F]/g, ch => mapUml[ch] || ch);
        return id
            .toString()
            .trim()
            .replace(/\s+/g, '_')
            .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
            .replace(/_+/g, '_')
            .toLowerCase();
    }

    async applySensorsToIoBroker(phoneId, sensors) {
        // Basis-Pfad für diesen Adapter/Phone
        const base = `mobile-alerts.0.Phone_${this.sanitizeId(phoneId)}`;

        // Erzeuge root-Objekt (falls nicht existiert)
        try {
            await this.setObjectNotExistsAsync(`${base}`, {
                type: 'device',
                common: {
                    name: `Phone ${phoneId}`
                },
                native: {}
            });
        } catch (e) {
            this.log.error(`DEBUG mobile-alerts: Fehler setObjectNotExistsAsync für ${base}: ${e.message}`);
        }

        for (const sensor of sensors) {
            // Erzeuge ein Device-Ordner für jeden Sensor (keine bestehenden Keys überschreiben)
            const sensorObjId = `${base}.${this.sanitizeId(sensor.name)}`;
            try {
                await this.setObjectNotExistsAsync(sensorObjId, {
                    type: 'channel',
                    common: { name: sensor.name },
                    native: {}
                });
            } catch (e) {
                this.log.error(`DEBUG mobile-alerts: Fehler setObjectNotExistsAsync für ${sensorObjId}: ${e.message}`);
            }

            // Temperature state
            if (sensor.temperature !== null && sensor.temperature !== undefined) {
                const stateId = `${sensorObjId}.temperature`;
                try {
                    await this.setObjectNotExistsAsync(stateId, {
                        type: 'state',
                        common: {
                            name: `${sensor.name} Temperature`,
                            type: 'number',
                            role: 'value.temperature',
                            unit: '°C',
                            read: true,
                            write: false,
                        },
                        native: {}
                    });
                } catch (e) {
                    this.log.error(`DEBUG mobile-alerts: Fehler setObjectNotExistsAsync für ${stateId}: ${e.message}`);
                }
                try {
                    await this.setStateAsync(stateId, { val: sensor.temperature, ack: true });
                } catch (e) {
                    this.log.error(`DEBUG mobile-alerts: Fehler setStateAsync für ${stateId}: ${e.message}`);
                }
            }

            // Humidity state
            if (sensor.humidity !== null && sensor.humidity !== undefined) {
                const stateId = `${sensorObjId}.humidity`;
                try {
                    await this.setObjectNotExistsAsync(stateId, {
                        type: 'state',
                        common: {
                            name: `${sensor.name} Humidity`,
                            type: 'number',
                            role: 'value.humidity',
                            unit: '%',
                            read: true,
                            write: false,
                        },
                        native: {}
                    });
                } catch (e) {
                    this.log.error(`DEBUG mobile-alerts: Fehler setObjectNotExistsAsync für ${stateId}: ${e.message}`);
                }
                try {
                    await this.setStateAsync(stateId, { val: sensor.humidity, ack: true });
                } catch (e) {
                    this.log.error(`DEBUG mobile-alerts: Fehler setStateAsync für ${stateId}: ${e.message}`);
                }
            }

            // Kabel-Sensor Flag (optional)
            try {
                const cableId = `${sensorObjId}.cable`;
                await this.setObjectNotExistsAsync(cableId, {
                    type: 'state',
                    common: {
                        name: `${sensor.name} Cable`,
                        type: 'boolean',
                        role: 'indicator',
                        read: true,
                        write: false,
                    },
                    native: {}
                });
                await this.setStateAsync(cableId, { val: !!sensor.cable, ack: true });
            } catch (e) {
                this.log.debug(`DEBUG mobile-alerts: Fehler beim Anlegen/Setzen cable-Flag für ${sensorObjId}: ${e.message}`);
            }
        }
    }

    async onUnload(callback) {
        try {
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            this.log.info('Adapter stopped and timer cleared');
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new MobileAlerts(options);
} else {
    new MobileAlerts();
}
