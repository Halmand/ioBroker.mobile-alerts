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
        this.on('unload', this.onUnload.bind(this));
    // default, kann via config überschrieben werden
    this.windUnit = 'm/s';
    this.pollTimer = null;
}

async onReady() {
    this.windUnit = this.config.windUnit || this.windUnit;

    const phoneIds = (this.config.phoneId || '').split(',').map(p => p.trim()).filter(Boolean);
    let pollInterval = Number(this.config.pollInterval || 300);
    if (!Number.isFinite(pollInterval) || pollInterval < 5) pollInterval = 300; // mind. 5s, default 300s

    if (!phoneIds.length) {
        this.log.warn('Keine PhoneID angegeben — Adapter läuft, warte auf Konfiguration.');
        // Adapter weiterlaufen lassen, aber nichts pollen
        return;
    }

    // erster Lauf synchron für alle PhoneIDs
    for (const id of phoneIds) {
        await this.fetchData(id);
    }

    // regelmäßiges Polling
    this.pollTimer = setInterval(() => {
        phoneIds.forEach(id => this.fetchData(id));
    }, pollInterval * 1000);
}

async onUnload(callback) {
    try {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        callback && callback();
    } catch (e) {
        callback && callback();
    }
}

// helper: sichere Objekt-ID (minimal invasiv)
// wir machen nur aus dem Sensor-Namen eine id-kompatible Zeichenfolge,
// belassen aber sichtbaren Namen (common.name) unverändert.
sanitizeId(s) {
    if (!s) return '';
    // Ersetze Umlaute, Sonderzeichen, mehrere Unterstriche -> kompakt
    const map = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss' };
    let r = s.replace(/[äöüÄÖÜß]/g, m => map[m] || m);
    r = r.replace(/[^a-zA-Z0-9-_ ]+/g, '_'); // alles nicht alphanumerisch -> _
    r = r.replace(/\s+/g, '_'); // Leer zu _
    r = r.replace(/_+/g, '_'); // mehrere _ -> _
    r = r.replace(/^_|_ $ /g, ''); // führende/trailing _
    if (!r) r = 'sensor';
    return r;
}

// convert wind depending on config
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

// Hauptfunktion: Daten abholen und States anlegen/setzen
async fetchData(phoneId) {
    try {
        const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId= $ {phoneId}`;
        const res = await axios.get(url, { timeout: 15000 });
        const html = res.data;
        const  $  = cheerio.load(html);

        const sensors = [];

        // jedes Sensor-Block oder table scannen
         $ ('div.sensor, table.table').each((i, el) => {
            const t =  $ (el).text().trim().replace(/\s+/g, ' ');
            if (!t) return;

            const name =  $ (el).find('h3, .sensor-name').first().text().trim() || `Sensor_ $ {i}`;
            const data = { name };

            // --- Feldextraktion (spezifisch zuerst, dann Fallbacks) ---
            const ts = t.match(/Zeitpunkt\s+([\d:. ]+)/i);
            if (ts) data.timestamp = ts[1].trim();

            // Temperatur: Innen / Außen / generisch / Kabelsensor
            const tempIn = t.match(/Temperatur\s*Innen\s+([-+\d,.-]+)\s*C/i);
            if (tempIn) data.temperature_inside = parseFloat(tempIn[1].replace(',', '.'));

            const tempOut = t.match(/Temperatur\s*Au[ßs]en\s+([-+\d,.-]+)\s*C/i);
            if (tempOut) data.temperature_outside = parseFloat(tempOut[1].replace(',', '.'));

            const tempCable = t.match(/Temperatur\s+Kabelsensor\s+([-+\d,.-]+)\s*C/i);
            if (tempCable) data.temperature_cable = parseFloat(tempCable[1].replace(',', '.'));

            // Generischer Temperatur-Fallback (wenn keine spezifischen vorhanden)
            if (data.temperature_inside === undefined && data.temperature_outside === undefined && data.temperature_cable === undefined) {
                const temp = t.match(/Temperatur\s+([-+\d,.-]+)\s*C(?!\s*Kabelsensor)/i);
                if (temp) data.temperature = parseFloat(temp[1].replace(',', '.'));
            }

            // Luftfeuchte: Innen / Außen / generisch
            const humIn = t.match(/Luftfeuchte\s*Innen\s+(\d{1,3})\s*%/i);
            if (humIn) data.humidity_inside = parseInt(humIn[1], 10);

            const humOut = t.match(/Luftfeuchte\s*Au[ßs]en\s+(\d{1,3})\s*%/i);
            if (humOut) data.humidity_outside = parseInt(humOut[1], 10);

            if (data.humidity_inside === undefined && data.humidity_outside === undefined) {
                const hum = t.match(/Luftfeuchte\s+(\d{1,3})\s*%/i);
                if (hum) data.humidity = parseInt(hum[1], 10);
            }

            // Durchschnitts-Luftfeuchten (3H,24H,7D,30D)
            const hum3 = t.match(/Durchschn\.\s*Luftf\.?\s*3H\s+(\d{1,3})\s*%/i) || t.match(/Durchschn\. Luftf\. 3H\s+(\d{1,3})\s*%/i);
            if (hum3) data.humidity_avg_3h = parseInt(hum3[1], 10);

            const hum24 = t.match(/Durchschn\.\s*Luftf\.?\s*24H\s+(\d{1,3})\s*%/i) || t.match(/Durchschn\. Luftf\. 24H\s+(\d{1,3})\s*%/i);
            if (hum24) data.humidity_avg_24h = parseInt(hum24[1], 10);

            const hum7 = t.match(/Durchschn\.\s*Luftf\.?\s*7D\s+(\d{1,3})\s*%/i) || t.match(/Durchschn\. Luftf\. 7D\s+(\d{1,3})\s*%/i);
            if (hum7) data.humidity_avg_7d = parseInt(hum7[1], 10);

            const hum30 = t.match(/Durchschn\.\s*Luftf\.?\s*30D\s+(\d{1,3})\s*%/i) || t.match(/Durchschn\. Luftf\. 30D\s+(\d{1,3})\s*%/i);
            if (hum30) data.humidity_avg_30d = parseInt(hum30[1], 10);

            // Regen
            const rain = t.match(/Regen\s+([\d,.-]+)\s*mm/i);
            if (rain) data.rain = parseFloat(rain[1].replace(',', '.'));

            // Wind (m/s), Böe, Richtung
            const wind = t.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i);
            if (wind) data.wind = this.convertWind(parseFloat(wind[1].replace(',', '.')));

            const gust = t.match(/Böe\s+([\d,.-]+)\s*m\/s/i);
            if (gust) data.gust = this.convertWind(parseFloat(gust[1].replace(',', '.')));

            const dir = t.match(/Windrichtung\s+([A-Za-zäöüÄÖÜß-]+)/i);
            if (dir) data.wind_direction = dir[1].trim();

            // Batterie
            const bat = t.match(/Batterie\s+(\d{1,3})\s*%/i);
            if (bat) data.battery = parseInt(bat[1], 10);

            // Bodenfeuchte (wet)
            const wet = t.match(/Bodenfeuchte\s+(Nass|Trocken)/i);
            if (wet) data.wet = wet[1] === 'Nass';

            // Kontaktsensor
            const door = t.match(/Kontaktsensor\s+(Geschlossen|Offen)/i);
            if (door) {
                data.contact = door[1] === 'Offen';
                data.contact_text = door[1];
            }

            sensors.push(data);
        });

        // Jetzt die sensors in ioBroker-Objekte und States schreiben
        // Phone Ordner: Phone_<phoneId> (wie du gewünscht hattest)
        const phoneBase = `Phone_ $ {phoneId}`;

        for (let sIndex = 0; sIndex < sensors.length; sIndex++) {
            const sensor = sensors[sIndex];

            // sensorName sanitized nur für Objekt-ID, common.name bleibt lesbar
            const sensorId = this.sanitizeId(sensor.name) || `sensor_ $ {sIndex}`;
            // falls gleiche ID trotzdem doppelt vorkommt (gleicher Name mehrmals) -> index anhängen
            const sensorBase = `mobile-alerts.0. $ {phoneBase}. $ {sensorId}`;

            // Erstelle Ordner-Objekt (wenn nicht existiert)
            await this.setObjectNotExistsAsync(` $ {sensorBase}`, {
                type: 'channel',
                common: {
                    name: sensor.name,
                    role: 'sensor',
                },
                native: { phoneId },
            });

            // Für jeden Key in sensor (außer name) State anlegen und setzen
            for (const [key, val] of Object.entries(sensor)) {
                if (key === 'name') continue;

                const stateId = ` $ {sensorBase}. $ {key}`;

                // existenz prüfen und bei Bedarf anlegen
                await this.setObjectNotExistsAsync(stateId, {
                    type: 'state',
                    common: {
                        name: key,
                        type: typeof val === 'number' ? 'number' : (typeof val === 'boolean' ? 'boolean' : 'string'),
                        role: this.mapRole(key),
                        read: true,
                        write: false,
                        unit: this.mapUnit(key),
                    },
                    native: {},
                });

                // setState (ack = true)
                await this.setStateAsync(stateId, { val, ack: true });
            }
        }

        this.log.info(`Erfolgreich  $ {sensors.length} Sensor(en) aktualisiert für  $ {phoneBase}.`);
        await this.setStateAsync('info.connection', { val: true, ack: true });

    } catch (err) {
        if (err.response) {
            this.log.error(`Fehler beim Abruf von Phone_ $ {phoneId}: HTTP  $ {err.response.status}`);
        } else if (err.code === 'ECONNABORTED') {
            this.log.error(`Fehler beim Abruf von Phone_ $ {phoneId}: Timeout`);
        } else {
            this.log.error(`Fehler beim Abruf von Phone_ $ {phoneId}: ${err.message}`);
        }
        await this.setStateAsync('info.connection', { val: false, ack: true });
    }
}
}
if (require.main !== module) {
    module.exports = options => new MobileAlerts(options);
} else {
    new MobileAlerts();
}
