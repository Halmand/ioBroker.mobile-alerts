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

      // METHODE 1: Alte Struktur (div.sensor, table.table)
      $('div.sensor, table.table').each((i, el) => {
        const $el = $(el);
        const text = $el.text().trim().replace(/\s+/g, ' ');
        if (!text) return;

        this.parseSensor(text, sensors, i, phoneId);
      });

      // METHODE 2: Neue Struktur (falls Methode 1 nichts findet)
      if (!sensors.length) {
        // Suche nach h4 Elementen für Sensornamen
        $('h4').each((i, el) => {
          const $h4 = $(el);
          const sensorName = $h4.text().trim();
          
          // Überspringe Überschriften wie "Überblick für Phone ID"
          if (!sensorName || sensorName.includes('Phone ID') || sensorName.includes('Überblick')) {
            return;
          }

          // Sammle alle Textinhalte nach diesem h4 bis zum nächsten h4
          let sensorText = sensorName + ' ';
          let nextEl = $h4.next();
          
          while (nextEl.length && nextEl.prop('tagName') !== 'H4') {
            sensorText += nextEl.text() + ' ';
            nextEl = nextEl.next();
          }
          
          this.parseSensor(sensorText, sensors, i, phoneId);
        });
      }

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

  parseSensor(text, sensors, index, phoneId) {
    const nameMatch = text.match(/^(.*?)\s+(ID|Zeitpunkt|Temp|Hum|Temperatur)/i);
    const idMatch = text.match(/ID\s+([A-F0-9]+)/i);
    const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+\d{4})/i);
    
    const id = idMatch ? idMatch[1] : null;
    const timestamp = timeMatch ? timeMatch[1].trim() : null;
    
    let sensorName = 'Sensor_' + (index + 1);
    if (nameMatch) {
      sensorName = nameMatch[1].trim();
      // Entferne mögliche PhoneID aus dem Namen
      if (phoneId && sensorName.includes(phoneId)) {
        sensorName = sensorName.replace(phoneId, '').trim();
      }
    }

    let battery = 'ok';
    if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';

    const data = { id, timestamp, battery };

    // 🌡️ VERBESSERTE Temperatur & Feuchte Erkennung
    // Suche nach allen Temperatur/Luftfeuchtigkeits-Mustern
    const tempHumPattern = /(Temp|Hum|Temperatur|Luftfeuchte)\s*(\w*)\s+([-\d,]+)\s*(C|%|°C)/gi;
    let match;
    
    while ((match = tempHumPattern.exec(text)) !== null) {
      const type = match[1].toLowerCase();
      const sensorNum = match[2].toLowerCase();
      const valueStr = match[3];
      const unit = match[4];
      
      const value = parseFloat(valueStr.replace(',', '.'));
      
      if (type.includes('temp')) {
        // Temperatur-Werte
        if (sensorNum === 'in' || sensorNum === 'innen') {
          data.temperature = value;
        } else if (sensorNum === 'out' || sensorNum === 'außen' || sensorNum === 'aussen') {
          data.temperature_out = value;
        } else if (sensorNum === 'cable' || sensorNum === 'kabel') {
          data.temperature_cable = value;
        } else if (sensorNum && !isNaN(sensorNum)) {
          // Nummerierte Sensoren (1, 2, 3, etc.)
          data[`temperature_${sensorNum}`] = value;
        } else if (type === 'temperatur' && !sensorNum) {
          // Einfache "Temperatur X C"
          data.temperature = value;
        } else if (sensorNum) {
          data[`temperature_${sensorNum}`] = value;
        }
      } else if (type.includes('hum') || type.includes('luftfeuchte')) {
        // Luftfeuchtigkeits-Werte
        if (sensorNum === 'in' || sensorNum === 'innen') {
          data.humidity = value;
        } else if (sensorNum === 'out' || sensorNum === 'außen' || sensorNum === 'aussen') {
          data.humidity_out = value;
        } else if (sensorNum && !isNaN(sensorNum)) {
          // Nummerierte Sensoren (1, 2, 3, etc.)
          data[`humidity_${sensorNum}`] = value;
        } else if (type === 'luftfeuchte' && !sensorNum) {
          // Einfache "Luftfeuchte X %"
          data.humidity = value;
        } else if (sensorNum) {
          data[`humidity_${sensorNum}`] = value;
        }
      }
    }

    // 🧾 Historische Durchschnittswerte
    const hum3h = text.match(/Durchschn\.?\s*Luftf\.?\s*3H\s+([\d,.-]+)\s*%/i);
    const hum24h = text.match(/Durchschn\.?\s*Luftf\.?\s*24H\s+([\d,.-]+)\s*%/i);
    const hum7d = text.match(/Durchschn\.?\s*Luftf\.?\s*7D\s+([\d,.-]+)\s*%/i);
    const hum30d = text.match(/Durchschn\.?\s*Luftf\.?\s*30D\s+([\d,.-]+)\s*%/i);

    if (hum3h) data.humidity_avg_3h = parseFloat(hum3h[1].replace(',', '.'));
    if (hum24h) data.humidity_avg_24h = parseFloat(hum24h[1].replace(',', '.'));
    if (hum7d) data.humidity_avg_7d = parseFloat(hum7d[1].replace(',', '.'));
    if (hum30d) data.humidity_avg_30d = parseFloat(hum30d[1].replace(',', '.'));

    // 🚪 Türkontakt
    if (text.includes('Kontaktsensor')) {
      if (text.includes('Geschlossen')) {
        data.contact = 'closed';
      } else if (text.includes('Offen') || text.includes('Open')) {
        data.contact = 'open';
      }
    }

    // 💧 Feuchtesensor
    const isMoistureSensor = text.match(/Feuchtesensor|wet|trocken|feucht/i) && 
                             !text.includes('Temperatur') && 
                             !text.includes('Luftfeuchte');
    
    if (isMoistureSensor) {
      const wetMatch = text.match(/(trocken|feucht)/i);
      if (wetMatch) data.wet = wetMatch[1].toLowerCase() === 'feucht';
    }

    // 🌧️ Regen
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

    // Nur Sensoren mit gültigen Daten hinzufügen
    const hasData = Object.keys(data).some(key => 
      !['id', 'timestamp', 'battery'].includes(key) && data[key] !== null && data[key] !== undefined
    );
    
    if (hasData || id) {
      sensors.push({ name: sensorName, ...data });
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
