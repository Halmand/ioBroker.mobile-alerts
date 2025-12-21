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
    this.pollTimer = null;
    this.windUnit = 'm/s';
  }

  async onReady() {
    try {
      const phoneIds = (this.config.phoneId || '').split(',').map(p => p.trim()).filter(Boolean);
      const pollInterval = this.config.pollInterval || 300;
      this.windUnit = this.config.windUnit || 'm/s';

      if (!phoneIds.length) {
        this.log.error('Keine PhoneID angegeben!');
        return;
      }

      // initial fetch
      for (const id of phoneIds) {
        try {
          await this.fetchData(id);
        } catch (e) {
          // Fehler bereits geloggt in fetchData
        }
      }

      // poll timer
      this.pollTimer = setInterval(() => {
        phoneIds.forEach(id => {
          this.fetchData(id).catch(() => {}); // Fehler intern behandelt
        });
      }, pollInterval * 1000);

    } catch (err) {
      this.log.error(`onReady Fehler: ${err && err.message}`);
    }
  }

  onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.log.info('Adapter stopped');
      callback();
    } catch (e) {
      callback();
    }
  }

  // ---------------------------
  // Minimal-invasive fetchData
  // ersetzt nur die fetchData Funktion (bewahrt Objektstruktur phoneId.SensorName.<feld>)
  // ---------------------------
  async fetchData(phoneId) {
    try {
      if (!phoneId) {
        this.log && this.log.warn && this.log.warn('fetchData: kein phoneId übergeben');
        return;
      }

      const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${encodeURIComponent(phoneId)}`;
      this.log && this.log.debug && this.log.debug(`Abruf: ${url}`);

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

      function num(v) {
        if (v === undefined || v === null) return NaN;
        const s = String(v).trim().replace(',', '.');
        const n = parseFloat(s);
        return isNaN(n) ? NaN : n;
      }

      $('div.sensor, table.table').each((i, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (!text) return;

        const nameMatch = text.match(/^(.*?)\s+ID\s+/i);
        const idMatch = text.match(/ID\s+([A-F0-9\-]+)/i);
        const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+)/i);

        const id = idMatch ? idMatch[1] : null;
        const timestamp = timeMatch ? timeMatch[1].trim() : null;

        let battery = 'ok';
        if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';

        const name = nameMatch ? nameMatch[1].trim() : `Sensor_${i + 1}`;
        const data = { id, timestamp, battery };

        // Temperatur & Feuchte
        const tempIn = text.match(/Temperatur(?:\s*Innen)?\s+([\d,.\-]+)\s*°?\s*C/i);
        const humIn = text.match(/Luftfeuchte(?:\s*Innen)?\s+([\d,.\-]+)\s*%/i);
        const tempOut = text.match(/Temperatur(?:\s*Außen| Außen)?\s+([\d,.\-]+)\s*°?\s*C/i);
        const humOut = text.match(/Luftfeuchte(?:\s*Außen| Außen)?\s+([\d,.\-]+)\s*%/i);
        const tempCable = text.match(/Temperatur(?:\s*Kabelsensor)?\s+([\d,.\-]+)\s*°?\s*C/i);

        if (tempIn) data.temperature = num(tempIn[1]);
        if (humIn) data.humidity = num(humIn[1]);
        if (tempOut) data.temperature_out = num(tempOut[1]);
        if (humOut) data.humidity_out = num(humOut[1]);
        if (tempCable) data.temperature_cable = num(tempCable[1]);

        // Regen
        const rainLast = text.match(/Regen(?:\s*letzte| letzte)?\s+([\d,.\-]+)\s*mm/i);
        const rainTotal = text.match(/Regen\s+gesamt\s+([\d,.\-]+)\s*mm/i);
        if (rainLast) data.rain_last = num(rainLast[1]);
        if (rainTotal) data.rain_total = num(rainTotal[1]);

        // Wind
        const windSpeed = text.match(/Wind(?:\s*Geschwindigkeit)?\s+([\d,.\-]+)\s*(m\/s|km\/h|kmh|bft)?/i);
        const windGust = text.match(/Böen\s+([\d,.\-]+)\s*(m\/s|km\/h|kmh|bft)?/i);
        const windDir = text.match(/Windrichtung\s+([NSEW\-0-9]+)/i);
        if (windSpeed) data.wind_speed = num(windSpeed[1]);
        if (windGust) data.wind_gust = num(windGust[1]);
        if (windDir) data.wind_dir = windDir[1].trim();

        // Sonstige (Feuchte/Status/Wet)
        if (/nass|wet/i.test(text)) data.wet = true;

        // Speichere Sensor
        sensors.push({ name, ...data });
      });

      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für ${phoneId}`);
        return;
      }

      // Erzeuge/aktualisiere Objekte unter phoneId.SensorName.<feld>
      for (const sensor of sensors) {
        // verwende exakt phoneId als erster Pfadteil, dann Sensorname (unverändert, nur Whitespace -> _ für Sicherheit)
        const safeName = sensor.name.replace(/\s+/g, '_');
        const base = `${phoneId}.${safeName}`;

        await this.setObjectNotExistsAsync(base, {
          type: 'channel',
          common: { name: sensor.name },
          native: { phoneId },
        });

        for (const [key, val] of Object.entries(sensor)) {
          if (key === 'name') continue;

          const stateId = `${base}.${key}`;

          const valueType = (typeof val === 'number' && !isNaN(val)) ? 'number' : (typeof val === 'boolean' ? 'boolean' : 'string');
          await this.setObjectNotExistsAsync(stateId, {
            type: 'state',
            common: {
              name: key,
              type: valueType,
              role: this.mapRole(key),
              read: true,
              write: false,
              unit: this.mapUnit(key),
            },
            native: {},
          });

          const setVal = (valueType === 'number') ? Number(val) : val;
          await this.setStateAsync(stateId, { val: setVal, ack: true });
        }
      }

      this.log && this.log.info && this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für ${phoneId}.`);
      await this.setStateAsync('info.connection', { val: true, ack: true });
    } catch (err) {
      const status = err && err.response && err.response.status;
      if (status === 404) {
        this.log && this.log.error && this.log.error(`fetchData: 404 für phoneId=${phoneId}`);
      } else {
        this.log && this.log.error && this.log.error(`Fehler beim Abruf für ${phoneId}: ${err && err.message}`);
      }
      await this.setStateAsync('info.connection', { val: false, ack: true });
      // wir werfen nicht zwingend weiter, aber loggen
      // throw err;
    }
  }

  // ---------------------------
  // Hilfsfunktionen (wie vorher)
  // ---------------------------
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
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
