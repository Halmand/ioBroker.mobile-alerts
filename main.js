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
      let currentSensor = null;

      // NEUE METHODE: Gehe alle Elemente durch und baue Sensoren strukturiert auf
      $('body > *').each((i, el) => {
        const $el = $(el);
        const tagName = $el.prop('tagName');
        const text = $el.text().trim();

        if (tagName === 'H4' && text && !text.includes('Phone ID') && !text.includes('Überblick')) {
          // Neuer Sensor beginnt
          if (currentSensor && Object.keys(currentSensor.data).length > 3) {
            sensors.push(currentSensor);
          }
          
          currentSensor = {
            name: text.trim(),
            data: {}
          };
        } 
        else if (currentSensor) {
          // Sensordaten extrahieren
          if (text.startsWith('ID')) {
            const idMatch = text.match(/ID\s+([A-F0-9]+)/i);
            if (idMatch) currentSensor.data.id = idMatch[1];
          } 
          else if (text.startsWith('Zeitpunkt')) {
            const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+)/);
            if (timeMatch) currentSensor.data.timestamp = timeMatch[1].trim();
          }
          else if (text.includes('Temp') || text.includes('Hum') || text.includes('Temperatur')) {
            // Temperatur/Luftfeuchtigkeit parsen
            this.parseTempHumValue(text, currentSensor.data);
          }
        }
      });

      // Letzten Sensor hinzufügen
      if (currentSensor && Object.keys(currentSensor.data).length > 3) {
        sensors.push(currentSensor);
      }

      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für Phone_${phoneId}`);
        return;
      }

      // Batteriestatus für alle Sensoren prüfen (basierend auf gesamter Seite)
      const fullText = $('body').text();
      const hasLowBattery = /batterie\s*(schwach|low|leer|empty)/i.test(fullText);
      
      // 💾 Objekte unter Phone_PhoneID > Sensorname
      for (const sensor of sensors) {
        const base = `Phone_${phoneId}.${sensor.name.replace(/\s+/g, '_')}`;

        // Batteriestatus setzen
        sensor.data.battery = hasLowBattery ? 'low' : 'ok';

        await this.setObjectNotExistsAsync(base, {
          type: 'channel',
          common: { name: sensor.name },
          native: { phoneId, sensorId: sensor.data.id },
        });

        for (const [key, val] of Object.entries(sensor.data)) {
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

  parseTempHumValue(text, data) {
    // NEUE PARSING-LOGIK für die tatsächliche Struktur
    // Beispiele: "Temp In 21,0 C", "Hum 1 87%", "Temperatur 16,3 C"
    
    // Entferne überflüssige Leerzeichen
    const cleanText = text.replace(/\s+/g, ' ').trim();
    
    // Pattern für "Temp In 21,0 C" oder "Hum 1 87%"
    const multiPattern = /(Temp|Hum)\s+(\w+)\s+([-\d,]+)\s*(C|%)/i;
    const multiMatch = cleanText.match(multiPattern);
    
    if (multiMatch) {
      const type = multiMatch[1].toLowerCase(); // "temp" oder "hum"
      const sensorNum = multiMatch[2].toLowerCase(); // "in", "1", "2", "3"
      const value = parseFloat(multiMatch[3].replace(',', '.'));
      
      if (type === 'temp') {
        if (sensorNum === 'in') {
          data.temperature = value;
        } else if (!isNaN(sensorNum)) {
          data[`temperature_${sensorNum}`] = value;
        } else {
          data[`temperature_${sensorNum}`] = value;
        }
      } else if (type === 'hum') {
        if (sensorNum === 'in') {
          data.humidity = value;
        } else if (!isNaN(sensorNum)) {
          data[`humidity_${sensorNum}`] = value;
        } else {
          data[`humidity_${sensorNum}`] = value;
        }
      }
      return;
    }
    
    // Pattern für einfache "Temperatur 16,3 C"
    const simplePattern = /Temperatur\s+([-\d,]+)\s*C/i;
    const simpleMatch = cleanText.match(simplePattern);
    
    if (simpleMatch) {
      data.temperature = parseFloat(simpleMatch[1].replace(',', '.'));
    }
    
    // Pattern für "Hum In 33%" (ohne Temperatur)
    const humPattern = /Hum\s+In\s+([\d,]+)\s*%/i;
    const humMatch = cleanText.match(humPattern);
    
    if (humMatch) {
      data.humidity = parseFloat(humMatch[1].replace(',', '.'));
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
