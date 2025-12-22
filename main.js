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

  async onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.log.info('Adapter wurde gestoppt');
      callback();
    } catch (err) {
      callback();
    }
  }

  async fetchData(phoneId) {
    try {
      const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${phoneId}`;
      const res = await axios.get(url, { timeout: 15000 });
      const html = res.data;
      const $ = cheerio.load(html);

      const sensors = [];

      $('div.sensor, table.table').each((i, el) => {
        const $el = $(el);
        const text = $el.text().trim().replace(/\s+/g, ' ');
        if (!text) return;

        const nameMatch = text.match(/^(.*?) ID /);
        const idMatch = text.match(/ID\s+([A-F0-9]+)/i);
        const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+)/);
        const id = idMatch ? idMatch[1] : null;
        const timestamp = timeMatch ? timeMatch[1].trim() : null;

        let battery = 'ok';
        if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';

        const name = nameMatch ? nameMatch[1].trim() : `Sensor_${i + 1}`;
        const data = { id, timestamp, battery };

        // 🌡️ Temperatur & Feuchte
        const tempIn = text.match(/Temperatur(?: Innen)?\s+([\d,.-]+)\s*C/i);
        const humIn = text.match(/Luftfeuchte(?: Innen)?\s+([\d,.-]+)\s*%/i);
        const tempOut = text.match(/Temperatur Außen\s+([\d,.-]+)\s*C/i);
        const humOut = text.match(/Luftfeuchte Außen\s+([\d,.-]+)\s*%/i);
        const tempCable = text.match(/Temperatur Kabelsensor\s+([\d,.-]+)\s*C/i);

        if (tempIn) data.temperature = parseFloat(tempIn[1].replace(',', '.'));
        if (humIn) data.humidity = parseFloat(humIn[1].replace(',', '.'));
        if (tempOut) data.temperature_out = parseFloat(tempOut[1].replace(',', '.'));
        if (humOut) data.humidity_out = parseFloat(humOut[1].replace(',', '.'));
        if (tempCable) data.temperature_cable = parseFloat(tempCable[1].replace(',', '.'));

        // 🧾 Historische Durchschnittswerte Luftfeuchtigkeit
        const hum3h = text.match(/Durchschn\.\s*Luftf\.\s*3H\s+([\d,.-]+)\s*%/i);
        const hum24h = text.match(/Durchschn\.\s*Luftf\.\s*24H\s+([\d,.-]+)\s*%/i);
        const hum7d = text.match(/Durchschn\.\s*Luftf\.\s*7D\s+([\d,.-]+)\s*%/i);
        const hum30d = text.match(/Durchschn\.\s*Luftf\.\s*30D\s+([\d,.-]+)\s*%/i);

        if (hum3h) data.humidity_avg_3h = parseFloat(hum3h[1].replace(',', '.'));
        if (hum24h) data.humidity_avg_24h = parseFloat(hum24h[1].replace(',', '.'));
        if (hum7d) data.humidity_avg_7d = parseFloat(hum7d[1].replace(',', '.'));
        if (hum30d) data.humidity_avg_30d = parseFloat(hum30d[1].replace(',', '.'));

        // 🚪 Türkontakt / Kontaktsensor
        if (text.includes('Kontaktsensor')) {
          if (text.includes('Geschlossen')) {
            data.contact = 'closed';
          } else if (text.includes('Offen') || text.includes('Open')) {
            data.contact = 'open';
          }
        }

        // 💧 Feuchtesensor (trocken/feucht) - NUR bei expliziter Erwähnung
        const isMoistureSensor = text.match(/Feuchtesensor|wet|trocken|feucht/i) && 
                                 !text.includes('Temperatur') && 
                                 !text.includes('Luftfeuchte');
        
        if (isMoistureSensor) {
          const wetMatch = text.match(/(trocken|feucht)/i);
          if (wetMatch) data.wet = wetMatch[1].toLowerCase() === 'feucht';
        }

        // 🌧️ VERBESSERTE REGEN-ERKENNUNG
        // Versuche verschiedene Regensensor-Formate
        if (text.includes('Regen')) {
          // Format 1: "Regen 0,3 mm" (ohne Doppelpunkt)
          const rainMatch1 = text.match(/Regen\s+([\d,.-]+)\s*mm/i);
          // Format 2: "Regen: 0,3 mm" (mit Doppelpunkt)
          const rainMatch2 = text.match(/Regen\s*[:=]?\s*([\d,.-]+)\s*mm/i);
          // Format 3: "Gesamt 0,3 mm" (für Gesamtregen)
          const rainTotal = text.match(/Gesamt\s+([\d,.-]+)\s*mm/i);
          // Format 4: "Rate 0,3 mm/h" (für Regenrate)
          const rainRate = text.match(/Rate\s+([\d,.-]+)\s*mm\/h/i);
          
          // Erkenne zuerst Gesamt und Rate
          if (rainTotal) data.rain_total = parseFloat(rainTotal[1].replace(',', '.'));
          if (rainRate) data.rain_rate = parseFloat(rainRate[1].replace(',', '.'));
          
          // Wenn kein rain_total aber einfacher Regenwert erkannt
          if (!data.rain_total && (rainMatch1 || rainMatch2)) {
            const rainValue = rainMatch1 ? rainMatch1[1] : rainMatch2[1];
            data.rain = parseFloat(rainValue.replace(',', '.'));
            // Falls rain noch nicht existiert, setze es als rain_total für Kompatibilität
            if (!data.rain_total) data.rain_total = data.rain;
          }
        }

        // 🌬️ Wind
        const windSpeed = text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i);
        const windGust = text.match(/Böe\s+([\d,.-]+)\s*m\/s/i);
        const windDir = text.match(/Windrichtung\s+([A-Za-zäöüß]+|\d{1,3}°)/i);
        if (windSpeed) data.wind_speed = this.convertWind(parseFloat(windSpeed[1].replace(',', '.')));
        if (windGust) data.wind_gust = this.convertWind(parseFloat(windGust[1].replace(',', '.')));
        if (windDir) data.wind_dir = windDir[1];

        sensors.push({ name, ...data });
      });

      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für ${phoneId}`);
        return;
      }

      // 💾 Objekte unter PhoneID > Sensorname
      for (const sensor of sensors) {
        const base = `${phoneId}.${sensor.name.replace(/\s+/g, '_')}`;

        await this.setObjectNotExistsAsync(base, {
          type: 'channel',
          common: { name: sensor.name },
          native: { phoneId },
        });

        for (const [key, val] of Object.entries(sensor)) {
          if (['name'].includes(key)) continue;

          await this.setObjectNotExistsAsync(`${base}.${key}`, {
            type: 'state',
            common: {
              name: key,
              type: typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string',
              role: this.mapRole(key),
              read: true,
              write: false,
              unit: this.mapUnit(key),
            },
            native: {},
          });

          await this.setStateAsync(`${base}.${key}`, { val, ack: true });
        }
      }

      this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für ${phoneId}.`);
      await this.setStateAsync('info.connection', { val: true, ack: true });
    } catch (err) {
      this.log.error(`Fehler beim Abruf für ${phoneId}: ${err.message}`);
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
    if (k.includes('rain') || k === 'rain_total' || k === 'rain_rate') return 'value.rain';
    if (k.includes('wind')) return 'value.wind';
    if (k.includes('battery')) return 'indicator.battery';
    if (k.includes('timestamp')) return 'value.time';
    if (k === 'wet') return 'sensor.water';
    if (k === 'contact') return 'sensor.door';
    return 'state';
  }

  mapUnit(k) {
    if (k.includes('temperature')) return '°C';
    if (k.includes('humidity')) return '%';
    if (k.includes('rain')) return 'mm';
    if (k === 'rain_rate') return 'mm/h';
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
