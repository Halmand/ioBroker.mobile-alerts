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
        let text = $el.text().trim().replace(/\s+/g, ' ');
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

        // 🌡️ VERBESSERTE Temperatur & Feuchte Erkennung für Multi-Sensoren
        // NEUE METHODE: Spezifische Suche nach den verschiedenen Sensor-Typen
        
        // Suche nach spezifischen Formaten wie "Temp.In 21,0 C", "Hum.In 33%"
        // und "Temp.1 2,1 C", "Hum.1 86%", etc.
        
        // Ersetze zunächst alle Varianten von Temp./Hum. für bessere Erkennung
        text = text.replace(/Temp\./g, 'Temp.').replace(/Hum\./g, 'Hum.');
        
        // Suche mit verbessertem Regex für alle Temperatur/Luftfeuchte-Werte
        const tempHumPattern = /(Temp\.|Hum\.)\s*(\w+)\s+([-\d,]+)\s*(C|%)/gi;
        let match;
        
        while ((match = tempHumPattern.exec(text)) !== null) {
          const type = match[1]; // "Temp." oder "Hum."
          const sensorNum = match[2].toLowerCase(); // "in", "1", "2", "3", etc.
          const valueStr = match[3];
          const unit = match[4];
          
          const value = parseFloat(valueStr.replace(',', '.'));
          
          if (type.toLowerCase().startsWith('temp')) {
            // Temperatur-Werte
            if (sensorNum === 'in') {
              data.temperature = value;
            } else if (sensorNum === 'out' || sensorNum === 'außen') {
              data.temperature_out = value;
            } else if (!isNaN(sensorNum)) {
              // Nummerierte Sensoren (1, 2, 3, etc.)
              data[`temperature_${sensorNum}`] = value;
            } else {
              data[`temperature_${sensorNum}`] = value;
            }
          } else if (type.toLowerCase().startsWith('hum')) {
            // Luftfeuchtigkeits-Werte
            if (sensorNum === 'in') {
              data.humidity = value;
            } else if (sensorNum === 'out' || sensorNum === 'außen') {
              data.humidity_out = value;
            } else if (!isNaN(sensorNum)) {
              // Nummerierte Sensoren (1, 2, 3, etc.)
              data[`humidity_${sensorNum}`] = value;
            } else {
              data[`humidity_${sensorNum}`] = value;
            }
          }
        }

        // Fallback: Alte Methode für einfache Sensoren
        if (Object.keys(data).filter(k => k.startsWith('temperature') || k.startsWith('humidity')).length === 0) {
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
        }

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
        if (text.includes('Regen')) {
          const rainMatch1 = text.match(/Regen\s+([\d,.-]+)\s*mm/i);
          const rainMatch2 = text.match(/Regen\s*[:=]?\s*([\d,.-]+)\s*mm/i);
          const rainTotal = text.match(/Gesamt\s+([\d,.-]+)\s*mm/i);
          const rainRate = text.match(/Rate\s+([\d,.-]+)\s*mm\/h/i);
          
          if (rainTotal) data.rain_total = parseFloat(rainTotal[1].replace(',', '.'));
          if (rainRate) data.rain_rate = parseFloat(rainRate[1].replace(',', '.'));
          
          if (!data.rain_total && (rainMatch1 || rainMatch2)) {
            const rainValue = rainMatch1 ? rainMatch1[1] : rainMatch2[1];
            data.rain = parseFloat(rainValue.replace(',', '.'));
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
        this.log.warn(`Keine Sensoren gefunden für Phone_${phoneId}`);
        return;
      }

      // 💾 Objekte unter Phone_PhoneID > Sensorname
      for (const sensor of sensors) {
        const base = `Phone_${phoneId}.${sensor.name.replace(/\s+/g, '_')}`;

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

      this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für Phone_${phoneId}.`);
      await this.setStateAsync('info.connection', { val: true, ack: true });
    } catch (err) {
      this.log.error(`Fehler beim Abruf für Phone_${phoneId}: ${err.message}`);
      await this.setStateAsync('info.connection', { val: false, ack: true });
    }
  }

  convertWind(v) {
    if (this.windUnit === 'km/h') return +(v * 3.6).toFixed(1);
    if (this.windUnit === 'bft') return +Math.round(Math.pow(v / 0.836, 2 / 3));
    return v;
  }

  mapRole(k) {
    if (k.startsWith('temperature')) return 'value.temperature';
    if (k.startsWith('humidity')) return 'value.humidity';
    if (k.includes('rain') || k === 'rain_total' || k === 'rain_rate') return 'value.rain';
    if (k.includes('wind')) return 'value.wind';
    if (k.includes('battery')) return 'indicator.battery';
    if (k.includes('timestamp')) return 'value.time';
    if (k === 'wet') return 'sensor.water';
    if (k === 'contact') return 'sensor.door';
    return 'state';
  }

  mapUnit(k) {
    if (k.startsWith('temperature')) return '°C';
    if (k.startsWith('humidity')) return '%';
    if (k.includes('rain')) return 'mm';
    if (k === 'rain_rate') return 'mm/h';
    if (k.includes('wind')) {
      if (this.windUnit === 'km/h') return 'km/h';
      if (this.windUnit === 'bft') return 'Bft';
      return 'm/s';
    }
    return '';
  }

  getFriendlyName(k) {
    const names = {
      temperature: 'Temperatur Innen',
      temperature_1: 'Temperatur Sensor 1',
      temperature_2: 'Temperatur Sensor 2',
      temperature_3: 'Temperatur Sensor 3',
      temperature_out: 'Temperatur Außen',
      temperature_cable: 'Temperatur Kabel',
      humidity: 'Luftfeuchte Innen',
      humidity_1: 'Luftfeuchte Sensor 1',
      humidity_2: 'Luftfeuchte Sensor 2',
      humidity_3: 'Luftfeuchte Sensor 3',
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
      humidity_avg_3h: 'Durchschnitt Luftfeuchte 3H',
      humidity_avg_24h: 'Durchschnitt Luftfeuchte 24H',
      humidity_avg_7d: 'Durchschnitt Luftfeuchte 7D',
      humidity_avg_30d: 'Durchschnitt Luftfeuchte 30D',
    };
    
    if (k.startsWith('temperature_') && !names[k]) {
      const num = k.replace('temperature_', '');
      return `Temperatur Sensor ${num}`;
    }
    
    if (k.startsWith('humidity_') && !names[k] && !k.includes('avg')) {
      const num = k.replace('humidity_', '');
      return `Luftfeuchte Sensor ${num}`;
    }
    
    return names[k] || k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }
}

if (require.main !== module) {
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
