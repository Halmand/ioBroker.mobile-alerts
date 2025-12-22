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
        if (!text || text.length < 10) return;

        // Verbesserte Sensornamen-Extraktion
        let sensorName = '';
        
        // Methode 1: Suche nach h4-Überschrift
        const $h4 = $el.find('h4').first();
        if ($h4.length) {
          sensorName = $h4.text().trim();
        }
        
        // Methode 2: Suche nach Text vor ID
        if (!sensorName) {
          const nameMatch = text.match(/^([^0-9\n]+?)\s*(ID|Zeitpunkt|Temperatur|Luftfeuchte|Regen|Wind|Kontaktsensor)/i);
          if (nameMatch) {
            sensorName = nameMatch[1].trim();
          }
        }
        
        // Methode 3: Fallback
        if (!sensorName) {
          sensorName = `Sensor_${i + 1}`;
        }

        const idMatch = text.match(/ID\s+([A-F0-9]{8,})/i);
        const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+\d{4})/);
        const id = idMatch ? idMatch[1] : null;
        const timestamp = timeMatch ? timeMatch[1].trim() : null;

        let battery = 'ok';
        if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';

        // Bereinige den Sensornamen
        const cleanName = sensorName
          .replace(/[^\wäöüßÄÖÜ\s]/gi, '')
          .trim()
          .replace(/\s+/g, '_');
        
        const data = { id, timestamp, battery };

        // 🌡️ Temperatur & Feuchte
        const tempIn = text.match(/Temperatur(?: Innen)?\s+([\d,.-]+)\s*C/i);
        const humIn = text.match(/Luftfeuchte(?: Innen)?\s+([\d,.-]+)\s*%/i);
        const tempOut = text.match(/Temperatur\s+Außen\s+([\d,.-]+)\s*C/i);
        const humOut = text.match(/Luftfeuchte\s+Außen\s+([\d,.-]+)\s*%/i);
        const tempCable = text.match(/Temperatur\s+Kabelsensor\s+([\d,.-]+)\s*C/i);

        if (tempIn) data.temperature = parseFloat(tempIn[1].replace(',', '.'));
        if (humIn) data.humidity = parseFloat(humIn[1].replace(',', '.'));
        if (tempOut) data.temperature_out = parseFloat(tempOut[1].replace(',', '.'));
        if (humOut) data.humidity_out = parseFloat(humOut[1].replace(',', '.'));
        if (tempCable) data.temperature_cable = parseFloat(tempCable[1].replace(',', '.'));

        // 🚪 Türkontakt / Kontaktsensor
        if (text.includes('Kontaktsensor')) {
          // Status extrahieren
          if (text.includes('Geschlossen')) {
            data.contact = 'closed';
          } else if (text.includes('Offen') || text.includes('Open')) {
            data.contact = 'open';
          }
          
          // Zusätzlich: Batterie-Status für Kontaktsensor
          if (text.toLowerCase().includes('batterie schwach')) {
            data.battery = 'low';
          }
        }

        // 💧 Feuchtesensor (trocken/feucht)
        const wetMatch = text.match(/(trocken|feucht)/i);
        if (wetMatch) data.wet = wetMatch[1].toLowerCase() === 'feucht';

        // 🌧️ Regen
        // Einfaches Format: "Regen: 0,3 mm"
        const rainSimple = text.match(/Regen\s*[:=]?\s*([\d,.-]+)\s*mm/i);
        // Gesamtregen
        const rainTotal = text.match(/Gesamt\s+([\d,.-]+)\s*mm/i);
        // Regenrate
        const rainRate = text.match(/Rate\s+([\d,.-]+)\s*mm\/h/i);
        
        if (rainSimple && !rainTotal) {
          data.rain = parseFloat(rainSimple[1].replace(',', '.'));
        }
        if (rainTotal) data.rain_total = parseFloat(rainTotal[1].replace(',', '.'));
        if (rainRate) data.rain_rate = parseFloat(rainRate[1].replace(',', '.'));

        // 🌬️ Wind
        const windSpeed = text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i);
        const windGust = text.match(/Böe\s+([\d,.-]+)\s*m\/s/i);
        const windDir = text.match(/Windrichtung\s+([A-Za-zäöüß]+|\d{1,3}°)/i);
        if (windSpeed) data.wind_speed = this.convertWind(parseFloat(windSpeed[1].replace(',', '.')));
        if (windGust) data.wind_gust = this.convertWind(parseFloat(windGust[1].replace(',', '.')));
        if (windDir) data.wind_dir = windDir[1];

        // Prüfe, ob Sensor gültige Daten hat
        const hasData = Object.keys(data).some(key => 
          !['id', 'timestamp', 'battery'].includes(key) && data[key] !== null && data[key] !== undefined
        );
        
        if (hasData || id) {
          sensors.push({ name: cleanName, ...data });
        }
      });

      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für ${phoneId}`);
        return;
      }

      // 💾 Objekte unter PhoneID > Sensorname
      for (const sensor of sensors) {
        const base = `${phoneId}.${sensor.name}`;

        await this.setObjectNotExistsAsync(base, {
          type: 'channel',
          common: { name: sensor.name },
          native: { phoneId, sensorId: sensor.id },
        });

        for (const [key, val] of Object.entries(sensor)) {
          if (['name'].includes(key)) continue;

          await this.setObjectNotExistsAsync(`${base}.${key}`, {
            type: 'state',
            common: {
              name: this.getFriendlyName(key),
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
    if (k.includes('rain')) return 'value.rain';
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
    if (k.includes('wind')) {
      if (this.windUnit === 'km/h') return 'km/h';
      if (this.windUnit === 'bft') return 'Bft';
      return 'm/s';
    }
    return '';
  }

  getFriendlyName(k) {
    const names = {
      temperature: 'Temperatur',
      temperature_out: 'Temperatur Außen',
      temperature_cable: 'Temperatur Kabel',
      humidity: 'Luftfeuchte',
      humidity_out: 'Luftfeuchte Außen',
      rain: 'Regen',
      rain_total: 'Regen Gesamt',
      rain_rate: 'Regen Rate',
      wind_speed: 'Windgeschwindigkeit',
      wind_gust: 'Windböe',
      wind_dir: 'Windrichtung',
      battery: 'Batterie',
      timestamp: 'Letzte Aktualisierung',
      wet: 'Feuchtigkeit',
      contact: 'Kontaktstatus',
      id: 'Sensor ID',
    };
    return names[k] || k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }
}

if (require.main !== module) {
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
